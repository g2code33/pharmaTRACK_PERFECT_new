//! Real local LAN examination authority.
//!
//! This module intentionally uses the Rust/Tauri process rather than a browser
//! mock. The admin machine binds a TCP listener on the examination LAN, keeps
//! an append-only fsynced journal, and only acknowledges an event after the
//! event transaction and its audit record have been written. The webview is a
//! client of this authority; it is never the authority itself.

use serde::{Deserialize, Serialize};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const PROTOCOL_VERSION: u64 = 1;
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanServerConfig {
    pub bind_host: String,
    pub port: u16,
    pub advertised_host: String,
    pub session_id: String,
    pub exam_version_id: String,
    pub authority_id: String,
    pub server_id: String,
    pub authority_epoch: u64,
    pub access_token: String,
    pub package: Value,
    pub session: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanServerStatus {
    pub running: bool,
    pub endpoint: String,
    pub discovery_endpoint: String,
    pub server_id: String,
    pub authority_id: String,
    pub authority_epoch: u64,
    pub revision: u64,
    pub active_connections: usize,
    pub active_attempts: usize,
    pub submitted_attempts: usize,
    pub last_heartbeat_at: String,
}

#[derive(Default)]
pub struct LanServerHandle {
    pub running: Mutex<Option<RunningLanServer>>,
}

pub struct RunningLanServer {
    stop: Arc<AtomicBool>,
    pub status: Arc<Mutex<ServerState>>,
}

#[derive(Debug, Clone)]
struct Connection {
    id: String,
    device_id: String,
    role: String,
    student_id: Option<String>,
    connected_at: String,
    last_seen_at: String,
    status: String,
}

#[derive(Debug, Clone)]
struct Attempt {
    id: String,
    student_id: String,
    device_session_id: String,
    status: String,
    answers: BTreeMap<String, Value>,
    created_at: String,
    submitted_at: Option<String>,
}

#[derive(Debug, Clone)]
struct AppliedEvent {
    event_id: String,
    revision: u64,
    status: String,
}

pub struct ServerState {
    config: LanServerConfig,
    endpoint: String,
    discovery_endpoint: String,
    journal_path: PathBuf,
    revision: u64,
    connections: HashMap<String, Connection>,
    attempts: HashMap<String, Attempt>,
    applied_events: HashMap<String, AppliedEvent>,
    security_events: Vec<Value>,
    last_heartbeat_at: String,
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

pub fn start(app: &AppHandle, handle: &LanServerHandle, config: LanServerConfig) -> Result<LanServerStatus, String> {
    if config.access_token.trim().len() < 32 {
        return Err("LAN authority access token must contain at least 32 characters.".into());
    }
    let bind = format!("{}:{}", config.bind_host, config.port);
    let listener = TcpListener::bind(&bind).map_err(|error| format!("Could not bind examination LAN server: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not configure examination LAN listener: {error}"))?;
    let local = listener
        .local_addr()
        .map_err(|error| format!("Could not determine examination LAN endpoint: {error}"))?;
    let endpoint = format!("http://{}:{}", config.advertised_host, local.port());
    let discovery_endpoint = format!("udp://{}:{}", config.advertised_host, local.port() + 1);
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate PharmaTRACK application data: {error}"))?;
    let journal_dir = app_data.join("pharmaexam");
    fs::create_dir_all(&journal_dir)
        .map_err(|error| format!("Could not create examination journal directory: {error}"))?;
    let journal_path = journal_dir.join(format!("{}.journal", safe_file_name(&config.session_id)));
    let mut server_state = ServerState {
        config,
        endpoint,
        discovery_endpoint,
        journal_path,
        revision: 0,
        connections: HashMap::new(),
        attempts: HashMap::new(),
        applied_events: HashMap::new(),
        security_events: Vec::new(),
        last_heartbeat_at: now(),
    };
    replay_journal(&mut server_state)?;

    stop(handle)?;
    let stop_signal = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(Mutex::new(server_state));
    let listener_stop = stop_signal.clone();
    let listener_state = shared.clone();
    thread::Builder::new()
        .name("pharmatrack-lan-authority".into())
        .spawn(move || {
            while !listener_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let state = listener_state.clone();
                        let signal = listener_stop.clone();
                        let _ = thread::Builder::new()
                            .name("pharmatrack-lan-request".into())
                            .spawn(move || handle_stream(stream, state, signal));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|error| format!("Could not start examination LAN listener: {error}"))?;

    let discovery_stop = stop_signal.clone();
    let discovery_state = shared.clone();
    let discovery_port = local.port().saturating_add(1);
    let _ = thread::Builder::new()
        .name("pharmatrack-lan-discovery".into())
        .spawn(move || discovery_loop(discovery_port, discovery_state, discovery_stop));

    let mut slot = handle.running.lock().map_err(|_| "LAN server state lock failed.")?;
    *slot = Some(RunningLanServer { stop: stop_signal, status: shared.clone() });
    let state = shared.lock().map_err(|_| "LAN server state lock failed.")?;
    Ok(status_from(&state))
}

pub fn stop(handle: &LanServerHandle) -> Result<(), String> {
    let mut slot = handle.running.lock().map_err(|_| "LAN server state lock failed.")?;
    if let Some(running) = slot.take() {
        running.stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

pub fn status(handle: &LanServerHandle) -> Result<LanServerStatus, String> {
    let slot = handle.running.lock().map_err(|_| "LAN server state lock failed.")?;
    let Some(running) = slot.as_ref() else {
        return Ok(LanServerStatus {
            running: false,
            endpoint: String::new(),
            discovery_endpoint: String::new(),
            server_id: String::new(),
            authority_id: String::new(),
            authority_epoch: 0,
            revision: 0,
            active_connections: 0,
            active_attempts: 0,
            submitted_attempts: 0,
            last_heartbeat_at: String::new(),
        });
    };
    let state = running.status.lock().map_err(|_| "LAN server state lock failed.")?;
    Ok(status_from(&state))
}

fn status_from(state: &ServerState) -> LanServerStatus {
    LanServerStatus {
        running: true,
        endpoint: state.endpoint.clone(),
        discovery_endpoint: state.discovery_endpoint.clone(),
        server_id: state.config.server_id.clone(),
        authority_id: state.config.authority_id.clone(),
        authority_epoch: state.config.authority_epoch,
        revision: state.revision,
        active_connections: state.connections.values().filter(|item| item.status == "CONNECTED").count(),
        active_attempts: state.attempts.values().filter(|item| item.status == "ACTIVE").count(),
        submitted_attempts: state.attempts.values().filter(|item| item.status == "SUBMITTED").count(),
        last_heartbeat_at: state.last_heartbeat_at.clone(),
    }
}

fn handle_stream(mut stream: TcpStream, state: Arc<Mutex<ServerState>>, stop: Arc<AtomicBool>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            let _ = write_json(&mut stream, 400, json!({"ok": false, "error": error}));
            return;
        }
    };
    if request.method == "OPTIONS" {
        let _ = write_json(&mut stream, 204, json!({"ok": true}));
        return;
    }
    let result = match state.lock() {
        Ok(mut locked) => route(&mut locked, &request),
        Err(_) => Err("LAN authority state lock failed.".into()),
    };
    match result {
        Ok((status, payload)) => {
            let _ = write_json(&mut stream, status, payload);
        }
        Err(error) => {
            let status = if error.starts_with("AUTH:") { 401 } else if error.starts_with("NOT_FOUND:") { 404 } else { 409 };
            let _ = write_json(&mut stream, status, json!({"ok": false, "error": error.trim_start_matches("AUTH:").trim_start_matches("NOT_FOUND:").trim()}));
        }
    }
    if stop.load(Ordering::Relaxed) {
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
}

fn route(state: &mut ServerState, request: &HttpRequest) -> Result<(u16, Value), String> {
    let segments: Vec<&str> = request.path.trim_matches('/').split('/').collect();
    if request.method == "GET" && request.path == "/pharmaexam/v1/health" {
        let authenticated = authenticate_request(state, request, false).is_ok();
        let mut payload = json!({
            "ok": true,
            "protocolVersion": PROTOCOL_VERSION,
            "server": {
                "serverId": state.config.server_id,
                "label": "PharmaTRACK LAN examination authority",
                "role": "PRIMARY",
                "endpoint": state.endpoint,
                "authorityId": state.config.authority_id,
                "epoch": state.config.authority_epoch,
                "revision": state.revision,
                "status": "PRIMARY",
                "lastHeartbeatAt": state.last_heartbeat_at,
            },
            "activeSessions": 1,
            "activeAttempts": if authenticated { state.attempts.values().filter(|item| item.status == "ACTIVE").count() } else { 0 },
            "checkedAt": now(),
            "serverNowAt": now(),
        });
        if !authenticated { payload["authenticated"] = json!(false); }
        return Ok((200, payload));
    }
    if request.method == "GET" && request.path == "/pharmaexam/v1/discover" {
        return Ok((200, json!({
            "ok": true,
            "protocolVersion": PROTOCOL_VERSION,
            "endpoint": state.endpoint,
            "sessionId": state.config.session_id,
            "examVersionId": state.config.exam_version_id,
            "serverId": state.config.server_id,
            "authorityId": state.config.authority_id,
        })));
    }
    authenticate_request(state, request, true)?;
    if segments.len() < 5 || segments[0] != "pharmaexam" || segments[1] != "v1" || segments[2] != "sessions" {
        return Err("NOT_FOUND: Unknown examination LAN route.".into());
    }
    if segments[3] != state.config.session_id {
        return Err("Session does not belong to this examination authority.".into());
    }
    match (request.method.as_str(), segments.get(4).copied(), segments.get(5).copied()) {
        ("POST", Some("connect"), None) => connect(state, request),
        ("GET", Some("package"), None) => Ok((200, json!({
            "ok": true,
            "sessionId": state.config.session_id,
            "examVersionId": state.config.exam_version_id,
            "package": state.config.package,
        }))),
        ("POST", Some("heartbeat"), None) => heartbeat(state, request),
        ("POST", Some("sync"), None) => sync(state, request),
        ("GET", Some("state"), None) => state_snapshot(state, request),
        ("GET", Some("results"), None) => results(state, request),
        ("POST", Some("attempts"), None) => create_attempt(state, request),
        ("POST", Some("attempts"), Some(attempt_id)) if segments.get(6) == Some(&"answers") => answer(state, request, attempt_id),
        ("POST", Some("attempts"), Some(attempt_id)) if segments.get(6) == Some(&"submit") => submit(state, request, attempt_id),
        ("POST", Some("attempts"), Some(attempt_id)) if segments.get(6) == Some(&"recover") => recover(state, request, attempt_id),
        _ => Err("NOT_FOUND: Unknown examination LAN route.".into()),
    }
}

fn authenticate_request(state: &ServerState, request: &HttpRequest, required: bool) -> Result<(), String> {
    let Some(token) = request.headers.get("x-pharma-exam-token") else {
        return if required { Err("AUTH: Examination session authentication is required.".into()) } else { Err("missing token".into()) };
    };
    if !constant_time_equal(token, &state.config.access_token) {
        return Err("AUTH: Examination session authentication failed.".into());
    }
    if let Some(signature) = request.headers.get("x-pharma-exam-signature") {
        let body = String::from_utf8_lossy(&request.body);
        let expected = sha256_hex(&format!("{}:{}:{}:{}", token, request.method, request.path, body));
        if !constant_time_equal(signature, &expected) {
            return Err("AUTH: Examination request signature failed.".into());
        }
    } else if required {
        return Err("AUTH: Examination request signature is required.".into());
    }
    Ok(())
}

fn connect(state: &mut ServerState, request: &HttpRequest) -> Result<(u16, Value), String> {
    let body: Value = parse_body(request)?;
    let device_id = body["deviceId"].as_str().ok_or("Device identity is required.")?.to_string();
    let role = body["role"].as_str().ok_or("Device role is required.")?.to_string();
    if role != "STUDENT" && role != "ADMIN" { return Err("Device role is invalid.".into()); }
    let student_id = body["studentId"].as_str().map(str::to_string);
    if role == "STUDENT" && student_id.is_none() { return Err("Student identity is required.".into()); }
    let at = now();
    let existing = state.connections.values_mut().find(|item| item.device_id == device_id && item.status == "CONNECTED");
    let connection = if let Some(existing) = existing {
        existing.last_seen_at = at.clone();
        existing.clone()
    } else {
        let id = format!("device-session-{}-{}", safe_file_name(&device_id), unix_millis());
        let created = Connection { id: id.clone(), device_id, role, student_id, connected_at: at.clone(), last_seen_at: at.clone(), status: "CONNECTED".into() };
        append_journal(state, json!({"kind":"CONNECTION_AUTHENTICATED","connection":connection_json(&created),"audit":{"type":"IDENTITY_AUTHENTICATED","at":at}}))?;
        state.security_events.push(json!({"type":"IDENTITY_AUTHENTICATED","severity":"info","at":at,"deviceSessionId":created.id,"studentId":created.student_id}));
        state.connections.insert(id, created.clone());
        created
    };
    state.last_heartbeat_at = at;
    Ok((200, json!({
        "ok": true,
        "server": server_json(state),
        "session": state.config.session,
        "deviceSessionId": connection.id,
        "sessionToken": state.config.access_token,
    })))
}

fn heartbeat(state: &mut ServerState, request: &HttpRequest) -> Result<(u16, Value), String> {
    let body: Value = parse_body(request)?;
    let device_id = body["deviceSessionId"].as_str().ok_or("Device session is required.")?;
    let connection = state.connections.get_mut(device_id).ok_or("Device session was not found.")?;
    connection.last_seen_at = now();
    connection.status = "CONNECTED".into();
    state.last_heartbeat_at = connection.last_seen_at.clone();
    append_journal(state, json!({"kind":"HEARTBEAT","deviceSessionId":device_id,"at":state.last_heartbeat_at}))?;
    Ok((200, json!({"ok":true,"lastSeenAt":state.last_heartbeat_at,"serverRevision":state.revision})))
}

fn create_attempt(state: &mut ServerState, request: &HttpRequest) -> Result<(u16, Value), String> {
    let body: Value = parse_body(request)?;
    let student_id = body["studentId"].as_str().ok_or("Student identity is required.")?.to_string();
    let device_session_id = body["deviceSessionId"].as_str().ok_or("Device session is required.")?.to_string();
    let connection = state.connections.get(&device_session_id).ok_or("Device session was not found.")?;
    if connection.student_id.as_deref() != Some(student_id.as_str()) { return Err("Device session does not own this student identity.".into()); }
    if let Some(existing) = state.attempts.values().find(|item| item.student_id == student_id && item.status == "ACTIVE") {
        return Ok((200, json!({"ok":true,"continued":true,"attempt":attempt_json(existing),"revision":state.revision})));
    }
    let at = now();
    let id = format!("attempt-{}-{}", safe_file_name(&student_id), unix_millis());
    let attempt = Attempt { id: id.clone(), student_id, device_session_id, status: "ACTIVE".into(), answers: BTreeMap::new(), created_at: at, submitted_at: None };
    append_journal(state, json!({"kind":"ATTEMPT_CREATED","attempt":attempt_json(&attempt)}))?;
    state.attempts.insert(id, attempt.clone());
    Ok((200, json!({"ok":true,"continued":false,"attempt":attempt_json(&attempt),"revision":state.revision})))
}

fn answer(state: &mut ServerState, request: &HttpRequest, attempt_id: &str) -> Result<(u16, Value), String> {
    let body: Value = parse_body(request)?;
    let answer = body.get("answer").cloned().unwrap_or_else(|| body["answer"].clone());
    let event_id = answer["eventId"].as_str().ok_or("Answer event ID is required.")?.to_string();
    let device_session_id = answer["deviceSessionId"].as_str().ok_or("Device session is required.")?.to_string();
    let revision = answer["revision"].as_u64().ok_or("Answer revision is required.")?;
    if let Some(previous) = state.applied_events.get(&event_id) {
        return Ok((200, json!({"ok":true,"duplicate":true,"revision":previous.revision,"acknowledgedEventIds":[event_id]})));
    }
    let attempt = state.attempts.get(attempt_id).ok_or("Attempt was not found on the examination authority.")?;
    if attempt.device_session_id != device_session_id { return Err("Attempt ownership validation failed.".into()); }
    let current_revision = attempt.answers.get(answer["questionId"].as_str().unwrap_or_default()).and_then(|item| item["revision"].as_u64()).unwrap_or(0);
    if current_revision >= revision { return Err("A newer answer revision is already authoritative.".into()); }
    let server_revision = state.revision + 1;
    let record = json!({"kind":"EVENT_APPLIED","eventId":event_id,"serverRevision":server_revision,"attemptId":attempt_id,"questionId":answer["questionId"],"answer":answer,"audit":{"type":"ANSWER_RECORDED","at":now()}});
    append_journal(state, record)?;
    let attempt = state.attempts.get_mut(attempt_id).ok_or("Attempt disappeared during answer transaction.")?;
    attempt.answers.insert(answer["questionId"].as_str().unwrap_or_default().to_string(), answer);
    state.revision = server_revision;
    state.applied_events.insert(event_id.clone(), AppliedEvent { event_id: event_id.clone(), revision: server_revision, status: "APPLIED".into() });
    state.security_events.push(json!({"type":"ANSWER_RECORDED","severity":"info","at":now(),"attemptId":attempt_id,"eventId":event_id,"serverRevision":server_revision}));
    Ok((200, json!({"ok":true,"revision":server_revision,"acknowledgedEventIds":[event_id]})))
}

fn sync(state: &mut ServerState, request: &HttpRequest) -> Result<(u16, Value), String> {
    let body: Value = parse_body(request)?;
    let events = body["events"].as_array().ok_or("Sync events must be an array.")?.clone();
    let mut applied = 0_u64;
    let mut conflicts = Vec::new();
    let mut acknowledged = Vec::new();
    for event in events {
        let event_id = event["eventId"].as_str().or_else(|| event["id"].as_str()).unwrap_or_default().to_string();
        if event_id.is_empty() { conflicts.push("event: Event ID is required.".to_string()); continue; }
        if let Some(previous) = state.applied_events.get(&event_id) {
            if previous.status == "APPLIED" { acknowledged.push(event_id); }
            continue;
        }
        match apply_sync_event(state, event.clone(), event_id.clone()) {
            Ok(revision) => { applied += 1; acknowledged.push(event_id); if revision > state.revision { state.revision = revision; } }
            Err(error) => {
                let rejection_reason = error.clone();
                let rejection = json!({"kind":"EVENT_REJECTED","eventId":event_id.clone(),"reason":rejection_reason,"at":now(),"audit":{"type":"SYNC_REJECTED","severity":"warning"}});
                if append_journal(state, rejection).is_ok() {
                    state.security_events.push(json!({"type":"SYNC_REJECTED","severity":"warning","at":now(),"eventId":event_id,"details":error}));
                }
                conflicts.push(format!("{event_id}: {error}"));
            }
        }
    }
    // A sync response is always a protocol response, even when some events
    // conflict. Returning JSON with ok=false lets the client preserve the
    // retryable event IDs instead of treating a partial batch as a transport
    // outage.
    Ok((200, json!({"ok":conflicts.is_empty(),"applied":applied,"conflicts":conflicts,"revision":state.revision,"acknowledgedEventIds":acknowledged})))
}

fn apply_sync_event(state: &mut ServerState, event: Value, event_id: String) -> Result<u64, String> {
    if event["sessionId"].as_str() != Some(state.config.session_id.as_str()) { return Err("Event session does not match the authority session.".into()); }
    if event["authorityEpoch"].as_u64() != Some(state.config.authority_epoch) { return Err("Event authority epoch is stale.".into()); }
    if event["revision"].as_u64().unwrap_or(0) < 1 { return Err("Event revision is invalid.".into()); }
    if event["entity"].as_str() != Some("ANSWER") && event["entity"].as_str() != Some("SECURITY_EVENT") { return Err("Event entity is not accepted by the authority.".into()); }
    let payload = event["payload"].as_object().ok_or("Event payload is required.")?;
    let attempt_id = payload.get("attemptId").and_then(Value::as_str).ok_or("Attempt ID is required.")?;
    let device_session_id = payload.get("deviceSessionId").and_then(Value::as_str).ok_or("Device session is required.")?;
    let connection = state.connections.get(device_session_id).ok_or("Device session was not authenticated.")?;
    if connection.status != "CONNECTED" { return Err("Device session is not connected.".into()); }
    let attempt = state.attempts.get(attempt_id).ok_or("Attempt was not found on the examination authority.")?;
    if attempt.device_session_id != device_session_id { return Err("Attempt ownership validation failed.".into()); }
    if event["entity"].as_str() == Some("ANSWER") {
        let question_id = event["questionId"].as_str().ok_or("Question ID is required.")?;
        let answer_revision = event["answerRevision"].as_u64().ok_or("Answer revision is required.")?;
        if answer_revision < 1 || payload.get("answer").and_then(Value::as_str).is_none() { return Err("Answer payload or revision is invalid.".into()); }
        if let Some(current) = attempt.answers.get(question_id) {
            if current["eventId"].as_str() != Some(event_id.as_str()) && current["revision"].as_u64().unwrap_or(0) >= answer_revision { return Err("A newer answer revision is already authoritative.".into()); }
        }
    }
    let server_revision = state.revision + 1;
    let record = json!({"kind":"EVENT_APPLIED","eventId":event_id.clone(),"serverRevision":server_revision,"attemptId":attempt_id,"event":event.clone(),"audit":{"type":"SYNC_RECONCILED","at":now()}});
    append_journal(state, record)?;
    let attempt = state.attempts.get_mut(attempt_id).ok_or("Attempt disappeared during event transaction.")?;
    if event["entity"].as_str() == Some("ANSWER") {
        let question_id = event["questionId"].as_str().ok_or("Question ID is required.")?;
        let answer = json!({
            "questionId":question_id,
            "answer":payload.get("answer").cloned().unwrap_or(Value::Null),
            "selectedOption":payload.get("selectedOption").cloned().unwrap_or(Value::Null),
            "deviceSessionId":device_session_id,
            "revision":event["answerRevision"].as_u64().unwrap_or(0),
            "eventId":event_id,
            "serverRevision":server_revision,
            "serverReceiptAt":now(),
        });
        attempt.answers.insert(question_id.to_string(), answer);
    }
    state.applied_events.insert(event_id.clone(), AppliedEvent { event_id: event_id.clone(), revision: server_revision, status: "APPLIED".into() });
    let audit_type = if event["entity"].as_str() == Some("ANSWER") { "ANSWER_RECORDED" } else { "SYNC_RECONCILED" };
    state.security_events.push(json!({"type":audit_type,"severity":"info","at":now(),"attemptId":attempt_id,"eventId":event_id,"serverRevision":server_revision}));
    Ok(server_revision)
}

fn submit(state: &mut ServerState, request: &HttpRequest, attempt_id: &str) -> Result<(u16, Value), String> {
    let body: Value = parse_body(request)?;
    let device_session_id = body["deviceSessionId"].as_str().ok_or("Device session is required.")?;
    let attempt = state.attempts.get(attempt_id).ok_or("Attempt was not found on the examination authority.")?;
    if attempt.device_session_id != device_session_id { return Err("Attempt ownership validation failed.".into()); }
    if attempt.status == "SUBMITTED" { return Ok((200, json!({"ok":true,"attempt":attempt_json(attempt),"revision":state.revision}))); }
    let at = now();
    let revision = state.revision + 1;
    append_journal(state, json!({"kind":"SUBMITTED","attemptId":attempt_id,"at":at,"serverRevision":revision,"audit":{"type":"SUBMITTED","at":at}}))?;
    let attempt = state.attempts.get_mut(attempt_id).ok_or("Attempt disappeared during submission transaction.")?;
    attempt.status = "SUBMITTED".into();
    attempt.submitted_at = Some(at);
    state.revision = revision;
    Ok((200, json!({"ok":true,"attempt":attempt_json(attempt),"revision":revision})))
}

fn recover(state: &mut ServerState, request: &HttpRequest, attempt_id: &str) -> Result<(u16, Value), String> {
    let _ = parse_body(request)?;
    let attempt = state.attempts.get(attempt_id).ok_or("Attempt was not found on the examination authority.")?;
    Ok((200, json!({"ok":true,"attempt":attempt_json(attempt),"revision":state.revision})))
}

fn state_snapshot(state: &mut ServerState, _request: &HttpRequest) -> Result<(u16, Value), String> {
    Ok((200, json!({"ok":true,"server":server_json(state),"connections":state.connections.values().map(connection_json).collect::<Vec<_>>(),"attempts":state.attempts.values().map(attempt_json).collect::<Vec<_>>(),"securityEvents":state.security_events,"revision":state.revision})))
}

fn results(state: &mut ServerState, _request: &HttpRequest) -> Result<(u16, Value), String> {
    let summaries = state.attempts.values().filter(|attempt| attempt.status == "SUBMITTED").map(|attempt| {
        json!({
            "attemptId": attempt.id,
            "studentId": attempt.student_id,
            "status": attempt.status,
            "submittedAt": attempt.submitted_at,
            "answered": attempt.answers.len(),
            "serverRevision": state.revision,
        })
    }).collect::<Vec<_>>();
    Ok((200, json!({"ok":true,"revision":state.revision,"results":summaries})))
}

fn parse_body(request: &HttpRequest) -> Result<Value, String> {
    serde_json::from_slice(&request.body).map_err(|_| "Request body is not valid JSON.".into())
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut bytes = Vec::new();
    let mut header_end = None;
    let mut content_length = 0_usize;
    loop {
        let mut chunk = [0_u8; 8192];
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 { break; }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > MAX_BODY_BYTES + 16 * 1024 { return Err("Request is too large.".into()); }
        if header_end.is_none() {
            if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                header_end = Some(position + 4);
                let header_text = String::from_utf8_lossy(&bytes[..position]);
                content_length = header_text.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    if name.eq_ignore_ascii_case("content-length") { value.trim().parse().ok() } else { None }
                }).unwrap_or(0);
            }
        }
        if let Some(end) = header_end { if bytes.len() >= end + content_length { break; } }
    }
    let end = header_end.ok_or("Malformed HTTP request.")?;
    let header_text = String::from_utf8_lossy(&bytes[..end - 4]);
    let mut lines = header_text.lines();
    let first = lines.next().ok_or("Missing HTTP request line.")?;
    let mut first_parts = first.split_whitespace();
    let method = first_parts.next().ok_or("Missing HTTP method.")?.to_string();
    let path = first_parts.next().ok_or("Missing HTTP path.")?.to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') { headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string()); }
    }
    Ok(HttpRequest { method, path, headers, body: bytes[end..end + content_length].to_vec() })
}

fn write_json(stream: &mut TcpStream, status: u16, body: Value) -> std::io::Result<()> {
    let encoded = serde_json::to_vec(&body).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    let reason = match status { 200 => "OK", 204 => "No Content", 400 => "Bad Request", 401 => "Unauthorized", 404 => "Not Found", 409 => "Conflict", _ => "Error" };
    write!(stream, "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type,x-pharma-exam-token,x-pharma-exam-signature,x-pharma-device-session\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", status, reason, encoded.len())?;
    stream.write_all(&encoded)
}

fn append_journal(state: &ServerState, record: Value) -> Result<(), String> {
    let mut file = OpenOptions::new().create(true).append(true).open(&state.journal_path).map_err(|error| format!("Durable journal open failed: {error}"))?;
    let encoded = serde_json::to_vec(&record).map_err(|error| format!("Durable journal serialization failed: {error}"))?;
    file.write_all(&encoded).map_err(|error| format!("Durable journal write failed: {error}"))?;
    file.write_all(b"\n").map_err(|error| format!("Durable journal delimiter failed: {error}"))?;
    file.sync_all().map_err(|error| format!("Durable journal fsync failed: {error}"))?;
    Ok(())
}

fn replay_journal(state: &mut ServerState) -> Result<(), String> {
    let Ok(content) = fs::read_to_string(&state.journal_path) else { return Ok(()); };
    for line in content.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue; };
        match record["kind"].as_str() {
            Some("EVENT_APPLIED") => {
                let event_id = record["eventId"].as_str().or_else(|| record["event"]["eventId"].as_str()).unwrap_or_default().to_string();
                let revision = record["serverRevision"].as_u64().unwrap_or(0);
                if !event_id.is_empty() { state.applied_events.insert(event_id.clone(), AppliedEvent { event_id, revision, status: "APPLIED".into() }); }
                state.revision = state.revision.max(revision);
                if let Some(audit) = record.get("audit") {
                    state.security_events.push(audit.clone());
                }
                if let Some(attempt_id) = record["attemptId"].as_str() {
                    if let Some(attempt) = state.attempts.get_mut(attempt_id) {
                        if let Some(event) = record.get("event") {
                            if event["entity"].as_str() == Some("ANSWER") {
                                if let Some(question_id) = event["questionId"].as_str() { attempt.answers.insert(question_id.into(), event["payload"].clone()); }
                            }
                        } else if let Some(answer) = record.get("answer") {
                            if let Some(question_id) = answer["questionId"].as_str() { attempt.answers.insert(question_id.into(), answer.clone()); }
                        }
                    }
                }
            }
            Some("ATTEMPT_CREATED") => if let Some(attempt) = record.get("attempt").and_then(attempt_from_json) { state.attempts.insert(attempt.id.clone(), attempt); },
            Some("SUBMITTED") => { if let Some(id) = record["attemptId"].as_str() { if let Some(attempt) = state.attempts.get_mut(id) { attempt.status = "SUBMITTED".into(); attempt.submitted_at = record["at"].as_str().map(str::to_string); } } state.revision = state.revision.max(record["serverRevision"].as_u64().unwrap_or(0)); }
            _ => {}
        }
    }
    Ok(())
}

fn connection_json(connection: &Connection) -> Value { json!({"id":connection.id,"deviceId":connection.device_id,"role":connection.role,"studentId":connection.student_id,"connectedAt":connection.connected_at,"lastHeartbeatAt":connection.last_seen_at,"status":connection.status}) }
fn attempt_json(attempt: &Attempt) -> Value { json!({"id":attempt.id,"sessionId":"","studentId":attempt.student_id,"deviceSessionId":attempt.device_session_id,"status":attempt.status,"answers":attempt.answers.values().cloned().collect::<Vec<_>>(),"startedAt":attempt.created_at,"submittedAt":attempt.submitted_at,"serverRevision":0,"localRevision":0}) }
fn attempt_from_json(value: &Value) -> Option<Attempt> { Some(Attempt { id:value["id"].as_str()?.into(), student_id:value["studentId"].as_str()?.into(), device_session_id:value["deviceSessionId"].as_str()?.into(), status:value["status"].as_str().unwrap_or("ACTIVE").into(), answers:BTreeMap::new(), created_at:value["startedAt"].as_str().unwrap_or("").into(), submitted_at:value["submittedAt"].as_str().map(str::to_string) }) }
fn server_json(state: &ServerState) -> Value { json!({"serverId":state.config.server_id,"label":"PharmaTRACK LAN examination authority","role":"PRIMARY","endpoint":state.endpoint,"authorityId":state.config.authority_id,"epoch":state.config.authority_epoch,"revision":state.revision,"status":"PRIMARY","lastHeartbeatAt":state.last_heartbeat_at}) }
fn safe_file_name(value: &str) -> String { value.chars().map(|character| if character.is_ascii_alphanumeric() || character == '-' || character == '_' { character } else { '_' }).collect() }
fn unix_millis() -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() }
fn now() -> String { Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true) }
fn sha256_hex(value: &str) -> String { let mut hasher = Sha256::new(); hasher.update(value.as_bytes()); format!("{:x}", hasher.finalize()) }
fn constant_time_equal(left: &str, right: &str) -> bool { if left.len() != right.len() { return false; } left.bytes().zip(right.bytes()).fold(0_u8, |difference, (a,b)| difference | (a ^ b)) == 0 }

fn discovery_loop(port: u16, state: Arc<Mutex<ServerState>>, stop: Arc<AtomicBool>) {
    let Ok(socket) = UdpSocket::bind(("0.0.0.0", port)) else { return; };
    let _ = socket.set_read_timeout(Some(Duration::from_millis(250)));
    let mut buffer = [0_u8; 1024];
    while !stop.load(Ordering::Relaxed) {
        if let Ok((size, source)) = socket.recv_from(&mut buffer) {
            if &buffer[..size] == b"PHARMATRACK_EXAM_DISCOVER" {
                if let Ok(locked) = state.lock() {
                    let response = json!({"protocolVersion":PROTOCOL_VERSION,"endpoint":locked.endpoint,"sessionId":locked.config.session_id,"examVersionId":locked.config.exam_version_id,"serverId":locked.config.server_id}).to_string();
                    let _ = socket.send_to(response.as_bytes(), source);
                }
            }
        }
    }
}

import { invoke } from '@tauri-apps/api/core';
import { buildExamPackageDraft, type ExaminationRepository } from './service';
import { randomBytes } from './crypto';
import type { ExamSession } from './types';

export const DEFAULT_LAN_EXAM_PORT = 8787;
export const LAN_DISCOVERY_MESSAGE = 'PHARMATRACK_EXAM_DISCOVER';

export interface LanServerStatus {
  running: boolean;
  endpoint: string;
  discoveryEndpoint: string;
  serverId: string;
  authorityId: string;
  authorityEpoch: number;
  revision: number;
  activeConnections: number;
  activeAttempts: number;
  submittedAttempts: number;
  lastHeartbeatAt: string;
}

export interface LanServerConfig {
  bindHost: string;
  port: number;
  advertisedHost: string;
  sessionId: string;
  examVersionId: string;
  authorityId: string;
  serverId: string;
  authorityEpoch: number;
  accessToken: string;
  package: Record<string, unknown>;
  session: ExamSession;
  /**
   * When true the discovery responder includes the session token, so student
   * devices on the examination Wi-Fi join with zero typing (their identity and
   * the exam password still gate entry). The token only authorizes student
   * session routes — the authority exposes no admin routes — so broadcasting
   * it cannot hand out control.
   */
  openEnrollment: boolean;
}

/** An examination authority found by broadcast on this LAN. */
export interface LanDiscoveredAuthority {
  endpoint: string;
  sessionId: string;
  examVersionId: string;
  serverId: string;
  authorityId: string;
  authorityEpoch: number;
  openEnrollment: boolean;
  /** Present only when the invigilator enabled open enrollment. */
  sessionToken?: string;
}

function token(): string {
  const bytes = randomBytes(32);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function isNativeLanServerAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function createLanServerConfig(
  repository: ExaminationRepository,
  session: ExamSession,
  advertisedHost: string,
  port = DEFAULT_LAN_EXAM_PORT,
  options: { openEnrollment?: boolean } = {},
): LanServerConfig {
  const snapshot = repository.snapshot;
  const version = snapshot.versions.find((item) => item.id === session.examVersionId);
  if (!version)
    throw new Error('The immutable examination version is not available for LAN staging.');
  const authority = snapshot.authorities.find(
    (item) => item.serverId === session.authoritativeServerId,
  );
  return {
    bindHost: '0.0.0.0',
    port,
    advertisedHost,
    sessionId: session.id,
    examVersionId: version.id,
    authorityId: authority?.authorityId || `authority-${session.id}`,
    serverId: session.authoritativeServerId,
    authorityEpoch: session.authorityEpoch,
    accessToken: token(),
    package: {
      ...buildExamPackageDraft(version),
      version,
    },
    session,
    openEnrollment: options.openEnrollment ?? false,
  };
}

export async function startLanExamServer(config: LanServerConfig): Promise<LanServerStatus> {
  if (!isNativeLanServerAvailable()) {
    throw new Error(
      'The real LAN examination server requires the authorized Tauri examination host.',
    );
  }
  return invoke<LanServerStatus>('start_lan_exam_server', { config });
}

/**
 * This device's real LAN address, for pre-filling the advertised host field.
 * A hardcoded 192.168.1.x guess strands every student on a different network,
 * which is the number one reason "start the LAN authority" looks broken from
 * the student side. Returns null in the browser preview or when the host has
 * no usable route; the field stays editable either way.
 */
export async function detectLanHost(): Promise<string | null> {
  if (!isNativeLanServerAvailable()) return null;
  try {
    const host = await invoke<string | null>('detect_lan_host');
    return host && host.trim() ? host.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Zero-config discovery for student devices: broadcasts the exam discovery
 * probe on the LAN and returns every authority that answered. This is what
 * removes "type the invigilator's IP" — the router may hand the host a new
 * address every day, but the broadcast finds it wherever it is. Browser
 * preview cannot send UDP; it gets an empty list and keeps manual entry.
 */
export async function discoverLanAuthorities(timeoutMs = 900): Promise<LanDiscoveredAuthority[]> {
  if (!isNativeLanServerAvailable()) return [];
  try {
    const found = await invoke<LanDiscoveredAuthority[]>('discover_lan_exam_servers', {
      timeoutMs,
    });
    return found ?? [];
  } catch {
    return [];
  }
}

export async function stopLanExamServer(): Promise<void> {
  if (!isNativeLanServerAvailable()) return;
  await invoke('stop_lan_exam_server');
}

export async function lanExamServerStatus(): Promise<LanServerStatus> {
  if (!isNativeLanServerAvailable()) {
    return {
      running: false,
      endpoint: '',
      discoveryEndpoint: '',
      serverId: '',
      authorityId: '',
      authorityEpoch: 0,
      revision: 0,
      activeConnections: 0,
      activeAttempts: 0,
      submittedAttempts: 0,
      lastHeartbeatAt: '',
    };
  }
  return invoke<LanServerStatus>('lan_exam_server_status');
}

# PharmaTRACK AI Engine — developer guide

PharmaTRACK has one AI layer. Features ask *it* for intelligence; they never talk
to a vendor, never hold a key, and never mention a model name.

```
UI (pages, readers, panels)
        │   context + task + profile
        ▼
   AIManager ──────────────► routing · fallback · retry · cancellation · status
        │
        ▼
  ProviderAdapter  (one per protocol: openai-compatible | gemini | anthropic | local)
        │
        ▼
   provider (NVIDIA, OpenAI, Gemini, Anthropic, Groq, OpenRouter, Mistral,
             any OpenAI-compatible endpoint, future local runtime)
        │
        ▼
     model (chosen in AI Settings, discovered or typed — never hard-coded)
```

Everything lives in `src/ai/`. Features import from `../ai` (the barrel) and
`../ai/state` (the React context) — nothing deeper.

| File | Responsibility |
| --- | --- |
| `types.ts` | Provider identity, protocols, capabilities, requests, responses, errors |
| `errors.ts` | Category mapping, user-facing reports, credential redaction |
| `models.ts` | Model metadata + capability resolution (protocol < registry < user) |
| `streaming.ts` | SSE parser, usage extraction |
| `providers/*` | One adapter per protocol, plus the preset table |
| `credentials.ts` | IndexedDB credential store + the export scrubbers |
| `settings.ts` | Provider/profile/priority configuration + legacy migration |
| `profiles.ts` | Preset AI profiles (Default / Study / Clinical / Quiz / Document / Fallback) |
| `manager.ts` | Routing, fallback, retry, timeout, cancellation, Test Connection, model listing |
| `context/*` | Controlled context builder, budget and token estimation |
| `tasks.ts` | Task registry + `buildTaskRequest` |
| `conversations.ts` | Local chat history (IndexedDB) with per-message provider metadata |
| `retrieval.ts` | Chunking/ranking seams for future RAG |
| `state.tsx` | `AIProvider`, `useAI`, `useAIStatus`, `useOnline` |

---

## 1. The adapter contract

```ts
interface ProviderAdapter {
  readonly kind: ProviderKind;              // provider identity this serves
  readonly protocol: AIProtocol;            // how it is spoken on the wire
  readonly defaultBaseUrl: string;
  readonly supportsTemperature: boolean;    // reasoning models say false
  readonly baselineCapabilities: AICapability[];

  complete(ctx: CallContext, req: AIRequest): Promise<RawCompletion>;
  stream?(ctx: CallContext, req: AIRequest): AsyncGenerator<AIStreamDelta>;
  listModels?(ctx: CallContext): Promise<ModelInfo[]>;
  probe?(ctx: CallContext): Promise<AICheckResult[]>;
}
```

An adapter owns **only** three things: how a request is spoken, which models it
can offer, and how its errors are shaped. It never routes, retries, falls back,
builds context, stores anything or renders anything.

`CallContext` = `{ config, model, signal }`. `config` is the provider entry with
its credentials already attached by the manager, and `signal` aborts on Stop or
timeout. Throw `HTTPError(status, body)` for a bad response; the normaliser does
the rest.

## 2. Adding a provider

* **Same protocol, new vendor** (most cases): add a preset to
  `PROVIDER_PRESETS` in `providers/index.ts` and an entry in
  `OPENAI_COMPATIBLE_DEFAULTS` — ~10 lines, no request code.
* **New protocol**: write `providers/<protocol>.ts` implementing the interface
  (~120 lines, see `gemini.ts`), map its kinds in `protocolForKind`, and export
  it from `providers/index.ts`. Nothing else changes: routing, fallback,
  retry, Test Connection, error reporting and the UI all follow.
* **User-defined endpoint**: the `custom` preset — name, base URL, key, model,
  optional organisation/project — needs no code at all.

Provider *identity* (`kind`, label), *protocol*, *endpoint* (`baseUrl`) and
*model* are four separate fields. Conflating them is what turns an app into a
single-provider chatbot; keep them apart.

## 3. Authentication

* Keys are read only from the credential store (`loadCredentials`,
  `loadAllCredentials`) and attached to a provider config at call time.
* Placement is protocol-specific and already correct: `Authorization: Bearer …`
  (OpenAI-compatible, plus `OpenAI-Organization` / `OpenAI-Project` when set),
  `x-goog-api-key` (Gemini), `x-api-key` + `anthropic-version` (Anthropic).
* **A key never goes in a URL.** The legacy code used `?key=…` for Gemini; that
  is gone, because URLs are logged by proxies, browsers and crash reporters.
* `migrateLegacySettings` moves a pre-engine `openAIKey` into the provider it
  actually belonged to (an `AIza…` key was always a Google key). The old field
  is cleared only after the new settings *and* credentials have been written.

## 4. Model configuration

* `ProviderConfig.model` is the default for that provider; `AIProfile.model`
  overrides it for that profile; `AIRequest.model` overrides both ad hoc.
* `modelOptions()` = discovered models → curated suggestions → the current value.
* `listModels()` where the API allows it (`/models`, Gemini's `models`), else the
  user types an id. An empty list is a valid, honest answer.
* Capabilities are resolved conservatively:
  `protocol baseline < registry entry < user declaration`, and a model nobody
  knows gets `source: 'assumed'` — rendered as “not established”. Never invent a
  capability; if you add a registry entry, you are making a factual claim.

## 5. Fallback

`resolveChain()` produces an ordered list: explicit `providerId` → capability
routing (priority order) → the active profile's provider, then the profile's
fallbacks, then remaining providers by `providerPriority`. All entries must be
enabled *and* keyed, and must establish the requested capability.

* Automatic fallback is a user setting (`automaticFallback`, plus per-profile
  `useFallback`). Naming a provider explicitly selects the **primary**, it does
  not opt out of failover.
* A switch is never silent: `AIResponse.fallback` carries requested vs used
  provider/model, the failure category and the sentence
  “NVIDIA unavailable. Switched to Google Gemini fallback.” The chat surface
  renders it as a badge under the answer.
* `USER_CANCELLED` never falls through. Non-switchable failures
  (`INVALID_REQUEST`, `UNKNOWN`) stop the chain rather than hammering every
  provider with the same malformed request.

## 6. Context construction

`buildContext(state, selection, budgetTokens)` returns
`{ blocks, sources, estimatedTokens, truncated, warnings }`.

Priority order (most valuable last-to-cut first): explicit `selection` →
page/slide in focus → material → student/course/topic scaffolding → objectives,
notes → retrieval hits → recent turns. `applyBudget` measures with
`estimateTokens` (`CHARS_PER_TOKEN = 3.6`), truncates the lowest-priority
material text and warns — it never silently drops the question.

Two hard rules:

1. **Never send the whole database.** Pass the ids and the text you actually
   have; the builder assembles only the blocks a request needs. The reader sends
   the current page/slide text (plus an optional highlighted passage), not the
   deck.
2. **Say what was sent.** `response.usedContext` / `context.sources` drive the
   “Context sent” disclosure in the panel.

`retrieval.ts` is the seam for future RAG: `chunkMaterial`, `lexicalIndex`,
`rankChunks`, `retrieve` already take course/topic/material/page/slide filters.

## 7. Streaming

`aiManager.stream(req)` yields `AIStreamDelta`s and resolves with the full
`AIResponse` (provenance, usage, attempts). Adapters yield deltas from whatever
the wire gives them; `parseSse` handles `data:` without a space, CRLF, multi-line
payloads, bare-JSON gateways and a final event with no newline.

* A provider that ignores `stream: true` and returns one JSON body is handled by
  the same adapter — the UI just gets one delta.
* `ProviderConfig.streaming === false`, or a task without the capability, forces
  the non-streaming path.
* Progressive UI: `onAIStatus` reports `connecting → streaming → done | error |
  cancelled`; `useAIStatus(runId)` renders “AI is responding…”.

## 8. Error normalisation

Everything thrown while talking to a provider passes through `normalizeError`,
which is the only place that decides a category:

`AUTHENTICATION · RATE_LIMIT · NETWORK · TIMEOUT · MODEL_UNAVAILABLE ·
INVALID_REQUEST · CONTEXT_TOO_LARGE · PROVIDER_ERROR · USER_CANCELLED · UNKNOWN`

`reportFor()` turns that into “reason + what to check”, e.g.

```
NVIDIA — Authentication failed
Reason: Authentication failed — the provider rejected the API key.
Check: • API key (re-paste it in AI Settings) • selected model • endpoint / base URL
```

Retry policy: only `retryable` categories, max 2 attempts, 700 ms × attempt
backoff. Never retry an auth failure, never retry a cancellation.

**Always redact.** `redactSecrets(text, [config.apiKey])` runs on every provider
message, body excerpt, log line and status event. A provider that echoes the key
back must not be able to get it into the UI, the console or a file.

## 9. Credential protection

* Keys live in IndexedDB `pharmatrack_ai_credentials`; configuration lives in
  localStorage `pharmatrack_ai_settings` with the key fields stripped on write.
* Nothing that serialises state may include a key: `stripCredentials()` for
  config objects, `scrubSecretsDeep()` for arbitrary JSON, `looksLikeApiKey()`
  and `maskKey()` for display and tests.
* Semester archives and `.pharmatrack` backups never carry keys — enforced in
  `buildPackageEntries` and covered by `src/test/ai-security.test.ts` (acceptance G).
* Conversations keep `providerId`/`model` **per message**, so history written by
  NVIDIA stays readable after switching to Gemini, and history is academic data
  that never travels with credentials.

## 10. Future local AI

`protocol: 'local'` and the `local` provider kind are reserved for Ollama /
llama.cpp / LM Studio, which expose an OpenAI-compatible HTTP API. Adding them is
a preset plus a base URL (`http://localhost:11434/v1`) — no engine change, and
`apiRoot()` already tolerates a pasted full path. The abstraction is ready; the
implementation is deliberately not shipped yet.

---

## Testing

```
npx tsc --noEmit      # types
npx vitest run        # full suite (engine, security, acceptance, readers, archives)
npx eslint src        # lint
npx vite build        # production build
```

The AI suites mock the network at the `fetch` boundary (`vi.stubGlobal`), so they
assert what actually goes on the wire:

* `src/test/ai-engine.test.ts` — adapters, streaming, errors, retry, fallback,
  capability routing, Test Connection, model discovery, context building.
* `src/test/ai-security.test.ts` — key handling: settings strip, header (never
  URL) placement, redaction, migration, backup exclusion.
* `src/test/ai-acceptance.test.tsx` — the A–H walkthrough end to end through
  `AIChatPanel`: generate, switch provider, fallback notice, PDF page context,
  PPT slide context, question provenance, no key in the DOM, restart restores
  providers/profiles/history/academic data.

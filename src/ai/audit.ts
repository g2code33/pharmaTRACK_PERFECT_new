/**
 * PharmaTRACK AI Safe Audit Trail.
 *
 * Records non-sensitive security and operational metadata:
 * - provider configured
 * - provider updated
 * - provider removed
 * - provider test succeeded
 * - provider test failed
 *
 * Critical security guarantee: raw secrets, tokens, and authorization headers
 * are never recorded. Details are deeply sanitized and scrubbed before storage.
 */
import * as idb from 'idb-keyval';
import type { ProviderId } from './types';
import { scrubSecretsDeep } from './credentials';

export const AI_AUDIT_LOG_KEY = 'pharmatrack_ai_audit_log';
export const MAX_AUDIT_EVENTS = 100;

export type AIAuditAction =
  | 'provider configured'
  | 'provider updated'
  | 'provider removed'
  | 'provider test succeeded'
  | 'provider test failed';

export interface AIAuditEvent {
  id: string;
  action: AIAuditAction;
  providerId: ProviderId;
  timestamp: string;
  details?: Record<string, unknown>;
}

type AuditListener = (event: AIAuditEvent) => void;
const listeners = new Set<AuditListener>();
let memoryLog: AIAuditEvent[] | null = null;

function sanitizeAuditDetails(
  details?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(details)) {
    // Drop any key that resembles a credential or token property
    if (
      /^(api[_-]?key|apikey|key|secret|password|auth|authorization|token|credentials|encryptedSecret)$/i.test(
        key,
      )
    ) {
      continue;
    }
    // Deeply scrub strings or objects
    sanitized[key] = scrubSecretsDeep(val);
  }
  return sanitized;
}

async function readLog(): Promise<AIAuditEvent[]> {
  if (memoryLog !== null) return [...memoryLog];
  try {
    const stored = await idb.get<AIAuditEvent[]>(AI_AUDIT_LOG_KEY);
    memoryLog = Array.isArray(stored) ? stored : [];
  } catch {
    memoryLog = [];
  }
  return [...memoryLog];
}

async function persistLog(events: AIAuditEvent[]): Promise<void> {
  memoryLog = events;
  try {
    await idb.set(AI_AUDIT_LOG_KEY, events);
  } catch {
    /* Audit persistence failure must not crash the application */
  }
}

/**
 * Records a safe AI operational/configuration event.
 * Never logs secrets.
 */
export async function recordAIAudit(
  action: AIAuditAction,
  providerId: ProviderId,
  details?: Record<string, unknown>,
): Promise<AIAuditEvent> {
  const current = await readLog();
  const event: AIAuditEvent = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    action,
    providerId,
    timestamp: new Date().toISOString(),
    details: sanitizeAuditDetails(details),
  };

  const next = [event, ...current].slice(0, MAX_AUDIT_EVENTS);
  await persistLog(next);

  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* observer errors must not interrupt caller */
    }
  }

  return event;
}

/** Retrieves all stored audit events in reverse-chronological order. */
export async function getAIAuditEvents(): Promise<AIAuditEvent[]> {
  return readLog();
}

/** Clears all audit events (e.g. on account deletion or test teardown). */
export async function clearAIAuditEvents(): Promise<void> {
  memoryLog = [];
  try {
    await idb.del(AI_AUDIT_LOG_KEY);
  } catch {
    /* ignore deletion errors */
  }
}

/** Subscribes to live audit events. */
export function onAIAudit(listener: AuditListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

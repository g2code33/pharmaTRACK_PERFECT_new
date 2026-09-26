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

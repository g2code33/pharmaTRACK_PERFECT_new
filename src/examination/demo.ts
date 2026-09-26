import { digestJson, randomId } from './crypto';

export type DemoEventType =
  | 'STARTUP'
  | 'AUTHENTICATION_BURST'
  | 'ANSWER_REVISION'
  | 'LAN_INTERRUPTION'
  | 'RECONNECT'
  | 'DEVICE_REPLACEMENT'
  | 'ADMIN_DEVICE_REPLACEMENT'
  | 'PRIMARY_FAILURE'
  | 'SECONDARY_FAILOVER'
  | 'RECONCILIATION'
  | 'TIMER_ADJUSTMENT'
  | 'FORCE_SUBMISSION'
  | 'SECURITY_EVENT'
  | 'SUBMISSION'
  | 'ARCHIVE';

export interface DemoEvent {
  id: string;
  type: DemoEventType;
  at: string;
  detail: string;
  studentCount: number;
}
export interface DemoSimulation {
  id: string;
  studentCount: number;
  packageStagedOnce: boolean;
  students: Array<{
    id: string;
    deviceA: string;
    deviceB: string;
    attemptId: string;
    answerRevisions: number;
  }>;
  events: DemoEvent[];
  expectedAuthority: 'SECONDARY';
  reconciledEvents: number;
  results: number;
  auditEvents: number;
}
export interface DemoLoadMetric {
  students: number;
  packageTransfers: number;
  authenticationRequests: number;
  answerEvents: number;
  heartbeatMessages: number;
  reconnects: number;
  submissions: number;
  failoverEvents: number;
  maxConcurrentOperations: number;
}

export async function runDemoSimulation(studentCount = 50): Promise<DemoSimulation> {
  if (![50, 100, 200, 300, 500].includes(studentCount))
    throw new Error('Demo load supports exactly 50, 100, 200, 300, or 500 students.');
  const now = Date.now();
  const at = (offset: number) => new Date(now + offset).toISOString();
  const students = Array.from({ length: studentCount }, (_, index) => ({
    id: `demo-student-${index + 1}`,
    deviceA: `demo-pc-${index + 1}`,
    deviceB: `demo-android-${index + 1}`,
    attemptId: `demo-attempt-${index + 1}`,
    answerRevisions: 2,
  }));
  const event = (
    type: DemoEventType,
    offset: number,
    detail: string,
    count = studentCount,
  ): DemoEvent => ({
    id: randomId('demo_event'),
    type,
    at: at(offset),
    detail,
    studentCount: count,
  });
  const events = [
    event('STARTUP', 0, 'Signed .pharmaexam package staged once on all ready devices.'),
    event('AUTHENTICATION_BURST', 1000, 'RX30 identity authentication burst.'),
    event('ANSWER_REVISION', 60_000, 'Compact answer revisions queued locally.'),
    event(
      'LAN_INTERRUPTION',
      2_400_000,
      'Primary LAN unavailable; encrypted local state remains active.',
    ),
    event(
      'DEVICE_REPLACEMENT',
      2_460_000,
      'Selected students continue the same attempt on Device B.',
      Math.ceil(studentCount / 10),
    ),
    event('RECONNECT', 2_520_000, 'Queued answer events reconnect and acknowledge idempotently.'),
    event('ADMIN_DEVICE_REPLACEMENT', 2_580_000, 'Admin Device B discovers the existing session.'),
    event('PRIMARY_FAILURE', 2_700_000, 'Primary server heartbeat expires at minute 45.'),
    event(
      'SECONDARY_FAILOVER',
      2_706_000,
      'Controlled administrator-confirmed secondary promotion.',
    ),
    event('RECONCILIATION', 2_712_000, 'Latest answer revisions and timer epoch reconcile.'),
    event(
      'TIMER_ADJUSTMENT',
      2_730_000,
      'Administrator grants a recorded accommodation to one student.',
      1,
    ),
    event(
      'SECURITY_EVENT',
      2_760_000,
      'Focus and recovery events are audited without labeling network loss as cheating.',
    ),
    event('FORCE_SUBMISSION', 3_600_000, 'One administrator force-submission is recorded.', 1),
    event('SUBMISSION', 3_660_000, 'All remaining active attempts submit.'),
    event('ARCHIVE', 3_720_000, 'Examination results and audit records are ready for archive.'),
  ];
  return {
    id: randomId('demo'),
    studentCount,
    packageStagedOnce: true,
    students,
    events,
    expectedAuthority: 'SECONDARY',
    reconciledEvents: studentCount * 2,
    results: studentCount,
    auditEvents: events.length + studentCount * 2,
  };
}

export async function runDemoLoadMatrix(): Promise<DemoLoadMetric[]> {
  const matrix: DemoLoadMetric[] = [];
  for (const students of [50, 100, 200, 300, 500]) {
    const answerEvents = students * 4;
    matrix.push({
      students,
      packageTransfers: 1,
      authenticationRequests: students,
      answerEvents,
      heartbeatMessages: Math.ceil(students / 25) * 60,
      reconnects: students,
      submissions: students,
      failoverEvents: 1,
      maxConcurrentOperations: students,
    });
  }
  await digestJson(matrix);
  return matrix;
}

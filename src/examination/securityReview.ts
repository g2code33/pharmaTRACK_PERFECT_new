import type { ExaminationState } from './types';

export interface SecurityReviewFinding {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
}
export interface SecurityReviewReport {
  passed: boolean;
  checkedAt: string;
  findings: SecurityReviewFinding[];
}

export function reviewExaminationSecurity(state: ExaminationState): SecurityReviewReport {
  const findings: SecurityReviewFinding[] = [];
  const rawState = JSON.stringify(state);
  for (const student of state.students) {
    if (
      Object.prototype.hasOwnProperty.call(
        student as unknown as Record<string, unknown>,
        'password',
      )
    )
      findings.push({
        id: `plaintext-password:${student.id}`,
        severity: 'critical',
        title: 'Plaintext student password found',
        detail: 'Student identities must contain only password verifiers.',
      });
  }
  const activeByStudent = new Map<string, string[]>();
  for (const attempt of state.attempts.filter((item) =>
    ['ACTIVE', 'PAUSED', 'RECOVERY_PENDING'].includes(item.status),
  ))
    activeByStudent.set(attempt.studentId, [
      ...(activeByStudent.get(attempt.studentId) || []),
      attempt.id,
    ]);
  for (const [studentId, attempts] of activeByStudent)
    if (attempts.length > 1)
      findings.push({
        id: `duplicate-attempt:${studentId}`,
        severity: 'critical',
        title: 'Multiple active attempts',
        detail: `${studentId} has ${attempts.length} active attempts.`,
      });
  const duplicateEvents = new Set<string>();
  for (const event of state.syncEvents)
    if (duplicateEvents.has(event.id))
      findings.push({
        id: `duplicate-sync:${event.id}`,
        severity: 'critical',
        title: 'Duplicate synchronization event',
        detail: `Event ${event.id} appears more than once.`,
      });
    else duplicateEvents.add(event.id);
  for (const attempt of state.attempts) {
    if (attempt.timerState && attempt.timerState.originalDurationMinutes <= 0)
      findings.push({
        id: `timer:${attempt.id}`,
        severity: 'critical',
        title: 'Invalid attempt timer',
        detail: 'Original duration must remain positive.',
      });
    if (attempt.status === 'ACTIVE' && !attempt.deviceSessionId)
      findings.push({
        id: `device:${attempt.id}`,
        severity: 'critical',
        title: 'Active attempt without device owner',
        detail: 'Only an authenticated device session may own an active attempt.',
      });
  }
  if (rawState.includes('"password":"') || rawState.includes('"examPassword":"'))
    findings.push({
      id: 'plaintext-password-scan',
      severity: 'critical',
      title: 'Plaintext password pattern found',
      detail: 'Examination state must store verifiers, never plaintext passwords.',
    });
  return {
    passed: findings.every((finding) => finding.severity !== 'critical'),
    checkedAt: new Date().toISOString(),
    findings,
  };
}

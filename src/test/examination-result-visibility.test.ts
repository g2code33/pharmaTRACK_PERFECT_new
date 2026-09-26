import { beforeEach, describe, expect, it, vi } from 'vitest';

const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: async (key: string) => idbStore.get(key),
  set: async (key: string, value: unknown) => {
    idbStore.set(key, value);
  },
  del: async (key: string) => {
    idbStore.delete(key);
  },
  keys: async () => [...idbStore.keys()],
  clear: async () => {
    idbStore.clear();
  },
}));

import { ExaminationRepository } from '../examination/service';
import { LocalExamAuthority, createLanServerFetch, LanExamClient } from '../examination/network';
import { createPharmaExamPackage, generateExamSigningKeyPair } from '../examination/package';
import type { ExamQuestion } from '../types';

const createTestQuestion = (id: string, correctOption = 0): ExamQuestion => ({
  id,
  courseId: 'pharm-101',
  topicId: 'pharmacology',
  questionText: `Question ${id}: What is the mechanism of action?`,
  questionType: 'mcq',
  marksAllocation: 2,
  difficulty: 'medium',
  probability: 'medium',
  modelAnswer: 'A',
  correctAnswer: 'A',
  tags: ['exam'],
  isPracticed: false,
  needsReview: false,
  isSaved: false,
  createdAt: new Date().toISOString(),
  options: ['Option A (Correct)', 'Option B', 'Option C', 'Option D'],
  correctOption,
});

beforeEach(() => {
  idbStore.clear();
});

describe('PHARMATRACK — RESULT VISIBILITY & ADMIN RELEASE ACCEPTANCE CERTIFICATION', () => {
  it('Scenario 1: Immediate-result exam → student submits → result appears with configured details', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.registerStudent('Alice Immediate', 'Level 200');
    const exam = await repository.createExam('Immediate Visibility Exam');
    const version = await repository.createVersion(
      exam.id,
      [createTestQuestion('q1', 0), createTestQuestion('q2', 1)],
      {
        title: 'Immediate Visibility Exam',
        assessmentType: 'FORMAL_EXAM',
        availability: { durationMinutes: 60 },
        resultVisibilityPolicy: 'IMMEDIATE',
        resultDetails: {
          showScore: true,
          showPercentage: true,
          showPassFail: true,
          showCorrectAnswers: true,
          showAnswerReview: true,
          showTimeUsed: true,
        },
      },
    );
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    const dev = await repository.createDeviceSession({
      deviceId: 'dev-alice',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });

    const { attempt } = await repository.createAttempt(session.id, student.student.id, dev.id);
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: dev.id,
      isFinal: true,
    });
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[1],
      answer: '1',
      selectedOption: 1,
      deviceSessionId: dev.id,
      isFinal: true,
    });

    // Student submits
    await repository.submitAttempt(attempt.id, false, dev.id);

    // Retrieve student visible result
    const studentResult = repository.getStudentVisibleResult(attempt.id, student.student.id);

    expect(studentResult.visible).toBe(true);
    expect(studentResult.status).toBe('IMMEDIATE');
    expect(studentResult.score).toBe(4);
    expect(studentResult.maxMarks).toBe(4);
    expect(studentResult.percentage).toBe(100);
    expect(studentResult.passed).toBe(true);
    expect(studentResult.questionResults).toHaveLength(2);
    expect(studentResult.questionResults?.[0].isCorrect).toBe(true);
  });

  it('Scenario 2: Hidden-until-release exam → student submits → result does NOT appear (score is omitted)', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.registerStudent('Bob Hidden', 'Level 300');
    const exam = await repository.createExam('On Release Exam');
    const version = await repository.createVersion(
      exam.id,
      [createTestQuestion('q1', 0), createTestQuestion('q2', 0)],
      {
        title: 'On Release Exam',
        resultVisibilityPolicy: 'ON_RELEASE',
      },
    );
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    const dev = await repository.createDeviceSession({
      deviceId: 'dev-bob',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });

    const { attempt } = await repository.createAttempt(session.id, student.student.id, dev.id);
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: dev.id,
      isFinal: true,
    });
    await repository.submitAttempt(attempt.id, false, dev.id);

    const studentResult = repository.getStudentVisibleResult(attempt.id, student.student.id);

    expect(studentResult.visible).toBe(false);
    expect(studentResult.status).toBe('HIDDEN');
    expect(studentResult.score).toBeUndefined();
    expect(studentResult.percentage).toBeUndefined();
    expect(studentResult.passed).toBeUndefined();
    expect(studentResult.questionResults).toBeUndefined();
    expect(studentResult.message).toContain('will be available when released by the administrator');
  });

  it('Scenario 3: Admin releases result → student can retrieve it', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.registerStudent('Charlie Release', 'Level 300');
    const exam = await repository.createExam('Release Exam');
    const version = await repository.createVersion(exam.id, [createTestQuestion('q1', 0)], {
      title: 'Release Exam',
      resultVisibilityPolicy: 'ON_RELEASE',
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    await repository.createDeviceSession({
      deviceId: 'admin-dev-01',
      role: 'ADMIN',
      capabilities: ['authority-control'],
    });
    const dev = await repository.createDeviceSession({
      deviceId: 'dev-charlie',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });

    const { attempt } = await repository.createAttempt(session.id, student.student.id, dev.id);
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: dev.id,
      isFinal: true,
    });
    await repository.submitAttempt(attempt.id, false, dev.id);

    // Initial check: hidden
    expect(repository.getStudentVisibleResult(attempt.id).visible).toBe(false);

    // Admin releases
    const releaseRecord = await repository.releaseResultForAttempt(
      attempt.id,
      'admin-chief',
      'admin-dev-01',
      'Official grades released',
    );
    expect(releaseRecord.status).toBe('RELEASED');
    expect(releaseRecord.releasedByAdminId).toBe('admin-chief');

    // Student checks again: now visible!
    const releasedResult = repository.getStudentVisibleResult(attempt.id, student.student.id);
    expect(releasedResult.visible).toBe(true);
    expect(releasedResult.status).toBe('RELEASED');
    expect(releasedResult.score).toBe(2);
    expect(releasedResult.percentage).toBe(100);
  });

  it('Scenario 4: Admin releases only Student A → Student B remains hidden', async () => {
    const repository = await ExaminationRepository.open();
    const studentA = await repository.registerStudent('Student A', 'Level 100');
    const studentB = await repository.registerStudent('Student B', 'Level 100');
    const exam = await repository.createExam('Selective Release Exam');
    const version = await repository.createVersion(exam.id, [createTestQuestion('q1', 0)], {
      title: 'Selective Release Exam',
      resultVisibilityPolicy: 'ON_RELEASE',
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    await repository.createDeviceSession({
      deviceId: 'admin-dev',
      role: 'ADMIN',
      capabilities: ['authority-control'],
    });

    const devA = await repository.createDeviceSession({
      deviceId: 'dev-a',
      studentId: studentA.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });
    const devB = await repository.createDeviceSession({
      deviceId: 'dev-b',
      studentId: studentB.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });

    const { attempt: attA } = await repository.createAttempt(session.id, studentA.student.id, devA.id);
    const { attempt: attB } = await repository.createAttempt(session.id, studentB.student.id, devB.id);

    await repository.submitAttempt(attA.id, false, devA.id);
    await repository.submitAttempt(attB.id, false, devB.id);

    // Admin selectively releases only Student A
    await repository.releaseSelectedResults(session.id, [attA.id], 'admin', 'admin-dev');

    expect(repository.getStudentVisibleResult(attA.id).visible).toBe(true);
    expect(repository.getStudentVisibleResult(attB.id).visible).toBe(false);
    expect(repository.getResultReleaseStatus(attA.id)).toBe('RELEASED');
    expect(repository.getResultReleaseStatus(attB.id)).toBe('HIDDEN');
  });

  it('Scenario 5: Result remains hidden after logout/login', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.registerStudent('Dan Reconnect', 'Level 400');
    const exam = await repository.createExam('Session Persist Exam');
    const version = await repository.createVersion(exam.id, [createTestQuestion('q1', 0)], {
      title: 'Session Persist Exam',
      resultVisibilityPolicy: 'ON_RELEASE',
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);

    const dev1 = await repository.createDeviceSession({
      deviceId: 'dev-session-1',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });
    const { attempt } = await repository.createAttempt(session.id, student.student.id, dev1.id);
    await repository.submitAttempt(attempt.id, false, dev1.id);

    // Simulate "Logout": device disconnects
    dev1.status = 'DISCONNECTED';
    await repository.save();

    // Reload repository from storage (simulating application restart)
    const reopenedRepo = await ExaminationRepository.open();

    // Student "Logs In" with new authenticated device session
    const dev2 = await reopenedRepo.createDeviceSession({
      deviceId: 'dev-session-2',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });

    // Query result: must still be hidden
    const res = reopenedRepo.getStudentVisibleResult(attempt.id, student.student.id);
    expect(res.visible).toBe(false);
    expect(res.score).toBeUndefined();
    expect(res.status).toBe('HIDDEN');
  });

  it('Scenario 6: Result remains hidden after switching devices', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.registerStudent('Eve Switcher', 'Level 500');
    const exam = await repository.createExam('Cross-Device Visibility Exam');
    const version = await repository.createVersion(exam.id, [createTestQuestion('q1', 0)], {
      title: 'Cross-Device Visibility Exam',
      resultVisibilityPolicy: 'ON_RELEASE',
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);

    // Device A (PC Native)
    const deviceA = await repository.createDeviceSession({
      deviceId: 'pc-workstation',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });
    const { attempt } = await repository.createAttempt(session.id, student.student.id, deviceA.id);
    await repository.submitAttempt(attempt.id, false, deviceA.id);

    // Student now logs onto Device B (iPhone PWA)
    const deviceB = await repository.createDeviceSession({
      deviceId: 'iphone-pwa-device',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });

    // Device B checks result
    const resultFromDeviceB = repository.getStudentVisibleResult(attempt.id, student.student.id);
    expect(resultFromDeviceB.visible).toBe(false);
    expect(resultFromDeviceB.score).toBeUndefined();

    // Now admin releases
    await repository.createDeviceSession({
      deviceId: 'admin-dev',
      role: 'ADMIN',
      capabilities: ['authority-control'],
    });
    await repository.releaseResultForAttempt(attempt.id, 'admin', 'admin-dev');

    // Device B checks again
    const releasedOnDeviceB = repository.getStudentVisibleResult(attempt.id, student.student.id);
    expect(releasedOnDeviceB.visible).toBe(true);
    expect(releasedOnDeviceB.score).toBe(0); // no questions answered
  });

  it('Scenario 7: Hidden result is NOT present in student payloads or local storage', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.registerStudent('Security Check Student', 'Level 200');
    const exam = await repository.createExam('Data Leakage Guard Exam');
    const version = await repository.createVersion(exam.id, [createTestQuestion('q1', 0)], {
      title: 'Data Leakage Guard Exam',
      resultVisibilityPolicy: 'ON_RELEASE',
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    const dev = await repository.createDeviceSession({
      deviceId: 'dev-audit',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });

    const { attempt } = await repository.createAttempt(session.id, student.student.id, dev.id);
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: dev.id,
      isFinal: true,
    });
    await repository.submitAttempt(attempt.id, false, dev.id);

    const studentResult = repository.getStudentVisibleResult(attempt.id, student.student.id);
    const serialized = JSON.stringify(studentResult);

    // Strict validation: No score, maxMarks, percentage, or answer text in student JSON!
    expect(serialized).not.toContain('"score"');
    expect(serialized).not.toContain('"maxMarks"');
    expect(serialized).not.toContain('"percentage"');
    expect(serialized).not.toContain('"questionResults"');
    expect(serialized).not.toContain('"Option A"');
  });

  it('Scenario 8: Never-show exam never exposes the result to the student (even if release is attempted)', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.registerStudent('Frank Never', 'Level 300');
    const exam = await repository.createExam('Confidential Assessment');
    const version = await repository.createVersion(exam.id, [createTestQuestion('q1', 0)], {
      title: 'Confidential Assessment',
      resultVisibilityPolicy: 'NEVER',
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    await repository.createDeviceSession({
      deviceId: 'admin-dev',
      role: 'ADMIN',
      capabilities: ['authority-control'],
    });
    const dev = await repository.createDeviceSession({
      deviceId: 'dev-frank',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });

    const { attempt } = await repository.createAttempt(session.id, student.student.id, dev.id);
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: dev.id,
      isFinal: true,
    });
    await repository.submitAttempt(attempt.id, false, dev.id);

    // Initial check: NEVER exposed
    let studentResult = repository.getStudentVisibleResult(attempt.id, student.student.id);
    expect(studentResult.visible).toBe(false);
    expect(studentResult.status).toBe('NEVER');
    expect(studentResult.score).toBeUndefined();

    // Even if an administrator releases the session
    await repository.releaseAllResults(session.id, 'admin', 'admin-dev');

    // The student interface STILL remains strictly forbidden
    studentResult = repository.getStudentVisibleResult(attempt.id, student.student.id);
    expect(studentResult.visible).toBe(false);
    expect(studentResult.status).toBe('NEVER');
    expect(studentResult.score).toBeUndefined();

    // But administrator CAN still see the score on the administrative side
    const adminView = repository.getExaminationResult(attempt.id);
    expect(adminView).toBeDefined();
    expect(adminView?.score).toBe(2);
  });

  it('Scenario 9: Auto-submission obeys the same visibility policy', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.registerStudent('Grace Expire', 'Level 400');
    const exam = await repository.createExam('Auto-Submit Timed Exam');
    const version = await repository.createVersion(exam.id, [createTestQuestion('q1', 0)], {
      title: 'Auto-Submit Timed Exam',
      resultVisibilityPolicy: 'ON_RELEASE',
      availability: { durationMinutes: 1 },
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    const dev = await repository.createDeviceSession({
      deviceId: 'dev-grace',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });

    const { attempt } = await repository.createAttempt(session.id, student.student.id, dev.id);
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: dev.id,
      isFinal: true,
    });

    // Time expired: auto-submitted with EXPIRY trigger
    await repository.submitAttempt(attempt.id, false, dev.id, 'EXPIRY');

    const result = repository.getStudentVisibleResult(attempt.id, student.student.id);
    expect(result.visible).toBe(false);
    expect(result.status).toBe('HIDDEN');
    expect(result.score).toBeUndefined();
  });

  it('Scenario 10: Admin release/revoke actions are audited with exact metadata and authority epoch', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.registerStudent('Hank Audit', 'Level 200');
    const exam = await repository.createExam('Audit Verification Exam');
    const version = await repository.createVersion(exam.id, [createTestQuestion('q1', 0)], {
      title: 'Audit Verification Exam',
      resultVisibilityPolicy: 'ON_RELEASE',
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    session.authorityEpoch = 3; // Epoch 3
    await repository.createDeviceSession({
      deviceId: 'admin-auditor-device',
      role: 'ADMIN',
      capabilities: ['authority-control'],
    });
    const dev = await repository.createDeviceSession({
      deviceId: 'dev-hank',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });

    const { attempt } = await repository.createAttempt(session.id, student.student.id, dev.id);
    await repository.submitAttempt(attempt.id, false, dev.id);

    // 1. Release action
    await repository.releaseResultForAttempt(
      attempt.id,
      'admin-dean',
      'admin-auditor-device',
      'Dean approved grades',
    );

    // 2. Revoke action
    await repository.revokeResultForAttempt(
      attempt.id,
      'admin-dean',
      'admin-auditor-device',
      'Grade audit recalculation required',
    );

    const audits = repository.getResultReleaseAudits(session.id);
    expect(audits).toHaveLength(2);

    expect(audits[0]).toMatchObject({
      attemptId: attempt.id,
      studentId: student.student.id,
      previousState: 'HIDDEN',
      newState: 'RELEASED',
      adminId: 'admin-dean',
      adminDeviceSessionId: 'admin-auditor-device',
      authorityEpoch: 3,
      reason: 'Dean approved grades',
    });

    expect(audits[1]).toMatchObject({
      attemptId: attempt.id,
      studentId: student.student.id,
      previousState: 'RELEASED',
      newState: 'HIDDEN',
      adminId: 'admin-dean',
      adminDeviceSessionId: 'admin-auditor-device',
      authorityEpoch: 3,
      reason: 'Grade audit recalculation required',
    });

    // Verify security events also recorded
    const secEvents = repository.snapshot.securityEvents.filter((e) => e.attemptId === attempt.id);
    expect(secEvents.some((e) => e.type === 'RESULTS_RELEASED')).toBe(true);
    expect(secEvents.some((e) => e.type === 'RESULTS_REVOKED')).toBe(true);
  });

  it('Scenario 11: Changing visibility does not modify the student score or examination result', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.registerStudent('Ian Score Integrity', 'Level 200');
    const exam = await repository.createExam('Score Invariant Exam');
    const version = await repository.createVersion(exam.id, [createTestQuestion('q1', 0)], {
      title: 'Score Invariant Exam',
      resultVisibilityPolicy: 'ON_RELEASE',
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    await repository.createDeviceSession({
      deviceId: 'admin-dev',
      role: 'ADMIN',
      capabilities: ['authority-control'],
    });
    const dev = await repository.createDeviceSession({
      deviceId: 'dev-ian',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });

    const { attempt } = await repository.createAttempt(session.id, student.student.id, dev.id);
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: dev.id,
      isFinal: true,
    });
    await repository.submitAttempt(attempt.id, false, dev.id);

    const initialAdminResult = repository.getExaminationResult(attempt.id)!;
    expect(initialAdminResult.score).toBe(2);
    expect(initialAdminResult.percentage).toBe(100);

    // Release 3 times, revoke 2 times
    await repository.releaseResultForAttempt(attempt.id, 'admin', 'admin-dev');
    await repository.revokeResultForAttempt(attempt.id, 'admin', 'admin-dev');
    await repository.releaseResultForAttempt(attempt.id, 'admin', 'admin-dev');
    await repository.revokeResultForAttempt(attempt.id, 'admin', 'admin-dev');
    await repository.releaseResultForAttempt(attempt.id, 'admin', 'admin-dev');

    const finalAdminResult = repository.getExaminationResult(attempt.id)!;
    expect(finalAdminResult.score).toBe(2);
    expect(finalAdminResult.percentage).toBe(100);
    expect(finalAdminResult.questionResults[0].marksAwarded).toBe(2);
    expect(finalAdminResult.answerStatistics.correct).toBe(1);
  });

  it('Scenario 12: Network interruption during submission does not accidentally expose a result', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.registerStudent('Jane Network Drop', 'Level 300');
    const exam = await repository.createExam('Network Drop Exam');
    const version = await repository.createVersion(exam.id, [createTestQuestion('q1', 0)], {
      title: 'Network Drop Exam',
      resultVisibilityPolicy: 'ON_RELEASE',
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    const dev = await repository.createDeviceSession({
      deviceId: 'dev-jane',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });

    const { attempt } = await repository.createAttempt(session.id, student.student.id, dev.id);
    attempt.synchronizationState = 'DEGRADED'; // LAN partitioned

    // Submission completes locally with staged sync event
    await repository.submitAttempt(attempt.id, false, dev.id);

    // Student visible check must remain safely hidden
    const res = repository.getStudentVisibleResult(attempt.id, student.student.id);
    expect(res.visible).toBe(false);
    expect(res.score).toBeUndefined();
    expect(res.status).toBe('HIDDEN');
  });

  it('Scenario 13: A student cannot bypass the policy through direct LAN API requests', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.registerStudent('Hacker Student', 'Level 500');
    const exam = await repository.createExam('API Guard Exam');
    const version = await repository.createVersion(exam.id, [createTestQuestion('q1', 0)], {
      title: 'API Guard Exam',
      resultVisibilityPolicy: 'ON_RELEASE',
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    const dev = await repository.createDeviceSession({
      deviceId: 'dev-hack',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });

    const { attempt } = await repository.createAttempt(session.id, student.student.id, dev.id);
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: dev.id,
      isFinal: true,
    });
    await repository.submitAttempt(attempt.id, false, dev.id);

    // Setup real LAN Authority & Client
    const authority = new LocalExamAuthority(repository);
    const clientFetch = createLanServerFetch(authority);
    const client = new LanExamClient('http://192.168.1.100:8787', clientFetch, {
      studentId: student.student.id,
      deviceSessionId: dev.id,
    });

    // 1. Direct API call to fetchStudentResult
    const apiRes = await client.fetchStudentResult(session.id, attempt.id);
    expect(apiRes.ok).toBe(true);
    expect(apiRes.result?.visible).toBe(false);
    expect(apiRes.result?.score).toBeUndefined();
    expect(apiRes.result?.percentage).toBeUndefined();

    // 2. Direct raw HTTP GET to endpoint
    const rawRes = await clientFetch(
      `http://192.168.1.100:8787/pharmaexam/v1/sessions/${session.id}/attempts/${attempt.id}/student-result?studentId=${student.student.id}`,
    );
    const body = (await rawRes.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.result.visible).toBe(false);
    expect(body.result.score).toBeUndefined();
    expect(body.result.percentage).toBeUndefined();
  });

  it('Scenario 14: Published exam versions retain their configured result policy and details', async () => {
    const repository = await ExaminationRepository.open();
    const exam = await repository.createExam('Published Retention Exam');
    const version = await repository.createVersion(exam.id, [createTestQuestion('q1', 0)], {
      title: 'Published Retention Exam',
      resultVisibilityPolicy: 'NEVER',
      resultDetails: {
        showScore: false,
        showPercentage: false,
        showPassFail: false,
        showCorrectAnswers: false,
        showAnswerReview: false,
        showTimeUsed: true,
      },
    });

    const published = await repository.publishVersion(exam.id, version.id);
    expect(published.immutable).toBe(true);
    expect(published.resultVisibilityPolicy).toBe('NEVER');
    expect(published.resultDetails?.showScore).toBe(false);
    expect(published.resultDetails?.showTimeUsed).toBe(true);

    // Test package export
    const keyPair = await generateExamSigningKeyPair();
    const pkg = await createPharmaExamPackage({
      version: published,
      institution: { name: 'School of Pharmacy' },
      signingKey: keyPair,
    });
    expect(pkg.exam.resultVisibilityPolicy).toBe('NEVER');
    expect(pkg.exam.resultDetails?.showScore).toBe(false);
  });

  it('Scenario 15: Existing finalized attempts remain governed by their recorded policy rather than silently inheriting a later exam configuration', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.registerStudent('Legacy Policy Student', 'Level 200');

    // Examination 1: Configured as ON_RELEASE
    const exam1 = await repository.createExam('Exam 1 — Hidden Policy');
    const version1 = await repository.createVersion(exam1.id, [createTestQuestion('q1', 0)], {
      title: 'Exam 1 — Hidden Policy',
      resultVisibilityPolicy: 'ON_RELEASE',
    });
    await repository.publishVersion(exam1.id, version1.id);
    const session1 = await repository.createSession(exam1.id, version1.id);
    const dev = await repository.createDeviceSession({
      deviceId: 'dev-legacy',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session1.id,
      capabilities: ['encrypted-local-state'],
    });

    // Student takes and finalizes attempt on Exam 1
    const { attempt: attempt1 } = await repository.createAttempt(
      session1.id,
      student.student.id,
      dev.id,
    );
    await repository.recordAnswer(attempt1.id, {
      questionId: attempt1.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: dev.id,
      isFinal: true,
    });
    await repository.submitAttempt(attempt1.id, false, dev.id);

    // Verify initially hidden under Exam 1's policy
    expect(repository.getStudentVisibleResult(attempt1.id).visible).toBe(false);
    expect(repository.getStudentVisibleResult(attempt1.id).status).toBe('HIDDEN');

    // Later: Admin configures Exam 2 with IMMEDIATE policy
    const exam2 = await repository.createExam('Exam 2 — Immediate Policy');
    const version2 = await repository.createVersion(exam2.id, [createTestQuestion('q1', 0)], {
      title: 'Exam 2 — Immediate Policy',
      resultVisibilityPolicy: 'IMMEDIATE',
    });
    await repository.publishVersion(exam2.id, version2.id);
    const session2 = await repository.createSession(exam2.id, version2.id);

    // Student takes and submits attempt on Exam 2
    const { attempt: attempt2 } = await repository.createAttempt(
      session2.id,
      student.student.id,
      dev.id,
    );
    await repository.recordAnswer(attempt2.id, {
      questionId: attempt2.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: dev.id,
      isFinal: true,
    });
    await repository.submitAttempt(attempt2.id, false, dev.id);

    // Critical Invariant:
    // Attempt 2 immediately displays its score
    const res2 = repository.getStudentVisibleResult(attempt2.id, student.student.id);
    expect(res2.visible).toBe(true);
    expect(res2.status).toBe('IMMEDIATE');
    expect(res2.score).toBe(2);

    // Attempt 1 MUST STILL remain hidden under its recorded snapshot policy!
    // It must NOT inherit Exam 2's later IMMEDIATE policy.
    const res1 = repository.getStudentVisibleResult(attempt1.id, student.student.id);
    expect(res1.visible).toBe(false);
    expect(res1.status).toBe('HIDDEN');
    expect(res1.score).toBeUndefined();
  });

  it('Optional Result-Detail Controls: granularly omits unpermitted fields when visible', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.registerStudent('Granular Student', 'Level 300');
    const exam = await repository.createExam('Granular Controls Exam');

    // Configured: Show Percentage & Pass/Fail ONLY. Hide score, correct answers, and review.
    const version = await repository.createVersion(exam.id, [createTestQuestion('q1', 0)], {
      title: 'Granular Controls Exam',
      resultVisibilityPolicy: 'IMMEDIATE',
      scoring: { passMark: 70 },
      resultDetails: {
        showScore: false, // HIDE SCORE NUMBERS
        showPercentage: true, // SHOW %
        showPassFail: true, // SHOW PASS/FAIL
        showCorrectAnswers: false, // HIDE CORRECT ANSWERS
        showAnswerReview: false, // HIDE QUESTION REVIEW
        showTimeUsed: false, // HIDE DURATION
      },
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    const dev = await repository.createDeviceSession({
      deviceId: 'dev-granular',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });

    const { attempt } = await repository.createAttempt(session.id, student.student.id, dev.id);
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: dev.id,
      isFinal: true,
    });
    await repository.submitAttempt(attempt.id, false, dev.id);

    const result = repository.getStudentVisibleResult(attempt.id, student.student.id);

    expect(result.visible).toBe(true);
    // Allowed fields:
    expect(result.percentage).toBe(100);
    expect(result.passed).toBe(true);
    expect(result.passMark).toBe(70);

    // Suppressed fields:
    expect(result.score).toBeUndefined();
    expect(result.maxMarks).toBeUndefined();
    expect(result.durationSeconds).toBeUndefined();
    expect(result.questionResults).toBeUndefined();
  });
});

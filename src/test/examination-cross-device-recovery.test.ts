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
import { LocalExamAuthority } from '../examination/network';
import { reconcileAnswer, reconcileAttempt } from '../examination/sync';
import { remainingMilliseconds } from '../examination/timer';
import type { ExamQuestion } from '../types';
import type { ExamAnswer, KioskPlatform } from '../examination/types';

function generate20ExamQuestions(): ExamQuestion[] {
  return Array.from({ length: 20 }, (_, i) => {
    const idx = i + 1;
    return {
      id: `q-${idx}`,
      courseId: 'pharma-cross-device',
      topicId: 'clinical-pharmacology',
      questionText: `Clinical Pharmacology Question ${idx}: What is the therapeutic significance of parameter ${idx}?`,
      questionType: 'mcq' as const,
      marksAllocation: 2,
      difficulty: idx % 3 === 0 ? ('hard' as const) : idx % 2 === 0 ? ('medium' as const) : ('easy' as const),
      probability: 'high' as const,
      modelAnswer: `Correct Therapeutic Answer ${idx}`,
      correctAnswer: `Correct Therapeutic Answer ${idx}`,
      tags: ['clinical', 'cross-device-recovery'],
      isPracticed: false,
      needsReview: false,
      isSaved: false,
      createdAt: '2026-09-26T00:00:00.000Z',
      options: [
        `Correct Therapeutic Answer ${idx}`,
        `Distractor Choice A for Q${idx}`,
        `Distractor Choice B for Q${idx}`,
        `Distractor Choice C for Q${idx}`,
      ],
      correctOption: 0,
    };
  });
}

async function setupCrossDeviceExamSession() {
  const repository = await ExaminationRepository.open();
  const exam = await repository.createExam('Pharmacology Cross-Device Clinical Examination');
  const questions = generate20ExamQuestions();
  const version = await repository.createVersion(exam.id, questions, {
    title: 'Pharmacology Cross-Device Clinical Examination',
    assessmentType: 'KIOSK_EXAM',
    availability: { durationMinutes: 60 },
    security: {
      kioskMode: true,
      requireLanAuthority: true,
      allowBackNavigation: false,
      allowQuestionNavigation: true,
      allowReviewBeforeSubmit: true,
    },
    navigation: {
      randomizeQuestions: false,
      randomizeOptions: false,
      allowPrevious: true,
      showQuestionNumbers: true,
    },
  });
  const published = await repository.publishVersion(exam.id, version.id);
  const session = await repository.createSession(
    exam.id,
    published.id,
    'lan-authoritative-server-01',
    'http://192.168.1.150:8787',
  );
  const authority = new LocalExamAuthority(repository);
  return { repository, exam, version: published, session, authority, questions: published.questions };
}

describe('PHARMATRACK — CROSS-DEVICE EXAM RECOVERY', () => {
  beforeEach(() => {
    idbStore.clear();
  });

  describe('Core 11-Step Simulation: Device A -> Disconnect -> Device B Continue -> Submit', () => {
    it('executes the full 11-step lifecycle without duplicate attempts, preserving all 20 answers and authoritative timer', async () => {
      const { repository, session, questions } = await setupCrossDeviceExamSession();

      // Step 1: Device A active
      // Student registers with First Name, Level, and obtains sequential RX30 kiosk credential
      const { student, password: kioskPassword } = await repository.registerStudent('Ama Serwaa', 'Level 400');
      expect(kioskPassword).toMatch(/^RX30/);

      // Verify initial cross-device recovery state is NOT_STARTED
      expect(repository.getCrossDeviceRecoveryState(session.id, student.id)).toBe('NOT_STARTED');

      // Device A connects as PC Native
      const deviceSessionA = await repository.createDeviceSession({
        deviceId: 'device-pc-hardware-uuid-101',
        role: 'STUDENT',
        studentId: student.id,
        sessionId: session.id,
        platform: 'native-pc',
        capabilities: ['native-kiosk', 'encrypted-local-state', 'attempt-recovery'],
      });
      expect(deviceSessionA.status).toBe('CONNECTED');

      // Attempt started on Device A
      const startResult = await repository.createAttempt(session.id, student.id, deviceSessionA.id);
      expect(startResult.continued).toBe(false);
      const attemptA = startResult.attempt;
      expect(attemptA.status).toBe('ACTIVE');
      expect(attemptA.recoveryStatus).toBe('ACTIVE');
      expect(attemptA.deviceSessionId).toBe(deviceSessionA.id);
      expect(attemptA.platform).toBe('native-pc');
      expect(attemptA.answers).toHaveLength(0);
      expect(repository.getCrossDeviceRecoveryState(session.id, student.id)).toBe('ACTIVE');

      const originalDeadlineAt = attemptA.deadlineAt;
      const originalStartedAt = attemptA.startedAt;
      expect(originalDeadlineAt).toBeDefined();

      // Step 2: Answer 20 questions on Device A
      for (let i = 0; i < 20; i++) {
        const q = questions[i];
        const savedAnswer = await repository.recordAnswer(attemptA.id, {
          questionId: q.id,
          answer: '0', // option 0 is the correct option
          selectedOption: 0,
          deviceSessionId: deviceSessionA.id,
          isFinal: false,
        });
        expect(savedAnswer.revision).toBe(i + 1);
        expect(savedAnswer.deviceSessionId).toBe(deviceSessionA.id);
      }

      const activeAttemptBeforeDrop = repository.snapshot.attempts.find((a) => a.id === attemptA.id)!;
      expect(activeAttemptBeforeDrop.answers).toHaveLength(20);
      expect(activeAttemptBeforeDrop.localRevision).toBe(20);

      // Step 3: Disconnect Device A (e.g. battery dies, network drops, OS crash)
      await repository.markDeviceDisconnected(deviceSessionA.id, 'Simulated PC power failure / battery depletion.');
      const disconnectedDeviceA = repository.snapshot.deviceSessions.find((d) => d.id === deviceSessionA.id)!;
      expect(disconnectedDeviceA.status).toBe('DISCONNECTED');

      const lostAttempt = repository.snapshot.attempts.find((a) => a.id === attemptA.id)!;
      expect(lostAttempt.status).toBe('DEVICE_LOST');
      expect(lostAttempt.recoveryStatus).toBe('DEVICE_LOST');
      expect(lostAttempt.synchronizationState).toBe('RECOVERY_PENDING');
      expect(repository.getCrossDeviceRecoveryState(session.id, student.id)).toBe('DEVICE_LOST');

      // Verify security audit log contains DEVICE_DISCONNECT
      const disconnectEvent = repository.snapshot.securityEvents.find(
        (e) => e.type === 'DEVICE_DISCONNECT' && e.deviceSessionId === deviceSessionA.id,
      );
      expect(disconnectEvent).toBeDefined();
      expect(disconnectEvent?.details).toContain('battery depletion');

      // Step 4: Modify/sync valid state
      // Simulate that prior to network loss, the last valid answer revision was acknowledged or local state held
      // Reconcile checks: local unsynchronized answer with higher revision is authoritative and never overwritten
      const localAnswerSnapshot: ExamAnswer = {
        questionId: questions[19].id,
        answer: '0',
        selectedOption: 0,
        answeredAt: new Date().toISOString(),
        revision: 20,
        deviceSessionId: deviceSessionA.id,
        isFinal: false,
      };
      const staleServerAnswerSnapshot: ExamAnswer = {
        questionId: questions[19].id,
        answer: '1',
        selectedOption: 1,
        answeredAt: new Date(Date.now() - 30_000).toISOString(),
        revision: 19,
        deviceSessionId: deviceSessionA.id,
        isFinal: false,
      };
      const reconciliation = reconcileAnswer(localAnswerSnapshot, staleServerAnswerSnapshot);
      expect(reconciliation.winner.revision).toBe(20);
      expect(reconciliation.winner.answer).toBe('0');
      expect(reconciliation.reason).toBe('Local answer has a newer revision.');

      // Step 5: Device B authenticates
      // Student opens Device B (iPhone PWA) and enters First Name, Level, and RX30 password
      const authenticatedStudent = await repository.authenticateStudent('Ama Serwaa', 'Level 400', kioskPassword);
      expect(authenticatedStudent.id).toBe(student.id);

      const deviceSessionB = await repository.createDeviceSession({
        deviceId: 'device-iphone-pwa-uuid-202',
        role: 'STUDENT',
        studentId: student.id,
        sessionId: session.id,
        platform: 'IOS_PWA',
        capabilities: ['ios-pwa-kiosk', 'touch-targets-accessible', 'encrypted-local-state'],
      });
      expect(deviceSessionB.status).toBe('CONNECTED');

      // Step 6: Continue Exam on Device B
      // Device B calls createAttempt -> discovers existing attempt for Student + Session
      const recoveryResult = await repository.createAttempt(session.id, student.id, deviceSessionB.id);
      expect(recoveryResult.continued).toBe(true);
      const recoveredAttempt = recoveryResult.attempt;

      // Rule: An attempt belongs to Student + Session + Attempt, NOT the physical device
      expect(recoveredAttempt.id).toBe(attemptA.id);
      expect(recoveredAttempt.deviceSessionId).toBe(deviceSessionB.id);
      expect(recoveredAttempt.platform).toBe('IOS_PWA');
      expect(recoveredAttempt.ownershipGeneration).toBe(2);
      expect(recoveredAttempt.status).toBe('ACTIVE');
      expect(recoveredAttempt.recoveryStatus).toBe('RECOVERED');
      expect(repository.getCrossDeviceRecoveryState(session.id, student.id)).toBe('RECOVERED');

      // Device A is confirmed disconnected and inactive
      const checkDeviceA = repository.snapshot.deviceSessions.find((d) => d.id === deviceSessionA.id)!;
      expect(checkDeviceA.status).toBe('DISCONNECTED');

      // Security audit trail recorded DEVICE_SWITCH
      const switchEvent = repository.snapshot.securityEvents.find(
        (e) => e.type === 'DEVICE_SWITCH' && e.attemptId === attemptA.id,
      );
      expect(switchEvent).toBeDefined();
      expect(switchEvent?.details).toBe(
        `Attempt ownership moved from ${deviceSessionA.id} to ${deviceSessionB.id}.`,
      );

      // Rejection of stale device session: Device A attempts to record an answer
      await expect(
        repository.recordAnswer(attemptA.id, {
          questionId: questions[0].id,
          answer: '2',
          selectedOption: 2,
          deviceSessionId: deviceSessionA.id,
          isFinal: false,
        }),
      ).rejects.toThrow('This device session no longer owns the active attempt. Continue Exam on the active device.');

      // Rejection of stale device session: Device A attempts to submit
      await expect(
        repository.submitAttempt(attemptA.id, false, deviceSessionA.id, 'MANUAL'),
      ).rejects.toThrow('This device session no longer owns the active attempt.');

      // Step 7: Verify all answers preserved
      expect(recoveredAttempt.answers).toHaveLength(20);
      for (let i = 0; i < 20; i++) {
        const q = questions[i];
        const ans = recoveredAttempt.answers.find((a) => a.questionId === q.id);
        expect(ans).toBeDefined();
        expect(ans?.answer).toBe('0');
        expect(ans?.selectedOption).toBe(0);
      }

      // Step 8: Verify authoritative timer
      // Deadline is preserved from initial attempt start; device change did NOT reset or add time
      expect(recoveredAttempt.deadlineAt).toBe(originalDeadlineAt);
      expect(recoveredAttempt.startedAt).toBe(originalStartedAt);
      expect(recoveredAttempt.timerState?.authoritativeDeadlineAt).toBe(originalDeadlineAt);
      const remainingMs = remainingMilliseconds(recoveredAttempt.timerState!, new Date().toISOString());
      expect(remainingMs).toBeGreaterThan(0);
      expect(remainingMs).toBeLessThanOrEqual(60 * 60_000);

      // Step 9: Verify no duplicate attempt
      const allAttemptsForStudent = repository.snapshot.attempts.filter(
        (a) => a.sessionId === session.id && a.studentId === student.id,
      );
      expect(allAttemptsForStudent).toHaveLength(1);
      expect(allAttemptsForStudent[0].id).toBe(attemptA.id);
      expect(session.studentAttemptIds.filter((id) => id === attemptA.id)).toHaveLength(1);

      // Step 10: Submit on Device B
      // Passwordless student submission
      const submittedAttempt = await repository.submitAttempt(
        recoveredAttempt.id,
        false,
        deviceSessionB.id,
        'MANUAL',
      );
      expect(submittedAttempt.status).toBe('SUBMITTED');
      expect(submittedAttempt.recoveryStatus).toBe('SUBMITTED');
      expect(submittedAttempt.submissionState).toBe('SUBMITTED');
      expect(submittedAttempt.submissionTrigger).toBe('MANUAL');
      expect(submittedAttempt.submittedAt).toBeDefined();
      expect(repository.getCrossDeviceRecoveryState(session.id, student.id)).toBe('SUBMITTED');

      // Verify submit audit event logged without password requirement
      const submitEvent = repository.snapshot.securityEvents.find(
        (e) => e.type === 'SUBMITTED' && e.attemptId === attemptA.id,
      );
      expect(submitEvent).toBeDefined();
      expect(submitEvent?.details).toBe('Student submitted the examination; no password was requested.');

      // Step 11: Verify one final result
      const allResultsForAttempt = repository.snapshot.results.filter((r) => r.attemptId === attemptA.id);
      expect(allResultsForAttempt).toHaveLength(1);
      const finalResult = allResultsForAttempt[0];
      expect(finalResult.studentId).toBe(student.id);
      expect(finalResult.examId).toBe(session.examId);
      expect(finalResult.questionResults).toHaveLength(20);
      expect(finalResult.answerStatistics.answered).toBe(20);
      expect(finalResult.answerStatistics.correct).toBe(20);
      expect(finalResult.score).toBe(40); // 20 questions * 2 marks
      expect(finalResult.percentage).toBe(100);

      // Second submit is idempotent and returns the same existing result
      const secondSubmit = await repository.submitAttempt(recoveredAttempt.id, false, deviceSessionB.id, 'MANUAL');
      expect(secondSubmit.status).toBe('SUBMITTED');
      expect(repository.snapshot.results.filter((r) => r.attemptId === attemptA.id)).toHaveLength(1);
    });
  });

  describe('Standard Recovery State Transitions: 7 Enforced States', () => {
    it('accurately traces NOT_STARTED -> ACTIVE -> DEVICE_LOST -> RECOVERY_PENDING -> RECOVERED -> SUBMITTED', async () => {
      const { repository, session } = await setupCrossDeviceExamSession();
      const { student } = await repository.registerStudent('Kwame Osei', 'Level 300');

      // 1. NOT_STARTED
      expect(repository.getCrossDeviceRecoveryState(session.id, student.id)).toBe('NOT_STARTED');

      // 2. ACTIVE
      const devA = await repository.createDeviceSession({
        deviceId: 'dev-pc-kwame',
        role: 'STUDENT',
        studentId: student.id,
        sessionId: session.id,
        platform: 'native-pc',
        capabilities: ['encrypted-local-state'],
      });
      const { attempt } = await repository.createAttempt(session.id, student.id, devA.id);
      expect(repository.getCrossDeviceRecoveryState(session.id, student.id)).toBe('ACTIVE');

      // 3. DEVICE_LOST
      await repository.markDeviceDisconnected(devA.id, 'Cable unplugged');
      expect(repository.getCrossDeviceRecoveryState(session.id, student.id)).toBe('DEVICE_LOST');

      // 4. RECOVERY_PENDING (simulate prolonged synchronization failure)
      await repository.markSynchronizationUnavailable(session.id, 'LAN gateway rebooting', true);
      expect(repository.getCrossDeviceRecoveryState(session.id, student.id)).toBe('RECOVERY_PENDING');

      // 5. RECOVERED (Device B reconnects)
      const devB = await repository.createDeviceSession({
        deviceId: 'dev-android-kwame',
        role: 'STUDENT',
        studentId: student.id,
        sessionId: session.id,
        platform: 'android',
        capabilities: ['encrypted-local-state'],
      });
      const continued = await repository.createAttempt(session.id, student.id, devB.id);
      expect(continued.continued).toBe(true);
      expect(repository.getCrossDeviceRecoveryState(session.id, student.id)).toBe('RECOVERED');

      // 6. SUBMITTED
      await repository.submitAttempt(attempt.id, false, devB.id, 'MANUAL');
      expect(repository.getCrossDeviceRecoveryState(session.id, student.id)).toBe('SUBMITTED');
    });

    it('enforces LOCKED state on administrative termination or critical security policy violation', async () => {
      const { repository, session } = await setupCrossDeviceExamSession();
      const { student } = await repository.registerStudent('Esi Mansah', 'Level 200');

      const adminDevice = await repository.createDeviceSession({
        deviceId: 'admin-console-01',
        role: 'ADMIN',
        sessionId: session.id,
        platform: 'native-pc',
        capabilities: ['admin-controls'],
      });

      const studentDev = await repository.createDeviceSession({
        deviceId: 'student-dev-esi',
        role: 'STUDENT',
        studentId: student.id,
        sessionId: session.id,
        platform: 'web',
        capabilities: ['encrypted-local-state'],
      });
      const { attempt } = await repository.createAttempt(session.id, student.id, studentDev.id);
      expect(repository.getCrossDeviceRecoveryState(session.id, student.id)).toBe('ACTIVE');

      // Proctor / Admin terminates attempt
      await repository.terminateAttempt(attempt.id, 'proctor-01', adminDevice.id, 'Unauthorized external materials detected.');
      expect(repository.getCrossDeviceRecoveryState(session.id, student.id)).toBe('LOCKED');

      const lockedAttempt = repository.snapshot.attempts.find((a) => a.id === attempt.id)!;
      expect(lockedAttempt.status).toBe('LOCKED');
      expect(lockedAttempt.recoveryStatus).toBe('LOCKED');
    });
  });

  describe('Cross-Platform Device Transitions', () => {
    const matrixTransitions: Array<{ from: KioskPlatform; to: KioskPlatform; label: string }> = [
      { from: 'native-pc', to: 'IOS_PWA', label: 'PC Native to iPhone PWA' },
      { from: 'android', to: 'web', label: 'Android Native to Web Browser' },
      { from: 'IOS_PWA', to: 'native-pc', label: 'iPhone PWA to PC Native' },
      { from: 'web', to: 'android', label: 'Web Browser to Android Native' },
    ];

    for (const transition of matrixTransitions) {
      it(`transitions successfully from ${transition.label} without data loss`, async () => {
        const { repository, session, questions } = await setupCrossDeviceExamSession();
        const studentName = `Student-${transition.from}-to-${transition.to}`;
        const { student, password: kioskPassword } = await repository.registerStudent(studentName, 'Level 400');

        // Initial device
        const dev1 = await repository.createDeviceSession({
          deviceId: `hardware-id-${transition.from}`,
          role: 'STUDENT',
          studentId: student.id,
          sessionId: session.id,
          platform: transition.from,
          capabilities: ['encrypted-local-state'],
        });
        const { attempt } = await repository.createAttempt(session.id, student.id, dev1.id);
        expect(attempt.platform).toBe(transition.from);

        // Answer first 5 questions on device 1
        for (let i = 0; i < 5; i++) {
          await repository.recordAnswer(attempt.id, {
            questionId: questions[i].id,
            answer: '0',
            selectedOption: 0,
            deviceSessionId: dev1.id,
            isFinal: false,
          });
        }

        // Disconnect device 1
        await repository.markDeviceDisconnected(dev1.id, `Simulated drop on ${transition.from}`);

        // Device 2 authenticates
        await repository.authenticateStudent(studentName, 'Level 400', kioskPassword);
        const dev2 = await repository.createDeviceSession({
          deviceId: `hardware-id-${transition.to}`,
          role: 'STUDENT',
          studentId: student.id,
          sessionId: session.id,
          platform: transition.to,
          capabilities: ['encrypted-local-state'],
        });

        // Continue exam on device 2
        const recovered = await repository.createAttempt(session.id, student.id, dev2.id);
        expect(recovered.continued).toBe(true);
        expect(recovered.attempt.id).toBe(attempt.id);
        expect(recovered.attempt.platform).toBe(transition.to);
        expect(recovered.attempt.answers).toHaveLength(5);
        expect(recovered.attempt.deviceSessionId).toBe(dev2.id);

        // Answer remaining 15 questions on device 2
        for (let i = 5; i < 20; i++) {
          await repository.recordAnswer(attempt.id, {
            questionId: questions[i].id,
            answer: '0',
            selectedOption: 0,
            deviceSessionId: dev2.id,
            isFinal: false,
          });
        }

        // Submit on device 2
        const finalized = await repository.submitAttempt(attempt.id, false, dev2.id, 'MANUAL');
        expect(finalized.status).toBe('SUBMITTED');
        expect(finalized.answers).toHaveLength(20);

        const result = repository.snapshot.results.find((r) => r.attemptId === attempt.id)!;
        expect(result.answerStatistics.correct).toBe(20);
        expect(result.percentage).toBe(100);
      });
    }
  });

  describe('LAN Failure & Local Encrypted State Superiority', () => {
    it('preserves student-side higher monotonic revisions and prevents older server snapshots from overwriting', async () => {
      const { repository, session, questions } = await setupCrossDeviceExamSession();
      const { student } = await repository.registerStudent('Kojo Antwi', 'Level 400');

      const dev = await repository.createDeviceSession({
        deviceId: 'dev-kojo-pc',
        role: 'STUDENT',
        studentId: student.id,
        sessionId: session.id,
        platform: 'native-pc',
        capabilities: ['encrypted-local-state'],
      });

      const { attempt } = await repository.createAttempt(session.id, student.id, dev.id);

      // Student answers question 1 with revision 1
      const ans1 = await repository.recordAnswer(attempt.id, {
        questionId: questions[0].id,
        answer: 'First Local Selection',
        selectedOption: 1,
        deviceSessionId: dev.id,
        isFinal: false,
      });
      expect(ans1.revision).toBe(1);

      // Student modifies answer to question 1 with revision 2 locally while offline
      const ans2 = await repository.recordAnswer(attempt.id, {
        questionId: questions[0].id,
        answer: 'Updated Correct Selection',
        selectedOption: 0,
        deviceSessionId: dev.id,
        isFinal: false,
      });
      expect(ans2.revision).toBe(2);

      // Simulate incoming stale server snapshot with revision 1
      const staleServerAnswer: ExamAnswer = {
        questionId: questions[0].id,
        answer: 'First Local Selection',
        selectedOption: 1,
        answeredAt: ans1.answeredAt,
        revision: 1,
        deviceSessionId: dev.id,
        isFinal: false,
      };

      const reconciled = reconcileAnswer(ans2, staleServerAnswer);
      // Local answer wins because local revision (2) > server revision (1)
      expect(reconciled.winner.revision).toBe(2);
      expect(reconciled.winner.answer).toBe('Updated Correct Selection');
      expect(reconciled.reason).toBe('Local answer has a newer revision.');

      // Full attempt reconciliation preserves the newer revision
      const localAttempt = repository.snapshot.attempts.find((a) => a.id === attempt.id)!;
      const incomingAttempt = {
        ...localAttempt,
        answers: [staleServerAnswer],
      };
      const mergedAttempt = reconcileAttempt(localAttempt, incomingAttempt);
      const mergedQ1 = mergedAttempt.answers.find((a) => a.questionId === questions[0].id)!;
      expect(mergedQ1.revision).toBe(2);
      expect(mergedQ1.answer).toBe('Updated Correct Selection');
    });

    it('resolves duplicate answer events idempotently without conflict', () => {
      const duplicateAnswerA: ExamAnswer = {
        questionId: 'q-5',
        answer: 'Therapeutic Answer 5',
        selectedOption: 0,
        answeredAt: '2026-09-26T10:00:00.000Z',
        revision: 5,
        eventId: 'event-sync-dup-555',
        deviceSessionId: 'dev-session-dup',
        isFinal: false,
      };
      const duplicateAnswerB: ExamAnswer = { ...duplicateAnswerA };

      const result = reconcileAnswer(duplicateAnswerA, duplicateAnswerB);
      expect(result.conflict).toBe(false);
      expect(result.winner).toEqual(duplicateAnswerA);
      expect(result.reason).toBe('Duplicate event is idempotent.');
    });
  });

  describe('Authoritative Timer Expiration During Device Transition', () => {
    it('finalizes attempt via timer expiry even if student device is lost, without requiring a password', async () => {
      const { repository, session, questions } = await setupCrossDeviceExamSession();
      const { student } = await repository.registerStudent('Abena Poku', 'Level 400');

      const devA = await repository.createDeviceSession({
        deviceId: 'dev-abena-pc',
        role: 'STUDENT',
        studentId: student.id,
        sessionId: session.id,
        platform: 'native-pc',
        capabilities: ['encrypted-local-state'],
      });

      const { attempt } = await repository.createAttempt(session.id, student.id, devA.id);

      // Student answers 10 questions before laptop battery dies
      for (let i = 0; i < 10; i++) {
        await repository.recordAnswer(attempt.id, {
          questionId: questions[i].id,
          answer: '0',
          selectedOption: 0,
          deviceSessionId: devA.id,
          isFinal: false,
        });
      }

      // Laptop shuts down
      await repository.markDeviceDisconnected(devA.id, 'Battery completely depleted.');
      expect(repository.getCrossDeviceRecoveryState(session.id, student.id)).toBe('DEVICE_LOST');

      // The student does not find another device before the exam duration ends.
      // The authoritative timer expires on the LAN server authority.
      // Authority force-submits with trigger 'EXPIRY'
      const expiredAttempt = await repository.submitAttempt(attempt.id, true, undefined, 'EXPIRY');
      expect(expiredAttempt.status).toBe('SUBMITTED');
      expect(expiredAttempt.submissionTrigger).toBe('EXPIRY');
      expect(expiredAttempt.submissionState).toBe('EXPIRED');

      // One final result is generated for the work done prior to expiration
      const finalResult = repository.snapshot.results.find((r) => r.attemptId === attempt.id)!;
      expect(finalResult.answerStatistics.answered).toBe(10);
      expect(finalResult.answerStatistics.correct).toBe(10);
      expect(finalResult.score).toBe(20); // 10 * 2 marks

      // Security event records passwordless expiry finalization
      const expiryEvent = repository.snapshot.securityEvents.find(
        (e) => e.type === 'EXPIRY_SUBMITTED' && e.attemptId === attempt.id,
      );
      expect(expiryEvent).toBeDefined();
    });
  });

  describe('Multi-Device Hop Recovery: Device A -> Device B -> Device C', () => {
    it('supports multiple sequential recoveries with monotonically increasing ownership generations', async () => {
      const { repository, session, questions } = await setupCrossDeviceExamSession();
      const { student, password: kioskPassword } = await repository.registerStudent('Yaw Boateng', 'Level 300');

      // Device A (PC Native)
      const devA = await repository.createDeviceSession({
        deviceId: 'pc-yaw-dev-1',
        role: 'STUDENT',
        studentId: student.id,
        sessionId: session.id,
        platform: 'native-pc',
        capabilities: ['encrypted-local-state'],
      });
      const { attempt } = await repository.createAttempt(session.id, student.id, devA.id);
      expect(attempt.ownershipGeneration).toBe(1);

      // Answer Q1-Q5 on Device A
      for (let i = 0; i < 5; i++) {
        await repository.recordAnswer(attempt.id, {
          questionId: questions[i].id,
          answer: '0',
          selectedOption: 0,
          deviceSessionId: devA.id,
          isFinal: false,
        });
      }

      // Disconnect Device A
      await repository.markDeviceDisconnected(devA.id, 'Device A thermal shutdown');

      // Device B (Android Native)
      await repository.authenticateStudent('Yaw Boateng', 'Level 300', kioskPassword);
      const devB = await repository.createDeviceSession({
        deviceId: 'android-yaw-dev-2',
        role: 'STUDENT',
        studentId: student.id,
        sessionId: session.id,
        platform: 'android',
        capabilities: ['encrypted-local-state'],
      });
      const recoveredB = await repository.createAttempt(session.id, student.id, devB.id);
      expect(recoveredB.continued).toBe(true);
      expect(recoveredB.attempt.ownershipGeneration).toBe(2);
      expect(recoveredB.attempt.deviceSessionId).toBe(devB.id);

      // Answer Q6-Q12 on Device B
      for (let i = 5; i < 12; i++) {
        await repository.recordAnswer(attempt.id, {
          questionId: questions[i].id,
          answer: '0',
          selectedOption: 0,
          deviceSessionId: devB.id,
          isFinal: false,
        });
      }

      // Disconnect Device B (e.g. tablet dropped, screen broke)
      await repository.markDeviceDisconnected(devB.id, 'Tablet physical screen damage');

      // Device C (iPhone PWA)
      await repository.authenticateStudent('Yaw Boateng', 'Level 300', kioskPassword);
      const devC = await repository.createDeviceSession({
        deviceId: 'iphone-yaw-dev-3',
        role: 'STUDENT',
        studentId: student.id,
        sessionId: session.id,
        platform: 'IOS_PWA',
        capabilities: ['encrypted-local-state'],
      });
      const recoveredC = await repository.createAttempt(session.id, student.id, devC.id);
      expect(recoveredC.continued).toBe(true);
      expect(recoveredC.attempt.ownershipGeneration).toBe(3);
      expect(recoveredC.attempt.deviceSessionId).toBe(devC.id);

      // Both Device A and Device B are disconnected
      expect(repository.snapshot.deviceSessions.find((d) => d.id === devA.id)!.status).toBe('DISCONNECTED');
      expect(repository.snapshot.deviceSessions.find((d) => d.id === devB.id)!.status).toBe('DISCONNECTED');

      // Both Device A and Device B are rejected from answering
      await expect(
        repository.recordAnswer(attempt.id, {
          questionId: questions[12].id,
          answer: '1',
          selectedOption: 1,
          deviceSessionId: devA.id,
          isFinal: false,
        }),
      ).rejects.toThrow('This device session no longer owns the active attempt.');

      await expect(
        repository.recordAnswer(attempt.id, {
          questionId: questions[12].id,
          answer: '1',
          selectedOption: 1,
          deviceSessionId: devB.id,
          isFinal: false,
        }),
      ).rejects.toThrow('This device session no longer owns the active attempt.');

      // Answer Q13-Q20 on Device C
      for (let i = 12; i < 20; i++) {
        await repository.recordAnswer(attempt.id, {
          questionId: questions[i].id,
          answer: '0',
          selectedOption: 0,
          deviceSessionId: devC.id,
          isFinal: false,
        });
      }

      // Submit on Device C
      const finalized = await repository.submitAttempt(attempt.id, false, devC.id, 'MANUAL');
      expect(finalized.status).toBe('SUBMITTED');
      expect(finalized.answers).toHaveLength(20);

      // Verify audit trail logged 2 DEVICE_SWITCH events
      const switchEvents = repository.snapshot.securityEvents.filter((e) => e.type === 'DEVICE_SWITCH');
      expect(switchEvents).toHaveLength(2);

      // Verify single final result
      const allResults = repository.snapshot.results.filter((r) => r.attemptId === attempt.id);
      expect(allResults).toHaveLength(1);
      expect(allResults[0].answerStatistics.correct).toBe(20);
      expect(allResults[0].score).toBe(40);
    });
  });
});

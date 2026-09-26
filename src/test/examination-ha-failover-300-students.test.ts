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

import { ExaminationHighAvailability } from '../examination/ha';
import { ExaminationRepository } from '../examination/service';
import { emptyExaminationState, type ExamQuestionSnapshot } from '../examination/types';
import type { ExamQuestion } from '../types';
import type { SyncEvent } from '../examination/types';

function createQuestions(): ExamQuestion[] {
  return [
    {
      id: 'ha-q1-pk',
      courseId: 'pharma-ha',
      topicId: 'pharmacokinetics',
      questionText: 'What parameter determines the time required to reach steady state drug concentration?',
      questionType: 'mcq',
      marksAllocation: 2,
      difficulty: 'medium',
      probability: 'high',
      modelAnswer: 'Elimination half-life (t1/2)',
      correctAnswer: 'Elimination half-life (t1/2)',
      tags: ['pk', 'ha-failover'],
      isPracticed: false,
      needsReview: false,
      isSaved: false,
      createdAt: '2026-09-26T00:00:00.000Z',
      options: [
        'Elimination half-life (t1/2)',
        'Volume of distribution (Vd)',
        'Bioavailability (F)',
        'Renal clearance rate',
      ],
      correctOption: 0,
    },
    {
      id: 'ha-q2-tox',
      courseId: 'pharma-ha',
      topicId: 'toxicology',
      questionText: 'Which antidote is indicated for acute paracetamol (acetaminophen) toxicity?',
      questionType: 'mcq',
      marksAllocation: 2,
      difficulty: 'easy',
      probability: 'high',
      modelAnswer: 'N-acetylcysteine (NAC)',
      correctAnswer: 'N-acetylcysteine (NAC)',
      tags: ['toxicology', 'ha-failover'],
      isPracticed: false,
      needsReview: false,
      isSaved: false,
      createdAt: '2026-09-26T00:00:00.000Z',
      options: [
        'N-acetylcysteine (NAC)',
        'Naloxone',
        'Atropine sulfate',
        'Flumazenil',
      ],
      correctOption: 0,
    },
  ];
}

describe('PHARMATRACK — HIGH AVAILABILITY FAILOVER & RESILIENCE CERTIFICATION', () => {
  beforeEach(() => {
    idbStore.clear();
  });

  describe('Critical Scenario: 300 Active Students Failover at 40 Minutes', () => {
    it(
      'replicates 300 active attempts, survives catastrophic primary failure at 40 min, promotes secondary to epoch 2, reconciles uncommitted local answers, preserves timers, and submits with zero loss',
      async () => {
        const studentCount = 300;
        const examStartTime = '2026-09-26T10:00:00.000Z';
        const replicationTime = '2026-09-26T10:10:00.000Z';
        const primaryFailureTime = '2026-09-26T10:40:00.000Z';
        const failoverPromoteTime = '2026-09-26T10:40:05.000Z';
        const originalExpectedDeadline = '2026-09-26T11:00:00.000Z'; // 60 minutes after start

        // 1. Initialize Primary Authority and Examination
        const primaryRepo = await ExaminationRepository.open();
        const exam = await primaryRepo.createExam('University Clinical Pharmacy Licensure Exam');
        const version = await primaryRepo.createVersion(exam.id, createQuestions(), {
          title: 'Licensure Version 2026.1',
          assessmentType: 'KIOSK_EXAM',
          availability: { durationMinutes: 60 },
          maxAttempts: 1,
          security: { kioskMode: true, requireLanAuthority: true },
        });
        await primaryRepo.publishVersion(exam.id, version.id);
        const session = await primaryRepo.createSession(exam.id, version.id, 'primary-authority-node');

        // Admin session
        const adminSession = await primaryRepo.createDeviceSession({
          id: 'admin-primary-session',
          deviceId: 'admin-laptop-01',
          role: 'ADMIN',
          sessionId: session.id,
          capabilities: ['authority-control', 'session-admin'],
        });

        // 2. Setup Secondary Authority and Coordinator
        const secondaryRepo = ExaminationRepository.fromSnapshot(emptyExaminationState());
        const coordinator = new ExaminationHighAvailability(primaryRepo, secondaryRepo, {
          primary: { serverId: 'primary-authority-node', authorityId: 'lan-cluster-alpha' },
          secondary: { serverId: 'secondary-failover-node', authorityId: 'lan-cluster-alpha' },
        });
        await coordinator.initialize();

        // 3. Connect 300 students and start attempts on Primary
        const students = await Promise.all(
          Array.from({ length: studentCount }, async (_, i) => {
            const name = `Candidate_${String(i + 1).padStart(3, '0')}`;
            const reg = await primaryRepo.registerStudent(name, 'Level 400');
            const student = reg.student;
            const deviceSession = await primaryRepo.createDeviceSession({
              deviceId: `device-hardware-uuid-${String(i + 1).padStart(3, '0')}`,
              studentId: student.id,
              role: 'STUDENT',
              sessionId: session.id,
              platform: i % 3 === 0 ? 'native-pc' : i % 2 === 0 ? 'IOS_PWA' : 'web',
              capabilities: ['encrypted-local-state', 'offline-recovery'],
            });
            const attemptResult = await primaryRepo.createAttempt(
              session.id,
              student.id,
              deviceSession.id,
              examStartTime,
            );
            return {
              student,
              deviceSession,
              attemptId: attemptResult.attempt.id,
              index: i,
            };
          }),
        );

        expect(students).toHaveLength(studentCount);

        // 4. All 300 students answer Question 1 and sync to Primary
        const q1Id = version.questions[0].id;
        const q2Id = version.questions[1].id;

        const q1Events: SyncEvent[] = students.map((s) => ({
          id: `evt-q1-s${s.index}`,
          eventId: `ans-q1-s${s.index}`,
          sessionId: session.id,
          entity: 'ANSWER',
          entityId: q1Id,
          sourceServerId: 'student-client',
          authorityEpoch: 1,
          revision: 1,
          at: '2026-09-26T10:05:00.000Z',
          direction: 'LOCAL_TO_SERVER',
          status: 'PENDING',
          questionId: q1Id,
          answerRevision: 1,
          payload: {
            attemptId: s.attemptId,
            answer: '0',
            selectedOption: 0,
            deviceSessionId: s.deviceSession.id,
            isFinal: false,
          },
        }));

        const q1Sync = await primaryRepo.processIncomingSyncEvents(session.id, q1Events);
        expect(q1Sync.ok).toBe(true);
        expect(q1Sync.applied).toBe(studentCount);

        // 5. Durable replication to Secondary at 10 minutes (10:10:00)
        await coordinator.heartbeat('primary-authority-node', '2026-09-26T10:09:59.000Z');
        const replicationSnapshot = await coordinator.replicateToSecondary(session.id, replicationTime);
        expect(replicationSnapshot.payload.students).toHaveLength(studentCount);
        expect(replicationSnapshot.payload.attempts).toHaveLength(studentCount);
        expect(secondaryRepo.snapshot.attempts).toHaveLength(studentCount);

        // 6. At 40 minutes (10:40:00), students answer Question 2 locally on their devices
        // These answers are held in students' local encrypted queues and have not yet reached Primary
        const q2UnsyncedEvents: SyncEvent[] = students.map((s) => ({
          id: `evt-q2-s${s.index}`,
          eventId: `ans-q2-s${s.index}`,
          sessionId: session.id,
          entity: 'ANSWER',
          entityId: q2Id,
          sourceServerId: 'student-client',
          authorityEpoch: 1,
          revision: 2,
          at: '2026-09-26T10:39:50.000Z',
          direction: 'LOCAL_TO_SERVER',
          status: 'PENDING',
          questionId: q2Id,
          answerRevision: 2,
          payload: {
            attemptId: s.attemptId,
            answer: '0',
            selectedOption: 0,
            deviceSessionId: s.deviceSession.id,
            isFinal: true,
          },
        }));

        // Check authoritative timer before failover: 40 minutes in -> exactly 20 minutes remaining!
        const timerBeforeFailover = await secondaryRepo.getAttemptTimer(
          students[0].attemptId,
          primaryFailureTime,
        );
        expect(timerBeforeFailover.deadlineAt).toBe(originalExpectedDeadline);
        expect(timerBeforeFailover.remainingMilliseconds).toBe(20 * 60 * 1000);

        // 7. CATASTROPHIC FAILURE OF PRIMARY SERVER AT 40 MINUTES
        // Primary server process crashes, power cut, hardware panic
        // Students retain encrypted local state in IndexedDB.
        // Secondary authority is promoted by administrator
        const promotionResult = await coordinator.promoteSecondary(
          'admin-user-01',
          adminSession.id,
          'Critical primary hardware failure 40m into exam; promoting secondary cluster node.',
          true,
          failoverPromoteTime,
        );

        expect(promotionResult.activeServerId).toBe('secondary-failover-node');
        expect(promotionResult.secondary.epoch).toBe(2);
        expect(promotionResult.replicationState).toBe('PROMOTED');

        // Authority epoch validation: Old primary cannot accept events
        expect(() => coordinator.assertCurrentAuthority('primary-authority-node', 1)).toThrow(
          'not the current',
        );
        expect(() => coordinator.assertCurrentAuthority('secondary-failover-node', 2)).not.toThrow();

        // 8. Reconnect all 300 students to promoted Secondary and reconcile local answers
        const reconnectResults = await Promise.all(
          students.map(async (s, idx) => {
            return coordinator.reconnectStudent(
              session.id,
              s.student.id,
              s.deviceSession.id,
              [q2UnsyncedEvents[idx]],
            );
          }),
        );

        expect(reconnectResults).toHaveLength(studentCount);
        for (const rec of reconnectResults) {
          expect(rec.continued).toBe(true);
          expect(rec.conflicts).toEqual([]);
          expect(rec.applied).toBe(1); // Q2 answer reconciled cleanly!
          expect(rec.authorityEpoch).toBe(2);
        }

        // 9. Verify Post-Failover State on Promoted Secondary:
        const secondarySnapshot = secondaryRepo.snapshot;

        // Invariant A: No duplicate attempts
        expect(secondarySnapshot.attempts).toHaveLength(studentCount);
        const uniqueAttempts = new Set(secondarySnapshot.attempts.map((a) => a.id));
        expect(uniqueAttempts.size).toBe(studentCount);

        // Invariant B: No lost answers (both Q1 and Q2 preserved for all 300 students)
        for (const att of secondarySnapshot.attempts) {
          expect(att.answers).toHaveLength(2);
          const answeredQuestions = new Set(att.answers.map((a) => a.questionId));
          expect(answeredQuestions.has(q1Id)).toBe(true);
          expect(answeredQuestions.has(q2Id)).toBe(true);
        }

        // Invariant C: Timer remains authoritative and strictly correct
        const timerAfterReconnect = await secondaryRepo.getAttemptTimer(
          students[0].attemptId,
          failoverPromoteTime,
        );
        expect(timerAfterReconnect.deadlineAt).toBe(originalExpectedDeadline);
        expect(timerAfterReconnect.remainingMilliseconds).toBe(20 * 60 * 1000 - 5000); // 20m minus 5s failover

        // 10. Students submit to Secondary authority at exam conclusion
        const submissions = await Promise.all(
          students.map(async (s) => {
            return secondaryRepo.submitAttempt(s.attemptId, false, s.deviceSession.id, 'MANUAL');
          }),
        );

        expect(submissions).toHaveLength(studentCount);
        for (const sub of submissions) {
          expect(sub.status).toBe('SUBMITTED');
          expect(sub.recoveryStatus).toBe('SUBMITTED');
        }

        // 11. Results preserved and verified
        expect(secondaryRepo.snapshot.results).toHaveLength(studentCount);
        for (const s of students) {
          const res = secondaryRepo.getExaminationResult(s.attemptId);
          expect(res).toBeDefined();
          expect(res?.attemptId).toBe(s.attemptId);
          expect(res?.answerStatistics.answered).toBe(2);
          expect(res?.answerStatistics.correct).toBe(2);
          expect(res?.score).toBe(4); // 2 questions * 2 marks
        }
      },
      360000,
    );
  });

  describe('Additional Resiliency & Failure Tests', () => {
    it('admin device replacement: restores administrative session on replacement hardware without disrupting active exam', async () => {
      const primary = await ExaminationRepository.open();
      const exam = await primary.createExam('Admin Replacement Exam');
      const version = await primary.createVersion(exam.id, createQuestions(), { title: 'v1' });
      await primary.publishVersion(exam.id, version.id);
      const session = await primary.createSession(exam.id, version.id, 'server-alpha');

      // Admin device 1
      const adminDev1 = await primary.createDeviceSession({
        id: 'admin-laptop-damaged',
        deviceId: 'hw-admin-01',
        role: 'ADMIN',
        sessionId: session.id,
        capabilities: ['admin-controls'],
      });

      // Admin laptop gets physically damaged / drops connection
      await primary.markDeviceDisconnected(adminDev1.id, 'Laptop screen cracked');
      expect(primary.snapshot.deviceSessions.find((d) => d.id === adminDev1.id)?.status).toBe('DISCONNECTED');

      // Replacement Admin iPad connects
      const adminDev2 = await primary.createDeviceSession({
        id: 'admin-tablet-replacement',
        deviceId: 'hw-admin-02-ipad',
        role: 'ADMIN',
        sessionId: session.id,
        capabilities: ['admin-controls'],
      });
      expect(adminDev2.status).toBe('CONNECTED');

      // Admin uses replacement device to pause an attempt
      const student = await primary.registerStudent('Kweku', 'Level 300');
      const studDev = await primary.createDeviceSession({
        deviceId: 'stud-dev',
        studentId: student.student.id,
        role: 'STUDENT',
        sessionId: session.id,
        capabilities: ['encrypted-local-state'],
      });
      const { attempt } = await primary.createAttempt(session.id, student.student.id, studDev.id);

      const paused = await primary.pauseAttempt(attempt.id, 'admin-kweku', adminDev2.id, 'Routine proctor inspection');
      expect(paused.status).toBe('PAUSED');
    });

    it('student device replacement: seamlessly transfers attempt ownership to replacement device and revokes stale hardware', async () => {
      const repo = await ExaminationRepository.open();
      const exam = await repo.createExam('Student Replacement Test');
      const version = await repo.createVersion(exam.id, createQuestions(), { title: 'v1' });
      await repo.publishVersion(exam.id, version.id);
      const session = await repo.createSession(exam.id, version.id, 'server-01');

      const { student, password } = await repo.registerStudent('Efua', 'Level 200');
      const dev1 = await repo.createDeviceSession({
        deviceId: 'efua-pc-dead-battery',
        role: 'STUDENT',
        studentId: student.id,
        sessionId: session.id,
        platform: 'native-pc',
        capabilities: ['encrypted-local-state'],
      });
      const { attempt } = await repo.createAttempt(session.id, student.id, dev1.id);

      // Student answers Q1 on Device 1
      await repo.recordAnswer(attempt.id, {
        questionId: version.questions[0].id,
        answer: '0',
        selectedOption: 0,
        deviceSessionId: dev1.id,
        isFinal: false,
      });

      // Device 1 battery dies
      await repo.markDeviceDisconnected(dev1.id, 'Battery died');

      // Student logs in on replacement device
      await repo.authenticateStudent('Efua', 'Level 200', password);
      const dev2 = await repo.createDeviceSession({
        deviceId: 'efua-tablet-replacement',
        role: 'STUDENT',
        studentId: student.id,
        sessionId: session.id,
        platform: 'android',
        capabilities: ['encrypted-local-state'],
      });

      const continued = await repo.createAttempt(session.id, student.id, dev2.id);
      expect(continued.continued).toBe(true);
      expect(continued.attempt.deviceSessionId).toBe(dev2.id);
      expect(continued.attempt.platform).toBe('android');
      expect(continued.attempt.ownershipGeneration).toBe(2);

      // Stale device 1 is rejected from recording answers
      await expect(
        repo.recordAnswer(attempt.id, {
          questionId: version.questions[1].id,
          answer: '0',
          deviceSessionId: dev1.id,
          isFinal: false,
        }),
      ).rejects.toThrow('no longer owns the active attempt');
    });

    it('network outage: buffers answers during LAN disruption and reconciles upon reconnection', async () => {
      const repo = await ExaminationRepository.open();
      const exam = await repo.createExam('Network Outage Test');
      const version = await repo.createVersion(exam.id, createQuestions(), { title: 'v1' });
      await repo.publishVersion(exam.id, version.id);
      const session = await repo.createSession(exam.id, version.id, 'server-alpha');

      const student = await repo.registerStudent('Ama', 'Level 300');
      const dev = await repo.createDeviceSession({
        deviceId: 'ama-laptop',
        studentId: student.student.id,
        role: 'STUDENT',
        sessionId: session.id,
        capabilities: ['encrypted-local-state'],
      });
      const { attempt } = await repo.createAttempt(session.id, student.student.id, dev.id);

      // Outage occurs: LAN gateway reboot
      await repo.markSynchronizationUnavailable(session.id, 'Switch reboot');
      expect(repo.snapshot.sessions[0].synchronizationStatus).toBe('degraded');

      // Student device answers while network is down
      const bufferedAnswerEvent: SyncEvent = {
        id: 'evt-buffered-01',
        eventId: 'ans-buf-01',
        sessionId: session.id,
        entity: 'ANSWER',
        entityId: version.questions[0].id,
        sourceServerId: 'student-client',
        authorityEpoch: 1,
        revision: 1,
        at: new Date().toISOString(),
        direction: 'LOCAL_TO_SERVER',
        status: 'PENDING',
        questionId: version.questions[0].id,
        answerRevision: 1,
        payload: {
          attemptId: attempt.id,
          answer: '0',
          selectedOption: 0,
          deviceSessionId: dev.id,
          isFinal: false,
        },
      };

      // Network restored: sync flush
      const syncRes = await repo.processIncomingSyncEvents(session.id, [bufferedAnswerEvent]);
      expect(syncRes.ok).toBe(true);
      expect(syncRes.applied).toBe(1);
      expect(repo.snapshot.attempts[0].answers).toHaveLength(1);
    });

    it('server restart: re-opens persisted examination state without data corruption', async () => {
      const primary = await ExaminationRepository.open();
      const exam = await primary.createExam('Server Restart Exam');
      const version = await primary.createVersion(exam.id, createQuestions(), { title: 'v1' });
      await primary.publishVersion(exam.id, version.id);
      const session = await primary.createSession(exam.id, version.id, 'primary-node');

      const student = await primary.registerStudent('RestartStudent', 'Level 100');
      const dev = await primary.createDeviceSession({
        deviceId: 'dev-01',
        studentId: student.student.id,
        role: 'STUDENT',
        sessionId: session.id,
        capabilities: ['encrypted-local-state'],
      });
      await primary.createAttempt(session.id, student.student.id, dev.id);
      await primary.save();

      // SIMULATE SERVER REBOOT / CRASH RECOVERY
      const rebootedRepo = await ExaminationRepository.open();
      const rebootedState = rebootedRepo.snapshot;

      expect(rebootedState.exams.some((e) => e.id === exam.id)).toBe(true);
      expect(rebootedState.sessions.some((s) => s.id === session.id)).toBe(true);
      expect(rebootedState.students.some((s) => s.id === student.student.id)).toBe(true);
      expect(rebootedState.attempts).toHaveLength(1);
      expect(rebootedState.attempts[0].sessionId).toBe(session.id);
    });

    it('secondary failure: blocks invalid promotion when secondary is stale or offline', async () => {
      const primary = await ExaminationRepository.open();
      const exam = await primary.createExam('Secondary Fail Test');
      const version = await primary.createVersion(exam.id, createQuestions(), { title: 'v1' });
      await primary.publishVersion(exam.id, version.id);
      const session = await primary.createSession(exam.id, version.id, 'primary-server');

      const secondary = ExaminationRepository.fromSnapshot(emptyExaminationState());
      vi.spyOn(secondary, 'installReplicatedState').mockRejectedValue(new Error('Secondary disk failure'));

      const coordinator = new ExaminationHighAvailability(primary, secondary, {
        primary: { serverId: 'primary-server', authorityId: 'exam-auth' },
        secondary: { serverId: 'secondary-server', authorityId: 'exam-auth' },
      });
      await coordinator.initialize();

      await expect(coordinator.replicateToSecondary(session.id)).rejects.toThrow('Secondary disk failure');
      expect(coordinator.status().replicationState).toBe('INTERRUPTED');

      // Attempting to promote an interrupted secondary is safely blocked
      await expect(
        coordinator.promoteSecondary('admin', 'admin-dev', 'Bad promote', true, new Date().toISOString()),
      ).rejects.toThrow('reconciliation');
    });

    it('stale client reconnect: rejects client attempting to submit to obsolete authority epoch', async () => {
      const primary = await ExaminationRepository.open();
      const exam = await primary.createExam('Epoch Rejection Test');
      const version = await primary.createVersion(exam.id, createQuestions(), { title: 'v1' });
      await primary.publishVersion(exam.id, version.id);
      const session = await primary.createSession(exam.id, version.id, 'primary-node');

      const student = await primary.registerStudent('EpochStudent', 'Level 400');
      const dev = await primary.createDeviceSession({
        deviceId: 'dev-epoch',
        studentId: student.student.id,
        role: 'STUDENT',
        sessionId: session.id,
        capabilities: ['encrypted-local-state'],
      });
      const { attempt } = await primary.createAttempt(session.id, student.student.id, dev.id);

      // Simulate epoch bumped to 2 on server
      session.authorityEpoch = 2;

      // Stale event sent with epoch 1 without reconciliation option
      const staleEvent: SyncEvent = {
        id: 'evt-stale-epoch',
        eventId: 'ans-stale',
        sessionId: session.id,
        entity: 'ANSWER',
        entityId: version.questions[0].id,
        sourceServerId: 'student-client',
        authorityEpoch: 1, // Stale!
        revision: 1,
        at: new Date().toISOString(),
        direction: 'LOCAL_TO_SERVER',
        status: 'PENDING',
        questionId: version.questions[0].id,
        answerRevision: 1,
        payload: {
          attemptId: attempt.id,
          answer: '0',
          deviceSessionId: dev.id,
          isFinal: false,
        },
      };

      const syncResult = await primary.processIncomingSyncEvents(session.id, [staleEvent]);
      expect(syncResult.ok).toBe(false);
      expect(syncResult.conflicts[0]).toContain('stale');
    });

    it('duplicate events: processes identical sync events idempotently without duplicating answers or revisions', async () => {
      const repo = await ExaminationRepository.open();
      const exam = await repo.createExam('Idempotency Test');
      const version = await repo.createVersion(exam.id, createQuestions(), { title: 'v1' });
      await repo.publishVersion(exam.id, version.id);
      const session = await repo.createSession(exam.id, version.id, 'server-alpha');

      const student = await repo.registerStudent('IdempotentStudent', 'Level 200');
      const dev = await repo.createDeviceSession({
        deviceId: 'dev-idem',
        studentId: student.student.id,
        role: 'STUDENT',
        sessionId: session.id,
        capabilities: ['encrypted-local-state'],
      });
      const { attempt } = await repo.createAttempt(session.id, student.student.id, dev.id);

      const event: SyncEvent = {
        id: 'evt-repeat-01',
        eventId: 'ans-unique-01',
        sessionId: session.id,
        entity: 'ANSWER',
        entityId: version.questions[0].id,
        sourceServerId: 'student-client',
        authorityEpoch: 1,
        revision: 1,
        at: new Date().toISOString(),
        direction: 'LOCAL_TO_SERVER',
        status: 'PENDING',
        questionId: version.questions[0].id,
        answerRevision: 1,
        payload: {
          attemptId: attempt.id,
          answer: '0',
          selectedOption: 0,
          deviceSessionId: dev.id,
          isFinal: false,
        },
      };

      // Send first time
      const res1 = await repo.processIncomingSyncEvents(session.id, [event]);
      expect(res1.ok).toBe(true);
      expect(res1.applied).toBe(1);

      // Send exact duplicate
      const res2 = await repo.processIncomingSyncEvents(session.id, [event]);
      expect(res2.ok).toBe(true);
      expect(res2.applied).toBe(0); // Idempotently acknowledged without reapplying!
      expect(res2.acknowledgedEventIds).toContain(event.id);

      // Check server answers array: exactly 1 answer, not 2
      expect(repo.snapshot.attempts[0].answers).toHaveLength(1);
    });
  });
});

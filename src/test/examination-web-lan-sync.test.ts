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
import {
  LanExamClient,
  LocalExamAuthority,
  createLanServerFetch,
  EXAMINATION_PROTOCOL_VERSION,
} from '../examination/network';
import { ExaminationSyncEngine, reconcileAnswer } from '../examination/sync';
import type { ExamQuestion } from '../types';
import type { ExamAnswer, SyncEvent } from '../examination/types';

const examQuestions: ExamQuestion[] = [
  {
    id: 'lan-q1',
    courseId: 'pharma-lan',
    topicId: 'pharmacokinetics',
    questionText: 'What is the primary route of excretion for water-soluble drugs?',
    questionType: 'mcq',
    marksAllocation: 2,
    difficulty: 'easy',
    probability: 'high',
    modelAnswer: 'Renal elimination via kidneys',
    correctAnswer: 'Renal elimination via kidneys',
    tags: ['pharmacology'],
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: '2026-09-26T00:00:00.000Z',
    options: ['Renal elimination via kidneys', 'Biliary excretion', 'Pulmonary exhalation', 'Dermal diffusion'],
    correctOption: 0,
  },
  {
    id: 'lan-q2',
    courseId: 'pharma-lan',
    topicId: 'pharmacodynamics',
    questionText: 'What term describes the maximum effect an agonist can produce?',
    questionType: 'mcq',
    marksAllocation: 2,
    difficulty: 'medium',
    probability: 'high',
    modelAnswer: 'Efficacy (Emax)',
    correctAnswer: 'Efficacy (Emax)',
    tags: ['receptors'],
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: '2026-09-26T00:00:00.000Z',
    options: ['Potency (EC50)', 'Efficacy (Emax)', 'Therapeutic index', 'Affinity (Kd)'],
    correctOption: 1,
  },
  {
    id: 'lan-q3',
    courseId: 'pharma-lan',
    topicId: 'toxicology',
    questionText: 'Name the specific antidote for paracetamol (acetaminophen) toxicity.',
    questionType: 'short_answer',
    marksAllocation: 3,
    difficulty: 'medium',
    probability: 'high',
    modelAnswer: 'N-acetylcysteine (NAC)',
    correctAnswer: 'N-acetylcysteine (NAC)',
    tags: ['toxicology'],
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: '2026-09-26T00:00:00.000Z',
  },
];

async function setupLanServerAuthority() {
  const repository = await ExaminationRepository.open();
  const exam = await repository.createExam('LAN Synchronized Pharmacology Exam');
  const version = await repository.createVersion(exam.id, examQuestions, {
    title: 'LAN Synchronized Pharmacology Exam',
    assessmentType: 'KIOSK_EXAM',
    availability: { durationMinutes: 90 },
    security: { kioskMode: true, requireLanAuthority: true },
    navigation: { allowPrevious: true, showQuestionNumbers: true },
  });
  const published = await repository.publishVersion(exam.id, version.id);
  const session = await repository.createSession(
    exam.id,
    published.id,
    'lan-primary-server',
    'http://192.168.1.100:8787',
  );
  const authority = new LocalExamAuthority(repository);
  return { repository, exam, version: published, session, authority };
}

describe('PHARMATRACK — WEB/PWA LAN EXAMINATION SYNCHRONIZATION', () => {
  beforeEach(() => {
    idbStore.clear();
  });

  describe('1. Web Student Connects', () => {
    it('authenticates, connects, receives authoritative clock and creates authoritative attempt on LAN server', async () => {
      const { repository, session, authority } = await setupLanServerAuthority();
      const serverFetch = createLanServerFetch(authority);

      // Student registers on server
      const { student } = await repository.registerStudent('Adwoa', 'Level 400');

      // Web student client initializes LanExamClient
      const lanClient = new LanExamClient('http://192.168.1.100:8787', serverFetch, {
        studentId: student.id,
      });

      // 1. Authoritative Health Check
      const health = await lanClient.health();
      expect(health.ok).toBe(true);
      expect(health.protocolVersion).toBe(EXAMINATION_PROTOCOL_VERSION);
      expect(health.serverNowAt).toBeDefined();

      // 2. Connect from Web device
      const deviceId = 'web-browser-adwoa-01';
      const connection = await lanClient.connect(session.id, deviceId, 'STUDENT', {
        studentId: student.id,
      });
      expect(connection.ok).toBe(true);
      expect(connection.sessionToken).toBeDefined();
      expect(connection.deviceSessionId).toBeDefined();

      // Update device session platform to 'web'
      const deviceSession = repository.snapshot.deviceSessions.find((d) => d.id === connection.deviceSessionId);
      expect(deviceSession).toBeDefined();
      expect(deviceSession?.studentId).toBe(student.id);

      // 3. Create Authoritative Attempt on LAN server
      const attemptRes = await lanClient.createAttempt(session.id, student.id, connection.deviceSessionId!);
      expect(attemptRes.ok).toBe(true);
      expect(attemptRes.attempt).toBeDefined();
      expect(attemptRes.attempt?.sessionId).toBe(session.id);
      expect(attemptRes.attempt?.studentId).toBe(student.id);
      expect(attemptRes.attempt?.status).toBe('ACTIVE');
      expect(attemptRes.attempt?.questionOrder.length).toBe(3);

      // Authoritative duration
      expect(attemptRes.attempt?.deadlineAt).toBeDefined();
    });
  });

  describe('2. 50 Concurrent Web Students', () => {
    it(
      'scales to 50 concurrent web students registering, creating attempts, and synchronizing answers without conflicts',
      async () => {
        const { repository, version, session, authority } = await setupLanServerAuthority();
        const serverFetch = createLanServerFetch(authority);

        const q1Id = version.questions[0].id;
        const q2Id = version.questions[1].id;
        const numStudents = 50;

        // Step A: Register 50 students and connect concurrently
        const connectTasks = Array.from({ length: numStudents }).map(async (_, i) => {
          const name = `Student${String(i + 1).padStart(2, '0')}`;
          const { student } = await repository.registerStudent(name, 'Level 300');
          const deviceId = `web-pwa-device-${String(i + 1).padStart(2, '0')}`;
          const client = new LanExamClient('http://192.168.1.100:8787', serverFetch, {
            studentId: student.id,
          });
          const conn = await client.connect(session.id, deviceId, 'STUDENT', { studentId: student.id });
          const att = await client.createAttempt(session.id, student.id, conn.deviceSessionId!);
          return {
            studentId: student.id,
            deviceId,
            client,
            deviceSessionId: conn.deviceSessionId!,
            attemptId: att.attempt!.id,
          };
        });

        const studentData = await Promise.all(connectTasks);

        expect(studentData.length).toBe(50);
        const uniqueAttemptIds = new Set(studentData.map((s) => s.attemptId));
        expect(uniqueAttemptIds.size).toBe(50);

        // Step B: All 50 students simultaneously answer Q1 and Q2, and sync concurrently
        const syncTasks = studentData.map(async (student, idx) => {
          const events: SyncEvent[] = [
            {
              id: `evt-s${idx}-q1`,
              eventId: `ans-s${idx}-q1`,
              sessionId: session.id,
              entity: 'ANSWER',
              entityId: q1Id,
              sourceServerId: 'web-client',
              authorityEpoch: 1,
              revision: 1,
              at: new Date().toISOString(),
              direction: 'LOCAL_TO_SERVER',
              status: 'PENDING',
              questionId: q1Id,
              answerRevision: 1,
              payload: {
                attemptId: student.attemptId,
                answer: '0',
                selectedOption: 0,
                deviceSessionId: student.deviceSessionId,
                isFinal: false,
              },
            },
            {
              id: `evt-s${idx}-q2`,
              eventId: `ans-s${idx}-q2`,
              sessionId: session.id,
              entity: 'ANSWER',
              entityId: q2Id,
              sourceServerId: 'web-client',
              authorityEpoch: 1,
              revision: 1,
              at: new Date().toISOString(),
              direction: 'LOCAL_TO_SERVER',
              status: 'PENDING',
              questionId: q2Id,
              answerRevision: 1,
              payload: {
                attemptId: student.attemptId,
                answer: '1',
                selectedOption: 1,
                deviceSessionId: student.deviceSessionId,
                isFinal: false,
              },
            },
          ];

          const syncResult = await student.client.sync(session.id, events);
          return syncResult;
        });

        const syncResults = await Promise.all(syncTasks);

        // Every single student's answers were successfully applied and acknowledged
        for (const res of syncResults) {
          expect(res.ok).toBe(true);
          expect(res.applied).toBe(2);
          expect(res.conflicts).toEqual([]);
        }

        // Check server authority snapshot: total applied answer events = 100
        const serverSnapshot = repository.snapshot;
        expect(serverSnapshot.attempts.length).toBe(50);
        for (const student of studentData) {
          const att = serverSnapshot.attempts.find((a) => a.id === student.attemptId);
          expect(att).toBeDefined();
          expect(att?.answers.length).toBe(2);
          expect(att?.synchronizationState).toBe('SYNCHRONIZED');
        }

        // Total replication revision progressed monotonically
        expect(serverSnapshot.sessions.find((s) => s.id === session.id)?.lastReplicationRevision).toBe(100);
      },
      30000,
    );
  });

  describe('3. LAN Interruption & SAVE-BEFORE-NEXT Invariant', () => {
    it('preserves local-first saving and allows question navigation during complete network drop', async () => {
      const { repository: serverRepo, version, session, authority } = await setupLanServerAuthority();
      let networkOnline = true;

      const q1Id = version.questions[0].id;
      const q2Id = version.questions[1].id;
      const q3Id = version.questions[2].id;

      // Simulated network interceptor
      const serverFetch = createLanServerFetch(authority, async () => {
        if (!networkOnline) {
          throw new TypeError('Failed to fetch: Network is down');
        }
        return null;
      });

      const { student } = await serverRepo.registerStudent('Kwame', 'Level 300');
      const clientTransport = new LanExamClient('http://192.168.1.100:8787', serverFetch, {
        studentId: student.id,
      });

      const conn = await clientTransport.connect(session.id, 'device-kwame-pwa', 'STUDENT');
      const remoteAttempt = await clientTransport.createAttempt(session.id, student.id, conn.deviceSessionId!);

      // Local client repository
      const localRepo = await ExaminationRepository.open();
      // Import the version locally as well
      await localRepo.importPublishedVersion(version);
      const localAttemptResult = await localRepo.createAttempt(
        session.id,
        student.id,
        conn.deviceSessionId!,
        new Date().toISOString(),
        remoteAttempt.attempt!.id,
      );
      const attemptId = localAttemptResult.attempt.id;

      const syncEngine = new ExaminationSyncEngine(localRepo, clientTransport, session.id);

      // Q1 answered while online
      await localRepo.recordAnswer(attemptId, {
        questionId: q1Id,
        answer: '0',
        selectedOption: 0,
        deviceSessionId: conn.deviceSessionId!,
        isFinal: false,
      });
      const q1Sync = await syncEngine.flush();
      expect(q1Sync.ok).toBe(true);
      expect(q1Sync.applied).toBe(1);

      // LAN INTERRUPTED: network goes down!
      networkOnline = false;

      // Invariant: Student selects answer for Q2 -> local persistence succeeds
      const q2Persisted = await localRepo.recordAnswer(attemptId, {
        questionId: q2Id,
        answer: '1',
        selectedOption: 1,
        deviceSessionId: conn.deviceSessionId!,
        isFinal: false,
      });
      expect(q2Persisted.answer).toBe('1');

      // Question navigation allowed because local persistence succeeded
      const navOk = await localRepo.updateCurrentQuestion(attemptId, q3Id);
      expect(navOk).toBe(true);
      const attAfterNav = localRepo.snapshot.attempts.find((a) => a.id === attemptId);
      expect(attAfterNav?.currentQuestionId).toBe(q3Id);

      // Asynchronous sync attempts to flush and detects failure gracefully
      const q2Sync = await syncEngine.flush();
      expect(q2Sync.ok).toBe(false);
      expect(q2Sync.state).toBe('DEGRADED');

      // Student answers Q3 while still offline
      await localRepo.recordAnswer(attemptId, {
        questionId: q3Id,
        answer: 'N-acetylcysteine',
        deviceSessionId: conn.deviceSessionId!,
        isFinal: false,
      });

      // Confirm local state preserves all 3 answers and pending sync events
      const localSnapshot = localRepo.snapshot;
      const att = localSnapshot.attempts.find((a) => a.id === attemptId);
      expect(att?.answers.length).toBe(3);
      expect(localRepo.pendingSyncEvents(session.id).length).toBe(2); // Q2 and Q3 pending
    });
  });

  describe('4. Reconnection & Recovery Synchronization', () => {
    it('automatically flushes buffered offline events upon reconnection without data loss', async () => {
      const { repository: serverRepo, version, session, authority } = await setupLanServerAuthority();
      let networkOnline = false;

      const qIds = version.questions.map((q) => q.id);

      const serverFetch = createLanServerFetch(authority, async () => {
        if (!networkOnline) throw new TypeError('Failed to fetch');
        return null;
      });

      const { student } = await serverRepo.registerStudent('Akosua', 'Level 200');
      const conn = await authority.connect(session.id, 'device-akosua-pwa', 'STUDENT', { studentId: student.id });
      const remoteAtt = await authority.createAttempt(session.id, student.id, conn.deviceSessionId!);

      const localRepo = await ExaminationRepository.open();
      await localRepo.importPublishedVersion(version);
      const localAttemptResult = await localRepo.createAttempt(
        session.id,
        student.id,
        conn.deviceSessionId!,
        new Date().toISOString(),
        remoteAtt.attempt!.id,
      );
      const attemptId = localAttemptResult.attempt.id;

      const clientTransport = new LanExamClient('http://192.168.1.100:8787', serverFetch, {
        token: conn.sessionToken,
        deviceSessionId: conn.deviceSessionId,
        studentId: student.id,
      });
      const syncEngine = new ExaminationSyncEngine(localRepo, clientTransport, session.id);

      // Student records 3 answers offline
      for (let i = 0; i < 3; i++) {
        await localRepo.recordAnswer(attemptId, {
          questionId: qIds[i],
          answer: String(i),
          selectedOption: i,
          deviceSessionId: conn.deviceSessionId!,
          isFinal: false,
        });
      }

      expect(localRepo.pendingSyncEvents(session.id).length).toBe(3);

      // Attempt flush while still offline -> fails
      const failedFlush = await syncEngine.flush();
      expect(failedFlush.ok).toBe(false);

      // NETWORK RESTORES!
      networkOnline = true;

      // Reconnect flush
      const restoredFlush = await syncEngine.flush();
      expect(restoredFlush.ok).toBe(true);
      expect(restoredFlush.applied).toBe(3);
      expect(restoredFlush.state).toBe('SYNCHRONIZED');
      expect(localRepo.pendingSyncEvents(session.id).length).toBe(0);

      // Server authority now has all 3 answers
      const serverAtt = serverRepo.snapshot.attempts.find((a) => a.id === attemptId);
      expect(serverAtt?.answers.length).toBe(3);
      expect(serverAtt?.synchronizationState).toBe('SYNCHRONIZED');
    });
  });

  describe('5. Duplicate Event Idempotency', () => {
    it('safely handles repeated sync events without duplicating answers or revisions', async () => {
      const { repository, version, session, authority } = await setupLanServerAuthority();
      const serverFetch = createLanServerFetch(authority);

      const q1Id = version.questions[0].id;
      const { student } = await repository.registerStudent('Yaw', 'Level 500');
      const conn = await authority.connect(session.id, 'device-yaw', 'STUDENT', { studentId: student.id });
      const att = await authority.createAttempt(session.id, student.id, conn.deviceSessionId!);

      const client = new LanExamClient('http://192.168.1.100:8787', serverFetch, {
        token: conn.sessionToken,
        deviceSessionId: conn.deviceSessionId,
        studentId: student.id,
      });

      const event: SyncEvent = {
        id: 'evt-unique-duplicate-test',
        eventId: 'ans-event-idempotent-01',
        sessionId: session.id,
        entity: 'ANSWER',
        entityId: q1Id,
        sourceServerId: 'web-client',
        authorityEpoch: 1,
        revision: 1,
        at: new Date().toISOString(),
        direction: 'LOCAL_TO_SERVER',
        status: 'PENDING',
        questionId: q1Id,
        answerRevision: 1,
        payload: {
          attemptId: att.attempt!.id,
          answer: '0',
          selectedOption: 0,
          deviceSessionId: conn.deviceSessionId,
          isFinal: false,
        },
      };

      // First delivery
      const first = await client.sync(session.id, [event]);
      expect(first.ok).toBe(true);
      expect(first.applied).toBe(1);
      expect(first.revision).toBe(1);

      // Duplicate delivery (e.g. retried after dropped network ACK)
      const duplicate = await client.sync(session.id, [event]);
      expect(duplicate.ok).toBe(true);
      expect(duplicate.applied).toBe(0); // not re-applied
      expect(duplicate.revision).toBe(1); // revision not incremented
      expect(duplicate.acknowledgedEventIds).toEqual([event.id]);

      // Server has exactly 1 answer
      const serverAtt = repository.snapshot.attempts.find((a) => a.id === att.attempt!.id);
      expect(serverAtt?.answers.length).toBe(1);
    });
  });

  describe('6. Conflicting Revisions', () => {
    it('rejects stale answer revisions and resolves deterministic winner via reconcileAnswer', async () => {
      const { repository, version, session, authority } = await setupLanServerAuthority();
      const serverFetch = createLanServerFetch(authority);

      const q1Id = version.questions[0].id;
      const { student } = await repository.registerStudent('Kofi', 'Level 200');
      const conn = await authority.connect(session.id, 'dev-kofi', 'STUDENT', { studentId: student.id });
      const att = await authority.createAttempt(session.id, student.id, conn.deviceSessionId!);

      const client = new LanExamClient('http://192.168.1.100:8787', serverFetch, {
        token: conn.sessionToken,
        deviceSessionId: conn.deviceSessionId,
        studentId: student.id,
      });

      // Submit newer revision 2 first
      const rev2Event: SyncEvent = {
        id: 'evt-rev-2',
        eventId: 'ans-rev-2',
        sessionId: session.id,
        entity: 'ANSWER',
        entityId: q1Id,
        sourceServerId: 'web-client',
        authorityEpoch: 1,
        revision: 2,
        at: '2026-09-26T12:00:10.000Z',
        direction: 'LOCAL_TO_SERVER',
        status: 'PENDING',
        questionId: q1Id,
        answerRevision: 2,
        payload: {
          attemptId: att.attempt!.id,
          answer: 'Updated Answer Revision 2',
          deviceSessionId: conn.deviceSessionId,
          isFinal: false,
        },
      };
      const res2 = await client.sync(session.id, [rev2Event]);
      expect(res2.ok).toBe(true);

      // Now a delayed stale revision 1 arrives
      const rev1Event: SyncEvent = {
        id: 'evt-rev-1',
        eventId: 'ans-rev-1',
        sessionId: session.id,
        entity: 'ANSWER',
        entityId: q1Id,
        sourceServerId: 'web-client',
        authorityEpoch: 1,
        revision: 1,
        at: '2026-09-26T12:00:00.000Z',
        direction: 'LOCAL_TO_SERVER',
        status: 'PENDING',
        questionId: q1Id,
        answerRevision: 1,
        payload: {
          attemptId: att.attempt!.id,
          answer: 'Stale Answer Revision 1',
          deviceSessionId: conn.deviceSessionId,
          isFinal: false,
        },
      };
      const res1 = await client.sync(session.id, [rev1Event]);
      expect(res1.ok).toBe(false);
      expect(res1.conflicts[0]).toContain('A newer answer revision is already authoritative.');

      // Server answer remains Revision 2
      const serverAtt = repository.snapshot.attempts.find((a) => a.id === att.attempt!.id);
      expect(serverAtt?.answers[0].answer).toBe('Updated Answer Revision 2');
      expect(serverAtt?.answers[0].revision).toBe(2);

      // Verify pure conflict reconciliation function
      const localAns: ExamAnswer = {
        questionId: q1Id,
        answer: 'Option A',
        answeredAt: '2026-09-26T12:00:00.000Z',
        revision: 1,
        deviceSessionId: 'd1',
        isFinal: false,
      };
      const incomingAns: ExamAnswer = {
        questionId: q1Id,
        answer: 'Option B',
        answeredAt: '2026-09-26T12:00:05.000Z',
        revision: 1,
        deviceSessionId: 'd2',
        isFinal: false,
      };
      const reconciled = reconcileAnswer(localAns, incomingAns);
      expect(reconciled.conflict).toBe(true);
      expect(reconciled.winner.answer).toBe('Option B'); // later timestamp chosen
    });
  });

  describe('7. Submission During Reconnect', () => {
    it('finalizes attempt locally during network drop and reconciles submission on reconnection without duplicate attempts', async () => {
      const { repository: serverRepo, version, session, authority } = await setupLanServerAuthority();
      let networkOnline = false;

      const q1Id = version.questions[0].id;

      const serverFetch = createLanServerFetch(authority, async () => {
        if (!networkOnline) throw new TypeError('Network down');
        return null;
      });

      const { student } = await serverRepo.registerStudent('Mansa', 'Level 300');
      const conn = await authority.connect(session.id, 'dev-mansa-web', 'STUDENT', { studentId: student.id });
      const remoteAtt = await authority.createAttempt(session.id, student.id, conn.deviceSessionId!);

      const localRepo = await ExaminationRepository.open();
      await localRepo.importPublishedVersion(version);
      const localAttemptResult = await localRepo.createAttempt(
        session.id,
        student.id,
        conn.deviceSessionId!,
        new Date().toISOString(),
        remoteAtt.attempt!.id,
      );
      const attemptId = localAttemptResult.attempt.id;

      // Student answers questions locally
      await localRepo.recordAnswer(attemptId, {
        questionId: q1Id,
        answer: '0',
        selectedOption: 0,
        deviceSessionId: conn.deviceSessionId!,
        isFinal: true,
      });

      // Student clicks "Submit Exam" while OFFLINE!
      // Local submission stages result, marks SUBMITTED, and queues SUBMISSION sync event
      await localRepo.markSynchronizationUnavailable(session.id, 'Network down during final submission');
      const locallySubmitted = await localRepo.submitAttempt(attemptId, false, conn.deviceSessionId!, 'MANUAL');

      expect(locallySubmitted.status).toBe('SUBMITTED');
      expect(locallySubmitted.submissionTrigger).toBe('MANUAL');
      expect(locallySubmitted.synchronizationState).toBe('RECOVERY_PENDING');

      // Verify pending events include both the answer and the submission
      const pending = localRepo.pendingSyncEvents(session.id);
      expect(pending.some((e) => e.entity === 'ANSWER')).toBe(true);
      expect(pending.some((e) => e.entity === 'SUBMISSION')).toBe(true);

      // NETWORK RESTORES!
      networkOnline = true;

      const client = new LanExamClient('http://192.168.1.100:8787', serverFetch, {
        token: conn.sessionToken,
        deviceSessionId: conn.deviceSessionId,
        studentId: student.id,
      });
      const syncEngine = new ExaminationSyncEngine(localRepo, client, session.id);

      // Reconnection flush sends answer + SUBMISSION event to the authority
      const flushResult = await syncEngine.flush();
      expect(flushResult.ok).toBe(true);

      // Server authority now has attempt finalized as SUBMITTED with answer
      const serverAtt = serverRepo.snapshot.attempts.find((a) => a.id === attemptId);
      expect(serverAtt?.status).toBe('SUBMITTED');
      expect(serverAtt?.submissionState).toBe('SUBMITTED');
      expect(serverAtt?.answers.length).toBe(1);

      // Idempotent retry of submitAttempt on server does not create a duplicate attempt
      const retrySubmit = await client.submitAttempt(session.id, attemptId, conn.deviceSessionId);
      expect(retrySubmit.ok).toBe(true);
      expect(retrySubmit.attempt?.status).toBe('SUBMITTED');
      expect(serverRepo.snapshot.attempts.filter((a) => a.id === attemptId).length).toBe(1);
    });
  });

  describe('8. Device Recovery & Local-First Invariants', () => {
    it('restores complete examination state after browser crash and reconciles with LAN authority', async () => {
      const { repository: serverRepo, version, session, authority } = await setupLanServerAuthority();

      const q1Id = version.questions[0].id;
      const q2Id = version.questions[1].id;

      const { student } = await serverRepo.registerStudent('Ekow', 'Level 400');
      const conn = await authority.connect(session.id, 'dev-ekow-original', 'STUDENT', { studentId: student.id });
      const remoteAtt = await authority.createAttempt(session.id, student.id, conn.deviceSessionId!);

      const localRepo = await ExaminationRepository.open();
      await localRepo.importPublishedVersion(version);
      const localAttemptResult = await localRepo.createAttempt(
        session.id,
        student.id,
        conn.deviceSessionId!,
        new Date().toISOString(),
        remoteAtt.attempt!.id,
      );
      const attemptId = localAttemptResult.attempt.id;

      // Student answers questions and advances current question
      await localRepo.recordAnswer(attemptId, {
        questionId: q1Id,
        answer: '0',
        selectedOption: 0,
        deviceSessionId: conn.deviceSessionId!,
        isFinal: false,
      });
      await localRepo.updateCurrentQuestion(attemptId, q2Id);

      // Sync to authority
      const client = new LanExamClient('http://192.168.1.100:8787', createLanServerFetch(authority), {
        token: conn.sessionToken,
        deviceSessionId: conn.deviceSessionId,
        studentId: student.id,
      });
      const syncEngine = new ExaminationSyncEngine(localRepo, client, session.id);
      await syncEngine.flush();

      // SIMULATE DEVICE CRASH / RELOAD
      // Re-opening the repository from encrypted IndexedDB:
      const recoveredRepo = await ExaminationRepository.open();
      const recoveredAttempt = recoveredRepo.snapshot.attempts.find((a) => a.id === attemptId);

      // VERIFY ALL MANDATORY LOCAL-FIRST INVARIANTS:
      expect(recoveredAttempt).toBeDefined();
      expect(recoveredAttempt?.id).toBe(attemptId); // attempt ID
      expect(recoveredAttempt?.examVersionId).toBe(session.examVersionId); // exam version
      expect(recoveredAttempt?.questionOrder.length).toBe(3); // question order
      expect(recoveredAttempt?.optionOrders).toBeDefined(); // option order
      expect(recoveredAttempt?.currentQuestionId).toBe(q2Id); // current question
      expect(recoveredAttempt?.answers.length).toBe(1); // answers
      expect(recoveredAttempt?.answers[0].revision).toBe(1); // answer revision
      expect(recoveredAttempt?.deadlineAt).toBeDefined(); // timer snapshot
      expect(recoveredAttempt?.securityState).toBeDefined(); // security state
      expect(recoveredAttempt?.serverRevision).toBe(1); // synchronization revision
      expect(recoveredAttempt?.deviceSessionId).toBe(conn.deviceSessionId); // device session ID

      // Recovery call to authority
      const recoverRes = await client.recover(session.id, attemptId, {
        id: 'rec-01',
        sessionId: session.id,
        attemptId,
        state: 'RECONNECTING',
        lastKnownRevision: 1,
        localEncryptedStateAvailable: true,
        reason: 'Device recovery after reload',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      expect(recoverRes.ok).toBe(true);
      expect(recoverRes.attempt?.id).toBe(attemptId);
    });
  });
});

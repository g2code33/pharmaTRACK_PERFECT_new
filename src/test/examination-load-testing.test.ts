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
  LocalExamAuthority,
  LanExamClient,
  createLanServerFetch,
  EXAMINATION_PROTOCOL_VERSION,
} from '../examination/network';
import type { ExamQuestion } from '../types';
import type { SyncEvent } from '../examination/types';

function createQuestions(): ExamQuestion[] {
  return [
    {
      id: 'q1-pk',
      courseId: 'pharma-load',
      topicId: 'pharmacokinetics',
      questionText: 'Which organ is primarily responsible for first-pass metabolism?',
      questionType: 'mcq',
      marksAllocation: 2,
      difficulty: 'easy',
      probability: 'high',
      modelAnswer: 'Liver',
      correctAnswer: 'Liver',
      tags: ['pk'],
      isPracticed: false,
      needsReview: false,
      isSaved: false,
      createdAt: '2026-09-26T00:00:00.000Z',
      options: ['Liver', 'Kidney', 'Lungs', 'Heart'],
      correctOption: 0,
    },
    {
      id: 'q2-pd',
      courseId: 'pharma-load',
      topicId: 'pharmacodynamics',
      questionText: 'What term describes an agent that binds to a receptor without activation?',
      questionType: 'mcq',
      marksAllocation: 2,
      difficulty: 'medium',
      probability: 'high',
      modelAnswer: 'Antagonist',
      correctAnswer: 'Antagonist',
      tags: ['pd'],
      isPracticed: false,
      needsReview: false,
      isSaved: false,
      createdAt: '2026-09-26T00:00:00.000Z',
      options: ['Antagonist', 'Agonist', 'Allosteric activator', 'Partial agonist'],
      correctOption: 0,
    },
  ];
}

async function setupLoadSession() {
  const repository = await ExaminationRepository.open();
  const exam = await repository.createExam('Load & Scalability Certification Exam');
  const version = await repository.createVersion(exam.id, createQuestions(), {
    title: 'Load Certification Version',
    assessmentType: 'KIOSK_EXAM',
    availability: { durationMinutes: 60 },
    maxAttempts: 1,
    security: { kioskMode: true, requireLanAuthority: true },
  });
  await repository.publishVersion(exam.id, version.id);
  const session = await repository.createSession(exam.id, version.id, 'primary-authority-node');
  const authority = new LocalExamAuthority(repository);
  return { repository, exam, version, session, authority };
}

describe('PHARMATRACK — EXAM LOAD TESTING & SCALABILITY CERTIFICATION', () => {
  beforeEach(() => {
    idbStore.clear();
  });

  async function executeScaleBenchmark(studentCount: number) {
    const { repository, session, authority, version } = await setupLoadSession();
    let networkInterrupted = false;

    const serverFetch = createLanServerFetch(authority, async () => {
      if (networkInterrupted) throw new TypeError('Network connection lost (simulated LAN cut)');
      return null;
    });

    // 1. Simultaneous Registration
    const registerStart = performance.now();
    const registered = await Promise.all(
      Array.from({ length: studentCount }, async (_, i) => {
        const studentName = `Student_${studentCount}_${String(i + 1).padStart(4, '0')}`;
        const reg = await repository.registerStudent(studentName, 'Level 300');
        return { studentName, student: reg.student, password: reg.password, index: i };
      }),
    );
    const registerDuration = performance.now() - registerStart;
    expect(registered).toHaveLength(studentCount);

    // 2. Simultaneous Authentication
    const authStart = performance.now();
    const authenticated = await Promise.all(
      registered.map(async (r) => {
        const auth = await repository.authenticateStudent(r.studentName, 'Level 300', r.password);
        return { ...r, authStudent: auth };
      }),
    );
    const authDuration = performance.now() - authStart;
    expect(authenticated).toHaveLength(studentCount);

    // 3. Simultaneous Connection & Device Session Creation
    const connStart = performance.now();
    const students = await Promise.all(
      authenticated.map(async (r) => {
        const deviceId = `dev-${studentCount}-${String(r.index + 1).padStart(4, '0')}`;
        const client = new LanExamClient('http://192.168.1.100:8787', serverFetch, {
          studentId: r.authStudent.id,
        });
        const conn = await client.connect(session.id, deviceId, 'STUDENT', { studentId: r.authStudent.id });
        return {
          student: r.authStudent,
          deviceId,
          deviceSessionId: conn.deviceSessionId!,
          client,
        };
      }),
    );
    const connDuration = performance.now() - connStart;
    console.log(`[scale=${studentCount}] reg=${registerDuration.toFixed(0)}ms, auth=${authDuration.toFixed(0)}ms, conn=${connDuration.toFixed(0)}ms`);
    expect(students).toHaveLength(studentCount);

    // 2. Simultaneous Package Retrieval
    const pkgStart = performance.now();
    const packages = await Promise.all(students.map((s) => s.client.fetchPackage(session.id)));
    const pkgDuration = performance.now() - pkgStart;
    console.log(`[scale=${studentCount}] pkg=${pkgDuration.toFixed(0)}ms`);
    expect(packages).toHaveLength(studentCount);
    for (const pkg of packages) {
      expect(pkg.ok).toBe(true);
      expect(pkg.examVersionId).toBe(version.id);
    }

    // 3. Simultaneous Exam Start
    const startStart = performance.now();
    const attempts = await Promise.all(
      students.map((s) => s.client.createAttempt(session.id, s.student.id, s.deviceSessionId)),
    );
    const startDuration = performance.now() - startStart;
    console.log(`[scale=${studentCount}] start=${startDuration.toFixed(0)}ms`);
    expect(attempts).toHaveLength(studentCount);
    const attemptIds = new Set(attempts.map((a) => a.attempt!.id));
    expect(attemptIds.size).toBe(studentCount);

    // 4. Simultaneous Answer Synchronization (Q1)
    const q1Id = version.questions[0].id;
    const q2Id = version.questions[1].id;

    const sync1Start = performance.now();
    const sync1Results = await Promise.all(
      students.map(async (s, idx) => {
        const event: SyncEvent = {
          id: `evt-q1-${s.student.id}`,
          eventId: `ans-q1-${s.student.id}`,
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
            attemptId: attempts[idx].attempt!.id,
            answer: '0',
            selectedOption: 0,
            deviceSessionId: s.deviceSessionId,
            isFinal: false,
          },
        };
        return s.client.sync(session.id, [event]);
      }),
    );
    const sync1Duration = performance.now() - sync1Start;
    console.log(`[scale=${studentCount}] sync1=${sync1Duration.toFixed(0)}ms`);
    for (const res of sync1Results) {
      expect(res.ok).toBe(true);
      expect(res.applied).toBe(1);
      expect(res.conflicts).toEqual([]);
    }

    // 5. Simultaneous Heartbeats
    const hbStart = performance.now();
    const hbResults = await Promise.all(
      students.map((s) => s.client.heartbeat(session.id, s.deviceSessionId)),
    );
    const hbDuration = performance.now() - hbStart;
    console.log(`[scale=${studentCount}] hb=${hbDuration.toFixed(0)}ms`);
    for (const hb of hbResults) {
      expect(hb.ok).toBe(true);
      expect(hb.lastSeenAt).toBeDefined();
    }

    // 6. LAN Interruption (Simulate network cut)
    networkInterrupted = true;
    const offlineEvents = students.map((s, idx) => {
      const event: SyncEvent = {
        id: `evt-q2-${s.student.id}`,
        eventId: `ans-q2-${s.student.id}`,
        sessionId: session.id,
        entity: 'ANSWER',
        entityId: q2Id,
        sourceServerId: 'web-client',
        authorityEpoch: 1,
        revision: 2,
        at: new Date().toISOString(),
        direction: 'LOCAL_TO_SERVER',
        status: 'PENDING',
        questionId: q2Id,
        answerRevision: 2,
        payload: {
          attemptId: attempts[idx].attempt!.id,
          answer: '0',
          selectedOption: 0,
          deviceSessionId: s.deviceSessionId,
          isFinal: true,
        },
      };
      return event;
    });

    // Reconnection & Flushed Sync
    networkInterrupted = false;
    const reconStart = performance.now();
    const reconResults = await Promise.all(
      students.map((s, idx) => s.client.sync(session.id, [offlineEvents[idx]])),
    );
    const reconDuration = performance.now() - reconStart;
    console.log(`[scale=${studentCount}] recon=${reconDuration.toFixed(0)}ms`);
    for (const res of reconResults) {
      expect(res.ok).toBe(true);
      expect(res.applied).toBe(1);
    }

    // 8. Simultaneous Submission
    const submitStart = performance.now();
    const submissions = await Promise.all(
      students.map((s, idx) => s.client.submitAttempt(session.id, attempts[idx].attempt!.id, s.deviceSessionId)),
    );
    const submitDuration = performance.now() - submitStart;
    console.log(`[scale=${studentCount}] submit=${submitDuration.toFixed(0)}ms`);
    for (const sub of submissions) {
      expect(sub.ok).toBe(true);
      expect(sub.attempt?.status).toBe('SUBMITTED');
    }

    // Server-side verification
    const snapshot = repository.snapshot;
    expect(snapshot.attempts).toHaveLength(studentCount);
    for (const att of snapshot.attempts) {
      expect(att.status).toBe('SUBMITTED');
      expect(att.answers).toHaveLength(2);
      expect(att.submissionState).toBe('SUBMITTED');
    }
    expect(snapshot.results).toHaveLength(studentCount);

    return {
      studentCount,
      registerDuration,
      pkgDuration,
      startDuration,
      sync1Duration,
      hbDuration,
      reconDuration,
      submitDuration,
    };
  }

  it('validates 50 students concurrent load', async () => {
    const metrics = await executeScaleBenchmark(50);
    expect(metrics.studentCount).toBe(50);
  }, 30000);

  it('validates 100 students concurrent load', async () => {
    const metrics = await executeScaleBenchmark(100);
    expect(metrics.studentCount).toBe(100);
  }, 30000);

  it('validates 200 students concurrent load', async () => {
    const metrics = await executeScaleBenchmark(200);
    expect(metrics.studentCount).toBe(200);
  }, 45000);

  it('validates 300 students concurrent load', async () => {
    const metrics = await executeScaleBenchmark(300);
    expect(metrics.studentCount).toBe(300);
  }, 60000);

  it('validates 500 students concurrent load', async () => {
    const metrics = await executeScaleBenchmark(500);
    expect(metrics.studentCount).toBe(500);
  }, 90000);
});

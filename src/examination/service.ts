import { v4 as uuidv4 } from 'uuid';
import {
  canonicalJson,
  derivePasswordVerifier,
  digestJson,
  normalizeLevel,
  randomId,
  sequentialKioskPassword,
  verifyPassword,
} from './crypto';
import { loadExaminationState, saveExaminationState } from './storage';
import {
  adjustAttemptTimer,
  createAttemptTimer,
  pauseAttemptTimer,
  remainingMilliseconds,
  resumeAttemptTimer,
  timerFromLegacyAttempt,
} from './timer';
import { buildExaminationResult } from './results';
import {
  snapshotQuestion,
  type AdminAction,
  type AssessmentType,
  type DeviceSession,
  type Exam,
  type ExamAnswer,
  type ExamAvailability,
  type ExamBuilderDraft,
  type ExamLifecycle,
  type ExamQuestionSnapshot,
  type ExamScoringSettings,
  type ExamSecuritySettings,
  type ExamSession,
  type ExamStudent,
  type ExamVersion,
  type ExaminationResult,
  type ExaminationState,
  type RecoveryState,
  type AttemptTimerState,
  type ExamAuthorityRecord,
  type ExamAuthorityLeaseRecord,
  type ExamReplicationSnapshot,
  type ViolationPolicy,
  type SecurityViolation,
  type SyncEvent,
  type SecurityEvent,
  type StudentAttempt,
} from './types';
import type { ExamQuestion } from '../types';

const DEFAULT_SECURITY: ExamSecuritySettings = {
  lockdown: false,
  capabilityFailurePolicy: 'ALLOW_WITH_WARNING',
  kioskMode: false,
  allowBackNavigation: true,
  allowQuestionNavigation: true,
  allowReviewBeforeSubmit: true,
  allowCalculator: false,
  allowPause: false,
  requireExamPassword: false,
  requireLanAuthority: false,
  detectFocusLoss: true,
  maxFocusLosses: 3,
  disableNavigation: true,
  disableCopyPaste: true,
  disablePrinting: true,
  disableExternalLinks: true,
  disableDeveloperTools: true,
  restrictWindowControls: true,
  restrictScreenCapture: true,
  restrictExit: true,
  requiredCapabilities: [],
  violationPolicies: {
    FOCUS_LOST: 'LOG_ONLY',
    ATTEMPTED_EXIT: 'REQUIRE_ADMIN_UNLOCK',
    ATTEMPTED_NAVIGATION: 'WARNING',
    ATTEMPTED_PRINT: 'WARNING',
    ATTEMPTED_COPY_PASTE: 'WARNING',
    EXTERNAL_LINK_ATTEMPT: 'WARNING',
    DEVELOPER_TOOL_ATTEMPT: 'LOG_ONLY',
    SUSPICIOUS_STATE_TRANSITION: 'REQUIRE_ADMIN_UNLOCK',
    NETWORK_LOSS: 'LOG_ONLY',
    DEVICE_DISCONNECT: 'LOG_ONLY',
    SERVER_DISCONNECT: 'LOG_ONLY',
    RECOVERY: 'LOG_ONLY',
    ADMIN_INTERVENTION: 'LOG_ONLY',
  },
  policyVersion: 2,
};

const DEFAULT_SCORING: ExamScoringSettings = {
  passMark: 50,
  negativeMarking: false,
  negativeMarkValue: 0,
  defaultMarks: 1,
};

const DEFAULT_AVAILABILITY: ExamAvailability = { durationMinutes: 60 };

export interface CreateVersionInput {
  title: string;
  instructions?: string;
  assessmentType?: AssessmentType;
  courseId?: string;
  topicId?: string;
  academicYear?: string;
  semester?: string;
  scoring?: Partial<ExamScoringSettings>;
  availability?: Partial<ExamAvailability>;
  security?: Partial<ExamSecuritySettings>;
  navigation?: Partial<ExamVersion['navigation']>;
  maxAttempts?: number;
  marksByQuestion?: Record<string, number>;
}

export interface AttemptCreationResult {
  attempt: StudentAttempt;
  continued: boolean;
}

export const LIFECYCLE_TRANSITIONS: Record<ExamLifecycle, ExamLifecycle[]> = {
  DRAFT: ['VALIDATED'],
  VALIDATED: ['DRAFT', 'PUBLISHED'],
  PUBLISHED: ['SCHEDULED', 'ACTIVE', 'ARCHIVED'],
  SCHEDULED: ['ACTIVE', 'CLOSED'],
  ACTIVE: ['SUBMITTED', 'CLOSED'],
  SUBMITTED: ['CLOSED', 'ARCHIVED'],
  CLOSED: ['ARCHIVED'],
  ARCHIVED: [],
};

export function validateExamVersion(version: ExamVersion): string[] {
  const errors: string[] = [];
  if (!version.title.trim()) errors.push('An examination title is required.');
  if (!version.questions.length) errors.push('At least one question is required.');
  if (version.questions.some((question, index) => question.order !== index))
    errors.push('Question order must be contiguous and exact.');
  if (
    new Set(version.questions.map((question) => question.sourceQuestionId)).size !==
    version.questions.length
  )
    errors.push('A question cannot appear twice in one version.');
  if (version.scoring.passMark < 0 || version.scoring.passMark > 100)
    errors.push('Pass mark must be between 0 and 100.');
  if (version.availability.durationMinutes <= 0) errors.push('Duration must be greater than zero.');
  if (version.maxAttempts < 1) errors.push('At least one attempt must be allowed.');
  if (version.security.kioskMode && version.assessmentType !== 'KIOSK_EXAM')
    errors.push('Kiosk security requires KIOSK_EXAM assessment type.');
  // The seed belongs to an attempt, not the published version. Each attempt
  // generates and stores its own seed when randomization is enabled.
  for (const question of version.questions) {
    if (!question.questionText.trim()) errors.push(`Question ${question.order + 1} is empty.`);
    if (question.marks <= 0)
      errors.push(`Question ${question.order + 1} must have positive marks.`);
    if (question.questionType === 'mcq') {
      if (!question.options || question.options.length < 2)
        errors.push(`Question ${question.order + 1} needs at least two options.`);
      if (
        question.correctOption == null ||
        question.correctOption < 0 ||
        question.correctOption >= (question.options?.length || 0)
      )
        errors.push(`Question ${question.order + 1} has an invalid correct option.`);
    }
  }
  return [...new Set(errors)];
}

function shuffle<T>(items: T[], seed: string): T[] {
  let value = 0;
  for (const char of seed) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  const output = [...items];
  for (let i = output.length - 1; i > 0; i -= 1) {
    value = (value * 1664525 + 1013904223) >>> 0;
    const j = value % (i + 1);
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}

function questionSnapshotId(
  question: ExamQuestion,
  examId: string,
  version: number,
  order: number,
): string {
  return `${examId}:v${version}:q${order}:${question.id}`;
}

export function buildQuestionSnapshots(
  questions: ExamQuestion[],
  examId: string,
  version: number,
  marksByQuestion: Record<string, number> = {},
): ExamQuestionSnapshot[] {
  return questions.map((question, order) => ({
    ...snapshotQuestion(
      question,
      order,
      marksByQuestion[question.id] ?? question.marksAllocation ?? 1,
    ),
    id: questionSnapshotId(question, examId, version, order),
  }));
}

export async function versionHash(version: Omit<ExamVersion, 'versionHash'>): Promise<string> {
  return digestJson(version);
}

export function nextExamVersionNumber(exam: Exam, versions: ExamVersion[]): number {
  return (
    versions
      .filter((version) => version.examId === exam.id)
      .reduce((max, version) => Math.max(max, version.version), 0) + 1
  );
}

export class ExaminationRepository {
  private state: ExaminationState;

  private constructor(state: ExaminationState) {
    this.state = state;
  }

  static async open(): Promise<ExaminationRepository> {
    return new ExaminationRepository(await loadExaminationState());
  }

  get snapshot(): ExaminationState {
    return JSON.parse(JSON.stringify(this.state)) as ExaminationState;
  }

  async save(): Promise<boolean> {
    return saveExaminationState(this.state);
  }

  async createExam(title: string, ownerDeviceId = randomId('device')): Promise<Exam> {
    const now = new Date().toISOString();
    const exam: Exam = {
      id: randomId('exam'),
      title: title.trim(),
      lifecycle: 'DRAFT',
      createdAt: now,
      updatedAt: now,
      versionIds: [],
      publishedVersionIds: [],
      ownerDeviceId,
    };
    this.state.exams.push(exam);
    await this.save();
    await this.logAdminAction({
      adminId: ownerDeviceId,
      adminDeviceSessionId: ownerDeviceId,
      action: 'CREATE',
      targetId: exam.id,
      reason: 'Examination created.',
    });
    return exam;
  }

  async createVersion(
    examId: string,
    questions: ExamQuestion[],
    input: CreateVersionInput,
  ): Promise<ExamVersion> {
    const exam = this.requireExam(examId);
    if (
      exam.lifecycle === 'PUBLISHED' ||
      exam.lifecycle === 'SCHEDULED' ||
      exam.lifecycle === 'ACTIVE'
    ) {
      throw new Error('Published examinations are immutable. Create a new version instead.');
    }
    const versionNumber = nextExamVersionNumber(exam, this.state.versions);
    const versionWithoutHash: Omit<ExamVersion, 'versionHash'> = {
      id: randomId('exam_version'),
      examId,
      version: versionNumber,
      createdAt: new Date().toISOString(),
      immutable: false,
      title: input.title.trim() || exam.title,
      instructions: input.instructions?.trim() || '',
      assessmentType: input.assessmentType || 'FORMAL_EXAM',
      courseId: input.courseId,
      topicId: input.topicId,
      academicYear: input.academicYear,
      semester: input.semester,
      questions: buildQuestionSnapshots(questions, examId, versionNumber, input.marksByQuestion),
      scoring: { ...DEFAULT_SCORING, ...input.scoring },
      availability: { ...DEFAULT_AVAILABILITY, ...input.availability },
      security: { ...DEFAULT_SECURITY, ...input.security },
      navigation: {
        randomizeQuestions: false,
        randomizeOptions: false,
        allowPrevious: true,
        showQuestionNumbers: true,
        ...input.navigation,
      },
      maxAttempts: input.maxAttempts ?? 1,
    };
    const version: ExamVersion = {
      ...versionWithoutHash,
      versionHash: await versionHash(versionWithoutHash),
    };
    this.state.versions.push(version);
    exam.versionIds.push(version.id);
    exam.currentVersionId = version.id;
    exam.updatedAt = new Date().toISOString();
    await this.save();
    await this.logAdminAction({
      adminId: exam.ownerDeviceId,
      adminDeviceSessionId: exam.ownerDeviceId,
      action: 'CREATE',
      targetId: version.id,
      reason: 'Examination version created.',
    });
    return version;
  }

  async validateVersion(
    examId: string,
    versionId?: string,
  ): Promise<{ ok: boolean; errors: string[] }> {
    const version = this.requireVersion(examId, versionId);
    const errors = validateExamVersion(version);
    if (!errors.length) {
      const exam = this.requireExam(examId);
      if (exam.lifecycle === 'DRAFT') exam.lifecycle = 'VALIDATED';
      exam.updatedAt = new Date().toISOString();
      await this.save();
      await this.logAdminAction({
        adminId: exam.ownerDeviceId,
        adminDeviceSessionId: exam.ownerDeviceId,
        action: 'VALIDATE',
        targetId: version.id,
        reason: 'Examination version validated.',
      });
    }
    return { ok: errors.length === 0, errors };
  }

  async publishVersion(examId: string, versionId?: string): Promise<ExamVersion> {
    const exam = this.requireExam(examId);
    const version = this.requireVersion(examId, versionId);
    const validation = validateExamVersion(version);
    if (validation.length) throw new Error(`Cannot publish: ${validation.join(' ')}`);
    const frozen: ExamVersion = JSON.parse(
      JSON.stringify({ ...version, immutable: true, publishedAt: new Date().toISOString() }),
    );
    const index = this.state.versions.findIndex((item) => item.id === version.id);
    this.state.versions[index] = frozen;
    exam.lifecycle = 'PUBLISHED';
    exam.currentVersionId = frozen.id;
    if (!exam.publishedVersionIds.includes(frozen.id)) exam.publishedVersionIds.push(frozen.id);
    exam.updatedAt = new Date().toISOString();
    await this.save();
    await this.logAdminAction({
      adminId: exam.ownerDeviceId,
      adminDeviceSessionId: exam.ownerDeviceId,
      action: 'PUBLISH',
      targetId: frozen.id,
      reason: 'Immutable examination version published.',
    });
    return frozen;
  }

  async transitionExam(examId: string, next: ExamLifecycle): Promise<Exam> {
    const exam = this.requireExam(examId);
    if (!LIFECYCLE_TRANSITIONS[exam.lifecycle].includes(next))
      throw new Error(`Cannot move exam from ${exam.lifecycle} to ${next}.`);
    exam.lifecycle = next;
    exam.updatedAt = new Date().toISOString();
    if (next === 'ARCHIVED') exam.archivedAt = exam.updatedAt;
    await this.save();
    return exam;
  }

  async archiveExam(
    examId: string,
    adminId: string,
    adminDeviceSessionId: string,
    reason: string,
  ): Promise<Exam> {
    this.requireAdminDevice(adminDeviceSessionId);
    const exam = this.requireExam(examId);
    const pending = this.state.attempts.some(
      (attempt) =>
        attempt.examId === examId && !['SUBMITTED', 'CLOSED', 'LOCKED'].includes(attempt.status),
    );
    if (pending) throw new Error('An examination with active attempts cannot be archived.');
    if (exam.lifecycle !== 'ARCHIVED') {
      if (!LIFECYCLE_TRANSITIONS[exam.lifecycle].includes('ARCHIVED')) {
        if (LIFECYCLE_TRANSITIONS[exam.lifecycle].includes('CLOSED')) exam.lifecycle = 'CLOSED';
        else throw new Error(`Cannot archive an examination from ${exam.lifecycle}.`);
      }
      exam.lifecycle = 'ARCHIVED';
      exam.archivedAt = new Date().toISOString();
      exam.updatedAt = exam.archivedAt;
      for (const session of this.state.sessions.filter((item) => item.examId === examId)) {
        session.status = 'CLOSED';
        session.endedAt = exam.archivedAt;
      }
      await this.save();
      await this.logAdminAction({
        adminId,
        adminDeviceSessionId,
        action: 'CLOSE',
        targetId: examId,
        reason,
        previousState: 'RESULTS',
        newState: 'ARCHIVED',
      });
    }
    return exam;
  }

  async markPackageImported(packageKey: string): Promise<boolean> {
    if (this.state.importedPackageKeys.includes(packageKey)) return false;
    this.state.importedPackageKeys.push(packageKey);
    await this.save();
    return true;
  }

  async importPublishedVersion(
    version: ExamVersion,
    ownerDeviceId = randomId('device'),
  ): Promise<Exam> {
    const existing = this.state.exams.find((exam) => exam.id === version.examId);
    if (existing) {
      const known = this.state.versions.find((item) => item.id === version.id);
      if (known && known.versionHash !== version.versionHash)
        throw new Error('A different package already uses this examination version ID.');
      if (!known) this.state.versions.push(JSON.parse(JSON.stringify(version)));
      if (!existing.versionIds.includes(version.id)) existing.versionIds.push(version.id);
      existing.currentVersionId = version.id;
      await this.save();
      return existing;
    }
    const exam: Exam = {
      id: version.examId,
      title: version.title,
      lifecycle: 'PUBLISHED',
      createdAt: version.createdAt,
      updatedAt: new Date().toISOString(),
      currentVersionId: version.id,
      versionIds: [version.id],
      publishedVersionIds: [version.id],
      ownerDeviceId,
    };
    this.state.exams.push(exam);
    this.state.versions.push(JSON.parse(JSON.stringify(version)));
    await this.save();
    return exam;
  }

  async createSession(
    examId: string,
    versionId?: string,
    serverId = 'local-authority',
    authorityEndpoint?: string,
    preferredSessionId?: string,
  ): Promise<ExamSession> {
    const exam = this.requireExam(examId);
    const version = this.requireVersion(examId, versionId);
    if (!version.immutable)
      throw new Error('Only a validated published version can have an examination session.');
    const session: ExamSession = {
      id: preferredSessionId || randomId('session'),
      examId,
      examVersionId: version.id,
      status: 'CREATED',
      authoritativeServerId: serverId,
      authorityEndpoint,
      authorityEpoch: 1,
      createdAt: new Date().toISOString(),
      connectedDeviceIds: [],
      studentAttemptIds: [],
      lastReplicationRevision: 0,
      synchronizationStatus: 'local',
    };
    this.state.sessions.push(session);
    if (exam.lifecycle === 'PUBLISHED') exam.lifecycle = 'SCHEDULED';
    await this.save();
    await this.logSecurityEvent({
      sessionId: session.id,
      type: 'SESSION_CREATED',
      severity: 'info',
      details: `Session created for immutable version ${version.id}.`,
    });
    return session;
  }

  async registerStudent(
    firstName: string,
    level: string,
  ): Promise<{ student: ExamStudent; password: string }> {
    const cleanName = firstName.trim();
    const cleanLevel = normalizeLevel(level);
    if (!cleanName) throw new Error('First name is required.');
    if (!cleanLevel) throw new Error('Choose a valid level from Level 100 to Level 600.');
    if (
      this.state.students.some(
        (student) => student.firstName.toLocaleLowerCase() === cleanName.toLocaleLowerCase(),
      )
    ) {
      throw new Error(
        'This first name is already in use. Please use your surname, middle name, or add a number to your first name.',
      );
    }
    const password = sequentialKioskPassword(this.state.students.length);
    const student: ExamStudent = {
      id: randomId('student'),
      firstName: cleanName,
      level: cleanLevel,
      kioskPasswordVerifier: await derivePasswordVerifier(password),
      registeredAt: new Date().toISOString(),
      activeDeviceSessionIds: [],
    };
    this.state.students.push(student);
    await this.save();
    await this.logSecurityEvent({
      studentId: student.id,
      type: 'IDENTITY_REGISTERED',
      severity: 'info',
      details: `Kiosk identity registered for ${student.level}.`,
    });
    return { student, password };
  }

  async authenticateStudent(
    firstName: string,
    level: string,
    password: string,
  ): Promise<ExamStudent> {
    const student = this.state.students.find(
      (item) =>
        item.firstName.toLocaleLowerCase() === firstName.trim().toLocaleLowerCase() &&
        item.level === normalizeLevel(level),
    );
    if (!student || !(await verifyPassword(password, student.kioskPasswordVerifier))) {
      await this.logSecurityEvent({
        studentId: student?.id,
        type: 'IDENTITY_REJECTED',
        severity: 'warning',
        details: 'Kiosk identity authentication failed.',
      });
      throw new Error('First name, level, or RX30 Kiosk password is incorrect.');
    }
    student.lastAuthenticatedAt = new Date().toISOString();
    await this.save();
    await this.logSecurityEvent({
      studentId: student.id,
      type: 'IDENTITY_AUTHENTICATED',
      severity: 'info',
      details: 'Kiosk identity authenticated.',
    });
    return student;
  }

  async createAttempt(
    sessionId: string,
    studentId: string,
    deviceSessionId: string,
    authoritativeStartedAt?: string,
    preferredAttemptId?: string,
  ): Promise<AttemptCreationResult> {
    const session = this.requireSession(sessionId);
    const version = this.requireVersion(session.examId, session.examVersionId);
    const existing = this.state.attempts.find(
      (attempt) =>
        attempt.sessionId === sessionId &&
        attempt.studentId === studentId &&
        ['READY', 'ACTIVE', 'PAUSED', 'DEVICE_LOST', 'RECOVERY_PENDING'].includes(attempt.status),
    );
    if (existing) {
      const previousDeviceSessionId = existing.deviceSessionId;
      for (const device of this.state.deviceSessions) {
        if (
          device.sessionId === sessionId &&
          device.id !== deviceSessionId &&
          device.status === 'CONNECTED'
        ) {
          device.status = 'DISCONNECTED';
        }
      }
      const owner = this.state.students.find((item) => item.id === studentId);
      if (owner)
        owner.activeDeviceSessionIds = [
          ...new Set([
            ...owner.activeDeviceSessionIds.filter((id) => id === deviceSessionId),
            deviceSessionId,
          ]),
        ];
      existing.deviceSessionId = deviceSessionId;
      existing.lastSyncedAt = new Date().toISOString();
      existing.ownershipGeneration = (existing.ownershipGeneration || 0) + 1;
      existing.status = 'ACTIVE';
      existing.securityState = 'NORMAL';
      existing.synchronizationState = 'RECOVERY_PENDING';
      const switchNow = new Date().toISOString();
      const switchRecovery = {
        id: randomId('recovery'),
        sessionId,
        attemptId: existing.id,
        state: 'RECOVERED' as const,
        lastKnownRevision: existing.serverRevision,
        localEncryptedStateAvailable: true,
        reason: 'Device ownership switched after Continue Exam.',
        createdAt: switchNow,
        updatedAt: switchNow,
      };
      this.state.recoveryStates.push(switchRecovery);
      existing.recoveryStateId = switchRecovery.id;
      session.connectedDeviceIds = [...new Set([...session.connectedDeviceIds, deviceSessionId])];
      this.state.securityEvents.push({
        id: randomId('security'),
        sessionId,
        attemptId: existing.id,
        studentId,
        deviceSessionId,
        type: 'DEVICE_SWITCH',
        severity: 'info',
        at: new Date().toISOString(),
        details: `Attempt ownership moved from ${previousDeviceSessionId} to ${deviceSessionId}.`,
      });
      await this.save();
      return { attempt: existing, continued: true };
    }
    const priorCount = this.state.attempts.filter(
      (attempt) => attempt.sessionId === sessionId && attempt.studentId === studentId,
    ).length;
    if (priorCount >= version.maxAttempts)
      throw new Error('The maximum number of attempts has already been used.');
    const randomizationSeed =
      version.navigation.randomizeQuestions || version.navigation.randomizeOptions
        ? uuidv4()
        : undefined;
    const orderedQuestions =
      randomizationSeed && version.navigation.randomizeQuestions
        ? shuffle(version.questions, randomizationSeed)
        : version.questions;
    const questionOrder = orderedQuestions.map((question) => question.id);
    const optionOrders: Record<string, number[]> = {};
    for (const question of orderedQuestions) {
      const indexes = (question.options || []).map((_, index) => index);
      optionOrders[question.id] =
        randomizationSeed && version.navigation.randomizeOptions
          ? shuffle(indexes, `${randomizationSeed}:${question.id}`)
          : indexes;
    }
    const startedAt = new Date();
    const timerState = createAttemptTimer(
      version.availability.durationMinutes,
      authoritativeStartedAt || startedAt.toISOString(),
      session.authorityEpoch,
    );
    const attempt: StudentAttempt = {
      id: preferredAttemptId || randomId('attempt'),
      sessionId,
      examId: session.examId,
      examVersionId: version.id,
      studentId,
      deviceSessionId,
      status: 'ACTIVE',
      startedAt: startedAt.toISOString(),
      deadlineAt: timerState.authoritativeDeadlineAt,
      timerState,
      currentQuestionId: questionOrder[0],
      questionOrder,
      optionOrders,
      randomizationSeed,
      settingsSnapshot: {
        scoring: JSON.parse(JSON.stringify(version.scoring)),
        availability: JSON.parse(JSON.stringify(version.availability)),
        security: JSON.parse(JSON.stringify(version.security)),
        navigation: JSON.parse(JSON.stringify(version.navigation)),
      },
      answers: [],
      focusLosses: 0,
      securityState: 'NORMAL',
      synchronizationState: 'LOCAL_ONLY',
      saveStatus: 'SAVED',
      submissionState: 'NOT_SUBMITTED',
      ownershipGeneration: 1,
      localRevision: 0,
      serverRevision: 0,
    };
    this.state.attempts.push(attempt);
    session.studentAttemptIds.push(attempt.id);
    session.status = 'ACTIVE';
    session.connectedDeviceIds = [...new Set([...session.connectedDeviceIds, deviceSessionId])];
    await this.save();
    await this.logSecurityEvent({
      attemptId: attempt.id,
      sessionId: session.id,
      studentId,
      deviceSessionId,
      type: 'ATTEMPT_STARTED',
      severity: 'info',
      details: 'Attempt created with encrypted local state and authoritative timer.',
    });
    return { attempt, continued: false };
  }

  async recordAnswer(
    attemptId: string,
    answer: Omit<ExamAnswer, 'revision' | 'answeredAt'>,
  ): Promise<ExamAnswer> {
    const attempt = this.requireAttempt(attemptId);
    if (!['ACTIVE', 'PAUSED', 'RECOVERY_PENDING'].includes(attempt.status))
      throw new Error('This attempt no longer accepts answers.');
    const knownDeviceSession = this.state.deviceSessions.some(
      (item) => item.id === answer.deviceSessionId,
    );
    if (knownDeviceSession && answer.deviceSessionId !== attempt.deviceSessionId)
      throw new Error(
        'This device session no longer owns the active attempt. Continue Exam on the active device.',
      );
    const previousAnswers = [...attempt.answers];
    const previousAllAnswers = [...this.state.answers];
    const previousSyncEvents = [...this.state.syncEvents];
    const previousRevision = attempt.localRevision;
    const session = this.state.sessions.find((item) => item.id === attempt.sessionId);
    const saved: ExamAnswer = {
      ...answer,
      eventId: answer.eventId || randomId('answer_event'),
      answeredAt: new Date().toISOString(),
      revision: ++attempt.localRevision,
    };
    attempt.saveStatus = 'SAVING';
    attempt.answers = [
      ...attempt.answers.filter((item) => item.questionId !== saved.questionId),
      saved,
    ];
    this.state.answers = [
      ...this.state.answers.filter(
        (item) =>
          !(
            item.questionId === saved.questionId &&
            item.deviceSessionId === saved.deviceSessionId &&
            item.revision < saved.revision
          ),
      ),
      saved,
    ];
    if (session) {
      this.state.syncEvents.push({
        id: randomId('sync_event'),
        eventId: saved.eventId,
        sessionId: session.id,
        entity: 'ANSWER',
        entityId: saved.eventId || saved.questionId,
        sourceServerId: 'local-device',
        authorityEpoch: session.authorityEpoch,
        revision: saved.revision,
        at: saved.answeredAt,
        direction: 'LOCAL_TO_SERVER',
        status: 'PENDING',
        questionId: saved.questionId,
        answerRevision: saved.revision,
        payload: {
          attemptId: attempt.id,
          answer: saved.answer,
          selectedOption: saved.selectedOption,
          deviceSessionId: saved.deviceSessionId,
        },
      });
    }
    const persisted = await this.save();
    if (!persisted) {
      attempt.answers = previousAnswers;
      this.state.answers = previousAllAnswers;
      this.state.syncEvents = previousSyncEvents;
      attempt.localRevision = previousRevision;
      attempt.saveStatus = 'SAVE_PROBLEM';
      throw new Error('Answer could not be persisted locally. The answer was kept for retry.');
    }
    attempt.saveStatus = 'SAVED';
    await this.logSecurityEvent({
      attemptId: attempt.id,
      sessionId: attempt.sessionId,
      studentId: attempt.studentId,
      deviceSessionId: attempt.deviceSessionId,
      type: 'ANSWER_PERSISTED',
      severity: 'info',
      details: `Answer revision ${saved.revision} persisted locally for question ${saved.questionId}.`,
      metadata: { revision: saved.revision, eventId: saved.eventId || '' },
    });
    return saved;
  }

  async submitAttempt(
    attemptId: string,
    forced = false,
    deviceSessionId?: string,
  ): Promise<StudentAttempt> {
    const attempt = this.requireAttempt(attemptId);
    if (!forced && deviceSessionId && deviceSessionId !== attempt.deviceSessionId)
      throw new Error('This device session no longer owns the active attempt.');
    if (
      attempt.status === 'SUBMITTED' ||
      attempt.status === 'CLOSED' ||
      attempt.status === 'LOCKED'
    ) {
      this.ensureResult(attempt);
      await this.save();
      return attempt;
    }
    attempt.status = 'SUBMITTED';
    attempt.submissionState = forced ? 'FORCE_SUBMITTED' : 'SUBMITTED';
    attempt.submittedAt = new Date().toISOString();
    attempt.synchronizationState =
      attempt.synchronizationState === 'DEGRADED'
        ? 'RECOVERY_PENDING'
        : attempt.synchronizationState;
    this.ensureResult(attempt);
    await this.save();
    return attempt;
  }

  getExaminationResult(attemptId: string): ExaminationResult | undefined {
    const attempt = this.state.attempts.find((item) => item.id === attemptId);
    const existing = this.state.results.find((result) => result.attemptId === attemptId);
    if (!attempt || !existing) return existing;
    const refreshed = buildExaminationResult(this.state, attempt, existing.submittedAt);
    const index = this.state.results.findIndex((result) => result.id === existing.id);
    this.state.results[index] = refreshed;
    return refreshed;
  }

  private ensureResult(attempt: StudentAttempt): ExaminationResult {
    const existing = this.state.results.find((result) => result.attemptId === attempt.id);
    if (existing) return existing;
    const result = buildExaminationResult(this.state, attempt);
    this.state.results.push(result);
    return result;
  }

  async saveAuthorityRecord(record: ExamAuthorityRecord): Promise<void> {
    const index = this.state.authorities.findIndex((item) => item.serverId === record.serverId);
    if (index >= 0) this.state.authorities[index] = { ...this.state.authorities[index], ...record };
    else this.state.authorities.push(record);
    await this.save();
  }

  async saveAuthorityLease(lease: ExamAuthorityLeaseRecord): Promise<void> {
    const index = this.state.authorityLeases.findIndex((item) => item.leaseId === lease.leaseId);
    if (index >= 0) this.state.authorityLeases[index] = lease;
    else this.state.authorityLeases.push(lease);
    await this.save();
  }

  async saveReplicationSnapshot(snapshot: ExamReplicationSnapshot): Promise<void> {
    this.state.replicationSnapshots.push(snapshot);
    await this.save();
  }

  async applyAuthorityTakeover(
    sessionId: string,
    serverId: string,
    authorityEpoch: number,
    authoritativeAt: string,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    if (authorityEpoch < session.authorityEpoch)
      throw new Error('Stale authority takeover was rejected.');
    session.authoritativeServerId = serverId;
    session.authorityEpoch = authorityEpoch;
    session.synchronizationStatus = 'recovery';
    for (const attempt of this.state.attempts.filter(
      (item) => item.sessionId === sessionId && item.timerState,
    )) {
      attempt.timerState = {
        ...attempt.timerState!,
        authorityEpoch,
        lastAuthorityAt: authoritativeAt,
      };
      attempt.synchronizationState = 'RECOVERY_PENDING';
      attempt.status = attempt.status === 'ACTIVE' ? 'RECOVERY_PENDING' : attempt.status;
    }
    await this.logSecurityEvent({
      sessionId,
      type: 'FAILOVER_COMPLETED',
      severity: 'warning',
      details: `Authority ${serverId} took over at epoch ${authorityEpoch}.`,
    });
  }

  async getAttemptTimer(
    attemptId: string,
    authoritativeNow = new Date().toISOString(),
  ): Promise<{
    remainingMilliseconds: number;
    deadlineAt: string;
    paused: boolean;
    timer: AttemptTimerState;
  }> {
    const attempt = this.requireAttempt(attemptId);
    const timer =
      attempt.timerState ||
      timerFromLegacyAttempt(
        attempt.startedAt,
        attempt.deadlineAt,
        attempt.settingsSnapshot.availability.durationMinutes,
      );
    attempt.timerState = timer;
    attempt.deadlineAt = timer.authoritativeDeadlineAt;
    return {
      remainingMilliseconds: remainingMilliseconds(timer, authoritativeNow),
      deadlineAt: timer.authoritativeDeadlineAt,
      paused: Boolean(timer.pausedAt),
      timer,
    };
  }

  async pauseAttempt(
    attemptId: string,
    adminId: string,
    adminDeviceSessionId: string,
    reason: string,
    authoritativeAt = new Date().toISOString(),
  ): Promise<StudentAttempt> {
    this.requireAdminDevice(adminDeviceSessionId);
    const attempt = this.requireAttempt(attemptId);
    const timer =
      attempt.timerState ||
      timerFromLegacyAttempt(
        attempt.startedAt,
        attempt.deadlineAt,
        attempt.settingsSnapshot.availability.durationMinutes,
      );
    attempt.timerState = pauseAttemptTimer(timer, authoritativeAt);
    attempt.deadlineAt = attempt.timerState.authoritativeDeadlineAt;
    attempt.status = 'PAUSED';
    await this.logAdminAction({
      adminId,
      adminDeviceSessionId,
      action: 'PAUSE',
      targetId: attempt.id,
      targetStudentId: attempt.studentId,
      reason,
      previousState: 'ACTIVE',
      newState: 'PAUSED',
    });
    await this.logSecurityEvent({
      attemptId,
      sessionId: attempt.sessionId,
      studentId: attempt.studentId,
      deviceSessionId: attempt.deviceSessionId,
      type: 'TIMER_PAUSED',
      severity: 'info',
      details: reason,
    });
    return attempt;
  }

  async resumeAttempt(
    attemptId: string,
    adminId: string,
    adminDeviceSessionId: string,
    reason: string,
    authoritativeAt = new Date().toISOString(),
  ): Promise<StudentAttempt> {
    this.requireAdminDevice(adminDeviceSessionId);
    const attempt = this.requireAttempt(attemptId);
    const timer =
      attempt.timerState ||
      timerFromLegacyAttempt(
        attempt.startedAt,
        attempt.deadlineAt,
        attempt.settingsSnapshot.availability.durationMinutes,
      );
    attempt.timerState = resumeAttemptTimer(timer, authoritativeAt);
    attempt.deadlineAt = attempt.timerState.authoritativeDeadlineAt;
    attempt.status = 'ACTIVE';
    await this.logAdminAction({
      adminId,
      adminDeviceSessionId,
      action: 'RESUME',
      targetId: attempt.id,
      targetStudentId: attempt.studentId,
      reason,
      previousState: 'PAUSED',
      newState: 'ACTIVE',
    });
    await this.logSecurityEvent({
      attemptId,
      sessionId: attempt.sessionId,
      studentId: attempt.studentId,
      deviceSessionId: attempt.deviceSessionId,
      type: 'TIMER_RESUMED',
      severity: 'info',
      details: reason,
    });
    return attempt;
  }

  async adjustAttemptTime(
    attemptId: string,
    minutes: number,
    adminId: string,
    adminDeviceSessionId: string,
    reason: string,
    authoritativeAt = new Date().toISOString(),
  ): Promise<StudentAttempt> {
    this.requireAdminDevice(adminDeviceSessionId);
    if (!Number.isFinite(minutes) || minutes === 0)
      throw new Error('Time adjustment must be a non-zero number of minutes.');
    const attempt = this.requireAttempt(attemptId);
    const timer =
      attempt.timerState ||
      timerFromLegacyAttempt(
        attempt.startedAt,
        attempt.deadlineAt,
        attempt.settingsSnapshot.availability.durationMinutes,
      );
    const next = adjustAttemptTimer(timer, minutes, adminId, reason, authoritativeAt);
    if (new Date(next.authoritativeDeadlineAt).getTime() < new Date(authoritativeAt).getTime())
      throw new Error('Time cannot be reduced below the authoritative current time.');
    attempt.timerState = next;
    attempt.deadlineAt = next.authoritativeDeadlineAt;
    await this.logAdminAction({
      adminId,
      adminDeviceSessionId,
      action: minutes > 0 ? 'ADD_TIME' : 'REMOVE_TIME',
      targetId: attempt.id,
      targetStudentId: attempt.studentId,
      reason,
      previousState: attempt.status,
      newState: attempt.status,
      timeAdjustmentMinutes: minutes,
    });
    await this.logSecurityEvent({
      attemptId,
      sessionId: attempt.sessionId,
      studentId: attempt.studentId,
      deviceSessionId: attempt.deviceSessionId,
      type: 'TIMER_ADJUSTED',
      severity: 'info',
      details: `${minutes} minute adjustment: ${reason}`,
    });
    return attempt;
  }

  async forceSubmitAttempt(
    attemptId: string,
    adminId: string,
    adminDeviceSessionId: string,
    reason: string,
  ): Promise<StudentAttempt> {
    this.requireAdminDevice(adminDeviceSessionId);
    const attempt = await this.submitAttempt(attemptId, true);
    await this.logAdminAction({
      adminId,
      adminDeviceSessionId,
      action: 'FORCE_SUBMIT',
      targetId: attemptId,
      targetStudentId: attempt.studentId,
      reason,
      previousState: 'ACTIVE',
      newState: 'SUBMITTED',
    });
    await this.logSecurityEvent({
      attemptId,
      sessionId: attempt.sessionId,
      studentId: attempt.studentId,
      deviceSessionId: attempt.deviceSessionId,
      type: 'FORCE_SUBMITTED',
      severity: 'warning',
      details: reason,
    });
    return attempt;
  }

  async terminateAttempt(
    attemptId: string,
    adminId: string,
    adminDeviceSessionId: string,
    reason: string,
  ): Promise<StudentAttempt> {
    this.requireAdminDevice(adminDeviceSessionId);
    const attempt = this.requireAttempt(attemptId);
    const previousState = attempt.status;
    attempt.status = 'LOCKED';
    attempt.submissionState = 'TERMINATED';
    attempt.submittedAt = attempt.submittedAt || new Date().toISOString();
    this.ensureResult(attempt);
    await this.logAdminAction({
      adminId,
      adminDeviceSessionId,
      action: 'TERMINATE',
      targetId: attemptId,
      targetStudentId: attempt.studentId,
      reason,
      previousState,
      newState: 'LOCKED',
    });
    await this.logSecurityEvent({
      attemptId,
      sessionId: attempt.sessionId,
      studentId: attempt.studentId,
      deviceSessionId: attempt.deviceSessionId,
      type: 'ATTEMPT_TERMINATED',
      severity: 'critical',
      details: reason,
    });
    await this.save();
    return attempt;
  }

  async unlockAttempt(
    attemptId: string,
    adminId: string,
    adminDeviceSessionId: string,
    reason: string,
  ): Promise<StudentAttempt> {
    this.requireAdminDevice(adminDeviceSessionId);
    const attempt = this.requireAttempt(attemptId);
    const previous = attempt.status;
    if (attempt.status === 'LOCKED') attempt.status = 'RECOVERY_PENDING';
    attempt.securityState = 'ADMIN_REVIEW';
    await this.logAdminAction({
      adminId,
      adminDeviceSessionId,
      action: 'UNLOCK',
      targetId: attemptId,
      targetStudentId: attempt.studentId,
      reason,
      previousState: previous,
      newState: attempt.status,
    });
    await this.logSecurityEvent({
      attemptId,
      sessionId: attempt.sessionId,
      studentId: attempt.studentId,
      deviceSessionId: attempt.deviceSessionId,
      type: 'ADMIN_INTERVENTION',
      severity: 'warning',
      details: reason,
    });
    await this.save();
    return attempt;
  }

  async recordSecurityViolation(
    attemptId: string,
    violation: SecurityViolation,
    detail: string,
  ): Promise<{ policy: ViolationPolicy; attempt: StudentAttempt }> {
    const attempt = this.requireAttempt(attemptId);
    const policy =
      attempt.settingsSnapshot.security.violationPolicies?.[violation] ||
      (violation === 'NETWORK_LOSS' || violation === 'SERVER_DISCONNECT' ? 'LOG_ONLY' : 'WARNING');
    const severity = policy === 'LOG_ONLY' ? 'info' : policy === 'WARNING' ? 'warning' : 'critical';
    const eventType =
      violation === 'FOCUS_LOST'
        ? 'FOCUS_LOST'
        : violation === 'RECOVERY'
          ? 'RECOVERY_COMPLETED'
          : violation === 'NETWORK_LOSS'
            ? 'NETWORK_LOSS'
            : violation === 'DEVICE_DISCONNECT'
              ? 'DEVICE_DISCONNECT'
              : violation === 'SERVER_DISCONNECT'
                ? 'SERVER_DISCONNECT'
                : violation === 'ATTEMPTED_EXIT'
                  ? 'ATTEMPTED_EXIT'
                  : violation === 'ATTEMPTED_NAVIGATION'
                    ? 'ATTEMPTED_NAVIGATION'
                    : violation === 'ATTEMPTED_PRINT'
                      ? 'ATTEMPTED_PRINT'
                      : violation === 'ATTEMPTED_COPY_PASTE'
                        ? 'ATTEMPTED_COPY_PASTE'
                        : violation === 'EXTERNAL_LINK_ATTEMPT'
                          ? 'EXTERNAL_LINK_ATTEMPT'
                          : violation === 'DEVELOPER_TOOL_ATTEMPT'
                            ? 'DEVELOPER_TOOL_ATTEMPT'
                            : 'SUSPICIOUS_STATE_TRANSITION';
    await this.logSecurityEvent({
      attemptId,
      sessionId: attempt.sessionId,
      studentId: attempt.studentId,
      deviceSessionId: attempt.deviceSessionId,
      type: eventType,
      severity,
      details: `${policy}: ${detail}`,
    });
    if (violation === 'FOCUS_LOST') attempt.focusLosses += 1;
    if (policy === 'LOCK_TEMPORARILY' || policy === 'REQUIRE_ADMIN_UNLOCK') {
      attempt.status = 'LOCKED';
      attempt.securityState = policy === 'REQUIRE_ADMIN_UNLOCK' ? 'ADMIN_REVIEW' : 'LOCKED';
    }
    if (policy === 'TERMINATE_ATTEMPT') {
      attempt.status = 'LOCKED';
      attempt.submissionState = 'TERMINATED';
    }
    if (policy === 'FORCE_SUBMIT') {
      attempt.status = 'SUBMITTED';
      attempt.submissionState = 'FORCE_SUBMITTED';
      attempt.submittedAt = new Date().toISOString();
    }
    await this.save();
    return { policy, attempt };
  }

  pendingSyncEvents(sessionId: string): SyncEvent[] {
    return this.state.syncEvents.filter(
      (event) => event.sessionId === sessionId && event.status === 'PENDING',
    );
  }

  /**
   * Apply events received by the examination authority. This is deliberately
   * separate from acknowledgeSyncEvents: an acknowledgement is only produced
   * after validation, mutation, audit append, and the durable encrypted save
   * all succeed. The native LAN server follows the same transaction contract.
   */
  async processIncomingSyncEvents(
    sessionId: string,
    events: SyncEvent[],
    authoritativeAt = new Date().toISOString(),
  ): Promise<{
    ok: boolean;
    applied: number;
    conflicts: string[];
    revision: number;
    acknowledgedEventIds: string[];
  }> {
    const session = this.requireSession(sessionId);
    let applied = 0;
    const conflicts: string[] = [];
    const acknowledgedEventIds: string[] = [];

    for (const incoming of events) {
      const eventKey = incoming.eventId || incoming.id;
      const existing = this.state.syncEvents.find(
        (event) => event.eventId === eventKey || event.id === incoming.id,
      );
      if (existing?.status === 'APPLIED') {
        acknowledgedEventIds.push(incoming.id);
        continue;
      }
      if (existing?.status === 'REJECTED') {
        conflicts.push(`${incoming.id}: previously rejected by the examination authority.`);
        continue;
      }

      const previousState = JSON.parse(JSON.stringify(this.state)) as ExaminationState;
      const reason = this.validateIncomingEvent(session, incoming);
      if (reason) {
        const rejected = existing || {
          ...incoming,
          status: 'REJECTED' as const,
          serverReceiptAt: authoritativeAt,
        };
        if (!existing) this.state.syncEvents.push(rejected);
        else existing.status = 'REJECTED';
        this.appendSecurityEventInMemory({
          sessionId,
          attemptId: this.incomingAttemptId(incoming),
          deviceSessionId: this.incomingDeviceSessionId(incoming),
          type: 'SYNC_REJECTED',
          severity: 'warning',
          at: authoritativeAt,
          details: `${incoming.id}: ${reason}`,
        });
        if (!(await this.save())) this.state = previousState;
        conflicts.push(`${incoming.id}: ${reason}`);
        continue;
      }

      try {
        const serverRevision = session.lastReplicationRevision + 1;
        this.applyIncomingEventInMemory(session, incoming, serverRevision, authoritativeAt);
        const appliedEvent = this.state.syncEvents.find(
          (event) => event.eventId === eventKey || event.id === incoming.id,
        );
        if (appliedEvent) {
          appliedEvent.status = 'APPLIED';
          appliedEvent.serverReceiptAt = authoritativeAt;
        } else {
          this.state.syncEvents.push({
            ...incoming,
            status: 'APPLIED',
            serverReceiptAt: authoritativeAt,
          });
        }
        session.lastReplicationRevision = serverRevision;
        this.appendSecurityEventInMemory({
          sessionId,
          attemptId: this.incomingAttemptId(incoming),
          deviceSessionId: this.incomingDeviceSessionId(incoming),
          type: incoming.entity === 'ANSWER' ? 'ANSWER_RECORDED' : 'SYNC_RECONCILED',
          severity: 'info',
          at: authoritativeAt,
          details: `Accepted ${incoming.entity} event ${incoming.id} at server revision ${serverRevision}.`,
          metadata: { eventId: incoming.id, serverRevision },
        });
        const persisted = await this.save();
        if (!persisted) throw new Error('Durable examination persistence failed.');
        applied += 1;
        acknowledgedEventIds.push(incoming.id);
      } catch (error) {
        this.state = previousState;
        conflicts.push(
          `${incoming.id}: ${error instanceof Error ? error.message : 'Event transaction failed.'}`,
        );
      }
    }

    return {
      ok: conflicts.length === 0,
      applied,
      conflicts,
      revision:
        this.state.sessions.find((item) => item.id === sessionId)?.lastReplicationRevision || 0,
      acknowledgedEventIds,
    };
  }

  private validateIncomingEvent(session: ExamSession, event: SyncEvent): string | undefined {
    if (event.sessionId !== session.id) return 'Event session does not match the target session.';
    if (event.authorityEpoch !== session.authorityEpoch) return 'Event authority epoch is stale.';
    if (!event.id || !event.eventId) return 'Event ID is required for replay protection.';
    if (!Number.isInteger(event.revision) || event.revision < 1)
      return 'Event revision is invalid.';
    const attemptId = this.incomingAttemptId(event);
    const attempt = this.state.attempts.find((item) => item.id === attemptId);
    if (!attempt) return 'Attempt ownership could not be established.';
    const deviceSessionId = this.incomingDeviceSessionId(event);
    const device = this.state.deviceSessions.find(
      (item) => item.id === deviceSessionId || item.deviceId === deviceSessionId,
    );
    if (!device || device.role !== 'STUDENT' || device.sessionId !== session.id)
      return 'Device session is not authenticated for this examination session.';
    if (device.status !== 'CONNECTED') return 'Device session is not connected.';
    if (
      attempt.deviceSessionId !== deviceSessionId &&
      attempt.deviceSessionId !== device.id &&
      attempt.deviceSessionId !== device.deviceId
    )
      return 'Device session does not own this attempt.';
    if (event.entity === 'ANSWER') {
      const answerRevision = event.answerRevision || 0;
      const payload = event.payload || {};
      if (!event.questionId || !Number.isInteger(answerRevision) || answerRevision < 1)
        return 'Answer question ID or revision is invalid.';
      if (typeof payload.answer !== 'string') return 'Answer payload is invalid.';
      const question = this.requireVersion(session.examId, session.examVersionId).questions.find(
        (item) => item.id === event.questionId,
      );
      if (!question) return 'Question does not belong to the immutable examination version.';
      const current = attempt.answers.find((answer) => answer.questionId === event.questionId);
      if (current && current.eventId !== event.eventId && current.revision >= answerRevision)
        return 'A newer answer revision is already authoritative.';
    } else if (event.entity === 'SECURITY_EVENT') {
      if (typeof event.payload?.type !== 'string') return 'Security event type is required.';
    } else {
      return `Entity ${event.entity} is not accepted by the LAN answer authority.`;
    }
    return undefined;
  }

  private incomingAttemptId(event: SyncEvent): string | undefined {
    const value = event.payload?.attemptId;
    return typeof value === 'string'
      ? value
      : event.entity === 'ATTEMPT'
        ? event.entityId
        : undefined;
  }

  private incomingDeviceSessionId(event: SyncEvent): string | undefined {
    const value = event.payload?.deviceSessionId;
    return typeof value === 'string' ? value : undefined;
  }

  private applyIncomingEventInMemory(
    session: ExamSession,
    event: SyncEvent,
    serverRevision: number,
    authoritativeAt: string,
  ): void {
    const attempt = this.state.attempts.find((item) => item.id === this.incomingAttemptId(event));
    if (!attempt) throw new Error('Attempt disappeared during event transaction.');
    if (event.entity === 'ANSWER') {
      const payload = event.payload || {};
      const answerRevision = event.answerRevision || 0;
      const answer: ExamAnswer = {
        questionId: event.questionId!,
        answer: String(payload.answer),
        selectedOption:
          typeof payload.selectedOption === 'number' ? payload.selectedOption : undefined,
        answeredAt: event.at,
        revision: answerRevision,
        eventId: event.eventId,
        deviceSessionId: this.incomingDeviceSessionId(event)!,
        isFinal: payload.isFinal === true,
        serverReceiptAt: authoritativeAt,
        serverRevision,
      };
      attempt.answers = [
        ...attempt.answers.filter((item) => item.questionId !== answer.questionId),
        answer,
      ];
      this.state.answers = [
        ...this.state.answers.filter(
          (item) =>
            !(
              item.questionId === answer.questionId &&
              item.deviceSessionId === answer.deviceSessionId
            ),
        ),
        answer,
      ];
      attempt.serverRevision = serverRevision;
      attempt.lastSyncedAt = authoritativeAt;
      attempt.synchronizationState = 'SYNCHRONIZED';
    } else if (event.entity === 'SECURITY_EVENT') {
      const type = event.payload?.type as SecurityEvent['type'];
      this.appendSecurityEventInMemory({
        sessionId: session.id,
        attemptId: attempt.id,
        studentId: attempt.studentId,
        deviceSessionId: this.incomingDeviceSessionId(event),
        type,
        severity: event.payload?.severity === 'critical' ? 'critical' : 'info',
        at: event.at,
        details: typeof event.payload?.details === 'string' ? event.payload.details : undefined,
      });
    }
  }

  private appendSecurityEventInMemory(event: Omit<SecurityEvent, 'id'>): SecurityEvent {
    const saved = { ...event, id: randomId('security') };
    this.state.securityEvents.push(saved);
    return saved;
  }

  async acknowledgeSyncEvents(
    sessionId: string,
    eventIds: string[],
    serverRevision: number,
    receiptAt = new Date().toISOString(),
  ): Promise<number> {
    let acknowledged = 0;
    const ids = new Set(eventIds);
    for (const event of this.state.syncEvents) {
      if (event.sessionId === sessionId && ids.has(event.id) && event.status === 'PENDING') {
        event.status = 'APPLIED';
        event.serverReceiptAt = receiptAt;
        acknowledged += 1;
      }
    }
    for (const attempt of this.state.attempts.filter((item) => item.sessionId === sessionId)) {
      attempt.serverRevision = Math.max(attempt.serverRevision, serverRevision);
      attempt.lastSyncedAt = receiptAt;
      attempt.synchronizationState = 'SYNCHRONIZED';
      if (attempt.status === 'RECOVERY_PENDING' || attempt.status === 'DEVICE_LOST')
        attempt.status = 'ACTIVE';
      if (attempt.recoveryStateId) {
        const recovery = this.state.recoveryStates.find(
          (item) => item.id === attempt.recoveryStateId,
        );
        if (recovery) {
          recovery.state = 'RECOVERED';
          recovery.updatedAt = receiptAt;
        }
      }
    }
    const session = this.state.sessions.find((item) => item.id === sessionId);
    if (session) {
      session.lastReplicationRevision = Math.max(session.lastReplicationRevision, serverRevision);
      session.synchronizationStatus = 'connected';
    }
    await this.save();
    return acknowledged;
  }

  async markDeviceDisconnected(
    deviceSessionId: string,
    reason = 'Student device disconnected.',
  ): Promise<void> {
    const device = this.state.deviceSessions.find((item) => item.id === deviceSessionId);
    if (device) {
      device.status = 'DISCONNECTED';
      device.lastHeartbeatAt = new Date().toISOString();
    }
    for (const attempt of this.state.attempts.filter(
      (item) =>
        item.deviceSessionId === deviceSessionId && ['ACTIVE', 'PAUSED'].includes(item.status),
    )) {
      attempt.status = 'DEVICE_LOST';
      attempt.synchronizationState = 'RECOVERY_PENDING';
      const now = new Date().toISOString();
      const recovery = {
        id: randomId('recovery'),
        sessionId: attempt.sessionId,
        attemptId: attempt.id,
        state: 'PENDING' as const,
        lastKnownRevision: attempt.serverRevision,
        localEncryptedStateAvailable: true,
        reason,
        createdAt: now,
        updatedAt: now,
      };
      this.state.recoveryStates.push(recovery);
      attempt.recoveryStateId = recovery.id;
      await this.logSecurityEvent({
        attemptId: attempt.id,
        sessionId: attempt.sessionId,
        studentId: attempt.studentId,
        deviceSessionId,
        type: 'DEVICE_DISCONNECT',
        severity: 'info',
        details: reason,
      });
    }
    await this.save();
  }

  async markSynchronizationUnavailable(
    sessionId: string,
    reason: string,
    pendingTooLong = false,
  ): Promise<void> {
    const session = this.state.sessions.find((item) => item.id === sessionId);
    if (session) {
      session.synchronizationStatus = pendingTooLong ? 'recovery' : 'degraded';
    }
    for (const attempt of this.state.attempts.filter(
      (item) => item.sessionId === sessionId && ['ACTIVE', 'PAUSED'].includes(item.status),
    )) {
      attempt.synchronizationState = pendingTooLong ? 'RECOVERY_PENDING' : 'DEGRADED';
      if (pendingTooLong) {
        attempt.status = 'RECOVERY_PENDING';
        const now = new Date().toISOString();
        const recovery = {
          id: randomId('recovery'),
          sessionId,
          attemptId: attempt.id,
          state: 'PENDING' as const,
          lastKnownRevision: attempt.serverRevision,
          localEncryptedStateAvailable: true,
          primaryServerId: session?.authoritativeServerId,
          reason,
          createdAt: now,
          updatedAt: now,
        };
        this.state.recoveryStates.push(recovery);
        attempt.recoveryStateId = recovery.id;
      }
    }
    await this.save();
    await this.logSecurityEvent({
      sessionId,
      type: 'SERVER_DISCONNECT',
      severity: pendingTooLong ? 'warning' : 'info',
      details: reason,
    });
  }

  async updateCurrentQuestion(attemptId: string, questionId: string): Promise<boolean> {
    const attempt = this.requireAttempt(attemptId);
    if (!attempt.questionOrder.includes(questionId))
      throw new Error('Question is not part of this attempt.');
    const previous = attempt.currentQuestionId;
    attempt.currentQuestionId = questionId;
    const persisted = await this.save();
    if (!persisted) {
      attempt.currentQuestionId = previous;
      throw new Error('Question position could not be persisted locally.');
    }
    return true;
  }

  async setSessionAuthority(
    sessionId: string,
    endpoint: string,
    accessToken: string,
    serverId: string,
    authorityEpoch: number,
  ): Promise<ExamSession> {
    const session = this.requireSession(sessionId);
    if (!endpoint || !accessToken) throw new Error('A LAN endpoint and access token are required.');
    session.authorityEndpoint = endpoint;
    session.authorityAccessToken = accessToken;
    session.authoritativeServerId = serverId;
    session.authorityEpoch = Math.max(session.authorityEpoch, authorityEpoch);
    session.synchronizationStatus = 'connected';
    await this.save();
    return session;
  }

  async heartbeatDeviceSession(deviceSessionId: string, sessionId?: string): Promise<string> {
    const device = this.state.deviceSessions.find(
      (item) => item.id === deviceSessionId || item.deviceId === deviceSessionId,
    );
    if (!device) throw new Error('Device session was not found.');
    if (sessionId && device.sessionId !== sessionId)
      throw new Error('Device session is not attached to this examination session.');
    if (device.status === 'DISCONNECTED') device.status = 'CONNECTED';
    const at = new Date().toISOString();
    device.lastHeartbeatAt = at;
    await this.save();
    return at;
  }

  async createDeviceSession(
    input: Omit<DeviceSession, 'id' | 'connectedAt' | 'lastHeartbeatAt' | 'status'> & {
      id?: string;
    },
  ): Promise<DeviceSession> {
    const now = new Date().toISOString();
    const { id: suppliedId, ...deviceInput } = input;
    const session: DeviceSession = {
      ...deviceInput,
      id: suppliedId || randomId('device_session'),
      connectedAt: now,
      lastHeartbeatAt: now,
      status: 'CONNECTED',
    };
    this.state.deviceSessions.push(session);
    if (input.role === 'STUDENT') {
      const student = this.state.students.find((item) => item.id === input.studentId);
      if (student && !student.activeDeviceSessionIds.includes(session.id))
        student.activeDeviceSessionIds.push(session.id);
    }
    if (input.sessionId) {
      const examSession = this.state.sessions.find((item) => item.id === input.sessionId);
      if (examSession)
        examSession.connectedDeviceIds = [
          ...new Set([...examSession.connectedDeviceIds, session.id]),
        ];
    }
    await this.save();
    return session;
  }

  async logSecurityEvent(event: Omit<SecurityEvent, 'id' | 'at'>): Promise<SecurityEvent> {
    const saved = { ...event, id: randomId('security'), at: new Date().toISOString() };
    this.state.securityEvents.push(saved);
    if (saved.attemptId) {
      const attempt = this.state.attempts.find((item) => item.id === saved.attemptId);
      const resultIndex = this.state.results.findIndex(
        (result) => result.attemptId === saved.attemptId,
      );
      if (attempt && resultIndex >= 0)
        this.state.results[resultIndex] = buildExaminationResult(
          this.state,
          attempt,
          this.state.results[resultIndex].submittedAt,
        );
    }
    await this.save();
    return saved;
  }

  async logAdminAction(action: Omit<AdminAction, 'id' | 'at'>): Promise<AdminAction> {
    const saved = { ...action, id: randomId('admin_action'), at: new Date().toISOString() };
    this.state.adminActions.push(saved);
    await this.save();
    return saved;
  }

  async createRecoveryState(
    input: Omit<RecoveryState, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<RecoveryState> {
    const now = new Date().toISOString();
    const recovery: RecoveryState = {
      ...input,
      id: randomId('recovery'),
      createdAt: now,
      updatedAt: now,
    };
    this.state.recoveryStates.push(recovery);
    await this.save();
    return recovery;
  }

  private requireAdminDevice(adminDeviceSessionId: string): void {
    const device = this.state.deviceSessions.find(
      (item) =>
        (item.id === adminDeviceSessionId || item.deviceId === adminDeviceSessionId) &&
        item.role === 'ADMIN' &&
        item.status === 'CONNECTED',
    );
    if (!device) throw new Error('Administrator device session is not authenticated or connected.');
  }

  private requireExam(id: string): Exam {
    const exam = this.state.exams.find((item) => item.id === id);
    if (!exam) throw new Error(`Examination ${id} was not found.`);
    return exam;
  }

  private requireVersion(examId: string, versionId?: string): ExamVersion {
    const exam = this.requireExam(examId);
    const id = versionId || exam.currentVersionId;
    const version = this.state.versions.find((item) => item.id === id && item.examId === examId);
    if (!version) throw new Error('The requested examination version was not found.');
    return version;
  }

  private requireSession(id: string): ExamSession {
    const session = this.state.sessions.find((item) => item.id === id);
    if (!session) throw new Error(`Examination session ${id} was not found.`);
    return session;
  }

  private requireAttempt(id: string): StudentAttempt {
    const attempt = this.state.attempts.find((item) => item.id === id);
    if (!attempt) throw new Error(`Attempt ${id} was not found.`);
    return attempt;
  }
}

export function defaultExamBuilderDraft(): ExamBuilderDraft {
  return {
    title: '',
    assessmentType: 'FORMAL_EXAM',
    instructions: '',
    questionIds: [],
    marksByQuestion: {},
    scoring: { ...DEFAULT_SCORING },
    availability: { ...DEFAULT_AVAILABILITY },
    security: { ...DEFAULT_SECURITY },
    navigation: {
      randomizeQuestions: false,
      randomizeOptions: false,
      allowPrevious: true,
      showQuestionNumbers: true,
    },
    maxAttempts: 1,
  };
}

export function questionPoolForBuilder(
  questions: ExamQuestion[],
  courseId?: string,
  topicId?: string,
  difficulty?: string,
): ExamQuestion[] {
  return questions.filter(
    (question) =>
      (!courseId || question.courseId === courseId) &&
      (!topicId || question.topicId === topicId) &&
      (!difficulty || difficulty === 'all' || question.difficulty === difficulty),
  );
}

export function buildExamPackageDraft(version: ExamVersion): Record<string, unknown> {
  return {
    examId: version.examId,
    examVersionId: version.id,
    title: version.title,
    assessmentType: version.assessmentType,
    questions: version.questions.map((question) => ({
      id: question.id,
      order: question.order,
      marks: question.marks,
    })),
    versionHash: version.versionHash,
    settings: canonicalJson(version.security),
  };
}

export { DEFAULT_AVAILABILITY, DEFAULT_SCORING, DEFAULT_SECURITY };

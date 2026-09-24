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
  emptyExaminationState,
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
  type ExaminationState,
  type RecoveryState,
  type SecurityEvent,
  type StudentAttempt,
} from './types';
import type { ExamQuestion } from '../types';

const DEFAULT_SECURITY: ExamSecuritySettings = {
  lockdown: false,
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
  policyVersion: 1,
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
  ): Promise<ExamSession> {
    const exam = this.requireExam(examId);
    const version = this.requireVersion(examId, versionId);
    if (!version.immutable)
      throw new Error('Only a validated published version can have an examination session.');
    const session: ExamSession = {
      id: randomId('session'),
      examId,
      examVersionId: version.id,
      status: 'CREATED',
      authoritativeServerId: serverId,
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
    if (!student || !(await verifyPassword(password, student.kioskPasswordVerifier)))
      throw new Error('First name, level, or RX30 Kiosk password is incorrect.');
    student.lastAuthenticatedAt = new Date().toISOString();
    await this.save();
    return student;
  }

  async createAttempt(
    sessionId: string,
    studentId: string,
    deviceSessionId: string,
  ): Promise<AttemptCreationResult> {
    const session = this.requireSession(sessionId);
    const version = this.requireVersion(session.examId, session.examVersionId);
    const existing = this.state.attempts.find(
      (attempt) =>
        attempt.sessionId === sessionId &&
        attempt.studentId === studentId &&
        ['READY', 'ACTIVE', 'PAUSED', 'RECOVERY_PENDING'].includes(attempt.status),
    );
    if (existing) {
      existing.deviceSessionId = deviceSessionId;
      existing.lastSyncedAt = new Date().toISOString();
      session.connectedDeviceIds = [...new Set([...session.connectedDeviceIds, deviceSessionId])];
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
    const attempt: StudentAttempt = {
      id: randomId('attempt'),
      sessionId,
      examId: session.examId,
      examVersionId: version.id,
      studentId,
      deviceSessionId,
      status: 'ACTIVE',
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(
        startedAt.getTime() + version.availability.durationMinutes * 60_000,
      ).toISOString(),
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
      localRevision: 0,
      serverRevision: 0,
    };
    this.state.attempts.push(attempt);
    session.studentAttemptIds.push(attempt.id);
    session.status = 'ACTIVE';
    session.connectedDeviceIds = [...new Set([...session.connectedDeviceIds, deviceSessionId])];
    await this.save();
    return { attempt, continued: false };
  }

  async recordAnswer(
    attemptId: string,
    answer: Omit<ExamAnswer, 'revision' | 'answeredAt'>,
  ): Promise<ExamAnswer> {
    const attempt = this.requireAttempt(attemptId);
    if (!['ACTIVE', 'PAUSED', 'RECOVERY_PENDING'].includes(attempt.status))
      throw new Error('This attempt no longer accepts answers.');
    const saved: ExamAnswer = {
      ...answer,
      answeredAt: new Date().toISOString(),
      revision: ++attempt.localRevision,
    };
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
    await this.save();
    return saved;
  }

  async submitAttempt(attemptId: string): Promise<StudentAttempt> {
    const attempt = this.requireAttempt(attemptId);
    if (attempt.status === 'SUBMITTED' || attempt.status === 'CLOSED') return attempt;
    attempt.status = 'SUBMITTED';
    attempt.submittedAt = new Date().toISOString();
    await this.save();
    return attempt;
  }

  async createDeviceSession(
    input: Omit<DeviceSession, 'id' | 'connectedAt' | 'lastHeartbeatAt' | 'status'>,
  ): Promise<DeviceSession> {
    const now = new Date().toISOString();
    const session: DeviceSession = {
      ...input,
      id: randomId('device_session'),
      connectedAt: now,
      lastHeartbeatAt: now,
      status: 'CONNECTED',
    };
    this.state.deviceSessions.push(session);
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

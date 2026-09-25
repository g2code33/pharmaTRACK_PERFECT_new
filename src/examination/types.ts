/**
 * PharmaTRACK Secure Examination Network — domain types.
 *
 * This namespace is deliberately separate from AppState. Practice Quiz and its
 * historical QuizHistory are existing academic data and remain backward
 * compatible; formal examinations get their own versioned, append-oriented
 * record set.
 */
import type { ExamQuestion, QuestionSourceRef } from '../types';

export const EXAMINATION_SCHEMA_VERSION = 1 as const;
export const EXAM_PACKAGE_FORMAT_VERSION = 1 as const;

export type KioskPlatform = 'PC_WEB' | 'ANDROID_WEB' | 'TAURI_PC' | 'ANDROID_NATIVE' | 'UNKNOWN';
export type ViolationPolicy =
  | 'LOG_ONLY'
  | 'WARNING'
  | 'LOCK_TEMPORARILY'
  | 'REQUIRE_ADMIN_UNLOCK'
  | 'TERMINATE_ATTEMPT'
  | 'FORCE_SUBMIT';
export type SecurityViolation =
  | 'FOCUS_LOST'
  | 'ATTEMPTED_EXIT'
  | 'ATTEMPTED_NAVIGATION'
  | 'ATTEMPTED_PRINT'
  | 'ATTEMPTED_COPY_PASTE'
  | 'EXTERNAL_LINK_ATTEMPT'
  | 'DEVELOPER_TOOL_ATTEMPT'
  | 'SUSPICIOUS_STATE_TRANSITION'
  | 'NETWORK_LOSS'
  | 'DEVICE_DISCONNECT'
  | 'SERVER_DISCONNECT'
  | 'RECOVERY'
  | 'ADMIN_INTERVENTION';

export interface PlatformCapability {
  id: string;
  label: string;
  supported: boolean;
  enforceable: boolean;
  detected: boolean;
  required: boolean;
  notes: string;
}

export interface PlatformCapabilityMatrix {
  platform: KioskPlatform;
  generatedAt: string;
  capabilities: PlatformCapability[];
}

export interface AttemptTimerState {
  originalDurationMinutes: number;
  authoritativeStartedAt: string;
  authoritativeDeadlineAt: string;
  lastAuthorityAt: string;
  authorityEpoch: number;
  pausedAt?: string;
  accumulatedPauseMilliseconds: number;
  adjustments: TimerAdjustment[];
}

export interface TimerAdjustment {
  id: string;
  minutes: number;
  at: string;
  adminId: string;
  reason: string;
  previousDeadlineAt: string;
  newDeadlineAt: string;
}

export interface ViolationPolicyMap {
  [violation: string]: ViolationPolicy;
}

export type AssessmentType = 'PRACTICE_QUIZ' | 'NORMAL_ASSESSMENT' | 'FORMAL_EXAM' | 'KIOSK_EXAM';

export type ExamLifecycle =
  | 'DRAFT'
  | 'VALIDATED'
  | 'PUBLISHED'
  | 'SCHEDULED'
  | 'ACTIVE'
  | 'SUBMITTED'
  | 'CLOSED'
  | 'ARCHIVED';

export type AttemptStatus =
  | 'READY'
  | 'ACTIVE'
  | 'PAUSED'
  | 'SUBMITTED'
  | 'CLOSED'
  | 'DEVICE_LOST'
  | 'RECOVERY_PENDING'
  | 'LOCKED';

export type SessionStatus = 'CREATED' | 'READY' | 'ACTIVE' | 'CLOSING' | 'CLOSED' | 'RECOVERY';

export type SecurityEventType =
  | 'PACKAGE_OPENED'
  | 'PACKAGE_REJECTED'
  | 'SESSION_CREATED'
  | 'IDENTITY_REGISTERED'
  | 'IDENTITY_AUTHENTICATED'
  | 'IDENTITY_REJECTED'
  | 'READINESS_PASSED'
  | 'READINESS_FAILED'
  | 'ATTEMPT_STARTED'
  | 'ANSWER_RECORDED'
  | 'NAVIGATION_BLOCKED'
  | 'FOCUS_LOST'
  | 'DISCONNECTED'
  | 'RECONNECTED'
  | 'RECOVERY_STARTED'
  | 'RECOVERY_COMPLETED'
  | 'SUBMITTED'
  | 'FAILOVER_REQUESTED'
  | 'FAILOVER_COMPLETED'
  | 'FOCUS_RESTORED'
  | 'ATTEMPTED_EXIT'
  | 'ATTEMPTED_NAVIGATION'
  | 'ATTEMPTED_PRINT'
  | 'ATTEMPTED_COPY_PASTE'
  | 'EXTERNAL_LINK_ATTEMPT'
  | 'DEVELOPER_TOOL_ATTEMPT'
  | 'SUSPICIOUS_STATE_TRANSITION'
  | 'NETWORK_LOSS'
  | 'DEVICE_DISCONNECT'
  | 'SERVER_DISCONNECT'
  | 'ADMIN_INTERVENTION'
  | 'ANSWER_PERSISTED'
  | 'ANSWER_PERSISTENCE_FAILED'
  | 'SYNC_RECONCILED'
  | 'SYNC_REJECTED'
  | 'DEVICE_SWITCH'
  | 'TIMER_PAUSED'
  | 'TIMER_RESUMED'
  | 'TIMER_ADJUSTED'
  | 'FORCE_SUBMITTED'
  | 'ATTEMPT_TERMINATED';

export type SecuritySeverity = 'info' | 'warning' | 'critical';

export interface ExamSecuritySettings {
  lockdown: boolean;
  capabilityFailurePolicy?: 'PREVENT_START' | 'ALLOW_WITH_WARNING' | 'REQUIRE_ADMIN_APPROVAL';
  kioskMode: boolean;
  allowBackNavigation: boolean;
  allowQuestionNavigation: boolean;
  allowReviewBeforeSubmit: boolean;
  allowCalculator: boolean;
  allowPause: boolean;
  requireExamPassword: boolean;
  requireLanAuthority: boolean;
  detectFocusLoss: boolean;
  maxFocusLosses?: number;
  /** Browser-enforced and native-adapter restrictions are explicit policy, not a guarantee. */
  disableNavigation?: boolean;
  disableCopyPaste?: boolean;
  disablePrinting?: boolean;
  disableExternalLinks?: boolean;
  disableDeveloperTools?: boolean;
  restrictWindowControls?: boolean;
  restrictScreenCapture?: boolean;
  restrictExit?: boolean;
  requiredCapabilities?: string[];
  violationPolicies?: ViolationPolicyMap;
  /** Security policy version is captured with every attempt. */
  policyVersion: number;
}

export interface ExamAvailability {
  opensAt?: string;
  closesAt?: string;
  durationMinutes: number;
  timezone?: string;
}

export interface ExamScoringSettings {
  passMark: number;
  negativeMarking: boolean;
  negativeMarkValue: number;
  defaultMarks: number;
}

export interface ExamNavigationSettings {
  randomizeQuestions: boolean;
  randomizeOptions: boolean;
  seed?: string;
  allowPrevious: boolean;
  showQuestionNumbers: boolean;
}

/** A frozen copy of a Question Bank entry used by one immutable exam version. */
export interface ExamQuestionSnapshot {
  id: string;
  sourceQuestionId: string;
  order: number;
  courseId: string;
  topicId: string;
  semester?: string;
  questionText: string;
  questionType: ExamQuestion['questionType'];
  marks: number;
  difficulty: ExamQuestion['difficulty'];
  options?: string[];
  correctOption?: number;
  correctAnswer?: string;
  explanation?: string;
  modelAnswer?: string;
  tags: string[];
  source?: QuestionSourceRef;
}

export interface ExamVersion {
  id: string;
  examId: string;
  version: number;
  versionHash: string;
  createdAt: string;
  publishedAt?: string;
  immutable: boolean;
  title: string;
  instructions: string;
  assessmentType: AssessmentType;
  courseId?: string;
  topicId?: string;
  academicYear?: string;
  semester?: string;
  questions: ExamQuestionSnapshot[];
  scoring: ExamScoringSettings;
  availability: ExamAvailability;
  security: ExamSecuritySettings;
  navigation: ExamNavigationSettings;
  maxAttempts: number;
  packageId?: string;
}

export interface Exam {
  id: string;
  title: string;
  lifecycle: ExamLifecycle;
  createdAt: string;
  updatedAt: string;
  currentVersionId?: string;
  versionIds: string[];
  ownerDeviceId: string;
  /** Published versions are never edited; new edits create a new version. */
  publishedVersionIds: string[];
  archivedAt?: string;
}

export interface ExamStudent {
  id: string;
  firstName: string;
  level: string;
  kioskPasswordVerifier: PasswordVerifier;
  registeredAt: string;
  lastAuthenticatedAt?: string;
  activeDeviceSessionIds: string[];
}

export interface PasswordVerifier {
  algorithm: 'PBKDF2-SHA-256';
  iterations: number;
  salt: string;
  verifier: string;
}

export interface ExamSession {
  id: string;
  examId: string;
  examVersionId: string;
  status: SessionStatus;
  authoritativeServerId: string;
  authorityEndpoint?: string;
  /** Encrypted with the examination state; never placed in normal Quiz data. */
  authorityAccessToken?: string;
  authorityEpoch: number;
  createdAt: string;
  scheduledStartAt?: string;
  startedAt?: string;
  endedAt?: string;
  connectedDeviceIds: string[];
  studentAttemptIds: string[];
  lastReplicationRevision: number;
  synchronizationStatus: 'local' | 'connected' | 'degraded' | 'recovery';
}

export interface StudentAttempt {
  id: string;
  sessionId: string;
  examId: string;
  examVersionId: string;
  studentId: string;
  deviceSessionId: string;
  status: AttemptStatus;
  startedAt: string;
  submittedAt?: string;
  /** Timer is attempt-owned and survives device changes. */
  deadlineAt: string;
  timerState?: AttemptTimerState;
  currentQuestionId?: string;
  questionOrder: string[];
  optionOrders: Record<string, number[]>;
  randomizationSeed?: string;
  settingsSnapshot: {
    scoring: ExamScoringSettings;
    availability: ExamAvailability;
    security: ExamSecuritySettings;
    navigation: ExamNavigationSettings;
  };
  answers: ExamAnswer[];
  focusLosses: number;
  securityState?: 'NORMAL' | 'WARNING' | 'LOCKED' | 'ADMIN_REVIEW';
  synchronizationState?:
    'LOCAL_ONLY' | 'SYNCING' | 'SYNCHRONIZED' | 'DEGRADED' | 'RECOVERY_PENDING';
  saveStatus?: 'SAVED' | 'SAVING' | 'SAVE_PROBLEM';
  submissionState?: 'NOT_SUBMITTED' | 'SUBMITTED' | 'FORCE_SUBMITTED' | 'TERMINATED';
  ownershipGeneration?: number;
  lastSyncedAt?: string;
  localRevision: number;
  serverRevision: number;
  recoveryStateId?: string;
}

export interface ExamAnswer {
  questionId: string;
  answer: string;
  selectedOption?: number;
  answeredAt: string;
  revision: number;
  eventId?: string;
  deviceSessionId: string;
  isFinal: boolean;
  serverReceiptAt?: string;
  serverRevision?: number;
}

export interface SecurityEvent {
  id: string;
  sessionId?: string;
  attemptId?: string;
  studentId?: string;
  deviceSessionId?: string;
  type: SecurityEventType;
  severity: SecuritySeverity;
  at: string;
  details?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ExamQuestionResult {
  questionId: string;
  sourceQuestionId: string;
  answer: string;
  isCorrect: boolean;
  marksAwarded: number;
  maxMarks: number;
}

export interface ExaminationResult {
  id: string;
  examId: string;
  examVersionId: string;
  attemptId: string;
  studentId: string;
  assessmentType: 'KIOSK_EXAM';
  score: number;
  percentage: number;
  maxMarks: number;
  durationSeconds: number;
  submittedAt: string;
  answerStatistics: { answered: number; unanswered: number; correct: number; incorrect: number };
  questionResults: ExamQuestionResult[];
  securityEventSummary: Record<string, number>;
  deviceHistory: string[];
  recoveryHistory: string[];
  administratorInterventions: string[];
  quizHistoryId?: string;
}

export interface AdminAction {
  id: string;
  sessionId?: string;
  adminId: string;
  adminDeviceSessionId: string;
  action:
    | 'CREATE'
    | 'VALIDATE'
    | 'PUBLISH'
    | 'SCHEDULE'
    | 'START'
    | 'PAUSE'
    | 'RESUME'
    | 'CLOSE'
    | 'ADD_TIME'
    | 'REMOVE_TIME'
    | 'FORCE_SUBMIT'
    | 'TERMINATE'
    | 'UNLOCK'
    | 'REOPEN'
    | 'FAILOVER'
    | 'RECOVER'
    | 'EXPORT';
  at: string;
  targetId?: string;
  targetStudentId?: string;
  reason?: string;
  previousState?: string;
  newState?: string;
  timeAdjustmentMinutes?: number;
}

export interface DeviceSession {
  id: string;
  deviceId: string;
  role: 'STUDENT' | 'ADMIN' | 'PRIMARY_SERVER' | 'SECONDARY_SERVER';
  label?: string;
  sessionId?: string;
  studentId?: string;
  connectedAt: string;
  lastHeartbeatAt: string;
  status: 'CONNECTED' | 'DISCONNECTED' | 'RECOVERY_PENDING';
  capabilities: string[];
}

export interface SyncEvent {
  id: string;
  sessionId: string;
  entity: 'SESSION' | 'ATTEMPT' | 'ANSWER' | 'SECURITY_EVENT' | 'ADMIN_ACTION' | 'RECOVERY';
  entityId: string;
  sourceServerId: string;
  authorityEpoch: number;
  revision: number;
  at: string;
  direction: 'LOCAL_TO_SERVER' | 'SERVER_TO_LOCAL' | 'SERVER_TO_SERVER';
  status: 'PENDING' | 'APPLIED' | 'CONFLICT' | 'REJECTED';
  eventId?: string;
  questionId?: string;
  answerRevision?: number;
  serverReceiptAt?: string;
  payload?: Record<string, unknown>;
}

export interface RecoveryState {
  id: string;
  sessionId: string;
  attemptId?: string;
  state: 'NONE' | 'PENDING' | 'RECONNECTING' | 'RECONCILING' | 'RECOVERED' | 'MANUAL_REVIEW';
  lastKnownRevision: number;
  localEncryptedStateAvailable: boolean;
  primaryServerId?: string;
  secondaryServerId?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExamAuthorityRecord {
  authorityId: string;
  serverId: string;
  label: string;
  role: 'PRIMARY' | 'SECONDARY';
  endpoint: string;
  status: 'PRIMARY' | 'SECONDARY' | 'STANDBY' | 'FAILOVER' | 'LOCKED';
  epoch: number;
  revision: number;
  lastHeartbeatAt: string;
  lastKnownGoodAt?: string;
}

export interface ExamAuthorityLeaseRecord {
  authorityId: string;
  serverId: string;
  epoch: number;
  leaseId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface ExamReplicationSnapshot {
  id: string;
  authorityId: string;
  serverId: string;
  authorityEpoch: number;
  revision: number;
  createdAt: string;
  sessionIds: string[];
  attemptIds: string[];
  pendingEventIds: string[];
  checksum: string;
}

export interface ExaminationState {
  schemaVersion: typeof EXAMINATION_SCHEMA_VERSION;
  exams: Exam[];
  versions: ExamVersion[];
  sessions: ExamSession[];
  students: ExamStudent[];
  attempts: StudentAttempt[];
  answers: ExamAnswer[];
  securityEvents: SecurityEvent[];
  adminActions: AdminAction[];
  deviceSessions: DeviceSession[];
  syncEvents: SyncEvent[];
  recoveryStates: RecoveryState[];
  results: ExaminationResult[];
  authorities: ExamAuthorityRecord[];
  authorityLeases: ExamAuthorityLeaseRecord[];
  replicationSnapshots: ExamReplicationSnapshot[];
  importedPackageKeys: string[];
}

export interface ExamBuilderDraft {
  title: string;
  assessmentType: AssessmentType;
  courseId?: string;
  topicId?: string;
  academicYear?: string;
  semester?: string;
  instructions: string;
  questionIds: string[];
  marksByQuestion: Record<string, number>;
  scoring: ExamScoringSettings;
  availability: ExamAvailability;
  security: ExamSecuritySettings;
  navigation: ExamNavigationSettings;
  maxAttempts: number;
}

export function snapshotQuestion(
  question: ExamQuestion,
  order: number,
  marks = question.marksAllocation || 1,
): ExamQuestionSnapshot {
  return {
    id: `${question.id}:v${Date.now()}:${order}`,
    sourceQuestionId: question.id,
    order,
    courseId: question.courseId,
    topicId: question.topicId,
    semester: question.semester,
    questionText: question.questionText,
    questionType: question.questionType,
    marks,
    difficulty: question.difficulty,
    options: question.options ? [...question.options] : undefined,
    correctOption: question.correctOption,
    correctAnswer: question.correctAnswer,
    explanation: question.explanation,
    modelAnswer: question.modelAnswer,
    tags: [...(question.tags || [])],
    source: question.source ? { ...question.source } : undefined,
  };
}

export function emptyExaminationState(): ExaminationState {
  return {
    schemaVersion: EXAMINATION_SCHEMA_VERSION,
    exams: [],
    versions: [],
    sessions: [],
    students: [],
    attempts: [],
    answers: [],
    securityEvents: [],
    adminActions: [],
    deviceSessions: [],
    syncEvents: [],
    recoveryStates: [],
    results: [],
    authorities: [],
    authorityLeases: [],
    replicationSnapshots: [],
    importedPackageKeys: [],
  };
}

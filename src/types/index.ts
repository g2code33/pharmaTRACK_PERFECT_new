// PharmTrack - Type Definitions

export interface Student {
  id: string;
  name: string;
  university: string;
  level: string;
  program: string;
  semester: string;
  createdAt: string;
  avatar_url?: string;
}

export interface Course {
  id: string;
  studentId: string;
  courseCode: string;
  courseName: string;
  lecturerName: string;
  semester: string;
  creditHours: number;
  createdAt: string;
  avatar_url?: string;
}

export interface Topic {
  id: string;
  courseId: string;
  topicName: string;
  orderIndex: number;
  createdAt: string;
  avatar_url?: string;
}

export interface Slide {
  id: string;
  topicId: string;
  slideNumber: number;
  title: string;
  contentText: string;
  fileUrl?: string;
  fileType?: 'pdf' | 'jpg' | 'png' | 'text';
  status: 'not_started' | 'in_progress' | 'completed';
  createdAt: string;
  avatar_url?: string;
  /**
   * Real file kind. `fileType` stays the old union so existing readers and
   * archives keep working. Presentations used to be stored as `text` with the
   * extension removed from the title.
   */
  materialKind?: 'pdf' | 'pptx' | 'ppt' | 'docx' | 'image' | 'text' | 'unknown';
  /** Original filename, including the extension the title no longer has. */
  originalName?: string;
  fileSize?: number;
  pageCount?: number;
  ocrStatus?: 'not_needed' | 'done' | 'skipped' | 'failed' | 'unknown';
  /** Set when a presentation could not be drawn. The original file is kept. */
  visualStatus?: 'ok' | 'failed' | 'unknown';
  favorite?: boolean;
  tags?: string[];
  lastOpenedAt?: string;
  /** 1-based page or slide the student last had on screen. */
  lastPosition?: number;
}

export interface LearningObjective {
  id: string;
  courseId: string;
  topicId?: string;
  objectiveText: string;
  status: 'not_covered' | 'partial' | 'mastered';
  createdAt: string;
  avatar_url?: string;
}

export interface ExamQuestion {
  id: string;
  courseId: string;
  topicId: string;
  questionText: string;
  questionType: 'short_answer' | 'structured' | 'essay' | 'mcq' | 'case_study';
  marksAllocation: number;
  difficulty: 'easy' | 'medium' | 'hard';
  probability: 'high' | 'medium' | 'low';
  modelAnswer: string;
  tags: string[];
  isPracticed: boolean;
  needsReview: boolean;
  isSaved: boolean;
  createdAt: string;
  avatar_url?: string;
  // For MCQ
  options?: string[];
  correctOption?: number;
}

export interface QuizHistory {
  id: string;
  studentId: string;
  courseId: string;
  questionsUsed: string[];
  answersGiven: { questionId: string; answer: string; isCorrect: boolean }[];
  scorePercentage: number;
  weakTopics: string[];
  timeTaken: number;
  completedAt: string;
}

export interface StudyPlan {
  id: string;
  studentId: string;
  date: string;
  timeSlot: string;
  courseId: string;
  activityType: 'study' | 'quiz' | 'revision' | 'upload';
  notes: string;
  isCompleted: boolean;
}

export interface Note {
  id: string;
  topicId: string;
  noteText: string;
  isAiGenerated: boolean;
  createdAt: string;
  avatar_url?: string;
  attachedFiles?: { id: string; name: string; type: string; data: string }[];
}

export interface ExamDate {
  id: string;
  courseId: string;
  examDate: string;
  examType: 'midsem' | 'endsem' | 'practical';
  isReminderSet: boolean;
}

export interface Activity {
  id: string;
  type: 'slide_completed' | 'quiz_taken' | 'questions_generated' | 'course_added' | 'objective_mastered';
  description: string;
  timestamp: string;
  courseId?: string;
  topicId?: string;
}

// Store state
export interface ChatMessageStore {
  id: string;
  topicId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

/**
 * A rectangle on a page, stored as fractions (0-1) of page width/height rather
 * than pixels. Zoom, rotation and window size all change the pixel geometry,
 * so absolute coordinates would drift; fractions stay correct at any scale.
 */
export interface HighlightRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Highlight {
  id: string;
  topicId: string;
  /** Index of the material within the topic. */
  slideIndex: number;
  text: string;
  color: string;
  timestamp: string;
  /** Material (Slide) this belongs to; lets us jump straight back to it. */
  materialId?: string;
  /** 1-based page within that material. */
  page?: number;
  /** Geometry for re-drawing the highlight over the page. */
  rects?: HighlightRect[];
  /** Optional user annotation attached to the highlight. */
  note?: string;
}

export interface SavedInsight {
  id: string;
  topicId: string;
  type: 'user' | 'ai';
  content: string;
  timestamp: string;
}

export interface AppState {
  isLoggedIn: boolean;
  student: Student | null;
  courses: Course[];
  topics: Topic[];
  slides: Slide[];
  learningObjectives: LearningObjective[];
  examQuestions: ExamQuestion[];
  quizHistory: QuizHistory[];
  studyPlans: StudyPlan[];
  notes: Note[];
  examDates: ExamDate[];
  activities: Activity[];
  chatHistory: ChatMessageStore[];
  highlights: Highlight[];
  savedInsights: SavedInsight[];
  openAIKey: string;
  timetables: { class: TimetableItem[]; quiz: TimetableItem[]; exam: TimetableItem[]; };
  timetablePdf: string | null;
}

export type TimetableItem = {
  id: string;
  subject: string;
  date: string;
  time: string;
  location: string;
  type: 'class' | 'quiz' | 'exam';
};

// ---------------------------------------------------------------------------
// Semester archives & portable backups
//
// A completed semester becomes an independent academic workspace: the whole
// live state (AppState collections) is snapshotted, every binary the semester
// references (uploaded PDFs/PPTX/images and offloaded slide text) is COPIED
// into the archive namespace in IndexedDB, the archive is verified, and only
// then is the live workspace reset. Archives never share records with the
// live workspace, so resetting the current semester cannot touch them.
// ---------------------------------------------------------------------------

export interface SemesterArchiveCounts {
  courses: number;
  topics: number;
  slides: number;
  notes: number;
  questions: number;
  quizzes: number;
}

export interface SemesterArchiveMeta {
  id: string;
  /** Normalised level, e.g. "300". */
  level: string;
  /** Normalised semester number, e.g. "1" | "2". */
  semester: string;
  /** Human title, e.g. "Level 300 — Semester 1". */
  title: string;
  academicYear?: string;
  completedAt: string;
  createdAt: string;
  status: 'creating' | 'verified' | 'failed';
  /** Archive record format version (independent of backupVersion). */
  version: number;
  /** Total records captured across all collections. */
  itemCount: number;
  /** Number of binary/text records copied into the archive. */
  fileCount: number;
  totalBytes: number;
  checksum?: string;
  counts?: SemesterArchiveCounts;
  /** Set when status === 'failed'. */
  error?: string;
}

/**
 * The complete snapshot of a semester workspace. Everything that makes the
 * semester restorable: identity at the time of completion plus every
 * semester-specific collection.
 */
export interface SemesterSnapshot {
  student: Student;
  courses: Course[];
  topics: Topic[];
  slides: Slide[];
  learningObjectives: LearningObjective[];
  examQuestions: ExamQuestion[];
  quizHistory: QuizHistory[];
  studyPlans: StudyPlan[];
  notes: Note[];
  examDates: ExamDate[];
  activities: Activity[];
  chatHistory: ChatMessageStore[];
  highlights: Highlight[];
  savedInsights: SavedInsight[];
  timetables: AppState['timetables'];
  timetablePdf: string | null;
  capturedAt: string;
  /**
   * Any AppState field this build does not name explicitly. The archiver copies
   * every semester field automatically, so a collection added later is still
   * inside the snapshot (and `semester/workspace.json` in a portable backup).
   */
  [extra: string]: unknown;
}

export interface BackupManifestFile {
  /** Zip entry name, e.g. "files/<fileId>" or "slideText/<slideId>.txt". */
  name: string;
  size: number;
  type: string;
}

export interface BackupManifest {
  app: 'pharmatrack';
  format: 'semester-backup';
  /** Portable backup format version. Import supports a fixed list of versions. */
  backupVersion: number;
  created: string;
  source: 'archive' | 'live';
  archiveId?: string;
  title: string;
  level: string;
  semester: string;
  academicYear?: string;
  completedAt?: string;
  /** Integrity checksum over the manifest's declared file list. */
  checksum: string;
  itemCount: number;
  fileCount: number;
  totalBytes: number;
  counts?: SemesterArchiveCounts;
  files: BackupManifestFile[];
}

/** A parsed, integrity-checked backup that has NOT been applied yet. */
export interface StagedBackup {
  /** New-version manifest, or the legacy one when importing an old export. */
  manifest: PharmaTrackBackupManifest | BackupManifest;
  snapshot: SemesterSnapshot;
  /** Per-page full-text search index captured with the semester, if any. */
  index: Record<string, { materialId: string; topicId: string; title: string; pages: { page: number; text: string }[] }> | null;
  /**
   * key = fileId (kind 'file'), slideId (kind 'slidetext'), or the original
   * IndexedDB key (kind 'record' — AI conversations and any future store).
   */
  files: Map<string, { value: Blob | string | unknown; kind: 'file' | 'slidetext' | 'record' }>;
}

/**
 * Portable backup manifest — the `pharmatrack-semester-backup` format.
 *
 * Versioned from day one: `formatVersion` is what import uses to decide
 * whether a backup can be read, and unknown future versions fail safely
 * (never partial-imported). Migration handlers for old versions live in
 * `src/utils/semesterArchive.ts` (`SEMESTER_FORMAT_MIGRATORS`).
 */
export interface PharmaTrackBackupManifest {
  app: 'pharmatrack';
  format: 'pharmatrack-semester-backup' | 'pharmatrack-degree-backup';
  formatVersion: number;
  appVersion: string;
  /** Present when the backup was made from a local archive. */
  archiveId?: string;
  academicYear?: string;
  level?: string;
  semester?: string;
  title: string;
  createdAt: string;
  completedAt?: string;
  source: 'archive' | 'live';
  recordCounts?: {
    courses: number;
    topics: number;
    slides: number;
    notes: number;
    questions: number;
    quizzes: number;
    studyPlans: number;
    examDates: number;
    activities: number;
    /** Slides that reference an uploaded binary. */
    materials: number;
    /** Total packaged files (binaries + offloaded slide text). */
    files: number;
  };
  totalBytes: number;
  integrity: {
    algorithm: string;
    /** Checksum over every packaged entry (name + size + content hash). */
    checksum: string;
    /** Checksum over the manifest itself (defense in depth, optional). */
    manifestChecksum?: string;
  };
  /** Degree backups: the per-semester packages inside this bundle. */
  semesters?: { name: string; title: string; archiveId?: string; size: number }[];
}

/** Normalised, format-agnostic view of a staged backup (for UI display). */
export interface BackupSummary {
  title: string;
  level?: string;
  semester?: string;
  academicYear?: string;
  completedAt?: string;
  createdAt: string;
  source: 'archive' | 'live';
  /** e.g. "v1" — the backup format version the UI can show the user. */
  versionLabel: string;
  archiveId?: string;
  counts: {
    courses: number;
    topics: number;
    slides: number;
    notes: number;
    questions: number;
    quizzes: number;
    studyPlans: number;
    examDates: number;
    activities: number;
    files: number;
  };
  totalBytes: number;
  /** Human-readable integrity algorithm, when the backup carries one. */
  integrityAlgorithm?: string;
  /** True when the checksum was recomputed and matched during validation. */
  integrityVerified: boolean;
}

/** A degree bundle: many semester packages in one file. */
export interface StagedDegreeBackup {
  title: string;
  totalBytes: number;
  semesters: StagedBackup[];
}

/** Detailed check log attached to a failed import (for diagnostics). */
export interface ImportDiagnostic {
  check: string;
  ok: boolean;
  detail?: string;
}


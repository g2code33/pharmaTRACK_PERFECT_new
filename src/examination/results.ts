import type { QuizHistory } from '../types';
import type {
  ExaminationState,
  ExaminationResult,
  ExamQuestionSnapshot,
  ExamVersion,
  StudentAttempt,
} from './types';

function isCorrect(question: ExamQuestionSnapshot, answer: string): boolean {
  if (!answer.trim()) return false;
  if (question.questionType === 'mcq') return Number(answer) === question.correctOption;
  return question.correctAnswer
    ? answer.trim().toLowerCase() === question.correctAnswer.trim().toLowerCase()
    : true;
}

export function buildExaminationResult(
  state: ExaminationState,
  attempt: StudentAttempt,
  submittedAt = attempt.submittedAt || new Date().toISOString(),
): ExaminationResult {
  const version = state.versions.find((item) => item.id === attempt.examVersionId);
  if (!version) throw new Error('The immutable examination version is unavailable for results.');
  const answers = new Map(attempt.answers.map((answer) => [answer.questionId, answer]));
  const questionResults = version.questions.map((question) => {
    const answer = answers.get(question.id)?.answer || '';
    const correct = isCorrect(question, answer);
    const marksAwarded = correct
      ? question.marks
      : answer.trim() && version.scoring.negativeMarking
        ? -version.scoring.negativeMarkValue
        : 0;
    return {
      questionId: question.id,
      sourceQuestionId: question.sourceQuestionId,
      answer,
      isCorrect: correct,
      marksAwarded,
      maxMarks: question.marks,
    };
  });
  const maxMarks = questionResults.reduce((sum, item) => sum + item.maxMarks, 0);
  const score = Math.max(
    0,
    questionResults.reduce((sum, item) => sum + item.marksAwarded, 0),
  );
  const securityEvents = state.securityEvents.filter((event) => event.attemptId === attempt.id);
  const securityEventSummary: Record<string, number> = {};
  for (const event of securityEvents)
    securityEventSummary[event.type] = (securityEventSummary[event.type] || 0) + 1;
  const adminActions = state.adminActions.filter((action) => action.targetId === attempt.id);
  const durationSeconds = Math.max(
    0,
    Math.round((new Date(submittedAt).getTime() - new Date(attempt.startedAt).getTime()) / 1000),
  );
  return {
    id: `result:${attempt.id}`,
    examId: attempt.examId,
    examVersionId: attempt.examVersionId,
    attemptId: attempt.id,
    studentId: attempt.studentId,
    assessmentType: 'KIOSK_EXAM',
    score,
    percentage: maxMarks ? Math.round((score / maxMarks) * 10000) / 100 : 0,
    maxMarks,
    durationSeconds,
    submittedAt,
    answerStatistics: {
      answered: questionResults.filter((item) => item.answer.trim()).length,
      unanswered: questionResults.filter((item) => !item.answer.trim()).length,
      correct: questionResults.filter((item) => item.isCorrect).length,
      incorrect: questionResults.filter((item) => item.answer.trim() && !item.isCorrect).length,
    },
    questionResults,
    securityEventSummary,
    deviceHistory: [
      ...new Set(
        state.deviceSessions
          .filter((device) => device.sessionId === attempt.sessionId)
          .map((device) => device.id),
      ),
    ],
    recoveryHistory: state.recoveryStates
      .filter((recovery) => recovery.attemptId === attempt.id)
      .map((recovery) => recovery.id),
    administratorInterventions: adminActions.map((action) => action.id),
  };
}

export function examinationResultToQuizHistory(
  result: ExaminationResult,
  version: ExamVersion,
): QuizHistory {
  return {
    id: `quiz-history:${result.id}`,
    studentId: result.studentId,
    courseId: version.courseId || '',
    topicId: version.topicId,
    questionsUsed: result.questionResults.map((question) => question.sourceQuestionId),
    answersGiven: result.questionResults.map((question) => ({
      questionId: question.sourceQuestionId,
      answer: question.answer,
      isCorrect: question.isCorrect,
    })),
    scorePercentage: result.percentage,
    weakTopics: version.questions
      .filter((question) =>
        result.questionResults.find((item) => item.questionId === question.id && !item.isCorrect),
      )
      .map((question) => question.topicId),
    timeTaken: result.durationSeconds,
    completedAt: result.submittedAt,
    mode: 'kiosk_exam',
    examinationResultId: result.id,
    examinationVersionId: result.examVersionId,
  };
}

/**
 * Minimal surface a backfill function needs from a repository — just enough
 * to avoid importing the whole `ExaminationRepository` class into every
 * caller and to make this trivially testable.
 */
export interface VisibleResultSource {
  snapshot: Pick<ExaminationState, 'attempts' | 'versions'>;
  getStudentVisibleResult(attemptId: string, studentId?: string): { visible: boolean };
  getExaminationResult(attemptId: string): ExaminationResult | undefined;
}

/**
 * Catches a student's Quiz History up with every kiosk exam result that has
 * become visible to them since the last time it was checked.
 *
 * A result can finish an exam but stay hidden for a while on purpose (the
 * "release results only when the administrator says so" policy) — the
 * attempt page only tries to record the result ONCE, at the moment of
 * submission, so if it was not visible yet at that exact instant it would
 * otherwise never make it into Quiz History at all, even after the
 * administrator releases it. Logging back in (the one moment the app knows
 * for certain which student is sitting at the device) is the natural place
 * to re-check every one of that student's submitted attempts and backfill
 * anything newly visible.
 */
export function findNewlyVisibleKioskResults(
  repository: VisibleResultSource,
  studentId: string,
  alreadyRecordedResultIds: ReadonlySet<string>,
): QuizHistory[] {
  const additions: QuizHistory[] = [];
  const attempts = repository.snapshot.attempts.filter((attempt) => attempt.studentId === studentId);
  for (const attempt of attempts) {
    let visibility: { visible: boolean };
    try {
      visibility = repository.getStudentVisibleResult(attempt.id, studentId);
    } catch {
      continue;
    }
    if (!visibility.visible) continue;
    const result = repository.getExaminationResult(attempt.id);
    if (!result || alreadyRecordedResultIds.has(result.id)) continue;
    const version = repository.snapshot.versions.find((item) => item.id === attempt.examVersionId);
    if (!version) continue;
    additions.push(examinationResultToQuizHistory(result, version));
  }
  return additions;
}


import { describe, expect, it } from 'vitest';
import { emptyExaminationState } from '../examination/types';
import { reviewExaminationSecurity } from '../examination/securityReview';

describe('final examination security review', () => {
  it('passes clean encrypted-domain state and detects duplicate active attempts', () => {
    const state = emptyExaminationState();
    expect(reviewExaminationSecurity(state).passed).toBe(true);
    state.attempts.push({
      id: 'a1',
      sessionId: 's',
      examId: 'e',
      examVersionId: 'v',
      studentId: 'student',
      deviceSessionId: 'd1',
      status: 'ACTIVE',
      settingsSnapshot: {
        scoring: { passMark: 50, negativeMarking: false, negativeMarkValue: 0, defaultMarks: 1 },
        availability: { durationMinutes: 60 },
        security: {
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
          policyVersion: 1,
        },
        navigation: {
          randomizeQuestions: false,
          randomizeOptions: false,
          allowPrevious: true,
          showQuestionNumbers: true,
        },
      },

      startedAt: '2026-01-01T00:00:00.000Z',
      deadlineAt: '2026-01-01T01:00:00.000Z',
      questionOrder: [],
      optionOrders: {},
      answers: [],
      focusLosses: 0,
      localRevision: 0,
      serverRevision: 0,
    });
    state.attempts.push({ ...state.attempts[0], id: 'a2', deviceSessionId: 'd2' });
    const report = reviewExaminationSecurity(state);
    expect(report.passed).toBe(false);
    expect(report.findings.some((finding) => finding.id === 'duplicate-attempt:student')).toBe(
      true,
    );
  });
});

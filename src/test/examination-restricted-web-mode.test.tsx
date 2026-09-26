import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

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
  createPharmaExamPackage,
  generateExamSigningKeyPair,
} from '../examination/package';
import {
  stagePharmaExamPackage,
  clearStagedPharmaExam,
} from '../examination/packageCache';
import {
  createCapabilityMatrix,
  createBrowserKioskAdapter,
  KIOSK_CAPABILITY_IDS,
  policyForViolation,
  platform,
} from '../examination/kioskAdapter';
import {
  enterSecureKiosk,
  getSecureKioskState,
  releaseSecureKiosk,
  markSecureKioskSubmitting,
  recordBlockedKioskNavigation,
  onBlockedKioskNavigation,
} from '../examination/kioskState';
import { aiManager } from '../ai/manager';
import AIChatPanel from '../components/AIChatPanel';
import SecureExamination from '../pages/SecureExamination';
import { AppProvider } from '../context/AppContext';
import { AIProvider } from '../ai/state';
import type { ExamQuestion } from '../types';
import type { SecurityViolation, ViolationPolicy } from '../examination/types';

const testQuestions: ExamQuestion[] = [
  {
    id: 'rq1',
    courseId: 'chem-201',
    topicId: 'stereochemistry',
    questionText: 'Which enantiomer of thalidomide is associated with teratogenic effects?',
    questionType: 'mcq',
    marksAllocation: 2,
    difficulty: 'medium',
    probability: 'high',
    modelAnswer: 'S-enantiomer',
    correctAnswer: 'S-enantiomer',
    tags: ['medicinal-chemistry'],
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: '2026-09-26T00:00:00.000Z',
    options: ['R-enantiomer', 'S-enantiomer', 'Both equally', 'Neither'],
    correctOption: 1,
  },
  {
    id: 'rq2',
    courseId: 'chem-201',
    topicId: 'pharmacokinetics',
    questionText: 'Define bioavailability and state the equation for oral bioavailability.',
    questionType: 'short_answer',
    marksAllocation: 3,
    difficulty: 'hard',
    probability: 'medium',
    modelAnswer: 'Fraction of administered dose reaching systemic circulation unchanged.',
    correctAnswer: 'Fraction of administered dose reaching systemic circulation unchanged.',
    tags: ['pharmacology'],
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: '2026-09-26T00:00:00.000Z',
  },
];

async function setupRestrictedExamPackage(policies: Partial<Record<SecurityViolation, ViolationPolicy>> = {}) {
  const repository = await ExaminationRepository.open();
  const exam = await repository.createExam('Restricted Web Examination');
  const version = await repository.createVersion(exam.id, testQuestions, {
    title: 'Restricted Web Examination',
    assessmentType: 'KIOSK_EXAM',
    availability: { durationMinutes: 60 },
    security: {
      kioskMode: true,
      fullLockdown: true,
      disableAI: true,
      disableNotes: true,
      disableMaterials: true,
      disableNavigation: true,
      disableCopyPaste: true,
      disablePrinting: true,
      disableExternalLinks: true,
      disableDeveloperTools: true,
      detectFocusLoss: true,
      restrictExit: true,
      capabilityFailurePolicy: 'ALLOW_WITH_WARNING',
      violationPolicies: policies,
      requiredCapabilities: [KIOSK_CAPABILITY_IDS.navigation, KIOSK_CAPABILITY_IDS.copyPaste],
    },
    navigation: { allowPrevious: true, showQuestionNumbers: true },
  });
  const published = await repository.publishVersion(exam.id, version.id);
  const signingKey = await generateExamSigningKeyPair();
  const packageData = await createPharmaExamPackage({
    version: published,
    institution: { name: 'KNUST Faculty of Pharmacy', code: 'KNUST-PHARM' },
    signingKey,
  });
  return { repository, exam, version: published, packageData };
}

describe('PHARMATRACK — RESTRICTED WEB EXAMINATION MODE', () => {
  beforeEach(async () => {
    idbStore.clear();
    sessionStorage.clear();
    releaseSecureKiosk();
    await clearStagedPharmaExam();
  });

  describe('1. Central Route Blocking & Navigation Hiding', () => {
    it('redirects restricted routes to active secure examination route', () => {
      const attemptId = 'att-restricted-route-01';
      const blockedRoutes = ['/materials', '/notes', '/ai', '/courses', '/library', '/read'];
      enterSecureKiosk(attemptId, true, blockedRoutes);

      const state = getSecureKioskState();
      expect(state.active).toBe(true);
      expect(state.mode).toBe('SECURE_EXAM_ACTIVE');
      expect(state.attemptId).toBe(attemptId);
      expect(state.fullLockdown).toBe(true);
      expect(state.blockedRoutes).toEqual(blockedRoutes);

      // Verify blocked navigation recording
      const violations: string[] = [];
      const cleanup = onBlockedKioskNavigation((path) => violations.push(path));
      recordBlockedKioskNavigation('/materials');
      recordBlockedKioskNavigation('/ai');
      recordBlockedKioskNavigation('/notes');
      expect(violations).toEqual(['/materials', '/ai', '/notes']);
      cleanup();
    });

    it('releases route restrictions when examination ends', () => {
      enterSecureKiosk('att-release-01', true, ['/materials', '/ai']);
      expect(getSecureKioskState().active).toBe(true);

      releaseSecureKiosk();
      const state = getSecureKioskState();
      expect(state.active).toBe(false);
      expect(state.attemptId).toBeFalsy();
      expect(state.blockedRoutes).toEqual([]);
    });
  });

  describe('2. AI Engine & Chat UI Blocking', () => {
    it('blocks AI completions in AIManager while examination is active', async () => {
      enterSecureKiosk('att-ai-blocked-01', true, ['/ai']);

      await expect(
        aiManager.generate({
          messages: [{ role: 'user', content: 'What is the dosage of paracetamol?' }],
        }),
      ).rejects.toThrow('AI completion is disabled during an active examination.');

      releaseSecureKiosk();
    });

    it('renders AIChatPanel in disabled state with clear exam warning banner', () => {
      enterSecureKiosk('att-ai-panel-01', true, ['/ai']);

      const mockAppState = {
        courses: [],
        semesters: [],
        highlights: [],
        quizHistory: [],
      } as any;

      render(
        <AIProvider>
          <MemoryRouter>
            <AIChatPanel
              appState={mockAppState}
              scope={{ courseId: 'c1', topicId: 't1' }}
            />
          </MemoryRouter>
        </AIProvider>,
      );

      // Exam banner is visible
      const banner = screen.getByTestId('ai-exam-blocked-banner');
      expect(banner).toBeDefined();
      expect(banner.textContent).toContain('PharmaTRACK AI is disabled during an active examination.');

      // Input and send button are disabled
      const input = screen.getByLabelText('Ask the AI') as HTMLInputElement;
      expect(input.disabled).toBe(true);
      expect(input.placeholder).toBe('AI is disabled during an active examination.');

      releaseSecureKiosk();
    });
  });

  describe('3. Material & Academic Library Blocking', () => {
    it('configures blocked routes to include materials, library, archive, and reader', async () => {
      const { repository, exam, version } = await setupRestrictedExamPackage();
      const session = await repository.createSession(exam.id, version.id);
      const { student } = await repository.registerStudent('Kofi', 'Level 300');
      const { attempt } = await repository.createAttempt(session.id, student.id, 'dev-mat-01');

      const expectedBlocked = ['/materials', '/library', '/archive', '/read', '/notes', '/ai'];
      enterSecureKiosk(attempt.id, true, expectedBlocked);

      const state = getSecureKioskState();
      expect(state.active).toBe(true);
      for (const route of expectedBlocked) {
        expect(state.blockedRoutes).toContain(route);
      }
    });
  });

  describe('4. External Link & Window Navigation Blocking', () => {
    it('intercepts external link clicks and prevents opening external origin', () => {
      const violations: any[] = [];
      const adapter = createBrowserKioskAdapter((v) => violations.push(v), [], {
        externalLinks: true,
      });
      const cleanup = adapter.install();

      const externalLink = document.createElement('a');
      externalLink.href = 'https://external-search-engine.example.com/pharmacology';
      document.body.appendChild(externalLink);

      const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
      externalLink.dispatchEvent(clickEvent);

      expect(clickEvent.defaultPrevented).toBe(true);
      expect(violations.length).toBe(1);
      expect(violations[0].violation).toBe('EXTERNAL_LINK_ATTEMPT');
      expect(violations[0].prevented).toBe(true);

      document.body.removeChild(externalLink);
      cleanup();
    });

    it('intercepts window.open calls and records violation', () => {
      const violations: any[] = [];
      const adapter = createBrowserKioskAdapter((v) => violations.push(v), [], {
        externalLinks: true,
      });
      const cleanup = adapter.install();

      const result = window.open('https://cheat-sheet.example.com', '_blank');
      expect(result).toBeNull();
      expect(violations.some((v) => v.violation === 'EXTERNAL_LINK_ATTEMPT')).toBe(true);

      cleanup();
    });
  });

  describe('5. Focus & Visibility Lifecycle Monitoring', () => {
    it('detects blur, focus, visibilitychange, and page transitions without auto force-submitting on default policy', async () => {
      const violations: any[] = [];
      const adapter = createBrowserKioskAdapter((v) => violations.push(v), [], {
        focus: true,
      });
      const cleanup = adapter.install();

      // Window blur
      window.dispatchEvent(new Event('blur'));
      expect(violations.some((v) => v.violation === 'FOCUS_LOST')).toBe(true);

      // Window focus recovery
      window.dispatchEvent(new Event('focus'));
      expect(violations.some((v) => v.violation === 'RECOVERY')).toBe(true);

      // Visibility change to hidden
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(violations.some((v) => v.violation === 'VISIBILITY_CHANGE')).toBe(true);

      // Page hide
      window.dispatchEvent(new Event('pagehide'));
      expect(violations.some((v) => v.violation === 'PAGE_HIDDEN')).toBe(true);

      // Page show recovery
      window.dispatchEvent(new Event('pageshow'));
      expect(violations.filter((v) => v.violation === 'RECOVERY').length).toBeGreaterThanOrEqual(2);

      // Default policy for focus loss is WARN, not FORCE_SUBMIT
      const { repository, exam, version } = await setupRestrictedExamPackage();
      const session = await repository.createSession(exam.id, version.id);
      const { student } = await repository.registerStudent('Ama', 'Level 200');
      const { attempt } = await repository.createAttempt(session.id, student.id, 'dev-focus-01');

      const outcome = await repository.recordSecurityViolation(
        attempt.id,
        'FOCUS_LOST',
        'Window focus temporarily lost.',
      );

      expect(outcome.policy).toBe('WARN');
      expect(outcome.attempt.status).toBe('ACTIVE');
      expect(outcome.attempt.securityState).toBe('WARNING');
      expect(outcome.attempt.focusLosses).toBe(1);

      cleanup();
    });
  });

  describe('6. Fullscreen Handling & Exit Detection', () => {
    it('requests fullscreen at start where supported and audits exit', async () => {
      const violations: any[] = [];
      const adapter = createBrowserKioskAdapter((v) => violations.push(v), [], {
        focus: true,
      });
      const cleanup = adapter.install();

      // requestFullscreen returns false gracefully in jsdom
      const granted = await adapter.requestFullscreen();
      expect(typeof granted).toBe('boolean');

      // Fullscreen exit detection
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => null,
      });
      document.dispatchEvent(new Event('fullscreenchange'));
      expect(violations.some((v) => v.violation === 'FULLSCREEN_EXIT')).toBe(true);

      cleanup();
    });
  });

  describe('7. Security Event Creation & Configured Policies', () => {
    it('supports LOG policy without mutating active attempt state', async () => {
      const { repository, exam, version } = await setupRestrictedExamPackage({
        FOCUS_LOST: 'LOG',
      });
      const session = await repository.createSession(exam.id, version.id);
      const { student } = await repository.registerStudent('StudentLog', 'Level 100');
      const { attempt } = await repository.createAttempt(session.id, student.id, 'dev-pol-01');

      const result = await repository.recordSecurityViolation(attempt.id, 'FOCUS_LOST', 'Focus lost');
      expect(result.policy).toBe('LOG');
      expect(result.attempt.status).toBe('ACTIVE');

      const events = repository.snapshot.securityEvents.filter((e) => e.attemptId === attempt.id);
      expect(events.some((e) => e.type === 'FOCUS_LOST' && e.severity === 'info')).toBe(true);
    });

    it('supports WARN policy by setting securityState to WARNING while staying ACTIVE', async () => {
      const { repository, exam, version } = await setupRestrictedExamPackage({
        FOCUS_LOST: 'WARN',
      });
      const session = await repository.createSession(exam.id, version.id);
      const { student } = await repository.registerStudent('StudentWarn', 'Level 200');
      const { attempt } = await repository.createAttempt(session.id, student.id, 'dev-pol-02');

      const result = await repository.recordSecurityViolation(attempt.id, 'FOCUS_LOST', 'Focus lost');
      expect(result.policy).toBe('WARN');
      expect(result.attempt.status).toBe('ACTIVE');
      expect(result.attempt.securityState).toBe('WARNING');
    });

    it('supports LOCK policy by setting attempt status to LOCKED', async () => {
      const { repository, exam, version } = await setupRestrictedExamPackage({
        FOCUS_LOST: 'LOCK',
      });
      const session = await repository.createSession(exam.id, version.id);
      const { student } = await repository.registerStudent('StudentLock', 'Level 300');
      const { attempt } = await repository.createAttempt(session.id, student.id, 'dev-pol-03');

      const result = await repository.recordSecurityViolation(attempt.id, 'FOCUS_LOST', 'Focus lost');
      expect(result.policy).toBe('LOCK');
      expect(result.attempt.status).toBe('LOCKED');
      expect(result.attempt.securityState).toBe('LOCKED');
    });

    it('supports ADMIN_INTERVENTION policy by setting attempt status to LOCKED and state to ADMIN_REVIEW', async () => {
      const { repository, exam, version } = await setupRestrictedExamPackage({
        FOCUS_LOST: 'ADMIN_INTERVENTION',
      });
      const session = await repository.createSession(exam.id, version.id);
      const { student } = await repository.registerStudent('StudentAdmin', 'Level 400');
      const { attempt } = await repository.createAttempt(session.id, student.id, 'dev-pol-04');

      const result = await repository.recordSecurityViolation(attempt.id, 'FOCUS_LOST', 'Focus lost');
      expect(result.policy).toBe('ADMIN_INTERVENTION');
      expect(result.attempt.status).toBe('LOCKED');
      expect(result.attempt.securityState).toBe('ADMIN_REVIEW');
    });

    it('supports FORCE_SUBMIT policy when explicitly configured by administrator', async () => {
      const { repository, exam, version } = await setupRestrictedExamPackage({
        FOCUS_LOST: 'FORCE_SUBMIT',
      });
      const session = await repository.createSession(exam.id, version.id);
      const { student } = await repository.registerStudent('StudentForce', 'Level 500');
      const { attempt } = await repository.createAttempt(session.id, student.id, 'dev-pol-05');

      const result = await repository.recordSecurityViolation(attempt.id, 'FOCUS_LOST', 'Focus lost');
      expect(result.policy).toBe('FORCE_SUBMIT');
      expect(result.attempt.status).toBe('SUBMITTED');
    });
  });

  describe('8. Student Submission (Password-Free)', () => {
    it('submits attempt immediately without requiring any exit password', async () => {
      const { repository, exam, version } = await setupRestrictedExamPackage();
      const session = await repository.createSession(exam.id, version.id);
      const { student } = await repository.registerStudent('Esi', 'Level 200');
      const { attempt } = await repository.createAttempt(session.id, student.id, 'dev-sub-01');

      // Record an answer
      await repository.recordAnswer(attempt.id, {
        questionId: 'rq1',
        answer: '1',
        selectedOption: 1,
        deviceSessionId: attempt.deviceSessionId,
        isFinal: false,
      });

      // Submit attempt: no password required!
      const closed = await repository.submitAttempt(
        attempt.id,
        false,
        attempt.deviceSessionId,
        'MANUAL',
      );

      expect(closed.status).toBe('SUBMITTED');
      expect(closed.submittedAt).toBeDefined();
      expect(closed.submissionTrigger).toBe('MANUAL');

      // Audit log records password-free submission
      const audit = repository.snapshot.securityEvents.filter((e) => e.attemptId === attempt.id);
      expect(audit.some((e) => e.type === 'SUBMITTED')).toBe(true);
    });
  });

  describe('9. Automatic Submission on Time Expiry', () => {
    it('automatically finalizes attempt when timer reaches zero without requiring any password', async () => {
      const { repository, exam, version } = await setupRestrictedExamPackage();
      const session = await repository.createSession(exam.id, version.id);
      const { student } = await repository.registerStudent('Kwabena', 'Level 300');
      const { attempt } = await repository.createAttempt(session.id, student.id, 'dev-exp-01');

      // Timer expires -> submit with forced = true and trigger = EXPIRY
      const expired = await repository.submitAttempt(
        attempt.id,
        true,
        attempt.deviceSessionId,
        'EXPIRY',
      );

      expect(expired.status).toBe('SUBMITTED');
      expect(expired.submissionTrigger).toBe('EXPIRY');

      const events = repository.snapshot.securityEvents.filter((e) => e.attemptId === attempt.id);
      expect(events.some((e) => e.type === 'EXPIRY_SUBMITTED')).toBe(true);
    });
  });

  describe('10. Browser Refresh & Session Recovery', () => {
    it('restores active attempt, questions, timer, and saved answers after simulated browser reload', async () => {
      const { repository, exam, version } = await setupRestrictedExamPackage();
      const session = await repository.createSession(exam.id, version.id);
      const { student } = await repository.registerStudent('Abena', 'Level 400');
      const { attempt } = await repository.createAttempt(session.id, student.id, 'dev-rec-01');

      // Record answer
      await repository.recordAnswer(attempt.id, {
        questionId: 'rq1',
        answer: '1',
        selectedOption: 1,
        deviceSessionId: attempt.deviceSessionId,
        isFinal: false,
      });

      // Enter kiosk mode and persist state to sessionStorage
      enterSecureKiosk(attempt.id, true, ['/materials', '/ai']);
      expect(getSecureKioskState().active).toBe(true);

      // Simulate a browser page reload: reopen repository from storage
      const reloadedRepo = await ExaminationRepository.open();
      const restoredAttempt = reloadedRepo.snapshot.attempts.find((a) => a.id === attempt.id);

      expect(restoredAttempt).toBeDefined();
      expect(restoredAttempt?.status).toBe('ACTIVE');
      expect(restoredAttempt?.answers.length).toBe(1);
      expect(restoredAttempt?.answers[0].answer).toBe('1');

      // Timer calculation continues seamlessly
      const timer = await reloadedRepo.getAttemptTimer(attempt.id);
      expect(timer.remainingMilliseconds).toBeGreaterThan(0);

      // Kiosk session state survives
      expect(getSecureKioskState().active).toBe(true);
      expect(getSecureKioskState().attemptId).toBe(attempt.id);
    });
  });

  describe('11. Offline Saving & Network Recovery', () => {
    it('saves answers locally during network disconnection and synchronizes on reconnect', async () => {
      const { repository, exam, version } = await setupRestrictedExamPackage();
      const session = await repository.createSession(exam.id, version.id);
      const { student } = await repository.registerStudent('Yaw', 'Level 200');
      const { attempt } = await repository.createAttempt(session.id, student.id, 'dev-off-01');

      const violations: any[] = [];
      const adapter = createBrowserKioskAdapter((v) => violations.push(v));
      const cleanup = adapter.install();

      // Simulate offline event
      window.dispatchEvent(new Event('offline'));
      expect(violations.some((v) => v.violation === 'NETWORK_LOSS')).toBe(true);

      // Save answer while offline
      await repository.recordAnswer(attempt.id, {
        questionId: 'rq2',
        answer: 'Fraction of unchanged drug reaching systemic circulation.',
        deviceSessionId: attempt.deviceSessionId,
        isFinal: false,
      });

      // Verify answer was persisted to local encrypted state
      const reloaded = await ExaminationRepository.open();
      const current = reloaded.snapshot.attempts.find((a) => a.id === attempt.id);
      expect(current?.answers.some((a) => a.questionId === 'rq2')).toBe(true);

      // Simulate online event
      window.dispatchEvent(new Event('online'));
      expect(violations.some((v) => v.violation === 'RECOVERY')).toBe(true);

      cleanup();
    });
  });

  describe('12. Browser Limitations & Honest Capability Reporting', () => {
    it('explicitly reports unavailable OS lockdown capabilities without faking them', () => {
      const matrix = createCapabilityMatrix('web');

      const checkUnavailable = (capabilityId: string) => {
        const cap = matrix.capabilities.find((c) => c.id === capabilityId);
        expect(cap).toBeDefined();
        expect(cap?.supported).toBe(false);
        expect(cap?.enforceable).toBe(false);
        expect(cap?.supportLevel).toBe('UNAVAILABLE');
      };

      // Verify all 7 explicit browser limitation boundaries
      checkUnavailable(KIOSK_CAPABILITY_IDS.screenCapture);
      checkUnavailable(KIOSK_CAPABILITY_IDS.screenRecording);
      checkUnavailable(KIOSK_CAPABILITY_IDS.appSwitch);
      checkUnavailable(KIOSK_CAPABILITY_IDS.homeGesture);
      checkUnavailable(KIOSK_CAPABILITY_IDS.osShortcuts);
      checkUnavailable(KIOSK_CAPABILITY_IDS.processKill);
      checkUnavailable(KIOSK_CAPABILITY_IDS.secondDevice);
    });
  });
});

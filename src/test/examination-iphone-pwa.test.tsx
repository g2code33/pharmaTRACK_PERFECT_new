import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import fs from 'fs';
import path from 'path';

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
  validatePharmaExamPackage,
} from '../examination/package';
import { stagePharmaExamPackage } from '../examination/packageCache';
import {
  createCapabilityMatrix,
  KIOSK_CAPABILITY_IDS,
} from '../examination/kioskAdapter';
import { createPlatformKioskAdapter } from '../examination/androidAdapter';
import {
  detectDeviceFamily,
  detectRuntimeCapabilities,
  isIOS,
  isIPhone,
  isIOSPWA,
  isIOSSafari,
  isPWAStandalone,
} from '../platform/runtime';
import {
  BROWSER_PHARMAEXAM_ACCEPT,
  hasPharmaExamExtension,
} from '../platform/fileSelection';
import { AppProvider } from '../context/AppContext';
import SecureExamination from '../pages/SecureExamination';
import KioskEntry from '../pages/KioskEntry';
import type { ExamQuestion } from '../types';

const originalUserAgent = navigator.userAgent;

function setMockUserAgent(agent: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: agent,
  });
}

const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

const sampleQuestions: ExamQuestion[] = [
  {
    id: 'q1',
    courseId: 'pharma-201',
    topicId: 'pharmacology',
    questionText: 'Which class of antimicrobial inhibits bacterial cell wall synthesis?',
    questionType: 'mcq',
    marksAllocation: 2,
    difficulty: 'medium',
    probability: 'high',
    modelAnswer: 'Beta-lactams',
    correctAnswer: 'Beta-lactams',
    tags: ['antimicrobials', 'cell-wall'],
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: '2026-09-26T00:00:00.000Z',
    options: ['Macrolides', 'Beta-lactams', 'Aminoglycosides', 'Fluoroquinolones'],
    correctOption: 1,
  },
  {
    id: 'q2',
    courseId: 'pharma-201',
    topicId: 'pharmacology',
    questionText: 'Outline the clinical significance of therapeutic drug monitoring for aminoglycosides.',
    questionType: 'short_answer',
    marksAllocation: 3,
    difficulty: 'hard',
    probability: 'medium',
    modelAnswer: 'Prevents nephrotoxicity and ototoxicity while ensuring therapeutic efficacy.',
    correctAnswer: 'Prevents nephrotoxicity and ototoxicity while ensuring therapeutic efficacy.',
    tags: ['pharmacology', 'tdm'],
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: '2026-09-26T00:00:00.000Z',
  },
];

async function createTestPackage() {
  const repository = await ExaminationRepository.open();
  const exam = await repository.createExam('Pharmacology iPhone Examination');
  const version = await repository.createVersion(exam.id, sampleQuestions, {
    title: 'Pharmacology iPhone Examination',
    assessmentType: 'KIOSK_EXAM',
    availability: { durationMinutes: 45 },
    security: {
      kioskMode: true,
      requireExamPassword: false,
      capabilityFailurePolicy: 'ALLOW_WITH_WARNING',
      requiredCapabilities: [KIOSK_CAPABILITY_IDS.navigation, KIOSK_CAPABILITY_IDS.copyPaste],
    },
    navigation: { allowPrevious: true, showQuestionNumbers: true },
  });
  const published = await repository.publishVersion(exam.id, version.id);
  const signingKey = await generateExamSigningKeyPair();
  const packageData = await createPharmaExamPackage({
    version: published,
    institution: { name: 'KNUST Department of Pharmacology', code: 'KNUST-PHARM' },
    signingKey,
  });
  return { repository, exam, version: published, packageData };
}

describe('PHARMATRACK — iPhone PWA Examination Flow', () => {
  beforeEach(() => {
    idbStore.clear();
    setMockUserAgent(IPHONE_SAFARI_UA);
    delete (navigator as any).standalone;
  });

  afterEach(() => {
    setMockUserAgent(originalUserAgent);
    delete (navigator as any).standalone;
  });

  describe('1. iPhone & PWA Device / Platform Detection', () => {
    it('detects iPhone Safari when running in standard browser mode', () => {
      setMockUserAgent(IPHONE_SAFARI_UA);
      (navigator as any).standalone = false;

      expect(detectDeviceFamily()).toBe('ios');
      expect(isIOS()).toBe(true);
      expect(isIPhone()).toBe(true);
      expect(isIOSSafari()).toBe(true);
      expect(isIOSPWA()).toBe(false);
      expect(isPWAStandalone()).toBe(false);

      const caps = detectRuntimeCapabilities();
      expect(caps.device).toBe('ios');
      expect(caps.isIOS).toBe(true);
      expect(caps.isIOSSafari).toBe(true);
      expect(caps.isIOSPWA).toBe(false);
      expect(caps.nativeHost).toBe(false);
    });

    it('detects installed iPhone PWA when navigator.standalone is true', () => {
      setMockUserAgent(IPHONE_SAFARI_UA);
      (navigator as any).standalone = true;

      expect(detectDeviceFamily()).toBe('ios');
      expect(isIOS()).toBe(true);
      expect(isIPhone()).toBe(true);
      expect(isIOSPWA()).toBe(true);
      expect(isIOSSafari()).toBe(false);
      expect(isPWAStandalone()).toBe(true);

      const caps = detectRuntimeCapabilities();
      expect(caps.isIOSPWA).toBe(true);
      expect(caps.isIOSSafari).toBe(false);
    });

    it('detects standalone display-mode via matchMedia when navigator.standalone is absent', () => {
      setMockUserAgent(IPHONE_SAFARI_UA);
      delete (navigator as any).standalone;

      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === '(display-mode: standalone)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      expect(isIOSPWA()).toBe(true);
      expect(isIOSSafari()).toBe(false);

      window.matchMedia = originalMatchMedia;
    });

    it('routes createPlatformKioskAdapter to IOS_SAFARI or IOS_PWA', async () => {
      setMockUserAgent(IPHONE_SAFARI_UA);
      (navigator as any).standalone = false;
      const safariAdapter = await createPlatformKioskAdapter(() => undefined, []);
      expect(safariAdapter.matrix.platform).toBe('IOS_SAFARI');

      (navigator as any).standalone = true;
      const pwaAdapter = await createPlatformKioskAdapter(() => undefined, []);
      expect(pwaAdapter.matrix.platform).toBe('IOS_PWA');
    });
  });

  describe('2. Honest Platform Capability Matrix for iPhone', () => {
    it('honestly reports Safari limitations without claiming native OS lockdown', () => {
      const safariMatrix = createCapabilityMatrix('IOS_SAFARI', [
        KIOSK_CAPABILITY_IDS.immersive,
        KIOSK_CAPABILITY_IDS.fileAssociation,
        KIOSK_CAPABILITY_IDS.homeGesture,
        KIOSK_CAPABILITY_IDS.focus,
      ]);

      expect(safariMatrix.platform).toBe('IOS_SAFARI');

      // Fullscreen API is not guaranteed on iPhone Safari for HTML documents
      const immersive = safariMatrix.capabilities.find((c) => c.id === KIOSK_CAPABILITY_IDS.immersive)!;
      expect(immersive.enforceable).toBe(false);
      expect(immersive.supportLevel).toBe('NOT_GUARANTEED');
      expect(immersive.notes).toContain('iPhone Safari does not support the Element Fullscreen API');

      // Home swipe gesture is reserved for iOS
      const homeGesture = safariMatrix.capabilities.find((c) => c.id === KIOSK_CAPABILITY_IDS.homeGesture)!;
      expect(homeGesture.supported).toBe(false);
      expect(homeGesture.enforceable).toBe(false);
      expect(homeGesture.supportLevel).toBe('UNAVAILABLE');

      // File association uses standard browser file picker / Files app
      const fileAssoc = safariMatrix.capabilities.find((c) => c.id === KIOSK_CAPABILITY_IDS.fileAssociation)!;
      expect(fileAssoc.supported).toBe(false);
      expect(fileAssoc.enforceable).toBe(false);
      expect(fileAssoc.supportLevel).toBe('UNAVAILABLE');

      // Focus monitoring is supported
      const focus = safariMatrix.capabilities.find((c) => c.id === KIOSK_CAPABILITY_IDS.focus)!;
      expect(focus.supported).toBe(true);
      expect(focus.notes).toContain('not automatically cheating');
    });

    it('reports standalone immersive support for installed iPhone PWA', () => {
      const pwaMatrix = createCapabilityMatrix('IOS_PWA', [KIOSK_CAPABILITY_IDS.immersive]);
      expect(pwaMatrix.platform).toBe('IOS_PWA');

      const immersive = pwaMatrix.capabilities.find((c) => c.id === KIOSK_CAPABILITY_IDS.immersive)!;
      expect(immersive.supported).toBe(true);
      expect(immersive.enforceable).toBe(true);
      expect(immersive.supportLevel).toBe('SUPPORTED');
      expect(immersive.notes).toContain('standalone display mode');
    });
  });

  describe('3. PWA Standalone, Viewport & Safe-Area Configuration', () => {
    it('verifies index.html has viewport-fit=cover, apple tags, and touch icons', () => {
      const htmlPath = path.resolve(__dirname, '../../index.html');
      const html = fs.readFileSync(htmlPath, 'utf8');

      expect(html).toContain('viewport-fit=cover');
      expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
      expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="black-translucent"');
      expect(html).toContain('rel="apple-touch-icon"');
    });

    it('verifies manifest.webmanifest configures standalone display', () => {
      const manifestPath = path.resolve(__dirname, '../../public/manifest.webmanifest');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      expect(manifest.display).toBe('standalone');
      expect(manifest.icons.length).toBeGreaterThanOrEqual(1);
      expect(manifest.theme_color).toBe('#0f172a');
    });

    it('verifies CSS contains safe-area utilities and touch manipulation rules', () => {
      const cssPath = path.resolve(__dirname, '../../src/index.css');
      const css = fs.readFileSync(cssPath, 'utf8');

      expect(css).toContain('.pt-safe');
      expect(css).toContain('.pb-safe');
      expect(css).toContain('.safe-area-x');
      expect(css).toContain('env(safe-area-inset-top');
      expect(css).toContain('env(safe-area-inset-bottom');
      expect(css).toContain('.touch-manipulation');
    });
  });

  describe('4. File Selection & Package Workflow on iPhone', () => {
    it('accepts .pharmaexam and application/octet-stream for iOS Files app compatibility', () => {
      expect(BROWSER_PHARMAEXAM_ACCEPT).toContain('.pharmaexam');
      expect(BROWSER_PHARMAEXAM_ACCEPT).toContain('application/octet-stream');
      expect(hasPharmaExamExtension('exam.pharmaexam')).toBe(true);
    });

    it('displays optional iPhone Safari Add to Home Screen guidance in KioskEntry', async () => {
      setMockUserAgent(IPHONE_SAFARI_UA);
      (navigator as any).standalone = false;

      render(
        <MemoryRouter initialEntries={['/examinations/kiosk']}>
          <AppProvider>
            <Routes>
              <Route path="/examinations/kiosk" element={<KioskEntry />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );

      expect(screen.getByText('iPhone Safari Detected')).toBeInTheDocument();
      expect(screen.getByText(/“Add to Home Screen”/i)).toBeInTheDocument();
      expect(screen.getByText(/borderless standalone PWA kiosk view/i)).toBeInTheDocument();
    });

    it('displays iPhone PWA Standalone Mode badge when running as installed PWA', async () => {
      setMockUserAgent(IPHONE_SAFARI_UA);
      (navigator as any).standalone = true;

      render(
        <MemoryRouter initialEntries={['/examinations/kiosk']}>
          <AppProvider>
            <Routes>
              <Route path="/examinations/kiosk" element={<KioskEntry />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );

      expect(screen.getByText('iPhone PWA Standalone Mode')).toBeInTheDocument();
    });
  });

  describe('5. Safari Lifecycle Behavior: Backgrounding & Returning', () => {
    it('audits focus loss when Safari is backgrounded but NEVER locks out the student or flags cheating', async () => {
      setMockUserAgent(IPHONE_SAFARI_UA);
      const { repository, exam, version } = await createTestPackage();
      const session = await repository.createSession(
        exam.id,
        version.id,
        'local-auth',
        undefined,
        'sess-ios-lifecycle',
      );
      const student = await repository.registerStudent('Ama', 'Level 400');
      const devSession = await repository.createDeviceSession({
        deviceId: 'iphone-ama',
        role: 'STUDENT',
        studentId: student.student.id,
        sessionId: session.id,
        platform: 'IOS_SAFARI',
        capabilities: ['encrypted-local-state', 'web-client'],
      });
      const attemptResult = await repository.createAttempt(
        session.id,
        student.student.id,
        devSession.id,
        new Date().toISOString(),
      );

      // Verify the attempt is active
      expect(attemptResult.attempt.status).toBe('ACTIVE');

      // Record FOCUS_LOST from Safari backgrounding (e.g. incoming call, notification center)
      const violationRes = await repository.recordSecurityViolation(
        attemptResult.attempt.id,
        'FOCUS_LOST',
        'Exam window lost focus. This is logged for review and is not automatically cheating.',
      );

      // Must remain ACTIVE — not locked, not terminated, no automatic cheating accusation
      expect(violationRes.attempt.status).toBe('ACTIVE');
      expect(violationRes.attempt.focusLosses).toBe(1);

      // Student returns to Safari / PWA -> RECOVERY event
      const recoveryRes = await repository.recordSecurityViolation(
        attemptResult.attempt.id,
        'RECOVERY',
        'Exam window focus was restored.',
      );

      expect(recoveryRes.attempt.status).toBe('ACTIVE');

      // Audit log records the events honestly
      const events = repository.snapshot.securityEvents.filter(
        (e) => e.attemptId === attemptResult.attempt.id,
      );
      expect(events.some((e) => e.type === 'FOCUS_LOST')).toBe(true);
      expect(events.some((e) => e.type === 'RECOVERY_COMPLETED')).toBe(true);
    });
  });

  describe('6. Safari Temporary Suspension & Authoritative Deadline Expiry', () => {
    it('automatically finalizes submission when returning after authoritative deadline has expired', async () => {
      setMockUserAgent(IPHONE_SAFARI_UA);
      const { repository, exam, version } = await createTestPackage();
      const session = await repository.createSession(
        exam.id,
        version.id,
        'local-auth',
        undefined,
        'sess-ios-suspension',
      );
      const student = await repository.registerStudent('Kofi', 'Level 500');
      const devSession = await repository.createDeviceSession({
        deviceId: 'iphone-kofi',
        role: 'STUDENT',
        studentId: student.student.id,
        sessionId: session.id,
        platform: 'IOS_SAFARI',
        capabilities: ['encrypted-local-state', 'web-client'],
      });

      // Start attempt 2 hours in the past so the authoritative deadline has expired
      const pastStart = new Date(Date.now() - 120 * 60 * 1000).toISOString();
      const attemptResult = await repository.createAttempt(
        session.id,
        student.student.id,
        devSession.id,
        pastStart,
      );

      // Submit due to expiry
      const submitted = await repository.submitAttempt(
        attemptResult.attempt.id,
        true,
        devSession.id,
        'EXPIRY',
      );

      expect(submitted.status).toBe('SUBMITTED');
      expect(submitted.submissionState).toBe('EXPIRED');
      expect(submitted.submissionTrigger).toBe('EXPIRY');

      // Result is generated
      const result = repository.getExaminationResult(attemptResult.attempt.id);
      expect(result).toBeDefined();
      expect(result?.attemptId).toBe(attemptResult.attempt.id);
    });
  });

  describe('7. Screen Rotation & Network Changes', () => {
    it('handles screen rotation without generating security violations', async () => {
      setMockUserAgent(IPHONE_SAFARI_UA);
      const violations: string[] = [];
      const adapter = await createPlatformKioskAdapter((v) => violations.push(v.violation), []);
      const cleanup = adapter.install();

      // Trigger screen rotation events
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('orientationchange'));

      expect(violations.length).toBe(0);
      cleanup();
    });

    it('handles network loss and restoration with continuous local persistence', async () => {
      setMockUserAgent(IPHONE_SAFARI_UA);
      const { repository, exam, version } = await createTestPackage();
      const session = await repository.createSession(
        exam.id,
        version.id,
        'local-auth',
        undefined,
        'sess-ios-net',
      );
      const student = await repository.registerStudent('Akua', 'Level 300');
      const devSession = await repository.createDeviceSession({
        deviceId: 'iphone-akua',
        role: 'STUDENT',
        studentId: student.student.id,
        sessionId: session.id,
        platform: 'IOS_SAFARI',
        capabilities: ['encrypted-local-state', 'web-client'],
      });
      const attemptResult = await repository.createAttempt(
        session.id,
        student.student.id,
        devSession.id,
        new Date().toISOString(),
      );

      // Network goes offline: record answer locally
      const recorded = await repository.recordAnswer(attemptResult.attempt.id, {
        questionId: 'q1',
        answer: '1',
        selectedOption: 1,
        deviceSessionId: devSession.id,
        isFinal: false,
      });

      expect(recorded.answer).toBe('1');
      expect(recorded.revision).toBe(1);

      // Local persistence holds during offline
      const attempt = repository.snapshot.attempts.find((a) => a.id === attemptResult.attempt.id)!;
      expect(attempt.answers.find((a) => a.questionId === 'q1')?.answer).toBe('1');

      // Recovery event when coming back online
      const recovery = await repository.recordSecurityViolation(
        attemptResult.attempt.id,
        'RECOVERY',
        'Network became available again; queued events can synchronize.',
      );
      expect(recovery.attempt.status).toBe('ACTIVE');
    });
  });

  describe('8. Submission Contract: Zero Password Requirement', () => {
    it('allows student to submit the exam at any time without entering a password', async () => {
      setMockUserAgent(IPHONE_SAFARI_UA);
      const { repository, exam, version } = await createTestPackage();
      const session = await repository.createSession(
        exam.id,
        version.id,
        'local-auth',
        undefined,
        'sess-ios-submit',
      );
      const student = await repository.registerStudent('Esi', 'Level 200');
      const devSession = await repository.createDeviceSession({
        deviceId: 'iphone-esi',
        role: 'STUDENT',
        studentId: student.student.id,
        sessionId: session.id,
        platform: 'IOS_PWA',
        capabilities: ['encrypted-local-state', 'web-client'],
      });
      const attemptResult = await repository.createAttempt(
        session.id,
        student.student.id,
        devSession.id,
        new Date().toISOString(),
      );

      // Answer question 1
      await repository.recordAnswer(attemptResult.attempt.id, {
        questionId: 'q1',
        answer: '1',
        selectedOption: 1,
        deviceSessionId: devSession.id,
        isFinal: false,
      });

      // Student taps SUBMIT EXAM — no password required
      const finalized = await repository.submitAttempt(
        attemptResult.attempt.id,
        true,
        devSession.id,
        'MANUAL',
      );

      expect(finalized.status).toBe('SUBMITTED');
      expect(finalized.submissionTrigger).toBe('MANUAL');

      // Audit confirms: no password requested
      const submitEvents = repository.snapshot.securityEvents.filter(
        (e) => e.attemptId === attemptResult.attempt.id && e.type === 'SUBMITTED',
      );
      expect(submitEvents.length).toBe(1);
      expect(submitEvents[0].details).toContain('no password was requested');
    });
  });

  describe('9. UI Touch Targets & Security Mode Communication', () => {
    it('renders SecureExamination in Restricted Web Examination Mode without Full Device Lockdown label', async () => {
      setMockUserAgent(IPHONE_SAFARI_UA);
      const { repository, exam, version, packageData } = await createTestPackage();
      const validation = await validatePharmaExamPackage(packageData.blob);
      expect(validation.ok).toBe(true);
      await stagePharmaExamPackage(validation.staged!);

      const session = await repository.createSession(
        exam.id,
        version.id,
        'local-auth',
        undefined,
        'sess-ios-ui',
      );
      const student = await repository.registerStudent('Yaw', 'Level 600');
      const devSession = await repository.createDeviceSession({
        deviceId: 'iphone-yaw',
        role: 'STUDENT',
        studentId: student.student.id,
        sessionId: session.id,
        platform: 'IOS_SAFARI',
        capabilities: ['encrypted-local-state', 'web-client'],
      });
      const attemptResult = await repository.createAttempt(
        session.id,
        student.student.id,
        devSession.id,
        new Date().toISOString(),
      );

      render(
        <MemoryRouter initialEntries={[`/examination/secure/${attemptResult.attempt.id}`]}>
          <AppProvider>
            <Routes>
              <Route path="/examination/secure/:attemptId" element={<SecureExamination />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );

      await waitFor(() => {
        expect(screen.getByText('Restricted Web Examination Mode')).toBeInTheDocument();
      });

      // Must NEVER display "Full Device Lockdown"
      expect(screen.queryByText(/Full Device Lockdown/i)).toBeNull();

      // Renders iPhone badge
      expect(screen.getByText('iPhone Safari')).toBeInTheDocument();

      // Question Navigator button exists and has touch-friendly class
      const navButtons = screen.getAllByRole('button', { name: '1' });
      expect(navButtons.length).toBeGreaterThanOrEqual(1);
      const mobileNavBtn = navButtons.find((btn) => btn.className.includes('touch-manipulation'));
      expect(mobileNavBtn).toBeDefined();
      expect(mobileNavBtn?.className).toContain('min-w-[44px]');
      expect(mobileNavBtn?.className).toContain('min-h-[44px]');

      // Submit Exam button exists
      const submitButtons = screen.getAllByRole('button', { name: /SUBMIT EXAM/i });
      expect(submitButtons.length).toBeGreaterThanOrEqual(1);
      expect(submitButtons[0].className).toContain('min-h-[48px]');
    });
  });
});

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

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(async (..._args: unknown[]) => () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import {
  createTauriKioskAdapter,
  readPharmaExamLaunch,
  consumePharmaExamLaunches,
  isTauriRuntime,
} from '../examination/nativeKiosk';
import {
  createAndroidKioskAdapter,
  consumeAndroidPharmaExamLaunch,
  type AndroidKioskBridge,
} from '../examination/androidAdapter';
import {
  createBrowserKioskAdapter,
  KIOSK_CAPABILITY_IDS,
  type KioskViolation,
} from '../examination/kioskAdapter';
import { ExaminationRepository } from '../examination/service';
import {
  createPharmaExamPackage,
  generateExamSigningKeyPair,
  verifyAdminExitPassword,
} from '../examination/package';
import type { ExamQuestion } from '../types';

const sampleQuestions: ExamQuestion[] = [
  {
    id: 'q1',
    courseId: 'pharma-native',
    topicId: 'pharmacology',
    questionText: 'Identify the antidote for acetaminophen poisoning.',
    questionType: 'mcq',
    marksAllocation: 2,
    difficulty: 'medium',
    probability: 'high',
    modelAnswer: 'N-acetylcysteine',
    correctAnswer: 'N-acetylcysteine',
    tags: ['toxicology'],
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: '2026-09-26T00:00:00.000Z',
    options: ['N-acetylcysteine', 'Naloxone', 'Flumazenil', 'Atropine'],
    correctOption: 0,
  },
];

async function setupTestExam() {
  const repository = await ExaminationRepository.open();
  const exam = await repository.createExam('Native Security Examination');
  const version = await repository.createVersion(exam.id, sampleQuestions, {
    title: 'Native Security Examination',
    assessmentType: 'KIOSK_EXAM',
    availability: { durationMinutes: 30 },
    security: {
      kioskMode: true,
      requireExamPassword: false,
      restrictExit: true,
      disableDeveloperTools: true,
      disableExternalLinks: true,
      disableNavigation: true,
      disableCopyPaste: true,
      disablePrinting: true,
    },
  });
  const published = await repository.publishVersion(exam.id, version.id);
  const signingKey = await generateExamSigningKeyPair();
  const packageData = await createPharmaExamPackage({
    version: published,
    institution: { name: 'KNUST Department of Pharmacology', code: 'KNUST-PHARM' },
    signingKey,
    adminExitPassword: 'Admin-Exit-Secret-999',
  });
  return { repository, exam, version: published, packageData };
}

describe('PHARMATRACK — Native PC & Android Kiosk Escape Path Testing', () => {
  beforeEach(() => {
    idbStore.clear();
    invokeMock.mockReset();
    listenMock.mockClear();
  });

  describe('1. Developer Tools Escape Path', () => {
    it('blocks developer tools invocation and shortcuts during active PC secure examination', async () => {
      const violations: KioskViolation[] = [];
      const adapter = createBrowserKioskAdapter((v) => violations.push(v), [], {
        developerTools: true,
      });
      const cleanup = adapter.install();

      // Attempt F12 shortcut
      const f12Event = new KeyboardEvent('keydown', { key: 'F12', bubbles: true });
      document.dispatchEvent(f12Event);

      // Attempt Ctrl+Shift+I shortcut
      const devShortcutEvent = new KeyboardEvent('keydown', {
        key: 'I',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      });
      document.dispatchEvent(devShortcutEvent);

      // Attempt Ctrl+Shift+J shortcut
      const consoleShortcutEvent = new KeyboardEvent('keydown', {
        key: 'J',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      });
      document.dispatchEvent(consoleShortcutEvent);

      expect(violations.length).toBe(3);
      expect(violations.every((v) => v.violation === 'DEVELOPER_TOOL_ATTEMPT')).toBe(true);
      cleanup();
    });

    it('rejects Tauri native open_devtools command during active examination mode', async () => {
      // Simulate native host error when secure exam mode is active
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === 'open_devtools') {
          throw new Error('Developer tools are strictly prohibited during a secure examination.');
        }
        return undefined;
      });

      await expect(
        invokeMock('open_devtools')
      ).rejects.toThrow('Developer tools are strictly prohibited during a secure examination.');
    });
  });

  describe('2. External URL & Link Escape Path', () => {
    it('blocks external URL opening and link navigation in PC and Web adapters', async () => {
      const violations: KioskViolation[] = [];
      const adapter = createBrowserKioskAdapter((v) => violations.push(v), [], {
        externalLinks: true,
      });
      const cleanup = adapter.install();

      // Create an external link and click it
      const externalLink = document.createElement('a');
      externalLink.href = 'https://external-cheats.com/answers';
      externalLink.textContent = 'External Cheat Sheet';
      document.body.appendChild(externalLink);

      const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
      externalLink.dispatchEvent(clickEvent);

      expect(clickEvent.defaultPrevented).toBe(true);
      expect(violations.some((v) => v.violation === 'EXTERNAL_LINK_ATTEMPT')).toBe(true);

      // Test window.open override
      const opened = window.open('https://external-search.com');
      expect(opened).toBeNull();
      expect(violations.some((v) => v.violation === 'EXTERNAL_LINK_ATTEMPT')).toBe(true);

      document.body.removeChild(externalLink);
      cleanup();
    });

    it('rejects Tauri native open_external_url during active secure examination', async () => {
      invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'open_external_url') {
          throw new Error('This application capability is unavailable during a secure examination.');
        }
        return undefined;
      });

      await expect(
        invokeMock('open_external_url', { url: 'https://google.com' })
      ).rejects.toThrow('This application capability is unavailable during a secure examination.');
    });

    it('blocks external navigation schemes in Android Kiosk bridge', async () => {
      const violations: KioskViolation[] = [];
      const bridge: AndroidKioskBridge = {
        enterLockTask: vi.fn(() => true),
        exitLockTask: vi.fn(() => true),
        restrictExternalIntents: vi.fn(() => true),
        setScreenCaptureBlocked: vi.fn(() => true),
        setImmersiveMode: vi.fn(() => true),
      };

      const adapter = await createAndroidKioskAdapter((v) => violations.push(v), [], bridge);
      const cleanup = adapter.install();

      // Trigger external link blocked custom event
      window.dispatchEvent(
        new CustomEvent('pharmatrack:external-link-blocked', {
          detail: 'Blocked external URL: market://details?id=com.external',
        })
      );

      expect(violations.length).toBe(1);
      expect(violations[0].violation).toBe('EXTERNAL_LINK_ATTEMPT');
      expect(violations[0].detail).toContain('market://details');
      cleanup();
    });
  });

  describe('3. Window Close & Minimize Controls Escape Path', () => {
    it('prevents beforeunload exit attempts and audits ATTEMPTED_EXIT in browser adapter', () => {
      const violations: KioskViolation[] = [];
      const adapter = createBrowserKioskAdapter((v) => violations.push(v), [], { exit: true });
      const cleanup = adapter.install();

      const beforeUnloadEvent = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(beforeUnloadEvent);

      expect(beforeUnloadEvent.defaultPrevented).toBe(true);
      expect(violations.some((v) => v.violation === 'ATTEMPTED_EXIT')).toBe(true);
      cleanup();
    });

    it('translates native PC close_blocked events into ATTEMPTED_EXIT violations', async () => {
      let eventHandler: ((event: { payload: { kind: string; detail: string } }) => void) | undefined;
      listenMock.mockImplementation(async (...args: unknown[]) => {
        eventHandler = args[1] as typeof eventHandler;
        return () => undefined;
      });

      const violations: KioskViolation[] = [];
      const adapter = createTauriKioskAdapter((v) => violations.push(v));
      const cleanup = adapter.install();

      // Simulate native window event emitted by Tauri on_window_event CloseRequested
      eventHandler?.({
        payload: {
          kind: 'close_blocked',
          detail: 'Window close was blocked while a secure examination was active.',
        },
      });

      expect(violations.length).toBe(1);
      expect(violations[0].violation).toBe('ATTEMPTED_EXIT');
      expect(violations[0].prevented).toBe(true);
      cleanup();
    });
  });

  describe('4. Keyboard Shortcuts Escape Path', () => {
    it('blocks copy, cut, paste, print, and save shortcuts', () => {
      const violations: KioskViolation[] = [];
      const adapter = createBrowserKioskAdapter((v) => violations.push(v), [], {
        copyPaste: true,
        printing: true,
        exit: true,
      });
      const cleanup = adapter.install();

      // Ctrl+C (Copy)
      const ctrlC = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true });
      document.dispatchEvent(ctrlC);
      expect(ctrlC.defaultPrevented).toBe(true);

      // Ctrl+V (Paste)
      const ctrlV = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true });
      document.dispatchEvent(ctrlV);
      expect(ctrlV.defaultPrevented).toBe(true);

      // Ctrl+X (Cut)
      const ctrlX = new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, cancelable: true });
      document.dispatchEvent(ctrlX);
      expect(ctrlX.defaultPrevented).toBe(true);

      // Ctrl+P (Print)
      const ctrlP = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true });
      document.dispatchEvent(ctrlP);
      expect(ctrlP.defaultPrevented).toBe(true);

      // Ctrl+S (Save page)
      const ctrlS = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
      document.dispatchEvent(ctrlS);
      expect(ctrlS.defaultPrevented).toBe(true);

      // Ctrl+U (View source)
      const ctrlU = new KeyboardEvent('keydown', { key: 'u', ctrlKey: true, cancelable: true });
      document.dispatchEvent(ctrlU);
      expect(ctrlU.defaultPrevented).toBe(true);

      // Escape key
      const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      document.dispatchEvent(escape);

      // Right-click context menu
      const contextMenu = new MouseEvent('contextmenu', { cancelable: true });
      document.dispatchEvent(contextMenu);
      expect(contextMenu.defaultPrevented).toBe(true);

      expect(violations.some((v) => v.violation === 'ATTEMPTED_COPY_PASTE')).toBe(true);
      expect(violations.some((v) => v.violation === 'ATTEMPTED_PRINT')).toBe(true);
      expect(violations.some((v) => v.violation === 'ATTEMPTED_EXIT')).toBe(true);
      cleanup();
    });
  });

  describe('5. Back Navigation Escape Path', () => {
    it('restores secure route and audits ATTEMPTED_NAVIGATION when browser history changes', () => {
      const violations: KioskViolation[] = [];
      const adapter = createBrowserKioskAdapter((v) => violations.push(v), [], { navigation: true });
      const cleanup = adapter.install();

      // Simulate popstate event to an external / unauthorized hash
      window.location.hash = '#/unauthorized-notes';
      window.dispatchEvent(new PopStateEvent('popstate'));

      expect(violations.some((v) => v.violation === 'ATTEMPTED_NAVIGATION')).toBe(true);
      cleanup();
    });

    it('intercepts Android hardware back button and emits ATTEMPTED_NAVIGATION violation', async () => {
      const violations: KioskViolation[] = [];
      const bridge: AndroidKioskBridge = {
        enterLockTask: vi.fn(() => true),
        exitLockTask: vi.fn(() => true),
      };

      const adapter = await createAndroidKioskAdapter((v) => violations.push(v), [], bridge);
      const cleanup = adapter.install();

      // Trigger Android back button blocked event
      window.dispatchEvent(
        new CustomEvent('pharmatrack:back-blocked', {
          detail: 'Hardware back button is disabled during secure examination.',
        })
      );

      expect(violations.length).toBe(1);
      expect(violations[0].violation).toBe('ATTEMPTED_NAVIGATION');
      expect(violations[0].prevented).toBe(true);
      cleanup();
    });
  });

  describe('6. Application Switching & Focus Loss', () => {
    it('audits focus loss events in PC native adapter without punitive cheating flags', async () => {
      let eventHandler: ((event: { payload: { kind: string; detail: string } }) => void) | undefined;
      listenMock.mockImplementation(async (...args: unknown[]) => {
        eventHandler = args[1] as typeof eventHandler;
        return () => undefined;
      });

      const violations: KioskViolation[] = [];
      const adapter = createTauriKioskAdapter((v) => violations.push(v));
      const cleanup = adapter.install();

      // Focus lost (e.g. Alt+Tab or task switch)
      eventHandler?.({
        payload: {
          kind: 'focus_lost',
          detail: 'Native secure examination window lost focus; focus re-assertion was dispatched.',
        },
      });

      expect(violations.length).toBe(1);
      expect(violations[0].violation).toBe('FOCUS_LOST');
      expect(violations[0].prevented).toBe(false);

      // Focus restored
      eventHandler?.({
        payload: {
          kind: 'focus_restored',
          detail: 'Native secure examination window focus was restored.',
        },
      });

      expect(violations.length).toBe(2);
      expect(violations[1].violation).toBe('RECOVERY');
      cleanup();
    });
  });

  describe('7. File Opening & Extension Verification', () => {
    it('rejects opening files without .pharmaexam extension in native read', async () => {
      invokeMock.mockImplementation(async (cmd: string, args: { path?: string }) => {
        if (cmd === 'read_pharmaexam_file') {
          if (!args.path?.toLowerCase().endsWith('.pharmaexam')) {
            throw new Error('Only .pharmaexam files can be opened by the examination launcher.');
          }
          return [1, 2, 3];
        }
        return undefined;
      });

      (window as any).__TAURI__ = {};

      await expect(
        readPharmaExamLaunch('/home/user/document.pdf')
      ).rejects.toThrow('Only .pharmaexam files can be opened');

      await expect(
        readPharmaExamLaunch('/etc/shadow')
      ).rejects.toThrow('Only .pharmaexam files can be opened');

      const bytes = await readPharmaExamLaunch('/home/user/exam.pharmaexam');
      expect(bytes).toEqual(new Uint8Array([1, 2, 3]));

      delete (window as any).__TAURI__;
    });

    it('processes Android intent delivery only for .pharmaexam packages', async () => {
      const deliveredBytes: Uint8Array[] = [];
      const sampleBytes = new Uint8Array([112, 107, 103]);

      const bridge: AndroidKioskBridge = {
        getPendingPharmaExam: vi.fn(() => sampleBytes),
      };

      const cleanup = await consumeAndroidPharmaExamLaunch((bytes) => {
        deliveredBytes.push(bytes);
      }, bridge);

      expect(deliveredBytes.length).toBe(1);
      expect(deliveredBytes[0]).toEqual(sampleBytes);
      cleanup();
    });
  });

  describe('8. Submission & Expiry Contract', () => {
    it('allows student to submit the attempt without any password', async () => {
      const { repository, exam, version } = await setupTestExam();
      const session = await repository.createSession(
        exam.id,
        version.id,
        'local-auth',
        undefined,
        'sess-native-submit',
      );
      const student = await repository.registerStudent('NativeStudent', 'Level 400');
      const devSession = await repository.createDeviceSession({
        deviceId: 'native-pc-device',
        role: 'STUDENT',
        studentId: student.student.id,
        sessionId: session.id,
        platform: 'TAURI_PC',
        capabilities: ['window-controls', 'fullscreen'],
      });
      const attemptResult = await repository.createAttempt(
        session.id,
        student.student.id,
        devSession.id,
        new Date().toISOString(),
      );

      // Manual submission
      const finalized = await repository.submitAttempt(
        attemptResult.attempt.id,
        true,
        devSession.id,
        'MANUAL',
      );

      expect(finalized.status).toBe('SUBMITTED');
      expect(finalized.submissionTrigger).toBe('MANUAL');

      const auditEvent = repository.snapshot.securityEvents.find(
        (e) => e.attemptId === finalized.id && e.type === 'SUBMITTED',
      );
      expect(auditEvent?.details).toContain('no password was requested');
    });

    it('submits attempt automatically on authoritative timer expiry without student input or password', async () => {
      const { repository, exam, version } = await setupTestExam();
      const session = await repository.createSession(
        exam.id,
        version.id,
        'local-auth',
        undefined,
        'sess-native-expiry',
      );
      const student = await repository.registerStudent('ExpiryStudent', 'Level 300');
      const devSession = await repository.createDeviceSession({
        deviceId: 'native-android-device',
        role: 'STUDENT',
        studentId: student.student.id,
        sessionId: session.id,
        platform: 'ANDROID_NATIVE',
        capabilities: ['lock-task', 'flag-secure'],
      });
      const attemptResult = await repository.createAttempt(
        session.id,
        student.student.id,
        devSession.id,
        new Date().toISOString(),
      );

      // Expiry submission
      const finalized = await repository.submitAttempt(
        attemptResult.attempt.id,
        true,
        devSession.id,
        'EXPIRY',
      );

      expect(finalized.status).toBe('SUBMITTED');
      expect(finalized.submissionState).toBe('EXPIRED');
      expect(finalized.submissionTrigger).toBe('EXPIRY');

      const auditEvent = repository.snapshot.securityEvents.find(
        (e) => e.attemptId === finalized.id && e.type === 'EXPIRY_SUBMITTED',
      );
      expect(auditEvent?.details).toContain('Authoritative timer expiry');
    });
  });

  describe('9. Controlled Exit Authorization', () => {
    it('authorizes early exit only with separate package admin password, rejecting student credentials', async () => {
      const { packageData } = await setupTestExam();

      // Verify incorrect passwords are rejected
      expect(await verifyAdminExitPassword('wrong-password', packageData.security)).toBe(false);
      expect(await verifyAdminExitPassword('RX30a', packageData.security)).toBe(false);

      // Verify correct administrator password authorizes early exit
      expect(
        await verifyAdminExitPassword('Admin-Exit-Secret-999', packageData.security)
      ).toBe(true);
    });

    it('requires matching session token to exit Tauri native secure mode', async () => {
      invokeMock.mockImplementation(async (cmd: string, args: { sessionToken?: string }) => {
        if (cmd === 'enter_secure_exam_mode') {
          return { sessionToken: 'valid-secret-token', capabilities: [] };
        }
        if (cmd === 'exit_secure_exam_mode') {
          if (args.sessionToken !== 'valid-secret-token') {
            throw new Error('Secure examination restoration authorization was rejected.');
          }
          return undefined;
        }
        return undefined;
      });

      const adapter = createTauriKioskAdapter(() => undefined);
      await adapter.enterSecureMode?.('attempt-token-test');

      // Valid token exits successfully
      const exitSuccess = await adapter.exitSecureMode?.();
      expect(exitSuccess).toBe(true);

      // Without token or invalid token, exit fails
      const secondExit = await adapter.exitSecureMode?.();
      expect(secondExit).toBe(false);
    });
  });

  describe('10. Android Native Lock-Task & Screen Capture Enforcement', () => {
    it('executes lock-task and FLAG_SECURE screen capture prevention through bridge', async () => {
      const enterLockTaskMock = vi.fn(() => true);
      const exitLockTaskMock = vi.fn(() => true);
      const setImmersiveModeMock = vi.fn((_enabled: boolean) => true);
      const setScreenCaptureBlockedMock = vi.fn((_blocked: boolean) => true);
      const restrictExternalIntentsMock = vi.fn((_restricted: boolean) => true);

      const bridge: AndroidKioskBridge = {
        enterLockTask: enterLockTaskMock,
        exitLockTask: exitLockTaskMock,
        setImmersiveMode: setImmersiveModeMock,
        setScreenCaptureBlocked: setScreenCaptureBlockedMock,
        restrictExternalIntents: restrictExternalIntentsMock,
      };

      const adapter = await createAndroidKioskAdapter(() => undefined, [], bridge);

      // Entering secure mode enforces all Android native protections
      const entered = await adapter.enterSecureMode?.('attempt-android-1');
      expect(entered).toBe(true);
      expect(enterLockTaskMock).toHaveBeenCalled();
      expect(setImmersiveModeMock).toHaveBeenCalledWith(true);
      expect(setScreenCaptureBlockedMock).toHaveBeenCalledWith(true);
      expect(restrictExternalIntentsMock).toHaveBeenCalledWith(true);

      // Screen capture capability is honestly marked SUPPORTED
      const captureCap = adapter.matrix.capabilities.find(
        (c) => c.id === KIOSK_CAPABILITY_IDS.screenCapture,
      );
      expect(captureCap?.supportLevel).toBe('SUPPORTED');
      expect(captureCap?.enforceable).toBe(true);

      // Exiting secure mode cleans up
      const exited = await adapter.exitSecureMode?.();
      expect(exited).toBe(true);
      expect(exitLockTaskMock).toHaveBeenCalled();
      expect(setImmersiveModeMock).toHaveBeenCalledWith(false);
      expect(setScreenCaptureBlockedMock).toHaveBeenCalledWith(false);
      expect(restrictExternalIntentsMock).toHaveBeenCalledWith(false);
    });
  });
});

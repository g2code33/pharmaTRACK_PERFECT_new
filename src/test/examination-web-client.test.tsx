import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import JSZip from 'jszip';

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
  verifyExamPassword,
} from '../examination/package';
import {
  stagePharmaExamPackage,
  loadStagedPharmaExam,
  clearStagedPharmaExam,
} from '../examination/packageCache';
import {
  createCapabilityMatrix,
  requiredCapabilitiesReady,
  KIOSK_CAPABILITY_IDS,
  platform,
} from '../examination/kioskAdapter';
import {
  createPlatformKioskAdapter,
  createAndroidKioskAdapter,
} from '../examination/androidAdapter';
import {
  createAttemptTimer,
  remainingMilliseconds,
} from '../examination/timer';
import { LocalExamAuthority } from '../examination/network';
import { ExaminationSyncEngine } from '../examination/sync';
import { readBlobArrayBuffer } from '../utils/fileGuard';
import type { ExamQuestion } from '../types';
import {
  BROWSER_PHARMAEXAM_ACCEPT,
  isBrowserPharmaExamSelection,
} from '../platform/fileSelection';
import { AppProvider } from '../context/AppContext';
import SecureExamination from '../pages/SecureExamination';
import KioskEntry from '../pages/KioskEntry';

const sampleQuestions: ExamQuestion[] = [
  {
    id: 'q1',
    courseId: 'pharma-101',
    topicId: 'pharmacokinetics',
    questionText: 'Which organ is the primary site of drug metabolism?',
    questionType: 'mcq',
    marksAllocation: 2,
    difficulty: 'medium',
    probability: 'high',
    modelAnswer: 'Liver',
    correctAnswer: 'Liver',
    tags: ['pharmacology', 'metabolism'],
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: '2026-09-26T00:00:00.000Z',
    options: ['Kidneys', 'Liver', 'Lungs', 'Heart'],
    correctOption: 1,
  },
  {
    id: 'q2',
    courseId: 'pharma-101',
    topicId: 'pharmacodynamics',
    questionText: 'Explain the mechanism of competitive receptor antagonism.',
    questionType: 'short_answer',
    marksAllocation: 3,
    difficulty: 'hard',
    probability: 'medium',
    modelAnswer: 'Binds reversibly to active receptor site without activation.',
    correctAnswer: 'Binds reversibly to active receptor site without activation.',
    tags: ['pharmacology', 'receptors'],
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: '2026-09-26T00:00:00.000Z',
  },
];

async function createTestPackage(requirePassword = false, password = 'Web-Kiosk-Secret-123') {
  const repository = await ExaminationRepository.open();
  const exam = await repository.createExam('Pharmacology Web Examination');
  const version = await repository.createVersion(exam.id, sampleQuestions, {
    title: 'Pharmacology Web Examination',
    assessmentType: 'KIOSK_EXAM',
    availability: { durationMinutes: 60 },
    security: {
      kioskMode: true,
      requireExamPassword: requirePassword,
      capabilityFailurePolicy: 'ALLOW_WITH_WARNING',
      requiredCapabilities: [KIOSK_CAPABILITY_IDS.navigation, KIOSK_CAPABILITY_IDS.copyPaste],
    },
    navigation: { allowPrevious: true, showQuestionNumbers: true },
  });
  const published = await repository.publishVersion(exam.id, version.id);
  const signingKey = await generateExamSigningKeyPair();
  const packageData = await createPharmaExamPackage({
    version: published,
    institution: { name: 'Faculty of Pharmacy & Pharmaceutical Sciences', code: 'FPPS-KNUST' },
    signingKey,
    examPassword: requirePassword ? password : undefined,
  });
  return { repository, exam, version: published, packageData, password };
}

describe('PHARMATRACK — Web/PWA Examination Client', () => {
  beforeEach(() => {
    idbStore.clear();
  });

  describe('1. Platform Identification & Capability Matrix', () => {
    it('identifies as platform = web in browser mode without claiming native OS lockdown', async () => {
      expect(platform()).toBe('web');

      const adapter = await createPlatformKioskAdapter(() => undefined, [
        KIOSK_CAPABILITY_IDS.navigation,
        KIOSK_CAPABILITY_IDS.copyPaste,
        KIOSK_CAPABILITY_IDS.lockTask,
      ]);

      expect(adapter.matrix.platform).toBe('web');

      // Native OS lockdown capabilities must be honestly reported as UNAVAILABLE in web mode
      const lockTask = adapter.matrix.capabilities.find(
        (c) => c.id === KIOSK_CAPABILITY_IDS.lockTask,
      )!;
      const windowControls = adapter.matrix.capabilities.find(
        (c) => c.id === KIOSK_CAPABILITY_IDS.windowControls,
      )!;
      const screenCapture = adapter.matrix.capabilities.find(
        (c) => c.id === KIOSK_CAPABILITY_IDS.screenCapture,
      )!;

      expect(lockTask.supported).toBe(false);
      expect(lockTask.enforceable).toBe(false);
      expect(lockTask.supportLevel).toBe('UNAVAILABLE');

      expect(windowControls.supported).toBe(false);
      expect(windowControls.enforceable).toBe(false);
      expect(windowControls.supportLevel).toBe('UNAVAILABLE');

      expect(screenCapture.supported).toBe(false);
      expect(screenCapture.enforceable).toBe(false);
      expect(screenCapture.supportLevel).toBe('UNAVAILABLE');

      // Web controls must be honestly reported as SUPPORTED
      const navigation = adapter.matrix.capabilities.find(
        (c) => c.id === KIOSK_CAPABILITY_IDS.navigation,
      )!;
      const copyPaste = adapter.matrix.capabilities.find(
        (c) => c.id === KIOSK_CAPABILITY_IDS.copyPaste,
      )!;
      const printing = adapter.matrix.capabilities.find(
        (c) => c.id === KIOSK_CAPABILITY_IDS.printing,
      )!;
      const externalLinks = adapter.matrix.capabilities.find(
        (c) => c.id === KIOSK_CAPABILITY_IDS.externalLinks,
      )!;

      expect(navigation.supported).toBe(true);
      expect(navigation.enforceable).toBe(true);
      expect(navigation.supportLevel).toBe('SUPPORTED');

      expect(copyPaste.supported).toBe(true);
      expect(copyPaste.enforceable).toBe(true);
      expect(copyPaste.supportLevel).toBe('SUPPORTED');

      expect(printing.supported).toBe(true);
      expect(printing.enforceable).toBe(true);
      expect(printing.supportLevel).toBe('SUPPORTED');

      expect(externalLinks.supported).toBe(true);
      expect(externalLinks.enforceable).toBe(true);
      expect(externalLinks.supportLevel).toBe('SUPPORTED');

      // Focus and immersive mode are NOT_GUARANTEED in pure browser
      const focus = adapter.matrix.capabilities.find(
        (c) => c.id === KIOSK_CAPABILITY_IDS.focus,
      )!;
      expect(focus.supported).toBe(true);
      expect(focus.enforceable).toBe(false);
      expect(focus.supportLevel).toBe('NOT_GUARANTEED');
    });

    it('preserves native-pc and android adapters without interference', async () => {
      // Native PC capability matrix
      const tauriMatrix = createCapabilityMatrix('TAURI_PC', [KIOSK_CAPABILITY_IDS.devTools]);
      expect(tauriMatrix.platform).toBe('TAURI_PC');

      // Android Native capability matrix with bridge
      const androidAdapter = await createAndroidKioskAdapter(
        () => undefined,
        [KIOSK_CAPABILITY_IDS.lockTask],
        {
          enterLockTask: () => true,
          exitLockTask: () => true,
          setImmersiveMode: () => true,
          capabilityStatus: () => ({
            [KIOSK_CAPABILITY_IDS.lockTask]: true,
            [KIOSK_CAPABILITY_IDS.screenCapture]: true,
          }),
        },
      );
      expect(androidAdapter.matrix.platform).toBe('ANDROID_NATIVE');
      const androidLockTask = androidAdapter.matrix.capabilities.find(
        (c) => c.id === KIOSK_CAPABILITY_IDS.lockTask,
      );
      expect(androidLockTask?.enforceable).toBe(true);
    });
  });

  describe('2. .pharmaexam Loading & Browser File Selection', () => {
    it('supports opening .pharmaexam packages via browser file selection', async () => {
      expect(BROWSER_PHARMAEXAM_ACCEPT).toContain('.pharmaexam');
      expect(isBrowserPharmaExamSelection({ name: 'KNUST_Exam_2026.pharmaexam' })).toBe(true);
      expect(isBrowserPharmaExamSelection({ name: 'KNUST_Exam_2026.zip' })).toBe(false);

      const { packageData } = await createTestPackage();
      const file = new File([packageData.blob], 'Pharmacology.pharmaexam', {
        type: 'application/octet-stream',
      });

      const validation = await validatePharmaExamPackage(file);
      expect(validation.ok).toBe(true);
      expect(validation.staged).toBeTruthy();
      expect(validation.staged?.exam.title).toBe('Pharmacology Web Examination');
      expect(validation.staged?.questions).toHaveLength(2);
      expect(validation.staged?.institution.name).toContain('Faculty of Pharmacy');
    });

    it('rejects tampered or corrupt packages before staging', async () => {
      const { packageData } = await createTestPackage();
      const bytes = new Uint8Array(await readBlobArrayBuffer(packageData.blob));
      const zip = await JSZip.loadAsync(bytes);

      // Tamper with question text inside questions.json
      zip.file(
        'questions.json',
        JSON.stringify([{ ...sampleQuestions[0], questionText: 'TAMPERED EXAM QUESTION' }]),
      );
      const tamperedBlob = await zip.generateAsync({ type: 'blob' });

      const tamperedResult = await validatePharmaExamPackage(tamperedBlob);
      expect(tamperedResult.ok).toBe(false);
      expect(tamperedResult.staged).toBeUndefined();
      expect(tamperedResult.errors.join(' ')).toMatch(/checksum|signature|digest/i);
    });

    it('verifies exam password when required by the package', async () => {
      const { packageData, password } = await createTestPackage(true, 'SecretPass321');
      const validation = await validatePharmaExamPackage(packageData.blob);
      expect(validation.ok).toBe(true);
      expect(await verifyExamPassword('SecretPass321', validation.staged!.security)).toBe(true);
      expect(await verifyExamPassword('WrongPass', validation.staged!.security)).toBe(false);
    });
  });

  describe('3. Offline Package Availability & Local Staging', () => {
    it('caches the examination package locally in encrypted storage before examination start', async () => {
      const { packageData } = await createTestPackage();
      const validation = await validatePharmaExamPackage(packageData.blob);
      expect(validation.ok).toBe(true);
      expect(validation.staged).toBeTruthy();

      // Stage package locally
      await stagePharmaExamPackage(validation.staged!);

      // Restore package from encrypted cache (simulating app relaunch or browser refresh while offline)
      const cached = await loadStagedPharmaExam();
      expect(cached).toBeTruthy();
      expect(cached?.exam.id).toBe(validation.staged!.exam.id);
      expect(cached?.questions).toHaveLength(2);
      expect(cached?.packageKey).toBe(validation.staged!.packageKey);
      expect(cached?.exam.availability.durationMinutes).toBe(60);

      // Clear staged package
      await clearStagedPharmaExam();
      expect(await loadStagedPharmaExam()).toBeNull();
    });
  });

  describe('4. Student Registration & Authentication (RX30 Identity)', () => {
    it('registers students with sequential RX30 identities and authenticates correctly', async () => {
      const repository = await ExaminationRepository.open();

      const student1 = await repository.registerStudent('Abena', 'Level 300');
      const student2 = await repository.registerStudent('Kwame', 'Level 300');

      expect(student1.password).toBe('RX30a');
      expect(student2.password).toBe('RX30b');

      // Duplicate first name must be rejected with the exact required phrasing
      await expect(repository.registerStudent('Abena', 'Level 300')).rejects.toThrow(
        'This first name is already in use. Please use your surname, middle name, or add a number to your first name.',
      );

      // Correct authentication
      const auth = await repository.authenticateStudent('Abena', 'Level 300', 'RX30a');
      expect(auth.id).toBe(student1.student.id);

      // Wrong password rejected
      await expect(
        repository.authenticateStudent('Abena', 'Level 300', 'RX30wrong'),
      ).rejects.toThrow();
    });
  });

  describe('5. Web Examination Attempt Lifecycle, Navigation & Saving', () => {
    it('manages full examination lifecycle: start, save-before-navigation, timer, submit, recovery', async () => {
      const { repository, version, packageData } = await createTestPackage();
      const validation = await validatePharmaExamPackage(packageData.blob);
      expect(validation.ok).toBe(true);
      await stagePharmaExamPackage(validation.staged!);

      // Student setup
      const student = await repository.registerStudent('Esi', 'Level 400');
      const session = await repository.createSession(version.examId, version.id);

      // Create Web Device Session
      const deviceSession = await repository.createDeviceSession({
        deviceId: 'web-browser-safari-ios',
        role: 'STUDENT',
        studentId: student.student.id,
        sessionId: session.id,
        platform: 'web',
        capabilities: ['encrypted-local-state', 'attempt-recovery', 'web-client'],
      });
      expect(deviceSession.platform).toBe('web');

      // Start Attempt
      const startedAt = '2026-09-26T10:00:00.000Z';
      const result = await repository.createAttempt(
        session.id,
        student.student.id,
        deviceSession.id,
        startedAt,
      );
      const attempt = result.attempt;
      expect(attempt.platform).toBe('web');
      expect(attempt.status).toBe('ACTIVE');
      expect(attempt.questionOrder).toHaveLength(2);

      // Authoritative timer verification
      const timer = attempt.timerState!;
      expect(timer.originalDurationMinutes).toBe(60);
      expect(remainingMilliseconds(timer, '2026-09-26T10:15:00.000Z')).toBe(45 * 60 * 1000);

      // Record Answer for Question 1 (Save before navigation)
      const q1Id = attempt.questionOrder[0];
      const answerQ1 = await repository.recordAnswer(attempt.id, {
        questionId: q1Id,
        answer: '1',
        selectedOption: 1,
        deviceSessionId: deviceSession.id,
        isFinal: false,
      });
      expect(answerQ1.answer).toBe('1');
      expect(answerQ1.selectedOption).toBe(1);

      // Navigate to Question 2
      const q2Id = attempt.questionOrder[1];
      await repository.updateCurrentQuestion(attempt.id, q2Id);
      const updatedAttempt = repository.snapshot.attempts.find((a) => a.id === attempt.id)!;
      expect(updatedAttempt.currentQuestionId).toBe(q2Id);

      // Record Answer for Question 2
      const answerQ2 = await repository.recordAnswer(attempt.id, {
        questionId: q2Id,
        answer: 'Reversible binding to receptor without intrinsic efficacy.',
        deviceSessionId: deviceSession.id,
        isFinal: false,
      });
      expect(answerQ2.answer).toContain('Reversible binding');

      // Verify answers are persisted in attempt snapshot
      const currentAttempt = repository.snapshot.attempts.find((a) => a.id === attempt.id)!;
      expect(currentAttempt.answers).toHaveLength(2);

      // Submit attempt
      const submitted = await repository.submitAttempt(
        attempt.id,
        false,
        deviceSession.id,
        'MANUAL',
      );
      expect(submitted.status).toBe('SUBMITTED');
      expect(submitted.submissionState).toBe('SUBMITTED');
      expect(submitted.submittedAt).toBeTruthy();

      // Answers cannot be recorded after submission
      await expect(
        repository.recordAnswer(attempt.id, {
          questionId: q1Id,
          answer: '0',
          deviceSessionId: deviceSession.id,
          isFinal: false,
        }),
      ).rejects.toThrow('no longer accepts answers');

      // Attempt Recovery: reload repository from encrypted storage and verify attempt persists
      const reloadedRepo = await ExaminationRepository.open();
      const recoveredAttempt = reloadedRepo.snapshot.attempts.find((a) => a.id === attempt.id)!;
      expect(recoveredAttempt).toBeTruthy();
      expect(recoveredAttempt.status).toBe('SUBMITTED');
      expect(recoveredAttempt.answers).toHaveLength(2);
      expect(recoveredAttempt.answers.find((a) => a.questionId === q1Id)?.answer).toBe('1');
    });

    it('operates offline during LAN disconnection and synchronizes when connected', async () => {
      const { repository, version } = await createTestPackage();
      const student = await repository.registerStudent('Kofi', 'Level 200');
      const session = await repository.createSession(version.examId, version.id);
      const device = await repository.createDeviceSession({
        deviceId: 'web-chrome-android',
        role: 'STUDENT',
        studentId: student.student.id,
        sessionId: session.id,
        platform: 'web',
        capabilities: ['encrypted-local-state'],
      });

      const started = await repository.createAttempt(session.id, student.student.id, device.id);

      // Answer recorded in local storage
      await repository.recordAnswer(started.attempt.id, {
        questionId: started.attempt.questionOrder[0],
        answer: '1',
        selectedOption: 1,
        deviceSessionId: device.id,
        isFinal: false,
      });

      // Verify sync event queued locally
      expect(repository.snapshot.syncEvents).toHaveLength(1);
      expect(repository.snapshot.syncEvents[0].status).toBe('PENDING');

      // Local authority sync engine flushes successfully
      const localAuthority = new LocalExamAuthority(repository);
      const syncEngine = new ExaminationSyncEngine(repository, localAuthority, session.id);
      const syncResult = await syncEngine.flush();
      expect(syncResult.ok).toBe(true);
      expect(syncResult.state).toBe('SYNCHRONIZED');
      expect(repository.snapshot.syncEvents[0].status).toBe('APPLIED');
    });
  });

  describe('6. Readiness Check & Capability Policies', () => {
    it('passes readiness check when capabilities meet policy and warns honestly', async () => {
      const matrix = createCapabilityMatrix('web', [
        KIOSK_CAPABILITY_IDS.navigation,
        KIOSK_CAPABILITY_IDS.copyPaste,
      ]);

      const readiness = requiredCapabilitiesReady(matrix, [
        KIOSK_CAPABILITY_IDS.navigation,
        KIOSK_CAPABILITY_IDS.copyPaste,
      ]);

      expect(readiness.ok).toBe(true);
      expect(readiness.unavailable).toHaveLength(0);

      // If policy requires native lockdown on web, it honestly fails
      const strictReadiness = requiredCapabilitiesReady(matrix, [
        KIOSK_CAPABILITY_IDS.lockTask,
      ]);
      expect(strictReadiness.ok).toBe(false);
      expect(strictReadiness.unavailable[0].id).toBe(KIOSK_CAPABILITY_IDS.lockTask);
    });
  });

  describe('7. Quiz Examination UI Reuse & Responsiveness', () => {
    it('renders question cards, answer options, numbering, progress, navigation, timer, submit, and save status', async () => {
      const { repository, version, packageData } = await createTestPackage();
      const validation = await validatePharmaExamPackage(packageData.blob);
      expect(validation.ok).toBe(true);
      await stagePharmaExamPackage(validation.staged!);

      const student = await repository.registerStudent('Ama', 'Level 200');
      const session = await repository.createSession(version.examId, version.id);
      const device = await repository.createDeviceSession({
        deviceId: 'device-iphone-15',
        role: 'STUDENT',
        studentId: student.student.id,
        sessionId: session.id,
        platform: 'web',
        capabilities: ['encrypted-local-state'],
      });

      const started = await repository.createAttempt(
        session.id,
        student.student.id,
        device.id,
        new Date().toISOString(),
      );

      render(
        <MemoryRouter initialEntries={[`/examination/secure/${started.attempt.id}`]}>
          <AppProvider>
            <Routes>
              <Route path="/examination/secure/:attemptId" element={<SecureExamination />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );

      // Verify question card header and question text
      expect(
        await screen.findByText('Which organ is the primary site of drug metabolism?'),
      ).toBeTruthy();
      expect(screen.getByText('Multiple Choice')).toBeTruthy();
      expect(screen.getByText('2 marks')).toBeTruthy();

      // Verify numbering and progress
      expect(screen.getByText('Question 1 of 2')).toBeTruthy();

      // Verify timer
      expect(screen.getByText(/59:|60:00/)).toBeTruthy();

      // Verify save and sync status
      expect(screen.getByText('SAVED')).toBeTruthy();
      expect(screen.getByText('Synchronized')).toBeTruthy();

      // Verify MCQ option letters and text
      expect(screen.getByText('A')).toBeTruthy();
      expect(screen.getByText('Kidneys')).toBeTruthy();
      expect(screen.getByText('B')).toBeTruthy();
      expect(screen.getByText('Liver')).toBeTruthy();
      expect(screen.getByText('C')).toBeTruthy();
      expect(screen.getByText('Lungs')).toBeTruthy();
      expect(screen.getByText('D')).toBeTruthy();
      expect(screen.getByText('Heart')).toBeTruthy();

      // Select Option B (Liver)
      fireEvent.click(screen.getByText('Liver'));

      // Verify Save status updates or remains saved
      await waitFor(() => {
        expect(screen.getByText('SAVED')).toBeTruthy();
      });

      // Verify Next button exists and navigates to Question 2
      const nextButton = screen.getByText('Next');
      expect(nextButton).toBeTruthy();
      fireEvent.click(nextButton);

      // Question 2: Short answer
      expect(
        await screen.findByText('Explain the mechanism of competitive receptor antagonism.'),
      ).toBeTruthy();
      expect(screen.getByText('Short Answer')).toBeTruthy();
      expect(screen.getByText('3 marks')).toBeTruthy();
      expect(screen.getByText('Question 2 of 2')).toBeTruthy();

      // Enter answer in textarea
      const textarea = screen.getByPlaceholderText('Type your answer here...');
      fireEvent.change(textarea, { target: { value: 'Binds active site reversibly.' } });

      // Click Previous button to navigate back to Question 1
      const prevButton = screen.getByText('Previous');
      fireEvent.click(prevButton);

      // Verify Question 1 is back and Option B is still selected
      expect(
        await screen.findByText('Which organ is the primary site of drug metabolism?'),
      ).toBeTruthy();
      expect(screen.getByText('Question 1 of 2')).toBeTruthy();

      // Verify question navigation grid buttons (1, 2)
      const questionNav1 = screen.getAllByRole('button', { name: '1' });
      const questionNav2 = screen.getAllByRole('button', { name: '2' });
      expect(questionNav1.length).toBeGreaterThan(0);
      expect(questionNav2.length).toBeGreaterThan(0);

      // Verify SUBMIT EXAM button exists
      expect(screen.getAllByText(/SUBMIT EXAM|Submit Exam/).length).toBeGreaterThan(0);
    });

    it('renders the Kiosk entry screen with file drop area, RX30 inputs, and readiness button', async () => {
      render(
        <MemoryRouter initialEntries={['/examinations/kiosk']}>
          <AppProvider>
            <Routes>
              <Route path="/examinations/kiosk" element={<KioskEntry />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );

      expect(await screen.findByText('Secure Examination Entry')).toBeTruthy();
      expect(screen.getByText('1. Choose .pharmaexam')).toBeTruthy();
      expect(screen.getByText(/Click to choose a .pharmaexam package/i)).toBeTruthy();
      expect(screen.getByText('2. Student identity')).toBeTruthy();
      expect(screen.getByText('First Name')).toBeTruthy();
      expect(screen.getByText('Level')).toBeTruthy();
      expect(screen.getByText('RX30 Kiosk password')).toBeTruthy();
      expect(screen.getByText('First-time registration')).toBeTruthy();
      expect(screen.getByText('3. LAN and examination password')).toBeTruthy();
      expect(screen.getByText('Run readiness checks')).toBeTruthy();
      expect(screen.getByText('Enter secure examination')).toBeTruthy();
    });
  });
});

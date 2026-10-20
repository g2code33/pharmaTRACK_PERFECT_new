import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Kiosk exams, registration, and login stay fully offline — this file only
 * covers the ONE opt-in piece that may ever touch the network: an
 * administrator pushing/reading an all-time results log from their own
 * PharmaTrack account. The Supabase RPC boundary is mocked; RLS/SECURITY
 * DEFINER behavior lives in supabase/kiosk-exam-results.sql and needs
 * deployment-level validation against the real project.
 */
const { rpcMock, getAuthenticatedUserMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  getAuthenticatedUserMock: vi.fn(),
}));

vi.mock('../utils/supabase', () => ({
  supabase: { rpc: rpcMock },
}));

vi.mock('../auth/authService', () => ({
  getAuthenticatedUser: getAuthenticatedUserMock,
}));

import {
  buildKioskResultSyncItems,
  fetchCloudKioskResults,
  pushKioskResultsToCloud,
} from '../examination/resultsCloudSync';
import type { ExaminationResult, ExamStudent, ExamVersion } from '../examination/types';

const originalOnLine = navigator.onLine;

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

beforeEach(() => {
  rpcMock.mockReset();
  getAuthenticatedUserMock.mockReset();
  setOnline(true);
});

afterEach(() => {
  setOnline(originalOnLine);
});

const student = { id: 's1', firstName: 'Efua', level: 'Level 300' } as ExamStudent;
const version = { id: 'v1', title: 'Pharmacology Finals' } as ExamVersion;
const result = {
  id: 'result:attempt-1',
  studentId: 's1',
  examVersionId: 'v1',
  percentage: 87,
  submittedAt: '2026-10-19T10:00:00.000Z',
} as ExaminationResult;

describe('kiosk exam results — cloud sync (admin opt-in only)', () => {
  it('builds non-sensitive sync items from local examination state', () => {
    const items = buildKioskResultSyncItems([result], [student], [version]);
    expect(items).toEqual([
      {
        resultKey: 'result:attempt-1',
        studentFirstName: 'Efua',
        studentLevel: 'Level 300',
        examTitle: 'Pharmacology Finals',
        scorePercentage: 87,
        submittedAt: '2026-10-19T10:00:00.000Z',
      },
    ]);
  });

  it('skips a result whose student or version record is missing locally', () => {
    expect(buildKioskResultSyncItems([result], [], [version])).toHaveLength(0);
    expect(buildKioskResultSyncItems([result], [student], [])).toHaveLength(0);
  });

  it('refuses to push while offline, without touching the network', async () => {
    setOnline(false);
    const outcome = await pushKioskResultsToCloud([
      {
        resultKey: 'r1',
        studentFirstName: 'Efua',
        studentLevel: 'Level 300',
        examTitle: 'Finals',
        scorePercentage: 90,
        submittedAt: '2026-10-19T10:00:00.000Z',
      },
    ]);
    expect(outcome).toEqual({ ok: false, reason: 'offline' });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('refuses to push while signed out', async () => {
    getAuthenticatedUserMock.mockResolvedValue(null);
    const outcome = await pushKioskResultsToCloud([
      {
        resultKey: 'r1',
        studentFirstName: 'Efua',
        studentLevel: 'Level 300',
        examTitle: 'Finals',
        scorePercentage: 90,
        submittedAt: '2026-10-19T10:00:00.000Z',
      },
    ]);
    expect(outcome).toEqual({ ok: false, reason: 'signed-out' });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('pushes each result via the push_kiosk_exam_result RPC when signed in and online', async () => {
    getAuthenticatedUserMock.mockResolvedValue({ id: 'admin-1' });
    rpcMock.mockResolvedValue({ data: {}, error: null });
    const outcome = await pushKioskResultsToCloud(
      [
        {
          resultKey: 'r1',
          studentFirstName: 'Efua',
          studentLevel: 'Level 300',
          examTitle: 'Finals',
          scorePercentage: 90,
          submittedAt: '2026-10-19T10:00:00.000Z',
        },
      ],
      'kiosk-admin-device',
    );
    expect(outcome).toEqual({ ok: true, synced: 1, failed: 0 });
    expect(rpcMock).toHaveBeenCalledWith('push_kiosk_exam_result', {
      p_result_key: 'r1',
      p_student_first_name: 'Efua',
      p_student_level: 'Level 300',
      p_exam_title: 'Finals',
      p_score_percentage: 90,
      p_submitted_at: '2026-10-19T10:00:00.000Z',
      p_device_label: 'kiosk-admin-device',
    });
  });

  it('counts a failed row without losing the rest', async () => {
    getAuthenticatedUserMock.mockResolvedValue({ id: 'admin-1' });
    rpcMock
      .mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
      .mockResolvedValueOnce({ data: {}, error: null });
    const outcome = await pushKioskResultsToCloud([
      {
        resultKey: 'bad',
        studentFirstName: 'A',
        studentLevel: 'Level 100',
        examTitle: 'X',
        scorePercentage: 10,
        submittedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        resultKey: 'good',
        studentFirstName: 'B',
        studentLevel: 'Level 100',
        examTitle: 'X',
        scorePercentage: 50,
        submittedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(outcome).toEqual({ ok: true, synced: 1, failed: 1 });
  });

  it('reads back results scoped to the signed-in account', async () => {
    getAuthenticatedUserMock.mockResolvedValue({ id: 'admin-1' });
    rpcMock.mockResolvedValue({
      data: [
        {
          result_key: 'r1',
          student_first_name: 'Efua',
          student_level: 'Level 300',
          exam_title: 'Finals',
          exam_key: '',
          score_percentage: '90',
          submitted_at: '2026-10-19T10:00:00.000Z',
          device_label: 'kiosk-admin-device',
        },
      ],
      error: null,
    });
    const outcome = await fetchCloudKioskResults();
    expect(outcome).toEqual({
      ok: true,
      results: [
        {
          resultKey: 'r1',
          studentFirstName: 'Efua',
          studentLevel: 'Level 300',
          examTitle: 'Finals',
          examKey: '',
          scorePercentage: 90,
          submittedAt: '2026-10-19T10:00:00.000Z',
          deviceLabel: 'kiosk-admin-device',
        },
      ],
    });
    expect(rpcMock).toHaveBeenCalledWith('list_kiosk_exam_results');
  });

  it('refuses to read while signed out', async () => {
    getAuthenticatedUserMock.mockResolvedValue(null);
    const outcome = await fetchCloudKioskResults();
    expect(outcome).toEqual({ ok: false, reason: 'signed-out' });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

/**
 * All-time kiosk exam results — the ONE piece of examination data that may
 * ever leave the device, and only when the administrator explicitly asks.
 *
 * Taking a kiosk exam, logging in, registering, and viewing a live LAN
 * session stay entirely offline and need no account — this module is not on
 * that path and is never called automatically for a student. It exists so
 * an administrator with a PharmaTRACK account can keep a durable "which
 * student, which exam, which score, when" log that is readable from
 * anywhere with internet, not only from a device that happened to be on the
 * exam LAN. Nothing else (questions, answers, security events) is sent.
 */
import { supabase } from '../utils/supabase';
import { checkCloudAccess, type AuthGateResult } from '../utils/requireAuth';
import type { ExaminationResult, ExamStudent, ExamVersion } from './types';

export interface KioskResultToSync {
  resultKey: string;
  studentFirstName: string;
  studentLevel: string;
  examTitle: string;
  scorePercentage: number;
  submittedAt: string;
}

export interface CloudKioskResult {
  resultKey: string;
  studentFirstName: string;
  studentLevel: string;
  examTitle: string;
  scorePercentage: number;
  submittedAt: string;
  deviceLabel?: string | null;
}

export type CloudAccessFailure = Extract<AuthGateResult, { ok: false }>;

export type PushKioskResultsOutcome =
  | { ok: true; synced: number; failed: number }
  | CloudAccessFailure;

export type FetchKioskResultsOutcome =
  | { ok: true; results: CloudKioskResult[] }
  | CloudAccessFailure;

/** Builds the (non-sensitive) rows worth syncing from local examination state. */
export function buildKioskResultSyncItems(
  results: readonly ExaminationResult[],
  students: readonly ExamStudent[],
  versions: readonly ExamVersion[],
): KioskResultToSync[] {
  const items: KioskResultToSync[] = [];
  for (const result of results) {
    const student = students.find((item) => item.id === result.studentId);
    const version = versions.find((item) => item.id === result.examVersionId);
    if (!student || !version) continue;
    items.push({
      resultKey: result.id,
      studentFirstName: student.firstName,
      studentLevel: student.level,
      examTitle: version.title,
      scorePercentage: result.percentage,
      submittedAt: result.submittedAt,
    });
  }
  return items;
}

/**
 * Pushes results to the administrator's own cloud log. Best-effort per row:
 * one bad row never blocks the rest. No-ops (with a clear reason) when
 * offline or signed out — the offline local view keeps working regardless.
 */
export async function pushKioskResultsToCloud(
  results: readonly KioskResultToSync[],
  deviceLabel?: string,
): Promise<PushKioskResultsOutcome> {
  const access = await checkCloudAccess();
  if (!access.ok) return access;

  let synced = 0;
  let failed = 0;
  for (const result of results) {
    const { error } = await supabase.rpc('push_kiosk_exam_result', {
      p_result_key: result.resultKey,
      p_student_first_name: result.studentFirstName,
      p_student_level: result.studentLevel,
      p_exam_title: result.examTitle,
      p_score_percentage: result.scorePercentage,
      p_submitted_at: result.submittedAt,
      p_device_label: deviceLabel ?? null,
    });
    if (error) failed += 1;
    else synced += 1;
  }
  return { ok: true, synced, failed };
}

/** Reads back every result this administrator's account has ever synced. */
export async function fetchCloudKioskResults(): Promise<FetchKioskResultsOutcome> {
  const access = await checkCloudAccess();
  if (!access.ok) return access;

  const { data, error } = await supabase.rpc('list_kiosk_exam_results');
  if (error || !data) return { ok: true, results: [] };

  const rows = data as Array<Record<string, unknown>>;
  return {
    ok: true,
    results: rows.map((row) => ({
      resultKey: String(row.result_key ?? ''),
      studentFirstName: String(row.student_first_name ?? ''),
      studentLevel: String(row.student_level ?? ''),
      examTitle: String(row.exam_title ?? ''),
      scorePercentage: Number(row.score_percentage ?? 0),
      submittedAt: String(row.submitted_at ?? ''),
      deviceLabel: (row.device_label as string | null) ?? null,
    })),
  };
}

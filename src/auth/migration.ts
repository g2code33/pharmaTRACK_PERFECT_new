import type { Student } from '../types';
import { loadState, saveState } from '../utils/storage';
import { supabase } from '../utils/supabase';

export interface LocalWorkspaceMigration {
  required: boolean;
  student: Student | null;
  hasAcademicData: boolean;
}

function hasAcademicData(state: ReturnType<typeof loadState>): boolean {
  return Boolean(
    state.courses.length ||
      state.topics.length ||
      state.slides.length ||
      state.notes.length ||
      state.examQuestions.length ||
      state.highlights.length ||
      state.quizHistory.length ||
      state.studyPlans.length ||
      state.examDates.length,
  );
}

/**
 * Local onboarding predates Supabase and assigns a random student ID. That ID
 * is not an account identity. A user-initiated sign-in may explicitly link the
 * existing workspace to the authenticated Supabase user ID.
 */
export function inspectLocalWorkspaceMigration(userId: string): LocalWorkspaceMigration {
  const state = loadState();
  const student = state.student;
  return {
    required: Boolean(student && student.id !== userId),
    student,
    hasAcademicData: hasAcademicData(state),
  };
}

export function studentForAuthenticatedUser(userId: string, student: Student): Student {
  return { ...student, id: userId };
}

/**
 * Explicitly invoked after the user confirms the migration prompt. It never
 * creates another auth user and it never uses email, Kiosk identity, or device
 * ID as the account key.
 */
export async function linkLocalWorkspaceToAccount(userId: string, student: Student): Promise<Student> {
  const linked = studentForAuthenticatedUser(userId, student);
  const { error } = await supabase.from('profiles').upsert(
    {
      id: userId,
      full_name: linked.name,
      university: linked.university,
      level: linked.level,
      program: linked.program,
      semester: linked.semester,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) throw error;

  const state = loadState();
  saveState({ ...state, student: linked });
  return linked;
}

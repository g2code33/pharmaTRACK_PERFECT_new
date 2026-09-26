import React, { createContext, useContext, useReducer, useEffect, useRef, useCallback, useMemo, ReactNode } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  AppState,
  Student,
  Course,
  Topic,
  Slide,
  LearningObjective,
  ExamQuestion,
  QuizHistory,
  StudyPlan,
  Note,
  ExamDate,
  Activity,
  Highlight,
  SavedInsight,
  ChatMessageStore,
  ClinicalAttempt,
  ClinicalCase,
} from '../types';
import { loadState, saveState } from '../utils/storage';
import { ensureSchema } from '../utils/storageManager';
import {
  findLegacyKey,
  loadAISettings,
  migrateLegacySettings,
  providerForLegacyKey,
  saveAISettings,
} from '../ai/settings';
import { saveCredentials, storedApiKey } from '../ai/credentials';
import { aiManager } from '../ai/manager';
import { supabase } from '../utils/supabase';
import {
  deleteCurrentAccount,
  onAuthChange,
  signOutEverywhereOnThisDevice,
} from '../auth/authService';
import { lockAccountAI, restoreAccountAIFromSession } from '../ai/accountSync';
import {
  clearAccountSyncData,
  getAccountRecord,
  getAccountSyncStatus,
  lockAccountSync,
  restoreAccountSync,
  type ProfilePreferences,
} from '../account/sync';
import { loadSearchIndex } from '../utils/searchIndex';
import { ensureArchiveCatalog } from '../utils/archiveCatalog';
import { ensureConversationIndex } from '../utils/conversationSearch';
import {
  applyQuiz,
  markReviewed,
  markStudied,
  recordsOf,
  setIntervals,
  setTopicConfidence,
  setTopicImportance,
  setTopicStatus,
} from '../utils/learningEngine';
import { flagAttemptedQuestions } from '../utils/questionBank';
import { caseIsStudyMaterial, isBuiltinCase } from '../utils/clinicalLearning';
import { TimetableItem, LearningStatus } from '../types';

type Action =
  | { type: 'SET_STUDENT'; payload: Student }
  | { type: 'UPDATE_STUDENT'; payload: Partial<Student> }
  | { type: 'ADD_COURSE'; payload: Course }
  | { type: 'UPDATE_COURSE'; payload: { id: string; updates: Partial<Course> } }
  | { type: 'DELETE_COURSE'; payload: string }
  | { type: 'ADD_TOPIC'; payload: Topic }
  | { type: 'UPDATE_TOPIC'; payload: { id: string; updates: Partial<Topic> } }
  | { type: 'DELETE_TOPIC'; payload: string }
  | { type: 'REORDER_TOPICS'; payload: { courseId: string; topics: Topic[] } }
  | { type: 'ADD_SLIDE'; payload: Slide }
  | { type: 'UPDATE_SLIDE'; payload: { id: string; updates: Partial<Slide> } }
  | { type: 'DELETE_SLIDE'; payload: string }
  | { type: 'REORDER_SLIDES'; payload: { topicId: string; slides: Slide[] } }
  | { type: 'ADD_LEARNING_OBJECTIVE'; payload: LearningObjective }
  | { type: 'UPDATE_LEARNING_OBJECTIVE'; payload: { id: string; updates: Partial<LearningObjective> } }
  | { type: 'DELETE_LEARNING_OBJECTIVE'; payload: string }
  | { type: 'ADD_EXAM_QUESTIONS'; payload: ExamQuestion[] }
  | { type: 'UPDATE_EXAM_QUESTION'; payload: { id: string; updates: Partial<ExamQuestion> } }
  | { type: 'DELETE_EXAM_QUESTION'; payload: string }
  | { type: 'ADD_QUIZ_HISTORY'; payload: QuizHistory }
  | { type: 'ADD_STUDY_PLAN'; payload: StudyPlan }
  | { type: 'UPDATE_STUDY_PLAN'; payload: { id: string; updates: Partial<StudyPlan> } }
  | { type: 'DELETE_STUDY_PLAN'; payload: string }
  | { type: 'ADD_NOTE'; payload: Note }
  | { type: 'UPDATE_NOTE'; payload: { id: string; updates: Partial<Note> } }
  | { type: 'DELETE_NOTE'; payload: string }
  | { type: 'ADD_EXAM_DATE'; payload: ExamDate }
  | { type: 'UPDATE_EXAM_DATE'; payload: { id: string; updates: Partial<ExamDate> } }
  | { type: 'DELETE_EXAM_DATE'; payload: string }
  | { type: 'ADD_ACTIVITY'; payload: Activity }
  | { type: 'ADD_CHAT_MESSAGE'; payload: { topicId: string; role: 'user' | 'assistant'; content: string } }
  | { type: 'CLEAR_CHAT_HISTORY'; payload: string }
  | { type: 'ADD_HIGHLIGHT'; payload: Omit<Highlight, 'id' | 'timestamp'> }
  | { type: 'DELETE_HIGHLIGHT'; payload: string }
  | { type: 'SAVE_INSIGHT'; payload: Omit<SavedInsight, 'id' | 'timestamp'> }
  | { type: 'DELETE_INSIGHT'; payload: string }
  | { type: 'SET_TOPIC_STATUS'; payload: { topicId: string; status: LearningStatus } }
  | { type: 'SET_TOPIC_CONFIDENCE'; payload: { topicId: string; confidence: number } }
  | { type: 'SET_TOPIC_IMPORTANCE'; payload: { topicId: string; importance: number } }
  | { type: 'MARK_TOPIC_STUDIED'; payload: { topicId: string } }
  | { type: 'MARK_TOPIC_REVIEWED'; payload: { topicId: string } }
  | { type: 'SET_LEARNING_INTERVALS'; payload: number[] }
  | { type: 'ADD_CLINICAL_CASE'; payload: ClinicalCase }
  | { type: 'UPDATE_CLINICAL_CASE'; payload: { id: string; updates: Partial<ClinicalCase> } }
  | { type: 'DELETE_CLINICAL_CASE'; payload: string }
  | { type: 'ADD_CLINICAL_ATTEMPT'; payload: ClinicalAttempt }
  | { type: 'SET_OPENAI_KEY'; payload: string }
  | { type: 'ADD_TIMETABLE_ITEMS'; payload: { items: TimetableItem[], category: 'class' | 'quiz' | 'exam' } }
  | { type: 'UPDATE_TIMETABLE_ITEM'; payload: { id: string; category: 'class' | 'quiz' | 'exam'; updates: Partial<TimetableItem> } }
  | { type: 'DELETE_TIMETABLE_ITEM'; payload: { id: string, category: 'class' | 'quiz' | 'exam' } }
  | { type: 'SET_TIMETABLE_PDF'; payload: string | null }
  | { type: 'LOGOUT' }
  | { type: 'SET_LOGGED_IN'; payload: boolean }
  | { type: 'LOAD_STATE'; payload: AppState };

const appReducer = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case 'LOAD_STATE':
      // isLoggedIn is NOT restored from disk. saveState() persists the whole
      // state object, so a stale `true` from a previous run would survive a
      // restart and make the UI claim a cloud session that doesn't exist
      // (e.g. showing "End Session" to a signed-out user). The real session
      // lives in the Supabase token; checkSession() sets this flag from that,
      // and that is the only thing allowed to turn it on. Preserve the
      // reducer's current value so a later async schema migration cannot
      // overwrite a session restored during the same boot.
      return {
        ...action.payload,
        isLoggedIn: state.isLoggedIn,
        learningRecords: recordsOf(action.payload),
        learningSettings: setIntervals(action.payload.learningSettings?.intervals),
        clinicalCases: Array.isArray(action.payload.clinicalCases) ? action.payload.clinicalCases : [],
        clinicalAttempts: Array.isArray(action.payload.clinicalAttempts) ? action.payload.clinicalAttempts : [],
      };

    case 'SET_LOGGED_IN':
      return { ...state, isLoggedIn: action.payload };

    case 'SET_STUDENT':
      return { ...state, student: action.payload };

    case 'UPDATE_STUDENT':
      return {
        ...state,
        student: state.student ? { ...state.student, ...action.payload } : null,
      };

    case 'ADD_CHAT_MESSAGE':
      return {
        ...state,
        chatHistory: [
          ...state.chatHistory,
          {
            id: uuidv4(),
            topicId: action.payload.topicId,
            role: action.payload.role,
            content: action.payload.content,
            timestamp: new Date().toISOString(),
          } as ChatMessageStore,
        ],
      };

    case 'CLEAR_CHAT_HISTORY':
      return {
        ...state,
        chatHistory: state.chatHistory.filter((m) => m.topicId !== action.payload),
      };

    case 'ADD_HIGHLIGHT':
      return {
        ...state,
        highlights: [
          ...state.highlights,
          {
            ...action.payload,
            id: uuidv4(),
            timestamp: new Date().toISOString(),
          } as Highlight,
        ],
      };

    case 'DELETE_HIGHLIGHT':
      return {
        ...state,
        highlights: state.highlights.filter((h) => h.id !== action.payload),
      };

    case 'SAVE_INSIGHT':
      return {
        ...state,
        savedInsights: [
          ...state.savedInsights,
          {
            ...action.payload,
            id: uuidv4(),
            timestamp: new Date().toISOString(),
          } as SavedInsight,
        ],
      };

    case 'DELETE_INSIGHT':
      return {
        ...state,
        savedInsights: state.savedInsights.filter((i) => i.id !== action.payload),
      };

    case 'ADD_COURSE':
      return { ...state, courses: [...state.courses, action.payload] };

    case 'UPDATE_COURSE':
      return {
        ...state,
        courses: state.courses.map((c) =>
          c.id === action.payload.id ? { ...c, ...action.payload.updates } : c
        ),
      };

    case 'DELETE_COURSE': {
      const gone = new Set(state.topics.filter((t) => t.courseId === action.payload).map((t) => t.id));
      return {
        ...state,
        courses: state.courses.filter((c) => c.id !== action.payload),
        topics: state.topics.filter((t) => t.courseId !== action.payload),
        learningRecords: recordsOf(state).filter((r) => !gone.has(r.topicId)),
      };
    }

    case 'ADD_TOPIC':
      return { ...state, topics: [...state.topics, action.payload] };

    case 'UPDATE_TOPIC':
      return {
        ...state,
        topics: state.topics.map((t) =>
          t.id === action.payload.id ? { ...t, ...action.payload.updates } : t
        ),
      };

    case 'DELETE_TOPIC':
      return {
        ...state,
        topics: state.topics.filter((t) => t.id !== action.payload),
        learningRecords: recordsOf(state).filter((r) => r.topicId !== action.payload),
      };

    case 'REORDER_TOPICS':
      return {
        ...state,
        topics: [
          ...state.topics.filter((t) => t.courseId !== action.payload.courseId),
          ...action.payload.topics,
        ],
      };

    case 'ADD_SLIDE':
      return { ...state, slides: [...state.slides, action.payload] };

    case 'UPDATE_SLIDE':
      return {
        ...state,
        slides: state.slides.map((s) =>
          s.id === action.payload.id ? { ...s, ...action.payload.updates } : s
        ),
      };

    case 'DELETE_SLIDE':
      return {
        ...state,
        slides: state.slides.filter((s) => s.id !== action.payload),
      };

    case 'REORDER_SLIDES':
      return {
        ...state,
        slides: [
          ...state.slides.filter((s) => s.topicId !== action.payload.topicId),
          ...action.payload.slides,
        ],
      };

    case 'ADD_LEARNING_OBJECTIVE':
      return { ...state, learningObjectives: [...state.learningObjectives, action.payload] };

    case 'UPDATE_LEARNING_OBJECTIVE':
      return {
        ...state,
        learningObjectives: state.learningObjectives.map((lo) =>
          lo.id === action.payload.id ? { ...lo, ...action.payload.updates } : lo
        ),
      };

    case 'DELETE_LEARNING_OBJECTIVE':
      return {
        ...state,
        learningObjectives: state.learningObjectives.filter((lo) => lo.id !== action.payload),
      };

    case 'ADD_EXAM_QUESTIONS':
      return { ...state, examQuestions: [...state.examQuestions, ...action.payload] };

    case 'UPDATE_EXAM_QUESTION':
      return {
        ...state,
        examQuestions: state.examQuestions.map((eq) =>
          eq.id === action.payload.id ? { ...eq, ...action.payload.updates } : eq
        ),
      };

    case 'DELETE_EXAM_QUESTION':
      return {
        ...state,
        examQuestions: state.examQuestions.filter((eq) => eq.id !== action.payload),
      };

    case 'ADD_QUIZ_HISTORY': {
      const examQuestions = flagAttemptedQuestions(state.examQuestions, action.payload);
      const next = { ...state, examQuestions, quizHistory: [...state.quizHistory, action.payload] };
      return { ...next, learningRecords: applyQuiz(next, action.payload) };
    }

    case 'SET_TOPIC_STATUS':
      return { ...state, learningRecords: setTopicStatus(state, action.payload.topicId, action.payload.status) };

    case 'SET_TOPIC_CONFIDENCE':
      return { ...state, learningRecords: setTopicConfidence(state, action.payload.topicId, action.payload.confidence) };

    case 'SET_TOPIC_IMPORTANCE':
      return { ...state, learningRecords: setTopicImportance(state, action.payload.topicId, action.payload.importance) };

    case 'MARK_TOPIC_STUDIED': {
      const learningRecords = markStudied(state, action.payload.topicId);
      if (learningRecords === recordsOf(state)) return state;
      return { ...state, learningRecords };
    }

    case 'MARK_TOPIC_REVIEWED':
      return { ...state, learningRecords: markReviewed(state, action.payload.topicId) };

    case 'SET_LEARNING_INTERVALS':
      return { ...state, learningSettings: setIntervals(action.payload) };

    case 'ADD_CLINICAL_CASE': {
      const item = { ...action.payload, fictional: true as const, origin: 'manual' as const };
      if (isBuiltinCase(item.id) || !caseIsStudyMaterial(item)) return state;
      return { ...state, clinicalCases: [...(state.clinicalCases ?? []), item] };
    }

    case 'UPDATE_CLINICAL_CASE': {
      if (isBuiltinCase(action.payload.id)) return state;
      const current = (state.clinicalCases ?? []).find((item) => item.id === action.payload.id);
      if (!current) return state;
      const next = { ...current, ...action.payload.updates, fictional: true as const, origin: 'manual' as const, updatedAt: new Date().toISOString() };
      if (!caseIsStudyMaterial(next)) return state;
      return {
        ...state,
        clinicalCases: (state.clinicalCases ?? []).map((item) => item.id === next.id ? next : item),
      };
    }

    case 'DELETE_CLINICAL_CASE':
      if (isBuiltinCase(action.payload)) return state;
      return {
        ...state,
        clinicalCases: (state.clinicalCases ?? []).filter((item) => item.id !== action.payload),
        clinicalAttempts: (state.clinicalAttempts ?? []).filter((item) => item.caseId !== action.payload),
      };

    case 'ADD_CLINICAL_ATTEMPT':
      return { ...state, clinicalAttempts: [...(state.clinicalAttempts ?? []), action.payload] };

    case 'ADD_STUDY_PLAN':
      return { ...state, studyPlans: [...state.studyPlans, action.payload] };

    case 'UPDATE_STUDY_PLAN':
      return {
        ...state,
        studyPlans: state.studyPlans.map((sp) =>
          sp.id === action.payload.id ? { ...sp, ...action.payload.updates } : sp
        ),
      };

    case 'DELETE_STUDY_PLAN':
      return {
        ...state,
        studyPlans: state.studyPlans.filter((sp) => sp.id !== action.payload),
      };

    case 'ADD_NOTE':
      return { ...state, notes: [...state.notes, action.payload] };

    case 'UPDATE_NOTE':
      return {
        ...state,
        notes: state.notes.map((n) =>
          n.id === action.payload.id ? { ...n, ...action.payload.updates } : n
        ),
      };

    case 'DELETE_NOTE':
      return {
        ...state,
        notes: state.notes.filter((n) => n.id !== action.payload),
      };

    case 'ADD_EXAM_DATE':
      return { ...state, examDates: [...state.examDates, action.payload] };

    case 'UPDATE_EXAM_DATE':
      return {
        ...state,
        examDates: state.examDates.map((ed) =>
          ed.id === action.payload.id ? { ...ed, ...action.payload.updates } : ed
        ),
      };

    case 'DELETE_EXAM_DATE':
      return {
        ...state,
        examDates: state.examDates.filter((ed) => ed.id !== action.payload),
      };

    case 'ADD_ACTIVITY':
      return {
        ...state,
        activities: [action.payload, ...state.activities].slice(0, 50),
      };

    case 'SET_OPENAI_KEY':
      return { ...state, openAIKey: action.payload };

    case 'ADD_TIMETABLE_ITEMS':
      return { ...state, timetables: { ...state.timetables, [action.payload.category]: [...state.timetables[action.payload.category], ...action.payload.items] } };
    case 'UPDATE_TIMETABLE_ITEM':
      return {
        ...state,
        timetables: {
          ...state.timetables,
          [action.payload.category]: state.timetables[action.payload.category].map((item) =>
            item.id === action.payload.id ? { ...item, ...action.payload.updates } : item
          ),
        },
      };
    case 'DELETE_TIMETABLE_ITEM':
      return { ...state, timetables: { ...state.timetables, [action.payload.category]: state.timetables[action.payload.category].filter(i => i.id !== action.payload.id) } };
    case 'SET_TIMETABLE_PDF':
      return { ...state, timetablePdf: action.payload };
    case 'LOGOUT':
      // Clear identity/session only, and deliberately KEEP the locally cached
      // study data (courses, topics, slides, notes...).
      // Resetting to initialState here is unsafe: the debounced save effect
      // writes state back to localStorage as soon as `student` is non-null
      // again, so the next sign-in would flush an empty state over the user's
      // real material and destroy it permanently. Settings ->
      // "Clear ALL Data" remains the explicit way to wipe local content.
      return { ...state, isLoggedIn: false, student: null };

    default:
      return state;
  }
};

const initialState: AppState = {
  isLoggedIn: false,
  student: null,
  courses: [],
  topics: [],
  slides: [],
  learningObjectives: [],
  examQuestions: [],
  quizHistory: [],
  studyPlans: [],
  notes: [],
  examDates: [],
  activities: [],
  chatHistory: [],
  highlights: [],
  savedInsights: [],
  learningRecords: [],
  learningSettings: { intervals: [1, 3, 7, 14, 30] },
  clinicalCases: [],
  clinicalAttempts: [],
  openAIKey: '',
  timetables: { class: [], quiz: [], exam: [] },
  timetablePdf: null,
};

/**
 * Moves a pre-AI-engine `openAIKey` (which was always used against Google's
 * endpoint, despite the name) into the multi-provider configuration:
 *
 *   old: state.openAIKey          new: providers.gemini.apiKey (IndexedDB)
 *                                       profiles.default → gemini
 *
 * Order matters — the provider entry and its credential are written first, and
 * the legacy field is cleared only afterwards, so an interrupted migration
 * leaves the user's key intact and simply retries on the next launch.
 */
async function migrateLegacyAiKey(state: AppState): Promise<void> {
  const legacy = findLegacyKey(state as unknown as Record<string, unknown>);
  if (!legacy) return;

  const targetId = providerForLegacyKey(legacy.key).kind;
  // A different key already in the AI store is left alone. Clearing the legacy
  // field in that case would drop the only copy of this key.
  const alreadyStored = await storedApiKey(targetId);
  if (alreadyStored && alreadyStored !== legacy.key) return;

  if (alreadyStored !== legacy.key) {
    const settings = loadAISettings();
    const { settings: migrated, providerId } = migrateLegacySettings(settings, legacy.key);
    const saved = saveAISettings(migrated);
    if (!saved.providers.some((p) => p.id === providerId && p.enabled)) return;
    await saveCredentials(providerId, { apiKey: legacy.key });
    aiManager.reload();
    await aiManager.ensureCredentials();
    // Cache is not proof. The key stays in the semester file until IndexedDB has it.
    if ((await storedApiKey(providerId)) !== legacy.key) return;
  }

  try {
    const stored = loadState();
    if (stored.openAIKey) {
      saveState({ ...stored, openAIKey: '' });
      console.warn(
        'PharmaTRACK AI: moved your existing API key into AI Settings (Settings → AI). ' +
          'API keys are no longer part of your academic data or backups.',
      );
    }
  } catch {
    /* keep the legacy field if clearing fails — it is harmless, just unused */
  }
}

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  getCourseProgress: (courseId: string) => number;
  getTopicProgress: (topicId: string) => number;
  getLOProgress: (courseId: string) => number;
  getOverallProgress: () => number;
  getTopicsForCourse: (courseId: string) => Topic[];
  getSlidesForTopic: (topicId: string) => Slide[];
  getLOsForCourse: (courseId: string) => LearningObjective[];
  getQuestionsForCourse: (courseId: string) => ExamQuestion[];
  getQuestionsForTopic: (topicId: string) => ExamQuestion[];
  getNotesForTopic: (topicId: string) => Note[];
  getExamDatesForCourse: (courseId: string) => ExamDate[];
  addActivity: (type: Activity['type'], description: string, courseId?: string, topicId?: string) => void;
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, rawDispatch] = useReducer(appReducer, initialState);
  // A boot migration is async. If the student already added something, applying
  // the pre-edit snapshot afterwards would wipe that work.
  const editedDuringBoot = useRef(false);
  const dispatch = useCallback((action: Action) => {
    if (action.type !== 'LOAD_STATE' && action.type !== 'SET_LOGGED_IN') editedDuringBoot.current = true;
    rawDispatch(action);
  }, []);

  // Set the moment the user signs out, and read synchronously by the session
  // effect below. A ref (not state) is required because the effect and the
  // in-flight async getSession() must see the new value immediately, before
  // React has a chance to re-render.
  const hasSignedOutRef = useRef(false);

  /**
   * Ends the session for real.
   *
   * Order matters: mark signed-out first so any in-flight session check bails
   * out, then ask Supabase to sign out, then purge the persisted token. The
   * purge is unconditional because `signOut()` returns early without clearing
   * storage when its network call fails (i.e. whenever the user is offline),
   * which is exactly what left users unable to log out.
   */
  const logout = useCallback(async () => {
    hasSignedOutRef.current = true;
    lockAccountAI();
    void lockAccountSync();
    try {
      // 'local' clears this device only. Other devices remain signed in, which
      // is the expected multi-device account behavior.
      await signOutEverywhereOnThisDevice();
    } catch (err) {
      console.error('Supabase sign-out failed, clearing local session anyway:', err);
    } finally {
      // Ends the cloud session but keeps the student profile, so the app stays
      // fully usable offline afterwards instead of demanding onboarding again.
      dispatch({ type: 'SET_LOGGED_IN', payload: false });
    }
  }, []);

  const deleteAccount = useCallback(async () => {
    // The server-side function deletes auth.users and cascaded account rows.
    // It cannot be replaced by auth.user_metadata or a client-side admin call.
    const accountUserId = getAccountSyncStatus().userId;
    await deleteCurrentAccount();
    if (accountUserId) await clearAccountSyncData(accountUserId);
    await lockAccountSync();
    lockAccountAI();
    hasSignedOutRef.current = true;
    // Account deletion removes the cloud identity, not this device's academic
    // workspace. Keep the local student/data available for export or continued
    // offline study, while marking the cloud session signed out.
    dispatch({ type: 'SET_LOGGED_IN', payload: false });
  }, []);

  // Warm the full-text search index from IndexedDB so global search can run
  // synchronously against it.
  useEffect(() => {
    void loadSearchIndex();
    void ensureArchiveCatalog();
    void ensureConversationIndex();
  }, []);

  // Readable data is applied synchronously so a click in the same turn is not
  // overwritten by an empty snapshot. Migration is async and only replaces
  // state if the student has not edited yet.
  useEffect(() => {
    let cancelled = false;
    const saved = loadState();
    if (!saved.timetables) saved.timetables = { class: [], quiz: [], exam: [] };
    rawDispatch({ type: 'LOAD_STATE', payload: saved });

    void (async () => {
      const result = await ensureSchema();
      if (cancelled || editedDuringBoot.current) return;
      const next = result.state;
      if (!next.timetables) next.timetables = { class: [], quiz: [], exam: [] };
      rawDispatch({ type: 'LOAD_STATE', payload: next });
      if (result.persist) void migrateLegacyAiKey(next);
    })();
    return () => { cancelled = true; };
  }, []);

  const fetchProfile = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id,full_name,university,level,program,semester,avatar_url,created_at')
        .eq('id', userId)
        .single();
      const currentLocalStudent = loadState().student;

      if (currentLocalStudent && currentLocalStudent.id !== userId) {
        // Do not silently attach an existing local workspace to whichever
        // account was just authenticated. Login shows the explicit migration
        // confirmation and links it only after the user accepts.
        return;
      }

      if (data && !error) {
        // The Supabase auth UUID is the only stable account identity. Local
        // onboarding IDs are never copied into a cloud profile.
        dispatch({
          type: 'SET_STUDENT',
          payload: {
            id: userId,
            name: data.full_name || 'Student',
            level: data.level || '100',
            semester: data.semester || '1st',
            program: data.program || 'Pharmacy',
            university: data.university || 'UCC',
            avatar_url: data.avatar_url || currentLocalStudent?.avatar_url,
            createdAt: data.created_at || currentLocalStudent?.createdAt || new Date().toISOString(),
          },
        });
      } else if (!currentLocalStudent) {
        // The signup trigger normally creates this row. This fallback keeps
        // older projects usable until the SQL migration has been applied.
        const fallback = {
          id: userId,
          full_name: 'Student',
          level: '100',
          updated_at: new Date().toISOString(),
        };
        const { error: createError } = await supabase.from('profiles').upsert(fallback, { onConflict: 'id' });
        if (createError) console.warn('Profile row is not available yet:', createError.message);
        dispatch({
          type: 'SET_STUDENT',
          payload: {
            id: userId,
            name: 'Student',
            level: '100',
            semester: '1st',
            program: 'Pharmacy',
            university: 'UCC',
            createdAt: new Date().toISOString(),
          },
        });
      }
      // A mismatched local student is deliberately left untouched here. Login
      // performs an explicit migration prompt before linking that workspace.
    } catch (e) {
      console.error('Profile fetch failed:', e);
    }
  };

  const restoreNormalAccount = async (userId: string) => {
    const sync = await restoreAccountSync(userId);
    if (getAccountSyncStatus().userId !== userId) return;
    // A conflict is intentionally not applied to AppState. The local value
    // remains visible until the user explicitly resolves the conflict through
    // the account-sync API; no newer remote value is silently discarded.
    if (sync.state === 'revoked' || sync.state === 'error' || sync.state === 'conflict') return;
    const profile = await getAccountRecord<ProfilePreferences>(userId, 'profile');
    if (!profile) return;
    const current = loadState().student;
    if (current && current.id !== userId) return;
    dispatch({
      type: 'SET_STUDENT',
      payload: {
        id: userId,
        name: profile.fullName || current?.name || 'Student',
        university: profile.university || current?.university || 'UCC',
        level: profile.level || current?.level || '100',
        program: profile.program || current?.program || 'Pharmacy',
        semester: profile.semester || current?.semester || '1st',
        createdAt: current?.createdAt || new Date().toISOString(),
        avatar_url: current?.avatar_url,
      },
    });
  };

  useEffect(() => {
    const checkSession = async () => {
      // Never auto-restore a session the user explicitly ended. This effect
      // re-runs on every isLoggedIn change (including the one logout causes),
      // so without this guard it immediately signs the user back in from the
      // cached student / still-persisted Supabase token.
      if (hasSignedOutRef.current) return;

      // Offline: trust the stored token, not the mere presence of a student.
      // A local-only user (onboarded, never signed in) has a student but no
      // session, and must NOT be treated as logged in — that would make the
      // UI offer cloud features they have no account for.
      if (!navigator.onLine) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          dispatch({ type: 'SET_LOGGED_IN', payload: true });
          void restoreNormalAccount(session.user.id);
        }
        return;
      }

      try {
        // Supabase restores/refreshes the persisted SDK session here. Cloud
        // writes perform the stronger getUser() validation in requireAuth.
        const { data: { session } } = await supabase.auth.getSession();
        if (hasSignedOutRef.current) return; // logout may have happened while awaiting
        if (session?.user) {
          dispatch({ type: 'SET_LOGGED_IN', payload: true });
          void fetchProfile(session.user.id);
          void restoreNormalAccount(session.user.id);
          void restoreAccountAIFromSession(session.user.id);
        } else if (state.isLoggedIn) {
          // Expired/revoked sessions are handled as signed out, while local
          // academic data remains available on the device.
          dispatch({ type: 'SET_LOGGED_IN', payload: false });
        }
      } catch (err) {
        // Network hiccup while checking. Leave the current state alone rather
        // than signing the user out over a transient request failure.
      }
    };

    checkSession();

    const subscription = onAuthChange((event, session) => {
      // A real sign-in clears the signed-out latch so the user can get back in.
      // INITIAL_SESSION is not treated as proof by itself; the online boot
      // check uses getUser(), while TOKEN_REFRESHED/USER_UPDATED are emitted
      // by the SDK after a validated auth operation.
      if (event === 'SIGNED_IN') hasSignedOutRef.current = false;

      const trustedSessionEvent =
        event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED';
      if (session?.user && trustedSessionEvent) {
        if (hasSignedOutRef.current) return;
        dispatch({ type: 'SET_LOGGED_IN', payload: true });
        void restoreNormalAccount(session.user.id);
        if (navigator.onLine) void fetchProfile(session.user.id);
      } else if (event === 'SIGNED_OUT') {
        // A remote expiry/revocation is also a real sign-out. Latch it so an
        // in-flight restoration response cannot resurrect the expired token;
        // the next SIGNED_IN event clears the latch.
        hasSignedOutRef.current = true;
        // Only a genuine SIGNED_OUT clears the session. Other session-less
        // events (a token refresh that failed offline, INITIAL_SESSION with no
        // session) must not log anyone out, and must never null the student —
        // that would bounce a local-only user back to onboarding and lose the
        // identity their offline app depends on.
        lockAccountAI();
        void lockAccountSync();
        dispatch({ type: 'SET_LOGGED_IN', payload: false });
      }
    });

    return () => subscription.unsubscribe();
  }, [state.student?.id, state.isLoggedIn]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      // Guard only against the very first render, before LOAD_STATE has run —
      // writing then would clobber saved data with an empty state.
      //
      // This used to require `student !== null || courses.length > 0`, which
      // silently dropped everything else: a user with highlights, notes or
      // timetable entries but no course yet had their work discarded on
      // reload. Save whenever there is anything worth saving.
      const hasContent =
        state.student !== null ||
        state.courses.length > 0 ||
        state.topics.length > 0 ||
        state.slides.length > 0 ||
        state.notes.length > 0 ||
        state.highlights.length > 0 ||
        state.savedInsights.length > 0 ||
        state.examQuestions.length > 0 ||
        state.quizHistory.length > 0 ||
        state.studyPlans.length > 0 ||
        state.examDates.length > 0 ||
        state.learningObjectives.length > 0 ||
        (state.learningRecords?.length ?? 0) > 0 ||
        (state.clinicalCases?.length ?? 0) > 0 ||
        (state.clinicalAttempts?.length ?? 0) > 0 ||
        state.activities.length > 0 ||
        state.timetablePdf !== null ||
        state.timetables.class.length > 0 ||
        state.timetables.quiz.length > 0 ||
        state.timetables.exam.length > 0;

      if (hasContent) saveState(state);
    }, 1000); // Debounce saves by 1 second to prevent UI freezing
    return () => clearTimeout(timeoutId);
  }, [state]);

  const getCourseProgress = (courseId: string): number => {
    const topics = state.topics.filter((t) => t.courseId === courseId);
    if (topics.length === 0) return 0;
    const slides = state.slides.filter((s) => topics.some((t) => t.id === s.topicId));
    if (slides.length === 0) return 0;
    const completedSlides = slides.filter((s) => s.status === 'completed').length;
    return Math.round((completedSlides / slides.length) * 100);
  };

  const getTopicProgress = (topicId: string): number => {
    const slides = state.slides.filter((s) => s.topicId === topicId);
    if (slides.length === 0) return 0;
    const completedSlides = slides.filter((s) => s.status === 'completed').length;
    return Math.round((completedSlides / slides.length) * 100);
  };

  const getLOProgress = (courseId: string): number => {
    const los = state.learningObjectives.filter((lo) => lo.courseId === courseId);
    if (los.length === 0) return 0;
    const masteredCount = los.filter((lo) => lo.status === 'mastered').length;
    const partialCount = los.filter((lo) => lo.status === 'partial').length;
    return Math.round(((masteredCount + partialCount * 0.5) / los.length) * 100);
  };

  const getOverallProgress = (): number => {
    if (state.courses.length === 0) return 0;
    const totalProgress = state.courses.reduce((sum, course) => sum + getCourseProgress(course.id), 0);
    return Math.round(totalProgress / state.courses.length);
  };

  const getTopicsForCourse = (courseId: string): Topic[] => {
    return state.topics.filter((t) => t.courseId === courseId).sort((a, b) => a.orderIndex - b.orderIndex);
  };

  const getSlidesForTopic = (topicId: string): Slide[] => {
    return state.slides.filter((s) => s.topicId === topicId).sort((a, b) => a.slideNumber - b.slideNumber);
  };

  const getLOsForCourse = (courseId: string): LearningObjective[] => {
    return state.learningObjectives.filter((lo) => lo.courseId === courseId);
  };

  const getQuestionsForCourse = (courseId: string): ExamQuestion[] => {
    return state.examQuestions.filter((eq) => eq.courseId === courseId);
  };

  const getQuestionsForTopic = (topicId: string): ExamQuestion[] => {
    return state.examQuestions.filter((eq) => eq.topicId === topicId);
  };

  const getNotesForTopic = (topicId: string): Note[] => {
    return state.notes.filter((n) => n.topicId === topicId);
  };

  const getExamDatesForCourse = (courseId: string): ExamDate[] => {
    return state.examDates.filter((ed) => ed.courseId === courseId);
  };

  const addActivity = (type: Activity['type'], description: string, courseId?: string, topicId?: string) => {
    const activity: Activity = {
      id: uuidv4(),
      type,
      description,
      timestamp: new Date().toISOString(),
      courseId,
      topicId,
    };
    dispatch({ type: 'ADD_ACTIVITY', payload: activity });
  };

  // Memoised so the context value is a NEW object only when `state` actually
  // changes. Previously this object literal was rebuilt on every single render
  // of the provider, which makes React treat the context as changed and
  // re-render all 19 consumers even when nothing they read was touched.
  // The helpers are recreated each render too, so they're intentionally
  // included via `state` — they all close over it and are cheap to rebuild.
  const value = useMemo(
    () => ({
      state,
      dispatch,
      getCourseProgress,
      getTopicProgress,
      getLOProgress,
      getOverallProgress,
      getTopicsForCourse,
      getSlidesForTopic,
      getLOsForCourse,
      getQuestionsForCourse,
      getQuestionsForTopic,
      getNotesForTopic,
      getExamDatesForCourse,
      addActivity,
      logout,
      deleteAccount,
    }),
    [state, logout, deleteAccount],
  );

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
};

export const useApp = (): AppContextType => {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
import React, { createContext, useContext, useReducer, useEffect, ReactNode } from 'react';
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
} from '../types';
import { loadState, saveState } from '../utils/storage';
import { supabase } from '../utils/supabase';
import { TimetableItem } from '../types';

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
  | { type: 'SET_OPENAI_KEY'; payload: string }
  | { type: 'ADD_TIMETABLE_ITEMS'; payload: { items: TimetableItem[], category: 'class' | 'quiz' | 'exam' } }
  | { type: 'DELETE_TIMETABLE_ITEM'; payload: { id: string, category: 'class' | 'quiz' | 'exam' } }
  | { type: 'SET_TIMETABLE_PDF'; payload: string | null }
  | { type: 'LOGOUT' }
  | { type: 'SET_LOGGED_IN'; payload: boolean }
  | { type: 'LOAD_STATE'; payload: AppState };

const appReducer = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case 'LOAD_STATE':
      return action.payload;

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

    case 'DELETE_COURSE':
      return {
        ...state,
        courses: state.courses.filter((c) => c.id !== action.payload),
        topics: state.topics.filter((t) => t.courseId !== action.payload),
      };

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

    case 'ADD_QUIZ_HISTORY':
      return { ...state, quizHistory: [...state.quizHistory, action.payload] };

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
    case 'DELETE_TIMETABLE_ITEM':
      return { ...state, timetables: { ...state.timetables, [action.payload.category]: state.timetables[action.payload.category].filter(i => i.id !== action.payload.id) } };
    case 'SET_TIMETABLE_PDF':
      return { ...state, timetablePdf: action.payload };
    case 'LOGOUT':
      return { ...initialState };

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
  openAIKey: '',
  timetables: { class: [], quiz: [], exam: [] },
  timetablePdf: null,
};

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
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(appReducer, initialState);

  // Initial Load from IDB/LocalStorage
  useEffect(() => {
    const savedState = loadState();
    // Default them to True if they are offline and had a student!
    if (!navigator.onLine && savedState.student) savedState.isLoggedIn = true;
    // ensure timetable arrays exist for old users
    if (!savedState.timetables) savedState.timetables = { class: [], quiz: [], exam: [] };
    dispatch({ type: 'LOAD_STATE', payload: savedState });
  }, []);

  const fetchProfile = async (userId: string) => {
    try {
      const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
      const currentLocalStudent = loadState().student;

      if (data && !error) {
        dispatch({
          type: 'SET_STUDENT',
          payload: { 
            id: userId, 
            name: data.full_name || currentLocalStudent?.name || 'Student', 
            level: data.level || currentLocalStudent?.level || '100', 
            semester: data.semester || currentLocalStudent?.semester || '1st', 
            program: data.program || currentLocalStudent?.program || 'Pharmacy', 
            university: data.university || currentLocalStudent?.university || 'UCC', 
            avatar_url: data.avatar_url || currentLocalStudent?.avatar_url, createdAt: data.created_at || currentLocalStudent?.createdAt || new Date().toISOString() 
          }
        });
      } else {
        if(currentLocalStudent) {
           dispatch({ type: 'SET_STUDENT', payload: currentLocalStudent });
        }
      }
    } catch (e) { console.error("Profile fetch fail:", e); }
  };

  useEffect(() => {
    const checkSession = async () => {
      if (!navigator.onLine && state.student) {
        dispatch({ type: 'SET_LOGGED_IN', payload: true });
        return;
      }
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          dispatch({ type: 'SET_LOGGED_IN', payload: true });
          if (navigator.onLine) fetchProfile(session.user.id);
        } else if (navigator.onLine && state.isLoggedIn) {
          dispatch({ type: 'SET_LOGGED_IN', payload: false });
        }
      } catch (err) {}
    };

    checkSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        dispatch({ type: 'SET_LOGGED_IN', payload: true });
        if (navigator.onLine) fetchProfile(session.user.id);
      } else if (navigator.onLine) {
        dispatch({ type: 'SET_LOGGED_IN', payload: false });
        dispatch({ type: 'SET_STUDENT', payload: null });
      }
    });

    return () => subscription.unsubscribe();
  }, [state.student?.id, state.isLoggedIn]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (state.student !== null || state.courses.length > 0) {
        saveState(state);
      }
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

  return (
    <AppContext.Provider
      value={{
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
      }}
    >
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
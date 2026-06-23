import { AppState, Course, Topic, Slide, LearningObjective, ExamQuestion, QuizHistory, StudyPlan, Note, ExamDate, Activity } from '../types';
import * as idb from 'idb-keyval';

const STORAGE_KEY = 'pharmatrack_state';

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

export const loadState = (): AppState => {
  try {
    const serializedState = localStorage.getItem(STORAGE_KEY);
    if (serializedState === null) {
      return initialState;
    }
    const parsedState = JSON.parse(serializedState);
    return { ...initialState, ...parsedState };
  } catch (err) {
    console.error('Error loading state from localStorage:', err);
    return initialState;
  }
};

export const saveState = (state: AppState): void => {
  try {
    const serializedState = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, serializedState);
  } catch (err) {
    console.error('Error saving state to localStorage:', err);
  }
};

// File Storage using IndexedDB (for large files like PDFs, audio, images)
export const saveFile = async (id: string, file: Blob | Uint8Array | string): Promise<void> => {
  try {
    await idb.set(`file_${id}`, file);
  } catch (err) {
    console.error(`Error saving file ${id} to IndexedDB:`, err);
  }
};

export const loadFile = async (id: string): Promise<Blob | Uint8Array | string | null> => {
  try {
    const file = await idb.get(`file_${id}`);
    return file || null;
  } catch (err) {
    console.error(`Error loading file ${id} from IndexedDB:`, err);
    return null;
  }
};

export const deleteFile = async (id: string): Promise<void> => {
  try {
    await idb.del(`file_${id}`);
  } catch (err) {
    console.error(`Error deleting file ${id} from IndexedDB:`, err);
  }
};

export const clearState = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.error('Error clearing state from localStorage:', err);
  }
};

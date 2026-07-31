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

/**
 * Extracted PDF/DOCX text can run to tens of KB per slide. Kept in full it
 * dominates the saved blob: 200 slides serialised to ~2 MB and blocked the main
 * thread for ~13 ms on every save, and localStorage's ~5 MB cap meant a heavy
 * user would eventually hit QuotaExceededError and silently stop saving.
 *
 * Slides keep a truncated copy so global search still works offline with no
 * async lookup, and the full text lives in IndexedDB (no practical size limit),
 * fetched only when a slide is actually opened.
 */
const CONTENT_TEXT_SEARCH_LIMIT = 2000;

const fullTextKey = (slideId: string) => `slidetext_${slideId}`;

/** Full extracted text for a slide, or null if it was never long enough to offload. */
export const loadSlideText = async (slideId: string): Promise<string | null> => {
  try {
    return (await idb.get(fullTextKey(slideId))) ?? null;
  } catch (err) {
    console.error(`Error loading slide text ${slideId}:`, err);
    return null;
  }
};

export const deleteSlideText = async (slideId: string): Promise<void> => {
  try {
    await idb.del(fullTextKey(slideId));
  } catch (err) {
    console.error(`Error deleting slide text ${slideId}:`, err);
  }
};

export const saveState = (state: AppState): void => {
  try {
    let offloaded = 0;

    const slides = state.slides.map((slide) => {
      const text = slide.contentText;
      if (!text || text.length <= CONTENT_TEXT_SEARCH_LIMIT) return slide;

      // Write the full text to IndexedDB in the background. If it fails the
      // truncated copy is still saved, so search keeps working and the only
      // loss is the tail of the text — never the slide itself.
      offloaded += 1;
      idb.set(fullTextKey(slide.id), text).catch((err) =>
        console.error(`Error offloading slide text ${slide.id}:`, err),
      );

      return { ...slide, contentText: text.slice(0, CONTENT_TEXT_SEARCH_LIMIT) };
    });

    const serializedState = JSON.stringify(
      offloaded > 0 ? { ...state, slides } : state,
    );
    localStorage.setItem(STORAGE_KEY, serializedState);
  } catch (err) {
    // A quota error here used to be invisible: saving just stopped and the
    // user kept working, losing everything on close. Make it loud.
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      console.error(
        'Storage full — your data could not be saved. Export a backup from Settings.',
        err,
      );
    } else {
      console.error('Error saving state to localStorage:', err);
    }
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

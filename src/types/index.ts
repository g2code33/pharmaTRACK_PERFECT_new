// PharmTrack - Type Definitions

export interface Student {
  id: string;
  name: string;
  university: string;
  level: string;
  program: string;
  semester: string;
  createdAt: string;
  avatar_url?: string;
}

export interface Course {
  id: string;
  studentId: string;
  courseCode: string;
  courseName: string;
  lecturerName: string;
  semester: string;
  creditHours: number;
  createdAt: string;
  avatar_url?: string;
}

export interface Topic {
  id: string;
  courseId: string;
  topicName: string;
  orderIndex: number;
  createdAt: string;
  avatar_url?: string;
}

export interface Slide {
  id: string;
  topicId: string;
  slideNumber: number;
  title: string;
  contentText: string;
  fileUrl?: string;
  fileType?: 'pdf' | 'jpg' | 'png' | 'text';
  status: 'not_started' | 'in_progress' | 'completed';
  createdAt: string;
  avatar_url?: string;
}

export interface LearningObjective {
  id: string;
  courseId: string;
  topicId?: string;
  objectiveText: string;
  status: 'not_covered' | 'partial' | 'mastered';
  createdAt: string;
  avatar_url?: string;
}

export interface ExamQuestion {
  id: string;
  courseId: string;
  topicId: string;
  questionText: string;
  questionType: 'short_answer' | 'structured' | 'essay' | 'mcq' | 'case_study';
  marksAllocation: number;
  difficulty: 'easy' | 'medium' | 'hard';
  probability: 'high' | 'medium' | 'low';
  modelAnswer: string;
  tags: string[];
  isPracticed: boolean;
  needsReview: boolean;
  isSaved: boolean;
  createdAt: string;
  avatar_url?: string;
  // For MCQ
  options?: string[];
  correctOption?: number;
}

export interface QuizHistory {
  id: string;
  studentId: string;
  courseId: string;
  questionsUsed: string[];
  answersGiven: { questionId: string; answer: string; isCorrect: boolean }[];
  scorePercentage: number;
  weakTopics: string[];
  timeTaken: number;
  completedAt: string;
}

export interface StudyPlan {
  id: string;
  studentId: string;
  date: string;
  timeSlot: string;
  courseId: string;
  activityType: 'study' | 'quiz' | 'revision' | 'upload';
  notes: string;
  isCompleted: boolean;
}

export interface Note {
  id: string;
  topicId: string;
  noteText: string;
  isAiGenerated: boolean;
  createdAt: string;
  avatar_url?: string;
  attachedFiles?: { id: string; name: string; type: string; data: string }[];
}

export interface ExamDate {
  id: string;
  courseId: string;
  examDate: string;
  examType: 'midsem' | 'endsem' | 'practical';
  isReminderSet: boolean;
}

export interface Activity {
  id: string;
  type: 'slide_completed' | 'quiz_taken' | 'questions_generated' | 'course_added' | 'objective_mastered';
  description: string;
  timestamp: string;
  courseId?: string;
  topicId?: string;
}

// Store state
export interface ChatMessageStore {
  id: string;
  topicId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface Highlight {
  id: string;
  topicId: string;
  slideIndex: number;
  text: string;
  color: string;
  timestamp: string;
}

export interface SavedInsight {
  id: string;
  topicId: string;
  type: 'user' | 'ai';
  content: string;
  timestamp: string;
}

export interface AppState {
  isLoggedIn: boolean;
  student: Student | null;
  courses: Course[];
  topics: Topic[];
  slides: Slide[];
  learningObjectives: LearningObjective[];
  examQuestions: ExamQuestion[];
  quizHistory: QuizHistory[];
  studyPlans: StudyPlan[];
  notes: Note[];
  examDates: ExamDate[];
  activities: Activity[];
  chatHistory: ChatMessageStore[];
  highlights: Highlight[];
  savedInsights: SavedInsight[];
  openAIKey: string;
  timetables: { class: TimetableItem[]; quiz: TimetableItem[]; exam: TimetableItem[]; };
  timetablePdf: string | null;
}

export type TimetableItem = {
  id: string;
  subject: string;
  date: string;
  time: string;
  location: string;
  type: 'class' | 'quiz' | 'exam';
};

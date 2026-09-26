import React, { useMemo, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import type { ExamQuestion, QuestionOrigin } from '../types';
import { createQuestion, DIFFICULTY_LABEL, TYPE_LABEL } from '../utils/questionBank';
import { inferMaterialKind } from '../utils/materialKind';

const ORIGINS: { id: QuestionOrigin; label: string }[] = [
  { id: 'manual', label: 'Manual' },
  { id: 'pdf', label: 'PDF' },
  { id: 'slide', label: 'PPT slide' },
  { id: 'objective', label: 'Learning objective' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onAdded?: (question: ExamQuestion) => void;
}

const AddQuestionModal: React.FC<Props> = ({ open, onClose, onAdded }) => {
  const { state, dispatch } = useApp();
  const [courseId, setCourseId] = useState('');
  const [topicId, setTopicId] = useState('');
  const [semester, setSemester] = useState('');
  const [questionType, setQuestionType] = useState<ExamQuestion['questionType']>('mcq');
  const [difficulty, setDifficulty] = useState<ExamQuestion['difficulty']>('medium');
  const [origin, setOrigin] = useState<QuestionOrigin>('manual');
  const [materialId, setMaterialId] = useState('');
  const [objectiveId, setObjectiveId] = useState('');
  const [page, setPage] = useState('');
  const [questionText, setQuestionText] = useState('');
  const [options, setOptions] = useState(['', '', '', '']);
  const [correctOption, setCorrectOption] = useState(0);
  const [correctAnswer, setCorrectAnswer] = useState('');
  const [explanation, setExplanation] = useState('');
  const [error, setError] = useState('');

  const topics = state.topics.filter((topic) => topic.courseId === courseId);
  const course = state.courses.find((item) => item.id === courseId);
  const materials = useMemo(() => {
    const topicIds = new Set(topics.map((topic) => topic.id));
    return state.slides.filter((slide) => topicIds.has(slide.topicId));
  }, [state.slides, topics]);
  const pdfs = materials.filter((slide) => inferMaterialKind(slide) === 'pdf');
  const decks = materials.filter((slide) => {
    const kind = inferMaterialKind(slide);
    return kind === 'ppt' || kind === 'pptx';
  });
  const objectives = state.learningObjectives.filter((item) => item.courseId === courseId);

  if (!open) return null;

  const save = () => {
    if (!courseId || !topicId) {
      setError('Choose a course and a topic.');
      return;
    }
    if (!questionText.trim()) {
      setError('Write the question.');
      return;
    }
    if (questionType === 'mcq' && options.filter((option) => option.trim()).length < 2) {
      setError('An MCQ needs at least two choices.');
      return;
    }
    const pageNumber = page.trim() ? parseInt(page, 10) : undefined;
    const question = createQuestion({
      id: uuidv4(),
      courseId,
      topicId,
      semester: semester || course?.semester,
      questionText,
      questionType,
      difficulty,
      options: questionType === 'mcq' ? options : undefined,
      correctOption: questionType === 'mcq' ? correctOption : undefined,
      correctAnswer: questionType === 'mcq' ? undefined : correctAnswer,
      explanation,
      source: {
        origin,
        label: origin === 'manual' ? 'Manual' : ORIGINS.find((item) => item.id === origin)?.label,
        materialId: origin === 'pdf' || origin === 'slide' ? materialId || undefined : undefined,
        objectiveId: origin === 'objective' ? objectiveId || undefined : undefined,
        page: pageNumber && pageNumber > 0 ? pageNumber : undefined,
      },
      tags: ['manual'],
    });
    dispatch({ type: 'ADD_EXAM_QUESTIONS', payload: [question] });
    onAdded?.(question);
    setQuestionText('');
    setOptions(['', '', '', '']);
    setCorrectOption(0);
    setCorrectAnswer('');
    setExplanation('');
    setError('');
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-[200]">
      <div className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full p-8 flex flex-col max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-2xl font-black text-slate-800">Add question</h2>
            <p className="text-sm text-slate-500">Saved on this device. Import and manual questions do not need a generator.</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:bg-slate-100 p-2 rounded-xl" type="button"><X size={24} /></button>
        </div>

        {error && <p className="mb-4 p-3 bg-red-50 text-red-600 rounded-xl text-sm font-bold">{error}</p>}

        <div className="grid sm:grid-cols-2 gap-4 mb-4">
          <label className="block text-xs font-black uppercase text-slate-500">
            Course
            <select value={courseId} onChange={(e) => {
              const next = e.target.value;
              const selected = state.courses.find((item) => item.id === next);
              setCourseId(next);
              setTopicId('');
              setSemester(selected?.semester || '');
              setMaterialId('');
              setObjectiveId('');
            }} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-bold text-slate-800">
              <option value="">Choose a course</option>
              {state.courses.map((item) => <option key={item.id} value={item.id}>{item.courseCode} — {item.courseName}</option>)}
            </select>
          </label>
          <label className="block text-xs font-black uppercase text-slate-500">
            Topic
            <select value={topicId} onChange={(e) => setTopicId(e.target.value)} disabled={!courseId} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-bold text-slate-800 disabled:opacity-50">
              <option value="">Choose a topic</option>
              {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.topicName}</option>)}
            </select>
          </label>
          <label className="block text-xs font-black uppercase text-slate-500">
            Semester
            <input value={semester} onChange={(e) => setSemester(e.target.value)} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-bold text-slate-800" />
          </label>
          <label className="block text-xs font-black uppercase text-slate-500">
            Difficulty
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as ExamQuestion['difficulty'])} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-bold text-slate-800">
              {Object.entries(DIFFICULTY_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <label className="block text-xs font-black uppercase text-slate-500">
            Question type
            <select value={questionType} onChange={(e) => setQuestionType(e.target.value as ExamQuestion['questionType'])} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-bold text-slate-800">
              {Object.entries(TYPE_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <label className="block text-xs font-black uppercase text-slate-500">
            Source
            <select value={origin} onChange={(e) => setOrigin(e.target.value as QuestionOrigin)} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-bold text-slate-800">
              {ORIGINS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        </div>

        {origin === 'pdf' && (
          <label className="block text-xs font-black uppercase text-slate-500 mb-4">
            PDF
            <select value={materialId} onChange={(e) => setMaterialId(e.target.value)} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-bold text-slate-800">
              <option value="">{pdfs.length ? 'Optional file' : 'No PDF in this course'}</option>
              {pdfs.map((slide) => <option key={slide.id} value={slide.id}>{slide.title || slide.originalName}</option>)}
            </select>
          </label>
        )}
        {origin === 'slide' && (
          <label className="block text-xs font-black uppercase text-slate-500 mb-4">
            Presentation
            <select value={materialId} onChange={(e) => setMaterialId(e.target.value)} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-bold text-slate-800">
              <option value="">{decks.length ? 'Optional file' : 'No presentation in this course'}</option>
              {decks.map((slide) => <option key={slide.id} value={slide.id}>{slide.title || slide.originalName}</option>)}
            </select>
          </label>
        )}
        {origin === 'objective' && (
          <label className="block text-xs font-black uppercase text-slate-500 mb-4">
            Learning objective
            <select value={objectiveId} onChange={(e) => setObjectiveId(e.target.value)} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-bold text-slate-800">
              <option value="">{objectives.length ? 'Optional objective' : 'No objectives in this course'}</option>
              {objectives.map((item) => <option key={item.id} value={item.id}>{item.objectiveText}</option>)}
            </select>
          </label>
        )}
        {(origin === 'pdf' || origin === 'slide') && (
          <label className="block text-xs font-black uppercase text-slate-500 mb-4">
            {origin === 'pdf' ? 'Page' : 'Slide number'}
            <input value={page} onChange={(e) => setPage(e.target.value)} inputMode="numeric" className="mt-1 w-32 border-2 border-slate-200 rounded-xl p-3 text-sm font-bold text-slate-800" />
          </label>
        )}

        <label className="block text-xs font-black uppercase text-slate-500 mb-4">
          Question
          <textarea value={questionText} onChange={(e) => setQuestionText(e.target.value)} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-semibold text-slate-800 min-h-[90px]" />
        </label>

        {questionType === 'mcq' ? (
          <div className="space-y-2 mb-4">
            <p className="text-xs font-black uppercase text-slate-500">Choices and correct answer</p>
            {options.map((option, index) => (
              <div key={index} className="flex items-center gap-2">
                <input type="radio" name="new-correct" checked={correctOption === index} onChange={() => setCorrectOption(index)} />
                <span className="w-5 font-black text-slate-400">{String.fromCharCode(65 + index)}</span>
                <input value={option} onChange={(e) => {
                  const next = [...options];
                  next[index] = e.target.value;
                  setOptions(next);
                }} className="flex-1 border-2 border-slate-200 rounded-xl p-2 text-sm" />
              </div>
            ))}
          </div>
        ) : (
          <label className="block text-xs font-black uppercase text-slate-500 mb-4">
            Correct answer
            <input value={correctAnswer} onChange={(e) => setCorrectAnswer(e.target.value)} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-semibold text-slate-800" />
          </label>
        )}

        <label className="block text-xs font-black uppercase text-slate-500 mb-6">
          Explanation
          <textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm text-slate-700 min-h-[70px]" />
        </label>

        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className="px-6 py-3 rounded-xl text-slate-600 font-bold">Cancel</button>
          <button type="button" onClick={save} className="px-8 py-3 bg-[#2D6A4F] text-white rounded-xl font-bold">Save question</button>
        </div>
      </div>
    </div>
  );
};

export default AddQuestionModal;

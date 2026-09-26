import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { FileQuestion, Upload, Plus, X, Trash2, CheckCircle2, Edit2, ChevronDown, ChevronUp, BookOpen, Layers, AlertCircle, Sparkles } from 'lucide-react';
import { ExamQuestion } from '../types';
import { v4 as uuidv4 } from 'uuid';
import QuestionAnalytics from '../components/QuestionAnalytics';
import AddQuestionModal from '../components/AddQuestionModal';
import { allQuestionPerformance, bankAnalytics, createQuestion, sourceLabel, TYPE_LABEL } from '../utils/questionBank';

const QuestionBank = () => {
  const { state, dispatch } = useApp();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const questionId = params.get('question');
  /** Questions the student picked to send to the AI as context. */
  const [selectedForAI, setSelectedForAI] = useState<Set<string>>(new Set());
  const questionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const appliedQuestion = useRef('');
  
  // Import Modal State
  const [showImportModal, setShowImportModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [jsonInput, setJsonInput] = useState('');
  const [error, setError] = useState('');
  const [selectedCourseId, setSelectedCourseId] = useState('');
  const [selectedTopicId, setSelectedTopicId] = useState('');

  // Edit Modal State
  const [editingQuestion, setEditingQuestion] = useState<ExamQuestion | null>(null);
  const [editForm, setEditForm] = useState({ questionText: '', options: ['', '', '', ''], correctOption: 0, modelAnswer: '', difficulty: 'medium' as ExamQuestion['difficulty'], semester: '', questionType: 'mcq' as ExamQuestion['questionType'], correctAnswer: '' });

  // Accordion State
  const [expandedCourses, setExpandedCourses] = useState<Set<string>>(new Set());
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set());

  const filteredTopics = state.topics.filter(t => t.courseId === selectedCourseId);

  useEffect(() => {
    if (!questionId || appliedQuestion.current === questionId) return;
    const question = state.examQuestions.find((q) => q.id === questionId);
    if (!question) return;
    appliedQuestion.current = questionId;
    if (question.courseId) setExpandedCourses((prev) => new Set(prev).add(question.courseId));
    if (question.topicId) setExpandedTopics((prev) => new Set(prev).add(question.topicId));
    const timer = window.setTimeout(() => {
      questionRefs.current[questionId]?.scrollIntoView({ block: 'center' });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [questionId, state.examQuestions]);

  const toggleCourse = (id: string) => {
    const next = new Set(expandedCourses);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedCourses(next);
  };

  const toggleTopic = (id: string) => {
    const next = new Set(expandedTopics);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedTopics(next);
  };

  const toggleAiSelection = (id: string) => {
    setSelectedForAI((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 8) next.add(id);
      return next;
    });
  };

  /**
   * Hands the picked questions to the AI workspace. Only their ids travel in the
   * URL; the engine rebuilds the context from the bank, so nothing else is sent.
   */
  const askAiAboutSelected = () => {
    const ids = [...selectedForAI].slice(0, 8);
    if (!ids.length) return;
    const first = state.examQuestions.find((q) => q.id === ids[0]);
    const query = new URLSearchParams({ questions: ids.join(',') });
    if (first?.topicId) query.set('topic', first.topicId);
    if (first?.courseId) query.set('course', first.courseId);
    navigate(`/ai?${query.toString()}`);
  };

  const handleImport = () => {
    if (!selectedCourseId || !selectedTopicId) {
      setError('Please select a specific Course and Topic before importing.');
      return;
    }
    try {
      const parsed = JSON.parse(jsonInput);
      if (!Array.isArray(parsed)) throw new Error('JSON must be an array of objects.');
      
      const course = state.courses.find((item) => item.id === selectedCourseId);
      const allowedTypes = ['mcq', 'short_answer', 'structured', 'essay', 'case_study'];
      const newQuestions: ExamQuestion[] = parsed.map((q: any) => {
        if (!q.question_text || !q.choices || q.correct_answer === undefined) throw new Error('Missing required fields in one or more questions.');
        const rawType = q.question_type === 'multiple_choice' ? 'mcq' : q.question_type || 'mcq';
        const difficulty = q.difficulty === 'easy' || q.difficulty === 'hard' || q.difficulty === 'medium' ? q.difficulty : 'medium';
        return createQuestion({
          id: uuidv4(),
          courseId: selectedCourseId,
          topicId: selectedTopicId,
          semester: typeof q.semester === 'string' && q.semester.trim() ? q.semester : course?.semester,
          questionText: q.question_text,
          questionType: allowedTypes.includes(rawType) ? rawType : 'mcq',
          difficulty,
          options: q.choices,
          correctOption: Number(q.correct_answer),
          explanation: q.explanation || '',
          source: { origin: 'imported', label: 'Imported JSON' },
          tags: ['imported'],
          isImported: true,
        });
      });

      dispatch({ type: 'ADD_EXAM_QUESTIONS', payload: newQuestions });
      
      // Auto-expand the folders so the user sees their new upload instantly
      setExpandedCourses(prev => new Set([...prev, selectedCourseId]));
      setExpandedTopics(prev => new Set([...prev, selectedTopicId]));
      
      setShowImportModal(false); setJsonInput(''); setError('');
    } catch (err: any) { setError(err.message || 'Invalid JSON format'); }
  };

  const handleDelete = (id: string) => {
    if (window.confirm("Are you sure you want to delete this question?")) dispatch({ type: 'DELETE_EXAM_QUESTION', payload: id });
  };

  const handleDeleteTopicQuestions = (topicId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm("WARNING: Delete ALL questions in this topic?")) {
      const qs = state.examQuestions.filter(q => q.topicId === topicId);
      qs.forEach(q => dispatch({ type: 'DELETE_EXAM_QUESTION', payload: q.id }));
    }
  };

  const openEditModal = (q: ExamQuestion) => {
    setEditingQuestion(q);
    setEditForm({
      questionText: q.questionText,
      options: q.options?.length ? q.options : ['', '', '', ''],
      correctOption: q.correctOption || 0,
      modelAnswer: q.explanation || q.modelAnswer || '',
      difficulty: q.difficulty,
      semester: q.semester || state.courses.find((course) => course.id === q.courseId)?.semester || '',
      questionType: q.questionType,
      correctAnswer: q.correctAnswer || '',
    });
  };

  const saveEdit = () => {
    if (!editingQuestion) return;
    const correctAnswer = editForm.questionType === 'mcq'
      ? (editForm.options[editForm.correctOption] || editForm.correctAnswer)
      : editForm.correctAnswer;
    dispatch({ type: 'UPDATE_EXAM_QUESTION', payload: { id: editingQuestion.id, updates: {
      questionText: editForm.questionText,
      questionType: editForm.questionType,
      difficulty: editForm.difficulty,
      semester: editForm.semester,
      options: editForm.questionType === 'mcq' ? editForm.options : editingQuestion.options,
      correctOption: editForm.questionType === 'mcq' ? editForm.correctOption : editingQuestion.correctOption,
      correctAnswer,
      modelAnswer: editForm.modelAnswer,
      explanation: editForm.modelAnswer,
    } } });
    setEditingQuestion(null);
  };

  // Group questions hierarchy
  const groupedData = state.courses.map(course => {
    const courseTopics = state.topics.filter(t => t.courseId === course.id).map(topic => {
      return { ...topic, questions: state.examQuestions.filter(q => q.topicId === topic.id) };
    }).filter(t => t.questions.length > 0);
    return { ...course, topics: courseTopics, totalQs: courseTopics.reduce((sum, t) => sum + t.questions.length, 0) };
  }).filter(c => c.totalQs > 0);

  const uncategorizedQs = state.examQuestions.filter(q => !state.courses.find(c => c.id === q.courseId));
  const analytics = useMemo(() => bankAnalytics(state), [state]);
  const questionStats = useMemo(() => allQuestionPerformance(state), [state.examQuestions, state.quizHistory]);

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <div className="bg-gradient-to-r from-indigo-900 via-purple-800 to-fuchsia-800 rounded-[2rem] p-10 text-white shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 right-0 p-8 opacity-20"><FileQuestion size={120} /></div>
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-2"><span className="px-3 py-1 bg-white/20 rounded-full text-xs font-black tracking-widest uppercase backdrop-blur-md">Question Engine</span></div>
          <h1 className="text-4xl font-black mb-3 tracking-tight">Question Bank</h1>
          <p className="text-purple-200 text-lg max-w-xl leading-relaxed">Add or import questions. Generated questions are optional — the bank works without them.</p>
        </div>
      </div>

      <div className="flex justify-between items-center bg-white p-4 rounded-2xl shadow-sm border border-slate-100">
        <div className="flex items-center gap-3 px-4">
           <div className="w-10 h-10 bg-purple-100 text-purple-600 rounded-xl flex items-center justify-center font-bold text-lg">{state.examQuestions.length}</div>
           <div><p className="font-bold text-slate-800">Total Questions</p><p className="text-xs text-slate-500 uppercase font-semibold">Across all courses</p></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={askAiAboutSelected}
            disabled={selectedForAI.size === 0}
            title={selectedForAI.size ? 'Send only these questions to the AI' : 'Tick a question first'}
            className="bg-white border border-slate-200 text-slate-800 px-5 py-3.5 rounded-xl font-bold flex items-center gap-2 hover:bg-slate-50 disabled:opacity-40"
          >
            <Sparkles size={18} />
            <span>Ask AI about {selectedForAI.size ? `${selectedForAI.size} selected` : 'questions'}</span>
          </button>
          <button onClick={() => setShowAddModal(true)} className="bg-white border border-slate-200 text-slate-800 px-5 py-3.5 rounded-xl font-bold flex items-center gap-2 hover:bg-slate-50">
            <Plus size={18} /><span>Add question</span>
          </button>
          <button onClick={() => setShowImportModal(true)} className="bg-[#2D6A4F] hover:bg-[#1B4332] text-white px-8 py-3.5 rounded-xl shadow-lg shadow-[#2D6A4F]/30 transition-all flex items-center space-x-2 font-bold hover:scale-105">
            <Upload size={20} /><span>Import JSON Bank</span>
          </button>
        </div>
      </div>

      <QuestionAnalytics analytics={analytics} />

      <div className="space-y-4">
        {groupedData.length === 0 && uncategorizedQs.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-3xl shadow-sm border border-slate-100">
            <FileQuestion className="mx-auto h-20 w-20 text-slate-200 mb-6" />
            <h3 className="text-2xl font-black text-slate-700 mb-2">Your Bank is Empty</h3>
            <p className="text-slate-500 font-medium">Add a question or import a JSON bank. You do not need a generator.</p>
          </div>
        ) : (
          groupedData.map(course => (
            <div key={course.id} className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <button onClick={() => toggleCourse(course.id)} className="w-full flex items-center justify-between p-5 bg-slate-50 hover:bg-slate-100 transition-colors border-b border-slate-200">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-indigo-100 text-indigo-700 rounded-xl flex items-center justify-center"><BookOpen size={24} /></div>
                  <div className="text-left"><h2 className="text-xl font-bold text-slate-800">{course.courseCode}: {course.courseName}</h2><p className="text-sm font-semibold text-slate-500">{course.totalQs} Questions Available</p></div>
                </div>
                <div className="p-2 bg-white rounded-full shadow-sm">{expandedCourses.has(course.id) ? <ChevronUp className="text-slate-400" /> : <ChevronDown className="text-slate-400" />}</div>
              </button>

              {expandedCourses.has(course.id) && (
                <div className="p-4 space-y-4 bg-slate-50/50">
                  {course.topics.map(topic => (
                    <div key={topic.id} className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                       <div className="w-full flex items-center justify-between p-4 bg-white hover:bg-slate-50 transition-colors cursor-pointer border-b border-slate-100" onClick={() => toggleTopic(topic.id)}>
                         <div className="flex items-center gap-3">
                           <div className="w-8 h-8 bg-purple-100 text-purple-600 rounded-lg flex items-center justify-center"><Layers size={18} /></div>
                           <h3 className="font-bold text-slate-700">{topic.topicName}</h3>
                           <span className="px-2.5 py-1 bg-slate-100 text-slate-600 rounded-md text-xs font-black">{topic.questions.length} Qs</span>
                         </div>
                         <div className="flex items-center gap-3">
                           <button onClick={(e) => handleDeleteTopicQuestions(topic.id, e)} className="text-red-400 hover:text-red-600 hover:bg-red-50 p-2 rounded-lg transition-colors font-bold text-xs flex items-center gap-1"><Trash2 size={14}/> Clear Topic</button>
                           {expandedTopics.has(topic.id) ? <ChevronUp size={20} className="text-slate-400"/> : <ChevronDown size={20} className="text-slate-400"/>}
                         </div>
                       </div>

                       {expandedTopics.has(topic.id) && (
                         <div className="p-5 grid gap-4 bg-slate-50/30">
                           {topic.questions.map((q, idx) => (
                             <div key={q.id} ref={(el) => { questionRefs.current[q.id] = el; }} data-question-id={q.id} className={`bg-white p-5 rounded-xl border shadow-sm hover:shadow-md transition-shadow relative group ${questionId === q.id ? 'border-[#2D6A4F] ring-2 ring-[#2D6A4F]/40' : 'border-slate-200'}`}>
                                <div className="absolute top-4 right-4 flex opacity-0 group-hover:opacity-100 transition-opacity gap-2">
                                   <button onClick={() => openEditModal(q)} className="p-2 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg transition-colors"><Edit2 size={16} /></button>
                                   <button onClick={() => handleDelete(q.id)} className="p-2 bg-red-50 text-red-600 hover:bg-red-100 rounded-lg transition-colors"><Trash2 size={16} /></button>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 mb-3 pr-16">
                                  <span className="bg-slate-800 text-white px-2.5 py-1 rounded text-xs font-black tracking-widest">Q{idx + 1}</span>
                                  <label className="flex items-center gap-1.5 bg-slate-100 text-slate-600 px-2 py-1 rounded text-[10px] font-black uppercase cursor-pointer select-none">
                                    <input
                                      type="checkbox"
                                      checked={selectedForAI.has(q.id)}
                                      onChange={() => toggleAiSelection(q.id)}
                                      data-testid={`ai-select-${q.id}`}
                                    />
                                    Ask AI
                                  </label>
                                  <span className="bg-slate-100 text-slate-600 px-2 py-1 rounded text-[10px] font-black uppercase">{TYPE_LABEL[q.questionType] || q.questionType}</span>
                                  <span className="bg-slate-100 text-slate-600 px-2 py-1 rounded text-[10px] font-black uppercase">{q.difficulty}</span>
                                  <span className="bg-indigo-50 text-indigo-700 px-2 py-1 rounded text-[10px] font-black uppercase">{q.semester || course.semester || 'Semester'}</span>
                                  <span className="bg-green-100 text-green-700 px-2 py-1 rounded text-[10px] font-black uppercase flex items-center gap-1"><CheckCircle2 size={12} /> {sourceLabel(q)}</span>
                                  {questionStats.get(q.id)?.weak && <span className="bg-red-50 text-red-600 px-2 py-1 rounded text-[10px] font-black uppercase">Needs review</span>}
                                </div>
                                <h4 className="text-lg font-bold text-slate-800 mb-2 pr-20">{q.questionText}</h4>
                                <p className="text-xs font-semibold text-slate-500 mb-4">
                                  {questionStats.get(q.id)?.attempts
                                    ? `${questionStats.get(q.id)?.attempts} attempts · ${questionStats.get(q.id)?.accuracy}% accuracy · last ${new Date(questionStats.get(q.id)!.lastAttempted || '').toLocaleDateString()}`
                                    : 'Not attempted yet'}
                                  {questionStats.get(q.id)?.improvement != null && questionStats.get(q.id)?.improvement !== 0
                                    ? ` · ${((questionStats.get(q.id)?.improvement || 0) > 0 ? '+' : '') + questionStats.get(q.id)?.improvement} pts`
                                    : ''}
                                </p>
                                {q.questionType !== 'mcq' && q.correctAnswer && <p className="text-sm text-green-800 mb-3"><strong>Correct answer:</strong> {q.correctAnswer}</p>}
                                {q.options && (
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
                                    {q.options.map((opt, oIdx) => (
                                      <div key={oIdx} className={`p-3 rounded-lg border ${oIdx === q.correctOption ? 'bg-green-50 border-green-200 text-green-900 font-semibold' : 'bg-slate-50 border-slate-100 text-slate-600'}`}><span className="mr-2 font-black opacity-50">{String.fromCharCode(65 + oIdx)}.</span>{opt}</div>
                                    ))}
                                  </div>
                                )}
                                {(q.explanation || q.modelAnswer) && <div className="bg-blue-50/50 p-4 rounded-xl border border-blue-100 text-sm text-blue-900"><strong className="text-blue-700 uppercase text-xs tracking-widest block mb-1">Explanation</strong>{q.explanation || q.modelAnswer}</div>}
                                {(questionStats.get(q.id)?.history.length || 0) > 0 && (
                                  <details className="mt-3 text-sm text-slate-600">
                                    <summary className="cursor-pointer font-bold text-slate-500">Attempt history</summary>
                                    <ul className="mt-2 space-y-1">
                                      {questionStats.get(q.id)?.history.slice().reverse().map((attempt) => (
                                        <li key={`${attempt.quizId}-${attempt.at}`}>{new Date(attempt.at).toLocaleDateString()} · {attempt.isCorrect ? 'Correct' : 'Incorrect'}</li>
                                      ))}
                                    </ul>
                                  </details>
                                )}
                             </div>
                           ))}
                         </div>
                       )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* IMPORT MODAL */}
      {showImportModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-[200]">
          <div className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full p-8 flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-black text-slate-800">Import JSON Bank</h2>
              <button onClick={() => setShowImportModal(false)} className="text-slate-400 hover:bg-slate-100 p-2 rounded-xl transition-colors"><X size={24} /></button>
            </div>
            
            <div className="mb-6 text-sm text-slate-600 bg-slate-50 border border-slate-200 p-5 rounded-2xl">
              <p className="font-bold text-slate-800 mb-2">Required JSON Schema:</p>
              <pre className="text-xs bg-slate-900 text-green-400 p-4 rounded-xl overflow-x-auto shadow-inner leading-relaxed">
{`[
  {
    "question_text": "What is the primary mechanism of action of Aspirin?",
    "question_type": "multiple_choice",
    "choices": ["A", "B", "C", "D"],
    "correct_answer": 0,
    "explanation": "Aspirin irreversibly inhibits COX-1..."
  }
]`}
              </pre>
            </div>

            {error && <div className="mb-4 p-4 bg-red-50 text-red-600 border border-red-200 rounded-xl text-sm font-bold flex items-center gap-2"><AlertCircle size={18}/> {error}</div>}

            <div className="flex gap-4 mb-4">
              <div className="flex-1">
                <label className="block text-[10px] font-black tracking-widest text-slate-500 uppercase mb-2">Target Course</label>
                <select value={selectedCourseId} onChange={(e) => { setSelectedCourseId(e.target.value); setSelectedTopicId(''); }} className="w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-bold focus:border-purple-500 outline-none bg-white">
                  <option value="">-- Choose Course --</option>
                  {state.courses.map(c => <option key={c.id} value={c.id}>{c.courseCode} - {c.courseName}</option>)}
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-[10px] font-black tracking-widest text-slate-500 uppercase mb-2">Target Topic</label>
                <select value={selectedTopicId} onChange={(e) => setSelectedTopicId(e.target.value)} disabled={!selectedCourseId} className="w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-bold focus:border-purple-500 outline-none bg-white disabled:opacity-50 disabled:bg-slate-50">
                  <option value="">-- Choose Topic --</option>
                  {filteredTopics.map(t => <option key={t.id} value={t.id}>{t.topicName}</option>)}
                </select>
              </div>
            </div>

            <textarea value={jsonInput} onChange={(e) => setJsonInput(e.target.value)} className="flex-1 w-full border-2 border-slate-200 rounded-2xl p-5 font-mono text-sm focus:border-purple-500 outline-none resize-none min-h-[150px] mb-6 shadow-inner bg-slate-50" placeholder="Paste your JSON array here..." />

            <div className="flex justify-end space-x-3">
              <button onClick={() => setShowImportModal(false)} className="px-6 py-3 rounded-xl text-slate-600 hover:bg-slate-100 font-bold transition-colors">Cancel</button>
              <button onClick={handleImport} className="px-8 py-3 bg-[#2D6A4F] hover:bg-[#1B4332] text-white rounded-xl font-bold shadow-lg shadow-[#2D6A4F]/30 transition-all">Import Questions</button>
            </div>
          </div>
        </div>
      )}

      {/* EDIT MODAL */}
      {editingQuestion && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-[200]">
          <div className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full p-8 flex flex-col max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6 border-b pb-4">
              <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2"><Edit2 className="text-blue-500"/> Edit Question</h2>
              <button onClick={() => setEditingQuestion(null)} className="text-slate-400 hover:bg-slate-100 p-2 rounded-xl transition-colors"><X size={24} /></button>
            </div>
            
            <div className="space-y-5">
              <div className="grid sm:grid-cols-3 gap-3">
                <label className="block text-[10px] font-black tracking-widest text-slate-500 uppercase">Type
                  <select value={editForm.questionType} onChange={(e) => setEditForm({...editForm, questionType: e.target.value as ExamQuestion['questionType']})} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-bold">
                    <option value="mcq">MCQ</option>
                    <option value="short_answer">Short answer</option>
                    <option value="structured">Structured</option>
                    <option value="essay">Essay</option>
                    <option value="case_study">Case study</option>
                  </select>
                </label>
                <label className="block text-[10px] font-black tracking-widest text-slate-500 uppercase">Difficulty
                  <select value={editForm.difficulty} onChange={(e) => setEditForm({...editForm, difficulty: e.target.value as ExamQuestion['difficulty']})} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-bold">
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                  </select>
                </label>
                <label className="block text-[10px] font-black tracking-widest text-slate-500 uppercase">Semester
                  <input value={editForm.semester} onChange={(e) => setEditForm({...editForm, semester: e.target.value})} className="mt-1 w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-bold" />
                </label>
              </div>
              <div>
                <label className="block text-[10px] font-black tracking-widest text-slate-500 uppercase mb-2">Question Text</label>
                <textarea value={editForm.questionText} onChange={(e) => setEditForm({...editForm, questionText: e.target.value})} className="w-full border-2 border-slate-200 rounded-xl p-4 font-semibold text-slate-800 outline-none focus:border-blue-500 min-h-[100px]" />
              </div>

              {editForm.questionType !== 'mcq' && (
                <div>
                  <label className="block text-[10px] font-black tracking-widest text-slate-500 uppercase mb-2">Correct answer</label>
                  <input value={editForm.correctAnswer} onChange={(e) => setEditForm({...editForm, correctAnswer: e.target.value})} className="w-full border-2 border-slate-200 rounded-xl p-3 text-sm font-semibold" />
                </div>
              )}
              {editForm.questionType === 'mcq' && <div>
                <label className="block text-[10px] font-black tracking-widest text-slate-500 uppercase mb-2">Options & Correct Answer</label>
                <div className="space-y-3 bg-slate-50 p-4 rounded-2xl border border-slate-100">
                   {editForm.options.map((opt, idx) => (
                      <div key={idx} className="flex items-center gap-3">
                         <input type="radio" name="correctOpt" checked={editForm.correctOption === idx} onChange={() => setEditForm({...editForm, correctOption: idx})} className="w-5 h-5 text-blue-600 focus:ring-blue-500" />
                         <span className="font-black text-slate-400 w-6">{String.fromCharCode(65 + idx)}.</span>
                         <input type="text" value={opt} onChange={(e) => { const newOpts = [...editForm.options]; newOpts[idx] = e.target.value; setEditForm({...editForm, options: newOpts}); }} className={`flex-1 border-2 rounded-xl p-3 outline-none transition-all font-medium ${editForm.correctOption === idx ? 'border-green-400 bg-green-50 text-green-900' : 'border-slate-200 bg-white focus:border-blue-400'}`} />
                      </div>
                   ))}
                </div>
              </div>}

              <div>
                <label className="block text-[10px] font-black tracking-widest text-slate-500 uppercase mb-2">Explanation (Model Answer)</label>
                <textarea value={editForm.modelAnswer} onChange={(e) => setEditForm({...editForm, modelAnswer: e.target.value})} className="w-full border-2 border-slate-200 rounded-xl p-4 font-medium text-slate-700 outline-none focus:border-blue-500 min-h-[80px]" />
              </div>
            </div>

            <div className="flex justify-end space-x-3 mt-8 pt-4 border-t">
              <button onClick={() => setEditingQuestion(null)} className="px-6 py-3 rounded-xl text-slate-600 hover:bg-slate-100 font-bold transition-colors">Cancel</button>
              <button onClick={saveEdit} className="px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold shadow-lg shadow-blue-500/30 transition-all">Save Changes</button>
            </div>
          </div>
        </div>
      )}

      <AddQuestionModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onAdded={(question) => {
          setExpandedCourses((prev) => new Set([...prev, question.courseId]));
          if (question.topicId) setExpandedTopics((prev) => new Set([...prev, question.topicId]));
        }}
      />
    </div>
  );
};

export default QuestionBank;

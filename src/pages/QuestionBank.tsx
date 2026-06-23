import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { FileQuestion, Upload, X, Trash2, CheckCircle2 } from 'lucide-react';
import { ExamQuestion } from '../types';

const QuestionBank = () => {
  const { state, dispatch } = useApp();
  const [showModal, setShowModal] = useState(false);
  const [jsonInput, setJsonInput] = useState('');
  const [error, setError] = useState('');

  const handleImport = () => {
    try {
      const parsed = JSON.parse(jsonInput);
      if (!Array.isArray(parsed)) throw new Error('JSON must be an array of objects.');
      
      const newQuestions: ExamQuestion[] = parsed.map((q: any) => {
        if (!q.question_text || !q.choices || q.correct_answer === undefined) {
          throw new Error('Missing required fields in one or more questions.');
        }
        return {
          id: Date.now().toString() + Math.random().toString(36).substring(2, 9),
          courseId: 'imported',
          topicId: 'imported',
          questionText: q.question_text,
          questionType: q.question_type === 'multiple_choice' ? 'mcq' : q.question_type || 'mcq',
          options: q.choices,
          correctOption: q.correct_answer,
          modelAnswer: q.explanation || '',
          marksAllocation: 1,
          difficulty: 'medium',
          probability: 'medium',
          tags: ['imported'],
          isPracticed: false,
          needsReview: false,
          isSaved: false,
          createdAt: new Date().toISOString(),
          isImported: true // Custom flag to track imported questions
        } as unknown as ExamQuestion; // Cast needed because we attached a custom isImported field
      });

      dispatch({ type: 'ADD_EXAM_QUESTIONS', payload: newQuestions });
      setShowModal(false);
      setJsonInput('');
      setError('');
    } catch (err: any) {
      setError(err.message || 'Invalid JSON format');
    }
  };

  const handleDelete = (id: string) => {
    if (window.confirm("Are you sure you want to delete this question?")) {
      dispatch({ type: 'DELETE_EXAM_QUESTION', payload: id });
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="bg-gradient-to-r from-purple-600 to-pink-600 rounded-2xl p-8 text-white shadow-lg flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold mb-2">Question Bank</h1>
          <p className="text-purple-100">Manage and practice your imported questions.</p>
        </div>
        <FileQuestion size={48} className="opacity-50" />
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => setShowModal(true)}
          className="bg-white border border-slate-200 text-slate-800 hover:border-purple-500 hover:text-purple-600 px-6 py-3 rounded-xl shadow-sm transition-colors flex items-center space-x-2 font-semibold"
        >
          <Upload size={20} />
          <span>Import Questions (JSON)</span>
        </button>
      </div>

      <div className="space-y-6">
        {state.examQuestions.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-2xl shadow-sm border border-slate-100">
            <FileQuestion className="mx-auto h-12 w-12 text-slate-300 mb-4" />
            <h3 className="text-lg font-semibold text-slate-800">No questions available</h3>
            <p className="text-slate-500">Import questions via JSON to get started.</p>
          </div>
        ) : (
          state.examQuestions.map((q, idx) => (
            <div key={q.id} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 relative group">
              <div className="flex justify-between items-start mb-4">
                <div className="flex items-center space-x-3">
                  <span className="bg-purple-100 text-purple-700 px-3 py-1 rounded-lg font-bold">Q{idx + 1}</span>
                  {(q as any).isImported && (
                    <span className="bg-green-100 text-green-700 px-2 py-1 rounded text-xs font-semibold flex items-center">
                      <CheckCircle2 size={12} className="mr-1" /> Imported
                    </span>
                  )}
                </div>
                <button 
                  onClick={() => handleDelete(q.id)}
                  className="text-slate-400 hover:text-red-500 transition-colors p-2 rounded-lg hover:bg-red-50"
                  title="Delete question"
                >
                  <Trash2 size={18} />
                </button>
              </div>
              
              <h3 className="text-lg font-medium text-slate-800 mb-4">{q.questionText}</h3>
              
              {q.options && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                  {q.options.map((choice, cIdx) => (
                    <div 
                      key={cIdx} 
                      className={`p-3 rounded-xl border ${cIdx === q.correctOption ? 'bg-green-50 border-green-200 text-green-800' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                    >
                      <span className="font-semibold mr-2">{String.fromCharCode(65 + cIdx)}.</span>
                      {choice}
                    </div>
                  ))}
                </div>
              )}
              
              {q.modelAnswer && (
                <div className="bg-blue-50 p-4 rounded-xl text-sm text-blue-800">
                  <strong>Explanation:</strong> {q.modelAnswer}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full p-8 flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-slate-800">Import JSON Questions</h2>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:bg-slate-100 p-2 rounded-xl transition-colors">
                <X size={24} />
              </button>
            </div>
            
            <div className="mb-6 text-sm text-slate-600 bg-slate-50 border border-slate-200 p-5 rounded-2xl">
              <p className="font-bold text-slate-800 mb-2">Required JSON Schema:</p>
              <pre className="text-xs bg-slate-800 text-green-400 p-4 rounded-xl overflow-x-auto shadow-inner">
{`[
  {
    "question_text": "What is the primary mechanism of action of Aspirin?",
    "question_type": "multiple_choice",
    "choices": [
      "COX-1 and COX-2 irreversible inhibition",
      "Selective COX-2 inhibition",
      "Opioid receptor agonism",
      "GABA receptor agonism"
    ],
    "correct_answer": 0,
    "explanation": "Aspirin irreversibly inhibits COX-1 and COX-2 by acetylation."
  }
]`}
              </pre>
            </div>

            {error && <div className="mb-4 p-3 bg-red-50 text-red-600 border border-red-200 rounded-xl text-sm font-semibold">{error}</div>}

            <textarea
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              className="flex-1 w-full border border-slate-200 rounded-2xl p-5 font-mono text-sm focus:ring-4 focus:ring-purple-500/10 focus:border-purple-500 outline-none resize-none min-h-[200px] mb-6 shadow-inner bg-slate-50"
              placeholder="Paste your JSON array here..."
            />

            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowModal(false)}
                className="px-6 py-3 rounded-xl text-slate-600 hover:bg-slate-100 font-semibold transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                className="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-bold shadow-lg shadow-purple-500/30 transition-all"
              >
                Import Data
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default QuestionBank;

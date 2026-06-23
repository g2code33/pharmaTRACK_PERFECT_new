import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { Calendar, Upload, Trash2, FileText, X, Clock, MapPin } from 'lucide-react';
import { TimetableItem } from '../types';

const Timetable = () => {
  const { state, dispatch } = useApp();
  const [showModal, setShowModal] = useState(false);
  const [importType, setImportType] = useState<'class' | 'quiz' | 'exam'>('class');
  const [jsonInput, setJsonInput] = useState('');
  const [error, setError] = useState('');

  // Handle Visual PDF
  const handlePdfUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') return alert('Please upload a valid PDF file.');
    if (file.size > 4 * 1024 * 1024) return alert('PDF is too large. Max 4MB.');

    const reader = new FileReader();
    reader.onload = (event) => {
      dispatch({ type: 'LOAD_STATE', payload: { ...state, timetablePdf: event.target?.result as string } });
    };
    reader.readAsDataURL(file);
  };

  const handleRemove = () => {
    dispatch({ type: 'LOAD_STATE', payload: { ...state, timetablePdf: null } });
  }

  // Handle JSON Import
  const handleImport = () => {
    try {
      const parsed = JSON.parse(jsonInput);
      if (!Array.isArray(parsed)) throw new Error('JSON must be an array');
      
      const newItems: TimetableItem[] = parsed.map((item: any) => ({
        id: Date.now().toString() + Math.random().toString(36).substring(2, 9),
        subject: item.subject,
        date: item.date,
        time: item.time,
        location: item.location,
        type: importType
      }));

      dispatch({ type: 'ADD_TIMETABLE_ITEMS', payload: { items: newItems, category: importType } });
      setShowModal(false);
      setJsonInput('');
      setError('');
    } catch (err: any) {
      setError(err.message || 'Invalid JSON format');
    }
  };

  const handleDeleteItem = (id: string, category: 'class' | 'quiz' | 'exam') => {
    dispatch({ type: 'DELETE_TIMETABLE_ITEM', payload: { id, category } });
  };

  const renderSection = (title: string, category: 'class' | 'quiz' | 'exam', items: TimetableItem[], color: string) => (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden mb-8">
      <div className={`px-6 py-4 border-b border-slate-100 flex justify-between items-center ${color}`}>
        <h2 className="text-xl font-bold">{title}</h2>
        <span className="px-3 py-1 bg-white/20 rounded-lg text-sm font-semibold">{items.length} Items</span>
      </div>
      <div className="p-6">
        {items.length === 0 ? (
          <p className="text-slate-500 text-center py-4 font-medium">No schedule found for this category.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {items.map((item) => (
              <div key={item.id} className="p-5 rounded-xl border border-slate-100 bg-slate-50 relative group hover:shadow-md hover:border-[#2D6A4F]/30 transition-all">
                <button 
                  onClick={() => handleDeleteItem(item.id, category)}
                  className="absolute top-4 right-4 text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity bg-white p-1.5 rounded-lg shadow-sm"
                >
                  <Trash2 size={16} />
                </button>
                <h3 className="font-bold text-lg text-slate-800 mb-3 pr-8">{item.subject}</h3>
                <div className="space-y-2 text-sm font-medium text-slate-600">
                  <div className="flex items-center"><Calendar size={16} className="mr-3 text-[#2D6A4F]"/> {item.date}</div>
                  <div className="flex items-center"><Clock size={16} className="mr-3 text-[#FFB703]"/> {item.time}</div>
                  <div className="flex items-center"><MapPin size={16} className="mr-3 text-blue-500"/> {item.location}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="bg-gradient-to-r from-[#1B4332] to-[#2D6A4F] rounded-2xl p-8 text-white shadow-lg flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold mb-2">Offline Class Timetable</h1>
          <p className="text-green-100">Upload Visual PDFs or Import Structured JSON schedules.</p>
        </div>
        <Calendar size={48} className="opacity-50" />
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => setShowModal(true)}
          className="bg-white border border-slate-200 text-slate-800 hover:border-[#2D6A4F] hover:text-[#2D6A4F] px-6 py-3 rounded-xl shadow-sm transition-colors flex items-center space-x-2 font-semibold"
        >
          <Upload size={20} />
          <span>Import Schedule (JSON)</span>
        </button>
      </div>

      {renderSection('Class Schedule', 'class', state.timetables?.class || [], 'bg-blue-50 text-blue-800')}
      {renderSection('Upcoming Quizzes', 'quiz', state.timetables?.quiz || [], 'bg-yellow-50 text-yellow-800')}
      {renderSection('Examinations', 'exam', state.timetables?.exam || [], 'bg-red-50 text-red-800')}

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-slate-800 flex items-center"><FileText className="mr-2 text-green-600" /> Visual PDF Document</h2>
          {state.timetablePdf ? (
            <button onClick={handleRemove} className="text-red-500 hover:text-red-700 bg-red-50 px-4 py-2 rounded-lg font-semibold flex items-center cursor-pointer transition-all"><Trash2 size={18} className="mr-2" /> Remove PDF</button>
          ) : (
            <label className="cursor-pointer bg-[#0F172A] hover:bg-[#1B4332] text-white px-4 py-2 rounded-lg font-semibold flex items-center transition-all shadow-md"><Upload size={18} className="mr-2" /> Upload PDF<input type="file" accept="application/pdf" className="hidden" onChange={handlePdfUpload} /></label>
          )}
        </div>
        
        {state.timetablePdf ? (
          <div className="w-full bg-slate-100 rounded-xl overflow-hidden border border-slate-200">
            <object data={state.timetablePdf} type="application/pdf" className="w-full h-[600px]"></object>
          </div>
        ) : (
          <div className="text-center py-12 border-2 border-dashed border-slate-200 rounded-xl">
            <FileText className="mx-auto h-12 w-12 text-slate-300 mb-4" />
            <p className="text-slate-500 font-medium">No visual timetable uploaded.</p>
          </div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full p-8 flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-slate-800">Import Timetable Data</h2>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:bg-slate-100 p-2 rounded-xl transition-colors">
                <X size={24} />
              </button>
            </div>
            
            <div className="mb-6">
              <label className="block text-sm font-bold text-slate-500 uppercase tracking-widest mb-2">Category</label>
              <select
                value={importType}
                onChange={(e) => setImportType(e.target.value as any)}
                className="w-full px-5 py-4 bg-slate-50 rounded-2xl border border-slate-200 outline-none focus:ring-4 focus:ring-[#2D6A4F]/10 focus:border-[#2D6A4F] font-medium text-slate-800 appearance-none"
              >
                <option value="class">Class Schedule</option>
                <option value="quiz">Quiz</option>
                <option value="exam">Examination</option>
              </select>
            </div>

            <div className="mb-6 text-sm text-slate-600 bg-slate-50 border border-slate-200 p-5 rounded-2xl">
              <p className="font-bold text-slate-800 mb-2">Required JSON Schema:</p>
              <pre className="text-xs bg-slate-800 text-[#4ADE80] p-4 rounded-xl overflow-x-auto shadow-inner">
{`[
  {
    "subject": "Organic Chemistry 101",
    "date": "2026-06-10",
    "time": "10:00 AM",
    "location": "Science Lab A"
  }
]`}
              </pre>
            </div>

            {error && <div className="mb-4 p-3 bg-red-50 text-red-600 border border-red-200 rounded-xl text-sm font-semibold">{error}</div>}

            <textarea
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              className="flex-1 w-full border border-slate-200 rounded-2xl p-5 font-mono text-sm focus:ring-4 focus:ring-[#2D6A4F]/10 focus:border-[#2D6A4F] outline-none resize-none min-h-[150px] mb-6 shadow-inner bg-slate-50"
              placeholder="Paste your JSON array here..."
            />

            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowModal(false)}
                className="px-6 py-3 rounded-xl text-slate-600 hover:bg-slate-100 font-bold transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                className="px-6 py-3 bg-[#1B4332] hover:bg-[#2D6A4F] text-white rounded-xl font-bold shadow-lg shadow-[#1B4332]/30 transition-all"
              >
                Import Schedule
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default Timetable;

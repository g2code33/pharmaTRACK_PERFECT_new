import React, { useState, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useApp } from '../context/AppContext';
import { Note } from '../types';
import { Link } from 'react-router-dom';
import { StickyNote, Plus, Edit2, Trash2, X, Search, BookOpen, ChevronDown, ChevronUp, Sparkles, Download, Clock, Paperclip, FileText, Image, XCircle } from 'lucide-react';
import { format, parseISO } from 'date-fns';

const Notes: React.FC = () => {
  const { state, dispatch, getTopicsForCourse, getSlidesForTopic } = useApp();
  const [selectedCourse, setSelectedCourse] = useState('');
  const [selectedTopic, setSelectedTopic] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());
  const [isGenerating, setIsGenerating] = useState(false);
  const [formData, setFormData] = useState({
    topicId: '',
    noteText: '',
    attachedFiles: [] as { id: string; name: string; type: string; data: string }[]
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const courses = state.courses;
  const topics = selectedCourse ? getTopicsForCourse(selectedCourse) : state.topics;

  const filteredNotes = state.notes.filter((note) => {
    if (selectedTopic && note.topicId !== selectedTopic) return false;
    if (selectedCourse && !topics.some(t => t.id === note.topicId)) return false;
    if (searchQuery && !note.noteText.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const toggleNote = (id: string) => {
    const newExpanded = new Set(expandedNotes);
    newExpanded.has(id) ? newExpanded.delete(id) : newExpanded.add(id);
    setExpandedNotes(newExpanded);
  };

  const handleOpenModal = (topicId?: string) => {
    setEditingNote(null);
    setFormData({ topicId: topicId || selectedTopic || '', noteText: '', attachedFiles: [] });
    setShowModal(true);
  };

  const handleEdit = (note: Note) => {
    setEditingNote(note);
    setFormData({ topicId: note.topicId, noteText: note.noteText, attachedFiles: note.attachedFiles || [] });
    setShowModal(true);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        setFormData(prev => ({ ...prev, attachedFiles: [...prev.attachedFiles, { id: uuidv4(), name: file.name, type: file.type, data: reader.result as string }] }));
      };
      reader.readAsDataURL(file);
    });
  };

  const removeAttachedFile = (id: string) => {
    setFormData(prev => ({ ...prev, attachedFiles: prev.attachedFiles.filter(f => f.id !== id) }));
  };

  const handleSave = () => {
    if (!formData.topicId || !formData.noteText.trim()) return;

    if (editingNote) {
      dispatch({ type: 'UPDATE_NOTE', payload: { id: editingNote.id, updates: { noteText: formData.noteText, attachedFiles: formData.attachedFiles } } });
    } else {
      dispatch({ type: 'ADD_NOTE', payload: { id: uuidv4(), topicId: formData.topicId, noteText: formData.noteText, isAiGenerated: false, createdAt: new Date().toISOString(), avatar_url: state.student?.avatar_url, attachedFiles: formData.attachedFiles } });
    }
    setShowModal(false);
  };

  const handleDelete = (id: string) => {
    if (window.confirm('Delete this note permanently?')) dispatch({ type: 'DELETE_NOTE', payload: id });
  };

  const generateAiSummary = async (topicId: string) => {
    const slides = getSlidesForTopic(topicId);
    if (!slides.length) { alert('No study material to summarize for this topic.'); return; }
    
    setIsGenerating(true);
    const content = slides.map(s => s.contentText).join('\n\n').substring(0, 3000);

    try {
      if (state.openAIKey) {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${state.openAIKey}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: "Summarize this material in 3 bullet points: " + content }] }] })
        });
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          dispatch({ type: 'ADD_NOTE', payload: { id: uuidv4(), topicId, noteText: "🤖 AI Summary:\n" + text, isAiGenerated: true, createdAt: new Date().toISOString() } });
        }
      } else {
         setTimeout(() => { dispatch({ type: 'ADD_NOTE', payload: { id: uuidv4(), topicId, noteText: "🤖 AI Summary:\nTo enable AI summaries, add your Gemini 2.5 Flash API Key in Settings.", isAiGenerated: true, createdAt: new Date().toISOString() } }); }, 1000);
      }
    } catch (e) { alert("Failed to connect to AI"); } finally { setIsGenerating(false); }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2"><StickyNote className="w-7 h-7 text-[#2D6A4F]" /> My Study Notes</h1>
          <p className="text-gray-500">Capture insights and generate AI summaries</p>
        </div>
        <button onClick={() => handleOpenModal()} className="flex items-center gap-2 px-5 py-2.5 bg-[#2D6A4F] text-white font-bold rounded-xl hover:bg-[#1B4332] shadow-md transition-all"><Plus className="w-5 h-5" /> New Note</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <select value={selectedCourse} onChange={(e) => { setSelectedCourse(e.target.value); setSelectedTopic(''); }} className="px-4 py-2 border border-gray-300 rounded-lg outline-none bg-gray-50"><option value="">All Courses</option>{courses.map((c) => (<option key={c.id} value={c.id}>{c.courseCode}</option>))}</select>
        <select value={selectedTopic} onChange={(e) => setSelectedTopic(e.target.value)} disabled={!selectedCourse} className="px-4 py-2 border border-gray-300 rounded-lg outline-none bg-gray-50 disabled:opacity-50"><option value="">All Topics</option>{topics.map((t) => (<option key={t.id} value={t.id}>{t.topicName}</option>))}</select>
        <div className="relative"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" /><input type="text" placeholder="Search notes..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg outline-none bg-gray-50" /></div>
      </div>

      {selectedTopic && (
        <div className="flex justify-end">
          <button onClick={() => generateAiSummary(selectedTopic)} disabled={isGenerating} className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-600 to-blue-600 text-white font-bold rounded-lg hover:shadow-lg transition-all disabled:opacity-50">
            {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} {isGenerating ? 'Generating...' : 'AI Auto-Summarize Topic'}
          </button>
        </div>
      )}

      <div className="grid gap-4">
        {filteredNotes.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-xl border border-gray-100"><StickyNote className="w-12 h-12 text-gray-300 mx-auto mb-3" /><p className="text-gray-500 font-medium">No notes found.</p></div>
        ) : (
          filteredNotes.map((note) => {
            const topic = state.topics.find((t) => t.id === note.topicId);
            const course = state.courses.find((c) => c.id === topic?.courseId);
            const isExpanded = expandedNotes.has(note.id);

            return (
              <div key={note.id} className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm hover:shadow-md transition-shadow group">
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <h3 className="font-bold text-gray-800 text-lg mb-1">{topic?.topicName}</h3>
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">{course?.courseCode} • {format(parseISO(note.createdAt), 'MMM d, yyyy')}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {note.isAiGenerated && <span className="bg-purple-100 text-purple-700 text-[10px] font-black uppercase px-2 py-1 rounded-md flex items-center gap-1"><Sparkles className="w-3 h-3"/> AI Summary</span>}
                    <button onClick={() => handleEdit(note)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg"><Edit2 className="w-4 h-4" /></button>
                    <button onClick={() => handleDelete(note.id)} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>

                <div className="relative">
                  <p className={`text-gray-700 whitespace-pre-wrap leading-relaxed ${isExpanded ? '' : 'line-clamp-3'}`}>{note.noteText}</p>
                  {note.attachedFiles && note.attachedFiles.length > 0 && (
                      <div className="flex gap-2 overflow-x-auto mt-4 pb-2 hide-scrollbar">
                        {note.attachedFiles.map(file => (
                          <div key={file.id} className="relative flex-shrink-0 cursor-pointer hover:scale-105 transition-transform" onClick={() => {
                            if (file.type.startsWith('image/')) {
                              const w = window.open("");
                              if (w) w.document.write(`<img src="${file.data}" style="max-width:100%;height:auto;"/>`);
                            } else {
                              const link = document.createElement("a");
                              link.href = file.data; link.download = file.name; link.click();
                            }
                          }}>
                            {file.type.startsWith('image/') ? (
                              <img src={file.data} className="w-20 h-20 rounded-xl object-cover border border-gray-200 shadow-sm" alt="attachment" />
                            ) : (
                              <div className="w-20 h-20 bg-gray-50 text-gray-500 rounded-xl flex flex-col items-center justify-center border border-gray-200 shadow-sm"><FileText className="w-6 h-6" /><span className="text-[9px] font-black mt-1 truncate w-16 text-center">{file.name}</span></div>
                            )}
                          </div>
                        ))}
                      </div>
                  )}
                  {(note.noteText.split('\n').length > 3 || note.noteText.length > 150) && (
                    <button onClick={() => toggleNote(note.id)} className="mt-2 text-[#2D6A4F] text-sm font-bold flex items-center gap-1 hover:underline">
                      {isExpanded ? <>Show Less <ChevronUp className="w-4 h-4" /></> : <>Read More <ChevronDown className="w-4 h-4" /></>}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <h2 className="text-xl font-bold text-gray-800">{editingNote ? 'Edit Note' : 'Create Note'}</h2>
              <button onClick={() => setShowModal(false)} className="p-2 hover:bg-gray-100 rounded-full"><X className="w-5 h-5 text-gray-500" /></button>
            </div>
            
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-2">Select Topic</label>
                <select value={formData.topicId} onChange={(e) => setFormData({ ...formData, topicId: e.target.value })} disabled={!!editingNote} className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-[#2D6A4F] outline-none disabled:bg-gray-100">
                  <option value="">-- Choose a topic --</option>
                  {state.courses.map((course) => (
                    <optgroup key={course.id} label={course.courseName}>
                      {getTopicsForCourse(course.id).map((topic) => (
                        <option key={topic.id} value={topic.id}>{topic.topicName}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              <div className="pt-2">
                <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" multiple accept="image/*,.pdf,.doc,.docx" />
                <button type="button" onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 font-bold rounded-lg hover:bg-gray-200 transition-colors text-sm"><Paperclip className="w-4 h-4"/> Attach Files/Images</button>
                {formData.attachedFiles.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto mt-3 pb-2 hide-scrollbar">
                    {formData.attachedFiles.map(file => (
                      <div key={file.id} className="relative flex-shrink-0 group">
                        {file.type.startsWith('image/') ? (
                          <img src={file.data} className="w-16 h-16 rounded-xl object-cover border-2 border-gray-200 shadow-sm" alt="preview" />
                        ) : (
                          <div className="w-16 h-16 bg-blue-50 text-blue-500 rounded-xl flex flex-col items-center justify-center border-2 border-blue-100 shadow-sm"><FileText className="w-6 h-6" /><span className="text-[8px] font-black mt-1 truncate w-14 px-1">{file.name}</span></div>
                        )}
                        <button onClick={() => removeAttachedFile(file.id)} className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity shadow-md"><XCircle className="w-3 h-3"/></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-bold text-gray-700 mb-2">Note Content</label>
                <textarea value={formData.noteText} onChange={(e) => setFormData({ ...formData, noteText: e.target.value })} placeholder="Type your brilliant ideas here..." rows={8} className="w-full px-4 py-4 border border-gray-300 rounded-xl focus:ring-2 focus:ring-[#2D6A4F] outline-none resize-none bg-gray-50" />
              </div>

              <div className="flex justify-end gap-3 mt-8 pt-4 border-t border-gray-100">
                <button onClick={() => setShowModal(false)} className="px-6 py-3 font-bold text-gray-600 hover:bg-gray-100 rounded-xl transition-colors">Cancel</button>
                <button onClick={handleSave} disabled={!formData.topicId || !formData.noteText.trim()} className="px-8 py-3 bg-[#2D6A4F] text-white font-bold rounded-xl shadow-lg hover:bg-[#1B4332] disabled:opacity-50 transition-all">{editingNote ? 'Save Changes' : 'Create Note'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
export default Notes;

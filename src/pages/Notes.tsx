// PharmTrack - Notes Page

import React, { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useApp } from '../context/AppContext';
import { Note } from '../types';
import { Link } from 'react-router-dom';
import {
  StickyNote,
  Plus,
  Edit2,
  Trash2,
  X,
  Search,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Download,
  Clock,
} from 'lucide-react';
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
  });

  const courses = state.courses;
  const topics = selectedCourse ? getTopicsForCourse(selectedCourse) : [];

  // Get all notes or filter by topic
  const filteredNotes = state.notes.filter((note) => {
    const topic = state.topics.find((t) => t.id === note.topicId);
    if (!topic) return false;

    if (selectedCourse && topic.courseId !== selectedCourse) return false;
    if (selectedTopic && note.topicId !== selectedTopic) return false;
    if (searchQuery) {
      const searchLower = searchQuery.toLowerCase();
      if (
        !note.noteText.toLowerCase().includes(searchLower) &&
        !topic.topicName.toLowerCase().includes(searchLower)
      ) {
        return false;
      }
    }
    return true;
  });

  // Group notes by topic
  const notesByTopic: Record<string, Note[]> = {};
  filteredNotes.forEach((note) => {
    if (!notesByTopic[note.topicId]) {
      notesByTopic[note.topicId] = [];
    }
    notesByTopic[note.topicId].push(note);
  });

  const toggleExpand = (noteId: string) => {
    const newExpanded = new Set(expandedNotes);
    if (newExpanded.has(noteId)) {
      newExpanded.delete(noteId);
    } else {
      newExpanded.add(noteId);
    }
    setExpandedNotes(newExpanded);
  };

  const handleOpenModal = (topicId?: string) => {
    setEditingNote(null);
    setFormData({
      topicId: topicId || selectedTopic || '',
      noteText: '',
    });
    setShowModal(true);
  };

  const handleEdit = (note: Note) => {
    setEditingNote(note);
    setFormData({
      topicId: note.topicId,
      noteText: note.noteText,
    });
    setShowModal(true);
  };

  const handleSave = () => {
    if (!formData.topicId || !formData.noteText.trim()) return;

    if (editingNote) {
      dispatch({
        type: 'UPDATE_NOTE',
        payload: {
          id: editingNote.id,
          updates: {
            noteText: formData.noteText,
          },
        },
      });
    } else {
      const newNote: Note = {
        id: uuidv4(),
        topicId: formData.topicId,
        noteText: formData.noteText,
        isAiGenerated: false,
        createdAt: new Date().toISOString(),
      };
      dispatch({ type: 'ADD_NOTE', payload: newNote });
    }

    setShowModal(false);
  };

  const handleDelete = (id: string) => {
    if (window.confirm('Delete this note?')) {
      dispatch({ type: 'DELETE_NOTE', payload: id });
    }
  };

  const generateSummary = async (topicId: string) => {
    const topic = state.topics.find((t) => t.id === topicId);
    if (!topic) return;

    const slides = getSlidesForTopic(topicId);
    const slideContent = slides
      .map((s) => `${s.title}: ${s.contentText}`)
      .filter((c) => c.length > 2)
      .join('\n\n');

    if (!slideContent) {
      alert('No slide content available to generate summary. Please add some content to your slides first.');
      return;
    }

    setIsGenerating(true);

    try {
      let summaryText = '';

      if (state.openAIKey) {
        // Use OpenAI API
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.openAIKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [
              {
                role: 'system',
                content:
                  'You are a pharmacy study assistant. Create a concise, well-organized summary with key terms highlighted. Use bullet points and clear headings.',
              },
              {
                role: 'user',
                content: `Create a study summary for the topic "${topic.topicName}" based on this content:\n\n${slideContent}`,
              },
            ],
            temperature: 0.7,
          }),
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message);
        summaryText = data.choices[0].message.content;
      } else {
        // Generate basic summary without API
        summaryText = `📚 STUDY SUMMARY: ${topic.topicName.toUpperCase()}\n\n`;
        summaryText += `📋 OVERVIEW\n`;
        summaryText += `This topic covers ${slides.length} slides of content.\n\n`;

        summaryText += `📝 KEY POINTS\n`;
        slides.forEach((slide, idx) => {
          if (slide.contentText) {
            summaryText += `${idx + 1}. ${slide.title}\n`;
            summaryText += `   ${slide.contentText.slice(0, 200)}${slide.contentText.length > 200 ? '...' : ''}\n\n`;
          }
        });

        summaryText += `\n💡 STUDY TIPS\n`;
        summaryText += `• Review all slides in sequence\n`;
        summaryText += `• Create flashcards for key terms\n`;
        summaryText += `• Practice with related exam questions\n`;
        summaryText += `\n⚡ To get AI-powered summaries, add your OpenAI API key in Settings.`;
      }

      const newNote: Note = {
        id: uuidv4(),
        topicId,
        noteText: summaryText,
        isAiGenerated: true,
        createdAt: new Date().toISOString(),
      };

      dispatch({ type: 'ADD_NOTE', payload: newNote });
    } catch (error) {
      console.error('Error generating summary:', error);
      alert('Failed to generate summary. Please try again.');
    } finally {
      setIsGenerating(false);
    }
  };

  const exportNotes = () => {
    let exportText = '# PharmTrack Study Notes\n\n';

    Object.entries(notesByTopic).forEach(([topicId, notes]) => {
      const topic = state.topics.find((t) => t.id === topicId);
      const course = state.courses.find((c) => c.id === topic?.courseId);

      exportText += `## ${course?.courseCode} - ${topic?.topicName}\n\n`;
      notes.forEach((note) => {
        exportText += `### ${note.isAiGenerated ? '🤖 AI Summary' : '📝 Note'}\n`;
        exportText += `${note.noteText}\n\n`;
        exportText += `---\n\n`;
      });
    });

    const blob = new Blob([exportText], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'study_notes.md';
    a.click();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <StickyNote className="w-7 h-7 text-yellow-500" />
            My Notes
          </h1>
          <p className="text-gray-500">Create and organize study notes</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={exportNotes}
            disabled={filteredNotes.length === 0}
            className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <Download className="w-4 h-4" />
            Export
          </button>
          <button
            onClick={() => handleOpenModal()}
            disabled={state.topics.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white font-semibold rounded-lg hover:bg-[#1B4332] disabled:opacity-50"
          >
            <Plus className="w-5 h-5" />
            Add Note
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="Search notes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
            />
          </div>
          <div className="flex gap-3">
            <select
              value={selectedCourse}
              onChange={(e) => {
                setSelectedCourse(e.target.value);
                setSelectedTopic('');
              }}
              className="px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
            >
              <option value="">All Courses</option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.courseCode}
                </option>
              ))}
            </select>

            {selectedCourse && (
              <select
                value={selectedTopic}
                onChange={(e) => setSelectedTopic(e.target.value)}
                className="px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
              >
                <option value="">All Topics</option>
                {topics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.topicName}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {/* Notes content */}
      {state.courses.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100">
          <BookOpen className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-700 mb-2">No courses yet</h2>
          <p className="text-gray-500 mb-4">Add a course first to create notes</p>
          <Link
            to="/courses"
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg"
          >
            Go to Courses
          </Link>
        </div>
      ) : state.topics.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100">
          <StickyNote className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-700 mb-2">No topics yet</h2>
          <p className="text-gray-500 mb-4">Add topics to your courses first to create notes</p>
          <Link
            to="/courses"
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg"
          >
            Manage Courses
          </Link>
        </div>
      ) : Object.keys(notesByTopic).length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100">
          <StickyNote className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-700 mb-2">No notes yet</h2>
          <p className="text-gray-500 mb-4">Start taking notes or generate summaries</p>
          <button
            onClick={() => handleOpenModal()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg"
          >
            <Plus className="w-4 h-4" />
            Add Your First Note
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(notesByTopic).map(([topicId, notes]) => {
            const topic = state.topics.find((t) => t.id === topicId);
            const course = state.courses.find((c) => c.id === topic?.courseId);
            if (!topic) return null;

            return (
              <div key={topicId} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="p-4 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-1 bg-[#2D6A4F]/10 text-[#2D6A4F] text-xs font-semibold rounded">
                        {course?.courseCode}
                      </span>
                      <h3 className="font-semibold text-gray-800">{topic.topicName}</h3>
                    </div>
                    <p className="text-sm text-gray-500 mt-1">{notes.length} notes</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => generateSummary(topicId)}
                      disabled={isGenerating}
                      className="flex items-center gap-1 px-3 py-1.5 bg-purple-100 text-purple-700 text-sm rounded-lg hover:bg-purple-200 disabled:opacity-50"
                    >
                      <Sparkles className="w-4 h-4" />
                      {isGenerating ? 'Generating...' : 'AI Summary'}
                    </button>
                    <button
                      onClick={() => handleOpenModal(topicId)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-[#2D6A4F]/10 text-[#2D6A4F] text-sm rounded-lg hover:bg-[#2D6A4F]/20"
                    >
                      <Plus className="w-4 h-4" />
                      Add Note
                    </button>
                  </div>
                </div>

                <div className="divide-y divide-gray-100">
                  {notes.map((note) => {
                    const isExpanded = expandedNotes.has(note.id);
                    const preview = note.noteText.slice(0, 200);

                    return (
                      <div key={note.id} className="p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-2">
                              {note.isAiGenerated && (
                                <span className="flex items-center gap-1 px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded">
                                  <Sparkles className="w-3 h-3" />
                                  AI Generated
                                </span>
                              )}
                              <span className="flex items-center gap-1 text-xs text-gray-400">
                                <Clock className="w-3 h-3" />
                                {format(parseISO(note.createdAt), 'MMM d, yyyy')}
                              </span>
                            </div>
                            <div
                              className={`text-gray-700 whitespace-pre-wrap ${
                                !isExpanded && note.noteText.length > 200 ? 'line-clamp-3' : ''
                              }`}
                            >
                              {isExpanded ? note.noteText : preview}
                              {!isExpanded && note.noteText.length > 200 && '...'}
                            </div>
                            {note.noteText.length > 200 && (
                              <button
                                onClick={() => toggleExpand(note.id)}
                                className="flex items-center gap-1 text-sm text-[#2D6A4F] hover:underline mt-2"
                              >
                                {isExpanded ? (
                                  <>
                                    <ChevronUp className="w-4 h-4" />
                                    Show less
                                  </>
                                ) : (
                                  <>
                                    <ChevronDown className="w-4 h-4" />
                                    Read more
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleEdit(note)}
                              className="p-1.5 text-gray-400 hover:text-[#2D6A4F] hover:bg-gray-100 rounded"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDelete(note.id)}
                              className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white">
              <h2 className="text-lg font-semibold text-gray-800">
                {editingNote ? 'Edit Note' : 'Add Note'}
              </h2>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Topic *</label>
                <select
                  value={formData.topicId}
                  onChange={(e) => setFormData({ ...formData, topicId: e.target.value })}
                  disabled={!!editingNote}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none disabled:opacity-50"
                >
                  <option value="">Select a topic</option>
                  {state.courses.map((course) => (
                    <optgroup key={course.id} label={`${course.courseCode} - ${course.courseName}`}>
                      {getTopicsForCourse(course.id).map((topic) => (
                        <option key={topic.id} value={topic.id}>
                          {topic.topicName}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Note Content *</label>
                <textarea
                  value={formData.noteText}
                  onChange={(e) => setFormData({ ...formData, noteText: e.target.value })}
                  placeholder="Write your notes here..."
                  rows={10}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none resize-none"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setShowModal(false)}
                  className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={!formData.topicId || !formData.noteText.trim()}
                  className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] disabled:opacity-50"
                >
                  {editingNote ? 'Save Changes' : 'Add Note'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Notes;

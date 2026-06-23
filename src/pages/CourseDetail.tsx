// PharmTrack - Course Detail Page

import React, { useState, useRef, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { useApp } from '../context/AppContext';
import { Topic, Slide } from '../types';
import { saveFile, loadFile, deleteFile } from '../utils/storage';
import {
  ArrowLeft,
  Plus,
  Edit2,
  Trash2,
  X,
  ChevronDown,
  ChevronUp,
  FileText,
  Image,
  Upload,
  Check,
  GripVertical,
  Eye,
  Target,
  FileQuestion,
  BookOpen as BookOpenIcon,
} from 'lucide-react';

const CourseDetail: React.FC = () => {
  const { courseId } = useParams<{ courseId: string }>();
  const navigate = useNavigate();
  const { state, dispatch, getCourseProgress, getTopicsForCourse, getSlidesForTopic, addActivity } = useApp();

  const course = state.courses.find((c) => c.id === courseId);
  const topics = courseId ? getTopicsForCourse(courseId) : [];
  const progress = courseId ? getCourseProgress(courseId) : 0;

  // State
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set(topics.map(t => t.id)));
  const [showTopicModal, setShowTopicModal] = useState(false);
  const [showSlideModal, setShowSlideModal] = useState(false);
  const [editingTopic, setEditingTopic] = useState<Topic | null>(null);
  const [editingSlide, setEditingSlide] = useState<Slide | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<string>('');
  const [viewingSlide, setViewingSlide] = useState<Slide | null>(null);
  const [viewingFileData, setViewingFileData] = useState<string | null>(null);

  // Effect to load file data when viewingSlide changes
  useEffect(() => {
    if (viewingSlide && viewingSlide.fileUrl) {
      loadFile(viewingSlide.id).then(data => {
        if (data) {
          // Convert Uint8Array to DataURL for display
          const blob = new Blob([data as any], { type: viewingSlide.fileType === 'pdf' ? 'application/pdf' : 'image/*' });
          setViewingFileData(URL.createObjectURL(blob));
        } else {
          setViewingFileData(null);
        }
      });
    } else {
      setViewingFileData(null);
    }
  }, [viewingSlide]);

  // Form data
  const [topicName, setTopicName] = useState('');
  const [slideForm, setSlideForm] = useState({
    title: '',
    contentText: '',
    fileType: 'text' as 'text' | 'pdf' | 'jpg' | 'png',
  });
  const [fileData, setFileData] = useState<string | Uint8Array | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!course) {
    return (
      <div className="text-center py-16">
        <h2 className="text-xl font-semibold text-gray-700 mb-2">Course not found</h2>
        <Link to="/courses" className="text-[#2D6A4F] hover:underline">
          Back to courses
        </Link>
      </div>
    );
  }

  // Topic handlers
  const toggleTopic = (topicId: string) => {
    const newExpanded = new Set(expandedTopics);
    if (newExpanded.has(topicId)) {
      newExpanded.delete(topicId);
    } else {
      newExpanded.add(topicId);
    }
    setExpandedTopics(newExpanded);
  };

  const handleAddTopic = () => {
    setEditingTopic(null);
    setTopicName('');
    setShowTopicModal(true);
  };

  const handleEditTopic = (topic: Topic) => {
    setEditingTopic(topic);
    setTopicName(topic.topicName);
    setShowTopicModal(true);
  };

  const handleSaveTopic = () => {
    if (!topicName.trim()) return;

    if (editingTopic) {
      dispatch({
        type: 'UPDATE_TOPIC',
        payload: { id: editingTopic.id, updates: { topicName } },
      });
    } else {
      const newTopic: Topic = {
        id: uuidv4(),
        courseId: courseId!,
        topicName,
        orderIndex: topics.length,
        createdAt: new Date().toISOString(),
      };
      dispatch({ type: 'ADD_TOPIC', payload: newTopic });
    }

    setShowTopicModal(false);
    setTopicName('');
    setEditingTopic(null);
  };

  const handleDeleteTopic = async (topicId: string) => {
    if (window.confirm('Delete this topic and all its slides?')) {
      // Delete associated files
      const slides = getSlidesForTopic(topicId);
      for (const slide of slides) {
        if (slide.fileUrl) {
          await deleteFile(slide.id);
        }
      }
      dispatch({ type: 'DELETE_TOPIC', payload: topicId });
    }
  };

  // Slide handlers
  const handleAddSlide = (topicId: string) => {
    setSelectedTopicId(topicId);
    setEditingSlide(null);
    setSlideForm({ title: '', contentText: '', fileType: 'text' });
    setFileData(null);
    setShowSlideModal(true);
  };

  const handleEditSlide = async (slide: Slide, topicId: string) => {
    setSelectedTopicId(topicId);
    setEditingSlide(slide);
    setSlideForm({
      title: slide.title,
      contentText: slide.contentText,
      fileType: slide.fileType || 'text',
    });
    if (slide.fileUrl) {
      const data = await loadFile(slide.id);
      if (data) {
        // Convert Uint8Array to Blob for preview
        const blob = new Blob([data as any], { type: slide.fileType === 'pdf' ? 'application/pdf' : 'image/*' });
        setFileData(URL.createObjectURL(blob));
      } else {
        setFileData(null);
      }
    } else {
      setFileData(null);
    }
    setShowSlideModal(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      setFileData(reader.result as string);
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (ext === 'pdf') {
        setSlideForm({ ...slideForm, fileType: 'pdf' });
      } else if (ext === 'jpg' || ext === 'jpeg') {
        setSlideForm({ ...slideForm, fileType: 'jpg' });
      } else if (ext === 'png') {
        setSlideForm({ ...slideForm, fileType: 'png' });
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSaveSlide = () => {
    if (!slideForm.title.trim()) return;

    const slides = getSlidesForTopic(selectedTopicId);

    if (editingSlide) {
      if (fileData) {
        saveFile(editingSlide.id, fileData);
      }
      dispatch({
        type: 'UPDATE_SLIDE',
        payload: {
          id: editingSlide.id,
          updates: {
            title: slideForm.title,
            contentText: slideForm.contentText,
            fileType: slideForm.fileType,
            fileUrl: fileData ? `local:${editingSlide.id}` : editingSlide.fileUrl,
          },
        },
      });
    } else {
      const newSlide: Slide = {
        id: uuidv4(),
        topicId: selectedTopicId,
        slideNumber: slides.length + 1,
        title: slideForm.title,
        contentText: slideForm.contentText,
        fileType: slideForm.fileType,
        fileUrl: fileData ? `local:${uuidv4()}` : undefined,
        status: 'not_started',
        createdAt: new Date().toISOString(),
      };

      if (fileData) {
        saveFile(newSlide.id, fileData);
        newSlide.fileUrl = `local:${newSlide.id}`;
      }

      dispatch({ type: 'ADD_SLIDE', payload: newSlide });
    }

    setShowSlideModal(false);
    setSlideForm({ title: '', contentText: '', fileType: 'text' });
    setFileData(null);
  };

  const handleDeleteSlide = async (slideId: string) => {
    if (window.confirm('Delete this slide?')) {
      await deleteFile(slideId);
      dispatch({ type: 'DELETE_SLIDE', payload: slideId });
    }
  };

  const handleSlideStatus = (slideId: string, status: Slide['status']) => {
    dispatch({
      type: 'UPDATE_SLIDE',
      payload: { id: slideId, updates: { status } },
    });

    if (status === 'completed') {
      const slide = state.slides.find((s) => s.id === slideId);
      addActivity('slide_completed', `Completed slide: ${slide?.title}`, courseId);
    }
  };

  const getProgressColor = (progress: number) => {
    if (progress >= 71) return 'bg-green-500';
    if (progress >= 31) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate('/courses')}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-gray-600" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="px-2 py-1 bg-[#2D6A4F]/10 text-[#2D6A4F] text-sm font-semibold rounded">
              {course.courseCode}
            </span>
            <span className="text-gray-400">•</span>
            <span className="text-sm text-gray-500">{course.semester}</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-800 mt-1">{course.courseName}</h1>
          {course.lecturerName && (
            <p className="text-gray-500 mt-1">Lecturer: {course.lecturerName}</p>
          )}
        </div>
      </div>

      {/* Progress and quick actions */}
      <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600">Course Progress</span>
              <span className="text-lg font-bold text-gray-800">{progress}%</span>
            </div>
            <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full ${getProgressColor(progress)} transition-all duration-300`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <div className="flex gap-2">
            <Link
              to={`/objectives?course=${courseId}`}
              className="flex items-center gap-2 px-3 py-2 bg-[#FFB703]/10 text-[#B07D00] text-sm font-medium rounded-lg hover:bg-[#FFB703]/20 transition-colors"
            >
              <Target className="w-4 h-4" />
              Objectives
            </Link>
            <Link
              to={`/questions?course=${courseId}`}
              className="flex items-center gap-2 px-3 py-2 bg-purple-100 text-purple-700 text-sm font-medium rounded-lg hover:bg-purple-200 transition-colors"
            >
              <FileQuestion className="w-4 h-4" />
              Questions
            </Link>
            <button
              onClick={handleAddTopic}
              className="flex items-center gap-2 px-3 py-2 bg-[#2D6A4F] text-white text-sm font-medium rounded-lg hover:bg-[#1B4332] transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Topic
            </button>
          </div>
        </div>
      </div>

      {/* Topics list */}
      <div className="space-y-3">
        {topics.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-xl border border-gray-100">
            <FileText className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <h2 className="text-lg font-semibold text-gray-700 mb-2">No topics yet</h2>
            <p className="text-gray-500 mb-4">Add your first topic to organize your slides</p>
            <button
              onClick={handleAddTopic}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Topic
            </button>
          </div>
        ) : (
          topics.map((topic) => {
            const slides = getSlidesForTopic(topic.id);
            const isExpanded = expandedTopics.has(topic.id);
            const completedSlides = slides.filter((s) => s.status === 'completed').length;
            const topicProgress = slides.length > 0 ? Math.round((completedSlides / slides.length) * 100) : 0;

            return (
              <div key={topic.id} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                {/* Topic header */}
                <div
                  className="flex items-center gap-3 p-4 cursor-pointer hover:bg-gray-50 transition-colors"
                  onClick={() => toggleTopic(topic.id)}
                >
                  <GripVertical className="w-5 h-5 text-gray-300" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-800">{topic.topicName}</h3>
                      <span className="text-xs text-gray-400">
                        {slides.length} {slides.length === 1 ? 'slide' : 'slides'}
                      </span>
                    </div>
                    {slides.length > 0 && (
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden max-w-[200px]">
                          <div
                            className={`h-full ${getProgressColor(topicProgress)}`}
                            style={{ width: `${topicProgress}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500">{topicProgress}%</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    {slides.length > 0 && (
                      <Link
                        to={`/read/${topic.id}`}
                        className="flex items-center gap-1 px-2.5 py-1 bg-blue-100 text-blue-700 text-xs font-medium rounded-lg hover:bg-blue-200 transition-colors"
                      >
                        <BookOpenIcon className="w-3.5 h-3.5" />
                        Read
                      </Link>
                    )}
                    <button
                      onClick={() => handleEditTopic(topic)}
                      className="p-1.5 text-gray-400 hover:text-[#2D6A4F] hover:bg-gray-100 rounded transition-colors"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteTopic(topic.id)}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    {isExpanded ? (
                      <ChevronUp className="w-5 h-5 text-gray-400" />
                    ) : (
                      <ChevronDown className="w-5 h-5 text-gray-400" />
                    )}
                  </div>
                </div>

                {/* Slides list */}
                {isExpanded && (
                  <div className="border-t border-gray-100">
                    {slides.length === 0 ? (
                      <div className="p-4 text-center text-gray-500 text-sm">
                        No slides yet
                      </div>
                    ) : (
                      <div className="divide-y divide-gray-50">
                        {slides.map((slide, slideIdx) => (
                          <div
                            key={slide.id}
                            className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
                          >
                            <Link
                              to={`/read/${topic.id}?slide=${slideIdx}`}
                              className="flex items-center gap-2 flex-1 min-w-0"
                            >
                              <span className="w-6 h-6 flex items-center justify-center text-xs text-gray-400 bg-gray-100 rounded">
                                {slide.slideNumber}
                              </span>
                              {slide.fileType === 'pdf' ? (
                                <FileText className="w-4 h-4 text-red-500" />
                              ) : slide.fileType !== 'text' ? (
                                <Image className="w-4 h-4 text-blue-500" />
                              ) : (
                                <FileText className="w-4 h-4 text-gray-400" />
                              )}
                              <div className="flex-1 min-w-0 ml-1">
                                <p className="font-medium text-gray-800 truncate hover:text-[#2D6A4F]">{slide.title}</p>
                                {slide.contentText && (
                                  <p className="text-sm text-gray-500 truncate">{slide.contentText.slice(0, 50)}...</p>
                                )}
                              </div>
                            </Link>

                            <div className="flex items-center gap-2">
                              {/* Status dropdown */}
                              <select
                                value={slide.status}
                                onChange={(e) => handleSlideStatus(slide.id, e.target.value as Slide['status'])}
                                className={`text-xs px-2 py-1 rounded border-0 cursor-pointer ${
                                  slide.status === 'completed'
                                    ? 'bg-green-100 text-green-700'
                                    : slide.status === 'in_progress'
                                    ? 'bg-yellow-100 text-yellow-700'
                                    : 'bg-gray-100 text-gray-600'
                                }`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <option value="not_started">Not Started</option>
                                <option value="in_progress">In Progress</option>
                                <option value="completed">Completed</option>
                              </select>

                              <Link
                                to={`/read/${topic.id}?slide=${slideIdx}`}
                                className="p-1.5 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded transition-colors"
                                title="Read & Study with AI"
                              >
                                <Eye className="w-4 h-4" />
                              </Link>
                              <button
                                onClick={() => handleEditSlide(slide, topic.id)}
                                className="p-1.5 text-gray-400 hover:text-[#2D6A4F] hover:bg-gray-100 rounded transition-colors"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleDeleteSlide(slide.id)}
                                className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add slide button */}
                    <div className="p-3 bg-gray-50 border-t border-gray-100">
                      <button
                        onClick={() => handleAddSlide(topic.id)}
                        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-[#2D6A4F] bg-[#2D6A4F]/10 rounded-lg hover:bg-[#2D6A4F]/20 transition-colors"
                      >
                        <Plus className="w-4 h-4" />
                        Add Slide
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Topic Modal */}
      {showTopicModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold text-gray-800">
                {editingTopic ? 'Edit Topic' : 'Add New Topic'}
              </h2>
              <button
                onClick={() => setShowTopicModal(false)}
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Topic Name *
              </label>
              <input
                type="text"
                value={topicName}
                onChange={(e) => setTopicName(e.target.value)}
                placeholder="e.g., Glycosides"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
                autoFocus
              />
              <div className="flex gap-3 mt-4">
                <button
                  onClick={() => setShowTopicModal(false)}
                  className="flex-1 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveTopic}
                  disabled={!topicName.trim()}
                  className="flex-1 py-2 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] disabled:opacity-50"
                >
                  {editingTopic ? 'Save' : 'Add Topic'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Slide Modal */}
      {showSlideModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white">
              <h2 className="text-lg font-semibold text-gray-800">
                {editingSlide ? 'Edit Slide' : 'Add New Slide'}
              </h2>
              <button
                onClick={() => setShowSlideModal(false)}
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Slide Title *
                </label>
                <input
                  type="text"
                  value={slideForm.title}
                  onChange={(e) => setSlideForm({ ...slideForm, title: e.target.value })}
                  placeholder="e.g., Introduction to Glycosides"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Content Type
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { type: 'text', label: 'Text', icon: FileText },
                    { type: 'pdf', label: 'PDF', icon: FileText },
                    { type: 'jpg', label: 'Image', icon: Image },
                  ].map(({ type, label, icon: Icon }) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setSlideForm({ ...slideForm, fileType: type as any })}
                      className={`flex items-center justify-center gap-2 py-2 rounded-lg border-2 transition-all ${
                        slideForm.fileType === type || (slideForm.fileType === 'png' && type === 'jpg')
                          ? 'border-[#2D6A4F] bg-[#2D6A4F]/10 text-[#2D6A4F]'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {slideForm.fileType === 'text' ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Content
                  </label>
                  <textarea
                    value={slideForm.contentText}
                    onChange={(e) => setSlideForm({ ...slideForm, contentText: e.target.value })}
                    placeholder="Enter slide content or notes..."
                    rows={6}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none resize-none"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Upload File
                  </label>
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                      fileData
                        ? 'border-green-300 bg-green-50'
                        : 'border-gray-300 hover:border-[#2D6A4F]'
                    }`}
                  >
                    {fileData ? (
                      slideForm.fileType === 'pdf' ? (
                        <div className="flex items-center justify-center gap-2 text-green-600">
                          <Check className="w-5 h-5" />
                          <span>PDF uploaded</span>
                        </div>
                      ) : (
                        <img
                          src={typeof fileData === 'string' ? fileData : undefined}
                          alt="Preview"
                          className="max-h-32 mx-auto rounded"
                        />
                      )
                    ) : (
                      <>
                        <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                        <p className="text-sm text-gray-500">
                          Click to upload {slideForm.fileType === 'pdf' ? 'PDF' : 'image'}
                        </p>
                      </>
                    )}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={slideForm.fileType === 'pdf' ? '.pdf' : 'image/*'}
                    onChange={handleFileChange}
                    className="hidden"
                  />

                  {/* Text notes for files */}
                  <div className="mt-3">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Notes (optional)
                    </label>
                    <textarea
                      value={slideForm.contentText}
                      onChange={(e) => setSlideForm({ ...slideForm, contentText: e.target.value })}
                      placeholder="Add notes or key points from this slide..."
                      rows={3}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none resize-none"
                    />
                  </div>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setShowSlideModal(false)}
                  className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveSlide}
                  disabled={!slideForm.title.trim()}
                  className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] disabled:opacity-50"
                >
                  {editingSlide ? 'Save Changes' : 'Add Slide'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Slide Viewer Modal */}
      {viewingSlide && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b">
              <div>
                <h2 className="text-lg font-semibold text-gray-800">{viewingSlide.title}</h2>
                <p className="text-sm text-gray-500">Slide #{viewingSlide.slideNumber}</p>
              </div>
              <button
                onClick={() => setViewingSlide(null)}
                className="p-2 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-6">
              {viewingSlide.fileUrl ? (
                viewingSlide.fileType === 'pdf' ? (
                  <div className="text-center py-12">
                    <FileText className="w-16 h-16 text-red-400 mx-auto mb-4" />
                    <p className="text-gray-600 mb-4">PDF Preview</p>
                    {viewingFileData && typeof viewingFileData === 'string' && (
                      <a
                        href={viewingFileData}
                        download={`${viewingSlide.title}.pdf`}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332]"
                      >
                        Download PDF
                      </a>
                    )}
                  </div>
                ) : (
                  <img
                    src={typeof viewingFileData === 'string' ? viewingFileData : ''}
                    alt={viewingSlide.title}
                    className="max-w-full h-auto mx-auto rounded-lg"
                  />
                )
              ) : null}

              {viewingSlide.contentText && (
                <div className={viewingSlide.fileUrl ? 'mt-6 pt-6 border-t' : ''}>
                  <h3 className="font-semibold text-gray-800 mb-2">Notes</h3>
                  <p className="text-gray-600 whitespace-pre-wrap">{viewingSlide.contentText}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CourseDetail;

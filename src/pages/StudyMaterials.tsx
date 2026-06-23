// PharmTrack - Study Materials Page (Upload & Manage Slides)

import React, { useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { useApp } from '../context/AppContext';
import { Topic, Slide } from '../types';
import { saveFile, loadFile, deleteFile } from '../utils/storage';
import { processAnyFile } from '../utils/universalProcessor';
import {
  Upload,
  FileText,
  Image,
  FolderOpen,
  Plus,
  Edit2,
  Trash2,
  X,
  Check,
  Clock,
  Circle,
  ChevronDown,
  ChevronUp,
  BookOpen,
  Eye,
  Sparkles,
  File,
  AlertCircle,
  Type,
  Loader2,
  Cloud,
  FileVideo,
} from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';

// Set worker path
// Offline-first worker initialization\nimport pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';\npdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const StudyMaterials: React.FC = () => {
  const { state, dispatch, getTopicsForCourse, getSlidesForTopic, addActivity } = useApp();

  const [selectedCourse, setSelectedCourse] = useState<string>(state.courses[0]?.id || '');
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set());
  const [showTopicModal, setShowTopicModal] = useState(false);
  const [showSlideModal, setShowSlideModal] = useState(false);
  const [showBulkUpload, setShowBulkUpload] = useState(false);
  const [editingTopic, setEditingTopic] = useState<Topic | null>(null);
  const [editingSlide, setEditingSlide] = useState<Slide | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<string>('');
  const [isConverting, setIsConverting] = useState<string | null>(null);
  const [topicName, setTopicName] = useState('');
  const [slideForm, setSlideForm] = useState({
    title: '',
    contentText: '',
    fileType: 'text' as 'text' | 'jpg' | 'png',
  });
  const [fileData, setFileData] = useState<string | null>(null);
  const [currentFileBlob, setCurrentFileBlob] = useState<Blob | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bulkFileInputRef = useRef<HTMLInputElement>(null);

  const topics = selectedCourse ? getTopicsForCourse(selectedCourse) : [];

  // Toggle topic expansion
  const toggleTopic = (topicId: string) => {
    const newExpanded = new Set(expandedTopics);
    if (newExpanded.has(topicId)) {
      newExpanded.delete(topicId);
    } else {
      newExpanded.add(topicId);
    }
    setExpandedTopics(newExpanded);
  };

  // Topic handlers
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
    if (!topicName.trim() || !selectedCourse) return;

    if (editingTopic) {
      dispatch({
        type: 'UPDATE_TOPIC',
        payload: { id: editingTopic.id, updates: { topicName } },
      });
    } else {
      const newTopic: Topic = {
        id: uuidv4(),
        courseId: selectedCourse,
        topicName,
        orderIndex: topics.length,
        createdAt: new Date().toISOString(),
      };
      dispatch({ type: 'ADD_TOPIC', payload: newTopic });
      // Auto-expand new topic
      setExpandedTopics(new Set([...expandedTopics, newTopic.id]));
    }

    setShowTopicModal(false);
    setTopicName('');
    setEditingTopic(null);
  };

  const handleDeleteTopic = async (topicId: string) => {
    if (window.confirm('Delete this topic and all its slides?')) {
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
    setCurrentFileBlob(null);
    setShowSlideModal(true);
  };

  const handleEditSlide = async (slide: Slide, topicId: string) => {
    setSelectedTopicId(topicId);
    setEditingSlide(slide);
    setSlideForm({
      title: slide.title,
      contentText: slide.contentText,
      fileType: (slide.fileType as 'text' | 'jpg' | 'png') || 'text',
    });
    if (slide.fileUrl) {
      const data = await loadFile(slide.id);
      if (typeof data === 'string') {
        setFileData(data);
      } else if (data instanceof Blob) {
        setFileData(URL.createObjectURL(data));
      }
    } else {
      setFileData(null);
    }
    setCurrentFileBlob(null);
    setShowSlideModal(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processFile(file);
  };

  const processFile = async (file: File) => {
    setCurrentFileBlob(file);
    
    try {
      // 🚀 PharmaGAME Universal Logic
      const result = await processAnyFile(file);
      
      setSlideForm(prev => ({ 
        ...prev, 
        fileType: result.type as any, 
        title: prev.title || file.name.replace(/\.[^/.]+$/, ''),
        contentText: result.text
      }));

      // Create high-speed UI preview
      const reader = new FileReader();
      reader.onload = () => setFileData(reader.result as string);
      reader.readAsDataURL(file);
      
    } catch (err: any) {
      console.error('File sync failed:', err);
      alert(`PharmaGAME Sync Error: ${err.message || 'File structure is unreadable'}`);
      setCurrentFileBlob(null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      processFile(file);
    }
  };

  const handleSaveSlide = async () => {
    if (!slideForm.title.trim()) return;

    const slides = getSlidesForTopic(selectedTopicId);

    if (editingSlide) {
      // Prioritize original Blob/File for storage
      const dataToSave = currentFileBlob || fileData;
      if (dataToSave) {
        await saveFile(editingSlide.id, dataToSave);
      }
      
      dispatch({
        type: 'UPDATE_SLIDE',
        payload: {
          id: editingSlide.id,
          updates: {
            title: slideForm.title,
            contentText: slideForm.contentText,
            fileType: slideForm.fileType,
            fileUrl: dataToSave ? `local:${editingSlide.id}` : editingSlide.fileUrl,
          },
        },
      });
    } else {
      const newId = uuidv4();
      const dataToSave = currentFileBlob || fileData;
      
      const newSlide: Slide = {
        id: newId,
        topicId: selectedTopicId,
        slideNumber: slides.length + 1,
        title: slideForm.title,
        contentText: slideForm.contentText,
        fileType: slideForm.fileType,
        fileUrl: dataToSave ? `local:${newId}` : undefined,
        status: 'not_started',
        createdAt: new Date().toISOString(),
      };

      if (dataToSave) {
        await saveFile(newId, dataToSave);
      }

      dispatch({ type: 'ADD_SLIDE', payload: newSlide });
      addActivity('slide_completed', `Added slide: ${slideForm.title}`, selectedCourse);
    }

    setShowSlideModal(false);
    setSlideForm({ title: '', contentText: '', fileType: 'text' });
    setFileData(null);
    setCurrentFileBlob(null);
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
      addActivity('slide_completed', `Completed: ${slide?.title}`, selectedCourse);
    }
  };

  const convertPdfToText = async (slide: Slide) => {
    const rawData = await loadFile(slide.id);
    if (!rawData) return;

    setIsConverting(slide.id);
    try {
      let data;
      if (rawData instanceof Blob) {
          data = new Uint8Array(await rawData.arrayBuffer());
      } else if (typeof rawData === 'string') {
          const base64Data = rawData.split(',')[1] || rawData;
          const binaryString = window.atob(base64Data);
          data = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) data[i] = binaryString.charCodeAt(i);
      } else {
          data = rawData as Uint8Array;
      }
      const loadingTask = pdfjs.getDocument({ data });
      const pdf = await loadingTask.promise;
      let fullText = '';
      
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(' ');
        fullText += `### PAGE ${i}\n\n${pageText}\n\n---\n\n`;
      }

      const newSlide: Slide = {
        id: uuidv4(),
        topicId: slide.topicId,
        slideNumber: Math.floor(slide.slideNumber) + 1,
        title: `📖 ${slide.title} (Full Study Transcript)`,
        contentText: fullText,
        fileType: 'text',
        status: 'not_started',
        createdAt: new Date().toISOString(),
      };

      dispatch({ type: 'ADD_SLIDE', payload: newSlide });
      addActivity('slide_completed', `Generated Study Transcript for ${slide.title}`, selectedCourse);
      alert('PharmaGAME: Perfect study transcript generated!');
    } catch (err) {
      console.error(err);
      alert('PharmaGAME: Extraction failed. PDF might be corrupted or protected.');
    } finally {
      setIsConverting(null);
    }
  };

  // Bulk upload handler
  const handleBulkUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !selectedTopicId) return;

    const slidesList = getSlidesForTopic(selectedTopicId);
    let slideNumber = slidesList.length;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = file.name.split('.').pop()?.toLowerCase();
      let fileType: 'pdf' | 'jpg' | 'png' | 'text' = 'text';
      let contentText = '';

      if (ext === 'pdf') {
        fileType = 'pdf';
        try {
          const arrayBuffer = await file.arrayBuffer();
          const loadingTask = pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) });
          const pdf = await loadingTask.promise;
          for (let j = 1; j <= pdf.numPages; j++) {
            const page = await pdf.getPage(j);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map((item: any) => (item as any).str).join(' ');
            contentText += `--- Page ${j} ---\n${pageText}\n\n`;
          }
        } catch (err) { console.error("Bulk PDF error:", err); }
      } else if (ext === 'png') {
        fileType = 'png';
      } else if (ext === 'jpg' || ext === 'jpeg') {
        fileType = 'jpg';
      }

      slideNumber++;
      const newSlideId = uuidv4();
      const newSlide: Slide = {
        id: newSlideId,
        topicId: selectedTopicId,
        slideNumber,
        title: file.name.replace(/\.[^/.]+$/, ''),
        contentText: contentText,
        fileType,
        fileUrl: `local:${newSlideId}`,
        status: 'not_started',
        createdAt: new Date().toISOString(),
      };

      // Save the raw File object directly
      await saveFile(newSlideId, file);
      dispatch({ type: 'ADD_SLIDE', payload: newSlide });
    }

    setShowBulkUpload(false);
    addActivity('slide_completed', `Uploaded ${files.length} slides`, selectedCourse);
  };

  const getStatusIcon = (status: Slide['status']) => {
    switch (status) {
      case 'completed':
        return <Check className="w-4 h-4 text-green-500" />;
      case 'in_progress':
        return <Clock className="w-4 h-4 text-yellow-500" />;
      default:
        return <Circle className="w-4 h-4 text-gray-300" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-purple-600 rounded-2xl p-6 text-white">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center">
            <Upload className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Study Materials</h1>
            <p className="text-white/80">Upload & manage your lecturer's slides</p>
          </div>
        </div>
      </div>

      {/* No courses message */}
      {state.courses.length === 0 ? (
        <div className="bg-white rounded-xl p-8 text-center border border-gray-100 shadow-sm">
          <AlertCircle className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-700 mb-2">No Courses Yet</h2>
          <p className="text-gray-500 mb-4">Add a course first to start uploading slides</p>
          <Link
            to="/courses"
            className="inline-flex items-center gap-2 px-6 py-3 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332]"
          >
            <Plus className="w-5 h-5" />
            Add Your First Course
          </Link>
        </div>
      ) : (
        <>
          {/* Course selector & actions */}
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
            <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
              <div className="flex items-center gap-3 flex-1">
                <FolderOpen className="w-5 h-5 text-gray-400" />
                <select
                  value={selectedCourse}
                  onChange={(e) => {
                    setSelectedCourse(e.target.value);
                    setExpandedTopics(new Set());
                  }}
                  className="flex-1 max-w-md px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-lg font-medium"
                >
                  {state.courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.courseCode} - {c.courseName}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleAddTopic}
                  className="flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white font-medium rounded-lg hover:bg-[#1B4332] transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Add Topic
                </button>
              </div>
            </div>
          </div>

          {/* Upload Instructions */}
          <div className="bg-gradient-to-r from-green-50 to-blue-50 border-2 border-green-200 rounded-xl p-5">
            <div className="flex items-start gap-3 mb-3">
              <div className="w-10 h-10 bg-green-500 rounded-xl flex items-center justify-center flex-shrink-0">
                <FileText className="w-6 h-6 text-white" />
              </div>
              <div>
                <h3 className="font-bold text-green-900 text-lg">✨ RECOMMENDED: Upload Word Documents (.docx)</h3>
                <p className="text-sm text-green-700 mt-1">Word files work 10x better than PDFs! Perfect text extraction, zero errors.</p>
              </div>
            </div>
            <div className="bg-white/70 rounded-lg p-4 ml-13">
              <h4 className="font-semibold text-blue-900 mb-2 flex items-center gap-2">
                <Sparkles className="w-4 h-4" />
                Quick Start Guide:
              </h4>
              <ol className="text-sm text-blue-800 space-y-2">
                <li className="flex items-start gap-2">
                  <span className="bg-blue-500 text-white w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold">1</span>
                  <span>Convert your lecturer's slides to Word (.docx) or use lecture notes directly</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="bg-blue-500 text-white w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold">2</span>
                  <span>Create a <strong>Topic</strong> for each chapter (e.g., "Cardiac Glycosides")</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="bg-blue-500 text-white w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold">3</span>
                  <span>Click <strong>"Add Slide"</strong> and upload your .docx file</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="bg-blue-500 text-white w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold">4</span>
                  <span>Click <strong>"📖 Read & Study"</strong> to open with AI assistance!</span>
                </li>
              </ol>
            </div>
            <p className="text-xs text-green-600 mt-3 ml-13 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              PDFs still supported, but Word documents provide the best experience!
            </p>
          </div>

          {/* Topics & Slides */}
          <div className="space-y-4">
            {topics.length === 0 ? (
              <div className="bg-white rounded-xl p-8 text-center border border-dashed border-gray-300">
                <FolderOpen className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                <h2 className="text-xl font-semibold text-gray-700 mb-2">No Topics Yet</h2>
                <p className="text-gray-500 mb-4">
                  Create topics to organize your slides by chapter or section
                </p>
                <button
                  onClick={handleAddTopic}
                  className="inline-flex items-center gap-2 px-6 py-3 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332]"
                >
                  <Plus className="w-5 h-5" />
                  Create First Topic
                </button>
              </div>
            ) : (
              topics.map((topic) => {
                const slides = getSlidesForTopic(topic.id);
                const isExpanded = expandedTopics.has(topic.id);
                const completedCount = slides.filter((s) => s.status === 'completed').length;

                return (
                  <div key={topic.id} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                    {/* Topic Header */}
                    <div
                      className="flex items-center gap-3 p-4 bg-gray-50 cursor-pointer hover:bg-gray-100 transition-colors"
                      onClick={() => toggleTopic(topic.id)}
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <h3 className="font-semibold text-gray-800 text-lg">{topic.topicName}</h3>
                          <span className="px-2 py-0.5 bg-gray-200 text-gray-600 text-xs rounded-full">
                            {slides.length} slides
                          </span>
                          {slides.length > 0 && (
                            <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full">
                              {completedCount}/{slides.length} done
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        {slides.length > 0 && (
                          <Link
                            to={`/read/${topic.id}`}
                            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
                          >
                            <BookOpen className="w-4 h-4" />
                            📖 Read & Study
                          </Link>
                        )}
                        <button
                          onClick={() => handleEditTopic(topic)}
                          className="p-2 text-gray-400 hover:text-gray-600 hover:bg-white rounded-lg"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteTopic(topic.id)}
                          className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg"
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

                    {/* Expanded content */}
                    {isExpanded && (
                      <div className="border-t border-gray-100">
                        {/* Upload area */}
                        <div className="p-4 bg-gradient-to-r from-purple-50 to-blue-50 border-b border-gray-100">
                          <div className="flex flex-wrap gap-3">
                            <button
                              onClick={() => handleAddSlide(topic.id)}
                              className="flex items-center gap-2 px-4 py-2.5 bg-white border-2 border-dashed border-purple-300 text-purple-700 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition-colors"
                            >
                              <Plus className="w-5 h-5" />
                              Add Single Slide
                            </button>

                            <button
                              onClick={() => {
                                setSelectedTopicId(topic.id);
                                setShowBulkUpload(true);
                              }}
                              className="flex items-center gap-2 px-4 py-2.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
                            >
                              <Upload className="w-5 h-5" />
                              Bulk Upload Files
                            </button>

                            <button
                              onClick={() => {
                                setSelectedTopicId(topic.id);
                                setSlideForm({ title: '', contentText: '', fileType: 'text' });
                                setFileData(null);
                                setEditingSlide(null);
                                setShowSlideModal(true);
                              }}
                              className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                            >
                              <FileText className="w-5 h-5" />
                              Paste Text Content
                            </button>
                          </div>
                        </div>

                        {/* Slides list */}
                        {slides.length === 0 ? (
                          <div className="p-8 text-center">
                            <File className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                            <p className="text-gray-500">No slides yet. Upload your first slide!</p>
                          </div>
                        ) : (
                          <div className="divide-y divide-gray-50">
                            {slides.map((slide, idx) => (
                              <div
                                key={slide.id}
                                className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
                              >
                                <button
                                  onClick={() => handleSlideStatus(
                                    slide.id,
                                    slide.status === 'completed' ? 'not_started' : 
                                    slide.status === 'in_progress' ? 'completed' : 'in_progress'
                                  )}
                                  className="flex-shrink-0"
                                >
                                  {getStatusIcon(slide.status)}
                                </button>

                                <span className="w-8 h-8 flex items-center justify-center bg-gray-100 rounded-lg text-sm font-medium text-gray-500">
                                  {idx + 1}
                                </span>

                                <div className="flex items-center gap-2">
                                  {slide.fileType === 'pdf' && <FileText className="w-5 h-5 text-red-500" />}
                                  {(slide.fileType === 'jpg' || slide.fileType === 'png') && <Image className="w-5 h-5 text-blue-500" />}
                                  {slide.fileType === 'text' && <FileText className="w-5 h-5 text-gray-400" />}
                                </div>

                                <Link
                                  to={`/read/${topic.id}?slide=${idx}`}
                                  className="flex-1 min-w-0"
                                >
                                  <p className="font-medium text-gray-800 hover:text-blue-600 truncate">
                                    {slide.title}
                                  </p>
                                  {slide.contentText && (
                                    <p className="text-sm text-gray-500 truncate">
                                      {slide.contentText.slice(0, 60)}...
                                    </p>
                                  )}
                                </Link>

                                <div className="flex items-center gap-1">
                                  {slide.fileType === 'pdf' && (
                                    <button
                                      onClick={() => convertPdfToText(slide)}
                                      disabled={isConverting === slide.id}
                                      className={`p-2 rounded-lg transition-colors ${
                                        isConverting === slide.id 
                                          ? 'text-blue-400 animate-pulse' 
                                          : 'text-purple-500 hover:bg-purple-50'
                                      }`}
                                      title="Convert PDF to Text Slide"
                                    >
                                      {isConverting === slide.id ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                      ) : (
                                        <Type className="w-4 h-4" />
                                      )}
                                    </button>
                                  )}
                                  <Link
                                    to={`/read/${topic.id}?slide=${idx}`}
                                    className="p-2 text-blue-500 hover:bg-blue-50 rounded-lg transition-colors"
                                    title="Read with AI"
                                  >
                                    <Eye className="w-4 h-4" />
                                  </Link>
                                  <button
                                    onClick={() => handleEditSlide(slide, topic.id)}
                                    className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"
                                  >
                                    <Edit2 className="w-4 h-4" />
                                  </button>
                                  <button
                                    onClick={() => handleDeleteSlide(slide.id)}
                                    className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      {/* Add/Edit Topic Modal */}
      {showTopicModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">
                {editingTopic ? 'Edit Topic' : 'Create New Topic'}
              </h2>
              <button onClick={() => setShowTopicModal(false)} className="p-1 hover:bg-gray-100 rounded">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Topic/Chapter Name
              </label>
              <input
                type="text"
                value={topicName}
                onChange={(e) => setTopicName(e.target.value)}
                placeholder="e.g., Cardiac Glycosides, Chapter 1, Week 3..."
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none text-lg"
                autoFocus
              />
              <div className="flex gap-3 mt-4">
                <button
                  onClick={() => setShowTopicModal(false)}
                  className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveTopic}
                  disabled={!topicName.trim()}
                  className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] disabled:opacity-50"
                >
                  {editingTopic ? 'Save' : 'Create Topic'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit Slide Modal */}
      {showSlideModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white">
              <h2 className="text-lg font-semibold">
                {editingSlide ? 'Edit Slide' : 'Add New Slide'}
              </h2>
              <button onClick={() => setShowSlideModal(false)} className="p-1 hover:bg-gray-100 rounded">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Title */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Slide Title *
                </label>
                <input
                  type="text"
                  value={slideForm.title}
                  onChange={(e) => setSlideForm({ ...slideForm, title: e.target.value })}
                  placeholder="e.g., Introduction to Glycosides"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] outline-none"
                />
              </div>

              {/* Content type tabs */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Material Format
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {[
                    { id: 'pdf', label: 'PDF', icon: FileText, color: 'bg-red-500' },
                    { id: 'docx', label: 'Word', icon: FileText, color: 'bg-blue-600' },
                    { id: 'pptx', label: 'PowerPoint', icon: FileVideo, color: 'bg-orange-500' },
                    { id: 'jpg', label: 'Image', icon: Image, color: 'bg-green-500' },
                  ].map((type) => {
                    const Icon = type.icon;
                    const isActive = slideForm.fileType === type.id || (type.id === 'jpg' && slideForm.fileType === 'png');
                    return (
                      <button
                        key={type.id}
                        type="button"
                        onClick={() => setSlideForm({ ...slideForm, fileType: type.id as any })}
                        className={`flex flex-col items-center gap-2 p-3 rounded-2xl border-2 transition-all ${
                          isActive
                            ? 'border-[#2D6A4F] bg-[#2D6A4F]/5 shadow-inner'
                            : 'border-gray-100 hover:border-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        <div className={`w-10 h-10 ${type.color} rounded-xl flex items-center justify-center shadow-lg`}>
                          <Icon className="w-5 h-5 text-white" />
                        </div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-gray-600">{type.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* File upload or text input */}
              {slideForm.fileType === 'text' ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Slide Content
                  </label>
                  <textarea
                    value={slideForm.contentText}
                    onChange={(e) => setSlideForm({ ...slideForm, contentText: e.target.value })}
                    placeholder="Paste or type your lecture slide content here..."
                    rows={10}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] outline-none resize-none"
                  />
                </div>
              ) : (
                <>
                  {/* Drag & drop area */}
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                      dragOver
                        ? 'border-[#2D6A4F] bg-[#2D6A4F]/10'
                        : fileData
                        ? 'border-green-400 bg-green-50'
                        : 'border-gray-300 hover:border-gray-400'
                    }`}
                  >
                    {fileData ? (
                      fileData.includes('image/') ? (
                        <img src={fileData} alt="Preview" className="max-h-40 mx-auto rounded-lg" />
                      ) : (
                        <div className="flex items-center justify-center gap-2 text-green-600">
                          <Check className="w-6 h-6" />
                          <span className="font-medium">Word Document Ready!</span>
                        </div>
                      )
                    ) : (
                      <>
                        <Upload className="w-10 h-10 text-gray-400 mx-auto mb-3" />
                        {(slideForm.fileType as any) === 'text' ? (
                          <>
                            <p className="text-gray-600 font-medium">
                              Drag & drop your Word document (.docx) here
                            </p>
                            <p className="text-sm text-gray-400 mt-1">or click to browse</p>
                          </>
                        ) : (
                          <>
                            <p className="text-gray-600 font-medium">
                              Drag & drop your image here
                            </p>
                            <p className="text-sm text-gray-400 mt-1">.jpg or .png</p>
                          </>
                        )}
                      </>
                    )}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.docx,.pptx,image/*"
                    onChange={handleFileChange}
                    className="hidden"
                  />

                  {/* Notes for uploaded files */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Notes (optional)
                    </label>
                    <textarea
                      value={slideForm.contentText}
                      onChange={(e) => setSlideForm({ ...slideForm, contentText: e.target.value })}
                      placeholder="Add notes or key points from this slide..."
                      rows={4}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] outline-none resize-none"
                    />
                  </div>
                </>
              )}

              {/* Actions */}
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

      {/* Bulk Upload Modal */}
      {showBulkUpload && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">Bulk Upload Files</h2>
              <button onClick={() => setShowBulkUpload(false)} className="p-1 hover:bg-gray-100 rounded">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6">
              <div
                onClick={() => bulkFileInputRef.current?.click()}
                className="border-2 border-dashed border-purple-300 rounded-xl p-8 text-center cursor-pointer hover:border-purple-500 hover:bg-purple-50 transition-colors"
              >
                <Upload className="w-12 h-12 text-purple-400 mx-auto mb-3" />
                <p className="text-purple-700 font-medium">Click to select multiple files</p>
                <p className="text-sm text-purple-500 mt-1">PDF, JPG, PNG supported</p>
              </div>
              <input
                ref={bulkFileInputRef}
                type="file"
                accept=".pdf,.docx,.pptx,image/*"
                multiple
                onChange={handleBulkUpload}
                className="hidden"
              />
              <p className="text-sm text-gray-500 mt-4 text-center">
                Each file will be added as a separate slide
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StudyMaterials;

// PharmTrack - Learning Objectives Page

import React, { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { useApp } from '../context/AppContext';
import { LearningObjective } from '../types';
import {
  Plus,
  Edit2,
  Trash2,
  X,
  Target,
  CheckCircle2,
  AlertCircle,
  Circle,
  Filter,
  BookOpen,
} from 'lucide-react';

const LearningObjectives: React.FC = () => {
  const [searchParams] = useSearchParams();
  const courseFilter = searchParams.get('course');
  const { state, dispatch, getLOProgress, addActivity, getTopicsForCourse } = useApp();

  const [showModal, setShowModal] = useState(false);
  const [editingLO, setEditingLO] = useState<LearningObjective | null>(null);
  const [selectedCourse, setSelectedCourse] = useState(courseFilter || '');
  const [formData, setFormData] = useState({
    courseId: courseFilter || '',
    topicId: '',
    objectiveText: '',
  });

  // Filter LOs
  const filteredLOs = state.learningObjectives.filter((lo) => {
    return !selectedCourse || lo.courseId === selectedCourse;
  });

  // Group by course
  const groupedByCourse: Record<string, LearningObjective[]> = {};
  filteredLOs.forEach((lo) => {
    if (!groupedByCourse[lo.courseId]) {
      groupedByCourse[lo.courseId] = [];
    }
    groupedByCourse[lo.courseId].push(lo);
  });

  const handleOpenModal = (courseId?: string) => {
    setEditingLO(null);
    setFormData({
      courseId: courseId || selectedCourse || '',
      topicId: '',
      objectiveText: '',
    });
    setShowModal(true);
  };

  const handleEdit = (lo: LearningObjective) => {
    setEditingLO(lo);
    setFormData({
      courseId: lo.courseId,
      topicId: lo.topicId || '',
      objectiveText: lo.objectiveText,
    });
    setShowModal(true);
  };

  const handleSave = () => {
    if (!formData.courseId || !formData.objectiveText.trim()) return;

    if (editingLO) {
      dispatch({
        type: 'UPDATE_LEARNING_OBJECTIVE',
        payload: {
          id: editingLO.id,
          updates: {
            courseId: formData.courseId,
            topicId: formData.topicId || undefined,
            objectiveText: formData.objectiveText,
          },
        },
      });
    } else {
      const newLO: LearningObjective = {
        id: uuidv4(),
        courseId: formData.courseId,
        topicId: formData.topicId || undefined,
        objectiveText: formData.objectiveText,
        status: 'not_covered',
        createdAt: new Date().toISOString(),
      };
      dispatch({ type: 'ADD_LEARNING_OBJECTIVE', payload: newLO });
    }

    setShowModal(false);
    setEditingLO(null);
  };

  const handleDelete = (id: string) => {
    if (window.confirm('Delete this learning objective?')) {
      dispatch({ type: 'DELETE_LEARNING_OBJECTIVE', payload: id });
    }
  };

  const handleStatusChange = (id: string, status: LearningObjective['status']) => {
    dispatch({
      type: 'UPDATE_LEARNING_OBJECTIVE',
      payload: { id, updates: { status } },
    });

    if (status === 'mastered') {
      const lo = state.learningObjectives.find((l) => l.id === id);
      addActivity('objective_mastered', `Mastered: ${lo?.objectiveText.slice(0, 50)}...`);
    }
  };

  const getStatusIcon = (status: LearningObjective['status']) => {
    switch (status) {
      case 'mastered':
        return <CheckCircle2 className="w-5 h-5 text-green-500" />;
      case 'partial':
        return <AlertCircle className="w-5 h-5 text-yellow-500" />;
      default:
        return <Circle className="w-5 h-5 text-red-400" />;
    }
  };

  const getStatusBg = (status: LearningObjective['status']) => {
    switch (status) {
      case 'mastered':
        return 'bg-green-50 border-green-200';
      case 'partial':
        return 'bg-yellow-50 border-yellow-200';
      default:
        return 'bg-red-50 border-red-200';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <Target className="w-7 h-7 text-[#FFB703]" />
            Learning Objectives
          </h1>
          <p className="text-gray-500">Track your understanding of course objectives</p>
        </div>
        <button
          onClick={() => handleOpenModal()}
          disabled={state.courses.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white font-semibold rounded-lg hover:bg-[#1B4332] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="w-5 h-5" />
          Add Objective
        </button>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3">
        <Filter className="w-5 h-5 text-gray-400" />
        <select
          value={selectedCourse}
          onChange={(e) => setSelectedCourse(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
        >
          <option value="">All Courses</option>
          {state.courses.map((course) => (
            <option key={course.id} value={course.id}>
              {course.courseCode} - {course.courseName}
            </option>
          ))}
        </select>
      </div>

      {/* Content */}
      {state.courses.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100">
          <BookOpen className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-700 mb-2">No courses yet</h2>
          <p className="text-gray-500 mb-4">Add a course first to create learning objectives</p>
          <Link
            to="/courses"
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332]"
          >
            Go to Courses
          </Link>
        </div>
      ) : filteredLOs.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100">
          <Target className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-700 mb-2">No objectives yet</h2>
          <p className="text-gray-500 mb-4">Add learning objectives to track your understanding</p>
          <button
            onClick={() => handleOpenModal()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332]"
          >
            <Plus className="w-4 h-4" />
            Add Your First Objective
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(groupedByCourse).map(([courseId, los]) => {
            const course = state.courses.find((c) => c.id === courseId);
            if (!course) return null;

            const progress = getLOProgress(courseId);
            const progressColor =
              progress >= 71 ? 'bg-green-500' : progress >= 31 ? 'bg-yellow-500' : 'bg-red-500';

            return (
              <div key={courseId} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                {/* Course header */}
                <div className="p-4 bg-gray-50 border-b border-gray-100">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-1 bg-[#2D6A4F]/10 text-[#2D6A4F] text-xs font-semibold rounded">
                          {course.courseCode}
                        </span>
                        <h3 className="font-semibold text-gray-800">{course.courseName}</h3>
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <div className="w-32 h-2 bg-gray-200 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${progressColor}`}
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <span className="text-sm text-gray-500">{progress}% mastery</span>
                      </div>
                    </div>
                    <button
                      onClick={() => handleOpenModal(courseId)}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm bg-[#2D6A4F]/10 text-[#2D6A4F] rounded-lg hover:bg-[#2D6A4F]/20"
                    >
                      <Plus className="w-4 h-4" />
                      Add
                    </button>
                  </div>
                </div>

                {/* Objectives list */}
                <div className="divide-y divide-gray-100">
                  {los.map((lo, index) => {
                    const topic = lo.topicId
                      ? state.topics.find((t) => t.id === lo.topicId)
                      : null;

                    return (
                      <div
                        key={lo.id}
                        className={`p-4 border-l-4 ${getStatusBg(lo.status)}`}
                      >
                        <div className="flex items-start gap-3">
                          <button
                            onClick={() => {
                              const nextStatus: Record<LearningObjective['status'], LearningObjective['status']> = {
                                not_covered: 'partial',
                                partial: 'mastered',
                                mastered: 'not_covered',
                              };
                              handleStatusChange(lo.id, nextStatus[lo.status]);
                            }}
                            className="mt-0.5"
                          >
                            {getStatusIcon(lo.status)}
                          </button>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-sm font-semibold text-gray-500">LO{index + 1}:</span>
                              {topic && (
                                <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded">
                                  {topic.topicName}
                                </span>
                              )}
                            </div>
                            <p className="text-gray-800">{lo.objectiveText}</p>
                          </div>

                          <div className="flex items-center gap-1">
                            <select
                              value={lo.status}
                              onChange={(e) => handleStatusChange(lo.id, e.target.value as LearningObjective['status'])}
                              className={`text-xs px-2 py-1 rounded border cursor-pointer ${
                                lo.status === 'mastered'
                                  ? 'bg-green-100 text-green-700 border-green-200'
                                  : lo.status === 'partial'
                                  ? 'bg-yellow-100 text-yellow-700 border-yellow-200'
                                  : 'bg-red-100 text-red-700 border-red-200'
                              }`}
                            >
                              <option value="not_covered">🔴 Not Covered</option>
                              <option value="partial">🟡 Partial</option>
                              <option value="mastered">🟢 Mastered</option>
                            </select>
                            <button
                              onClick={() => handleEdit(lo)}
                              className="p-1.5 text-gray-400 hover:text-[#2D6A4F] hover:bg-white rounded"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDelete(lo.id)}
                              className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-white rounded"
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
          <div className="bg-white rounded-xl w-full max-w-lg shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold text-gray-800">
                {editingLO ? 'Edit Objective' : 'Add Learning Objective'}
              </h2>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Course *</label>
                <select
                  value={formData.courseId}
                  onChange={(e) => setFormData({ ...formData, courseId: e.target.value, topicId: '' })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
                >
                  <option value="">Select a course</option>
                  {state.courses.map((course) => (
                    <option key={course.id} value={course.id}>
                      {course.courseCode} - {course.courseName}
                    </option>
                  ))}
                </select>
              </div>

              {formData.courseId && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Topic (optional)
                  </label>
                  <select
                    value={formData.topicId}
                    onChange={(e) => setFormData({ ...formData, topicId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
                  >
                    <option value="">General (no specific topic)</option>
                    {getTopicsForCourse(formData.courseId).map((topic) => (
                      <option key={topic.id} value={topic.id}>
                        {topic.topicName}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Objective *
                </label>
                <textarea
                  value={formData.objectiveText}
                  onChange={(e) => setFormData({ ...formData, objectiveText: e.target.value })}
                  placeholder="e.g., Define glycosides and classify them based on their chemical nature"
                  rows={3}
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
                  disabled={!formData.courseId || !formData.objectiveText.trim()}
                  className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] disabled:opacity-50"
                >
                  {editingLO ? 'Save Changes' : 'Add Objective'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LearningObjectives;

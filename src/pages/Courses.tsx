// PharmTrack - Courses Page

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { useApp } from '../context/AppContext';
import { Course } from '../types';
import {
  Plus,
  BookOpen,
  Edit2,
  Trash2,
  X,
  User,
  Clock,
  ArrowRight,
  Search,
  Filter,
} from 'lucide-react';

const Courses: React.FC = () => {
  const { state, dispatch, getCourseProgress, getTopicsForCourse, addActivity } = useApp();
  const [showModal, setShowModal] = useState(false);
  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [semesterFilter, setSemesterFilter] = useState<string>('all');
  const [formData, setFormData] = useState({
    courseCode: '',
    courseName: '',
    lecturerName: '',
    semester: '1st Semester',
    creditHours: 3,
  });

  const semesters = ['1st Semester', '2nd Semester'];

  const resetForm = () => {
    setFormData({
      courseCode: '',
      courseName: '',
      lecturerName: '',
      semester: '1st Semester',
      creditHours: 3,
    });
    setEditingCourse(null);
  };

  const openAddModal = () => {
    resetForm();
    setShowModal(true);
  };

  const openEditModal = (course: Course) => {
    setEditingCourse(course);
    setFormData({
      courseCode: course.courseCode,
      courseName: course.courseName,
      lecturerName: course.lecturerName,
      semester: course.semester,
      creditHours: course.creditHours,
    });
    setShowModal(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (editingCourse) {
      dispatch({
        type: 'UPDATE_COURSE',
        payload: {
          id: editingCourse.id,
          updates: formData,
        },
      });
    } else {
      const newCourse: Course = {
        id: uuidv4(),
        studentId: state.student?.id || '',
        ...formData,
        createdAt: new Date().toISOString(),
      };
      dispatch({ type: 'ADD_COURSE', payload: newCourse });
      addActivity('course_added', `Added new course: ${formData.courseCode} - ${formData.courseName}`);
    }

    setShowModal(false);
    resetForm();
  };

  const handleDelete = (courseId: string) => {
    if (window.confirm('Are you sure you want to delete this course? All topics and slides will also be deleted.')) {
      dispatch({ type: 'DELETE_COURSE', payload: courseId });
    }
  };

  // Filter courses
  const filteredCourses = state.courses.filter((course) => {
    const matchesSearch =
      course.courseCode.toLowerCase().includes(searchQuery.toLowerCase()) ||
      course.courseName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      course.lecturerName.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesSemester = semesterFilter === 'all' || course.semester === semesterFilter;
    return matchesSearch && matchesSemester;
  });

  // Get progress color
  const getProgressColor = (progress: number) => {
    if (progress >= 71) return { bg: 'bg-green-500', text: 'text-green-600', emoji: '🟢' };
    if (progress >= 31) return { bg: 'bg-yellow-500', text: 'text-yellow-600', emoji: '🟡' };
    return { bg: 'bg-red-500', text: 'text-red-600', emoji: '🔴' };
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">My Courses</h1>
          <p className="text-gray-500">Manage your courses and track progress</p>
        </div>
        <button
          onClick={openAddModal}
          className="flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white font-semibold rounded-lg hover:bg-[#1B4332] transition-colors"
        >
          <Plus className="w-5 h-5" />
          Add Course
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search courses..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-5 h-5 text-gray-400" />
          <select
            value={semesterFilter}
            onChange={(e) => setSemesterFilter(e.target.value)}
            className="px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
          >
            <option value="all">All Semesters</option>
            {semesters.map((sem) => (
              <option key={sem} value={sem}>{sem}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Courses grid */}
      {filteredCourses.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100">
          <BookOpen className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-700 mb-2">
            {state.courses.length === 0 ? 'No courses yet' : 'No matching courses'}
          </h2>
          <p className="text-gray-500 mb-6">
            {state.courses.length === 0
              ? 'Add your first course to start tracking your progress'
              : 'Try adjusting your search or filters'}
          </p>
          {state.courses.length === 0 && (
            <button
              onClick={openAddModal}
              className="inline-flex items-center gap-2 px-6 py-3 bg-[#2D6A4F] text-white font-semibold rounded-lg hover:bg-[#1B4332] transition-colors"
            >
              <Plus className="w-5 h-5" />
              Add Your First Course
            </button>
          )}
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCourses.map((course) => {
            const progress = getCourseProgress(course.id);
            const colors = getProgressColor(progress);
            const topicsCount = getTopicsForCourse(course.id).length;

            return (
              <Link
                to={`/course/${course.id}`}
                key={course.id}
                className="bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md hover:border-blue-300 transition-all overflow-hidden block cursor-pointer"
              >
                <div className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <span className="inline-block px-2 py-1 bg-[#2D6A4F]/10 text-[#2D6A4F] text-xs font-semibold rounded mb-2">
                        {course.courseCode}
                      </span>
                      <h3 className="font-semibold text-gray-800 line-clamp-2">{course.courseName}</h3>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); openEditModal(course); }}
                        className="p-1.5 text-gray-400 hover:text-[#2D6A4F] hover:bg-gray-100 rounded transition-colors"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDelete(course.id); }}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-sm text-gray-500 mb-4">
                    <div className="flex items-center gap-1">
                      <User className="w-4 h-4" />
                      <span className="truncate">{course.lecturerName || 'No lecturer'}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="w-4 h-4" />
                      <span>{course.creditHours} hrs</span>
                    </div>
                  </div>

                  <div className="mb-3">
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-gray-500">Progress</span>
                      <span className={`font-semibold ${colors.text}`}>
                        {colors.emoji} {progress}%
                      </span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${colors.bg} transition-all duration-300`}
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-400">
                      {topicsCount} {topicsCount === 1 ? 'topic' : 'topics'}
                    </span>
                    <span
                      className="flex items-center gap-1 text-sm font-medium text-[#2D6A4F] group-hover:underline"
                    >
                      View Details
                      <ArrowRight className="w-4 h-4" />
                    </span>
                  </div>
                </div>

                <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 text-xs text-gray-400">
                  {course.semester}
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold text-gray-800">
                {editingCourse ? 'Edit Course' : 'Add New Course'}
              </h2>
              <button
                onClick={() => {
                  setShowModal(false);
                  resetForm();
                }}
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Course Code *
                  </label>
                  <input
                    type="text"
                    value={formData.courseCode}
                    onChange={(e) => setFormData({ ...formData, courseCode: e.target.value })}
                    placeholder="e.g., PHM 216"
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Credit Hours
                  </label>
                  <input
                    type="number"
                    value={formData.creditHours}
                    onChange={(e) => setFormData({ ...formData, creditHours: parseInt(e.target.value) || 0 })}
                    min="1"
                    max="6"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Course Name *
                </label>
                <input
                  type="text"
                  value={formData.courseName}
                  onChange={(e) => setFormData({ ...formData, courseName: e.target.value })}
                  placeholder="e.g., Pharmacognosy"
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Lecturer Name
                </label>
                <input
                  type="text"
                  value={formData.lecturerName}
                  onChange={(e) => setFormData({ ...formData, lecturerName: e.target.value })}
                  placeholder="e.g., Dr. Mensah"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Semester
                </label>
                <select
                  value={formData.semester}
                  onChange={(e) => setFormData({ ...formData, semester: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
                >
                  {semesters.map((sem) => (
                    <option key={sem} value={sem}>{sem}</option>
                  ))}
                </select>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowModal(false);
                    resetForm();
                  }}
                  className="flex-1 py-2.5 border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 bg-[#2D6A4F] text-white font-medium rounded-lg hover:bg-[#1B4332] transition-colors"
                >
                  {editingCourse ? 'Save Changes' : 'Add Course'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Courses;

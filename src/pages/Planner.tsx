// PharmTrack - Study Planner Page

import React, { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useApp } from '../context/AppContext';
import { StudyPlan } from '../types';
import {
  format,
  addDays,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isToday,
} from 'date-fns';
import {
  Calendar,
  Plus,
  Edit2,
  Trash2,
  X,
  ChevronLeft,
  ChevronRight,
  Clock,
  Check,
  BookOpen,
  Brain,
  RotateCcw,
  Upload,
  Sparkles,
} from 'lucide-react';

const Planner: React.FC = () => {
  const { state, dispatch, getCourseProgress } = useApp();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [showModal, setShowModal] = useState(false);
  const [editingPlan, setEditingPlan] = useState<StudyPlan | null>(null);
  const [selectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [formData, setFormData] = useState({
    date: format(new Date(), 'yyyy-MM-dd'),
    timeSlot: '09:00 - 11:00',
    courseId: '',
    activityType: 'study' as StudyPlan['activityType'],
    notes: '',
  });

  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
  const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd });

  const timeSlots = [
    '06:00 - 08:00',
    '08:00 - 10:00',
    '09:00 - 11:00',
    '10:00 - 12:00',
    '12:00 - 14:00',
    '14:00 - 16:00',
    '15:00 - 17:00',
    '16:00 - 18:00',
    '18:00 - 20:00',
    '19:00 - 21:00',
    '20:00 - 22:00',
  ];

  const activityTypes = [
    { value: 'study', label: 'Study', icon: BookOpen, color: 'bg-blue-500' },
    { value: 'quiz', label: 'Quiz Practice', icon: Brain, color: 'bg-purple-500' },
    { value: 'revision', label: 'Revision', icon: RotateCcw, color: 'bg-green-500' },
    { value: 'upload', label: 'Upload/Organize', icon: Upload, color: 'bg-orange-500' },
  ];

  const getPlansForDay = (date: Date) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    return state.studyPlans.filter((p) => p.date === dateStr);
  };

  const handleOpenModal = (date?: string) => {
    setEditingPlan(null);
    setFormData({
      date: date || selectedDate,
      timeSlot: '09:00 - 11:00',
      courseId: state.courses[0]?.id || '',
      activityType: 'study',
      notes: '',
    });
    setShowModal(true);
  };

  const handleEdit = (plan: StudyPlan) => {
    setEditingPlan(plan);
    setFormData({
      date: plan.date,
      timeSlot: plan.timeSlot,
      courseId: plan.courseId,
      activityType: plan.activityType,
      notes: plan.notes,
    });
    setShowModal(true);
  };

  const handleSave = () => {
    if (!formData.courseId) return;

    if (editingPlan) {
      dispatch({
        type: 'UPDATE_STUDY_PLAN',
        payload: {
          id: editingPlan.id,
          updates: formData,
        },
      });
    } else {
      const newPlan: StudyPlan = {
        id: uuidv4(),
        studentId: state.student?.id || '',
        ...formData,
        isCompleted: false,
      };
      dispatch({ type: 'ADD_STUDY_PLAN', payload: newPlan });
    }

    setShowModal(false);
  };

  const handleDelete = (id: string) => {
    if (window.confirm('Delete this study session?')) {
      dispatch({ type: 'DELETE_STUDY_PLAN', payload: id });
    }
  };

  const handleToggleComplete = (id: string) => {
    const plan = state.studyPlans.find((p) => p.id === id);
    dispatch({
      type: 'UPDATE_STUDY_PLAN',
      payload: {
        id,
        updates: { isCompleted: !plan?.isCompleted },
      },
    });
  };

  const generateWeeklyPlan = () => {
    // Auto-generate study plan based on course progress
    const sortedCourses = [...state.courses]
      .map((c) => ({ ...c, progress: getCourseProgress(c.id) }))
      .sort((a, b) => a.progress - b.progress);

    if (sortedCourses.length === 0) {
      alert('Add some courses first to generate a study plan.');
      return;
    }

    const newPlans: StudyPlan[] = [];
    const studyTimeSlots = ['09:00 - 11:00', '14:00 - 16:00', '19:00 - 21:00'];

    weekDays.forEach((day, dayIdx) => {
      if (dayIdx >= 5) return; // Skip weekend for auto-generation

      const dateStr = format(day, 'yyyy-MM-dd');
      const existingPlans = getPlansForDay(day);

      // Skip if already has plans
      if (existingPlans.length >= 2) return;

      // Add 1-2 study sessions per day
      const numSessions = Math.min(2 - existingPlans.length, sortedCourses.length);
      for (let i = 0; i < numSessions; i++) {
        const course = sortedCourses[i % sortedCourses.length];
        const timeSlot = studyTimeSlots[i % studyTimeSlots.length];

        // Check if this slot is already taken
        const slotTaken = existingPlans.some((p) => p.timeSlot === timeSlot);
        if (slotTaken) continue;

        newPlans.push({
          id: uuidv4(),
          studentId: state.student?.id || '',
          date: dateStr,
          timeSlot,
          courseId: course.id,
          activityType: i === 0 ? 'study' : 'quiz',
          notes: i === 0 ? 'Focus on lowest progress topics' : 'Practice questions',
          isCompleted: false,
        });
      }
    });

    if (newPlans.length === 0) {
      alert('Week already has sufficient study plans.');
      return;
    }

    newPlans.forEach((plan) => {
      dispatch({ type: 'ADD_STUDY_PLAN', payload: plan });
    });
  };

  const getActivityInfo = (type: StudyPlan['activityType']) => {
    return activityTypes.find((a) => a.value === type) || activityTypes[0];
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <Calendar className="w-7 h-7 text-[#2D6A4F]" />
            Study Planner
          </h1>
          <p className="text-gray-500">Plan and organize your study sessions</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={generateWeeklyPlan}
            disabled={state.courses.length === 0}
            className="flex items-center gap-2 px-4 py-2 border border-[#2D6A4F] text-[#2D6A4F] rounded-lg hover:bg-[#2D6A4F]/10 disabled:opacity-50"
          >
            <Sparkles className="w-4 h-4" />
            Auto-Generate
          </button>
          <button
            onClick={() => handleOpenModal()}
            disabled={state.courses.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white font-semibold rounded-lg hover:bg-[#1B4332] disabled:opacity-50"
          >
            <Plus className="w-5 h-5" />
            Add Session
          </button>
        </div>
      </div>

      {/* Week navigation */}
      <div className="flex items-center justify-between bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
        <button
          onClick={() => setCurrentDate(addDays(currentDate, -7))}
          className="p-2 hover:bg-gray-100 rounded-lg"
        >
          <ChevronLeft className="w-5 h-5 text-gray-600" />
        </button>
        <div className="text-center">
          <h2 className="font-semibold text-gray-800">
            {format(weekStart, 'MMM d')} - {format(weekEnd, 'MMM d, yyyy')}
          </h2>
          <button
            onClick={() => setCurrentDate(new Date())}
            className="text-sm text-[#2D6A4F] hover:underline"
          >
            Go to Today
          </button>
        </div>
        <button
          onClick={() => setCurrentDate(addDays(currentDate, 7))}
          className="p-2 hover:bg-gray-100 rounded-lg"
        >
          <ChevronRight className="w-5 h-5 text-gray-600" />
        </button>
      </div>

      {/* Week view */}
      <div className="grid grid-cols-1 md:grid-cols-7 gap-4">
        {weekDays.map((day) => {
          const dayPlans = getPlansForDay(day);
          const isCurrentDay = isToday(day);
          const isPast = day < new Date() && !isToday(day);

          return (
            <div
              key={day.toISOString()}
              className={`bg-white rounded-xl border shadow-sm overflow-hidden ${
                isCurrentDay ? 'border-[#2D6A4F] ring-2 ring-[#2D6A4F]/20' : 'border-gray-100'
              }`}
            >
              <div
                className={`p-3 text-center ${
                  isCurrentDay ? 'bg-[#2D6A4F] text-white' : 'bg-gray-50'
                }`}
              >
                <p className={`text-xs ${isCurrentDay ? 'text-white/80' : 'text-gray-500'}`}>
                  {format(day, 'EEE')}
                </p>
                <p className={`text-xl font-bold ${isCurrentDay ? 'text-white' : 'text-gray-800'}`}>
                  {format(day, 'd')}
                </p>
              </div>

              <div className={`p-2 min-h-[200px] ${isPast ? 'opacity-60' : ''}`}>
                {dayPlans.length === 0 ? (
                  <button
                    onClick={() => handleOpenModal(format(day, 'yyyy-MM-dd'))}
                    className="w-full h-full min-h-[160px] flex flex-col items-center justify-center text-gray-400 hover:text-[#2D6A4F] hover:bg-[#2D6A4F]/5 rounded-lg transition-colors"
                  >
                    <Plus className="w-6 h-6 mb-1" />
                    <span className="text-xs">Add</span>
                  </button>
                ) : (
                  <div className="space-y-2">
                    {dayPlans.map((plan) => {
                      const course = state.courses.find((c) => c.id === plan.courseId);
                      const activity = getActivityInfo(plan.activityType);
                      const Icon = activity.icon;

                      return (
                        <div
                          key={plan.id}
                          className={`p-2 rounded-lg border ${
                            plan.isCompleted
                              ? 'bg-green-50 border-green-200'
                              : 'bg-gray-50 border-gray-100'
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <div className={`w-5 h-5 rounded flex items-center justify-center ${activity.color}`}>
                              <Icon className="w-3 h-3 text-white" />
                            </div>
                            <span className="text-xs font-semibold text-gray-700 truncate">
                              {course?.courseCode}
                            </span>
                          </div>
                          <p className="text-xs text-gray-500 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {plan.timeSlot.split(' - ')[0]}
                          </p>
                          {plan.notes && (
                            <p className="text-xs text-gray-400 mt-1 truncate">{plan.notes}</p>
                          )}
                          <div className="flex items-center gap-1 mt-2">
                            <button
                              onClick={() => handleToggleComplete(plan.id)}
                              className={`p-1 rounded ${
                                plan.isCompleted
                                  ? 'bg-green-500 text-white'
                                  : 'bg-gray-200 text-gray-500 hover:bg-gray-300'
                              }`}
                            >
                              <Check className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => handleEdit(plan)}
                              className="p-1 bg-gray-200 text-gray-500 rounded hover:bg-gray-300"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => handleDelete(plan.id)}
                              className="p-1 bg-gray-200 text-red-500 rounded hover:bg-red-100"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    <button
                      onClick={() => handleOpenModal(format(day, 'yyyy-MM-dd'))}
                      className="w-full py-1 text-xs text-[#2D6A4F] hover:bg-[#2D6A4F]/10 rounded flex items-center justify-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      Add
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Today's summary */}
      <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm">
        <h3 className="font-semibold text-gray-800 mb-4">Today's Plan</h3>
        {(() => {
          const todayPlans = getPlansForDay(new Date());
          if (todayPlans.length === 0) {
            return (
              <p className="text-gray-500 text-center py-4">
                No study sessions planned for today
              </p>
            );
          }
          return (
            <div className="space-y-3">
              {todayPlans.map((plan) => {
                const course = state.courses.find((c) => c.id === plan.courseId);
                const activity = getActivityInfo(plan.activityType);
                const Icon = activity.icon;

                return (
                  <div
                    key={plan.id}
                    className={`flex items-center gap-4 p-4 rounded-lg ${
                      plan.isCompleted ? 'bg-green-50' : 'bg-gray-50'
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${activity.color}`}>
                      <Icon className="w-5 h-5 text-white" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-800">{course?.courseCode}</span>
                        <span className="px-2 py-0.5 bg-gray-200 text-gray-600 text-xs rounded">
                          {activity.label}
                        </span>
                      </div>
                      <p className="text-sm text-gray-500">{plan.timeSlot}</p>
                      {plan.notes && (
                        <p className="text-sm text-gray-400 mt-1">{plan.notes}</p>
                      )}
                    </div>
                    <button
                      onClick={() => handleToggleComplete(plan.id)}
                      className={`p-2 rounded-lg transition-colors ${
                        plan.isCompleted
                          ? 'bg-green-500 text-white'
                          : 'bg-gray-200 text-gray-500 hover:bg-gray-300'
                      }`}
                    >
                      <Check className="w-5 h-5" />
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold text-gray-800">
                {editingPlan ? 'Edit Study Session' : 'Add Study Session'}
              </h2>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                <input
                  type="date"
                  value={formData.date}
                  onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Time Slot</label>
                <select
                  value={formData.timeSlot}
                  onChange={(e) => setFormData({ ...formData, timeSlot: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
                >
                  {timeSlots.map((slot) => (
                    <option key={slot} value={slot}>
                      {slot}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Course</label>
                <select
                  value={formData.courseId}
                  onChange={(e) => setFormData({ ...formData, courseId: e.target.value })}
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

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Activity Type</label>
                <div className="grid grid-cols-2 gap-2">
                  {activityTypes.map((activity) => {
                    const Icon = activity.icon;
                    return (
                      <button
                        key={activity.value}
                        type="button"
                        onClick={() =>
                          setFormData({ ...formData, activityType: activity.value as any })
                        }
                        className={`flex items-center gap-2 p-3 rounded-lg border-2 transition-all ${
                          formData.activityType === activity.value
                            ? 'border-[#2D6A4F] bg-[#2D6A4F]/10'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className={`w-8 h-8 rounded flex items-center justify-center ${activity.color}`}>
                          <Icon className="w-4 h-4 text-white" />
                        </div>
                        <span className="text-sm font-medium">{activity.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Notes (optional)
                </label>
                <input
                  type="text"
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="e.g., Focus on Chapter 3, Review slides 10-20"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
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
                  disabled={!formData.courseId}
                  className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] disabled:opacity-50"
                >
                  {editingPlan ? 'Save Changes' : 'Add Session'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Planner;

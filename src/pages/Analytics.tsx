// PharmTrack - Analytics Page

import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  Legend,
} from 'recharts';
import { format, parseISO, subDays, isAfter } from 'date-fns';
import {
  BarChart3,
  TrendingUp,
  Target,
  Brain,
  BookOpen,
  FileQuestion,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Award,
  Printer,
} from 'lucide-react';

const Analytics: React.FC = () => {
  const { state, getCourseProgress, getLOProgress } = useApp();
  const [timeRange, setTimeRange] = useState<'7d' | '30d' | 'all'>('30d');

  // Calculate statistics
  const totalCourses = state.courses.length;
  const totalSlides = state.slides.length;
  const completedSlides = state.slides.filter((s) => s.status === 'completed').length;
  const totalQuestions = state.examQuestions.length;
  const practicedQuestions = state.examQuestions.filter((q) => q.isPracticed).length;
  const totalQuizzes = state.quizHistory.length;
  const totalLOs = state.learningObjectives.length;
  const masteredLOs = state.learningObjectives.filter((lo) => lo.status === 'mastered').length;

  // Calculate average quiz score
  const avgQuizScore =
    totalQuizzes > 0
      ? Math.round(
          state.quizHistory.reduce((sum, q) => sum + q.scorePercentage, 0) / totalQuizzes
        )
      : 0;

  // Course progress data for bar chart
  const courseProgressData = state.courses.map((course) => ({
    name: course.courseCode,
    progress: getCourseProgress(course.id),
    loProgress: getLOProgress(course.id),
  }));

  // Question type distribution for pie chart
  const questionTypeData = [
    { name: 'MCQ', value: state.examQuestions.filter((q) => q.questionType === 'mcq').length },
    { name: 'Short Answer', value: state.examQuestions.filter((q) => q.questionType === 'short_answer').length },
    { name: 'Structured', value: state.examQuestions.filter((q) => q.questionType === 'structured').length },
    { name: 'Essay', value: state.examQuestions.filter((q) => q.questionType === 'essay').length },
    { name: 'Case Study', value: state.examQuestions.filter((q) => q.questionType === 'case_study').length },
  ].filter((d) => d.value > 0);

  const COLORS = ['#10B981', '#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B'];

  // Quiz performance over time
  const quizPerformanceData = state.quizHistory
    .slice(-10)
    .map((quiz, idx) => ({
      name: `Quiz ${idx + 1}`,
      score: quiz.scorePercentage,
      date: format(parseISO(quiz.completedAt), 'MMM d'),
    }));

  // Activity by day (last 7 or 30 days)
  const getDaysAgo = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 365;
  const cutoffDate = subDays(new Date(), getDaysAgo);

  const recentActivities = state.activities.filter((a) =>
    isAfter(parseISO(a.timestamp), cutoffDate)
  );

  // Slides completed by status
  const slideStatusData = [
    { name: 'Completed', value: state.slides.filter((s) => s.status === 'completed').length, color: '#10B981' },
    { name: 'In Progress', value: state.slides.filter((s) => s.status === 'in_progress').length, color: '#F59E0B' },
    { name: 'Not Started', value: state.slides.filter((s) => s.status === 'not_started').length, color: '#EF4444' },
  ].filter((d) => d.value > 0);

  // Weak areas (topics with lowest progress)
  const topicProgressData = state.topics.map((topic) => {
    const slides = state.slides.filter((s) => s.topicId === topic.id);
    const completed = slides.filter((s) => s.status === 'completed').length;
    const progress = slides.length > 0 ? Math.round((completed / slides.length) * 100) : 0;
    const course = state.courses.find((c) => c.id === topic.courseId);
    return {
      topicName: topic.topicName,
      courseCode: course?.courseCode || '',
      progress,
      total: slides.length,
    };
  }).filter((t) => t.total > 0);

  const weakTopics = [...topicProgressData]
    .sort((a, b) => a.progress - b.progress)
    .slice(0, 5);

  // Get readiness status
  const getReadinessStatus = (progress: number) => {
    if (progress >= 70) return { label: 'Well Prepared', color: 'text-green-600', bg: 'bg-green-100', emoji: '🟢' };
    if (progress >= 40) return { label: 'On Track', color: 'text-yellow-600', bg: 'bg-yellow-100', emoji: '🟡' };
    return { label: 'Needs Attention', color: 'text-red-600', bg: 'bg-red-100', emoji: '🔴' };
  };

  return (
    <div className="space-y-6">
            {/* Print-only Header */}
      <div className="hidden print:block mb-8 text-center border-b-2 border-gray-800 pb-4">
        <img src="/logo.png" className="h-16 mx-auto mb-4" alt="PharmaTRACK Logo" />
        <h1 className="text-3xl font-black text-gray-900 mb-2">PharmaTRACK Progress Report</h1>
        <div className="grid grid-cols-2 gap-4 text-left text-sm mt-6 mb-2 mx-auto max-w-2xl bg-gray-50 p-4 rounded-lg border border-gray-200">
           <div><span className="font-bold text-gray-500">Student Name:</span> <span className="font-semibold text-gray-800">{state.student?.name || 'N/A'}</span></div>
           <div><span className="font-bold text-gray-500">University:</span> <span className="font-semibold text-gray-800">{state.student?.university || 'N/A'}</span></div>
           <div><span className="font-bold text-gray-500">Program:</span> <span className="font-semibold text-gray-800">{state.student?.program || 'N/A'}</span></div>
           <div><span className="font-bold text-gray-500">Level/Semester:</span> <span className="font-semibold text-gray-800">{state.student?.level || 'N/A'} / {state.student?.semester || 'N/A'}</span></div>
        </div>
        <p className="text-xs font-bold text-gray-400 mt-4 text-right">Generated on: {new Date().toLocaleDateString()}</p>
      </div>

      {/* Screen Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <BarChart3 className="w-7 h-7 text-blue-600" />
            Study Analytics
          </h1>
          <p className="text-gray-500">Track your progress and identify areas for improvement</p>
        </div>
                <div className="flex gap-2 print:hidden">
          <button 
            onClick={() => {
              const originalTitle = document.title;
              document.title = `PharmaTRACK_Progress_${state.student?.name?.replace(/\s+/g, '_') || 'Report'}_${new Date().toISOString().split('T')[0]}`;
              window.print();
              document.title = originalTitle;
            }} 
            className="flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg text-sm font-bold shadow-md hover:bg-[#1B4332] transition-colors"
          >
            <Printer className="w-4 h-4" /> Print Report
          </button>
          {(['7d', '30d', 'all'] as const).map((range) => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                timeRange === range
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {range === '7d' ? '7 Days' : range === '30d' ? '30 Days' : 'All Time'}
            </button>
          ))}
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
              <BookOpen className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-800">{totalCourses}</p>
              <p className="text-sm text-gray-500">Courses</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-800">
                {completedSlides}/{totalSlides}
              </p>
              <p className="text-sm text-gray-500">Slides Completed</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
              <FileQuestion className="w-6 h-6 text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-800">
                {practicedQuestions}/{totalQuestions}
              </p>
              <p className="text-sm text-gray-500">Questions Practiced</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-yellow-100 rounded-lg flex items-center justify-center">
              <Award className="w-6 h-6 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-800">{avgQuizScore}%</p>
              <p className="text-sm text-gray-500">Avg Quiz Score</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main charts grid */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Course Progress */}
        <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm">
          <h3 className="font-semibold text-gray-800 mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-blue-600" />
            Course Progress
          </h3>
          {courseProgressData.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={courseProgressData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="progress" name="Slide Progress" fill="#2D6A4F" radius={[4, 4, 0, 0]} />
                <Bar dataKey="loProgress" name="LO Mastery" fill="#FFB703" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[250px] flex items-center justify-center text-gray-400">
              No course data yet
            </div>
          )}
        </div>

        {/* Quiz Performance */}
        <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm">
          <h3 className="font-semibold text-gray-800 mb-4 flex items-center gap-2">
            <Brain className="w-5 h-5 text-purple-600" />
            Quiz Performance Trend
          </h3>
          {quizPerformanceData.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={quizPerformanceData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="#8B5CF6"
                  strokeWidth={2}
                  dot={{ fill: '#8B5CF6', r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[250px] flex items-center justify-center text-gray-400">
              No quiz data yet. Take a quiz to see trends!
            </div>
          )}
        </div>

        {/* Slide Status Distribution */}
        <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm">
          <h3 className="font-semibold text-gray-800 mb-4 flex items-center gap-2">
            <Target className="w-5 h-5 text-green-600" />
            Slide Completion Status
          </h3>
          {slideStatusData.length > 0 ? (
            <div className="flex items-center gap-6">
              <ResponsiveContainer width="50%" height={200}>
                <PieChart>
                  <Pie
                    data={slideStatusData}
                    cx="50%"
                    cy="50%"
                    innerRadius={40}
                    outerRadius={70}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {slideStatusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-3">
                {slideStatusData.map((item) => (
                  <div key={item.name} className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="text-sm text-gray-600">
                      {item.name}: {item.value} ({totalSlides > 0 ? Math.round((item.value / totalSlides) * 100) : 0}%)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-gray-400">
              No slides yet
            </div>
          )}
        </div>

        {/* Question Types */}
        <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm">
          <h3 className="font-semibold text-gray-800 mb-4 flex items-center gap-2">
            <FileQuestion className="w-5 h-5 text-purple-600" />
            Question Type Distribution
          </h3>
          {questionTypeData.length > 0 ? (
            <div className="flex items-center gap-6">
              <ResponsiveContainer width="50%" height={200}>
                <PieChart>
                  <Pie
                    data={questionTypeData}
                    cx="50%"
                    cy="50%"
                    outerRadius={70}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {questionTypeData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-2">
                {questionTypeData.map((item, idx) => (
                  <div key={item.name} className="flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: COLORS[idx % COLORS.length] }}
                    />
                    <span className="text-sm text-gray-600">
                      {item.name}: {item.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-gray-400">
              No questions generated yet
            </div>
          )}
        </div>
      </div>

      {/* Course Readiness & Weak Areas */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Course Readiness */}
        <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm">
          <h3 className="font-semibold text-gray-800 mb-4 flex items-center gap-2">
            <Award className="w-5 h-5 text-yellow-600" />
            Exam Readiness by Course
          </h3>
          {state.courses.length > 0 ? (
            <div className="space-y-3">
              {state.courses.map((course) => {
                const progress = getCourseProgress(course.id);
                const loProgress = getLOProgress(course.id);
                const avgProgress = Math.round((progress + loProgress) / 2);
                const status = getReadinessStatus(avgProgress);

                return (
                  <div key={course.id} className="p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-800">{course.courseCode}</span>
                        <span className={`px-2 py-0.5 text-xs rounded ${status.bg} ${status.color}`}>
                          {status.emoji} {status.label}
                        </span>
                      </div>
                      <span className="font-bold text-gray-800">{avgProgress}%</span>
                    </div>
                    <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          avgProgress >= 70 ? 'bg-green-500' : avgProgress >= 40 ? 'bg-yellow-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${avgProgress}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-400">No courses yet</div>
          )}
        </div>

        {/* Weak Areas */}
        <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm">
          <h3 className="font-semibold text-gray-800 mb-4 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-red-500" />
            Topics Needing Attention
          </h3>
          {weakTopics.length > 0 ? (
            <div className="space-y-3">
              {weakTopics.map((topic) => (
                <div key={topic.topicName} className="flex items-center justify-between p-3 bg-red-50 rounded-lg">
                  <div>
                    <p className="font-medium text-gray-800">{topic.topicName}</p>
                    <p className="text-sm text-gray-500">{topic.courseCode}</p>
                  </div>
                  <span className="font-bold text-red-600">{topic.progress}%</span>
                </div>
              ))}
            </div>
          ) : topicProgressData.length > 0 ? (
            <div className="text-center py-8">
              <CheckCircle2 className="w-12 h-12 text-green-400 mx-auto mb-2" />
              <p className="text-green-600 font-medium">Great job! All topics are on track.</p>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-400">No topic data yet</div>
          )}
        </div>
      </div>

      {/* Learning Objectives Summary */}
      <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm">
        <h3 className="font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <Target className="w-5 h-5 text-[#FFB703]" />
          Learning Objectives Summary
        </h3>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="p-4 bg-green-50 rounded-lg">
            <p className="text-3xl font-bold text-green-600">{masteredLOs}</p>
            <p className="text-sm text-gray-600">Mastered</p>
          </div>
          <div className="p-4 bg-yellow-50 rounded-lg">
            <p className="text-3xl font-bold text-yellow-600">
              {state.learningObjectives.filter((lo) => lo.status === 'partial').length}
            </p>
            <p className="text-sm text-gray-600">Partially Understood</p>
          </div>
          <div className="p-4 bg-red-50 rounded-lg">
            <p className="text-3xl font-bold text-red-600">
              {state.learningObjectives.filter((lo) => lo.status === 'not_covered').length}
            </p>
            <p className="text-sm text-gray-600">Not Covered</p>
          </div>
        </div>
        {totalLOs > 0 && (
          <div className="mt-4">
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-600">Overall LO Mastery</span>
              <span className="font-medium text-gray-800">
                {Math.round((masteredLOs / totalLOs) * 100)}%
              </span>
            </div>
            <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-[#FFB703]"
                style={{ width: `${(masteredLOs / totalLOs) * 100}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Recent Activity */}
      <div className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm">
        <h3 className="font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <Clock className="w-5 h-5 text-gray-600" />
          Recent Activity ({timeRange === 'all' ? 'All Time' : `Last ${getDaysAgo} days`})
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div className="p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-800">{recentActivities.length}</p>
            <p className="text-sm text-gray-500">Total Activities</p>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-800">
              {recentActivities.filter((a) => a.type === 'slide_completed').length}
            </p>
            <p className="text-sm text-gray-500">Slides Completed</p>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-800">
              {recentActivities.filter((a) => a.type === 'quiz_taken').length}
            </p>
            <p className="text-sm text-gray-500">Quizzes Taken</p>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-800">
              {recentActivities.filter((a) => a.type === 'questions_generated').length}
            </p>
            <p className="text-sm text-gray-500">Question Sets Generated</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Analytics;

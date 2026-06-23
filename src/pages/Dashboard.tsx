import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { format, differenceInDays, parseISO } from 'date-fns';
import {
  BookOpen,
  Target,
  FileQuestion,
  TrendingUp,
  AlertCircle,
  CheckCircle2,
  Clock,
  Calendar,
  ArrowRight,
  Plus,
  Brain,
  Sparkles,
} from 'lucide-react';

const Dashboard: React.FC = () => {
  const {
    state,
    getCourseProgress,
    getLOProgress,
    getOverallProgress,
    getTopicsForCourse,
  } = useApp();
  const navigate = useNavigate();

  const overallProgress = getOverallProgress();

  // Get recent activities
  const recentActivities = state.activities.slice(0, 5);

  // Get upcoming exams (within 60 days) safely
  const upcomingExams = state.examDates
    .filter((ed) => {
      if (!ed.examDate) return false;
      try {
        const daysUntil = differenceInDays(parseISO(ed.examDate), new Date());
        return daysUntil >= 0 && daysUntil <= 60;
      } catch (e) { return false; }
    })
    .sort((a, b) => new Date(a.examDate).getTime() - new Date(b.examDate).getTime())
    .slice(0, 3);

  // Get courses sorted by progress
  const coursesByProgress = [...state.courses]
    .map((course) => ({
      ...course,
      progress: getCourseProgress(course.id),
      loProgress: getLOProgress(course.id),
    }))
    .sort((a, b) => a.progress - b.progress);

  // Weekly study plans
  const weekPlans = state.studyPlans
    .filter((sp) => {
      if (!sp.date) return false;
      try {
        const planDate = parseISO(sp.date);
        const diff = differenceInDays(planDate, new Date());
        return diff >= 0 && diff <= 7;
      } catch(e) { return false; }
    })
    .slice(0, 5);

  const getProgressColor = (progress: number) => {
    if (progress >= 71) return { bg: 'bg-green-500', text: 'text-green-600', light: 'bg-green-100' };
    if (progress >= 31) return { bg: 'bg-yellow-500', text: 'text-yellow-600', light: 'bg-yellow-100' };
    return { bg: 'bg-red-500', text: 'text-red-600', light: 'bg-red-100' };
  };

  const totalSlides = state.slides.length;
  const completedSlides = state.slides.filter((s) => s.status === 'completed').length;
  const totalQuestions = state.examQuestions.length;

  const getActivityRoute = (type: string) => {
    switch (type) {
      case 'slide_completed': return '/materials';
      case 'quiz_taken': return '/quiz';
      case 'questions_generated': return '/questions';
      case 'course_added': return '/courses';
      default: return '/';
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Welcome header */}
      <div className="bg-gradient-to-r from-[#1B4332] to-[#2D6A4F] rounded-2xl p-6 text-white relative overflow-hidden shadow-lg">
        <div className="absolute top-0 right-0 p-4 opacity-10">
          <Sparkles className="w-24 h-24" />
        </div>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 relative z-10">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2 py-0.5 bg-[#FFB703] text-[#1B4332] text-[10px] font-black rounded uppercase tracking-widest">
                PharmaGAME AI Connected
              </span>
            </div>
            <h1 className="text-2xl md:text-3xl font-bold mb-1">
            Welcome back, {state.student?.name || 'Student'}! 👋
          </h1>
          <p className="text-green-100 font-medium">
            {state.student?.university || 'UCC'} | Level {state.student?.level || '100'} | {state.student?.semester || '1st'} Semester | {state.student?.program || 'Pharmacy'}
          </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/courses"
              className="flex items-center gap-2 px-4 py-2 bg-[#FFB703] text-[#1B4332] font-bold rounded-xl hover:bg-yellow-400 transition-colors shadow-sm"
            >
              <Plus className="w-5 h-5" />
              Add Course
            </Link>
          </div>
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Link to="/courses" className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm hover:shadow-md hover:border-[#2D6A4F]/20 transition-all group">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#2D6A4F]/10 rounded-lg flex items-center justify-center group-hover:scale-110 transition-transform">
              <BookOpen className="w-5 h-5 text-[#2D6A4F]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-800">{state.courses.length}</p>
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">Courses</p>
            </div>
          </div>
        </Link>

        <Link to="/materials" className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm hover:shadow-md hover:border-[#FFB703]/20 transition-all group">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#FFB703]/10 rounded-lg flex items-center justify-center group-hover:scale-110 transition-transform">
              <Target className="w-5 h-5 text-[#FFB703]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-800">{completedSlides}/{totalSlides}</p>
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">Slides Done</p>
            </div>
          </div>
        </Link>

        <Link to="/questions" className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm hover:shadow-md hover:border-purple-200 transition-all group">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center group-hover:scale-110 transition-transform">
              <FileQuestion className="w-5 h-5 text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-800">{totalQuestions}</p>
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">Questions</p>
            </div>
          </div>
        </Link>

        <Link to="/quiz" className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm hover:shadow-md hover:border-blue-200 transition-all group">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center group-hover:scale-110 transition-transform">
              <Brain className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-800">{state.quizHistory.length}</p>
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">Quizzes</p>
            </div>
          </div>
        </Link>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left column */}
        <div className="lg:col-span-2 space-y-6">
          
          <div className="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-800">Overall Progress</h2>
              <span className={`text-2xl font-black ${getProgressColor(overallProgress).text}`}>
                {overallProgress}%
              </span>
            </div>
            <div className="h-4 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full ${getProgressColor(overallProgress).bg} transition-all duration-500`}
                style={{ width: `${overallProgress}%` }}
              />
            </div>
          </div>

          <div className="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-800">My Courses</h2>
              <Link to="/courses" className="text-sm font-bold text-[#2D6A4F] hover:underline flex items-center gap-1">
                View all <ArrowRight className="w-4 h-4" />
              </Link>
            </div>

            {state.courses.length === 0 ? (
              <div className="text-center py-8">
                <BookOpen className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 mb-4 font-medium">No courses added yet</p>
                <Link to="/courses" className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#2D6A4F] text-white font-bold rounded-xl hover:bg-[#1B4332] transition-colors shadow-md">
                  <Plus className="w-5 h-5" /> Add Your First Course
                </Link>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 gap-4">
                {coursesByProgress.slice(0, 4).map((course) => {
                  const colors = getProgressColor(course.progress);
                  const topicsCount = getTopicsForCourse(course.id).length;
                  return (
                    <Link
                      key={course.id}
                      to={`/course/${course.id}`}
                      className="block p-5 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors border border-slate-200"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <p className="font-bold text-gray-800">{course.courseCode}</p>
                          <p className="text-sm font-medium text-gray-500 line-clamp-1">{course.courseName}</p>
                        </div>
                        <span className={`text-sm font-bold ${colors.text}`}>{course.progress}%</span>
                      </div>
                      <div className="h-2 bg-gray-200 rounded-full overflow-hidden mb-2">
                        <div className={`h-full ${colors.bg} transition-all`} style={{ width: `${course.progress}%` }} />
                      </div>
                      <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">{topicsCount} topics</p>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          <div className="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-800">This Week's Plan</h2>
              <Link to="/planner" className="text-sm font-bold text-[#2D6A4F] hover:underline flex items-center gap-1">
                Open Planner <ArrowRight className="w-4 h-4" />
              </Link>
            </div>

            {weekPlans.length === 0 ? (
              <div className="text-center py-6">
                <Calendar className="w-10 h-10 text-gray-300 mx-auto mb-2" />
                <p className="text-gray-500 text-sm font-medium">No study plans for this week</p>
                <Link to="/planner" className="text-[#2D6A4F] font-bold text-sm hover:underline mt-2 inline-block">
                  Create a plan
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {weekPlans.map((plan: any) => {
                  const course = state.courses.find((c) => c.id === plan.courseId);
                  return (
                    <div key={plan.id} className={`flex items-center gap-3 p-4 rounded-xl ${plan.status === 'completed' ? 'bg-green-50 border border-green-100' : 'bg-slate-50 border border-slate-100'}`}>
                      {plan.status === 'completed' ? (
                        <CheckCircle2 className="w-6 h-6 text-green-500 flex-shrink-0" />
                      ) : (
                        <Clock className="w-6 h-6 text-slate-400 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-gray-800 truncate">
                          {course?.courseCode} - {plan.title}
                        </p>
                        <p className="text-xs font-medium text-gray-500 mt-0.5">
                          {plan.date ? format(parseISO(plan.date), 'EEE, MMM d') : 'Unknown Date'} • {plan.durationMinutes} mins
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-6">
          
          <div className="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm">
            <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-[#FFB703]" /> Upcoming Exams
            </h2>
            {upcomingExams.length === 0 ? (
              <p className="text-gray-500 text-sm text-center py-4 font-medium">No upcoming exams</p>
            ) : (
              <div className="space-y-3">
                {upcomingExams.map((exam) => {
                  const course = state.courses.find((c) => c.id === exam.courseId);
                  const daysUntil = differenceInDays(parseISO(exam.examDate), new Date());
                  return (
                    <div key={exam.id} className={`p-4 rounded-xl ${daysUntil <= 7 ? 'bg-red-50 border border-red-100' : 'bg-slate-50 border border-slate-100'}`}>
                      <div className="flex items-center justify-between mb-1">
                        <p className="font-bold text-gray-800">{course?.courseCode}</p>
                        <span className={`text-xs font-black uppercase tracking-wider px-2 py-1 rounded-md ${daysUntil <= 7 ? 'bg-red-100 text-red-600' : 'bg-slate-200 text-slate-600'}`}>
                          {daysUntil === 0 ? 'Today!' : `${daysUntil} days`}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-gray-500 capitalize">{exam.examType}</p>
                      <p className="text-xs font-bold text-gray-400 mt-1 uppercase">
                        {exam.examDate ? format(parseISO(exam.examDate), 'EEEE, MMM d, yyyy') : 'Unknown Date'}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm">
            <h2 className="text-lg font-bold text-gray-800 mb-4">Recent Activity</h2>
            {recentActivities.length === 0 ? (
              <p className="text-gray-500 text-sm text-center py-4 font-medium">No recent activity</p>
            ) : (
              <div className="space-y-2">
                {recentActivities.map((activity) => (
                  <div 
                    key={activity.id} 
                    onClick={() => navigate(getActivityRoute(activity.type))}
                    className="flex items-start gap-3 p-3 -mx-3 rounded-xl hover:bg-slate-50 cursor-pointer transition-colors"
                  >
                    <div className="w-10 h-10 bg-[#2D6A4F]/10 rounded-full flex items-center justify-center flex-shrink-0">
                      {activity.type === 'slide_completed' && <CheckCircle2 className="w-5 h-5 text-green-600" />}
                      {activity.type === 'quiz_taken' && <Brain className="w-5 h-5 text-blue-600" />}
                      {activity.type === 'questions_generated' && <Sparkles className="w-5 h-5 text-purple-600" />}
                      {activity.type === 'course_added' && <BookOpen className="w-5 h-5 text-[#2D6A4F]" />}
                      {activity.type === 'objective_mastered' && <Target className="w-5 h-5 text-[#FFB703]" />}
                      {!['slide_completed', 'quiz_taken', 'questions_generated', 'course_added', 'objective_mastered'].includes(activity.type) && <Clock className="w-5 h-5 text-slate-500" />}
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <p className="text-sm font-medium text-gray-800 line-clamp-2">{activity.description}</p>
                      <p className="text-xs font-bold text-gray-400 mt-1 uppercase">
                        {activity.timestamp ? format(parseISO(activity.timestamp), 'MMM d, h:mm a') : 'Unknown Date'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-gradient-to-br from-[#FFB703]/10 to-[#FFB703]/5 rounded-2xl p-6 border border-[#FFB703]/20 shadow-sm">
            <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-[#FFB703]" /> Recommendations
            </h2>
            <div className="space-y-4">
              {coursesByProgress.length > 0 && coursesByProgress[0].progress < 50 && (
                <div className="flex items-start gap-3 bg-white/60 p-3 rounded-xl">
                  <AlertCircle className="w-5 h-5 text-[#FFB703] mt-0.5 flex-shrink-0" />
                  <p className="text-sm font-medium text-gray-800 leading-snug">
                    Focus on <strong className="font-bold">{coursesByProgress[0].courseCode}</strong> - lowest progress at {coursesByProgress[0].progress}%
                  </p>
                </div>
              )}
              {state.examQuestions.filter((q) => q.needsReview).length > 0 && (
                <div className="flex items-start gap-3 bg-white/60 p-3 rounded-xl">
                  <Brain className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
                  <p className="text-sm font-medium text-gray-800 leading-snug">
                    You have {state.examQuestions.filter((q) => q.needsReview).length} questions marked for review
                  </p>
                </div>
              )}
              {state.quizHistory.length === 0 && state.examQuestions.length > 0 && (
                <div className="flex items-start gap-3 bg-white/60 p-3 rounded-xl">
                  <Sparkles className="w-5 h-5 text-purple-500 mt-0.5 flex-shrink-0" />
                  <p className="text-sm font-medium text-gray-800 leading-snug">
                    Try taking your first quiz to test your knowledge!
                  </p>
                </div>
              )}
              {state.courses.length === 0 && (
                <div className="flex items-start gap-3 bg-white/60 p-3 rounded-xl">
                  <BookOpen className="w-5 h-5 text-[#2D6A4F] mt-0.5 flex-shrink-0" />
                  <p className="text-sm font-medium text-gray-800 leading-snug">
                    Get started by adding your first course
                  </p>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
};
export default Dashboard;

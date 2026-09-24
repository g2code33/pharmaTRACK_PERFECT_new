import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import {
  ArrowRight,
  BookOpen,
  Calendar,
  Clock,
  Plus,
  Sparkles,
  Target,
} from 'lucide-react';
import { useAI } from '../ai/state';
import ClassPrepCard from '../components/ClassPrepCard';
import { formatStudyTime, studyBrief, type NowAction, type Urgency } from '../utils/studyDashboard';

const MARK: Record<Urgency, string> = { red: '🔴', orange: '🟠', yellow: '🟡' };
const MARK_LABEL: Record<Urgency, string> = { red: 'Now', orange: 'Next', yellow: 'Later' };

function ActionRow({ action }: { action: NowAction }) {
  return (
    <Link to={action.href} className="flex items-start gap-3 p-3 sm:p-4 rounded-xl border border-gray-100 bg-gray-50 hover:border-[#2D6A4F]/40 hover:bg-white min-h-12">
      <span className="text-xl leading-none mt-0.5" aria-hidden>{MARK[action.urgency]}</span>
      <span className="sr-only">{MARK_LABEL[action.urgency]}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-bold text-gray-900">{action.title}</span>
        <span className="block text-sm text-gray-500 mt-0.5">{action.detail}</span>
      </span>
      <ArrowRight className="w-4 h-4 text-gray-400 shrink-0 mt-1" />
    </Link>
  );
}

const Dashboard: React.FC = () => {
  const { state, getCourseProgress, getTopicsForCourse } = useApp();
  const ai = useAI();
  const brief = studyBrief(state);
  const courses = [...state.courses]
    .map((course) => ({ ...course, progress: getCourseProgress(course.id) }))
    .sort((a, b) => a.progress - b.progress);

  return (
    <div className="space-y-5 sm:space-y-6 max-w-7xl mx-auto">
      <div className="bg-gradient-to-r from-[#1B4332] to-[#2D6A4F] rounded-2xl p-4 sm:p-6 text-white relative overflow-hidden shadow-lg">
        <div className="absolute top-0 right-0 p-4 opacity-10 hidden sm:block"><Sparkles className="w-24 h-24" /></div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 relative z-10">
          <div className="min-w-0">
            <Link
              to="/settings?tab=ai"
              data-testid="dashboard-ai-status"
              className={`inline-block px-2 py-0.5 text-[10px] font-black rounded uppercase tracking-widest ${ai.ready ? 'bg-[#FFB703] text-[#1B4332]' : 'bg-white/15 text-green-50'}`}
            >
              {ai.ready ? `AI Connected${ai.activeProviderLabel ? ` · ${ai.activeProviderLabel}` : ''}` : 'AI Not Configured'}
            </Link>
            <h1 className="text-2xl sm:text-3xl font-bold mt-2 truncate">Welcome back, {state.student?.name || 'Student'}</h1>
            <p className="text-green-100 text-sm sm:text-base mt-1">
              {state.student?.university || 'UCC'} · Level {state.student?.level || '100'} · {state.student?.semester || '1st'} Semester
            </p>
          </div>
          <Link to="/courses" className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#FFB703] text-[#1B4332] font-bold rounded-xl shrink-0">
            <Plus className="w-5 h-5" /> Add Course
          </Link>
        </div>
      </div>

      <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6" data-testid="do-now">
        <div className="flex items-end justify-between gap-3 mb-4">
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-[#2D6A4F]">Today</p>
            <h2 className="text-xl sm:text-2xl font-black text-gray-900">What should I do now?</h2>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <Link to="/learn" className="text-sm font-bold text-[#2D6A4F]">Spaced revision</Link>
            <Link to="/clinical" className="text-sm font-bold text-[#2D6A4F]">Clinical cases</Link>
          </div>
        </div>
        {brief.now.length === 0 ? (
          <div className="rounded-xl bg-gray-50 p-4 text-sm text-gray-600">
            <p className="font-semibold text-gray-800">Nothing is due yet.</p>
            <p className="mt-1">Add a class, a study plan, or open a topic. Priorities show up from your timetable and revision dates — no AI required.</p>
            <div className="flex flex-wrap gap-2 mt-3">
              <Link to="/timetable" className="px-3 py-2 bg-[#1B4332] text-white rounded-lg text-sm font-bold">Add a class</Link>
              <Link to="/learn" className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm font-bold">Open topics</Link>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {brief.now.map((action) => <ActionRow key={action.id} action={action} />)}
          </div>
        )}
      </section>

      <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3" data-testid="dashboard-stats">
        <Stat label="Study time" value={formatStudyTime(brief.stats.studyMinutes)} detail="Quizzes and finished plans" />
        <Stat label="Topics done" value={String(brief.stats.topicsCompleted)} detail={`${brief.stats.topicsRemaining} remaining`} />
        <Stat label="Quiz accuracy" value={brief.stats.quizAccuracy === null ? '—' : `${brief.stats.quizAccuracy}%`} detail="From saved attempts" />
        <Stat label="Revision" value={String(brief.stats.revisionDue)} detail={`${brief.stats.needsRevision} need revision`} />
        <Stat label="Exam countdown" value={brief.stats.nextExamDays === null ? '—' : brief.stats.nextExamDays === 0 ? 'Today' : `${brief.stats.nextExamDays}d`} detail={brief.stats.nextExamLabel} />
        <Stat label="Semester" value={`${brief.stats.semesterProgress}%`} detail="Slide progress" />
      </section>

      {brief.nextClass && (
        <div>
          <div className="flex items-center justify-between mb-2 px-1">
            <h2 className="font-black text-gray-800">Next class</h2>
            <Link to="/timetable" className="text-sm font-bold text-[#2D6A4F]">Timetable</Link>
          </div>
          <ClassPrepCard session={brief.nextClass} open />
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <Panel title="Overdue revisions" href="/learn" empty="No revision is overdue.">
            {brief.overdue.map((item) => (
              <Link key={item.id} to={item.href} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-red-50">
                <span className="font-semibold text-gray-800 truncate">🔴 {item.label}</span>
                <span className="text-xs font-bold text-red-600 shrink-0">{item.detail}</span>
              </Link>
            ))}
          </Panel>
          <Panel title="Weak topics" href="/quiz?mode=weak" empty="No weak topics yet.">
            {brief.weakTopics.slice(0, 5).map((item) => (
              <Link key={item.id} to={item.href} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-orange-50">
                <span className="font-semibold text-gray-800 truncate">🟠 {item.label}</span>
                <span className="text-xs font-bold text-orange-700 shrink-0">{item.detail}</span>
              </Link>
            ))}
          </Panel>
          <Panel title="Unfinished plans" href="/planner" empty="No open study plans.">
            {brief.unfinishedPlans.slice(0, 5).map((item) => (
              <Link key={item.id} to={item.href} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-gray-50">
                <span className="font-semibold text-gray-800 truncate">{item.label}</span>
                <span className="text-xs text-gray-500 shrink-0">{item.detail}</span>
              </Link>
            ))}
          </Panel>
          <Panel title="Recent materials" href="/library" empty="No materials yet.">
            {brief.recentMaterials.map((item) => (
              <Link key={item.id} to={item.href} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-gray-50">
                <span className="min-w-0">
                  <span className="block font-semibold text-gray-800 truncate">{item.label}</span>
                  <span className="block text-xs text-gray-500 truncate">{item.detail}</span>
                </span>
                <ArrowRight className="w-4 h-4 text-gray-300 shrink-0" />
              </Link>
            ))}
          </Panel>
        </div>

        <div className="space-y-5">
          <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-5">
            <h2 className="font-black text-gray-800 mb-3 flex items-center gap-2"><Calendar className="w-5 h-5 text-[#FFB703]" /> Upcoming exams</h2>
            {brief.upcomingExams.length === 0 ? <p className="text-sm text-gray-500">No exam in the next 60 days.</p> : (
              <div className="space-y-2">
                {brief.upcomingExams.map((exam) => (
                  <Link key={exam.id} to={exam.href} className="block p-3 rounded-xl bg-slate-50">
                    <span className="font-bold text-gray-800">{exam.label}</span>
                    <span className="block text-xs font-bold text-gray-500 mt-1">{exam.detail}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-5">
            <h2 className="font-black text-gray-800 mb-3 flex items-center gap-2"><Target className="w-5 h-5 text-blue-600" /> Quiz performance</h2>
            <p className="text-3xl font-black text-gray-900">{brief.quizAccuracy === null ? '—' : `${brief.quizAccuracy}%`}</p>
            <p className="text-xs text-gray-500 mb-3">Accuracy across saved attempts</p>
            {brief.recentScores.length > 0 && (
              <div className="flex items-end gap-1 h-16">
                {brief.recentScores.map((score, index) => (
                  <div key={index} className="flex-1 bg-blue-100 rounded-t" style={{ height: `${Math.max(8, score)}%` }} title={`${score}%`} />
                ))}
              </div>
            )}
            <Link to="/quiz" className="inline-block mt-3 text-sm font-bold text-[#2D6A4F]">Take a quiz</Link>
          </section>

          <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-black text-gray-800">Semester progress</h2>
              <span className="font-black text-[#2D6A4F]">{brief.stats.semesterProgress}%</span>
            </div>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden mb-4">
              <div className="h-full bg-[#2D6A4F]" style={{ width: `${brief.stats.semesterProgress}%` }} />
            </div>
            {courses.length === 0 ? <p className="text-sm text-gray-500">Add a course to track the semester.</p> : (
              <div className="space-y-2">
                {courses.slice(0, 4).map((course) => (
                  <Link key={course.id} to={`/course/${course.id}`} className="block">
                    <span className="flex justify-between text-sm font-semibold text-gray-700"><span className="truncate">{course.courseCode}</span><span>{course.progress}%</span></span>
                    <span className="block text-xs text-gray-400">{getTopicsForCourse(course.id).length} topics</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {brief.todayClasses.filter((session) => session.id !== brief.nextClass?.id).length > 0 && (
        <section>
          <h2 className="font-black text-gray-800 mb-2 flex items-center gap-2"><Clock className="w-5 h-5" /> Today&apos;s classes</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {brief.todayClasses.filter((session) => session.id !== brief.nextClass?.id).map((session) => <ClassPrepCard key={session.id} session={session} />)}
          </div>
        </section>
      )}

      <Link to="/courses" className="sm:hidden flex items-center justify-center gap-2 py-3 text-sm font-bold text-[#2D6A4F]">
        <BookOpen className="w-4 h-4" /> All courses
      </Link>
    </div>
  );
};

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-3 min-w-0">
      <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 truncate">{label}</p>
      <p className="text-xl font-black text-gray-900 mt-1 truncate">{value}</p>
      <p className="text-xs text-gray-500 truncate">{detail}</p>
    </div>
  );
}

function Panel({ title, href, empty, children }: { title: string; href: string; empty: string; children: ReactNode }) {
  const list = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-black text-gray-800">{title}</h2>
        <Link to={href} className="text-sm font-bold text-[#2D6A4F]">Open</Link>
      </div>
      {list.length === 0 ? <p className="text-sm text-gray-500">{empty}</p> : <div className="space-y-2">{children}</div>}
    </section>
  );
}

export default Dashboard;

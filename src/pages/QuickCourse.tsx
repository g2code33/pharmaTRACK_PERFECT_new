import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  Home,
  Layers,
  PlayCircle,
  RotateCcw,
  Timer,
  Trophy,
} from 'lucide-react';
import { detectRuntimeCapabilities } from '../platform/runtime';
import {
  decodeQuickCoursePack,
  quickCourseTopicRoute,
  type QuickCourseEntry,
  type QuickCoursePack,
} from '../utils/quickCourseShare';
import {
  quickCourseEntryKey,
  quickCourseEntryProgress,
  type QuickCourseEntryProgress,
} from '../utils/quickQuizAttempts';
import { APP_STORE_URL, openInstalledAppOrStore } from '../utils/appLinks';
import NativeTitleBar from '../components/NativeTitleBar';

type Row = {
  entry: QuickCourseEntry;
  entryKey: string;
  progress: QuickCourseEntryProgress;
};

const statusTone: Record<QuickCourseEntryProgress['status'], string> = {
  'not-started': 'border-slate-200 bg-white',
  'in-progress': 'border-amber-200 bg-amber-50/60',
  done: 'border-emerald-200 bg-emerald-50/60',
};

/**
 * The page a shared course link opens.
 *
 * Sharing a single topic drops the recipient straight into that quiz. Sharing a
 * course instead brings them here, where every topic is listed so they can
 * choose one, do it, and come back to this same page for the next one whenever
 * they want. Progress for each topic is kept on the device, so the list shows
 * what is finished, what is half-done and what has not been started.
 */
const QuickCourse: React.FC = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const runtime = detectRuntimeCapabilities();
  const courseParam = params.get('p') || '';
  // Re-read progress whenever the page is shown again, so finishing a topic and
  // coming back immediately reflects the new score.
  const [progressTick, setProgressTick] = useState(0);

  useEffect(() => {
    const refresh = () => setProgressTick((value) => value + 1);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  const decoded = useMemo<{ pack?: QuickCoursePack; error?: string }>(() => {
    if (!courseParam) return { error: 'No course was found in this link.' };
    try {
      return { pack: decodeQuickCoursePack(courseParam) };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'This course link could not be opened.',
      };
    }
  }, [courseParam]);

  // progressTick is a deliberate dependency: bumping it re-reads what this
  // device has finished, so returning from a topic shows the new score.
  const rows = useMemo<Row[]>(() => {
    if (!decoded.pack || progressTick < 0) return [];
    return decoded.pack.entries.map((entry) => {
      const entryKey = quickCourseEntryKey(entry);
      return { entry, entryKey, progress: quickCourseEntryProgress(entryKey) };
    });
  }, [decoded.pack, progressTick]);

  const totals = useMemo(() => {
    const done = rows.filter((row) => row.progress.status === 'done');
    const questions = rows.reduce((sum, row) => sum + row.entry.questionCount, 0);
    const averagePercent = done.length
      ? Math.round(
          done.reduce((sum, row) => sum + (row.progress.status === 'done' ? row.progress.percent : 0), 0) /
            done.length,
        )
      : 0;
    return { done: done.length, total: rows.length, questions, averagePercent };
  }, [rows]);

  if (decoded.error || !decoded.pack) {
    return (
      <div className="min-h-[100dvh]">
        <NativeTitleBar sticky />
        <div className="mx-auto max-w-2xl p-4 sm:p-8">
        <div className="rounded-3xl border border-amber-200 bg-amber-50 p-6 text-center">
          <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-amber-500" />
          <h1 className="mb-2 text-xl font-black text-amber-900">This course link did not open</h1>
          <p className="mb-5 text-sm font-semibold text-amber-800">{decoded.error}</p>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="inline-flex items-center gap-2 rounded-2xl bg-[#2D6A4F] px-5 py-3 text-sm font-black text-white hover:bg-[#1B4332]"
          >
            <Home className="h-4 w-4" /> Go to PharmaTRACK
          </button>
          </div>
        </div>
      </div>
    );
  }

  const pack = decoded.pack;
  const allDone = totals.total > 0 && totals.done === totals.total;

  return (
    <div className="min-h-[100dvh] bg-slate-50">
      <NativeTitleBar sticky />
      <div className="app-page-main mx-auto w-full max-w-4xl space-y-4 p-4 pb-16 sm:space-y-6 sm:p-8">
      {/* Web visitors get the app first; a packaged app is already the app. */}
      {!runtime.nativeHost && !runtime.isPWA ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs font-black uppercase tracking-wider text-slate-500">
            Works best in the PharmaTRACK app
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                void openInstalledAppOrStore(
                  `/quick-course?p=${encodeURIComponent(courseParam)}`,
                )
              }
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#2D6A4F] px-3 py-2 text-xs font-black text-white hover:bg-[#1B4332]"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open in app
            </button>
            <a
              href={APP_STORE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" /> Get app
            </a>
          </div>
        </div>
      ) : null}

      <header className="relative overflow-hidden rounded-[1.5rem] bg-gradient-to-r from-indigo-900 via-purple-800 to-fuchsia-800 p-5 text-white shadow-2xl sm:rounded-[2rem] sm:p-8">
        <div className="absolute right-0 top-0 p-8 opacity-20">
          <Layers size={110} />
        </div>
        <div className="relative z-10">
          <span className="rounded-full bg-white/20 px-3 py-1 text-xs font-black uppercase tracking-widest backdrop-blur-md">
            Shared course
          </span>
          <h1 className="mt-3 text-2xl font-black tracking-tight sm:text-4xl">{pack.title}</h1>
          <p className="mt-2 max-w-xl text-sm font-semibold text-purple-100 sm:text-base">
            Choose any topic to start. Your progress is saved on this device, so you can leave and
            come back to finish the rest whenever you like.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs font-black uppercase tracking-wider">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5">
              <BookOpen className="h-3.5 w-3.5" /> {totals.total} topic{totals.total === 1 ? '' : 's'}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5">
              {totals.questions} question{totals.questions === 1 ? '' : 's'}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5">
              <Timer className="h-3.5 w-3.5" />
              {pack.timeLimitMinutes ? `${pack.timeLimitMinutes} min per topic` : 'No time limit'}
            </span>
          </div>
        </div>
      </header>

      <div
        data-testid="quick-course-progress"
        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-100 text-[#1B4332]">
            {allDone ? <Trophy className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
          </div>
          <div>
            <p className="text-sm font-black text-slate-800">
              {totals.done} of {totals.total} topics done
            </p>
            <p className="text-xs font-bold text-slate-500">
              {allDone
                ? 'Every topic in this course is complete. Resit any of them any time.'
                : 'Finish a topic, then come back here for the next one.'}
              {totals.done ? ` · ${totals.averagePercent}% average` : ''}
            </p>
          </div>
        </div>
        <div className="h-2 w-full max-w-[14rem] overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-[#2D6A4F] transition-[width] duration-300"
            style={{ width: `${totals.total ? (totals.done / totals.total) * 100 : 0}%` }}
          />
        </div>
      </div>

      <ol className="space-y-3" data-testid="quick-course-topics">
        {rows.map((row, index) => {
          const { entry, progress } = row;
          const started = progress.status !== 'not-started';
          return (
            <li
              key={`${row.entryKey}-${index}`}
              className={`perf-deferred-card flex flex-col gap-3 rounded-2xl border p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between ${statusTone[progress.status]}`}
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-xs font-black text-white">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <h2 className="truncate text-base font-black text-slate-800">{entry.name}</h2>
                  <p className="text-xs font-bold text-slate-500">
                    {entry.questionCount} question{entry.questionCount === 1 ? '' : 's'}
                    {progress.status === 'done'
                      ? ` · scored ${progress.percent}% (${progress.correct}/${progress.total})`
                      : ''}
                    {progress.status === 'in-progress'
                      ? ` · ${progress.answered} answered so far`
                      : ''}
                  </p>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                {progress.status === 'done' ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-[#1B4332]">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Done
                  </span>
                ) : null}
                {progress.status === 'in-progress' ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-amber-800">
                    <Clock className="h-3.5 w-3.5" /> In progress
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => navigate(quickCourseTopicRoute(entry, courseParam))}
                  className="inline-flex items-center gap-2 rounded-xl bg-[#2D6A4F] px-4 py-2.5 text-sm font-black text-white hover:bg-[#1B4332]"
                >
                  {progress.status === 'done' ? (
                    <>
                      <RotateCcw className="h-4 w-4" /> Resit
                    </>
                  ) : started ? (
                    <>
                      <PlayCircle className="h-4 w-4" /> Resume
                    </>
                  ) : (
                    <>
                      Start <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-50"
        >
          <Home className="h-4 w-4" /> PharmaTRACK home
        </button>
      </div>
      </div>
    </div>
  );
};

export default QuickCourse;

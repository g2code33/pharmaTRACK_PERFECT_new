import React, { useCallback, useState } from 'react';
import { AlertTriangle, Check, Clock, Copy, Layers, Link2, Loader2, Share2, Timer, X } from 'lucide-react';
import type { QuickQuizPack } from '../utils/quickQuizShare';
import { quickQuizShareUrl } from '../utils/quickQuizShare';
import { createQuickCourseShare, type QuickCourseTopicInput } from '../utils/quickCourseShare';
import { canUseWebShare, copyTextToClipboard, shareOrCopyLink } from '../utils/clipboard';

const TIME_PRESETS = [5, 10, 15, 20, 30, 45, 60];

type Stage =
  | { kind: 'timing' }
  | { kind: 'working'; progress?: string }
  | {
      kind: 'ready';
      url: string;
      mode: 'short-code' | 'inline' | 'course';
      copied: boolean;
      offlineTopics?: string[];
    }
  | { kind: 'error'; message: string };

/** What the sheet is being asked to share. */
type ShareJob =
  | { kind: 'quiz'; pack: QuickQuizPack }
  | {
      kind: 'course';
      title: string;
      course?: { code?: string; name?: string };
      topics: QuickCourseTopicInput[];
      questionCount: number;
    };

export interface QuickCourseShareInput {
  title: string;
  course?: { code?: string; name?: string };
  topics: QuickCourseTopicInput[];
}

export interface QuickQuizShareController {
  /** Opens the share sheet for a pack. Does nothing when there is no pack. */
  startShare: (pack: QuickQuizPack | null | undefined) => void;
  /**
   * Opens the share sheet for a whole course. The recipient gets a page
   * listing every topic instead of being dropped into one quiz.
   */
  startCourseShare: (input: QuickCourseShareInput | null | undefined) => void;
  /** Render this anywhere in the page; it is `null` while the sheet is closed. */
  shareDialog: React.ReactNode;
}

/**
 * Quick quiz sharing without a single native dialog.
 *
 * `window.prompt` returns null in several app webviews (so sharing silently
 * died) and `navigator.share` rejects with NotAllowedError on desktop, which
 * used to pop the system "The request is not allowed by the user agent"
 * error box. This sheet asks for the timing in-app, builds the short link,
 * copies it automatically and always leaves the link on screen to copy by
 * hand if the runtime blocks clipboard access.
 */
export function useQuickQuizShare(): QuickQuizShareController {
  const [job, setJob] = useState<ShareJob | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'timing' });
  const [customMinutes, setCustomMinutes] = useState('');
  const [chosenMinutes, setChosenMinutes] = useState<number | undefined>(undefined);

  const startShare = useCallback((next: QuickQuizPack | null | undefined) => {
    if (!next) return;
    setJob({ kind: 'quiz', pack: next });
    setCustomMinutes('');
    setChosenMinutes(undefined);
    setStage({ kind: 'timing' });
  }, []);

  const startCourseShare = useCallback((input: QuickCourseShareInput | null | undefined) => {
    const topics = (input?.topics || []).filter((topic) =>
      topic.questions.some((question) => question.questionText.trim()),
    );
    if (!input || !topics.length) return;
    setJob({
      kind: 'course',
      title: input.title,
      course: input.course,
      topics,
      questionCount: topics.reduce((sum, topic) => sum + topic.questions.length, 0),
    });
    setCustomMinutes('');
    setChosenMinutes(undefined);
    setStage({ kind: 'timing' });
  }, []);

  const close = useCallback(() => {
    setJob(null);
    setStage({ kind: 'timing' });
  }, []);

  const generate = useCallback(
    async (minutes: number | undefined) => {
      if (!job) return;
      setChosenMinutes(minutes);
      setStage({ kind: 'working' });
      const timeLimitMinutes = minutes && minutes > 0 ? Math.round(minutes) : undefined;
      try {
        if (job.kind === 'course') {
          // Each topic becomes its own quiz link, so the course link stays
          // short however many topics there are.
          const { url, offlineTopics } = await createQuickCourseShare(
            job.topics,
            { title: job.title, course: job.course, timeLimitMinutes },
            {
              onProgress: ({ current, total, name }) =>
                setStage({
                  kind: 'working',
                  progress: `Preparing topic ${current} of ${total} · ${name}`,
                }),
            },
          );
          const copied = await copyTextToClipboard(url);
          setStage({ kind: 'ready', url, mode: 'course', copied, offlineTopics });
          return;
        }
        const timedPack: QuickQuizPack = { ...job.pack, timeLimitMinutes };
        const { url, mode } = await quickQuizShareUrl(timedPack);
        const copied = await copyTextToClipboard(url);
        setStage({ kind: 'ready', url, mode, copied });
      } catch (error) {
        setStage({
          kind: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'This link could not be created. Check your connection and try again.',
        });
      }
    },
    [job],
  );

  const copyAgain = useCallback(async () => {
    const url = stage.kind === 'ready' ? stage.url : '';
    if (!url) return;
    const copied = await copyTextToClipboard(url);
    setStage((current) => (current.kind === 'ready' ? { ...current, copied } : current));
  }, [stage]);

  const shareNow = useCallback(async () => {
    if (stage.kind !== 'ready' || !job) return;
    const label = job.kind === 'course' ? 'PharmaTRACK Course' : 'PharmaTRACK Quick Quiz';
    const result = await shareOrCopyLink({
      url: stage.url,
      title: `${label}: ${job.kind === 'course' ? job.title : job.pack.title}`,
    });
    if (result === 'shared' || result === 'copied') {
      setStage((current) => (current.kind === 'ready' ? { ...current, copied: true } : current));
    }
  }, [job, stage]);

  const customValue = Number.parseInt(customMinutes, 10);
  const customIsValid = Number.isFinite(customValue) && customValue > 0 && customValue <= 600;

  const isCourse = job?.kind === 'course';
  const jobTitle = job ? (job.kind === 'course' ? job.title : job.pack.title) : '';
  const jobQuestionCount = job ? (job.kind === 'course' ? job.questionCount : job.pack.questionCount) : 0;
  const jobSubtitle = job
    ? job.kind === 'course'
      ? `${job.topics.length} topic${job.topics.length === 1 ? '' : 's'} · ${jobQuestionCount} question${jobQuestionCount === 1 ? '' : 's'}`
      : `${jobQuestionCount} question${jobQuestionCount === 1 ? '' : 's'}`
    : '';

  const shareDialog = job ? (
    <div
      className="fixed inset-0 z-[400] flex items-end justify-center bg-slate-900/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={isCourse ? 'Share this course' : 'Share this quick quiz'}
    >
      <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl safe-area-bottom sm:rounded-3xl sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#2D6A4F] text-white">
              {isCourse ? <Layers className="h-5 w-5" /> : <Share2 className="h-5 w-5" />}
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-black text-slate-900">
                {isCourse ? 'Share whole course' : 'Share quick quiz'}
              </h2>
              <p className="truncate text-sm font-semibold text-slate-500">
                {jobTitle} · {jobSubtitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close share sheet"
            className="rounded-xl p-2 text-slate-400 hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {stage.kind === 'timing' ? (
          <div>
            <p className="mb-3 text-sm font-bold text-slate-700">
              {isCourse
                ? 'Choose the time first — it applies to each topic quiz in this course.'
                : 'Choose the time first — every shared quiz is either untimed or timed.'}
            </p>

            <button
              type="button"
              onClick={() => void generate(undefined)}
              className="mb-3 flex w-full items-center justify-between gap-3 rounded-2xl border-2 border-[#2D6A4F] bg-emerald-50 px-4 py-3 text-left hover:bg-emerald-100"
            >
              <span className="flex items-center gap-2 text-sm font-black text-[#1B4332]">
                <Clock className="h-4 w-4" /> Never — no time limit
              </span>
              <span className="text-xs font-black uppercase tracking-wider text-[#2D6A4F]">Share</span>
            </button>

            <p className="mb-2 text-xs font-black uppercase tracking-wider text-slate-500">Timed</p>
            <div className="mb-3 grid grid-cols-[repeat(4,minmax(0,1fr))] gap-2">
              {TIME_PRESETS.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  onClick={() => void generate(minutes)}
                  className="rounded-2xl border border-slate-200 bg-white px-2 py-3 text-sm font-black text-slate-700 hover:border-[#2D6A4F] hover:bg-emerald-50"
                >
                  {minutes}m
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <label className="sr-only" htmlFor="quick-quiz-share-minutes">
                Custom minutes
              </label>
              <input
                id="quick-quiz-share-minutes"
                type="number"
                min={1}
                max={600}
                inputMode="numeric"
                value={customMinutes}
                onChange={(event) => setCustomMinutes(event.target.value)}
                placeholder="Custom minutes"
                className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm font-bold text-slate-700 outline-none focus:border-[#2D6A4F]"
              />
              <button
                type="button"
                disabled={!customIsValid}
                onClick={() => customIsValid && void generate(customValue)}
                className="rounded-2xl bg-[#2D6A4F] px-4 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                Use time
              </button>
            </div>
          </div>
        ) : null}

        {stage.kind === 'working' ? (
          <div className="flex items-center gap-3 rounded-2xl bg-slate-50 p-4">
            <Loader2 className="h-5 w-5 animate-spin text-[#2D6A4F]" />
            <p className="text-sm font-bold text-slate-700">
              {stage.progress || 'Creating a short link…'}
            </p>
          </div>
        ) : null}

        {stage.kind === 'ready' ? (
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-xs font-black uppercase tracking-wider text-[#1B4332]">
                <Timer className="h-3.5 w-3.5" />
                {chosenMinutes ? `${chosenMinutes} min timer` : 'No time limit'}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-black uppercase tracking-wider text-slate-600">
                <Link2 className="h-3.5 w-3.5" />
                {stage.mode === 'course'
                  ? 'Course link'
                  : stage.mode === 'short-code'
                    ? 'Short link'
                    : 'Offline link'}
              </span>
            </div>

            {isCourse ? (
              <p className="mb-3 rounded-2xl bg-emerald-50 px-3 py-2 text-xs font-bold text-[#1B4332]">
                Whoever opens this link sees every topic in the course and picks
                which one to do. They can come back to the same link any time to
                take the others.
              </p>
            ) : null}

            {stage.offlineTopics?.length ? (
              <p className="mb-3 rounded-2xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
                {stage.offlineTopics.length} topic
                {stage.offlineTopics.length === 1 ? ' was' : 's were'} packed into the
                link itself because a short link could not be created:{' '}
                {stage.offlineTopics.join(', ')}.
              </p>
            ) : null}

            <input
              readOnly
              value={stage.url}
              aria-label="Quick quiz link"
              onFocus={(event) => event.currentTarget.select()}
              className="mb-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs font-bold text-slate-700 outline-none"
            />
            <p className="mb-4 text-xs font-bold text-slate-500">
              {stage.copied
                ? `Link copied — paste it anywhere to share this ${isCourse ? 'course' : 'quiz'}.`
                : 'Tap the link above to select it, then copy it with your keyboard.'}
            </p>

            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => void copyAgain()}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#2D6A4F] px-4 py-3 text-sm font-black text-white hover:bg-[#1B4332]"
              >
                {stage.copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {stage.copied ? 'Copied' : 'Copy link'}
              </button>
              {canUseWebShare() ? (
                <button
                  type="button"
                  onClick={() => void shareNow()}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-50"
                >
                  <Share2 className="h-4 w-4" /> Share…
                </button>
              ) : (
                <button
                  type="button"
                  onClick={close}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-50"
                >
                  Done
                </button>
              )}
            </div>
          </div>
        ) : null}

        {stage.kind === 'error' ? (
          <div>
            <div className="mb-4 flex items-start gap-3 rounded-2xl bg-amber-50 p-4">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
              <p className="text-sm font-bold text-amber-900">{stage.message}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => void generate(chosenMinutes)}
                className="rounded-2xl bg-[#2D6A4F] px-4 py-3 text-sm font-black text-white hover:bg-[#1B4332]"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={close}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  ) : null;

  return { startShare, startCourseShare, shareDialog };
}

export default useQuickQuizShare;

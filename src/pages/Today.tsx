/**
 * What Should I Study Today — local spaced revision.
 * No provider is consulted. The list is the learning engine reading this device.
 */
import React, { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import {
  AlertCircle,
  BookOpen,
  Calendar,
  CheckCircle2,
  Clock,
  GraduationCap,
  RotateCcw,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import type { LearningStatus } from '../types';
import {
  DEFAULT_INTERVALS,
  LEARNING_STATUSES,
  PRIORITY_LABEL,
  STATUS_LABEL,
  dailyPriorities,
  intervalsOf,
  topicProgress,
  type PriorityReason,
  type StudyPriority,
} from '../utils/learningEngine';

const REASONS: PriorityReason[] = ['overdue', 'weak', 'upcoming_exam', 'unfinished_plan', 'reinforce'];

const STATUS_CLASS: Record<LearningStatus, string> = {
  not_started: 'bg-gray-100 text-gray-600',
  learning: 'bg-blue-100 text-blue-700',
  reviewed: 'bg-amber-100 text-amber-800',
  mastered: 'bg-green-100 text-green-700',
  needs_revision: 'bg-red-100 text-red-700',
};

function when(iso?: string): string {
  if (!iso) return '—';
  try {
    return format(parseISO(iso), 'd MMM yyyy');
  } catch {
    return iso.slice(0, 10);
  }
}

const Today: React.FC = () => {
  const { state, dispatch } = useApp();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('topic') || '';
  const [intervals, setIntervalText] = useState(intervalsOf(state).join(', '));

  const priorities = useMemo(() => dailyPriorities(state), [state]);
  const selected = selectedId ? topicProgress(state, selectedId) : null;
  const topics = useMemo(
    () => state.topics
      .map((topic) => topicProgress(state, topic.id))
      .filter((view): view is NonNullable<typeof view> => !!view)
      .sort((a, b) => a.courseCode.localeCompare(b.courseCode) || a.topicName.localeCompare(b.topicName)),
    [state],
  );

  const saveIntervals = () => {
    const parsed = intervals.split(/[^0-9]+/).map((part) => parseInt(part, 10)).filter((n) => Number.isFinite(n));
    dispatch({ type: 'SET_LEARNING_INTERVALS', payload: parsed });
    setIntervalText(parsed.filter((n) => n >= 1 && n <= 365).slice(0, 8).join(', ') || DEFAULT_INTERVALS.join(', '));
  };

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="bg-gradient-to-r from-[#1B4332] to-[#2D6A4F] rounded-2xl p-6 text-white">
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#FFB703]">Learning engine</p>
        <h1 className="text-2xl font-bold mt-1">What Should I Study Today?</h1>
        <p className="text-sm text-white/80 mt-2 max-w-2xl">
          Overdue revision, weak topics, upcoming exams, unfinished plans, and topics you just learned.
          Stored on this device. No AI provider is required.
        </p>
      </div>

      <details className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
        <summary className="cursor-pointer text-sm font-bold text-gray-700">Revision intervals</summary>
        <p className="text-xs text-gray-500 mt-2">
          Days between reviews. Default is {DEFAULT_INTERVALS.join(', ')}. A new gap applies the next time a topic is reviewed.
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <input
            value={intervals}
            onChange={(e) => setIntervalText(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-56"
            aria-label="Revision intervals in days"
          />
          <button onClick={saveIntervals} className="px-3 py-2 bg-[#2D6A4F] text-white rounded-lg text-xs font-bold">Save</button>
          <button
            onClick={() => {
              dispatch({ type: 'SET_LEARNING_INTERVALS', payload: [...DEFAULT_INTERVALS] });
              setIntervalText(DEFAULT_INTERVALS.join(', '));
            }}
            className="px-3 py-2 border border-gray-200 rounded-lg text-xs font-bold text-gray-600"
          >
            Reset
          </button>
          <span className="text-[11px] text-gray-400">Active: {intervalsOf(state).join(' → ')} days</span>
        </div>
      </details>

      {priorities.length === 0 ? (
        <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-8 text-center">
          <CheckCircle2 className="w-10 h-10 text-[#2D6A4F] mx-auto mb-2" />
          <p className="font-bold text-gray-700">Nothing is due today.</p>
          <p className="text-sm text-gray-500 mt-1">Open a topic to start learning, or add an exam date and a study plan.</p>
        </div>
      ) : (
        REASONS.map((reason) => {
          const group = priorities.filter((item) => item.reason === reason).slice(0, 8);
          if (group.length === 0) return null;
          return (
            <section key={reason} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5" data-priority-reason={reason}>
              <h2 className="text-sm font-black uppercase tracking-widest text-gray-500 mb-3">{PRIORITY_LABEL[reason]}</h2>
              <div className="space-y-2">
                {group.map((item) => (
                  <PriorityRow key={item.id} item={item} />
                ))}
              </div>
            </section>
          );
        })
      )}

      <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <h2 className="text-sm font-black uppercase tracking-widest text-gray-500 mb-3">Topic progress</h2>
        {topics.length === 0 ? (
          <p className="text-sm text-gray-400">No topics yet. Add one from a course.</p>
        ) : (
          <div className="space-y-2">
            {topics.map((view) => (
              <button
                key={view.topicId}
                onClick={() => setParams(selectedId === view.topicId ? {} : { topic: view.topicId })}
                className={`w-full text-left p-3 rounded-xl border ${selectedId === view.topicId ? 'border-[#2D6A4F] bg-[#2D6A4F]/5' : 'border-gray-100 hover:bg-gray-50'}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm text-gray-800 truncate">{view.topicName}</span>
                  <span className={`text-[10px] font-black uppercase px-1.5 py-0.5 rounded ${STATUS_CLASS[view.status]}`}>{STATUS_LABEL[view.status]}</span>
                  {view.overdue && <span className="text-[10px] font-bold text-red-600">Due</span>}
                  <span className="ml-auto text-[11px] text-gray-400">{view.courseCode}</span>
                </div>
                <p className="text-[11px] text-gray-500 mt-1">
                  Accuracy {view.accuracy === null ? '—' : `${view.accuracy}%`} · {view.attempted} attempted · next {when(view.nextReviewAt)}
                </p>
              </button>
            ))}
          </div>
        )}
      </section>

      {selected && (
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4" data-testid="topic-progress">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">{selected.courseCode} · {selected.courseName}</p>
              <h2 className="text-lg font-bold text-gray-800">{selected.topicName}</h2>
            </div>
            <Link to={`/read/${selected.topicId}`} className="px-3 py-2 bg-[#2D6A4F] text-white rounded-lg text-xs font-bold shrink-0">Open topic</Link>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
            <Stat label="Learning status" value={STATUS_LABEL[selected.status]} />
            <Stat label="Quiz accuracy" value={selected.accuracy === null ? '—' : `${selected.accuracy}%`} />
            <Stat label="Questions attempted" value={String(selected.attempted)} />
            <Stat label="Missed questions" value={String(selected.missed)} />
            <Stat label="Last studied" value={when(selected.lastStudiedAt)} />
            <Stat label="Next review" value={when(selected.nextReviewAt)} />
          </div>

          <div className="flex flex-wrap gap-2 items-end">
            <label className="text-xs font-bold text-gray-500">
              Status
              <select
                value={selected.status}
                onChange={(e) => dispatch({ type: 'SET_TOPIC_STATUS', payload: { topicId: selected.topicId, status: e.target.value as LearningStatus } })}
                className="block mt-1 px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
              >
                {LEARNING_STATUSES.map((status) => (
                  <option key={status} value={status}>{STATUS_LABEL[status]}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-bold text-gray-500">
              Confidence
              <select
                value={selected.confidence}
                onChange={(e) => dispatch({ type: 'SET_TOPIC_CONFIDENCE', payload: { topicId: selected.topicId, confidence: Number(e.target.value) } })}
                className="block mt-1 px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
              >
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-gray-500">
              Importance
              <select
                value={selected.importance}
                onChange={(e) => dispatch({ type: 'SET_TOPIC_IMPORTANCE', payload: { topicId: selected.topicId, importance: Number(e.target.value) } })}
                className="block mt-1 px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
              >
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button
              onClick={() => dispatch({ type: 'MARK_TOPIC_REVIEWED', payload: { topicId: selected.topicId } })}
              className="px-3 py-2 bg-[#FFB703] text-[#1B4332] rounded-lg text-xs font-bold"
            >
              Mark reviewed
            </button>
          </div>

          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-2">Revision history</h3>
            {selected.history.length === 0 ? (
              <p className="text-sm text-gray-400">No revisions yet.</p>
            ) : (
              <ol className="space-y-1.5">
                {selected.history.slice(0, 12).map((event) => (
                  <li key={event.id} className="flex items-center gap-2 text-sm bg-gray-50 rounded-lg px-3 py-2">
                    <Clock className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    <span className="text-gray-500 text-xs">{when(event.at)}</span>
                    <span className="text-gray-700">{event.note || event.kind}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      )}
    </div>
  );
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded-xl px-3 py-2">
      <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">{label}</p>
      <p className="font-bold text-gray-800">{value}</p>
    </div>
  );
}

function PriorityRow({ item }: { item: StudyPriority }) {
  const icon = item.reason === 'overdue' ? AlertCircle
    : item.reason === 'upcoming_exam' ? Calendar
    : item.reason === 'unfinished_plan' ? Clock
    : item.reason === 'reinforce' ? RotateCcw
    : BookOpen;
  const Icon = icon;
  return (
    <Link to={item.href} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:border-[#2D6A4F] hover:bg-[#2D6A4F]/5">
      <Icon className="w-4 h-4 text-[#2D6A4F] shrink-0" />
      <div className="min-w-0">
        <p className="font-bold text-sm text-gray-800 truncate">{item.title}</p>
        <p className="text-[11px] text-gray-500 truncate">{item.detail}</p>
      </div>
      <GraduationCap className="w-4 h-4 text-gray-300 ml-auto shrink-0" />
    </Link>
  );
}

export default Today;

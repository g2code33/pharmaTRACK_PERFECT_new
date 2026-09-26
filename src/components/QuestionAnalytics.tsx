import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import type { PerformanceBucket, QuestionBankAnalytics } from '../utils/questionBank';

type Tab = 'course' | 'topic' | 'difficulty' | 'type' | 'semester';

const TABS: { id: Tab; label: string }[] = [
  { id: 'course', label: 'Course' },
  { id: 'topic', label: 'Topic' },
  { id: 'difficulty', label: 'Difficulty' },
  { id: 'type', label: 'Question type' },
  { id: 'semester', label: 'Semester' },
];

function pct(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

function tone(value: number | null): string {
  if (value === null) return 'text-slate-400';
  if (value < 70) return 'text-red-600';
  if (value < 85) return 'text-amber-600';
  return 'text-emerald-700';
}

function Row({ row, indent = false }: { row: PerformanceBucket; indent?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 py-1.5 ${indent ? 'pl-4' : ''}`}>
      <span className={`truncate ${indent ? 'text-sm text-slate-600' : 'font-semibold text-slate-800'}`}>{row.label}</span>
      <span className="flex items-center gap-2 shrink-0">
        {row.improvement !== null && row.improvement !== 0 && (
          <span className={`text-xs font-bold ${row.improvement > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
            {row.improvement > 0 ? `+${row.improvement}` : row.improvement}
          </span>
        )}
        <span className={`font-black tabular-nums ${tone(row.accuracy)}`}>{pct(row.accuracy)}</span>
      </span>
    </div>
  );
}

const QuestionAnalytics: React.FC<{ analytics: QuestionBankAnalytics }> = ({ analytics }) => {
  const [tab, setTab] = useState<Tab>('course');
  const empty = analytics.totals.attempts === 0;

  return (
    <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5" data-testid="question-analytics">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-black text-slate-800">Question performance</h2>
          <p className="text-sm text-slate-500">
            {empty
              ? 'Take a quiz to see accuracy by course, topic, difficulty, type, and semester.'
              : `${analytics.totals.attempts} attempts · ${pct(analytics.totals.accuracy)} accuracy · ${analytics.totals.incorrect} incorrect`}
          </p>
        </div>
        <Link to="/quiz?mode=weak" className="text-xs font-bold text-[#2D6A4F] hover:underline">Weak-topic quiz</Link>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold ${tab === item.id ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {empty ? (
        <p className="text-sm text-slate-400">No attempts yet.</p>
      ) : tab === 'course' ? (
        <div className="space-y-4">
          {analytics.byCourse.map((course) => (
            <div key={course.id}>
              <Row row={course} />
              {course.topics.map((topic) => <Row key={topic.id} row={topic} indent />)}
            </div>
          ))}
        </div>
      ) : (
        <div>
          {(tab === 'topic' ? analytics.byTopic : tab === 'difficulty' ? analytics.byDifficulty : tab === 'type' ? analytics.byType : analytics.bySemester)
            .map((row) => <Row key={row.id} row={row} />)}
        </div>
      )}

      {analytics.weakAreas.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <p className="text-xs font-black uppercase tracking-widest text-red-500 mb-2">Weak areas</p>
          <div className="flex flex-wrap gap-2">
            {analytics.weakAreas.map((area) => (
              <Link key={area.id} to={`/learn?topic=${area.id}`} className="px-3 py-1 rounded-lg bg-red-50 text-red-700 text-sm font-semibold">
                {area.label} {pct(area.accuracy)}
              </Link>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};

export default QuestionAnalytics;

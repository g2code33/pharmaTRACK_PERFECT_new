/**
 * Clinical Learning — fictional study cases. No provider is called.
 * The page will not answer a request to treat a real person.
 */
import React, { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ChevronLeft, Plus, ShieldAlert } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useApp } from '../context/AppContext';
import type { ClinicalCase, ClinicalQuestion, ClinicalStepId, Course, Topic } from '../types';
import {
  CLINICAL_STEPS,
  EDUCATIONAL_DISCLAIMER,
  NOT_A_PRESCRIPTION,
  PHARMACY_TOPICS,
  PRACTICE_DOSE_NOTE,
  attemptsFor,
  caseById,
  caseIsStudyMaterial,
  clinicalContext,
  createCase,
  duplicateCase,
  formatClinicalContext,
  gradeDose,
  isBuiltinCase,
  orderedPharmacy,
  orderedSteps,
  parseLines,
  parseMedicines,
  pharmacyMeta,
  reviewAnswer,
  stepMeta,
  visibleCases,
  type AnswerReview,
} from '../utils/clinicalLearning';

function SafetyBanner({ extra }: { extra?: string }) {
  return (
    <div role="note" className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
      <div className="flex items-start gap-3">
        <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em]">Educational information</p>
          <p className="text-sm mt-1">{EDUCATIONAL_DISCLAIMER}</p>
          <p className="text-sm mt-1 font-semibold">{NOT_A_PRESCRIPTION}</p>
          {extra && <p className="text-sm mt-2">{extra}</p>}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

const inputClass = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 outline-none focus:ring-2 focus:ring-[#2D6A4F]';

function CaseForm({
  initial,
  courses,
  topics,
  onCancel,
  onSave,
}: {
  initial?: ClinicalCase;
  courses: Course[];
  topics: Topic[];
  onCancel: () => void;
  onSave: (item: ClinicalCase) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [presentation, setPresentation] = useState(initial?.presentation ?? '');
  const [symptoms, setSymptoms] = useState(initial?.symptoms ?? '');
  const [history, setHistory] = useState(initial?.history ?? '');
  const [findings, setFindings] = useState(initial?.findings ?? '');
  const [labs, setLabs] = useState(initial?.labs ?? '');
  const [medicines, setMedicines] = useState(
    (initial?.medicines ?? []).map((item) => item.detail ? `${item.name} — ${item.detail}` : item.name).join('\n'),
  );
  const [problems, setProblems] = useState((initial?.problems ?? []).join('\n'));
  const [courseId, setCourseId] = useState(initial?.courseId ?? '');
  const [topicId, setTopicId] = useState(initial?.topicId ?? '');
  const [steps, setSteps] = useState<Record<string, string>>(() => {
    const next: Record<string, string> = {};
    for (const entry of orderedSteps(initial?.steps)) next[entry.id] = entry.explanation;
    return next;
  });
  const [pharmacy, setPharmacy] = useState<Record<string, string>>(() => {
    const next: Record<string, string> = {};
    for (const entry of orderedPharmacy(initial?.pharmacy)) next[entry.id] = entry.text;
    return next;
  });
  const [questionPrompt, setQuestionPrompt] = useState(initial?.questions[0]?.prompt ?? '');
  const [questionKey, setQuestionKey] = useState(initial?.questions[0]?.answerKey ?? '');
  const [questionAnswer, setQuestionAnswer] = useState(initial?.questions[0]?.modelAnswer ?? '');
  const [error, setError] = useState('');

  const topicOptions = topics.filter((topic) => !courseId || topic.courseId === courseId);

  const save = () => {
    const extraQuestions = (initial?.questions ?? []).slice(1);
    const questions: ClinicalQuestion[] = [];
    if (questionPrompt.trim()) {
      questions.push({
        id: initial?.questions[0]?.id || uuidv4(),
        prompt: questionPrompt,
        answerKey: questionKey,
        modelAnswer: questionAnswer || 'Add a model answer for this fictional case. It is not advice for a real person.',
      });
    }
    questions.push(...extraQuestions);
    const draft = createCase({
      id: initial?.id || uuidv4(),
      title,
      presentation,
      symptoms,
      history,
      findings,
      labs,
      medicines: parseMedicines(medicines),
      problems: parseLines(problems),
      courseId: courseId || undefined,
      topicId: topicId || undefined,
      semester: courses.find((course) => course.id === courseId)?.semester,
      steps: CLINICAL_STEPS.map((meta) => ({ id: meta.id, explanation: steps[meta.id] ?? '' })),
      pharmacy: PHARMACY_TOPICS.map((meta) => ({ id: meta.id, text: pharmacy[meta.id] ?? '' })),
      questions,
      doseExercise: initial?.doseExercise,
      safetyNote: initial?.safetyNote,
      createdAt: initial?.createdAt,
    });
    if (!caseIsStudyMaterial(draft)) {
      setError(`${NOT_A_PRESCRIPTION} Rewrite the case as a fictional study note before saving. This form will not store a request to treat a real person.`);
      return;
    }
    setError('');
    onSave(draft);
  };

  return (
    <form
      className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6 space-y-4"
      onSubmit={(event) => { event.preventDefault(); save(); }}
    >
      <div>
        <h2 className="text-lg font-black text-gray-900">{initial ? 'Edit study case' : 'Add a study case'}</h2>
        <p className="text-sm text-gray-500 mt-1">Manual cases are stored on this device. A generator is not required.</p>
      </div>
      {error && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 text-red-800 text-sm p-3">{error}</p>
      )}
      <Field label="Title">
        <input value={title} onChange={(event) => setTitle(event.target.value)} className={inputClass} required />
      </Field>
      <Field label="Patient presentation">
        <textarea value={presentation} onChange={(event) => setPresentation(event.target.value)} rows={3} className={inputClass} required placeholder="Fictional person, setting, and what they ask." />
      </Field>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Course">
          <select value={courseId} onChange={(event) => { setCourseId(event.target.value); setTopicId(''); }} className={inputClass}>
            <option value="">None</option>
            {courses.map((course) => <option key={course.id} value={course.id}>{course.courseCode} — {course.courseName}</option>)}
          </select>
        </Field>
        <Field label="Topic">
          <select value={topicId} onChange={(event) => setTopicId(event.target.value)} className={inputClass}>
            <option value="">None</option>
            {topicOptions.map((topic) => <option key={topic.id} value={topic.id}>{topic.topicName}</option>)}
          </select>
        </Field>
      </div>
      <details className="rounded-xl border border-gray-200 p-3">
        <summary className="text-sm font-bold cursor-pointer">Case structure</summary>
        <div className="grid sm:grid-cols-2 gap-3 mt-3">
          <Field label="Symptoms"><textarea value={symptoms} onChange={(event) => setSymptoms(event.target.value)} rows={2} className={inputClass} /></Field>
          <Field label="History"><textarea value={history} onChange={(event) => setHistory(event.target.value)} rows={2} className={inputClass} /></Field>
          <Field label="Relevant findings"><textarea value={findings} onChange={(event) => setFindings(event.target.value)} rows={2} className={inputClass} /></Field>
          <Field label="Laboratory information"><textarea value={labs} onChange={(event) => setLabs(event.target.value)} rows={2} className={inputClass} /></Field>
          <Field label="Current medicines — one per line">
            <textarea value={medicines} onChange={(event) => setMedicines(event.target.value)} rows={3} className={inputClass} placeholder="Ibuprofen — 400 mg in the scenario" />
          </Field>
          <Field label="Potential problems — one per line">
            <textarea value={problems} onChange={(event) => setProblems(event.target.value)} rows={3} className={inputClass} />
          </Field>
        </div>
      </details>
      <details className="rounded-xl border border-gray-200 p-3">
        <summary className="text-sm font-bold cursor-pointer">Learning flow — What, Where, Why, How</summary>
        <div className="space-y-3 mt-3">
          {CLINICAL_STEPS.map((meta) => (
            <Field key={meta.id} label={`${meta.label} — ${meta.prompt}`}>
              <textarea value={steps[meta.id] ?? ''} onChange={(event) => setSteps((prev) => ({ ...prev, [meta.id]: event.target.value }))} rows={2} className={inputClass} />
            </Field>
          ))}
        </div>
      </details>
      <details className="rounded-xl border border-gray-200 p-3">
        <summary className="text-sm font-bold cursor-pointer">Pharmacy study notes</summary>
        <div className="space-y-3 mt-3">
          {PHARMACY_TOPICS.map((meta) => (
            <Field key={meta.id} label={meta.label}>
              <textarea value={pharmacy[meta.id] ?? ''} onChange={(event) => setPharmacy((prev) => ({ ...prev, [meta.id]: event.target.value }))} rows={2} className={inputClass} placeholder={meta.prompt} />
            </Field>
          ))}
        </div>
      </details>
      <details className="rounded-xl border border-gray-200 p-3" open={!initial}>
        <summary className="text-sm font-bold cursor-pointer">Practice question</summary>
        <div className="space-y-3 mt-3">
          <Field label="Question">
            <textarea value={questionPrompt} onChange={(event) => setQuestionPrompt(event.target.value)} rows={2} className={inputClass} />
          </Field>
          <Field label="Study key — optional, used for offline review">
            <input value={questionKey} onChange={(event) => setQuestionKey(event.target.value)} className={inputClass} placeholder="epigastric|upper abdomen" />
          </Field>
          <Field label="Model answer — fictional case only">
            <textarea value={questionAnswer} onChange={(event) => setQuestionAnswer(event.target.value)} rows={3} className={inputClass} />
          </Field>
        </div>
      </details>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="px-4 py-2 rounded-xl bg-[#1B4332] text-white text-sm font-bold">Save study case</button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-bold">Cancel</button>
      </div>
    </form>
  );
}

function PracticeCard({
  question,
  onSave,
}: {
  question: ClinicalQuestion;
  onSave: (review: AnswerReview & { answer: string; questionId: string }) => void;
}) {
  const [answer, setAnswer] = useState('');
  const [review, setReview] = useState<AnswerReview | null>(null);

  const submit = () => {
    const next = reviewAnswer(question, answer);
    setReview(next);
    onSave({ ...next, answer, questionId: question.id });
  };

  return (
    <div className="rounded-xl border border-gray-200 p-4 space-y-3">
      <p className="text-sm font-semibold text-gray-900">{question.prompt}</p>
      <textarea
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        rows={3}
        className={inputClass}
        aria-label={`Answer: ${question.prompt}`}
        placeholder="Your study note. Do not ask this box to treat a real person."
      />
      <button type="button" onClick={submit} className="px-3 py-2 rounded-lg bg-[#1B4332] text-white text-xs font-bold">
        Review answer
      </button>
      {review && (
        <div className={`rounded-xl p-3 text-sm ${review.refused ? 'bg-red-50 text-red-900 border border-red-200' : 'bg-gray-50 text-gray-800'}`}>
          <p className="font-semibold">
            {review.refused ? 'Not answered' : review.matched === true ? 'Study key found' : review.matched === false ? 'Study key not found' : 'Compare with the model answer'}
          </p>
          <p className="mt-1">{review.feedback}</p>
          {review.showModelAnswer && (
            <p className="mt-2">{question.modelAnswer}</p>
          )}
        </div>
      )}
    </div>
  );
}

function CaseReader({
  item,
  courseName,
  topicName,
  attemptCount,
  onBack,
  onEdit,
  onDuplicate,
  onDelete,
  onAttempt,
}: {
  item: ClinicalCase;
  courseName?: string;
  topicName?: string;
  attemptCount: number;
  onBack: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAttempt: (payload: { questionId: string; answer: string; matched: boolean | null; refused: boolean }) => void;
}) {
  const [stepId, setStepId] = useState<ClinicalStepId>('what');
  const [doseInput, setDoseInput] = useState('');
  const [doseResult, setDoseResult] = useState<ReturnType<typeof gradeDose> | null>(null);
  const [copied, setCopied] = useState(false);
  const builtin = isBuiltinCase(item.id);
  const step = orderedSteps(item.steps).find((entry) => entry.id === stepId) ?? orderedSteps(item.steps)[0];
  const meta = stepMeta(step.id);
  const context = useMemo(() => clinicalContext(item, { step: stepId }), [item, stepId]);

  const copySources = async () => {
    const text = formatClinicalContext(context);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-5">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-sm font-bold text-[#2D6A4F]">
        <ChevronLeft className="w-4 h-4" /> All study cases
      </button>
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6 space-y-3">
        <div className="flex flex-wrap gap-2">
          <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded bg-amber-100 text-amber-800">Fictional</span>
          <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded bg-gray-100 text-gray-500">{builtin ? 'Study library' : 'My case'}</span>
          {courseName && <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{courseName}</span>}
          {topicName && <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{topicName}</span>}
        </div>
        <h2 className="text-xl sm:text-2xl font-black text-gray-900">{item.title}</h2>
        {item.safetyNote && <p className="text-sm text-amber-900">{item.safetyNote}</p>}
        <div className="flex flex-wrap gap-2">
          {builtin ? (
            <button type="button" onClick={onDuplicate} className="px-3 py-2 rounded-lg border border-gray-200 text-xs font-bold">Duplicate into my cases</button>
          ) : (
            <>
              <button type="button" onClick={onEdit} className="px-3 py-2 rounded-lg border border-gray-200 text-xs font-bold">Edit</button>
              <button type="button" onClick={onDelete} className="px-3 py-2 rounded-lg border border-red-200 text-red-700 text-xs font-bold">Delete</button>
            </>
          )}
        </div>
      </div>

      <section id="case-structure" className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6 space-y-4">
        <h3 className="text-sm font-black uppercase tracking-widest text-[#2D6A4F]">Case</h3>
        <dl className="grid sm:grid-cols-2 gap-4">
          {[
            ['Patient presentation', item.presentation],
            ['Symptoms', item.symptoms],
            ['History', item.history],
            ['Relevant findings', item.findings],
            ['Laboratory information', item.labs],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[10px] font-black uppercase tracking-widest text-gray-400">{label}</dt>
              <dd className="text-sm text-gray-800 mt-1">{value || 'Not filled in.'}</dd>
            </div>
          ))}
        </dl>
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Current medicines</p>
          {item.medicines.length === 0 ? <p className="text-sm text-gray-500 mt-1">None listed.</p> : (
            <ul className="mt-2 flex flex-wrap gap-2">
              {item.medicines.map((medicine) => (
                <li key={`${medicine.name}-${medicine.detail ?? ''}`} className="px-3 py-1 rounded-full bg-gray-100 text-sm">
                  {medicine.name}{medicine.detail ? ` — ${medicine.detail}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Potential problems</p>
          <ul className="mt-2 space-y-1">
            {(item.problems.length ? item.problems : ['None listed.']).map((problem) => (
              <li key={problem} className="text-sm text-gray-800">• {problem}</li>
            ))}
          </ul>
        </div>
      </section>

      <section id="learning-flow" className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6 space-y-3">
        <h3 className="text-sm font-black uppercase tracking-widest text-[#2D6A4F]">Learning flow</h3>
        <p className="text-sm text-gray-500">What, where, why, how, then what should be assessed, therapeutic considerations, monitoring, and counseling.</p>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {CLINICAL_STEPS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setStepId(entry.id)}
              className={`shrink-0 px-3 py-2 rounded-full text-xs font-bold ${stepId === entry.id ? 'bg-[#1B4332] text-white' : 'bg-gray-50 border border-gray-200 text-gray-600'}`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="rounded-xl bg-[#1B4332]/5 p-4">
          <p className="text-xs font-black uppercase tracking-widest text-[#2D6A4F]">{meta.label}</p>
          <p className="text-sm font-semibold text-gray-900 mt-1">{meta.prompt}</p>
          <p className="text-sm text-gray-700 mt-2">{step.explanation || 'No study note yet. Duplicate the case or edit your own to add one.'}</p>
        </div>
      </section>

      <section id="pharmacy" className="space-y-2">
        <h3 className="text-sm font-black uppercase tracking-widest text-[#2D6A4F] px-1">Pharmacy</h3>
        {orderedPharmacy(item.pharmacy).map((entry) => {
          const topic = pharmacyMeta(entry.id);
          return (
            <details key={entry.id} className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <summary className="text-sm font-semibold cursor-pointer">{topic.label}</summary>
              <p className="text-xs text-gray-400 mt-2">{topic.prompt}</p>
              <p className="text-sm text-gray-700 mt-1">{entry.text || 'No study note yet.'}</p>
            </details>
          );
        })}
      </section>

      <section id="practice" className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6 space-y-4">
        <div className="flex items-end justify-between gap-3">
          <h3 className="text-sm font-black uppercase tracking-widest text-[#2D6A4F]">Case practice</h3>
          <p className="text-xs text-gray-400">{attemptCount} review{attemptCount === 1 ? '' : 's'} on this device</p>
        </div>
        <p className="text-sm text-gray-500">Answer the study question, then compare it with the model answer. The review stays on this device.</p>
        {item.questions.length === 0 && <p className="text-sm text-gray-500">No practice question yet. Edit the case to add one. A generator is not required.</p>}
        {item.questions.map((question) => (
          <PracticeCard
            key={question.id}
            question={question}
            onSave={(review) => onAttempt({
              questionId: review.questionId,
              answer: review.answer,
              matched: review.matched,
              refused: review.refused,
            })}
          />
        ))}
        {item.doseExercise && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 space-y-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-amber-800">Dose calculation — worksheet only</p>
            <p className="text-sm text-gray-800">{item.doseExercise.prompt}</p>
            <p className="text-xs text-amber-900">{PRACTICE_DOSE_NOTE}</p>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                value={doseInput}
                onChange={(event) => setDoseInput(event.target.value)}
                inputMode="decimal"
                aria-label="Your count for the practice problem"
                placeholder="Worksheet count"
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => setDoseResult(gradeDose(item.doseExercise!, doseInput))}
                className="px-3 py-2 rounded-lg bg-[#1B4332] text-white text-xs font-bold shrink-0"
              >
                Check the practice count
              </button>
            </div>
            {doseResult && (
              <div className="text-sm text-gray-800 space-y-1">
                <p className="font-semibold">{doseResult.ok ? 'The worksheet count matches.' : 'The worksheet count does not match.'}</p>
                <p>Study total: {doseResult.expected} {doseResult.unit}.</p>
                <p>{doseResult.working}</p>
                <p className="font-semibold">{doseResult.note}</p>
              </div>
            )}
          </div>
        )}
      </section>

      <section id="sources" className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6 space-y-3">
        <h3 className="text-sm font-black uppercase tracking-widest text-[#2D6A4F]">Sources for a future tutor</h3>
        <p className="text-sm text-gray-600">
          No provider is called from this page. A future tutor may explain this case only from the labelled blocks below, and must name those sources. It must not turn the case into advice for a real person.
        </p>
        <ul className="space-y-2">
          {context.sources.map((source) => (
            <li key={source.label} className="text-sm">
              <span className="font-semibold text-gray-900">{source.label}</span>
              <span className="text-gray-400"> · {source.kind} · {source.materialId}</span>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => void copySources()} className="px-3 py-2 rounded-lg border border-gray-200 text-xs font-bold">
          {copied ? 'Copied labelled sources' : 'Copy labelled sources'}
        </button>
      </section>
    </div>
  );
}

const Clinical: React.FC = () => {
  const { state, dispatch } = useApp();
  const [params, setParams] = useSearchParams();
  const caseId = params.get('case') || '';
  const item = caseId ? caseById(state, caseId) : undefined;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const cases = useMemo(() => visibleCases(state), [state]);
  const library = cases.filter((entry) => entry.origin === 'builtin');
  const mine = cases.filter((entry) => entry.origin !== 'builtin');

  const open = (id: string) => {
    setAdding(false);
    setEditing(false);
    setParams({ case: id });
  };

  const save = (next: ClinicalCase) => {
    if (!caseIsStudyMaterial(next)) return;
    if (state.clinicalCases?.some((entry) => entry.id === next.id)) {
      dispatch({ type: 'UPDATE_CLINICAL_CASE', payload: { id: next.id, updates: next } });
    } else {
      dispatch({ type: 'ADD_CLINICAL_CASE', payload: next });
    }
    open(next.id);
  };

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="bg-gradient-to-r from-[#1B4332] to-[#2D6A4F] rounded-2xl p-6 text-white">
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#FFB703]">Clinical learning</p>
        <h1 className="text-2xl font-bold mt-1">Study cases</h1>
        <p className="text-sm text-white/80 mt-2 max-w-2xl">
          Work a fictional case from what and where, through why and how, to assessment, therapeutic considerations, monitoring, and counseling. Stored on this device. No AI provider is required.
        </p>
      </div>
      <SafetyBanner />

      {caseId && !item && (
        <div className="bg-white rounded-2xl border border-gray-100 p-6">
          <p className="font-semibold">That study case is not on this device.</p>
          <button type="button" onClick={() => setParams({})} className="mt-3 text-sm font-bold text-[#2D6A4F]">Back to cases</button>
        </div>
      )}

      {item && !editing && (
        <CaseReader
          item={item}
          courseName={state.courses.find((course) => course.id === item.courseId)?.courseCode}
          topicName={state.topics.find((topic) => topic.id === item.topicId)?.topicName}
          attemptCount={attemptsFor(state, item.id).length}
          onBack={() => setParams({})}
          onEdit={() => setEditing(true)}
          onDuplicate={() => save(duplicateCase(item))}
          onDelete={() => {
            if (!window.confirm('Delete this study case from this device?')) return;
            dispatch({ type: 'DELETE_CLINICAL_CASE', payload: item.id });
            setParams({});
          }}
          onAttempt={(payload) => dispatch({
            type: 'ADD_CLINICAL_ATTEMPT',
            payload: { id: uuidv4(), caseId: item.id, at: new Date().toISOString(), ...payload },
          })}
        />
      )}

      {(!item || editing) && (
        <>
          {!editing && (
            <>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-black">Study library</h2>
                <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-[#1B4332] text-white text-sm font-bold">
                  <Plus className="w-4 h-4" /> Add a study case
                </button>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                {library.map((entry) => (
                  <article key={entry.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex flex-col gap-3">
                    <div className="flex gap-2">
                      <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded bg-amber-100 text-amber-800">Fictional</span>
                      <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded bg-gray-100 text-gray-500">Built-in</span>
                    </div>
                    <h3 className="font-bold text-gray-900">{entry.title}</h3>
                    <p className="text-sm text-gray-600 line-clamp-3">{entry.presentation}</p>
                    <button type="button" onClick={() => open(entry.id)} aria-label={`Open ${entry.title}`} className="mt-auto self-start px-3 py-2 rounded-lg bg-[#1B4332] text-white text-xs font-bold">
                      Open
                    </button>
                  </article>
                ))}
              </div>
              <div className="flex items-center gap-2 text-amber-800">
                <AlertTriangle className="w-4 h-4" />
                <p className="text-sm">Built-in cases are fictional. Add your own if you want different facts. Do not enter a real person.</p>
              </div>
              {mine.length > 0 && (
                <>
                  <h2 className="text-lg font-black">My study cases</h2>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {mine.map((entry) => (
                      <article key={entry.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-2">
                        <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded bg-amber-100 text-amber-800">Fictional</span>
                        <h3 className="font-bold text-gray-900">{entry.title}</h3>
                        <p className="text-sm text-gray-600 line-clamp-3">{entry.presentation}</p>
                        <button type="button" onClick={() => open(entry.id)} aria-label={`Open ${entry.title}`} className="px-3 py-2 rounded-lg border border-gray-200 text-xs font-bold">
                          Open
                        </button>
                      </article>
                    ))}
                  </div>
                </>
              )}
              <p className="text-xs text-gray-400">
                Looking for a case later? Academic search can open it. <Link to="/search" className="font-bold text-[#2D6A4F]">Search</Link>
              </p>
            </>
          )}
          {(adding || editing) && (
            <CaseForm
              initial={editing ? item : undefined}
              courses={state.courses}
              topics={state.topics}
              onCancel={() => { setAdding(false); setEditing(false); }}
              onSave={save}
            />
          )}
        </>
      )}
    </div>
  );
};

export default Clinical;

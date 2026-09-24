import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Download,
  FileText,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import type { AssessmentType, ExamBuilderDraft, ExamSecuritySettings } from '../examination/types';
import {
  defaultExamBuilderDraft,
  ExaminationRepository,
  questionPoolForBuilder,
} from '../examination/service';
import { parseExamQuestionJson, reorderQuestionIds } from '../examination/builder';
import { createPharmaExamPackage, generateExamSigningKeyPair } from '../examination/package';

const levels = ['Level 100', 'Level 200', 'Level 300', 'Level 400', 'Level 500', 'Level 600'];
const violationTypes = [
  'FOCUS_LOST',
  'ATTEMPTED_EXIT',
  'ATTEMPTED_NAVIGATION',
  'ATTEMPTED_PRINT',
  'ATTEMPTED_COPY_PASTE',
  'EXTERNAL_LINK_ATTEMPT',
  'DEVELOPER_TOOL_ATTEMPT',
  'NETWORK_LOSS',
  'DEVICE_DISCONNECT',
  'SERVER_DISCONNECT',
] as const;

const ExaminationBuilder: React.FC = () => {
  const { state, dispatch } = useApp();
  const [draft, setDraft] = useState<ExamBuilderDraft>(defaultExamBuilderDraft());
  const [courseId, setCourseId] = useState('');
  const [topicId, setTopicId] = useState('');
  const [difficulty, setDifficulty] = useState('all');
  const [jsonInput, setJsonInput] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const topics = state.topics.filter((topic) => topic.courseId === courseId);
  const pool = useMemo(
    () =>
      questionPoolForBuilder(
        state.examQuestions,
        courseId || undefined,
        topicId || undefined,
        difficulty,
      ),
    [state.examQuestions, courseId, topicId, difficulty],
  );
  const selected = draft.questionIds
    .map((id) => state.examQuestions.find((question) => question.id === id))
    .filter(Boolean);

  const updateDraft = (updates: Partial<ExamBuilderDraft>) =>
    setDraft((current) => ({ ...current, ...updates }));
  const selectQuestion = (id: string) =>
    updateDraft({
      questionIds: draft.questionIds.includes(id)
        ? draft.questionIds.filter((item) => item !== id)
        : [...draft.questionIds, id],
    });
  const move = (index: number, direction: -1 | 1) =>
    updateDraft({ questionIds: reorderQuestionIds(draft.questionIds, index, index + direction) });

  const importQuestions = () => {
    if (!courseId || !topicId) {
      setImportMessage('Choose a course and topic before importing questions.');
      return;
    }
    const result = parseExamQuestionJson(
      jsonInput,
      courseId,
      topicId,
      state.courses.find((course) => course.id === courseId)?.semester,
    );
    if (result.valid.length) {
      dispatch({ type: 'ADD_EXAM_QUESTIONS', payload: result.valid });
      updateDraft({
        questionIds: [...draft.questionIds, ...result.valid.map((question) => question.id)],
      });
    }
    setImportMessage(
      `${result.valid.length} valid question(s) imported.${result.errors.length ? ` ${result.errors.join(' ')}` : ''}`,
    );
  };

  const generatePackage = async () => {
    if (!draft.title.trim()) return setStatus('Enter an examination title.');
    if (!draft.questionIds.length) return setStatus('Select at least one question.');
    setBusy(true);
    setStatus('Validating questions and creating an immutable version…');
    try {
      const repository = await ExaminationRepository.open();
      const exam = await repository.createExam(draft.title);
      const questions = draft.questionIds
        .map((id) => state.examQuestions.find((question) => question.id === id))
        .filter((question): question is (typeof state.examQuestions)[number] => Boolean(question));
      const version = await repository.createVersion(exam.id, questions, {
        title: draft.title,
        assessmentType: draft.assessmentType,
        courseId: draft.courseId,
        topicId: draft.topicId,
        academicYear: draft.academicYear,
        semester: draft.semester,
        instructions: draft.instructions,
        scoring: draft.scoring,
        availability: draft.availability,
        security: draft.security,
        navigation: draft.navigation,
        maxAttempts: draft.maxAttempts,
        marksByQuestion: draft.marksByQuestion,
      });
      const validation = await repository.validateVersion(exam.id, version.id);
      if (!validation.ok) throw new Error(validation.errors.join(' '));
      const published = await repository.publishVersion(exam.id, version.id);
      let examPassword: string | undefined;
      if (draft.security.requireExamPassword) {
        examPassword =
          window.prompt('Set the examination password. It will not be stored in plaintext.') ||
          undefined;
        if (!examPassword)
          throw new Error('An examination password is required by the selected security policy.');
      }
      const packaged = await createPharmaExamPackage({
        version: published,
        signingKey: await generateExamSigningKeyPair(),
        institution: { name: state.student?.university || 'Local institution', code: 'LOCAL' },
        examPassword,
      });
      const url = URL.createObjectURL(packaged.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = packaged.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus(
        `Published Version ${published.version} and downloaded ${packaged.filename}. Published versions are immutable.`,
      );
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : 'The examination package could not be generated.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <header className="rounded-2xl bg-gradient-to-r from-[#0F172A] to-[#1B4332] text-white p-6 shadow-lg">
        <div className="flex flex-wrap gap-4 items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest font-black text-emerald-300">
              Secure Examination Network
            </p>
            <h1 className="text-3xl font-black mt-1">Formal Examination Builder</h1>
            <p className="text-white/75 mt-2 max-w-2xl">
              Build from the existing Question Bank. Published versions are signed, immutable, and
              never change an existing practice Quiz.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              to="/quiz"
              className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 font-bold text-sm"
            >
              Back to Quiz
            </Link>
            <Link
              to="/examinations/kiosk"
              className="px-4 py-2 rounded-lg bg-emerald-400 text-slate-950 font-black text-sm"
            >
              Open Kiosk
            </Link>
            <Link
              to="/examinations/admin"
              className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 font-bold text-sm"
            >
              Live Admin
            </Link>
          </div>
        </div>
      </header>

      <div className="grid xl:grid-cols-[1fr_1.2fr] gap-6">
        <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-5">
          <div className="flex items-center gap-2">
            <FileText className="text-[#2D6A4F]" />
            <h2 className="text-xl font-black text-slate-800">Exam settings</h2>
          </div>
          <label className="block text-sm font-bold text-slate-700">
            Title
            <input
              value={draft.title}
              onChange={(event) => updateDraft({ title: event.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              placeholder="PHAR 401 Final Examination"
            />
          </label>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block text-sm font-bold text-slate-700">
              Assessment type
              <select
                value={draft.assessmentType}
                onChange={(event) =>
                  updateDraft({ assessmentType: event.target.value as AssessmentType })
                }
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="NORMAL_ASSESSMENT">Normal assessment</option>
                <option value="FORMAL_EXAM">Formal examination</option>
                <option value="KIOSK_EXAM">Kiosk examination</option>
              </select>
            </label>
            <label className="block text-sm font-bold text-slate-700">
              Maximum attempts
              <input
                type="number"
                min="1"
                value={draft.maxAttempts}
                onChange={(event) =>
                  updateDraft({ maxAttempts: Math.max(1, Number(event.target.value)) })
                }
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block text-sm font-bold text-slate-700">
              Academic year
              <input
                value={draft.academicYear || ''}
                onChange={(event) => updateDraft({ academicYear: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                placeholder="2026/2027"
              />
            </label>
            <label className="block text-sm font-bold text-slate-700">
              Semester
              <input
                value={draft.semester || ''}
                onChange={(event) => updateDraft({ semester: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                placeholder="First Semester"
              />
            </label>
          </div>
          <label className="block text-sm font-bold text-slate-700">
            Instructions
            <textarea
              value={draft.instructions}
              onChange={(event) => updateDraft({ instructions: event.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-20"
              placeholder="Read every question carefully…"
            />
          </label>

          <div className="border-t pt-4 space-y-3">
            <h3 className="font-black text-slate-800">Scoring and timing</h3>
            <div className="grid sm:grid-cols-3 gap-3">
              <label className="text-sm font-bold">
                Duration (min)
                <input
                  type="number"
                  min="1"
                  value={draft.availability.durationMinutes}
                  onChange={(event) =>
                    updateDraft({
                      availability: {
                        ...draft.availability,
                        durationMinutes: Math.max(1, Number(event.target.value)),
                      },
                    })
                  }
                  className="mt-1 w-full rounded-lg border px-2 py-2"
                />
              </label>
              <label className="text-sm font-bold">
                Pass mark (%)
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={draft.scoring.passMark}
                  onChange={(event) =>
                    updateDraft({
                      scoring: { ...draft.scoring, passMark: Number(event.target.value) },
                    })
                  }
                  className="mt-1 w-full rounded-lg border px-2 py-2"
                />
              </label>
              <label className="text-sm font-bold">
                Default marks
                <input
                  type="number"
                  min="1"
                  value={draft.scoring.defaultMarks}
                  onChange={(event) =>
                    updateDraft({
                      scoring: {
                        ...draft.scoring,
                        defaultMarks: Math.max(1, Number(event.target.value)),
                      },
                    })
                  }
                  className="mt-1 w-full rounded-lg border px-2 py-2"
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={draft.scoring.negativeMarking}
                onChange={(event) =>
                  updateDraft({
                    scoring: { ...draft.scoring, negativeMarking: event.target.checked },
                  })
                }
              />{' '}
              Enable negative marking
            </label>
            {draft.scoring.negativeMarking && (
              <label className="text-sm font-bold">
                Negative mark value
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.scoring.negativeMarkValue}
                  onChange={(event) =>
                    updateDraft({
                      scoring: { ...draft.scoring, negativeMarkValue: Number(event.target.value) },
                    })
                  }
                  className="ml-2 rounded-lg border px-2 py-1"
                />
              </label>
            )}
          </div>

          <div className="border-t pt-4 space-y-2">
            <h3 className="font-black text-slate-800 flex items-center gap-2">
              <LockKeyhole className="w-4 h-4" /> Navigation and security
            </h3>
            {(
              [
                ['randomizeQuestions', 'Randomize question order'],
                ['randomizeOptions', 'Randomize MCQ options'],
                ['allowPrevious', 'Allow previous navigation'],
                ['allowReviewBeforeSubmit', 'Allow review before submit'],
                ['requireExamPassword', 'Require examination password'],
                ['requireLanAuthority', 'Require LAN authority'],
                ['lockdown', 'Enable kiosk lockdown policy'],
              ] as const
            ).map(([key, label]) => {
              const target = key in draft.security ? draft.security : draft.navigation;
              const checked = Boolean((target as unknown as Record<string, unknown>)[key]);
              return (
                <label key={key} className="flex items-center gap-2 text-sm font-semibold">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) =>
                      key in draft.security
                        ? updateDraft({
                            security: { ...draft.security, [key]: event.target.checked },
                          })
                        : updateDraft({
                            navigation: { ...draft.navigation, [key]: event.target.checked },
                          })
                    }
                  />{' '}
                  {label}
                </label>
              );
            })}
            <label className="block text-sm font-bold mt-3">
              Unavailable capability policy
              <select
                value={draft.security.capabilityFailurePolicy || 'ALLOW_WITH_WARNING'}
                onChange={(event) =>
                  updateDraft({
                    security: {
                      ...draft.security,
                      capabilityFailurePolicy: event.target
                        .value as ExamSecuritySettings['capabilityFailurePolicy'],
                    },
                  })
                }
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="ALLOW_WITH_WARNING">Allow with warning</option>
                <option value="PREVENT_START">Prevent exam start</option>
                <option value="REQUIRE_ADMIN_APPROVAL">Require admin approval</option>
              </select>
            </label>
            <label className="block text-sm font-bold">
              Required capability IDs
              <input
                value={(draft.security.requiredCapabilities || []).join(', ')}
                onChange={(event) =>
                  updateDraft({
                    security: {
                      ...draft.security,
                      requiredCapabilities: event.target.value
                        .split(',')
                        .map((item) => item.trim())
                        .filter(Boolean),
                    },
                  })
                }
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                placeholder="copy-paste-block, printing-block"
              />
            </label>
            <div className="border-t pt-3 mt-3">
              <p className="text-sm font-black mb-2">Violation policy</p>
              <div className="grid sm:grid-cols-2 gap-2">
                {violationTypes.map((violation) => (
                  <label key={violation} className="text-xs font-bold">
                    {violation.replace(/_/g, ' ')}
                    <select
                      value={draft.security.violationPolicies?.[violation] || 'LOG_ONLY'}
                      onChange={(event) =>
                        updateDraft({
                          security: {
                            ...draft.security,
                            violationPolicies: {
                              ...draft.security.violationPolicies,
                              [violation]: event.target.value as NonNullable<
                                ExamSecuritySettings['violationPolicies']
                              >[string],
                            },
                          },
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1"
                    >
                      <option value="LOG_ONLY">Log only</option>
                      <option value="WARNING">Warning</option>
                      <option value="LOCK_TEMPORARILY">Lock temporarily</option>
                      <option value="REQUIRE_ADMIN_UNLOCK">Require admin unlock</option>
                      <option value="TERMINATE_ATTEMPT">Terminate attempt</option>
                      <option value="FORCE_SUBMIT">Force submit</option>
                    </select>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-black text-slate-800">Question selection</h2>
              <p className="text-sm text-slate-500">
                {selected.length} selected · {pool.length} matching the filters
              </p>
            </div>
            <Link to="/questions" className="text-sm font-bold text-[#2D6A4F] underline">
              Manage Question Bank
            </Link>
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <select
              value={courseId}
              onChange={(event) => {
                setCourseId(event.target.value);
                setTopicId('');
              }}
              className="rounded-lg border border-slate-300 px-3 py-2"
            >
              <option value="">All courses</option>
              {state.courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.courseCode} — {course.courseName}
                </option>
              ))}
            </select>
            <select
              value={topicId}
              onChange={(event) => setTopicId(event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2"
            >
              <option value="">All topics</option>
              {topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.topicName}
                </option>
              ))}
            </select>
            <select
              value={difficulty}
              onChange={(event) => setDifficulty(event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2"
            >
              <option value="all">All difficulty</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
          </div>
          <div className="max-h-80 overflow-y-auto border border-slate-200 rounded-xl divide-y">
            {pool.map((question) => (
              <label key={question.id} className="flex gap-3 p-3 hover:bg-slate-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.questionIds.includes(question.id)}
                  onChange={() => selectQuestion(question.id)}
                  className="mt-1"
                />
                <span className="text-sm">
                  <strong>{question.questionType.toUpperCase()}</strong> · {question.difficulty}
                  <br />
                  {question.questionText}
                </span>
              </label>
            ))}
            {!pool.length && (
              <p className="p-6 text-center text-slate-500">
                No questions match. Add questions in the existing Question Bank first.
              </p>
            )}
          </div>

          <div className="border-t pt-4">
            <h3 className="font-black text-slate-800 mb-2">Import valid questions from JSON</h3>
            <textarea
              value={jsonInput}
              onChange={(event) => setJsonInput(event.target.value)}
              className="w-full min-h-24 rounded-lg border px-3 py-2 font-mono text-xs"
              placeholder='[{"question_text":"…","choices":["A","B"],"correct_answer":0}]'
            />
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={importQuestions}
                className="px-3 py-2 rounded-lg bg-slate-800 text-white text-sm font-bold"
              >
                Validate and import
              </button>
              <span className="text-xs self-center text-slate-500">
                Only valid rows enter the existing Question Bank.
              </span>
            </div>
            {importMessage && (
              <p className="text-sm mt-2 text-amber-700 flex gap-1">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {importMessage}
              </p>
            )}
          </div>

          <div className="border-t pt-4">
            <h3 className="font-black text-slate-800 mb-2">Exact exam order and preview</h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {selected.map((question, index) => (
                <div key={question!.id} className="rounded-lg border p-3 flex gap-2 items-start">
                  <span className="font-black text-[#2D6A4F]">{index + 1}.</span>
                  <div className="flex-1 text-sm">
                    {question!.questionText}
                    <div className="text-xs text-slate-500 mt-1">
                      {question!.options?.join(' · ')}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    title="Move up"
                    className="p-1 disabled:opacity-30"
                  >
                    <ArrowUp className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    disabled={index === selected.length - 1}
                    onClick={() => move(index, 1)}
                    title="Move down"
                    className="p-1 disabled:opacity-30"
                  >
                    <ArrowDown className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-sm text-emerald-900 flex gap-2">
            <ShieldCheck className="w-5 h-5 shrink-0" />
            <p>
              Publishing freezes the exact text, option order, marks, security settings, and version
              hash. The generated file is signed and the password is stored only as a derived
              verifier.
            </p>
          </div>
          {status && <p className="rounded-lg bg-slate-100 p-3 text-sm font-semibold">{status}</p>}
          <button
            type="button"
            disabled={busy}
            onClick={() => void generatePackage()}
            className="w-full rounded-xl bg-[#2D6A4F] hover:bg-[#1B4332] disabled:opacity-50 text-white py-3 font-black flex items-center justify-center gap-2"
          >
            <Download className="w-5 h-5" />
            {busy ? 'Generating signed package…' : 'Publish and download .pharmaexam'}
          </button>
          <p className="text-xs text-slate-500 flex items-center gap-1">
            <CheckCircle2 className="w-4 h-4" />
            Existing practice Quiz and QuizHistory are unchanged.
          </p>
        </section>
      </div>
    </div>
  );
};

export default ExaminationBuilder;

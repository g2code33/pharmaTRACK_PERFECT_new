/**
 * PharmaTRACK AI Engine — controlled context builder.
 *
 * The rule this module exists to enforce: **never send the app's state to a
 * model**. A question about slide 23 of Lecture 4 gets the course name, the
 * topic, that slide's text, and nothing else — not the other 120 slides, not the
 * rest of the semester, not the whole chat history.
 *
 * Everything that goes out is therefore *selected* here, measured, deduplicated,
 * truncated against the model's context window, and returned with a manifest
 * (`sources`) so the UI can show exactly what was sent.
 */
import type {
  AIContextBlock,
  AIContextBundle,
  AIContextSource,
  AppStateLike,
  ContextSelection,
} from './types';
import { estimateTokens, truncateToTokens } from './tokens';

/** Rough token budget defaults, overridable per profile. */
export const DEFAULT_CONTEXT_BUDGET = 12_000;
/** Never send more than this many characters of one block, whatever the budget. */
const HARD_BLOCK_CHARS = 60_000;

/**
 * Builds the context bundle for one request. Pure: it reads state, never
 * mutates it, and every field it emits is traceable to a `source` entry.
 */
export function buildContext(
  state: AppStateLike,
  selection: ContextSelection,
  budgetTokens: number = DEFAULT_CONTEXT_BUDGET,
): AIContextBundle {
  const blocks: AIContextBlock[] = [];
  const warnings: string[] = [];

  const topic = state.topics.find((t) => t.id === selection.topicId);
  const course =
    state.courses.find((c) => c.id === (selection.courseId ?? topic?.courseId)) ??
    undefined;

  /* --- 1. Academic position (small, always useful, never identifying) --- */
  const position: string[] = [];
  if (state.student?.level) position.push(`Level: ${state.student.level}`);
  if (state.student?.semester) position.push(`Semester: ${state.student.semester}`);
  if (state.student?.program) position.push(`Programme: ${state.student.program}`);
  if (course) {
    position.push(`Course: ${course.courseCode ? `${course.courseCode} — ` : ''}${course.courseName}`);
  }
  if (topic) position.push(`Topic: ${topic.topicName}`);
  if (position.length) {
    push(blocks, {
      label: 'Student context',
      text: position.join('\n'),
      source: { kind: 'student', label: 'Level, semester, course and topic' },
    });
  }

  /* --- 2. The material in focus: selection → page/slide → retrieval --- */
  const material = state.slides.find((s) => s.id === selection.materialId);
  if (selection.selection?.trim()) {
    push(blocks, {
      label: 'Selected passage',
      text: selection.selection.trim(),
      source: {
        kind: 'selection',
        label: material
          ? `${material.title}${selection.slide ? ` — slide ${selection.slide}` : selection.page ? ` — page ${selection.page}` : ''}`
          : 'Selected text',
        materialId: material?.id,
        page: selection.page,
        slide: selection.slide,
      },
    });
  }

  if (selection.materialText) {
    const { label, text, page, slide, focusText } = selection.materialText;
    // Prefer the page/slide actually in view; fall back to the whole material.
    const body = (focusText && focusText.trim()) || text;
    const isFocus = Boolean(focusText && focusText.trim());
    if (body.trim()) {
      push(blocks, {
        label: isFocus
          ? slide
            ? `Current slide (${slide}) of ${label}`
            : page
              ? `Current page (${page}) of ${label}`
              : label
          : label,
        text: body,
        source: {
          kind: slide ? 'slide' : page ? 'page' : 'material',
          label: isFocus ? `${label} — ${slide ? `slide ${slide}` : `page ${page}`}` : label,
          materialId: material?.id,
          page,
          slide,
        },
      });
    }
  }

  // Retrieval hits: the only mechanism allowed to pull in *other* materials,
  // and only what the question actually matched.
  for (const hit of selection.retrieval ?? []) {
    push(blocks, {
      label: `Related material — ${hit.label}`,
      text: hit.text,
      source: {
        kind: 'retrieval',
        label: `${hit.label}${hit.page ? ` (page ${hit.page})` : hit.slide ? ` (slide ${hit.slide})` : ''}`,
        materialId: hit.materialId,
        page: hit.page,
        slide: hit.slide,
      },
    });
  }

  /* --- 3. Optional academic scaffolding -------------------------------- */
  if (selection.includeObjectives ?? true) {
    const objectives = state.learningObjectives
      .filter((o) => (!topic || o.topicId === topic.id || (!o.topicId && course && o.courseId === course.id)))
      .slice(0, 12);
    if (objectives.length) {
      push(blocks, {
        label: 'Learning objectives',
        text: objectives
          .map((o) => `- ${o.objectiveText}${o.status ? ` (${String(o.status).replace('_', ' ')})` : ''}`)
          .join('\n'),
        source: { kind: 'objectives', label: `${objectives.length} learning objectives` },
      });
    }
  }

  if (selection.includeNotes) {
    const notes = state.notes.filter((n) => n.topicId === selection.topicId).slice(0, 10);
    if (notes.length) {
      push(blocks, {
        label: 'My notes on this topic',
        text: notes.map((n) => `- ${n.noteText}`).join('\n'),
        source: { kind: 'notes', label: `${notes.length} of your notes` },
      });
    }
  }

  if (selection.includePerformance) {
    const history = state.quizHistory
      .filter((q) => !course || q.courseId === course.id)
      .slice(-5);
    if (history.length) {
      const weak = [...new Set(history.flatMap((q) => q.weakTopics ?? []))].slice(0, 8);
      const lines = history.map((q) => {
        const correct = q.answersGiven ? q.answersGiven.filter((a) => a.isCorrect).length : undefined;
        const total = q.answersGiven?.length;
        const score = `${Math.round(q.scorePercentage)}%`;
        const detail = correct !== undefined && total ? ` (${correct}/${total})` : '';
        return `- ${score}${detail} on ${q.completedAt?.slice(0, 10) ?? 'a recent quiz'}`;
      });
      if (weak.length) lines.push(`Weak topics flagged: ${weak.join(', ')}`);
      push(blocks, {
        label: 'Recent quiz performance',
        text: lines.join('\n'),
        source: { kind: 'quiz', label: `${history.length} recent quiz results` },
      });
    }
  }

  if (selection.includePlan) {
    const plan = state.studyPlans.filter((p) => !course || p.courseId === course.id).slice(0, 8);
    if (plan.length) {
      push(blocks, {
        label: 'Study plan',
        text: plan
          .map((p) => `- ${p.date}${p.timeSlot ? ` ${p.timeSlot}` : ''}: ${p.notes || p.activityType}${p.isCompleted ? ' (done)' : ''}`)
          .join('\n'),
        source: { kind: 'study-plan', label: `${plan.length} planned sessions` },
      });
    }
  }

  /* --- 3b. Questions the user picked from the bank --------------------- */
  // Explicitly selected questions carry their answer, because the student asked
  // about those exact questions. A topic-wide inclusion is a prompt for the
  // model, so answers are left out and only the stems travel.
  const picked = (selection.questionIds ?? []).slice(0, 8);
  const bank = state.examQuestions ?? [];
  const questions = picked.length
    ? picked.map((id) => bank.find((q) => q.id === id)).filter((q): q is NonNullable<typeof q> => Boolean(q))
    : selection.includeQuestions
      ? bank.filter((q) => (topic ? q.topicId === topic.id : !course || q.courseId === course.id)).slice(0, 6)
      : [];

  if (questions.length) {
    push(blocks, {
      label: picked.length ? 'Selected questions' : 'Question bank questions',
      text: questions
        .map((q, index) => {
          const meta = [q.questionType, q.difficulty].filter(Boolean).join(' · ');
          const lines = [`${index + 1}. ${q.questionText}${meta ? ` [${meta}]` : ''}`];
          if (picked.length) {
            const answer = q.correctAnswer ?? q.modelAnswer;
            if (answer) lines.push(`   Correct answer: ${answer}`);
            if (q.explanation) lines.push(`   Explanation: ${q.explanation}`);
          }
          return lines.join('\n');
        })
        .join('\n'),
      source: {
        kind: 'question',
        label: `${questions.length} question${questions.length === 1 ? '' : 's'} from your bank`,
      },
    });
  }

  /* --- 4. Budgeting ---------------------------------------------------- */
  const bundle: AIContextBundle = {
    blocks,
    sources: blocks.map((b) => b.source),
    estimatedTokens: 0,
    truncated: false,
    warnings,
  };

  const history =
    selection.includeHistory === false ? '' : recentTurns(selection, selection.historyTurns ?? 4);
  if (history) {
    bundle.blocks.push({
      label: 'Earlier in this conversation',
      text: history,
      source: { kind: 'history', label: `${selection.historyTurns ?? 4} earlier messages` },
    });
  }

  applyBudget(bundle, budgetTokens, warnings);
  bundle.estimatedTokens = bundle.blocks.reduce((sum, b) => sum + estimateTokens(b.text), 0);
  bundle.sources = bundle.blocks.map((b) => b.source);
  return bundle;
}

function recentTurns(selection: ContextSelection, turns: number): string {
  const messages = selection.conversation?.messages ?? [];
  if (!messages.length || turns <= 0) return '';
  return messages
    .slice(-turns)
    .map((m) => `${m.role === 'user' ? 'Student' : 'Assistant'}: ${m.content.slice(0, 600)}`)
    .join('\n');
}

/**
 * Fits the bundle into the budget. Priority order is "what the user is looking
 * at right now" first, then course scaffolding, then retrieval — so if anything
 * has to go, it is never the slide the student asked about.
 */
export function applyBudget(bundle: AIContextBundle, budgetTokens: number, warnings: string[]): void {
  const priority = (block: AIContextBlock): number => {
    switch (block.source.kind) {
      case 'selection':
        return 0;
      case 'page':
      case 'slide':
      case 'clinical-case':
        return 1;
      case 'material':
        return 2;
      case 'course':
      case 'topic':
      case 'student':
      case 'question':
        return 3;
      case 'objectives':
      case 'notes':
        return 4;
      case 'retrieval':
        return 5;
      default:
        return 6;
    }
  };

  const ordered = [...bundle.blocks].sort((a, b) => priority(a) - priority(b));
  let used = 0;
  const kept: AIContextBlock[] = [];

  for (const block of ordered) {
    const tokens = estimateTokens(block.text);
    const remaining = budgetTokens - used;
    if (remaining <= 200) {
      bundle.truncated = true;
      continue;
    }
    if (tokens <= remaining && block.text.length <= HARD_BLOCK_CHARS) {
      used += tokens;
      kept.push(block);
      continue;
    }
    const capped = truncateToTokens(block.text, Math.min(remaining - 100, estimateTokens(block.text)));
    bundle.truncated = true;
    used += estimateTokens(capped);
    kept.push({
      ...block,
      text: `${capped}\n\n[… truncated: this selection is larger than the model's context budget …]`,
      source: { ...block.source, chars: capped.length, truncated: true },
    });
  }

  // Restore a stable, readable order (focus first, as the prompt is built in order).
  bundle.blocks = kept.sort((a, b) => priority(a) - priority(b));
  bundle.sources = bundle.blocks.map((b) => b.source);
  if (bundle.truncated) {
    warnings.push(
      'Only part of the selected material was sent — the rest exceeded the context budget for this model.',
    );
  }
}

function push(
  blocks: AIContextBlock[],
  init: { label: string; text: string; source: Omit<AIContextSource, 'chars'> & { chars?: number } },
): void {
  const text = init.text.replace(/\s+\n/g, '\n').trim();
  if (!text) return;
  blocks.push({
    label: init.label,
    text,
    source: { ...init.source, chars: text.length },
  });
}

/**
 * PharmaTRACK AI Engine — task layer.
 *
 * Every AI *feature* in PharmaTRACK (Explain, Simplify, Summarize, Generate
 * MCQs, Flashcards, Weak topics, Clinical reasoning…) is a small, declarative
 * description here: which profile to use, which capabilities the job needs, and
 * how the prompt is assembled from the context bundle.
 *
 * Nothing in this file knows a provider exists. That is what stops PharmaTRACK
 * from growing one hard-coded AI implementation per button — the PDF reader,
 * the PPT viewer, Notes, the question bank and the study planner all run the
 * same engine with a different `AITaskId`.
 */
import type { AICapability, AIProfile, AIRequest, AIContextBundle, AIChatTurn } from './types';
import { PROFILE_IDS } from './profiles';

export type AITaskId =
  /* Study */
  | 'explain'
  | 'simplify'
  | 'teach'
  | 'summarize'
  | 'compare'
  | 'examples'
  /* Practice */
  | 'mcq'
  | 'short-answer'
  | 'clinical-case'
  | 'mark-answer'
  /* Revision */
  | 'flashcards'
  | 'weak-topics'
  | 'revision-summary'
  /* Documents */
  | 'ask-material'
  | 'explain-page'
  | 'explain-slide'
  | 'key-concepts'
  | 'questions-from-material'
  /* Pharmacy */
  | 'mechanism'
  | 'indications'
  | 'contraindications'
  | 'adverse-effects'
  | 'interactions'
  | 'monitoring'
  | 'counselling'
  | 'clinical-reasoning'
  /* Anything else */
  | 'chat';

export interface AITaskDefinition {
  id: AITaskId;
  /** Button label. */
  label: string;
  /** One-line description for tooltips. */
  hint: string;
  profile: keyof typeof PROFILE_IDS extends never ? never : string;
  /** Capabilities the job needs; drives capability routing when unbound. */
  capabilities: AICapability[];
  /** Grouping for the AI panel's action menus. */
  group: 'study' | 'practice' | 'revision' | 'document' | 'pharmacy' | 'other';
  /** True when the answer should be structured (MCQs, flashcards). */
  structured?: boolean;
  /** Instruction appended to the profile's system prompt. */
  instruction: string;
  /** Optional fixed user prompt, used when the task is not free-form chat. */
  prompt?: (ctx?: { material?: string; page?: number; slide?: number }) => string;
}

const asMCQ = (count = 5) =>
  `Write ${count} multiple-choice questions from the material above. For each: the stem, options A–D, the correct ` +
  `answer, and a one-sentence rationale. Use only content present in the material.`;

export const AI_TASKS: Record<AITaskId, AITaskDefinition> = {
  explain: {
    id: 'explain',
    label: 'Explain this',
    hint: 'Explain the selected material in plain language',
    profile: PROFILE_IDS.study,
    capabilities: ['text_generation'],
    group: 'study',
    instruction:
      'Explain what the student selected, in words a second-year pharmacy student would use. ' +
      'Start with the core idea in one sentence, then unpack it.',
  },
  simplify: {
    id: 'simplify',
    label: 'Simplify',
    hint: 'Rewrite it in the simplest possible language',
    profile: PROFILE_IDS.study,
    capabilities: ['text_generation'],
    group: 'study',
    instruction:
      'Rewrite the selected material in the simplest accurate language. Short sentences, no jargon unless you define it.',
  },
  teach: {
    id: 'teach',
    label: 'Teach me',
    hint: 'Teach the topic from the ground up',
    profile: PROFILE_IDS.study,
    capabilities: ['text_generation'],
    group: 'study',
    instruction:
      'Teach this topic from first principles: what problem it solves, how it works, and what the student must be able ' +
      'to recall for an exam.',
  },
  summarize: {
    id: 'summarize',
    label: 'Summarize',
    hint: 'Summarise the selected material',
    profile: PROFILE_IDS.study,
    capabilities: ['text_generation'],
    group: 'study',
    instruction: 'Summarise the material as 5–8 bullet points, most examinable first.',
  },
  compare: {
    id: 'compare',
    label: 'Compare',
    hint: 'Compare and contrast the items in the material',
    profile: PROFILE_IDS.study,
    capabilities: ['text_generation'],
    group: 'study',
    instruction: 'Compare the drugs/classes/concepts in the material as a compact table: mechanism, use, key risk.',
  },
  examples: {
    id: 'examples',
    label: 'Give examples',
    hint: 'Concrete pharmacy examples of the concept',
    profile: PROFILE_IDS.study,
    capabilities: ['text_generation'],
    group: 'study',
    instruction: 'Give three concrete pharmacy examples of the concept, each with a short clinical justification.',
  },
  mcq: {
    id: 'mcq',
    label: 'Generate MCQs',
    hint: 'Exam-style multiple-choice questions',
    profile: PROFILE_IDS.quiz,
    capabilities: ['text_generation'],
    group: 'practice',
    structured: true,
    instruction: asMCQ(5),
    prompt: () => asMCQ(5),
  },
  'short-answer': {
    id: 'short-answer',
    label: 'Short-answer questions',
    hint: 'Exam-style short-answer questions',
    profile: PROFILE_IDS.quiz,
    capabilities: ['text_generation'],
    group: 'practice',
    structured: true,
    instruction: 'Write 4 short-answer questions from the material, each with a model answer of 2–3 sentences.',
    prompt: () => 'Write 4 short-answer questions from the material, each with a model answer.',
  },
  'clinical-case': {
    id: 'clinical-case',
    label: 'Clinical case',
    hint: 'A patient-based question using this material',
    profile: PROFILE_IDS.clinical,
    capabilities: ['text_generation'],
    group: 'practice',
    structured: true,
    instruction:
      'Write one short clinical case that requires the material above, then ask 3 questions about it with model answers.',
  },
  'mark-answer': {
    id: 'mark-answer',
    label: 'Mark my answer',
    hint: 'Mark the student’s answer to a generated question',
    profile: PROFILE_IDS.quiz,
    capabilities: ['text_generation'],
    group: 'practice',
    instruction:
      'Mark the student’s answer against the material. Give what was correct, what was missing or wrong, the marks, ' +
      'and the model answer.',
  },
  flashcards: {
    id: 'flashcards',
    label: 'Create flashcards',
    hint: 'Question/answer cards for revision',
    profile: PROFILE_IDS.quiz,
    capabilities: ['text_generation'],
    group: 'revision',
    structured: true,
    instruction:
      'Create 8 flashcards from the material as “Q: … / A: …” pairs. Keep each answer to one or two lines.',
    prompt: () => 'Create 8 flashcards from the material above as Q/A pairs.',
  },
  'weak-topics': {
    id: 'weak-topics',
    label: 'Find my weak topics',
    hint: 'Uses your quiz performance and study plan',
    profile: PROFILE_IDS.study,
    capabilities: ['text_generation'],
    group: 'revision',
    instruction:
      'Using the quiz performance, notes and objectives above, name the topics this student is weakest on, in priority ' +
      'order, and give a concrete revision action for each.',
  },
  'revision-summary': {
    id: 'revision-summary',
    label: 'Revision summary',
    hint: 'One-page summary for the exam',
    profile: PROFILE_IDS.study,
    capabilities: ['text_generation'],
    group: 'revision',
    instruction:
      'Write a one-page revision summary of the material: key mechanisms, drugs, numbers, and the traps examiners use.',
  },
  'ask-material': {
    id: 'ask-material',
    label: 'Ask about this material',
    hint: 'Question about the material you are reading',
    profile: PROFILE_IDS.document,
    capabilities: ['text_generation'],
    group: 'document',
    instruction: 'Answer strictly from the supplied material. If the answer is not in it, say so and stop.',
  },
  'explain-page': {
    id: 'explain-page',
    label: 'Explain this page',
    hint: 'Explain the PDF page currently on screen',
    profile: PROFILE_IDS.document,
    capabilities: ['text_generation'],
    group: 'document',
    instruction:
      'Explain the page currently on screen: what it is about, what matters, and what the student should remember.',
    prompt: () => 'Explain this page.',
  },
  'explain-slide': {
    id: 'explain-slide',
    label: 'Explain this slide',
    hint: 'Explain the slide currently on screen',
    profile: PROFILE_IDS.document,
    capabilities: ['text_generation'],
    group: 'document',
    instruction:
      'Explain the slide currently on screen: the point of the slide, and the detail behind each bullet or table row.',
    prompt: () => 'Explain this slide.',
  },
  'key-concepts': {
    id: 'key-concepts',
    label: 'Find key concepts',
    hint: 'The concepts most likely to be examined',
    profile: PROFILE_IDS.document,
    capabilities: ['text_generation'],
    group: 'document',
    instruction: 'List the key concepts in the material with a one-line definition each, ordered by likely exam weighting.',
  },
  'questions-from-material': {
    id: 'questions-from-material',
    label: 'Questions from this material',
    hint: 'Generate questions grounded in the material',
    profile: PROFILE_IDS.quiz,
    capabilities: ['text_generation'],
    group: 'document',
    structured: true,
    instruction: asMCQ(6),
  },
  mechanism: {
    id: 'mechanism',
    label: 'Mechanism',
    hint: 'Mechanism of action',
    profile: PROFILE_IDS.clinical,
    capabilities: ['text_generation'],
    group: 'pharmacy',
    instruction: 'State the mechanism of action precisely, receptor/enzyme/target included, at molecular level.',
  },
  indications: {
    id: 'indications',
    label: 'Indications',
    hint: 'What it is used for',
    profile: PROFILE_IDS.clinical,
    capabilities: ['text_generation'],
    group: 'pharmacy',
    instruction: 'List indications with a one-line clinical justification for each, first-line before second-line.',
  },
  contraindications: {
    id: 'contraindications',
    label: 'Contraindications',
    hint: 'When it must not be used',
    profile: PROFILE_IDS.clinical,
    capabilities: ['text_generation'],
    group: 'pharmacy',
    instruction: 'List absolute and relative contraindications, with the reason each one matters.',
  },
  'adverse-effects': {
    id: 'adverse-effects',
    label: 'Adverse effects',
    hint: 'Side effects and their mechanisms',
    profile: PROFILE_IDS.clinical,
    capabilities: ['text_generation'],
    group: 'pharmacy',
    instruction:
      'List adverse effects by frequency (common → rare), and explain the mechanism behind the important ones.',
  },
  interactions: {
    id: 'interactions',
    label: 'Interactions',
    hint: 'Drug and food interactions',
    profile: PROFILE_IDS.clinical,
    capabilities: ['text_generation'],
    group: 'pharmacy',
    instruction: 'List clinically significant interactions with mechanism, severity and what to do about each.',
  },
  monitoring: {
    id: 'monitoring',
    label: 'Monitoring',
    hint: 'What to monitor during therapy',
    profile: PROFILE_IDS.clinical,
    capabilities: ['text_generation'],
    group: 'pharmacy',
    instruction: 'List the monitoring parameters, with target values and the frequency a pharmacist would check.',
  },
  counselling: {
    id: 'counselling',
    label: 'Counselling points',
    hint: 'What to tell the patient',
    profile: PROFILE_IDS.clinical,
    capabilities: ['text_generation'],
    group: 'pharmacy',
    instruction:
      'Write patient counselling points in plain language: how to take it, what to expect, what to report, when to come back.',
  },
  'clinical-reasoning': {
    id: 'clinical-reasoning',
    label: 'Clinical reasoning',
    hint: 'Work through a clinical problem',
    profile: PROFILE_IDS.clinical,
    capabilities: ['text_generation'],
    group: 'pharmacy',
    structured: true,
    instruction:
      'Reason clinically step by step: presenting problem → relevant pharmacology → therapeutic options → risks → ' +
      'monitoring plan. Show the reasoning, not just the answer.',
  },
  chat: {
    id: 'chat',
    label: 'Chat',
    hint: 'Ask anything about your material',
    profile: PROFILE_IDS.default,
    capabilities: ['text_generation'],
    group: 'other',
    instruction: '',
  },
};

export const taskById = (id: AITaskId | undefined): AITaskDefinition =>
  (id && AI_TASKS[id]) || AI_TASKS.chat;

/** Tasks grouped for menus in the AI panel. */
export const tasksInGroup = (group: AITaskDefinition['group']): AITaskDefinition[] =>
  Object.values(AI_TASKS).filter((t) => t.group === group && t.id !== 'chat');

/** Prompt text for a task the user did not type anything into. */
export function taskPrompt(id: AITaskId, ctx?: { material?: string; page?: number; slide?: number }): string {
  const task = taskById(id);
  return task.prompt ? task.prompt(ctx) : task.label;
}

/**
 * Turns a context bundle + a task + the user's question into the request the
 * engine will route. Context blocks are labelled and framed as source material
 * so the model cites *PharmaTRACK* context rather than pretending it browsed.
 */
export function buildTaskRequest(input: {
  task: AITaskId;
  question?: string;
  context?: AIContextBundle;
  profile?: AIProfile;
  /** Prior turns of this conversation, oldest → newest. */
  history?: AIChatTurn[];
  images?: AIRequest['images'];
  providerId?: string;
  model?: string;
  capability?: AICapability;
  stream?: boolean;
}): AIRequest {
  const task = taskById(input.task);
  const systemParts = [input.profile?.systemInstructions ?? '', task.instruction].filter(Boolean);
  const instruction = systemParts.join('\n\n');

  const blocks = input.context?.blocks ?? [];
  const contextText = blocks
    .map((block) => `--- ${block.label} ---\n${block.text}`)
    .join('\n\n');

  const messages: AIChatTurn[] = [];
  if (instruction) messages.push({ role: 'system', content: instruction });
  for (const turn of input.history ?? []) messages.push(turn);

  if (contextText) {
    messages.push({
      role: 'user',
      content: `PharmaTRACK context (use it as the source; cite the section or slide when useful):\n\n${contextText}`,
    });
    // Keep the assistant from treating the context dump as the question.
    messages.push({ role: 'assistant', content: 'Understood — I have the material. What would you like to know?' });
  }
  messages.push({ role: 'user', content: (input.question ?? '').trim() || taskPrompt(input.task) });

  const capabilities = input.capability
    ? [input.capability]
    : task.capabilities.length
      ? task.capabilities
      : ['text_generation' as AICapability];

  return {
    messages,
    profileId: task.profile,
    providerId: input.providerId,
    model: input.model,
    images: input.images,
    capability: capabilities[0],
    temperature: input.profile?.temperature,
    maxOutputTokens: input.profile?.maxOutputTokens,
    stream: input.stream,
    context: input.context,
  };
}

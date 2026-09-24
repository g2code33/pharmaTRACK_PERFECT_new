/**
 * PharmaTRACK AI Engine — preset AI profiles.
 *
 * A profile is "how PharmaTRACK should answer this *kind* of question": which
 * provider, which model, how creative, how long, which instructions, what to
 * fall back to. Features ask for a profile (or a capability) — never for a
 * vendor — which is what keeps Study, Documents, Practice and the readers on
 * one engine.
 *
 * Defaults ship empty of provider bindings (`providerId: ''`) because nothing is
 * configured on a fresh install: the AI Settings screen fills them in, and the
 * migration binds the default profile to the user's existing key.
 */
import type { AIProfile } from './types';

/** Ids used by features, so call sites never hard-code provider names. */
/** Shared refusal. Clinical study must not become a prescription. */
export const EDUCATIONAL_BOUNDARY =
  'Never give a dose or a treatment plan for a real patient. If asked how to treat a real person, refuse and say a qualified clinician must decide. Name the labelled PharmaTRACK source you used when one was supplied.';

export const PROFILE_IDS = {
  default: 'default',
  study: 'study',
  clinical: 'clinical',
  quiz: 'quiz',
  document: 'document',
  fallback: 'fallback',
} as const;

export const PRESET_PROFILES: AIProfile[] = [
  {
    id: PROFILE_IDS.default,
    name: 'Default AI',
    providerId: '',
    temperature: 0.4,
    maxOutputTokens: 1200,
    contextLimitTokens: 12000,
    capabilities: ['text_generation', 'streaming'],
    fallbacks: [],
    useFallback: true,
    systemInstructions:
      'You are PharmaTRACK’s academic assistant for a pharmacy student. Be accurate, concise and exam-focused. ' +
      'Prefer short paragraphs and bullet points. If you are unsure, say so rather than inventing facts. ' +
      EDUCATIONAL_BOUNDARY,
  },
  {
    id: PROFILE_IDS.study,
    name: 'Study AI',
    providerId: '',
    temperature: 0.5,
    maxOutputTokens: 1500,
    contextLimitTokens: 16000,
    capabilities: ['text_generation', 'streaming'],
    fallbacks: [],
    useFallback: true,
    systemInstructions:
      'You are a pharmacy tutor. Explain the material the student selected in plain language, step by step, ' +
      'then add one exam-style question to check understanding. Keep it under 250 words unless asked for more. ' +
      EDUCATIONAL_BOUNDARY,
  },
  {
    id: PROFILE_IDS.clinical,
    name: 'Clinical AI',
    providerId: '',
    temperature: 0.2,
    maxOutputTokens: 1500,
    contextLimitTokens: 16000,
    capabilities: ['text_generation', 'streaming'],
    fallbacks: [],
    useFallback: true,
    systemInstructions:
      'You are a clinical pharmacy preceptor for students. Reason from mechanism to indication, contraindication, adverse effect, ' +
      'interaction, monitoring and counselling. Use only the labelled PharmaTRACK context and name those sources. Flag anything unsafe. ' +
      'Never give patient-specific prescribing advice. If asked about a real patient, refuse and say a qualified clinician must decide. ' +
      'This is education, not clinical practice. ' + EDUCATIONAL_BOUNDARY,
  },
  {
    id: PROFILE_IDS.quiz,
    name: 'Quiz AI',
    providerId: '',
    temperature: 0.6,
    maxOutputTokens: 2000,
    contextLimitTokens: 14000,
    capabilities: ['text_generation', 'streaming'],
    fallbacks: [],
    useFallback: true,
    systemInstructions:
      'You write pharmacy exam questions from the supplied material only. For MCQs give four options (A–D), ' +
      'mark the correct answer, and add a one-sentence rationale. Never invent content that is not in the material; ' +
      'if the material is insufficient, say so. ' + EDUCATIONAL_BOUNDARY,
  },
  {
    id: PROFILE_IDS.document,
    name: 'Document AI',
    providerId: '',
    temperature: 0.3,
    maxOutputTokens: 1600,
    contextLimitTokens: 30000,
    capabilities: ['text_generation', 'streaming', 'document_analysis'],
    fallbacks: [],
    useFallback: true,
    systemInstructions:
      'You explain lecture material one page or slide at a time. Work only from the supplied context, refer to it ' +
      '(e.g. “slide 12”) when helpful, and finish with the two or three points most likely to be examined. ' +
      EDUCATIONAL_BOUNDARY,
  },
  {
    id: PROFILE_IDS.fallback,
    name: 'Fallback AI',
    providerId: '',
    temperature: 0.4,
    maxOutputTokens: 1200,
    contextLimitTokens: 12000,
    capabilities: ['text_generation', 'streaming'],
    fallbacks: [],
    useFallback: false,
    systemInstructions:
      'You are PharmaTRACK’s backup assistant, used when the primary provider is unavailable. Answer the same ' +
      'question the student asked, as helpfully as you can from the supplied context. ' + EDUCATIONAL_BOUNDARY,
  },
];

export const defaultProfile = (): AIProfile => ({ ...PRESET_PROFILES[0], fallbacks: [] });

export const profileById = (profiles: AIProfile[], id: string | undefined): AIProfile =>
  profiles.find((p) => p.id === id) ?? profiles.find((p) => p.id === PROFILE_IDS.default) ?? profiles[0] ?? defaultProfile();

/**
 * Clinical learning is a local study mode. These tests never call a provider.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AppState } from '../types';
import { initialState } from '../utils/storage';
import { searchAll } from '../utils/search';
import { searchAcademic } from '../utils/academicSearch';
import { AI_TASKS, CLINICAL_SOURCE_RULE } from '../ai/tasks';
import { EDUCATIONAL_BOUNDARY, PRESET_PROFILES, PROFILE_IDS } from '../ai/profiles';
import { CURRENT_SCHEMA_VERSION } from '../utils/storageManager';
import Clinical from '../pages/Clinical';
import {
  BUILTIN_CASES,
  CLINICAL_STEPS,
  EDUCATIONAL_DISCLAIMER,
  NOT_A_PRESCRIPTION,
  PHARMACY_TOPICS,
  caseIsStudyMaterial,
  clinicalContext,
  createCase,
  duplicateCase,
  gradeDose,
  looksLikeRealPatientRequest,
  reviewAnswer,
  visibleCases,
} from '../utils/clinicalLearning';

const { dispatch, stateRef } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  stateRef: { current: null as AppState | null },
}));

vi.mock('../context/AppContext', () => ({
  useApp: () => ({ state: stateRef.current, dispatch }),
}));

describe('clinical learning', () => {
  it('ships fictional cases with the full study structure and no provider', () => {
    const source = readFileSync('src/utils/clinicalLearning.ts', 'utf8');
    expect(source).not.toContain('ai/manager');
    expect(source).not.toContain('fetch(');
    expect(BUILTIN_CASES.length).toBeGreaterThanOrEqual(2);
    for (const item of BUILTIN_CASES) {
      expect(item.fictional).toBe(true);
      expect(item.origin).toBe('builtin');
      expect(caseIsStudyMaterial(item)).toBe(true);
      expect(CLINICAL_STEPS.every((step) => item.steps.some((entry) => entry.id === step.id && entry.explanation))).toBe(true);
      expect(PHARMACY_TOPICS.every((topic) => item.pharmacy.some((entry) => entry.id === topic.id && entry.text))).toBe(true);
      expect(item.presentation).toBeTruthy();
      expect(item.symptoms).toBeTruthy();
      expect(item.history).toBeTruthy();
      expect(item.findings).toBeTruthy();
      expect(item.labs).toBeTruthy();
      expect(item.medicines.length).toBeGreaterThan(0);
      expect(item.problems.length).toBeGreaterThan(0);
      expect(item.questions.length).toBeGreaterThan(0);
      expect(item.doseExercise?.working).toMatch(/not/i);
    }
    expect(visibleCases(initialState).map((item) => item.id)).toEqual(BUILTIN_CASES.map((item) => item.id));
  });

  it('reviews study answers and refuses a real-patient request', () => {
    const question = BUILTIN_CASES[0].questions[0];
    expect(reviewAnswer(question, 'burning epigastric pain').matched).toBe(true);
    expect(reviewAnswer(question, 'headache only').matched).toBe(false);
    expect(reviewAnswer(question, 'headache only').showModelAnswer).toBe(true);

    const refused = reviewAnswer(question, 'epigastric pain — what dose should I give my mum?');
    expect(refused.refused).toBe(true);
    expect(refused.matched).toBeNull();
    expect(refused.showModelAnswer).toBe(false);
    expect(refused.feedback).toContain('qualified clinician');

    expect(looksLikeRealPatientRequest(EDUCATIONAL_DISCLAIMER)).toBe(false);
    expect(looksLikeRealPatientRequest(NOT_A_PRESCRIPTION)).toBe(false);
    expect(looksLikeRealPatientRequest('The fictional patient has epigastric pain.')).toBe(false);
    expect(looksLikeRealPatientRequest('Discuss this with the prescriber.')).toBe(false);
    expect(looksLikeRealPatientRequest('I have a real patient who needs ibuprofen')).toBe(true);
  });

  it('marks only the worksheet count and labels it as not a dose', () => {
    const exercise = BUILTIN_CASES[0].doseExercise!;
    const right = gradeDose(exercise, '15');
    expect(right.ok).toBe(true);
    expect(right.note).toMatch(/not a dose/i);
    expect(right.working).toMatch(/not an instruction/i);
    expect(gradeDose(exercise, '14').ok).toBe(false);
    expect(gradeDose(exercise, 'what dose should I give my dad').ok).toBe(false);
    expect(gradeDose(exercise, 'what dose should I give my dad').note).toMatch(/qualified clinician/);
  });

  it('builds labelled offline context and keeps practice keys out unless asked', () => {
    const item = BUILTIN_CASES[1];
    const ctx = clinicalContext(item, { step: 'why' });
    expect(ctx.provider).toBeNull();
    expect(ctx.offline).toBe(true);
    expect(ctx.generated).toBe(false);
    expect(ctx.disclaimer).toContain('not advice for a real patient');
    expect(ctx.blocks[0].label).toBe('Educational boundary');
    expect(ctx.blocks[1].label).toBe('Step: Why?');
    expect(ctx.sources.every((source) => source.kind === 'clinical-case' && source.materialId === item.id)).toBe(true);
    expect(ctx.sources.map((source) => source.label)).toContain('Pharmacy: Mechanism');
    expect(ctx.blocks.some((block) => block.label.startsWith('Model answer'))).toBe(false);
    const unique = item.questions[0].modelAnswer;
    expect(ctx.blocks.some((block) => block.text.includes(unique))).toBe(false);

    const review = clinicalContext(item, { includePractice: true, questionId: item.questions[0].id });
    expect(review.blocks.some((block) => block.label === 'Model answer (study review only)' && block.text.includes(unique))).toBe(true);
  });

  it('stores a manual case without replacing the library', () => {
    const manual = createCase({
      title: 'Study case: classroom antacid',
      presentation: 'A fictional customer in a teaching pharmacy asks what an antacid is for.',
    });
    expect(manual.fictional).toBe(true);
    expect(manual.origin).toBe('manual');
    expect(manual.steps).toHaveLength(CLINICAL_STEPS.length);
    expect(manual.pharmacy).toHaveLength(PHARMACY_TOPICS.length);
    const visible = visibleCases({ clinicalCases: [manual, { ...BUILTIN_CASES[0], title: 'shadow' }] });
    expect(visible.filter((item) => item.id === 'builtin-ibuprofen')).toHaveLength(1);
    expect(visible.find((item) => item.id === 'builtin-ibuprofen')?.title).toBe(BUILTIN_CASES[0].title);
    expect(visible.some((item) => item.id === manual.id)).toBe(true);
    expect(duplicateCase(BUILTIN_CASES[0]).origin).toBe('manual');
    expect(caseIsStudyMaterial(createCase({
      title: 'Dose for my mother',
      presentation: 'What dose should I give my mother tonight?',
    }))).toBe(false);
  });

  it('is findable in offline search and does not bump the schema', () => {
    const hit = searchAll(initialState, 'ibuprofen').find((result) => result.category === 'Case');
    expect(hit?.link).toBe('/clinical?case=builtin-ibuprofen');
    expect(hit?.action).toBe('Open case');
    const filtered = searchAcademic(initialState, 'salbutamol', { materialType: 'case' });
    expect(filtered.every((result) => result.category === 'Case')).toBe(true);
    expect(filtered.some((result) => result.link.includes('builtin-inhalers'))).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
    expect(readFileSync('src/utils/storageManager.ts', 'utf8')).not.toContain("'clinicalCases'");
    expect(readFileSync('src/utils/storageManager.ts', 'utf8')).not.toContain("'learningRecords'");
  });

  it('keeps future clinical tasks educational and source-bound', () => {
    expect(CLINICAL_SOURCE_RULE).toMatch(/real patient/);
    expect(AI_TASKS['clinical-case'].instruction).toContain(CLINICAL_SOURCE_RULE);
    expect(AI_TASKS['clinical-reasoning'].instruction).toContain('What, Where, Why, How');
    expect(AI_TASKS.mechanism.instruction).toContain(CLINICAL_SOURCE_RULE);
    expect(AI_TASKS.interactions.instruction).toMatch(/real patient/);
    const clinical = PRESET_PROFILES.find((profile) => profile.id === PROFILE_IDS.clinical);
    expect(clinical?.systemInstructions).toContain('name those sources');
    expect(clinical?.systemInstructions).toContain(EDUCATIONAL_BOUNDARY);
    expect(readFileSync('src/pages/Clinical.tsx', 'utf8')).not.toContain('ai/manager');
    expect(readFileSync('src/pages/Clinical.tsx', 'utf8')).not.toContain('fetch(');
  });

  it('shows the educational boundary and does not offer to generate advice', () => {
    stateRef.current = initialState;
    dispatch.mockClear();
    render(
      <MemoryRouter>
        <Clinical />
      </MemoryRouter>,
    );
    expect(screen.getByRole('note').textContent).toContain(EDUCATIONAL_DISCLAIMER);
    expect(screen.getByRole('heading', { name: 'Study cases' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /generate|ask ai|prescribe/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Study case: Ibuprofen and epigastric burning' }));
    expect(screen.getByRole('heading', { name: 'Study case: Ibuprofen and epigastric burning' })).toBeTruthy();
    expect(screen.getByText('Sources for a future tutor')).toBeTruthy();
    expect(screen.getByText(/No provider is called from this page/)).toBeTruthy();
  });
});

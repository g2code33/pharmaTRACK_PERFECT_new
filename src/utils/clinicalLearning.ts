/**
 * Clinical learning mode — a study system for pharmacy students.
 *
 * Cases are fictional exercises. This module never calls a provider and never
 * turns a note into a dose or a treatment plan for a real person. A future
 * tutor may receive only the labelled blocks from `clinicalContext`.
 */
import type { AppState } from '../types';
import type {
  ClinicalAttempt,
  ClinicalCase,
  ClinicalCaseDraft,
  ClinicalMedicine,
  ClinicalQuestion,
  ClinicalStep,
  ClinicalStepId,
  DoseExercise,
  PharmacyPoint,
  PharmacyTopicId,
} from '../types';

export const EDUCATIONAL_DISCLAIMER =
  'This is a study exercise for pharmacy students. It is not advice for a real patient and it does not replace a qualified clinician.';

export const NOT_A_PRESCRIPTION =
  'Do not treat a real person from this page or from an AI reply. Patient-specific decisions belong to a qualified clinician.';

export const PRACTICE_DOSE_NOTE =
  'Practice arithmetic for this fictional problem. It is not a dose for a real person.';

export const CLINICAL_STEPS: { id: ClinicalStepId; label: string; prompt: string }[] = [
  { id: 'what', label: 'What?', prompt: 'What is the problem in this study case?' },
  { id: 'where', label: 'Where?', prompt: 'Where is it happening — organ, receptor, or setting?' },
  { id: 'why', label: 'Why?', prompt: 'Why is this happening? Name the mechanism.' },
  { id: 'how', label: 'How?', prompt: 'How does the medicine produce the effect or the harm in this case?' },
  { id: 'assess', label: 'What should be assessed?', prompt: 'What history, findings, labs, or red flags belong in the study notes?' },
  { id: 'therapy', label: 'Therapeutic considerations', prompt: 'What options would a class discuss? Do not choose a treatment for a real person.' },
  { id: 'monitoring', label: 'Monitoring', prompt: 'What would a pharmacist check in this teaching case?' },
  { id: 'counseling', label: 'Counseling', prompt: 'What counseling points belong in the study notes?' },
];

export const PHARMACY_TOPICS: { id: PharmacyTopicId; label: string; prompt: string }[] = [
  { id: 'mechanism', label: 'Mechanism', prompt: 'What is the mechanism, including the target?' },
  { id: 'indications', label: 'Indications', prompt: 'What is this medicine used for in teaching?' },
  { id: 'contraindications', label: 'Contraindications', prompt: 'When do study notes say it should not be used?' },
  { id: 'adverse-effects', label: 'Adverse effects', prompt: 'What harms belong in the study notes?' },
  { id: 'interactions', label: 'Interactions', prompt: 'Which interactions matter in this discussion?' },
  { id: 'monitoring', label: 'Monitoring', prompt: 'What would be checked, and why?' },
  { id: 'counseling', label: 'Counseling', prompt: 'What would a student rehearse saying?' },
  { id: 'dose-calculation', label: 'Dose calculation', prompt: 'What is the practice arithmetic? It is not a dose for a real person.' },
  { id: 'therapeutic-reasoning', label: 'Therapeutic reasoning', prompt: 'What would a class weigh? Do not choose a treatment for a real person.' },
  { id: 'differential', label: 'Differential considerations', prompt: 'What else could explain the presentation in a teaching discussion?' },
];

const step = (id: ClinicalStepId, explanation: string): ClinicalStep => ({ id, explanation });
const point = (id: PharmacyTopicId, text: string): PharmacyPoint => ({ id, text });

export const BUILTIN_CASES: ClinicalCase[] = [
  {
    id: 'builtin-ibuprofen',
    title: 'Study case: Ibuprofen and epigastric burning',
    fictional: true,
    origin: 'builtin',
    presentation:
      'A teaching scenario. A fictional 68-year-old, Mrs A., tells a pharmacy student she has had burning pain in the upper abdomen for four days.',
    symptoms:
      'Burning epigastric pain, worse after meals. The scenario does not describe vomiting of blood or black stools.',
    history:
      'Osteoarthritis in the scenario. She has taken ibuprofen 400 mg three times daily for three weeks, and aspirin 75 mg once daily. No previous ulcer is described.',
    findings:
      'The teaching note says there is mild tenderness in the epigastrium. No signs of an acute abdomen are described.',
    labs:
      'The scenario says haemoglobin is within the printed reference range. There is no real laboratory result to act on.',
    medicines: [
      { name: 'Ibuprofen', detail: '400 mg three times daily in the scenario' },
      { name: 'Aspirin', detail: '75 mg once daily in the scenario' },
    ],
    problems: [
      'Possible NSAID-related gastric irritation, for class discussion only.',
      'Two medicines that can irritate the stomach are used together in the scenario.',
      'The student must not stop either medicine for a real person.',
    ],
    steps: [
      step('what', 'The study problem is burning upper-abdominal pain in a fictional person who has recently been taking an NSAID.'),
      step('where', 'The relevant site in this discussion is the stomach lining. The enzyme target is cyclo-oxygenase (COX). The setting is a teaching conversation, not a clinic decision.'),
      step('why', 'Ibuprofen inhibits COX and reduces protective prostaglandins in the gastric mucosa. Less prostaglandin means less mucus and bicarbonate, so the lining is more exposed to acid. Low-dose aspirin also inhibits COX-1 and can add to gastric irritation. That is the teaching mechanism, not a diagnosis.'),
      step('how', 'In the scenario the pain started after weeks of regular ibuprofen. A student can connect the timing, the medicine, and the site. Timing alone does not prove cause.'),
      step('assess', 'In class, list what a pharmacist would want to know: vomiting of blood, black stools, severe or sudden pain, fainting, other medicines, ulcer history, and alcohol. If a real person had those red flags, the learning point is urgent clinical assessment, not an answer from this app. In an older adult, upper abdominal pain is not always the stomach.'),
      step('therapy', 'A class might discuss whether an NSAID is still needed, whether gastroprotection is a topic for the prescriber, and that paracetamol is often mentioned as another analgesic in osteoarthritis teaching. This page does not choose a medicine or a dose for Mrs A. or for anyone else.'),
      step('monitoring', 'Study points: ask about ongoing pain, black stools, and dizziness. A prescriber may check haemoglobin if bleeding is suspected. No monitoring order is made here.'),
      step('counseling', 'Class points: take an NSAID with food in textbook examples, do not add another NSAID, report black stools or vomiting of blood, and do not stop aspirin that was prescribed for the heart without the prescriber. These are not instructions for a real person tonight.'),
    ],
    pharmacy: [
      point('mechanism', 'Ibuprofen inhibits cyclo-oxygenase (COX-1 and COX-2), so less prostaglandin is formed. In the stomach that means less protective mucus and bicarbonate. That is the study mechanism for the epigastric burning in this fictional case.'),
      point('indications', 'In teaching, ibuprofen is an analgesic and anti-inflammatory used for pain such as osteoarthritis. The scenario uses it for that discussion. This is not a decision that anyone should continue it.'),
      point('contraindications', 'Study contraindications include active peptic ulcer, a previous NSAID-related bleed, NSAID hypersensitivity, and severe heart failure. The scenario does not give enough history to apply these to a real person. A student lists them; a clinician decides.'),
      point('adverse-effects', 'Dyspepsia, gastric irritation, gastrointestinal bleeding, raised blood pressure, fluid retention, and reduced renal function in susceptible people. The fictional pain fits gastric irritation as a teaching link, not as a confirmed diagnosis.'),
      point('interactions', 'Low-dose aspirin plus an NSAID raises gastrointestinal risk in teaching. Ibuprofen taken around the same time as low-dose aspirin can also reduce aspirin\'s antiplatelet effect. Anticoagulants would raise bleeding risk further. These are discussion points, not a reason for this page to stop anyone\'s aspirin.'),
      point('monitoring', 'Study monitoring is symptom change, black stools, vomiting of blood, swelling, and breathlessness. A prescriber may check haemoglobin or renal function when those concerns exist. No monitoring order is made here.'),
      point('counseling', 'Class points: take the NSAID with food in textbook examples, do not add another NSAID, report black stools or vomiting of blood, and do not stop prescribed aspirin without the prescriber. These are not instructions for a real person tonight.'),
      point('dose-calculation', 'The worksheet count is ibuprofen 400 mg three times daily for 5 days, which is 15 tablets of 400 mg. Checking units and arithmetic is the skill. The count is not a quantity to dispense or take.'),
      point('therapeutic-reasoning', 'A class can weigh pain control against gastric risk, and can name that a prescriber might discuss gastroprotection or a different analgesic. The weighing is the exercise. The choice is not made on this page.'),
      point('differential', 'Teaching differentials for epigastric burning include dyspepsia, reflux, and ulcer disease. In an older adult, upper abdominal pain is not always the stomach. This case does not establish a diagnosis.'),
    ],
    questions: [
      {
        id: 'ibu-what',
        prompt: 'What is the presenting problem in this study case?',
        answerKey: 'epigastric|upper abdomen|upper abdominal',
        modelAnswer: 'Model answer: burning pain in the upper abdomen in a fictional person who has been taking ibuprofen. The study point is NSAID gastric irritation, not a diagnosis to apply to anyone else.',
        step: 'what',
      },
      {
        id: 'ibu-why',
        prompt: 'Which enzyme is the teaching target of ibuprofen in this case?',
        answerKey: 'cox|cyclo-oxygenase|cyclooxygenase',
        modelAnswer: 'Model answer: cyclo-oxygenase (COX). Inhibiting it lowers protective prostaglandins in the gastric mucosa. That is a mechanism note, not a reason to change someone\'s medicines.',
        topic: 'mechanism',
        step: 'why',
      },
      {
        id: 'ibu-flag',
        prompt: 'Name one red flag that means urgent assessment, not an answer from this app.',
        answerKey: 'black stool|melaena|melena|vomiting blood|haematemesis|hematemesis|faint',
        modelAnswer: 'Model answer: vomiting of blood, black stools, fainting, or severe sudden pain. The learning point is urgent clinical assessment. This app must not manage that person.',
        step: 'assess',
      },
      {
        id: 'ibu-bound',
        prompt: 'What must this page not do with the fictional case?',
        answerKey: 'not treat|not a real|qualified|not prescribe|must not',
        modelAnswer: 'Model answer: it must not treat a real person, choose a medicine, or replace a qualified clinician. It only supports study of a fictional case.',
        step: 'therapy',
      },
    ],
    doseExercise: {
      id: 'ibu-count',
      prompt: 'Worksheet count only. The notes say 400 mg three times daily for 5 days. How many 400 mg tablets is that count?',
      working: '5 days × 3 doses = 15 tablets of 400 mg on the worksheet. This counts tablets in a study problem. It is not an instruction to dispense, take, or prescribe that number.',
      expected: 15,
      unit: 'tablets',
    },
    safetyNote: 'Mrs A. is fictional. Vomiting of blood, black stools, fainting, or severe pain means urgent clinical assessment, not this page.',
    createdAt: '2026-01-15T00:00:00.000Z',
  },
  {
    id: 'builtin-inhalers',
    title: 'Study case: Reliever and preventer inhalers',
    fictional: true,
    origin: 'builtin',
    presentation:
      'A class role-play. A fictional 19-year-old, Mr B., is speaking in full sentences. He asks which inhaler to use first when he wheezes. He is not acutely breathless in the scenario.',
    symptoms: 'Occasional wheeze in the role-play. He can finish his sentences. No blue lips are described.',
    history:
      'The scenario says he uses a salbutamol inhaler often and rarely uses a beclometasone inhaler that was already supplied. No other medicines are listed.',
    findings: 'The teaching note says he is talking comfortably. There is no description of respiratory distress.',
    labs: 'No laboratory information is part of this role-play.',
    medicines: [
      { name: 'Salbutamol inhaler', detail: 'used often in the scenario when he wheezes' },
      { name: 'Beclometasone inhaler', detail: 'present in the scenario as a preventer, rarely used' },
    ],
    problems: [
      'The role-play mixes a reliever with a preventer that is rarely used.',
      'A student must not start, stop, or change either inhaler for a real person.',
      'If someone cannot speak in sentences or is getting worse, the learning point is emergency care.',
    ],
    steps: [
      step('what', 'The study problem is a role-play question: which inhaler is for symptoms now, and which is the preventer. Mr B. is fictional and is speaking comfortably.'),
      step('where', 'The relevant site is bronchial smooth muscle for the reliever, and inflamed airways for the preventer. The setting is a classroom, not an emergency.'),
      step('why', 'Salbutamol stimulates beta-2 receptors and relaxes airway smooth muscle, so teaching calls it a reliever. Beclometasone is an inhaled corticosteroid. It reduces inflammation over time, so it is not a rescue medicine.'),
      step('how', 'In the role-play he reaches for salbutamol when he wheezes because that medicine acts on the airway muscle within minutes in teaching. The steroid inhaler does not do that job.'),
      step('assess', 'Note how often the reliever is used, whether he can speak in sentences, and whether symptoms are worsening. Blue lips, inability to speak, or worsening breathlessness means emergency care. Do not keep studying the case instead.'),
      step('therapy', 'A class can separate rescue bronchodilation from regular preventive treatment, and can say that frequent reliever use is a reason to discuss the preventer with a prescriber. No inhaler is started, stopped, or dose-changed here.'),
      step('monitoring', 'Study checks are reliever frequency, ability to speak, and whether symptoms are rising. Rising reliever use is a signal to review the preventer with a prescriber, not to change a dose on this page.'),
      step('counseling', 'Rehearse: the reliever is for symptoms in the role-play; the preventer is regular treatment as already prescribed, not for sudden wheeze; rinse the mouth after the steroid inhaler; emergency signs need emergency care, not this app.'),
    ],
    pharmacy: [
      point('mechanism', 'Salbutamol is a short-acting beta-2 agonist. It relaxes bronchial smooth muscle, which is why teaching calls it a reliever. Beclometasone is an inhaled corticosteroid. It reduces airway inflammation over time, which is why it is not a rescue medicine.'),
      point('indications', 'In teaching, salbutamol relieves wheeze. An inhaled corticosteroid is a preventer when a prescriber has chosen regular treatment. The scenario already has both. This page does not start either one.'),
      point('contraindications', 'Study notes for a salbutamol product include hypersensitivity to that product. Acute severe breathlessness is not a list to work through at home. It is a reason for emergency care.'),
      point('adverse-effects', 'Salbutamol can cause tremor and a fast heart rate. An inhaled corticosteroid can cause hoarseness and oral thrush, which is why teaching says to rinse the mouth after use.'),
      point('interactions', 'Non-selective beta blockers can oppose salbutamol in teaching discussions. This scenario does not list a beta blocker. Do not add medicines to the fictional person from this page.'),
      point('monitoring', 'Study checks are how often the reliever is needed, whether speech is limited by breathlessness, and whether symptoms are worsening. No home monitoring plan is prescribed here.'),
      point('counseling', 'Rehearse the difference between reliever and preventer, rinsing after the steroid inhaler, and seeking emergency care if a person cannot speak in sentences, has blue lips, or is getting worse. Do not tell a real person to wait and read this page.'),
      point('dose-calculation', 'The worksheet says 2 puffs, twice a day, for 7 days, which is 28 puffs. That is arithmetic. It is not Mr B.\'s dose and not a regimen to start.'),
      point('therapeutic-reasoning', 'A class can separate rescue bronchodilation from preventive anti-inflammatory treatment. Frequent reliever use is a reason to review the preventer with a prescriber. No inhaler is changed here.'),
      point('differential', 'Wheeze in a teaching case can be discussed as asthma, but the scenario does not prove the diagnosis. Other causes of breathlessness exist. Acute severe breathlessness is an emergency, not a differential to finish in the app.'),
    ],
    questions: [
      {
        id: 'inh-reliever',
        prompt: 'Which inhaler is the reliever in this role-play?',
        answerKey: 'salbutamol',
        modelAnswer: 'Model answer: salbutamol. It is the short-acting bronchodilator in the scenario. Naming it is a study point, not an instruction to use it.',
        topic: 'indications',
        step: 'what',
      },
      {
        id: 'inh-receptor',
        prompt: 'Which receptor does salbutamol stimulate in this teaching note?',
        answerKey: 'beta-2|beta2|beta 2',
        modelAnswer: 'Model answer: the beta-2 receptor on bronchial smooth muscle. That is why teaching calls the effect bronchodilation.',
        topic: 'mechanism',
        step: 'why',
      },
      {
        id: 'inh-flag',
        prompt: 'Name one sign that means emergency care rather than more study.',
        answerKey: 'blue|cannot speak|can\'t speak|too breathless|emergency|getting worse',
        modelAnswer: 'Model answer: inability to speak in sentences, blue lips, or breathlessness that is getting worse. The learning point is emergency care, not a reply from this app.',
        step: 'assess',
      },
      {
        id: 'inh-preventer',
        prompt: 'Why is the corticosteroid inhaler not the rescue medicine in this case?',
        answerKey: 'inflammation|preventer|not immediate|not a reliever|not rescue',
        modelAnswer: 'Model answer: it reduces inflammation over time. It does not relax airway muscle within minutes, so teaching does not use it as the reliever.',
        topic: 'mechanism',
        step: 'how',
      },
    ],
    doseExercise: {
      id: 'inh-count',
      prompt: 'Worksheet count only. A label in the notes says 2 puffs, twice a day, for 7 days. How many puffs is that count?',
      working: '2 × 2 × 7 = 28 puffs on the worksheet. This is not a regimen to start, and it is not this fictional person\'s dose.',
      expected: 28,
      unit: 'puffs',
    },
    safetyNote: 'Mr B. is fictional and is speaking comfortably. If a real person cannot speak in sentences, has blue lips, or is getting worse, seek emergency care. Do not manage that from this page.',
    createdAt: '2026-01-15T00:00:00.000Z',
  },
];

const BUILTIN_IDS = new Set(BUILTIN_CASES.map((item) => item.id));

export function isBuiltinCase(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

export function orderedSteps(steps: ClinicalStep[] | undefined): ClinicalStep[] {
  return CLINICAL_STEPS.map((meta) => steps?.find((item) => item.id === meta.id) ?? { id: meta.id, explanation: '' });
}

export function orderedPharmacy(points: PharmacyPoint[] | undefined): PharmacyPoint[] {
  return PHARMACY_TOPICS.map((meta) => points?.find((item) => item.id === meta.id) ?? { id: meta.id, text: '' });
}

export function stepMeta(id: ClinicalStepId) {
  return CLINICAL_STEPS.find((item) => item.id === id) ?? CLINICAL_STEPS[0];
}

export function pharmacyMeta(id: PharmacyTopicId) {
  return PHARMACY_TOPICS.find((item) => item.id === id) ?? PHARMACY_TOPICS[0];
}

export function parseMedicines(text: string): ClinicalMedicine[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, ...rest] = line.split(/\s+[—–-]\s+/);
    const detail = rest.join(' — ').trim();
    return { name: name.trim(), detail: detail || undefined };
  }).filter((item) => item.name);
}

export function parseLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function createCase(draft: ClinicalCaseDraft, now = new Date().toISOString()): ClinicalCase {
  const stamp = now.replace(/[^0-9]/g, '').slice(0, 14);
  return {
    id: draft.id?.trim() || `case-${stamp || 'local'}`,
    title: draft.title.trim() || 'Untitled study case',
    fictional: true,
    origin: 'manual',
    courseId: draft.courseId || undefined,
    topicId: draft.topicId || undefined,
    semester: draft.semester?.trim() || undefined,
    presentation: draft.presentation.trim(),
    symptoms: draft.symptoms?.trim() ?? '',
    history: draft.history?.trim() ?? '',
    findings: draft.findings?.trim() ?? '',
    labs: draft.labs?.trim() ?? '',
    medicines: draft.medicines ?? [],
    problems: (draft.problems ?? []).map((item) => item.trim()).filter(Boolean),
    steps: orderedSteps(draft.steps),
    pharmacy: orderedPharmacy(draft.pharmacy),
    questions: (draft.questions ?? []).filter((item) => item.prompt.trim()).map((item, index) => ({
      ...item,
      id: item.id || `q-${stamp}-${index + 1}`,
      prompt: item.prompt.trim(),
      modelAnswer: item.modelAnswer.trim(),
      answerKey: item.answerKey?.trim() || undefined,
    })),
    doseExercise: draft.doseExercise?.prompt.trim() ? {
      ...draft.doseExercise,
      id: draft.doseExercise.id || `dose-${stamp}`,
      prompt: draft.doseExercise.prompt.trim(),
      working: draft.doseExercise.working.trim() || PRACTICE_DOSE_NOTE,
    } : undefined,
    safetyNote: draft.safetyNote?.trim() || EDUCATIONAL_DISCLAIMER,
    createdAt: draft.createdAt || now,
    updatedAt: now,
  };
}

export function duplicateCase(item: ClinicalCase, now = new Date().toISOString()): ClinicalCase {
  const stamp = now.replace(/[^0-9]/g, '').slice(0, 14);
  return createCase({
    title: `Copy of ${item.title}`,
    presentation: item.presentation,
    symptoms: item.symptoms,
    history: item.history,
    findings: item.findings,
    labs: item.labs,
    medicines: item.medicines,
    problems: item.problems,
    steps: item.steps,
    pharmacy: item.pharmacy,
    questions: item.questions.map((question, index) => ({ ...question, id: `q-${stamp}-${index + 1}` })),
    doseExercise: item.doseExercise ? { ...item.doseExercise, id: `dose-${stamp}` } : undefined,
    courseId: item.courseId,
    topicId: item.topicId,
    semester: item.semester,
    safetyNote: item.safetyNote,
    createdAt: now,
  }, now);
}

const REAL_PATIENT_REQUESTS = [
  /\b(my|our)\s+(patient|mum|mom|mother|dad|father|grandmother|grandfather|grandma|grandpa|child|son|daughter|wife|husband|brother|sister|nan|nana)\b/i,
  /\bpatient of mine\b/i,
  /\b(this|the)\s+patient\s+in\s+front\s+of\s+me\b/i,
  /\bwhat (dose|drug|medicine|treatment) should i (give|start|prescribe|use)\b/i,
  /\b(prescribe|dose)\s+(for|to)\s+(my|him|her|them)\b/i,
  /\btreat\s+(him|her|them|my)\b/i,
  /\bhow should i treat\b/i,
  /\bcan you (prescribe|dose|treat)\b/i,
  /\bi have a (real |actual )?patient\b/i,
  /\breal patient\b/i,
];

/** True when the text is asking for care of a real person, not studying a fictional case. */
export function looksLikeRealPatientRequest(text: string): boolean {
  const cleaned = text
    .split(EDUCATIONAL_DISCLAIMER).join('')
    .split(NOT_A_PRESCRIPTION).join('')
    .replace(/\bnot\s+(advice\s+for\s+)?a\s+real\s+patient\b/gi, '')
    .replace(/\bdo not treat\b/gi, '');
  return REAL_PATIENT_REQUESTS.some((pattern) => pattern.test(cleaned));
}

export function narrativeOf(item: Pick<ClinicalCase, 'title' | 'presentation' | 'symptoms' | 'history' | 'findings' | 'labs' | 'medicines' | 'problems'>): string {
  return [
    item.title,
    item.presentation,
    item.symptoms,
    item.history,
    item.findings,
    item.labs,
    item.medicines.map((medicine) => `${medicine.name} ${medicine.detail ?? ''}`).join('\n'),
    item.problems.join('\n'),
  ].join('\n');
}

/** A saved case must be a fictional study note, not a request to treat someone. */
export function caseIsStudyMaterial(item: Pick<ClinicalCase, 'title' | 'presentation' | 'symptoms' | 'history' | 'findings' | 'labs' | 'medicines' | 'problems'>): boolean {
  return item.title.trim().length > 0
    && item.presentation.trim().length > 0
    && !looksLikeRealPatientRequest(narrativeOf(item));
}

export function savedCases(state: Pick<AppState, 'clinicalCases'>): ClinicalCase[] {
  return (state.clinicalCases ?? []).filter((item): item is ClinicalCase =>
    !!item
    && typeof item.id === 'string'
    && typeof item.title === 'string'
    && typeof item.presentation === 'string'
    && !BUILTIN_IDS.has(item.id),
  );
}

export function visibleCases(state: Pick<AppState, 'clinicalCases'>): ClinicalCase[] {
  return [...BUILTIN_CASES, ...savedCases(state)];
}

export function caseById(state: Pick<AppState, 'clinicalCases'>, id: string): ClinicalCase | undefined {
  return visibleCases(state).find((item) => item.id === id);
}

export function attemptsFor(state: Pick<AppState, 'clinicalAttempts'>, caseId: string): ClinicalAttempt[] {
  return (state.clinicalAttempts ?? []).filter((item) => item.caseId === caseId);
}

export interface AnswerReview {
  matched: boolean | null;
  refused: boolean;
  showModelAnswer: boolean;
  feedback: string;
}

export function reviewAnswer(question: ClinicalQuestion, raw: string): AnswerReview {
  const answer = raw.trim();
  if (looksLikeRealPatientRequest(answer)) {
    return {
      matched: null,
      refused: true,
      showModelAnswer: false,
      feedback: `${NOT_A_PRESCRIPTION} This box reviews the fictional case. It will not answer that.`,
    };
  }
  if (!answer) {
    return {
      matched: question.answerKey ? false : null,
      refused: false,
      showModelAnswer: true,
      feedback: 'Nothing to compare yet. The model answer is for this fictional case only.',
    };
  }
  if (!question.answerKey) {
    return {
      matched: null,
      refused: false,
      showModelAnswer: true,
      feedback: 'Compare your note with the model answer. This question is not auto-marked. The model answer is for this fictional case only.',
    };
  }
  const keys = question.answerKey.split('|').map((key) => key.trim().toLowerCase()).filter(Boolean);
  const hay = answer.toLowerCase();
  const matched = keys.some((key) => hay.includes(key));
  return {
    matched,
    refused: false,
    showModelAnswer: true,
    feedback: matched
      ? 'The study key is in your answer. Read the model answer for the rest of the point. It applies only to this fictional case.'
      : 'The study key was not found. Read the model answer, then try the idea in your own words. It applies only to this fictional case.',
  };
}

export interface PracticeReviewItem extends AnswerReview {
  questionId: string;
  prompt: string;
  answer: string;
  modelAnswer: string;
}

export function reviewPractice(
  item: ClinicalCase,
  answers: { questionId: string; answer: string }[],
): PracticeReviewItem[] {
  return item.questions.map((question) => {
    const found = answers.find((answer) => answer.questionId === question.id);
    return {
      questionId: question.id,
      prompt: question.prompt,
      answer: found?.answer ?? '',
      modelAnswer: question.modelAnswer,
      ...reviewAnswer(question, found?.answer ?? ''),
    };
  });
}

export interface DoseGrade {
  ok: boolean;
  expected: number;
  unit: string;
  working: string;
  note: string;
}

export function gradeDose(exercise: DoseExercise, raw: string): DoseGrade {
  if (looksLikeRealPatientRequest(raw)) {
    return {
      ok: false,
      expected: exercise.expected,
      unit: exercise.unit,
      working: exercise.working,
      note: `${NOT_A_PRESCRIPTION} This check only marks the worksheet count.`,
    };
  }
  const entered = Number(String(raw).trim());
  const tolerance = exercise.tolerance ?? 0;
  const ok = Number.isFinite(entered) && Math.abs(entered - exercise.expected) <= tolerance;
  return {
    ok,
    expected: exercise.expected,
    unit: exercise.unit,
    working: exercise.working,
    note: PRACTICE_DOSE_NOTE,
  };
}

export interface ClinicalSource {
  kind: 'clinical-case';
  label: string;
  materialId: string;
}

export interface ClinicalContextBlock {
  label: string;
  text: string;
  source: ClinicalSource;
}

/** Controlled context for a future tutor. Nothing here is sent to a provider. */
export interface ClinicalContext {
  blocks: ClinicalContextBlock[];
  sources: ClinicalSource[];
  estimatedTokens: number;
  truncated: false;
  warnings: string[];
  provider: null;
  offline: true;
  generated: false;
  disclaimer: string;
}

export interface ClinicalFocus {
  step?: ClinicalStepId;
  topic?: PharmacyTopicId;
  questionId?: string;
  includePractice?: boolean;
}

function pushBlock(blocks: ClinicalContextBlock[], label: string, text: string, caseId: string) {
  const body = text.trim();
  if (!body) return;
  blocks.push({
    label,
    text: body,
    source: { kind: 'clinical-case', label, materialId: caseId },
  });
}

export function clinicalContext(item: ClinicalCase, focus: ClinicalFocus = {}): ClinicalContext {
  const blocks: ClinicalContextBlock[] = [];
  pushBlock(
    blocks,
    'Educational boundary',
    `${EDUCATIONAL_DISCLAIMER} ${NOT_A_PRESCRIPTION} Stay on this fictional study case. Name the block you use. Do not give a dose or a treatment plan for a real person.`,
    item.id,
  );
  pushBlock(blocks, 'Study case', `${item.title}. Fictional study case. Origin: ${item.origin}.`, item.id);
  pushBlock(blocks, 'Patient presentation', item.presentation, item.id);
  pushBlock(blocks, 'Symptoms', item.symptoms, item.id);
  pushBlock(blocks, 'History', item.history, item.id);
  pushBlock(blocks, 'Relevant findings', item.findings, item.id);
  pushBlock(blocks, 'Laboratory information', item.labs, item.id);
  pushBlock(
    blocks,
    'Current medicines',
    item.medicines.map((medicine) => medicine.detail ? `${medicine.name} — ${medicine.detail}` : medicine.name).join('\n'),
    item.id,
  );
  pushBlock(blocks, 'Potential problems', item.problems.map((problem) => `- ${problem}`).join('\n'), item.id);
  if (item.safetyNote) pushBlock(blocks, 'Case safety note', item.safetyNote, item.id);

  for (const entry of orderedSteps(item.steps)) {
    const meta = stepMeta(entry.id);
    pushBlock(blocks, `Step: ${meta.label}`, `${meta.prompt}\n\n${entry.explanation}`.trim(), item.id);
  }
  for (const entry of orderedPharmacy(item.pharmacy)) {
    const meta = pharmacyMeta(entry.id);
    pushBlock(blocks, `Pharmacy: ${meta.label}`, entry.text, item.id);
  }
  if (item.doseExercise) {
    pushBlock(
      blocks,
      'Practice calculation',
      `${item.doseExercise.prompt}\n\n${item.doseExercise.working}\n\n${PRACTICE_DOSE_NOTE}`,
      item.id,
    );
  }
  if (focus.includePractice) {
    for (const question of item.questions) {
      const showAnswer = focus.questionId === question.id;
      pushBlock(
        blocks,
        showAnswer ? 'Model answer (study review only)' : 'Practice question',
        showAnswer
          ? `${question.prompt}\n\n${question.modelAnswer}\n\nThis model answer is for the fictional case only.`
          : question.prompt,
        item.id,
      );
    }
  }

  const focusLabel = focus.step
    ? `Step: ${stepMeta(focus.step).label}`
    : focus.topic
      ? `Pharmacy: ${pharmacyMeta(focus.topic).label}`
      : '';
  if (focusLabel) {
    const index = blocks.findIndex((block) => block.label === focusLabel);
    if (index > 1) {
      const [picked] = blocks.splice(index, 1);
      blocks.splice(1, 0, picked);
    }
  }

  const chars = blocks.reduce((sum, block) => sum + block.text.length, 0);
  const warnings: string[] = [];
  if (looksLikeRealPatientRequest(narrativeOf(item))) {
    warnings.push('This text looks like a real-patient request. A tutor must refuse treatment advice and stay on the study case.');
  }
  warnings.push('No provider was called. A future tutor must use these labelled blocks and name them.');

  return {
    blocks,
    sources: blocks.map((block) => block.source),
    estimatedTokens: Math.ceil(chars / 4),
    truncated: false,
    warnings,
    provider: null,
    offline: true,
    generated: false,
    disclaimer: `${EDUCATIONAL_DISCLAIMER} ${NOT_A_PRESCRIPTION}`,
  };
}

export function formatClinicalContext(ctx: ClinicalContext): string {
  return [
    ctx.disclaimer,
    '',
    ...ctx.blocks.map((block) => `--- ${block.label} ---\n${block.text}`),
    '',
    `Sources: ${ctx.sources.map((source) => source.label).join('; ')}`,
  ].join('\n');
}

export function caseSearchText(item: ClinicalCase): string {
  const medicines = Array.isArray(item.medicines) ? item.medicines : [];
  const problems = Array.isArray(item.problems) ? item.problems : [];
  const steps = Array.isArray(item.steps) ? item.steps : [];
  const pharmacy = Array.isArray(item.pharmacy) ? item.pharmacy : [];
  const questions = Array.isArray(item.questions) ? item.questions : [];
  return [
    item.title,
    item.presentation,
    item.symptoms,
    item.history,
    item.findings,
    item.labs,
    medicines.map((medicine) => `${medicine.name} ${medicine.detail ?? ''}`).join(' '),
    problems.join(' '),
    steps.map((entry) => entry.explanation).join(' '),
    pharmacy.map((entry) => entry.text).join(' '),
    questions.map((question) => question.prompt).join(' '),
  ].join('\n');
}

/**
 * PharmaTRACK AI — the academic intelligence workspace.
 *
 * This is deliberately not "a chatbox page". It is the study surface that the
 * engine powers: pick what you are working on (course → topic → material), see
 * the context that will be sent, then run one of the study / practice / revision
 * tasks — all through the same provider-independent engine the readers use.
 *
 * The page loads *lazily*: no PDFs, PPTs or extracted text are touched until a
 * material is opened, and its full text is fetched from IndexedDB on demand.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, ChevronLeft, FileText, History, Layers, MessageSquarePlus, Sparkles } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useApp } from '../context/AppContext';
import { loadSlideText } from '../utils/storage';
import AIChatPanel from '../components/AIChatPanel';
import { useAI } from '../ai/state';
import {
  formatTokens,
  listConversations,
  loadConversation,
  type AIConversation,
  type ConversationMeta,
  type ContextSelection,
} from '../ai';
import type { AppStateLike } from '../ai';

const AiAssistant: React.FC = () => {
  const { state, getSlidesForTopic } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const ai = useAI();

  const topicId = params.get('topic') ?? undefined;
  const materialId = params.get('material') ?? undefined;
  const courseId = params.get('course') ?? undefined;
  const conversationId = params.get('conversation') ?? undefined;
  /** Question-bank ids handed over by “Ask AI about these” on the bank page. */
  const questionIds = (params.get('questions') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  const replaceParams = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (!value) next.delete(key);
      else next.set(key, value);
    }
    setParams(next);
  }, [params, setParams]);

  const topic = state.topics.find((t) => t.id === topicId);
  const course = state.courses.find((c) => c.id === (topic?.courseId ?? courseId));
  const materials = useMemo(
    () => (topicId ? getSlidesForTopic(topicId) : []),
    [getSlidesForTopic, topicId],
  );
  const material = materials.find((m) => m.id === materialId);
  const [materialText, setMaterialText] = useState<string | null>(null);

  // Load the full text of the selected material only when it is selected.
  useEffect(() => {
    let cancelled = false;
    if (!material?.id) {
      setMaterialText(null);
      return;
    }
    loadSlideText(material.id)
      .then((text) => {
        if (!cancelled) setMaterialText(text ?? material.contentText ?? '');
      })
      .catch(() => {
        if (!cancelled) setMaterialText(material.contentText ?? '');
      });
    return () => {
      cancelled = true;
    };
  }, [material?.id, material?.contentText]);

  const appState = state as unknown as AppStateLike;

  /** The bank questions the student attached, shown before anything is sent. */
  const attachedQuestions = useMemo(
    () =>
      questionIds.length
        ? (state.examQuestions ?? []).filter((q) => questionIds.includes(q.id)).slice(0, 8)
        : [],
    [questionIds.join(','), state.examQuestions],
  );

  const scope: ContextSelection = useMemo(
    () => ({
      topicId,
      courseId: course?.id,
      materialId: material?.id,
      materialText: material
        ? { label: `${material.title}`, text: materialText ?? material.contentText ?? '' }
        : undefined,
      questionIds: questionIds.length ? questionIds : undefined,
    }),
    // questionIds is rebuilt from the URL on every render, so depend on its text.
    [course?.id, material, materialText, topicId, questionIds.join(',')],
  );

  const ready = ai.providers.filter((p) => p.usable);

  /*
   * Chat history. Conversations are academic data stored away from AppState and
   * away from the providers, so they open unchanged whichever provider wrote
   * them — and they are readable with the network off.
   */
  const [history, setHistory] = useState<ConversationMeta[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openConversation, setOpenConversation] = useState<AIConversation | null>(null);

  const refreshHistory = useCallback(() => {
    listConversations()
      .then(setHistory)
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  const openHistoryEntry = useCallback(async (id: string) => {
    const conversation = await loadConversation(id);
    if (!conversation) return;
    setOpenId(id);
    setOpenConversation(conversation);
  }, []);

  useEffect(() => {
    if (!conversationId || conversationId === openId) return;
    void openHistoryEntry(conversationId);
  }, [conversationId, openId, openHistoryEntry]);

  const startNewChat = useCallback(() => {
    setOpenId(null);
    setOpenConversation(null);
    replaceParams({ conversation: null });
  }, [replaceParams]);

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <div className="bg-gradient-to-r from-[#0F172A] to-[#1B4332] rounded-2xl p-5 text-white flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4 text-[#FFB703]" />
            <span className="text-[10px] font-black uppercase tracking-widest text-[#FFB703]">
              Academic intelligence layer
            </span>
          </div>
          <h1 className="text-xl font-bold">PharmaTRACK AI</h1>
          <p className="text-xs text-gray-300 mt-1">
            {ready.length
              ? `${ready.length} provider${ready.length === 1 ? '' : 's'} ready · ${ai.activeProfile.name}`
              : 'No provider configured yet — add one in Settings → AI'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => navigate('/settings?tab=ai')}
            className="px-3 py-2 bg-white/10 hover:bg-white/20 rounded-xl text-xs font-bold"
          >
            AI Settings
          </button>
          {topic && (
            <button
              onClick={() => navigate(`/read/${topic.id}`)}
              className="px-3 py-2 bg-[#FFB703] text-[#1B4332] rounded-xl text-xs font-bold"
            >
              Open reader
            </button>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-[320px_1fr] gap-4">
        {/* Picker: course → topic → material */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3 h-fit">
          <p className="text-[11px] font-black uppercase tracking-widest text-gray-400">What are you studying?</p>

          <label className="block">
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Course</span>
            <select
              value={course?.id ?? ''}
              onChange={(e) => replaceParams({ course: e.target.value || null, topic: null, material: null })}
              className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#2D6A4F]"
            >
              <option value="">— all courses —</option>
              {state.courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.courseCode ? `${c.courseCode} — ` : ''}
                  {c.courseName}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Topic</span>
            <select
              value={topicId ?? ''}
              onChange={(e) => replaceParams({ topic: e.target.value || null, material: null })}
              className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#2D6A4F]"
            >
              <option value="">— all topics —</option>
              {state.topics
                .filter((t) => !course || t.courseId === course.id)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.topicName}
                  </option>
                ))}
            </select>
          </label>

          {topicId && (
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Material</span>
              <div className="mt-1 space-y-1 max-h-64 overflow-y-auto">
                {materials.length === 0 && (
                  <p className="text-[11px] text-gray-400">No materials in this topic yet.</p>
                )}
                {materials.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => replaceParams({ material: m.id })}
                    className={`w-full flex items-center gap-2 p-2 rounded-lg text-left text-xs border ${
                      m.id === materialId
                        ? 'border-[#2D6A4F] bg-[#2D6A4F]/5 font-bold'
                        : 'border-gray-100 hover:bg-gray-50'
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    <span className="truncate">{m.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {attachedQuestions.length > 0 && (
            <div className="pt-2 border-t border-gray-100">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                  Questions in scope
                </span>
                <button
                  onClick={() => replaceParams({ questions: null })}
                  className="text-[10px] font-bold text-gray-400 hover:text-red-600"
                >
                  Clear
                </button>
              </div>
              <ul className="space-y-1">
                {attachedQuestions.map((q) => (
                  <li key={q.id} className="p-2 rounded-lg border border-gray-100 text-[11px] text-gray-700">
                    {q.questionText}
                  </li>
                ))}
              </ul>
              <p className="text-[10px] text-gray-400 mt-1">
                Only these questions are sent, with the course and topic above.
              </p>
            </div>
          )}

          <div className="pt-2 border-t border-gray-100 text-[11px] text-gray-500 space-y-1">
            <p className="flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5" />
              {materials.length} material{materials.length === 1 ? '' : 's'} in scope
            </p>
            <p className="flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5" />
              {formatTokens(estimateScopeTokens(materialText, material?.contentText))} of material text
            </p>
          </div>

          {/* Chat history: local, provider-independent, readable offline. */}
          <div className="pt-3 border-t border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] font-black uppercase tracking-widest text-gray-400 flex items-center gap-1.5">
                <History className="w-3.5 h-3.5" /> History
              </p>
              <button
                onClick={startNewChat}
                className="flex items-center gap-1 text-[10px] font-bold text-[#2D6A4F] hover:underline"
              >
                <MessageSquarePlus className="w-3 h-3" /> New
              </button>
            </div>
            {history.length === 0 && (
              <p className="text-[11px] text-gray-400">Your past AI conversations will appear here.</p>
            )}
            <div className="space-y-1 max-h-56 overflow-y-auto" data-testid="ai-history">
              {history.slice(0, 12).map((meta) => (
                <button
                  key={meta.id}
                  onClick={() => replaceParams({ conversation: meta.id })}
                  className={`w-full text-left p-2 rounded-lg border text-[11px] ${
                    meta.id === openId ? 'border-[#2D6A4F] bg-[#2D6A4F]/5' : 'border-gray-100 hover:bg-gray-50'
                  }`}
                >
                  <p className="font-bold text-gray-700 truncate">{meta.title}</p>
                  <p className="text-[9px] text-gray-400 uppercase font-black tracking-wider truncate">
                    {[meta.providerId?.toUpperCase(), meta.model, `${meta.messageCount} msg`]
                      .filter(Boolean)
                      .join(' • ')}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* The engine-powered panel */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden min-h-[560px] flex flex-col">
          <AIChatPanel
            key={openId ?? 'new'}
            initialConversation={openConversation}
            scope={scope}
            appState={appState}
            title={material ? material.title : topic ? topic.topicName : 'PharmaTRACK AI'}
            loadMaterialText={material?.id ? (id) => loadSlideText(id) : undefined}
            quickTasks={[
              'explain',
              'simplify',
              'summarize',
              'mcq',
              'flashcards',
              'short-answer',
              'weak-topics',
              'revision-summary',
              'mechanism',
              'adverse-effects',
              'clinical-reasoning',
            ]}
            onAnswered={() => {
              /* answers live in the panel; saving as a note stays a user choice */
            }}
            onMessage={() => {
              // Keep the history list in step without reloading any body text.
              refreshHistory();
            }}
          />
        </div>
      </div>

      <div className="text-center pb-2">
        <button
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1 text-xs font-bold text-gray-400 hover:text-[#2D6A4F]"
        >
          <ChevronLeft className="w-3.5 h-3.5" /> Back
        </button>
      </div>
    </div>
  );
};

function estimateScopeTokens(...texts: Array<string | undefined | null>): number {
  const chars = texts.reduce((sum, text) => sum + (text?.length ?? 0), 0);
  return Math.ceil(chars / 3.6);
}

export default AiAssistant;

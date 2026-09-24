/**
 * PharmaTRACK AI — the chat surface used inside the readers and the AI
 * workspace.
 *
 * It renders whatever the engine gives back and nothing else: it never builds a
 * request, never picks a provider and never touches a key. The engine supplies
 * the text (streamed or not), the provider/model that produced it, the fallback
 * notice, the error report and the context manifest — this component just shows
 * them, with Stop, Retry and "what was sent" transparency built in.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, BookOpen, Brain, CheckCircle2, ChevronDown, GraduationCap, Lightbulb,
  Loader2, RefreshCw, Send, Square, Sparkles, Stethoscope, WifiOff, X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import {
  AI_TASKS,
  aiManager,
  appendMessage,
  buildContext,
  buildTaskRequest,
  formatTokens,
  newConversation,
  profileById,
  replaceMessage,
  retrieveForSelection,
  saveConversation,
  taskById,
  tasksInGroup,
  type AIChatMessage,
  type AIConversation,
  type AIContextSource,
  type AIContextKind,
  type AIErrorReport,
  type AITaskId,
  type AppStateLike,
  type ContextSelection,
  type RetrievalHit,
} from '../ai';
import { AIEngineError, reportFor } from '../ai/errors';
import { useAI, useAIStatus, useOnline } from '../ai/state';

export interface AIChatPanelProps {
  /** Academic scope for the context builder. */
  scope: ContextSelection;
  /** App state slice used to build context (the panel never sends state itself). */
  appState: AppStateLike;
  /** Loads the full text of a material (IndexedDB) when it exceeds the inline copy. */
  loadMaterialText?: (materialId: string) => Promise<string | null>;
  /** Compact header used inside the readers. */
  compact?: boolean;
  /** Called when a reply arrives, e.g. to offer “save as note”. */
  onAnswered?: (message: AIChatMessage) => void;
  /**
   * Called for every message (user and assistant) as it lands, so a host page
   * can mirror the transcript into its own store (e.g. the topic chat history
   * that ends up in semester archives) without owning the AI request.
   */
  onMessage?: (message: AIChatMessage) => void;
  className?: string;
  /** Task buttons to show above the composer. */
  quickTasks?: AITaskId[];
  title?: string;
  /**
   * Reopens a stored conversation instead of starting an empty one. Its
   * messages keep the provider/model they were written with, so history stays
   * readable after switching providers.
   */
  initialConversation?: AIConversation | null;
}

/** Label for the material in focus, used in the context block headers. */
const materialLabel = (scope: ContextSelection): string => {
  if (scope.materialText?.label) return scope.materialText.label;
  if (scope.slide) return `Slide ${scope.slide}`;
  if (scope.page) return `Page ${scope.page}`;
  return 'Material';
};

const TASK_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  study: BookOpen,
  practice: Brain,
  revision: GraduationCap,
  document: Lightbulb,
  pharmacy: Stethoscope,
};

const GROUP_LABELS: Record<string, string> = {
  study: 'Study',
  practice: 'Practice',
  revision: 'Revision',
  document: 'This material',
  pharmacy: 'Pharmacy learning',
};

export const AIChatPanel: React.FC<AIChatPanelProps> = ({
  scope,
  appState,
  loadMaterialText,
  compact = false,
  onAnswered,
  onMessage,
  className = '',
  quickTasks,
  title = 'PharmaTRACK AI',
  initialConversation = null,
}) => {
  const navigate = useNavigate();
  const { readyCount, activeProfile, settings, providers } = useAI();
  const online = useOnline();

  /**
   * A provider that runs on this device answers without the internet, so
   * "offline" does not automatically mean "no AI". Everything else needs a
   * connection, and the panel says so plainly instead of failing mid-answer.
   */
  const hasLocalProvider = useMemo(
    () => providers.some((p) => p.enabled && p.usable && runsLocally(p.kind, p.baseUrl)),
    [providers],
  );
  const offlineBlocked = !online && !hasLocalProvider;

  const [conversation, setConversation] = useState<AIConversation>(
    () =>
      initialConversation ??
      newConversation({ courseId: scope.courseId, topicId: scope.topicId, materialId: scope.materialId, page: scope.page, slide: scope.slide }),
  );
  const [input, setInput] = useState('');
  const [runId, setRunId] = useState<string | undefined>();
  const status = useAIStatus(runId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AIErrorReport | null>(null);
  /** Full text of the material in focus, loaded once per material. */
  const [materialText, setMaterialText] = useState<{ id: string; text: string } | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const lastQuestionRef = useRef<{ question: string; task: AITaskId } | null>(null);


  /* --- load the full material text (IndexedDB) once, lazily ---------- */
  useEffect(() => {
    let cancelled = false;
    const inline = scope.materialText?.text;
    if (inline && inline.length > 2000) {
      setMaterialText({ id: scope.materialId ?? 'inline', text: inline });
      return;
    }
    if (!scope.materialId || !loadMaterialText) {
      setMaterialText(null);
      return;
    }
    loadMaterialText(scope.materialId)
      .then((text) => {
        if (!cancelled) setMaterialText(text ? { id: scope.materialId as string, text } : null);
      })
      .catch(() => {
        if (!cancelled) setMaterialText(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scope.materialId, scope.materialText?.text, loadMaterialText]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [conversation.messages.length, status.status]);

  const groupedTasks = useMemo(() => {
    const groups: Array<{ group: string; tasks: AITaskId[] }> = [];
    const wanted = quickTasks?.length
      ? quickTasks
      : (['study', 'practice', 'revision', 'document', 'pharmacy'] as const).flatMap((g) =>
          tasksInGroup(g).slice(0, 4).map((t) => t.id),
        );
    for (const id of wanted) {
      const task = taskById(id);
      const bucket = groups.find((g) => g.group === task.group);
      if (bucket) bucket.tasks.push(id);
      else groups.push({ group: task.group, tasks: [id] });
    }
    return groups;
  }, [quickTasks]);

  /**
   * Local retrieval for one question. Runs offline against the on-device index
   * and returns only the passages that actually match — so the prompt carries
   * the slide in front of the student plus a handful of relevant chunks, never
   * every document in the workspace.
   */
  const retrieveForQuestion = useCallback(
    async (question: string): Promise<RetrievalHit[]> => {
      if (!question.trim()) return [];
      if (!scope.courseId && !scope.topicId) return [];
      try {
        const { hits } = await retrieveForSelection(appState, scope, question, {
          loadText: loadMaterialText,
        });
        return hits;
      } catch {
        // Retrieval is an enhancement, never a gate: a broken index must not
        // stop the student asking a question.
        return [];
      }
    },
    [appState, scope, loadMaterialText],
  );

  const ask = useCallback(
    async (question: string, taskId: AITaskId = 'chat') => {
      const trimmed = question.trim();
      if (!trimmed || busy) return;

      lastQuestionRef.current = { question: trimmed, task: taskId };
      setError(null);
      setBusy(true);

      const profile = profileById(settings.profiles, taskById(taskId).profile);
      const budget = profile.contextLimitTokens ?? 12_000;

      // Local retrieval first: only the matching passages are candidates.
      const retrieval = await retrieveForQuestion(trimmed);

      // Context is built from the *selection*, never from the whole workspace.
      const context = buildContext(
        appState,
        {
          ...scope,
          question: trimmed,
          retrieval,
          materialText:
            scope.materialText ??
            (materialText ? { label: materialLabel(scope), text: materialText.text } : undefined),
          conversation,
        },
        budget,
      );

      const request = buildTaskRequest({
        task: taskId,
        question: trimmed,
        context,
        profile,
        providerId: profile.providerId || undefined,
        model: profile.model,
        stream: true,
        history: conversation.messages.slice(-4).map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content.slice(0, 2000),
        })),
      });

      let next = appendMessage(conversation, { role: 'user', content: trimmed });
      onMessage?.(next.messages[next.messages.length - 1]);
      const placeholder = appendMessage(next, { role: 'assistant', content: '' });
      const assistantId = placeholder.messages[placeholder.messages.length - 1].id;
      next = placeholder;
      setConversation(next);

      const id = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setRunId(id);

      try {
        let text = '';
        const generator = aiManager.stream({ ...request, runId: id });
        let step = await generator.next();
        while (!step.done) {
          text += step.value.text;
          const snapshot = text;
          setConversation((current) => replaceMessage(current, assistantId, { content: snapshot }));
          step = await generator.next();
        }
        const response = step.value;

        const finished = replaceMessage(next, assistantId, {
          content: response.content,
          providerId: response.providerId,
          model: response.model,
          usage: response.usage,
          sources: context.sources,
          fallback: response.fallback
            ? {
                requestedProvider: response.fallback.requestedProvider,
                usedProvider: response.fallback.usedProvider,
                reason: response.fallback.reason,
                message: response.fallback.message,
              }
            : undefined,
        });
        setConversation(finished);
        void saveConversation(finished);
        const answered = finished.messages[finished.messages.length - 1];
        onMessage?.(answered);
        onAnswered?.(answered);
      } catch (err) {
        const normalised =
          err instanceof AIEngineError
            ? err
            : new AIEngineError({ category: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) });
        const report = reportFor(normalised);
        const after = replaceMessage(next, assistantId, {
          content:
            normalised.category === 'USER_CANCELLED'
              ? '_Stopped._'
              : report.reason,
          error: { category: normalised.category, message: report.reason },
          cancelled: normalised.category === 'USER_CANCELLED',
        });
        setConversation(after);
        void saveConversation(after);
        if (normalised.category !== 'USER_CANCELLED') setError(report);
      } finally {
        setBusy(false);
        setRunId(undefined);
      }
    },
    [
      appState,
      busy,
      conversation,
      materialText,
      onAnswered,
      onMessage,
      retrieveForQuestion,
      scope,
      settings.profiles,
    ],
  );

  const stop = () => {
    if (runId) aiManager.cancel(runId);
  };

  const retry = () => {
    const last = lastQuestionRef.current;
    if (!last) return;
    void ask(last.question, last.task);
  };

  const configured = readyCount > 0;
  /** Ready to answer: something configured, and reachable from here. */
  const canSend = configured && !offlineBlocked;

  return (
    <div className={`flex flex-col h-full bg-white ${className}`} data-testid="ai-chat-panel">
      {/* Header: identity + engine status, never a provider-specific control */}
      <div className={`flex items-center justify-between border-b border-gray-100 ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}>
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#0F172A] to-[#1E293B] flex items-center justify-center shrink-0">
            <Sparkles className="w-3.5 h-3.5 text-[#FFB703]" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-black uppercase italic text-gray-800 leading-none truncate">{title}</p>
            <p className="text-[9px] font-bold uppercase tracking-widest text-[#2D6A4F] mt-0.5 truncate">
              {configured
                ? `${activeProfile.name} • ${readyCount} provider${readyCount === 1 ? '' : 's'} ready`
                : 'No provider configured'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {status.status === 'streaming' && (
            <span className="text-[9px] font-black uppercase tracking-widest text-[#2D6A4F] animate-pulse">
              AI is responding…
            </span>
          )}
          <button
            onClick={() => navigate('/settings')}
            className="p-1.5 text-gray-400 hover:text-[#2D6A4F] hover:bg-gray-50 rounded-lg"
            title="AI Settings"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>
      </div>

      {offlineBlocked ? (
        <div
          className="flex items-start gap-2 px-3 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900"
          data-testid="ai-offline-state"
        >
          <WifiOff className="w-3.5 h-3.5 shrink-0 mt-px" />
          <div className="min-w-0">
            <p className="font-bold">AI unavailable offline</p>
            <p className="text-amber-800">
              Reading, notes, quizzes, search, revision and archives all keep working — only live generation
              needs a connection. Add a local provider (Ollama or llama.cpp) in Settings → AI to keep AI working
              offline too.
            </p>
          </div>
        </div>
      ) : !online ? (
        <div className="flex items-center gap-2 px-3 py-2 bg-[#2D6A4F]/5 border-b border-[#2D6A4F]/20 text-[11px] text-[#1B4332]">
          <WifiOff className="w-3.5 h-3.5 shrink-0" />
          <span>Offline — answering from your local provider, which runs on this device.</span>
        </div>
      ) : null}

      {!configured && (
        <div className="m-3 p-3 rounded-xl border border-[#2D6A4F]/20 bg-[#2D6A4F]/5 text-[11px] text-gray-700">
          <p className="font-bold text-gray-800 mb-1">Add an AI provider to start</p>
          <p className="mb-2">
            PharmaTRACK works with NVIDIA, OpenAI, Gemini, Claude, Groq, OpenRouter, Mistral or any OpenAI-compatible
            endpoint — keys stay on this device.
          </p>
          <button
            onClick={() => navigate('/settings?tab=ai')}
            className="px-3 py-1.5 bg-[#2D6A4F] text-white rounded-lg font-bold text-[11px]"
          >
            Open AI Settings
          </button>
        </div>
      )}

      {/* Messages */}
      <div className={`flex-1 overflow-y-auto space-y-3 bg-slate-50/40 ${compact ? 'p-3' : 'p-4'}`}>
        {conversation.messages.length === 0 && configured && (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <Lightbulb className="w-7 h-7 text-[#FFB703] mb-2" />
            <p className="text-xs font-bold text-gray-800 mb-1">
              {scope.slide ? `Ask about slide ${scope.slide}` : scope.page ? `Ask about page ${scope.page}` : 'Ask about your material'}
            </p>
            <p className="text-[11px] text-gray-500 max-w-[240px]">
              Only the material you are looking at is sent — not your whole semester.
            </p>
          </div>
        )}

        {conversation.messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}

        {busy && !conversation.messages.some((m) => m.content === '' && m.role === 'assistant') && (
          <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-[#2D6A4F]">
            <Loader2 className="w-3 h-3 animate-spin" /> AI is responding…
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Error card: category, reason, what to check — never a bare "Error" */}
      {error && (
        <div className="mx-3 mb-2 p-3 rounded-xl border border-amber-200 bg-amber-50" data-testid="ai-error-card">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold text-amber-900">{error.title}</p>
              <p className="text-[11px] text-amber-800">{error.reason}</p>
              {error.checks.length > 0 && (
                <ul className="mt-1 text-[10px] text-amber-800 list-disc list-inside">
                  {error.checks.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2 mt-2">
                {error.retryable && (
                  <button onClick={retry} className="flex items-center gap-1 px-2.5 py-1 bg-white border border-amber-300 rounded-lg text-[10px] font-bold text-amber-900">
                    <RefreshCw className="w-3 h-3" /> Retry
                  </button>
                )}
                <button onClick={() => navigate('/settings?tab=ai')} className="px-2.5 py-1 bg-white border border-amber-300 rounded-lg text-[10px] font-bold text-amber-900">
                  AI Settings
                </button>
              </div>
            </div>
            <button onClick={() => setError(null)} className="text-amber-500 hover:text-amber-700">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Task menus: the workflow, not just a text box */}
      <div className="px-3 pt-2 pb-1 border-t border-gray-100">
        <div className="flex flex-wrap gap-1.5">
          {groupedTasks.map(({ group, tasks }) => {
            const Icon = TASK_ICONS[group] ?? Sparkles;
            const open = openMenu === group;
            return (
              <div key={group} className="relative">
                <button
                  onClick={() => setOpenMenu(open ? null : group)}
                  disabled={!canSend || busy}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg border border-gray-200 bg-white text-[10px] font-bold text-gray-600 hover:border-[#2D6A4F] hover:text-[#2D6A4F] disabled:opacity-40"
                >
                  <Icon className="w-3 h-3" />
                  {GROUP_LABELS[group] ?? group}
                </button>
                {open && (
                  <div className="absolute bottom-full mb-1 left-0 w-56 bg-white border border-gray-200 rounded-xl shadow-xl p-1 z-30">
                    {tasks.map((id) => (
                      <button
                        key={id}
                        onClick={() => {
                          setOpenMenu(null);
                          void ask(AI_TASKS[id].label, id);
                        }}
                        className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[#2D6A4F]/5"
                      >
                        <p className="text-[11px] font-bold text-gray-800">{AI_TASKS[id].label}</p>
                        <p className="text-[9px] text-gray-500">{AI_TASKS[id].hint}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Context transparency: exactly what will be sent */}
      <div className="px-3 pb-1">
        <button
          onClick={() => setShowSources((v) => !v)}
          className="text-[9px] font-bold uppercase tracking-widest text-gray-400 hover:text-[#2D6A4F]"
          data-testid="ai-context-toggle"
        >
          Context sent {showSources ? '▾' : '▸'}
        </button>
        {showSources && <ContextPreview appState={appState} scope={scope} materialText={materialText?.text} />}
      </div>

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const question = input;
          setInput('');
          void ask(question, 'chat');
        }}
        className="p-3 border-t border-gray-100"
      >
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={canSend ? 'Ask about this material…' : offlineBlocked ? 'AI unavailable offline' : 'Configure a provider first…'}
            disabled={!canSend}
            className="flex-1 px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-xs outline-none focus:bg-white focus:ring-4 focus:ring-[#2D6A4F]/5 disabled:opacity-60"
            aria-label="Ask the AI"
          />
          {busy ? (
            <button
              type="button"
              onClick={stop}
              className="w-9 h-9 rounded-xl bg-red-50 border border-red-200 text-red-600 flex items-center justify-center"
              title="Stop generating"
              data-testid="ai-stop"
            >
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim() || !canSend}
              className="w-9 h-9 rounded-xl bg-[#2D6A4F] text-[#FFB703] flex items-center justify-center disabled:opacity-30"
              title="Send"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Pieces                                                             */
/* ------------------------------------------------------------------ */

/**
 * True for a provider that answers without leaving the device: the dedicated
 * local runtime, or any endpoint pointed at this machine. These are the only
 * providers that can serve AI while the student is offline.
 */
function runsLocally(kind: string, baseUrl?: string): boolean {
  if (kind === 'local') return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(baseUrl ?? '');
}

/**
 * The academic source line under an answer, e.g.
 * "Pharmacology · Autonomic drugs · Lecture 4 — slide 23".
 *
 * Prefers whatever the student was looking at (selection → slide/page →
 * material) and falls back to the top retrieval hit, so a grounded answer can
 * always be traced back to a course, topic, material and page/slide.
 */
function academicSourceLine(sources: AIContextSource[] | undefined): string | null {
  if (!sources?.length) return null;
  const priority: AIContextKind[] = ['selection', 'slide', 'page', 'material', 'retrieval'];
  let best: AIContextSource | undefined;
  for (const kind of priority) {
    best = sources.find((s) => s.kind === kind);
    if (best) break;
  }
  if (!best) return null;

  const where = best.slide ? `slide ${best.slide}` : best.page ? `page ${best.page}` : undefined;
  const material = [best.materialTitle, where].filter(Boolean).join(' — ');
  const parts = [best.courseName, best.topicName, material].filter(Boolean);
  return parts.length ? parts.join(' · ') : best.label;
}

const MessageBubble: React.FC<{ message: AIChatMessage }> = ({ message }) => {
  const isUser = message.role === 'user';
  const provider = message.providerId
    ? `${message.providerId.toUpperCase()}${message.model ? ` • ${message.model}` : ''}`
    : isUser
      ? 'You'
      : 'PharmaTRACK AI';
  /** Academic provenance of the answer, e.g. "Pharmacology · Autonomic drugs · Lecture 4 — slide 23". */
  const source = useMemo(() => academicSourceLine(message.sources), [message.sources]);

  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`} data-testid={`ai-message-${message.role}`}>
      <div
        className={`max-w-[92%] p-3 rounded-2xl text-[13px] leading-relaxed shadow-sm whitespace-pre-wrap ${
          isUser ? 'bg-[#2D6A4F] text-white rounded-tr-sm' : 'bg-white border border-gray-100 text-gray-700 rounded-tl-sm'
        }`}
      >
        {message.content || (message.role === 'assistant' ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[#2D6A4F]" /> : null)}
      </div>

      <div className="flex items-center gap-2 mt-1 px-1 flex-wrap">
        <span className="text-[8px] text-gray-400 uppercase font-black">{provider}</span>
        {message.fallback && (
          <span className="text-[8px] font-black uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800" data-testid="ai-fallback-notice">
            {message.fallback.message}
          </span>
        )}
        {message.cancelled && <span className="text-[8px] font-black uppercase text-gray-400">stopped</span>}
        {message.usage?.outputTokens ? (
          <span className="text-[8px] text-gray-300 uppercase font-black">{message.usage.outputTokens} tokens out</span>
        ) : null}
      </div>

      {!isUser && source ? (
        <span
          className="flex items-center gap-1 text-[9px] text-[#2D6A4F] mt-0.5 px-1 font-bold"
          data-testid="ai-source-line"
          title="Where this answer came from"
        >
          <BookOpen className="w-3 h-3 shrink-0" />
          {source}
        </span>
      ) : null}

      {message.error && (
        <span className="text-[9px] text-amber-700 mt-0.5 px-1" data-testid="ai-message-error">
          {message.error.category.replace('_', ' ').toLowerCase()}: {message.error.message}
        </span>
      )}
    </div>
  );
};

/** Shows what the builder would send, so "send selected context only" is visible. */
const ContextPreview: React.FC<{
  appState: AppStateLike;
  scope: ContextSelection;
  materialText?: string;
}> = ({ appState, scope, materialText }) => {
  const bundle = useMemo(
    () =>
      buildContext(
        appState,
        {
          ...scope,
          materialText: scope.materialText ?? (materialText ? { label: 'Material', text: materialText } : undefined),
        },
        12_000,
      ),
    [appState, scope, materialText],
  );

  const sources: AIContextSource[] = bundle.sources;

  return (
    <div className="mt-1 p-2 rounded-lg bg-gray-50 border border-gray-100" data-testid="ai-context-preview">
      {sources.length === 0 ? (
        <p className="text-[10px] text-gray-500">Nothing selected yet — open a page or slide first.</p>
      ) : (
        <ul className="space-y-0.5">
          {sources.map((source, i) => (
            <li key={`${source.kind}-${i}`} className="flex items-center gap-1.5 text-[10px] text-gray-600">
              <CheckCircle2 className="w-3 h-3 text-[#2D6A4F] shrink-0" />
              <span className="font-bold">{source.label}</span>
              {source.page ? <span className="text-gray-400">p.{source.page}</span> : null}
              {source.slide ? <span className="text-gray-400">slide {source.slide}</span> : null}
              {source.truncated && <span className="text-amber-600">truncated</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[9px] text-gray-400 mt-1">
        {formatTokens(bundle.estimatedTokens)} · your files stay on this device; only this text is sent to your provider.
      </p>
    </div>
  );
};

export default AIChatPanel;

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { useQuizAutosave } from '../hooks/useQuizAutosave';
import { canUseWebShare, copyTextToClipboard, shareOrCopyLink } from '../utils/clipboard';
import { useQuickQuizShare } from '../components/QuickQuizShareDialog';
import { buildQuickQuizPack } from '../utils/quickQuizShare';
import type { ExamQuestion } from '../types';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');

const question = (id: string): ExamQuestion => ({
  id,
  courseId: 'course-1',
  topicId: 'topic-1',
  semester: '1',
  questionText: `Question ${id}?`,
  questionType: 'mcq',
  marksAllocation: 1,
  difficulty: 'medium',
  probability: 'medium',
  modelAnswer: 'Because it is correct.',
  explanation: 'Because it is correct.',
  correctAnswer: 'Answer B',
  tags: ['manual'],
  isPracticed: false,
  needsReview: false,
  isSaved: true,
  createdAt: '2026-09-29T00:00:00.000Z',
  options: ['Answer A', 'Answer B', 'Answer C'],
  correctOption: 1,
});

describe('quiz autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const Harness: React.FC<{ onSave: (value: unknown) => void }> = ({ onSave }) => {
    const [answer, setAnswer] = useState('');
    useQuizAutosave(answer === 'stop' ? null : { answer }, (snapshot) => onSave(snapshot));
    return (
      <button type="button" onClick={() => setAnswer((value) => (value === '' ? 'B' : 'stop'))}>
        change
      </button>
    );
  };

  it('writes the attempt shortly after every change instead of only on unmount', () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onSave).toHaveBeenCalledWith({ answer: '' });

    fireEvent.click(screen.getByText('change'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onSave).toHaveBeenLastCalledWith({ answer: 'B' });
  });

  it('flushes immediately when the page is hidden, which is what a refresh does', () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);
    onSave.mockClear();

    fireEvent.click(screen.getByText('change'));
    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(onSave).toHaveBeenCalledWith({ answer: 'B' });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  it('never writes the same snapshot twice and stays idle when there is nothing to save', () => {
    const onSave = vi.fn();
    const { unmount } = render(<Harness onSave={onSave} />);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(onSave).toHaveBeenCalledTimes(1);

    // 'stop' turns the snapshot off: a submitted or paused quiz writes nothing.
    fireEvent.click(screen.getByText('change'));
    fireEvent.click(screen.getByText('change'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    unmount();
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe('quiz pages resume where the student stopped', () => {
  const quiz = read('../pages/Quiz.tsx');
  const quickQuiz = read('../pages/QuickQuiz.tsx');

  it('autosaves and auto-resumes a normal quiz after a refresh', () => {
    expect(quiz).toContain("import { useQuizAutosave } from '../hooks/useQuizAutosave'");
    expect(quiz).toContain('useQuizAutosave(autosaveSnapshot');
    expect(quiz).toContain("reason: 'auto' as const");
    expect(quiz).toContain("reason: 'paused'");
    expect(quiz).toContain('const restoreSavedQuiz = useCallback');
    expect(quiz).toContain('if (!saved || saved.reason === \'paused\') return;');
    expect(quiz).toContain('Resumed automatically');
  });

  it('autosaves and auto-resumes a shared quick quiz after a refresh', () => {
    expect(quickQuiz).toContain("import { useQuizAutosave } from '../hooks/useQuizAutosave'");
    expect(quickQuiz).toContain('useQuizAutosave(autosaveSnapshot');
    expect(quickQuiz).toContain("reason: 'auto' as const");
    expect(quickQuiz).toContain("if (saved.reason === 'paused')");
    expect(quickQuiz).toContain('setAutoResumed(true)');
  });
});

describe('copying and sharing without native dialogs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('falls back to the legacy copy path when the clipboard API is refused', async () => {
    const writeText = vi.fn().mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    );
    vi.stubGlobal('navigator', { userAgent: 'test', clipboard: { writeText } } as unknown as Navigator);
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

    await expect(copyTextToClipboard('https://example.com/#/q/Short42')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('refuses the Web Share API inside the desktop app, where it only throws', () => {
    vi.stubGlobal('navigator', { userAgent: 'test', share: async () => undefined } as unknown as Navigator);
    expect(canUseWebShare()).toBe(true);

    vi.stubGlobal('__TAURI_INTERNALS__', {});
    expect(canUseWebShare()).toBe(false);
  });

  it('copies the link when a share sheet rejects the request', async () => {
    const share = vi.fn().mockRejectedValue(
      Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { userAgent: 'test', share, clipboard: { writeText } } as unknown as Navigator);

    await expect(shareOrCopyLink({ url: 'https://example.com/#/q/Short42' })).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith('https://example.com/#/q/Short42');
  });
});

describe('quick quiz share sheet', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const ShareHarness: React.FC = () => {
    const { startShare, shareDialog } = useQuickQuizShare();
    const pack = buildQuickQuizPack([question('1')], { title: 'Hospital pharmacy' });
    return (
      <div>
        <button type="button" onClick={() => startShare(pack)}>
          Quick Start
        </button>
        {shareDialog}
      </div>
    );
  };

  it('forces a timing choice, then shows and copies the link in-app', async () => {
    vi.stubEnv('VITE_CLOUDFLARE_API_BASE_URL', 'https://api.example.test');
    let postedBody: { pack?: { timeLimitMinutes?: number } } = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ code: 'ShortLink1' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { userAgent: 'test', clipboard: { writeText } } as unknown as Navigator);

    render(<ShareHarness />);
    fireEvent.click(screen.getByText('Quick Start'));

    // The sheet opens on the timing step; no link exists yet.
    expect(screen.getByText(/Choose the time first/i)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('15m'));

    await waitFor(() => expect(screen.getByDisplayValue(/#\/q\/ShortLink1$/)).toBeTruthy());
    expect(postedBody.pack?.timeLimitMinutes).toBe(15);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('#/q/ShortLink1'));
    expect(screen.getByText(/15 min timer/i)).toBeTruthy();
  });

  it('shows a retryable in-app message instead of a native error box', async () => {
    vi.stubEnv('VITE_CLOUDFLARE_API_BASE_URL', '');
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    vi.stubGlobal('navigator', { userAgent: 'test' } as unknown as Navigator);

    const BigShareHarness: React.FC = () => {
      const { startShare, shareDialog } = useQuickQuizShare();
      // Unique, incompressible text: no offline fallback link can be short
      // enough, so the sheet must surface the failure in-app.
      const pack = buildQuickQuizPack(
        Array.from({ length: 80 }, (_, index) => {
          const base = question(String(index));
          const noise = Array.from(
            { length: 240 },
            (_unused, position) => String.fromCharCode(97 + ((index * 31 + position * 7) % 26)),
          ).join('');
          return { ...base, questionText: `${noise} ${index}?`, options: [`${noise}A`, `${noise}B`] };
        }),
        { title: 'Too big for an offline link' },
      );
      return (
        <div>
          <button type="button" onClick={() => startShare(pack)}>
            Quick Start
          </button>
          {shareDialog}
        </div>
      );
    };

    render(<BigShareHarness />);
    fireEvent.click(screen.getByText('Quick Start'));
    fireEvent.click(screen.getByText(/Never — no time limit/i));

    await waitFor(() => expect(screen.getByText('Try again')).toBeTruthy());
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe('sharing pages never raise native dialogs', () => {
  it('routes Question Bank, Quiz and Quick Quiz sharing through the in-app sheet', () => {
    const questionBank = read('../pages/QuestionBank.tsx');
    const quiz = read('../pages/Quiz.tsx');
    const quickQuiz = read('../pages/QuickQuiz.tsx');

    for (const source of [questionBank, quiz, quickQuiz]) {
      expect(source).toContain("useQuickQuizShare } from '../components/QuickQuizShareDialog'");
      expect(source).toContain('{shareDialog}');
      expect(source).not.toContain('shareQuickQuizPack');
    }
    expect(quiz).not.toContain('Could not share this quick quiz link.');
    expect(quickQuiz).not.toContain("window.prompt('Copy this quick quiz link:'");
  });
});

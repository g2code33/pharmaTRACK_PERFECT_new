/**
 * Zero-config examination entry — the "no manual work by students" contract.
 *
 *   - A student device on the examination Wi-Fi discovers the authority by
 *     broadcast: one authority → endpoint (and, with open enrollment, the
 *     session token) auto-filled with zero typing.
 *   - Several authorities → a picker, one click.
 *   - Closed enrollment → the endpoint is still auto-filled; the session
 *     token stays on the invigilator's board.
 *   - Browser preview (no UDP) → manual entry, exactly as before.
 *
 * Plus the lockdown half: entering a secure exam disables selection and
 * dragging document-wide, and the devtools shortcuts are now CANCELLED, not
 * merely observed.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const discovery = vi.hoisted(() => ({
  native: true,
  found: [] as Array<{
    endpoint: string;
    sessionId: string;
    examVersionId: string;
    serverId: string;
    authorityId: string;
    authorityEpoch: number;
    openEnrollment: boolean;
    sessionToken?: string;
  }>,
}));

vi.mock('../examination/lanServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../examination/lanServer')>();
  return {
    ...actual,
    isNativeLanServerAvailable: () => discovery.native,
    discoverLanAuthorities: async () => discovery.found,
  };
});

vi.mock('../examination/packageCache', () => ({
  loadStagedPharmaExam: async () => null,
  stagePharmaExamPackage: async () => undefined,
}));

import KioskEntry from '../pages/KioskEntry';
import { createBrowserKioskAdapter, type KioskViolation } from '../examination/kioskAdapter';
import { enterSecureKiosk, releaseSecureKiosk } from '../examination/kioskState';

const authority = (over: Record<string, unknown> = {}) => ({
  endpoint: 'http://10.42.0.7:8787',
  sessionId: 'session_1',
  examVersionId: 'version_1',
  serverId: 'srv-1',
  authorityId: 'authority_1',
  authorityEpoch: 1,
  openEnrollment: true,
  sessionToken: 'token-from-broadcast',
  ...over,
});

function open() {
  render(
    <MemoryRouter initialEntries={['/examinations/kiosk']}>
      <Routes>
        <Route path="/examinations/kiosk" element={<KioskEntry />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  discovery.native = true;
  discovery.found = [];
  window.localStorage.clear();
  try {
    sessionStorage.clear();
    document.documentElement.classList.remove('secure-exam-lockdown');
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  cleanup();
  releaseSecureKiosk();
});

describe('authority auto-discovery on the student device', () => {
  it('auto-fills endpoint, session ID AND session token when one open-enrollment authority answers', async () => {
    discovery.found = [authority()];
    open();

    await waitFor(() => {
      expect((screen.getByTestId('lan-endpoint-input') as HTMLInputElement).value).toBe(
        'http://10.42.0.7:8787',
      );
    });
    // Open enrollment: the student types nothing at all — the session ID from
    // the broadcast joins the admin's session, not a local look-alike.
    expect((screen.getByTestId('lan-token-input') as HTMLInputElement).value).toBe(
      'token-from-broadcast',
    );
    expect((screen.getByTestId('session-id-input') as HTMLInputElement).value).toBe('session_1');
    expect(screen.getByTestId('discovered-authorities').textContent).toContain(
      'found automatically',
    );
  });

  it('auto-fills the endpoint but never the token when enrollment is closed', async () => {
    discovery.found = [authority({ openEnrollment: false, sessionToken: undefined })];
    open();

    await waitFor(() => {
      expect((screen.getByTestId('lan-endpoint-input') as HTMLInputElement).value).toBe(
        'http://10.42.0.7:8787',
      );
    });
    // The session token stays on the invigilator's board.
    expect((screen.getByTestId('lan-token-input') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('discovered-authorities').textContent).toContain(
      'session token still required',
    );
  });

  it('shows a picker when several authorities answer and fills on click', async () => {
    discovery.found = [
      authority({ serverId: 'srv-1' }),
      authority({
        endpoint: 'http://10.42.0.9:8787',
        serverId: 'srv-2',
        sessionId: 'session_2',
        openEnrollment: false,
        sessionToken: undefined,
      }),
    ];
    open();

    await waitFor(() => {
      expect(screen.getByTestId('discovered-authorities').textContent).toContain(
        '2 examination authorities found',
      );
    });

    fireEvent.click(screen.getByTestId('discovered-authority-srv-2'));
    expect((screen.getByTestId('lan-endpoint-input') as HTMLInputElement).value).toBe(
      'http://10.42.0.9:8787',
    );
    // The picked authority's session is the one that gets joined.
    expect((screen.getByTestId('session-id-input') as HTMLInputElement).value).toBe('session_2');
    // Closed enrollment on the picked authority: token untouched.
    expect((screen.getByTestId('lan-token-input') as HTMLInputElement).value).toBe('');
  });

  it('says so plainly when no authority answers, instead of a silent field', async () => {
    discovery.found = [];
    open();
    await waitFor(() => {
      expect(screen.getByTestId('discovery-status').textContent).toContain(
        'No examination authority answered',
      );
    });
  });

  it('keeps scanning by itself until the invigilator starts the authority', async () => {
    // The zero-typing promise covers the real classroom sequence: students
    // open the app first, the invigilator starts the authority afterwards.
    // The page must find it WITHOUT a refresh and fill everything in.
    vi.useFakeTimers();
    try {
      discovery.found = [];
      open();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30);
      });
      expect(screen.getByTestId('discovery-status').textContent).toContain(
        'No examination authority answered',
      );

      discovery.found = [authority()];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4100);
      });

      expect((screen.getByTestId('lan-endpoint-input') as HTMLInputElement).value).toBe(
        'http://10.42.0.7:8787',
      );
      expect((screen.getByTestId('lan-token-input') as HTMLInputElement).value).toBe(
        'token-from-broadcast',
      );
      expect((screen.getByTestId('session-id-input') as HTMLInputElement).value).toBe('session_1');
      expect(screen.getByTestId('discovered-authorities').textContent).toContain(
        'found automatically',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps manual entry in the browser preview (no UDP from a browser tab)', async () => {
    discovery.native = false;
    open();
    // Let any (wrongly triggered) discovery settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('discovered-authorities')).toBeNull();
    expect(screen.queryByTestId('discovery-status')).toBeNull();
    expect((screen.getByTestId('lan-endpoint-input') as HTMLInputElement).value).toBe('');
  });

  it('remembers the last used endpoint for the next exam on this device', async () => {
    window.localStorage.setItem('pharmatrack:lan-endpoint', 'http://10.42.0.7:8787');
    discovery.found = [];
    open();
    await waitFor(() => {
      expect((screen.getByTestId('lan-endpoint-input') as HTMLInputElement).value).toBe(
        'http://10.42.0.7:8787',
      );
    });
  });
});

describe('secure examination lockdown', () => {
  it('disables document-wide selection while the exam is active and restores it after', () => {
    enterSecureKiosk('attempt-1', true);
    expect(document.documentElement.classList.contains('secure-exam-lockdown')).toBe(true);
    releaseSecureKiosk();
    expect(document.documentElement.classList.contains('secure-exam-lockdown')).toBe(false);
  });

  it('cancels the devtools shortcuts, not just records them', () => {
    const violations: KioskViolation[] = [];
    const adapter = createBrowserKioskAdapter((v) => violations.push(v), [], {
      developerTools: true,
    });
    const cleanupAdapter = adapter.install();

    const chord = new KeyboardEvent('keydown', {
      key: 'I',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(chord);
    expect(chord.defaultPrevented).toBe(true);
    expect(violations[violations.length - 1]?.violation).toBe('DEVELOPER_TOOL_ATTEMPT');
    expect(violations[violations.length - 1]?.prevented).toBe(true);

    cleanupAdapter();
  });

  it('cancels dragging content out of the examination', () => {
    const violations: KioskViolation[] = [];
    const adapter = createBrowserKioskAdapter((v) => violations.push(v), [], {});
    const cleanupAdapter = adapter.install();

    // jsdom has no DragEvent constructor; a cancelable event on the same
    // name reaches the same listener.
    const drag = new MouseEvent('dragstart', { bubbles: true, cancelable: true });
    document.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
    expect(violations[violations.length - 1]?.violation).toBe('ATTEMPTED_COPY_PASTE');

    cleanupAdapter();
  });
});

/**
 * Regression tests for the logout bug.
 *
 * The bug: clicking "End Session" only dispatched SET_LOGGED_IN:false. It never
 * called supabase.auth.signOut(), so the session stayed in localStorage. That
 * dispatch flipped state.isLoggedIn, which is a dependency of the session
 * effect, so the effect re-ran, getSession() still returned a valid session,
 * and the user was signed straight back in.
 *
 * Offline was worse: signOut() POSTs to /logout first and returns early
 * WITHOUT clearing storage when that request fails.
 *
 * These tests drive the real AppProvider + real reducer. Only the network edge
 * (supabase) is faked, so the re-authentication loop is genuinely exercised.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { setOnline } from './setup';

const AUTH_KEY = 'sb-ltpwedxcvbejiywmwrwc-auth-token';

/** Mimics supabase-js: the session lives in localStorage until signOut clears it. */
const authState = {
  online: true,
  /** Set false to simulate the /logout POST failing (i.e. offline). */
  networkWorks: true,
  callbacks: [] as Array<(event: string, session: unknown) => void>,
};

const hasStoredSession = () => localStorage.getItem(AUTH_KEY) !== null;
const storedSession = () =>
  hasStoredSession() ? { user: { id: 'user-1' } } : null;

vi.mock('../utils/supabase', async () => {
  const actual = await vi.importActual<typeof import('../utils/supabase')>(
    '../utils/supabase',
  );
  return {
    // Keep the REAL purgeStoredSession + AUTH_STORAGE_KEY; that logic is under test.
    ...actual,
    supabase: {
      auth: {
        getSession: async () => ({ data: { session: storedSession() } }),
        getUser: async () => ({ data: { user: storedSession()?.user ?? null } }),
        signOut: async () => {
          if (!authState.networkWorks) {
            // Exactly what auth-js does offline: bail out, leave storage intact.
            return { error: { message: 'AuthRetryableFetchError: fetch failed' } };
          }
          localStorage.removeItem(AUTH_KEY);
          return { error: null };
        },
        onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
          authState.callbacks.push(cb);
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
      },
      from: () => ({
        select: () => ({
          eq: () => ({ single: async () => ({ data: null, error: { message: 'no profile' } }) }),
        }),
      }),
    },
  };
});

import { AppProvider, useApp } from '../context/AppContext';

/** Minimal consumer that reports auth state and exposes the real logout(). */
const Probe: React.FC = () => {
  const { state, logout } = useApp();
  return (
    <div>
      <span data-testid="logged-in">{String(state.isLoggedIn)}</span>
      <span data-testid="courses">{state.courses.length}</span>
      <span data-testid="notes">{state.notes.length}</span>
      <button onClick={() => void logout()}>End Session</button>
    </div>
  );
};

/** Seeds a logged-in user who already has study material saved. */
const seedLoggedInUserWithData = () => {
  localStorage.setItem(AUTH_KEY, JSON.stringify({ user: { id: 'user-1' } }));
  localStorage.setItem(
    'pharmatrack_state',
    JSON.stringify({
      isLoggedIn: true,
      student: { id: 'user-1', name: 'Ama', university: 'UCC', level: '300', program: 'Pharmacy', semester: '1st', createdAt: '2024-01-01' },
      courses: [{ id: 'c1', courseCode: 'PHA301', courseName: 'Pharmacology' }],
      notes: [{ id: 'n1', topicId: 't1', noteText: 'Beta blockers', isAiGenerated: false, createdAt: '2024-01-01' }],
      topics: [], slides: [], learningObjectives: [], examQuestions: [],
      quizHistory: [], studyPlans: [], examDates: [], activities: [],
      chatHistory: [], highlights: [], savedInsights: [], openAIKey: '',
      timetables: { class: [], quiz: [], exam: [] }, timetablePdf: null,
    }),
  );
};

const renderApp = async () => {
  const view = render(
    <AppProvider>
      <Probe />
    </AppProvider>,
  );
  // Let the load + session effects settle.
  await waitFor(() => expect(screen.getByTestId('logged-in')).toHaveTextContent('true'));
  return view;
};

const clickLogout = async () => {
  await act(async () => {
    screen.getByText('End Session').click();
  });
  // Give the resurrect-loop a chance to fire if the guard is missing.
  await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  authState.callbacks = [];
  authState.networkWorks = true;
  setOnline(true);
  seedLoggedInUserWithData();
});

describe('logout', () => {
  it('signs the user out and does not re-authenticate them (online)', async () => {
    await renderApp();
    await clickLogout();

    expect(screen.getByTestId('logged-in')).toHaveTextContent('false');
    expect(hasStoredSession()).toBe(false);
  });

  it('signs the user out even when offline and the /logout request fails', async () => {
    // The original bug's worst case: signOut() fails, so auth-js never clears
    // storage, and the offline branch re-authenticated from the cached student.
    setOnline(false);
    authState.networkWorks = false;

    await renderApp();
    await clickLogout();

    expect(screen.getByTestId('logged-in')).toHaveTextContent('false');
    expect(hasStoredSession()).toBe(false);
  });

  it('stays logged out instead of being revived by the session effect', async () => {
    await renderApp();
    await clickLogout();

    // The effect re-runs on every isLoggedIn change. Without hasSignedOutRef
    // this is exactly where the user got signed back in.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    expect(screen.getByTestId('logged-in')).toHaveTextContent('false');
  });

  it('ignores a stale session event fired after logout', async () => {
    await renderApp();
    await clickLogout();

    // TOKEN_REFRESHED/INITIAL_SESSION can arrive late from the discarded session.
    await act(async () => {
      authState.callbacks.forEach((cb) => cb('TOKEN_REFRESHED', { user: { id: 'user-1' } }));
    });

    expect(screen.getByTestId('logged-in')).toHaveTextContent('false');
  });

  it('keeps the user\'s study data so logging out never destroys work', async () => {
    // LOGOUT used to reset to initialState. Once logout actually worked, the
    // debounced save would have flushed that empty state over real material.
    await renderApp();
    expect(screen.getByTestId('courses')).toHaveTextContent('1');

    await clickLogout();

    expect(screen.getByTestId('courses')).toHaveTextContent('1');
    expect(screen.getByTestId('notes')).toHaveTextContent('1');
  });

  it('allows signing back in after a logout', async () => {
    await renderApp();
    await clickLogout();
    expect(screen.getByTestId('logged-in')).toHaveTextContent('false');

    // A real SIGNED_IN must clear the signed-out latch, or users are locked out.
    await act(async () => {
      localStorage.setItem(AUTH_KEY, JSON.stringify({ user: { id: 'user-1' } }));
      authState.callbacks.forEach((cb) => cb('SIGNED_IN', { user: { id: 'user-1' } }));
    });

    expect(screen.getByTestId('logged-in')).toHaveTextContent('true');
  });
});

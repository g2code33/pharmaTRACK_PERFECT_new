/**
 * Tests for the offline-first model.
 *
 * The app must be fully usable with no account and no internet. An account is
 * optional and only unlocks cloud sync. The traps this guards against:
 *
 *  - a local-only user (onboarded, never signed in) being treated as logged in,
 *    so the UI offers cloud features they have no account for
 *  - a failed token refresh while offline nulling the student and throwing the
 *    user back to onboarding, losing the identity their offline app relies on
 *  - signing out wiping the student and doing the same
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { setOnline } from './setup';

const AUTH_KEY = 'sb-ltpwedxcvbejiywmwrwc-auth-token';

const authState = { callbacks: [] as Array<(e: string, s: unknown) => void> };
const storedSession = () =>
  localStorage.getItem(AUTH_KEY) ? { user: { id: 'user-1' } } : null;

vi.mock('../utils/supabase', async () => {
  const actual = await vi.importActual<typeof import('../utils/supabase')>('../utils/supabase');
  return {
    ...actual,
    supabase: {
      auth: {
        getSession: async () => ({ data: { session: storedSession() } }),
        getUser: async () => ({ data: { user: storedSession()?.user ?? null } }),
        signOut: async () => { localStorage.removeItem(AUTH_KEY); return { error: null }; },
        onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
          authState.callbacks.push(cb);
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
      },
      from: () => ({
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: { message: 'x' } }) }) }),
      }),
    },
  };
});

import { AppProvider, useApp } from '../context/AppContext';
import { checkCloudAccess } from '../utils/requireAuth';

const Probe: React.FC = () => {
  const { state, logout } = useApp();
  return (
    <div>
      <span data-testid="logged-in">{String(state.isLoggedIn)}</span>
      <span data-testid="has-student">{String(state.student !== null)}</span>
      <span data-testid="courses">{state.courses.length}</span>
      <button onClick={() => void logout()}>Sign Out</button>
    </div>
  );
};

/** A student who completed onboarding but has never signed in. */
const seedLocalOnlyUser = () => {
  localStorage.setItem('pharmatrack_state', JSON.stringify({
    isLoggedIn: false,
    student: { id: 'local-1', name: 'Kwame', university: 'UCC', level: '200', program: 'Pharm.D', semester: '1st', createdAt: '2024-01-01' },
    courses: [{ id: 'c1', courseCode: 'PHA201', courseName: 'Pharmaceutics' }],
    topics: [], slides: [], learningObjectives: [], examQuestions: [], quizHistory: [],
    studyPlans: [], notes: [], examDates: [], activities: [], chatHistory: [],
    highlights: [], savedInsights: [], openAIKey: '',
    timetables: { class: [], quiz: [], exam: [] }, timetablePdf: null,
  }));
};

const renderApp = () => render(<AppProvider><Probe /></AppProvider>);

beforeEach(() => {
  authState.callbacks = [];
  setOnline(true);
});

describe('offline-first: no account required', () => {
  it('loads a local-only user without marking them signed in', async () => {
    seedLocalOnlyUser();
    setOnline(false);
    renderApp();

    await waitFor(() => expect(screen.getByTestId('has-student')).toHaveTextContent('true'));
    // The key assertion: having a student must not imply a cloud session.
    expect(screen.getByTestId('logged-in')).toHaveTextContent('false');
    expect(screen.getByTestId('courses')).toHaveTextContent('1');
  });

  it('keeps working offline with no account at all', async () => {
    seedLocalOnlyUser();
    setOnline(false);
    renderApp();

    await waitFor(() => expect(screen.getByTestId('courses')).toHaveTextContent('1'));
    expect(screen.getByTestId('logged-in')).toHaveTextContent('false');
  });

  it('does not log the user out when a session-less event fires offline', async () => {
    localStorage.setItem(AUTH_KEY, JSON.stringify({ user: { id: 'user-1' } }));
    seedLocalOnlyUser();
    renderApp();
    await waitFor(() => expect(screen.getByTestId('logged-in')).toHaveTextContent('true'));

    // A token refresh failing offline delivers no session. That must not be
    // mistaken for a deliberate sign-out.
    await act(async () => {
      authState.callbacks.forEach((cb) => cb('TOKEN_REFRESHED', null));
    });

    expect(screen.getByTestId('has-student')).toHaveTextContent('true');
    expect(screen.getByTestId('logged-in')).toHaveTextContent('true');
  });

  it('keeps the student after signing out, so the app still works offline', async () => {
    localStorage.setItem(AUTH_KEY, JSON.stringify({ user: { id: 'user-1' } }));
    seedLocalOnlyUser();
    renderApp();
    await waitFor(() => expect(screen.getByTestId('logged-in')).toHaveTextContent('true'));

    await act(async () => { screen.getByText('Sign Out').click(); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('logged-in')).toHaveTextContent('false');
    // Signing out must not bounce them back to onboarding.
    expect(screen.getByTestId('has-student')).toHaveTextContent('true');
    expect(screen.getByTestId('courses')).toHaveTextContent('1');
  });
});

describe('cloud access gate', () => {
  it('reports offline when there is no connection', async () => {
    setOnline(false);
    localStorage.setItem(AUTH_KEY, JSON.stringify({ user: { id: 'user-1' } }));

    expect(await checkCloudAccess()).toEqual({ ok: false, reason: 'offline' });
  });

  it('reports signed-out when online but with no account', async () => {
    setOnline(true);
    expect(await checkCloudAccess()).toEqual({ ok: false, reason: 'signed-out' });
  });

  it('allows the action when online and signed in', async () => {
    setOnline(true);
    localStorage.setItem(AUTH_KEY, JSON.stringify({ user: { id: 'user-1' } }));

    expect(await checkCloudAccess()).toEqual({ ok: true, userId: 'user-1' });
  });
});

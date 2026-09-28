/**
 * Regression tests for lazy route-chunk loading.
 *
 * The reported bug: picking a tab in the sidebar flashed a near-white screen.
 *
 * Root cause: every page except the first-paint ones is a lazy chunk, and the
 * only Suspense boundary sat in App.tsx ABOVE <Routes> — above the Layout. A
 * page whose chunk was still downloading therefore tore down the whole shell
 * (sidebar, header, search) and left a lone spinner on the page background.
 *
 * The fix keeps the shell mounted in every case:
 *  - Layout wraps its <Outlet /> in its own boundary, so the loader shows in
 *    the content area only;
 *  - the routers opt into future.v7_startTransition, so in-app navigation
 *    keeps the current page on screen while the next chunk downloads;
 *  - the storage-blocked boot branch, which renders the lazy StorageManager,
 *    got the boundary it was missing entirely.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../utils/supabase', async () => {
  const actual = await vi.importActual<typeof import('../utils/supabase')>('../utils/supabase');
  return {
    ...actual,
    supabase: {
      auth: {
        getSession: async () => ({ data: { session: null } }),
        getUser: async () => ({ data: { user: null } }),
        signOut: async () => ({ error: null }),
        onAuthStateChange: () => ({
          data: { subscription: { unsubscribe: () => {} } },
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({ single: async () => ({ data: null, error: { message: 'x' } }) }),
        }),
      }),
    },
  };
});

// jsdom has no IndexedDB; the app tolerates its absence in real browsers, but
// an unhandled rejection would add noise to these tests.
vi.mock('idb-keyval', () => {
  const idbStore = new Map<string, unknown>();
  return {
    get: async (k: string) => idbStore.get(k),
    set: async (k: string, v: unknown) => {
      idbStore.set(k, v);
    },
    del: async (k: string) => {
      idbStore.delete(k);
    },
    delMany: async (keys: string[]) => keys.forEach((k) => idbStore.delete(k)),
    keys: async () => [...idbStore.keys()],
    clear: async () => idbStore.clear(),
  };
});

// App loads every non-first-paint page through React.lazy(() => import(...)).
// Replacing two of them with components that suspend forever pins the exact
// state the bug lives in — "the user clicked a tab, the chunk has not arrived
// yet" — without depending on network timing. (The default export must be a
// plain component: App already wraps the import in React.lazy, so a lazy
// default would be lazy-in-lazy and React refuses to mount it.)
vi.mock('../pages/StudyMaterials', async () => {
  const lazily = await import('react');
  const Pending = lazily.lazy(() => new Promise<{ default: React.ComponentType }>(() => {}));
  return { default: () => <Pending /> };
});

vi.mock('../pages/StorageManager', async () => {
  const lazily = await import('react');
  const Pending = lazily.lazy(() => new Promise<{ default: React.ComponentType }>(() => {}));
  return { default: () => <Pending /> };
});

import { AppProvider } from '../context/AppContext';
import App from '../App';
import Layout from '../components/Layout';
import { initialState } from '../utils/storage';

/** A route element that suspends forever, like a chunk mid-download. */
const PendingPage = React.lazy(() => new Promise<{ default: React.ComponentType }>(() => {}));

/** A workspace with a completed onboarding: App must show the full shell. */
const seedOnboardedStudent = () => {
  localStorage.setItem(
    'pharmatrack_state',
    JSON.stringify({
      ...initialState,
      student: {
        id: 'local-1',
        name: 'Ama',
        university: 'UCC',
        level: '400',
        program: 'Pharm.D',
        semester: '1st',
        createdAt: '2024-01-01',
      },
    }),
  );
};

describe('lazy route loading never blanks the app shell', () => {
  it('keeps the sidebar and header mounted while a sidebar tab\'s chunk downloads', async () => {
    seedOnboardedStudent();
    window.location.hash = '#/materials';

    render(
      <AppProvider>
        <App />
      </AppProvider>,
    );

    // The pending page shows a loader…
    await waitFor(() => {
      expect(screen.getByTestId('page-loading')).toBeInTheDocument();
    });

    // …but the shell survives the wait: sidebar brand, the nav item that was
    // clicked, and the header search box. Before the fix all three were torn
    // down and replaced by a lone spinner on a near-white screen.
    expect(screen.getByRole('heading', { name: /pharma\s*track/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /study materials/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search notes/i)).toBeInTheDocument();
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it('swaps only the content area when a route suspends inside the Layout', () => {
    render(
      <AppProvider>
        <MemoryRouter initialEntries={['/materials']}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/materials" element={<PendingPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );

    expect(screen.getByTestId('page-loading')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /pharma\s*track/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search notes/i)).toBeInTheDocument();
    // A suspension is not an error: the scoped boundary must not trip.
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it('shows the loader, not the crash screen, on the storage-blocked boot path', async () => {
    // An unreadable semester file boots App into the StorageManager branch,
    // whose chunk is itself lazy. Without a boundary that suspension escaped
    // to the ErrorBoundary and students saw "Something went wrong" instead of
    // the storage recovery tool.
    localStorage.setItem('pharmatrack_state', '{not json');

    render(
      <AppProvider>
        <App />
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('page-loading')).toBeInTheDocument();
    });
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });
});

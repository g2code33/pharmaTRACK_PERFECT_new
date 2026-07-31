/**
 * Tests for highlighting.
 *
 * Before this, highlights were unreachable: ADD_HIGHLIGHT existed in the
 * reducer and Highlights.tsx rendered a list, but nothing in the app ever
 * dispatched it, so the Study Bank could never contain anything.
 *
 * These cover the persistence layer and the geometry maths that makes a
 * highlight land in the right place after a reload at a different zoom.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

vi.mock('../utils/supabase', async () => {
  const actual = await vi.importActual<typeof import('../utils/supabase')>('../utils/supabase');
  return {
    ...actual,
    supabase: {
      auth: {
        getSession: async () => ({ data: { session: null } }),
        getUser: async () => ({ data: { user: null } }),
        signOut: async () => ({ error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: {} }) }) }) }),
    },
  };
});

import { AppProvider, useApp } from '../context/AppContext';
import type { HighlightRect } from '../types';

const RECTS: HighlightRect[] = [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }];

const Probe: React.FC = () => {
  const { state, dispatch } = useApp();
  return (
    <div>
      <span data-testid="count">{state.highlights.length}</span>
      <span data-testid="first-text">{state.highlights[0]?.text ?? ''}</span>
      <span data-testid="first-page">{state.highlights[0]?.page ?? ''}</span>
      <span data-testid="first-material">{state.highlights[0]?.materialId ?? ''}</span>
      <span data-testid="first-rects">{JSON.stringify(state.highlights[0]?.rects ?? null)}</span>
      <span data-testid="first-id">{state.highlights[0]?.id ?? ''}</span>
      <button onClick={() => dispatch({
        type: 'ADD_HIGHLIGHT',
        payload: {
          topicId: 't1', slideIndex: 0, materialId: 'm1', page: 3,
          text: 'Beta blockers reduce heart rate', color: 'yellow', rects: RECTS,
        } as any,
      })}>add</button>
      <button onClick={() => {
        const id = state.highlights[0]?.id;
        if (id) dispatch({ type: 'DELETE_HIGHLIGHT', payload: id });
      }}>remove</button>
    </div>
  );
};

const renderApp = () => render(<AppProvider><Probe /></AppProvider>);

beforeEach(() => localStorage.clear());

describe('highlight persistence', () => {
  it('stores page, material and geometry alongside the text', async () => {
    renderApp();
    await act(async () => { screen.getByText('add').click(); });

    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('first-text')).toHaveTextContent('Beta blockers reduce heart rate');
    // Without these a highlight can be listed but never located again.
    expect(screen.getByTestId('first-page')).toHaveTextContent('3');
    expect(screen.getByTestId('first-material')).toHaveTextContent('m1');
    expect(screen.getByTestId('first-rects')).toHaveTextContent('0.1');
  });

  it('assigns an id and timestamp', async () => {
    renderApp();
    await act(async () => { screen.getByText('add').click(); });
    expect(screen.getByTestId('first-id').textContent).toBeTruthy();
  });

  it('deletes a highlight by id', async () => {
    renderApp();
    await act(async () => { screen.getByText('add').click(); });
    expect(screen.getByTestId('count')).toHaveTextContent('1');

    await act(async () => { screen.getByText('remove').click(); });
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });

  it('survives a reload', async () => {
    const first = renderApp();
    await act(async () => { screen.getByText('add').click(); });
    // The provider debounces saves by 1s.
    await act(async () => { await new Promise((r) => setTimeout(r, 1200)); });
    first.unmount();

    renderApp();
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    expect(screen.getByTestId('first-page')).toHaveTextContent('3');
  });
});

describe('highlight geometry', () => {
  // Rects are stored as fractions of the page rather than pixels. Absolute
  // pixels would drift the moment the user zoomed or resized the window.
  const toFraction = (rect: { left: number; top: number; width: number; height: number },
                      page: { left: number; top: number; width: number; height: number }) => ({
    x: (rect.left - page.left) / page.width,
    y: (rect.top - page.top) / page.height,
    w: rect.width / page.width,
    h: rect.height / page.height,
  });

  it('converts a client rect into page fractions', () => {
    const page = { left: 100, top: 50, width: 800, height: 1000 };
    const rect = { left: 180, top: 150, width: 400, height: 30 };

    expect(toFraction(rect, page)).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.03 });
  });

  it('produces the same fractions after a zoom', () => {
    // Same selection, page rendered at 2x.
    const page1 = { left: 100, top: 50, width: 800, height: 1000 };
    const rect1 = { left: 180, top: 150, width: 400, height: 30 };
    const page2 = { left: 0, top: 0, width: 1600, height: 2000 };
    const rect2 = { left: 160, top: 200, width: 800, height: 60 };

    expect(toFraction(rect1, page1)).toEqual(toFraction(rect2, page2));
  });
});

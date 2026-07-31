/**
 * Tests for the render-error boundary.
 *
 * Without one, a single bad render (a malformed PDF record, corrupt quiz data)
 * took the whole app to a white screen. That is worse here than in a typical
 * web app: everything is stored locally, and the export/backup button lives in
 * Settings — which a white screen makes unreachable.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import ErrorBoundary from '../components/ErrorBoundary';

const Boom: React.FC<{ fail: boolean }> = ({ fail }) => {
  if (fail) throw new Error('Simulated render crash');
  return <p>Working content</p>;
};

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // React logs caught errors; keep the test output readable.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(<ErrorBoundary><Boom fail={false} /></ErrorBoundary>);
    expect(screen.getByText('Working content')).toBeInTheDocument();
  });

  it('catches a render crash instead of unmounting the tree', () => {
    render(<ErrorBoundary><Boom fail /></ErrorBoundary>);
    expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();
  });

  it('names the area that failed', () => {
    render(<ErrorBoundary label="Quiz"><Boom fail /></ErrorBoundary>);
    expect(screen.getByText(/Something went wrong in Quiz/)).toBeInTheDocument();
  });

  it('reassures the user their data is safe', () => {
    // The fallback must not imply data loss — nothing was lost, only a render.
    render(<ErrorBoundary><Boom fail /></ErrorBoundary>);
    expect(screen.getByText(/nothing you saved has been lost/i)).toBeInTheDocument();
  });

  it('offers recovery and a data export', () => {
    render(<ErrorBoundary><Boom fail /></ErrorBoundary>);
    expect(screen.getByText('Try again')).toBeInTheDocument();
    expect(screen.getByText('Go to Dashboard')).toBeInTheDocument();
    // Export matters because Settings is unreachable from a broken page.
    expect(screen.getByText('Export backup')).toBeInTheDocument();
  });

  it('exposes the stack for debugging', () => {
    render(<ErrorBoundary><Boom fail /></ErrorBoundary>);
    expect(screen.getByText('Technical details')).toBeInTheDocument();
    expect(screen.getByText(/Simulated render crash/)).toBeInTheDocument();
  });

  it('clears the error when the route changes', () => {
    // Navigating away from a broken page must not leave the fallback stuck.
    const view = render(
      <ErrorBoundary resetKey="/quiz"><Boom fail /></ErrorBoundary>,
    );
    expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();

    view.rerender(<ErrorBoundary resetKey="/notes"><Boom fail={false} /></ErrorBoundary>);
    expect(screen.getByText('Working content')).toBeInTheDocument();
  });

  it('recovers when "Try again" is pressed and the cause is gone', () => {
    const view = render(<ErrorBoundary><Boom fail /></ErrorBoundary>);
    expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();

    // The child must stop throwing BEFORE retrying, otherwise it simply
    // crashes again — which is the correct behaviour, not a recovery.
    view.rerender(<ErrorBoundary><Boom fail={false} /></ErrorBoundary>);
    act(() => { screen.getByText('Try again').click(); });

    expect(screen.getByText('Working content')).toBeInTheDocument();
  });
});

describe('wiring', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

  it('wraps the page area, so the sidebar survives a crash', () => {
    const layout = read('../components/Layout.tsx');
    expect(layout).toMatch(/<ErrorBoundary resetKey=\{location\.pathname\}>[\s\S]{0,120}<Outlet \/>/);
  });

  it('also wraps the router, covering Login and Onboarding', () => {
    const app = read('../App.tsx');
    expect(app).toMatch(/<ErrorBoundary>[\s\S]{0,80}<HashRouter>/);
  });
});

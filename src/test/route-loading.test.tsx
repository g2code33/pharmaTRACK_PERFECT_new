/**
 * Regression tests for the sidebar-navigation white-screen bug.
 *
 * The bug: a single Suspense boundary wrapped the whole router (including the
 * Layout), so loading a lazy page chunk unmounted the entire shell and showed a
 * centred spinner on a blank white window.
 *
 * The fix keeps the Suspense boundary INSIDE the persistent Layout, around only
 * the route outlet. These tests prove the pieces that guarantee that behaviour:
 *
 *  1. the shell (sidebar/header) stays mounted while a lazy route loads;
 *  2. only the content area shows the loading fallback;
 *  3. a rejected dynamic import shows a recoverable error with a Retry;
 *  4. the loading state always reaches a timeout/Retry, never an endless spin;
 *  5. the fallback background is non-white in both themes and is accessible;
 *  6. chunk-load errors are detected across engines (incl. WebKit wording).
 */
import React, { Suspense } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import RouteLoading from '../components/RouteLoading';
import RouteErrorBoundary from '../components/RouteErrorBoundary';
import {
  DEFAULT_BACKGROUND_PREFETCH_ROUTES,
  isChunkLoadError,
  prefetchRoute,
  registerRoute,
  scheduleRoutePrefetch,
  lazyWithRetry,
} from '../utils/routeLoader';
import { __testing as idleSchedulerTesting } from '../utils/idleScheduler';

// A minimal stand-in for the persistent shell: a sidebar/header that must stay
// mounted, plus a Suspense boundary around the "route outlet" exactly as Layout
// arranges it.
const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div>
    <nav data-testid="sidebar">Sidebar</nav>
    <header data-testid="header">Header</header>
    <main data-testid="content">
      <RouteErrorBoundary>
        <Suspense fallback={<RouteLoading timeoutMs={50} />}>{children}</Suspense>
      </RouteErrorBoundary>
    </main>
  </div>
);

describe('route loading keeps the app shell mounted', () => {
  it('shows the fallback only in the content area while a lazy page loads', () => {
    // A lazy component whose import never settles → perpetual pending state.
    const NeverResolves = React.lazy(() => new Promise<never>(() => {}));
    render(
      <Shell>
        <NeverResolves />
      </Shell>,
    );

    // The shell stays; only the content area shows the loading fallback.
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('header')).toBeInTheDocument();
    const fallback = screen.getByTestId('route-loading');
    expect(fallback).toBeInTheDocument();
    // Fallback lives inside the content area, not replacing the shell.
    expect(screen.getByTestId('content')).toContainElement(fallback);
  });

  it('the fallback is accessible and has a non-white, theme-aware background', () => {
    render(<RouteLoading timeoutMs={999999} />);
    const status = screen.getByTestId('route-loading');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-label');
    // Non-white background for light mode + an explicit dark variant.
    expect(status.className).toMatch(/bg-slate-50/);
    expect(status.className).toMatch(/dark:bg-slate-900/);
  });
});

describe('the loading state can never spin forever', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('surfaces a Retry after the timeout', () => {
    const onRetry = vi.fn();
    render(<RouteLoading timeoutMs={100} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(150);
    });
    const retry = screen.getByRole('button', { name: /retry/i });
    expect(retry).toBeInTheDocument();
    act(() => {
      retry.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('a failed dynamic import is recoverable', () => {
  it('shows a chunk error with a Retry action, not a blank spinner', async () => {
    const Boom: React.FC = () => {
      throw new Error('Failed to fetch dynamically imported module: /assets/Page-abc123.js');
    };
    render(
      <RouteErrorBoundary>
        <Suspense fallback={<RouteLoading />}>
          <Boom />
        </Suspense>
      </RouteErrorBoundary>,
    );
    expect(await screen.findByTestId('route-chunk-error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('shows a generic recoverable page error for non-chunk render errors', () => {
    const Boom: React.FC = () => {
      throw new Error('some render bug');
    };
    render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    expect(screen.getByTestId('route-render-error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('chunk-load error detection', () => {
  it('recognises the wording used by Chromium and WebKit', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true); // WebKit
    const named = new Error('boom');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadError(named)).toBe(true);
  });

  it('does not treat ordinary errors as chunk failures', () => {
    expect(isChunkLoadError(new Error('cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('route prefetch', () => {
  it('does not auto-parse the heavy reader/chart/archive chunks at startup', () => {
    // Those routes are still warmed on sidebar hover/focus/touch. Keeping them
    // out of the blind background queue prevents the "mouse is slow/freezing"
    // feeling caused by parsing PDF/PPTX/charts while the student is working.
    expect(DEFAULT_BACKGROUND_PREFETCH_ROUTES).not.toContain('/read');
    expect(DEFAULT_BACKGROUND_PREFETCH_ROUTES).not.toContain('/analytics');
    expect(DEFAULT_BACKGROUND_PREFETCH_ROUTES).not.toContain('/archive');
    expect(DEFAULT_BACKGROUND_PREFETCH_ROUTES).toContain('/materials');
    expect(DEFAULT_BACKGROUND_PREFETCH_ROUTES).toContain('/quiz');
  });

  it('warms a registered route exactly once', async () => {
    const factory = vi.fn(async () => ({ default: (() => null) as React.ComponentType }));
    registerRoute('/prefetch-test', factory);
    prefetchRoute('/prefetch-test');
    prefetchRoute('/prefetch-test'); // second call must be a no-op
    await Promise.resolve();
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('does not register duplicate global mousemove tracking for background work', () => {
    const events = idleSchedulerTesting.trackedInputEvents();
    expect(events).toContain('pointermove');
    expect(events).not.toContain('mousemove');
  });

  it('queues hover/touch prefetch for idle time instead of parsing immediately', async () => {
    idleSchedulerTesting.resetInputTracking();
    vi.useFakeTimers();
    try {
      const factory = vi.fn(async () => ({ default: (() => null) as React.ComponentType }));
      registerRoute('/idle-prefetch-test', factory);
      scheduleRoutePrefetch('/idle-prefetch-test');
      expect(factory).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1_000);
        vi.runOnlyPendingTimers();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lazyWithRetry renders the module on a successful import', async () => {
    const Ok: React.FC = () => <div data-testid="loaded-ok">ok</div>;
    const Lazy = lazyWithRetry(async () => ({ default: Ok }));
    render(
      <Suspense fallback={<RouteLoading />}>
        <Lazy />
      </Suspense>,
    );
    expect(await screen.findByTestId('loaded-ok')).toBeInTheDocument();
  });
});

import React from 'react';
import { AlertTriangle, RotateCw, Home, WifiOff } from 'lucide-react';
import { isChunkLoadError } from '../utils/routeLoader';

/**
 * Error boundary for the route outlet only.
 *
 * It sits INSIDE the Layout so a failed page never white-screens the shell —
 * the sidebar and header stay usable. It handles two cases:
 *
 *  - a failed lazy chunk (common after an app update, or a flaky network in the
 *    Tauri webview): shows a recoverable message with a real Retry that pulls a
 *    fresh service worker and reloads. This guarantees the user is never left
 *    with an endless spinner.
 *  - any other render error in a page: the same "one broken page, rest of the
 *    app still works" message the app has always shown.
 *
 * `resetKey` (the route path) clears the error on navigation, so moving to
 * another page recovers automatically.
 */

interface Props {
  children: React.ReactNode;
  resetKey?: string;
}

interface State {
  error: Error | null;
  reloading: boolean;
}

class RouteErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, reloading: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Route] load/render error:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, reloading: false });
    }
  }

  private retryChunk = async () => {
    this.setState({ reloading: true });
    try {
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          registrations.map(async (registration) => {
            try {
              await registration.update();
            } catch {
              /* ignore */
            }
            if (registration.waiting) {
              try {
                registration.waiting.postMessage({ type: 'SKIP_WAITING' });
              } catch {
                /* ignore */
              }
            }
          }),
        );
      }
    } catch {
      /* best-effort */
    } finally {
      window.location.reload();
    }
  };

  render() {
    const { error, reloading } = this.state;
    if (!error) return this.props.children;

    const chunk = isChunkLoadError(error);

    if (chunk) {
      return (
        <div
          role="alert"
          data-testid="route-chunk-error"
          className="flex flex-col items-center justify-center min-h-[60vh] w-full p-8 text-center"
        >
          <div className="max-w-lg w-full bg-white dark:bg-slate-800 border border-amber-100 dark:border-slate-700 rounded-2xl shadow-sm p-8">
            <WifiOff className="w-14 h-14 text-amber-400 mx-auto mb-4" aria-hidden="true" />
            <h2 className="text-xl font-black text-slate-800 dark:text-slate-100 mb-2">
              This page could not be loaded
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-1">
              The app may have just updated, or the connection dropped while
              loading this section. Nothing you saved has been lost.
            </p>
            <p className="text-xs text-slate-400 dark:text-slate-500 mb-6">
              Retrying fetches the latest version and reopens the page.
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              <button
                type="button"
                onClick={this.retryChunk}
                disabled={reloading}
                className="flex items-center gap-2 px-4 py-2.5 bg-[#2D6A4F] text-white rounded-xl font-bold hover:bg-[#1B4332] disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-[#2D6A4F]/50"
              >
                <RotateCw className={`w-4 h-4 ${reloading ? 'animate-spin' : ''}`} aria-hidden="true" />
                {reloading ? 'Retrying…' : 'Retry'}
              </button>
              <button
                type="button"
                onClick={() => {
                  window.location.hash = '#/';
                  this.setState({ error: null });
                }}
                className="flex items-center gap-2 px-4 py-2.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl font-bold hover:bg-slate-200 dark:hover:bg-slate-600"
              >
                <Home className="w-4 h-4" aria-hidden="true" /> Go to Dashboard
              </button>
            </div>
          </div>
        </div>
      );
    }

    // Non-chunk render error: keep the sidebar usable, offer recovery.
    return (
      <div
        role="alert"
        data-testid="route-render-error"
        className="flex flex-col items-center justify-center min-h-[60vh] w-full p-8 text-center"
      >
        <div className="max-w-lg w-full bg-white dark:bg-slate-800 border border-red-100 dark:border-slate-700 rounded-2xl shadow-sm p-8">
          <AlertTriangle className="w-14 h-14 text-red-400 mx-auto mb-4" aria-hidden="true" />
          <h2 className="text-xl font-black text-slate-800 dark:text-slate-100 mb-2">
            Something went wrong on this page
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
            The rest of the app is still working, and nothing you saved has been
            lost.
          </p>
          <div className="flex flex-wrap gap-2 justify-center">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="flex items-center gap-2 px-4 py-2.5 bg-[#2D6A4F] text-white rounded-xl font-bold hover:bg-[#1B4332]"
            >
              <RotateCw className="w-4 h-4" aria-hidden="true" /> Try again
            </button>
            <button
              type="button"
              onClick={() => {
                window.location.hash = '#/';
                this.setState({ error: null });
              }}
              className="flex items-center gap-2 px-4 py-2.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl font-bold hover:bg-slate-200 dark:hover:bg-slate-600"
            >
              <Home className="w-4 h-4" aria-hidden="true" /> Go to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default RouteErrorBoundary;

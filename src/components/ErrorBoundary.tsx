import React from 'react';
import { AlertTriangle, RotateCw, Home, Download } from 'lucide-react';

/**
 * Catches render errors so one broken page cannot white-screen the whole app.
 *
 * This matters more than usual here: the app is offline-first and everything
 * lives on the student's device. A crash used to leave a blank window with no
 * way to reach Settings, which is where the export/backup button is — so the
 * data was still there but effectively unreachable. The fallback therefore
 * offers a data export as well as recovery.
 *
 * Only render-phase errors are caught. Event handlers and async code are not,
 * so those still need their own try/catch.
 */

interface Props {
  children: React.ReactNode;
  /** Shown in the message, e.g. "Quiz". */
  label?: string;
  /** Remount children when this changes (e.g. the route path). */
  resetKey?: string;
}

interface State {
  error: Error | null;
  info: React.ErrorInfo | null;
}

class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep the stack in the console for F12 debugging.
    console.error(`[${this.props.label ?? 'App'}] render error:`, error, info.componentStack);
    this.setState({ info });
  }

  componentDidUpdate(prev: Props) {
    // Navigating away from a broken page should clear the error, otherwise the
    // fallback would persist across routes.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, info: null });
    }
  }

  private exportBackup = () => {
    try {
      const raw = localStorage.getItem('pharmatrack_state') ?? '{}';
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `pharmatrack-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Backup export failed:', err);
    }
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const where = this.props.label ? ` in ${this.props.label}` : '';

    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] w-full p-8 text-center">
        <div className="max-w-lg w-full bg-white border border-red-100 rounded-2xl shadow-sm p-8">
          <AlertTriangle className="w-14 h-14 text-red-400 mx-auto mb-4" />
          <h2 className="text-xl font-black text-slate-800 mb-2">Something went wrong{where}</h2>
          <p className="text-sm text-slate-500 mb-1">
            The rest of the app is still working, and nothing you saved has been lost.
          </p>
          <p className="text-xs text-slate-400 mb-6">
            Your courses, slides and notes are stored on this device, not in this page.
          </p>

          <div className="flex flex-wrap gap-2 justify-center">
            <button
              onClick={() => this.setState({ error: null, info: null })}
              className="flex items-center gap-2 px-4 py-2.5 bg-[#2D6A4F] text-white rounded-xl font-bold hover:bg-[#1B4332]"
            >
              <RotateCw className="w-4 h-4" /> Try again
            </button>
            <button
              onClick={() => { window.location.hash = '#/'; this.setState({ error: null, info: null }); }}
              className="flex items-center gap-2 px-4 py-2.5 bg-slate-100 text-slate-700 rounded-xl font-bold hover:bg-slate-200"
            >
              <Home className="w-4 h-4" /> Go to Dashboard
            </button>
            <button
              onClick={this.exportBackup}
              title="Save a copy of your data before doing anything else"
              className="flex items-center gap-2 px-4 py-2.5 bg-slate-100 text-slate-700 rounded-xl font-bold hover:bg-slate-200"
            >
              <Download className="w-4 h-4" /> Export backup
            </button>
          </div>

          <details className="mt-6 text-left">
            <summary className="text-[11px] font-black uppercase tracking-widest text-slate-400 cursor-pointer hover:text-slate-600">
              Technical details
            </summary>
            <pre className="mt-2 p-3 bg-slate-900 text-red-300 text-[10px] rounded-lg overflow-auto max-h-48 whitespace-pre-wrap">
              {error.message}
              {this.state.info?.componentStack}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;

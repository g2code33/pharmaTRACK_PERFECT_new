import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minus, X } from 'lucide-react';
import { detectRuntimeCapabilities, getApplicationVersion } from '../platform/runtime';
import { reportNativeTitlebar } from '../platform/nativeTitlebar';

const APP_VERSION_FALLBACK = __APP_VERSION__;

type NativeDesktopWindow = {
  startDragging: () => Promise<void>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  close: () => Promise<void>;
};

type NativeWindowAction = 'drag' | 'minimize' | 'toggleMaximize' | 'close';

/**
 * The desktop window strip: drag area, app name, and the minimize / maximize /
 * close buttons.
 *
 * The desktop windows are created without system decorations so Windows and
 * Linux look the same, which means these buttons are the ONLY way to minimize,
 * maximize or close the app. Every full-height screen therefore has to render
 * this — a screen that forgets it is a window the user cannot close.
 *
 * It also tells the native side that it exists. If this never happens (an old
 * cached bundle, or a screen that forgot it), the Rust side puts the system
 * title bar back after a few seconds so the window is never trapped. See
 * src-tauri/src/main.rs.
 *
 * Renders nothing outside the desktop app.
 */
export interface NativeTitleBarProps {
  /**
   * Use on screens that scroll as one page, so the window controls stay
   * reachable instead of scrolling away. Screens that are a flex column of
   * fixed height do not need it.
   */
  sticky?: boolean;
}

const NativeTitleBar: React.FC<NativeTitleBarProps> = ({ sticky = false }) => {
  const runtime = detectRuntimeCapabilities();
  const nativeWindowRef = useRef<NativeDesktopWindow | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [appVersion, setAppVersion] = useState(APP_VERSION_FALLBACK);

  const platformLabel =
    typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent)
      ? 'Windows App'
      : 'Desktop App';

  const getWindow = useCallback(async (): Promise<NativeDesktopWindow | null> => {
    if (!runtime.nativeWebview) return null;
    if (!nativeWindowRef.current) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        nativeWindowRef.current = getCurrentWindow() as unknown as NativeDesktopWindow;
      } catch (error) {
        // A missing or half-initialised bridge must not take the app down with
        // an unhandled rejection; the native safety net restores the system
        // title bar instead.
        console.warn('Native window handle is unavailable', error);
        return null;
      }
    }
    return nativeWindowRef.current;
  }, [runtime.nativeWebview]);

  const syncMaximized = useCallback(async () => {
    const win = await getWindow();
    if (!win) return;
    try {
      setIsMaximized(await win.isMaximized());
    } catch {
      setIsMaximized(false);
    }
  }, [getWindow]);

  const run = useCallback(
    async (action: NativeWindowAction) => {
      const win = await getWindow();
      if (!win) return;
      try {
        if (action === 'drag') await win.startDragging();
        if (action === 'minimize') await win.minimize();
        if (action === 'toggleMaximize') {
          await win.toggleMaximize();
          await syncMaximized();
        }
        if (action === 'close') await win.close();
      } catch (error) {
        console.warn(`Native window action failed: ${action}`, error);
      }
    },
    [getWindow, syncMaximized],
  );

  useEffect(() => {
    if (!runtime.nativeWebview) return;
    void syncMaximized();
    void getApplicationVersion(APP_VERSION_FALLBACK).then(setAppVersion);
  }, [runtime.nativeWebview, syncMaximized]);

  useEffect(() => {
    if (!runtime.nativeWebview) return undefined;
    reportNativeTitlebar(true);
    return () => reportNativeTitlebar(false);
  }, [runtime.nativeWebview]);

  if (!runtime.nativeWebview) return null;

  return (
    <div
      className={`native-titlebar flex h-9 flex-shrink-0 items-center border-b border-slate-200 bg-white text-slate-900 shadow-sm ${sticky ? 'sticky top-0 z-[500]' : ''}`}
    >
      <div
        className="native-titlebar-drag flex h-full flex-1 select-none items-center gap-2 overflow-hidden px-3"
        data-tauri-drag-region
        onMouseDown={(event) => {
          if (event.button === 0 && event.detail === 1) void run('drag');
        }}
        onDoubleClick={() => void run('toggleMaximize')}
        title="Drag to move · Double-click to maximize"
      >
        {/* One compact line. The window strip used to be 44px tall and
            repeated the branding that the sidebar and header already show,
            which is pure vertical real estate on a laptop screen. */}
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white">
          <img src="/logo.png" alt="PharmaTRACK" className="h-full w-full object-cover scale-110" />
        </div>
        <p className="truncate text-xs font-black uppercase italic tracking-tight text-slate-900">
          Pharma<span className="text-emerald-600">TRACK</span>
        </p>
        <span className="hidden rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.18em] text-emerald-700 sm:inline-flex">
          {platformLabel}
        </span>
        <span className="hidden truncate text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400 lg:inline">
          Track · Learn · Achieve · v{appVersion}
        </span>
      </div>
      <div className="flex h-full items-center pr-1">
        <button
          type="button"
          aria-label="Minimize PharmaTRACK"
          title="Minimize"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => void run('minimize')}
          className="native-window-control"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={isMaximized ? 'Restore PharmaTRACK window' : 'Maximize PharmaTRACK'}
          title={isMaximized ? 'Restore' : 'Maximize'}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => void run('toggleMaximize')}
          className="native-window-control"
        >
          <Maximize2 className={`h-3.5 w-3.5 ${isMaximized ? 'scale-90' : ''}`} />
        </button>
        <button
          type="button"
          aria-label="Close PharmaTRACK"
          title="Close"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => void run('close')}
          className="native-window-control native-window-control-close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

export default NativeTitleBar;

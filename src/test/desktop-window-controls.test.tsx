/**
 * The desktop window must always be minimizable, maximizable and closable.
 *
 * Both desktop builds are created without system decorations so Windows and
 * Linux look identical, which makes the app's own window strip the only place
 * those controls exist. A screen that does not render it is a window the user
 * cannot close — which is exactly what the Windows build looked like next to
 * the Linux one.
 *
 * Two guarantees are locked in here: every full-height screen renders the
 * strip, and the native side restores the system title bar if the front-end
 * never reports one (an old cached bundle, or a crash before React mounts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import NativeTitleBar from '../components/NativeTitleBar';
import { resetNativeTitlebarReportingForTests } from '../platform/nativeTitlebar';

const root = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function enterDesktopShell(): void {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    invoke: () => Promise.resolve(),
    transformCallback: (callback: unknown) => callback,
  };
}

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  resetNativeTitlebarReportingForTests();
  vi.restoreAllMocks();
});

describe('the window strip', () => {
  it('renders minimize, maximize and close inside the desktop app', () => {
    enterDesktopShell();
    render(<NativeTitleBar />);
    expect(screen.getByLabelText('Minimize PharmaTRACK')).toBeInTheDocument();
    expect(screen.getByLabelText('Maximize PharmaTRACK')).toBeInTheDocument();
    expect(screen.getByLabelText('Close PharmaTRACK')).toBeInTheDocument();
  });

  it('renders nothing at all on the web, where the browser owns the window', () => {
    const { container } = render(<NativeTitleBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers a draggable region so an undecorated window can still be moved', () => {
    enterDesktopShell();
    const { container } = render(<NativeTitleBar />);
    expect(container.querySelector('[data-tauri-drag-region]')).not.toBeNull();
  });

  it('looks the same on Windows as it does on Linux apart from its label', () => {
    const source = stripComments(read('src/components/NativeTitleBar.tsx'));
    // One component, one markup path. The only thing the platform decides is
    // the wording of the badge; nothing is added, removed or restyled.
    expect(source.match(/\/windows\/i/g) || []).toHaveLength(1);
    expect(source).toContain('const platformLabel =');
    expect(source).not.toMatch(/platformLabel\s*(\?|===|!==)/);
  });
});

describe('every full-height screen has window controls', () => {
  const screens: Array<[string, string]> = [
    ['the main app shell', 'src/components/Layout.tsx'],
    ['a shared quick quiz', 'src/pages/QuickQuiz.tsx'],
    ['a shared course', 'src/pages/QuickCourse.tsx'],
    ['sign in', 'src/pages/Login.tsx'],
    ['first run', 'src/pages/Onboarding.tsx'],
    ['the storage-blocked screen', 'src/App.tsx'],
  ];

  it.each(screens)('%s renders the strip', (_label, file) => {
    const source = read(file);
    expect(source).toContain('NativeTitleBar');
    expect(source).toMatch(/import NativeTitleBar from/);
  });

  it('covers each of the quiz page\'s own full-screen states', () => {
    const source = read('src/pages/QuickQuiz.tsx');
    // loading, error, paused, finished and the quiz itself.
    expect(source.match(/<NativeTitleBar/g) || []).toHaveLength(5);
  });

  it('keeps the strip reachable on screens that scroll as one page', () => {
    const component = read('src/components/NativeTitleBar.tsx');
    expect(component).toContain("sticky ? 'sticky top-0 z-[500]' : ''");
    expect(read('src/pages/QuickQuiz.tsx')).toContain('<NativeTitleBar sticky />');
  });
});

describe('the native safety net', () => {
  it('restores the system title bar when nothing claims it', () => {
    const rust = read('src-tauri/src/main.rs');
    expect(rust).toContain('struct CustomTitlebarState');
    expect(rust).toContain('TITLEBAR_FALLBACK_DELAY');
    expect(rust).toContain('fn set_native_titlebar');
    expect(rust).toContain('window.set_decorations(!custom)');
    expect(rust).toContain('set_decorations(true)');
    // The command has to be reachable from the front-end.
    expect(rust).toContain('set_native_titlebar,');
  });

  it('is told as soon as the app draws its own strip', () => {
    const component = stripComments(read('src/components/NativeTitleBar.tsx'));
    expect(component).toContain('reportNativeTitlebar(true)');
    expect(component).toContain('reportNativeTitlebar(false)');

    const reporter = stripComments(read('src/platform/nativeTitlebar.ts'));
    expect(reporter).toContain("nativeInvoke('set_native_titlebar', { custom })");
    // Navigating unmounts one strip and mounts the next in the same tick, so
    // disappearance has to be debounced or the system bar flashes.
    expect(reporter).toContain('HIDE_DEBOUNCE_MS');
  });

  it('says nothing at all outside the desktop app', async () => {
    const { reportNativeTitlebar } = await import('../platform/nativeTitlebar');
    const runtime = await import('../platform/runtime');
    const invoke = vi.spyOn(runtime, 'nativeInvoke');
    reportNativeTitlebar(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('the desktop window itself', () => {
  it('is undecorated on both platforms, so one strip serves both', () => {
    const config = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      app: { windows: Array<Record<string, unknown>> };
    };
    const main = config.app.windows[0];
    expect(main.decorations).toBe(false);
    expect(main.resizable).toBe(true);
  });

  it('is allowed to run every control the strip offers', () => {
    const capability = JSON.parse(read('src-tauri/capabilities/migrated.json')) as {
      permissions: string[];
    };
    for (const permission of [
      'core:window:allow-start-dragging',
      'core:window:allow-minimize',
      'core:window:allow-toggle-maximize',
      'core:window:allow-is-maximized',
      'core:window:allow-close',
    ]) {
      expect(capability.permissions).toContain(permission);
    }
  });
});

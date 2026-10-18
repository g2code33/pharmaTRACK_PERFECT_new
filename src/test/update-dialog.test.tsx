/**
 * Updating must look and behave like the rest of PharmaTRACK.
 *
 * The update pill used to drive `window.confirm` and `alert`. Those dialogs
 * belong to the host browser, not to the app: they block the JavaScript
 * thread (so the download progress behind them never painted), they are
 * unstyled, they ignore dark mode, and inside a packaged WebView they are the
 * one surface the app cannot control — on some Linux WebKitGTK builds
 * `confirm()` returns false without ever being shown, which silently declined
 * every update the user was offered.
 *
 * These tests lock in the replacement: an in-app sheet with a real progress
 * bar, a download that cannot be dismissed half-way, and no native dialog
 * anywhere in the update path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import UpdateDialog, { type UpdateFlowState } from '../components/UpdateDialog';
import { formatDownloadSize, updateDownloadPercent } from '../utils/updateProgress';

const root = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const noop = () => undefined;

function renderDialog(state: UpdateFlowState | null, overrides: Partial<Record<string, () => void>> = {}) {
  return render(
    <UpdateDialog
      state={state}
      onInstall={(overrides.onInstall as () => void) || noop}
      onRestart={(overrides.onRestart as () => void) || noop}
      onRetry={(overrides.onRetry as () => void) || noop}
      onOpenStore={(overrides.onOpenStore as () => void) || noop}
      onClose={(overrides.onClose as () => void) || noop}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the update sheet replaces every native dialog', () => {
  it('leaves no window.confirm or alert in the update flow', () => {
    const layout = stripComments(read('src/components/Layout.tsx'));
    const dialog = stripComments(read('src/components/UpdateDialog.tsx'));

    for (const source of [layout, dialog]) {
      expect(source).not.toMatch(/window\.alert\(/);
      expect(source).not.toMatch(/[^.\w]alert\(/);
    }

    // The update path specifically: none of the old prompts may return.
    expect(layout).not.toContain('is available! Do you want to download and install it now?');
    expect(layout).not.toContain('Update installed successfully!');
    expect(layout).not.toContain('You are already on the latest version');
    expect(layout).not.toContain('Update Check Failed');

    // ...and the sheet is actually mounted by the shell.
    expect(layout).toContain('<UpdateDialog');
    expect(layout).toContain("from './UpdateDialog'");
  });

  it('sits above the native title bar so the desktop strip never clips it', () => {
    const dialog = read('src/components/UpdateDialog.tsx');
    const titlebar = read('src/components/NativeTitleBar.tsx');

    const layer = (source: string) =>
      Math.max(...[...source.matchAll(/z-\[(\d+)\]/g)].map((match) => Number(match[1])));

    expect(layer(dialog)).toBeGreaterThan(layer(titlebar));
  });

  it('renders nothing while the flow is closed', () => {
    const { container } = renderDialog(null);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers the update with release notes and an explicit Later', () => {
    const onInstall = vi.fn();
    renderDialog({ kind: 'available', version: '1.3.0', notes: 'Faster slide reader.' }, { onInstall });

    expect(screen.getByText('Update available')).toBeTruthy();
    expect(screen.getByText(/Version 1\.3\.0/)).toBeTruthy();
    expect(screen.getByText('Faster slide reader.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Later/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Install now/ }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it('paints real download progress instead of a frozen window', () => {
    renderDialog({ kind: 'downloading', version: '1.3.0', received: 5 * 1024 * 1024, total: 20 * 1024 * 1024 });

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect((bar as HTMLElement).style.width).toBe('25%');
    expect(screen.getByText(/25% · 5\.0 MB of 20\.0 MB/)).toBeTruthy();
  });

  it('falls back to an indeterminate bar when the server sends no size', () => {
    renderDialog({ kind: 'downloading', version: '1.3.0', received: 1024 * 1024, total: 0 });

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(bar.className).toContain('animate-pulse');
    expect(screen.getByText(/1\.0 MB downloaded/)).toBeTruthy();
  });

  it('cannot be dismissed while the package is downloading', () => {
    const onClose = vi.fn();
    renderDialog({ kind: 'downloading', version: '1.3.0', received: 1, total: 100 }, { onClose });

    expect(screen.queryByRole('button', { name: /Close update sheet/ })).toBeNull();
    fireEvent.click(screen.getByRole('dialog'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape and on a backdrop tap once it is safe to', () => {
    const onClose = vi.fn();
    renderDialog({ kind: 'current', version: '1.2.2' }, { onClose });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('asks for a restart when the install is finished', () => {
    const onRestart = vi.fn();
    renderDialog({ kind: 'installed', version: '1.3.0' }, { onRestart });

    expect(screen.getByText('Update installed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Restart now/ }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('sends the Android build to the download page rather than claiming it is current', () => {
    const onOpenStore = vi.fn();
    renderDialog({ kind: 'store', version: '1.2.2' }, { onOpenStore });

    fireEvent.click(screen.getByRole('button', { name: /Open download page/ }));
    expect(onOpenStore).toHaveBeenCalledTimes(1);
  });

  it('shows a failure in-app with a retry', () => {
    const onRetry = vi.fn();
    renderDialog({ kind: 'failed', message: 'The update server did not answer within 20s.' }, { onRetry });

    expect(screen.getByText('Update failed')).toBeTruthy();
    expect(screen.getByText(/did not answer within 20s/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('computes progress safely', () => {
    expect(updateDownloadPercent(0, 0)).toBeNull();
    expect(updateDownloadPercent(10, 0)).toBeNull();
    expect(updateDownloadPercent(0, 100)).toBe(0);
    expect(updateDownloadPercent(50, 100)).toBe(50);
    expect(updateDownloadPercent(500, 100)).toBe(100);
    expect(formatDownloadSize(0)).toBe('0 MB');
    expect(formatDownloadSize(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatDownloadSize(2048)).toBe('2 KB');
  });
});

describe('the pill always tells the truth about the update', () => {
  const layout = stripComments(read('src/components/Layout.tsx'));

  it('never leaves the launch check spinning and never pops a sheet on boot', () => {
    // The quiet check only arms the pill; the sheet is opened by a tap.
    expect(layout).toContain("const showSheet = (next: UpdateFlowState) => {");
    expect(layout).toContain("if (!silent && runId === updateRunIdRef.current) setUpdateFlow(next);");
    expect(layout).toContain("setUpdateStatus((current) => (current === 'checking' ? 'idle' : current));");
  });

  it('turns into the offer once an update is waiting', () => {
    expect(layout).toContain('`Update ${pendingUpdateVersion}`');
    expect(layout).toContain("updateStatus === 'done' ? 'Restart now'");
    expect(layout).toContain("updateStatus === 'done' ? void restartForUpdate() : void checkForUpdates(false)");
  });

  it('reopens a pending offer instead of checking the network twice', () => {
    expect(layout).toContain('if (!silent && pendingUpdateRef.current) {');
  });

  it('throttles download repaints so the shell stays responsive', () => {
    expect(layout).toContain('if (!finished && now - lastPaintedAt < 120) return;');
  });

  it('routes the Android build to the download page', () => {
    expect(layout).toContain("if (runtime.platform === 'android-native') {");
    expect(layout).toContain("setUpdateFlow({ kind: 'store', version: appVersion })");
    expect(layout).toContain('APP_STORE_URL');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(async (..._args: unknown[]) => () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import { createTauriKioskAdapter, queryNativeFullscreenActive } from '../examination/nativeKiosk';
import { KIOSK_CAPABILITY_IDS } from '../examination/kioskAdapter';

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockClear();
});

describe('native PC secure examination adapter', () => {
  it('reports native application controls without claiming OS lockdown or capture prevention', () => {
    const adapter = createTauriKioskAdapter(() => undefined, [KIOSK_CAPABILITY_IDS.windowControls]);
    const windowControls = adapter.matrix.capabilities.find(
      (item) => item.id === KIOSK_CAPABILITY_IDS.windowControls,
    );
    const screenCapture = adapter.matrix.capabilities.find(
      (item) => item.id === KIOSK_CAPABILITY_IDS.screenCapture,
    );
    expect(adapter.matrix.platform).toBe('TAURI_PC');
    expect(windowControls?.supportLevel).toBe('PARTIAL');
    expect(windowControls?.enforceable).toBe(true);
    expect(screenCapture?.supportLevel).toBe('NOT_GUARANTEED');
    expect(screenCapture?.enforceable).toBe(false);
  });

  it('authorizes entry and requires the native session handle to restore the window', async () => {
    invokeMock.mockResolvedValueOnce({
      sessionToken: 'session-1',
      capabilities: [],
    });
    const adapter = createTauriKioskAdapter(() => undefined);
    expect(await adapter.enterSecureMode?.('attempt-1')).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('enter_secure_exam_mode', { attemptId: 'attempt-1' });

    invokeMock.mockResolvedValueOnce(undefined);
    expect(await adapter.exitSecureMode?.()).toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith('exit_secure_exam_mode', {
      sessionToken: 'session-1',
    });
  });

  it('turns native focus, close, navigation, and external-link events into existing violations', async () => {
    let receiveEvent: ((event: { payload: { kind: string; detail: string } }) => void) | undefined;
    listenMock.mockImplementationOnce(async (...args: unknown[]) => {
      receiveEvent = args[1] as typeof receiveEvent;
      return () => undefined;
    });
    const violations: string[] = [];
    const adapter = createTauriKioskAdapter((event) => violations.push(event.violation));
    const cleanup = adapter.install();
    await Promise.resolve();
    receiveEvent?.({ payload: { kind: 'focus_lost', detail: 'focus lost' } });
    receiveEvent?.({ payload: { kind: 'close_blocked', detail: 'close blocked' } });
    receiveEvent?.({ payload: { kind: 'navigation_blocked', detail: 'navigation blocked' } });
    receiveEvent?.({ payload: { kind: 'external_link_blocked', detail: 'external blocked' } });
    expect(violations).toEqual([
      'FOCUS_LOST',
      'ATTEMPTED_EXIT',
      'ATTEMPTED_NAVIGATION',
      'EXTERNAL_LINK_ATTEMPT',
    ]);
    cleanup();
  });

  describe('native fullscreen reassertion (Return to Fullscreen button)', () => {
    // Before this fix, `requestFullscreen` was a no-op stub that never
    // called into the OS window at all, and the page's own exited-fullscreen
    // detector only ever looked at the DOM Fullscreen API — which native-pc
    // secure exams never use (they fullscreen the OS window directly). The
    // button therefore visibly did nothing when clicked.

    it('asks the native host to re-enter fullscreen and reports the resulting state', async () => {
      invokeMock.mockResolvedValueOnce({ sessionToken: 'session-1', capabilities: [] });
      const adapter = createTauriKioskAdapter(() => undefined);
      await adapter.enterSecureMode?.('attempt-1');

      invokeMock.mockResolvedValueOnce(true);
      expect(await adapter.requestFullscreen()).toBe(true);
      expect(invokeMock).toHaveBeenLastCalledWith('reassert_secure_exam_fullscreen');
    });

    it('returns false without calling the native host when no secure session has been entered', async () => {
      const adapter = createTauriKioskAdapter(() => undefined);
      expect(await adapter.requestFullscreen()).toBe(false);
      expect(invokeMock).not.toHaveBeenCalledWith('reassert_secure_exam_fullscreen');
    });

    it('returns false if the native reassertion call fails', async () => {
      invokeMock.mockResolvedValueOnce({ sessionToken: 'session-1', capabilities: [] });
      const adapter = createTauriKioskAdapter(() => undefined);
      await adapter.enterSecureMode?.('attempt-1');

      invokeMock.mockRejectedValueOnce(new Error('no secure examination is active'));
      expect(await adapter.requestFullscreen()).toBe(false);
    });

    it('queries the real native fullscreen state instead of the (unused) DOM Fullscreen API', async () => {
      invokeMock.mockResolvedValueOnce(true);
      expect(await queryNativeFullscreenActive()).toBe(true);
      expect(invokeMock).toHaveBeenLastCalledWith('secure_exam_fullscreen_active');

      invokeMock.mockResolvedValueOnce(false);
      expect(await queryNativeFullscreenActive()).toBe(false);
    });

    it('reports fullscreen state as unknown (undefined) rather than falsely "exited" if the query fails', async () => {
      invokeMock.mockRejectedValueOnce(new Error('no window'));
      expect(await queryNativeFullscreenActive()).toBeUndefined();
    });
  });
});

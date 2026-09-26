import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(async (..._args: unknown[]) => () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import { createTauriKioskAdapter } from '../examination/nativeKiosk';
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
});

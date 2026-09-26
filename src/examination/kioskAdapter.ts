import type {
  KioskPlatform,
  PlatformCapability,
  PlatformCapabilityMatrix,
  SecurityViolation,
  ViolationPolicy,
} from './types';

export const KIOSK_CAPABILITY_IDS = {
  navigation: 'browser-navigation-block',
  copyPaste: 'copy-paste-block',
  printing: 'printing-block',
  externalLinks: 'external-link-block',
  devTools: 'developer-tools-detection',
  windowControls: 'window-control-restriction',
  screenCapture: 'screen-capture-restriction',
  focus: 'focus-monitoring',
  immersive: 'immersive-window',
  lockTask: 'android-lock-task',
  fileAssociation: 'pharmaexam-file-association',
} as const;

export interface KioskViolation {
  violation: SecurityViolation;
  detail: string;
  prevented: boolean;
}

export interface KioskRestrictionPolicy {
  navigation?: boolean;
  copyPaste?: boolean;
  printing?: boolean;
  externalLinks?: boolean;
  developerTools?: boolean;
  exit?: boolean;
  focus?: boolean;
}

export interface KioskAdapter {
  readonly matrix: PlatformCapabilityMatrix;
  install(): () => void;
  requestFullscreen(): Promise<boolean>;
  /** Native hosts may enforce window controls and return a session-scoped handle. */
  enterSecureMode?: (attemptId: string) => Promise<boolean>;
  exitSecureMode?: () => Promise<boolean>;
}

export function platform(): KioskPlatform {
  return 'web';
}

function capability(
  id: string,
  label: string,
  supported: boolean,
  enforceable: boolean,
  required: boolean,
  notes: string,
  supportLevel: PlatformCapability['supportLevel'] = !supported
    ? 'UNAVAILABLE'
    : enforceable
      ? 'SUPPORTED'
      : 'NOT_GUARANTEED',
): PlatformCapability {
  return {
    id,
    label,
    supportLevel,
    supported,
    enforceable,
    detected: supported,
    required,
    notes,
  };
}

export function createCapabilityMatrix(
  kind: KioskPlatform = platform(),
  requiredIds: string[] = [],
): PlatformCapabilityMatrix {
  const android = kind === 'ANDROID_WEB' || kind === 'ANDROID_NATIVE' || kind === 'android';
  const native = kind === 'TAURI_PC' || kind === 'ANDROID_NATIVE' || kind === 'native-pc';
  const capabilities = [
    capability(
      KIOSK_CAPABILITY_IDS.navigation,
      'PharmaTRACK navigation block',
      true,
      true,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.navigation),
      'The secure route omits normal application navigation; browser escape cannot be fully controlled.',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.copyPaste,
      'Copy and paste restriction',
      true,
      true,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.copyPaste),
      'Browser events can prevent exam-page copy, cut, and paste; operating-system clipboard access is not universally controllable.',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.printing,
      'Print restriction',
      true,
      true,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.printing),
      'Print shortcuts and beforeprint are blocked in the exam page; OS-level print controls are not guaranteed.',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.externalLinks,
      'External link restriction',
      true,
      true,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.externalLinks),
      'Exam-page external link activation is prevented and audited.',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.devTools,
      'Developer tools restriction',
      false,
      false,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.devTools),
      'Web browsers do not provide a reliable developer-tools prevention API. Attempts can only be heuristically audited.',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.windowControls,
      'Window manipulation restriction',
      false,
      false,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.windowControls),
      native
        ? 'Native host may provide a policy adapter; this browser adapter cannot guarantee it.'
        : 'A browser tab cannot reliably prevent minimize, close, task switching, or another window.',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.screenCapture,
      'Screen capture restriction',
      false,
      false,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.screenCapture),
      android
        ? 'This web adapter cannot guarantee Android capture prevention; a native adapter must report actual support.'
        : 'This browser adapter cannot reliably prevent OS screenshots or capture.',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.focus,
      'Focus-loss monitoring',
      true,
      false,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.focus),
      'Focus and visibility changes are observable and logged, but are not automatically cheating.',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.immersive,
      'Immersive examination UI',
      true,
      false,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.immersive),
      'Fullscreen is requested when the browser grants permission; the student or browser may deny it.',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.lockTask,
      'Android lock-task / PC native lockdown',
      false,
      false,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.lockTask),
      'Available only through a separately deployed native adapter with OS permission; not guaranteed in web mode.',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.fileAssociation,
      'PharmaTRACK .pharmaexam file association / intent route',
      false,
      false,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.fileAssociation),
      'Available only when the Tauri PC bundle or an Android host bridge actually registers the file route.',
    ),
  ];
  return { platform: kind, generatedAt: new Date().toISOString(), capabilities };
}

export function requiredCapabilitiesReady(
  matrix: PlatformCapabilityMatrix,
  requiredIds: string[],
): { ok: boolean; unavailable: PlatformCapability[] } {
  const unavailable = matrix.capabilities.filter(
    (item) => requiredIds.includes(item.id) && (!item.supported || !item.enforceable),
  );
  return { ok: unavailable.length === 0, unavailable };
}

export function createBrowserKioskAdapter(
  onViolation: (event: KioskViolation) => void,
  requiredIds: string[] = [],
  policy: KioskRestrictionPolicy = {},
  platformKind: KioskPlatform = 'web',
): KioskAdapter {
  const restrictions = {
    navigation: policy.navigation !== false,
    copyPaste: policy.copyPaste !== false,
    printing: policy.printing !== false,
    externalLinks: policy.externalLinks !== false,
    developerTools: policy.developerTools !== false,
    exit: policy.exit !== false,
    focus: policy.focus !== false,
  };
  const matrix = createCapabilityMatrix(platformKind, requiredIds);
  const prevent = (event: Event, violation: SecurityViolation, detail: string) => {
    event.preventDefault();
    onViolation({ violation, detail, prevented: true });
  };
  const install = () => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return () => undefined;
    const onCopy = (event: ClipboardEvent) =>
      prevent(event, 'ATTEMPTED_COPY_PASTE', `${event.type} was attempted in secure examination.`);
    const onPrint = (event: Event) =>
      prevent(event, 'ATTEMPTED_PRINT', 'Printing was attempted in secure examination.');
    const onContext = (event: MouseEvent) =>
      prevent(event, 'ATTEMPTED_COPY_PASTE', 'Context menu was attempted in secure examination.');
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const modifier = event.ctrlKey || event.metaKey;
      if (
        modifier &&
        ((restrictions.copyPaste && ['c', 'v', 'x', 's', 'u'].includes(key)) ||
          (restrictions.printing && key === 'p'))
      )
        prevent(
          event,
          key === 'p' ? 'ATTEMPTED_PRINT' : 'ATTEMPTED_COPY_PASTE',
          `Shortcut Ctrl/Command+${key.toUpperCase()} was attempted.`,
        );
      if (
        restrictions.developerTools &&
        (key === 'f12' || (event.ctrlKey && event.shiftKey && ['i', 'j', 'c'].includes(key)))
      )
        onViolation({
          violation: 'DEVELOPER_TOOL_ATTEMPT',
          detail:
            'A developer-tools shortcut was attempted; browser enforcement is not guaranteed.',
          prevented: false,
        });
      if (restrictions.exit && key === 'escape')
        onViolation({
          violation: 'ATTEMPTED_EXIT',
          detail: 'Escape was pressed in secure examination.',
          prevented: false,
        });
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const link = target?.closest?.('a') as HTMLAnchorElement | null;
      if (link?.href && new URL(link.href, window.location.href).origin !== window.location.origin)
        prevent(event, 'EXTERNAL_LINK_ATTEMPT', 'External link activation was blocked.');
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      onViolation({
        violation: 'ATTEMPTED_EXIT',
        detail: 'The browser attempted to close or navigate away from the examination.',
        prevented: true,
      });
      event.returnValue = '';
    };
    const onBlur = () =>
      onViolation({
        violation: 'FOCUS_LOST',
        detail:
          'Exam window lost focus. This is logged for review and is not automatically cheating.',
        prevented: false,
      });
    const onOffline = () =>
      onViolation({
        violation: 'NETWORK_LOSS',
        detail: 'Network became unavailable; encrypted local saving continues.',
        prevented: false,
      });
    const onOnline = () =>
      onViolation({
        violation: 'RECOVERY',
        detail: 'Network became available again; queued events can synchronize.',
        prevented: false,
      });
    const onFocus = () =>
      onViolation({
        violation: 'RECOVERY',
        detail: 'Exam window focus was restored.',
        prevented: false,
      });
    const secureHash = window.location.hash;
    const restoreSecureRoute = () => {
      if (!window.location.hash.includes('/examination/secure/')) {
        window.history.pushState(
          {},
          '',
          `${window.location.pathname}${window.location.search}${secureHash}`,
        );
        onViolation({
          violation: 'ATTEMPTED_NAVIGATION',
          detail: 'Normal PharmaTRACK navigation was attempted during secure examination.',
          prevented: true,
        });
      }
    };
    const onVisibility = () =>
      onViolation({
        violation: document.visibilityState === 'hidden' ? 'FOCUS_LOST' : 'RECOVERY',
        detail: `Document visibility changed to ${document.visibilityState}.`,
        prevented: false,
      });
    if (restrictions.copyPaste) {
      document.addEventListener('copy', onCopy);
      document.addEventListener('cut', onCopy);
      document.addEventListener('paste', onCopy);
      document.addEventListener('contextmenu', onContext);
    }
    if (restrictions.copyPaste || restrictions.printing || restrictions.developerTools || restrictions.exit)
      document.addEventListener('keydown', onKey, true);
    if (restrictions.externalLinks) document.addEventListener('click', onClick, true);
    if (restrictions.printing) window.addEventListener('beforeprint', onPrint);
    if (restrictions.exit) window.addEventListener('beforeunload', onBeforeUnload);
    if (restrictions.focus) {
      window.addEventListener('blur', onBlur);
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onVisibility);
    }
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    if (restrictions.navigation) {
      window.addEventListener('hashchange', restoreSecureRoute);
      window.addEventListener('popstate', restoreSecureRoute);
    }
    return () => {
      if (restrictions.copyPaste) {
        document.removeEventListener('copy', onCopy);
        document.removeEventListener('cut', onCopy);
        document.removeEventListener('paste', onCopy);
        document.removeEventListener('contextmenu', onContext);
      }
      if (restrictions.copyPaste || restrictions.printing || restrictions.developerTools || restrictions.exit)
        document.removeEventListener('keydown', onKey, true);
      if (restrictions.externalLinks) document.removeEventListener('click', onClick, true);
      if (restrictions.printing) window.removeEventListener('beforeprint', onPrint);
      if (restrictions.exit) window.removeEventListener('beforeunload', onBeforeUnload);
      if (restrictions.focus) {
        window.removeEventListener('blur', onBlur);
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onVisibility);
      }
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      if (restrictions.navigation) {
        window.removeEventListener('hashchange', restoreSecureRoute);
        window.removeEventListener('popstate', restoreSecureRoute);
      }
    };
  };
  return {
    matrix,
    install,
    requestFullscreen: async () => {
      if (typeof document === 'undefined' || !document.documentElement.requestFullscreen)
        return false;
      try {
        await document.documentElement.requestFullscreen();
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function policyForViolation(
  policyMap: Record<string, ViolationPolicy> | undefined,
  violation: SecurityViolation,
): ViolationPolicy {
  return policyMap?.[violation] || 'LOG_ONLY';
}

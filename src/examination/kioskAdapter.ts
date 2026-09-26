import type {
  KioskPlatform,
  PlatformCapability,
  PlatformCapabilityMatrix,
  SecurityViolation,
  ViolationPolicy,
} from './types';

export {
  getCentralPlatformCapabilityReport,
  formatCapabilityReportText,
  PLATFORM_SECURITY_CONTROLS,
  type PlatformTier,
  type SecurityRating,
} from './platformReport';

export const KIOSK_CAPABILITY_IDS = {
  navigation: 'browser-navigation-block',
  copyPaste: 'copy-paste-block',
  printing: 'printing-block',
  externalLinks: 'external-link-block',
  devTools: 'developer-tools-detection',
  windowControls: 'window-control-restriction',
  screenCapture: 'screen-capture-restriction',
  screenRecording: 'screen-recording-restriction',
  appSwitch: 'os-app-switch-restriction',
  homeGesture: 'mobile-home-gesture-restriction',
  osShortcuts: 'os-keyboard-shortcut-restriction',
  processKill: 'browser-process-termination-restriction',
  secondDevice: 'secondary-device-restriction',
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
  const isIos = kind === 'IOS_SAFARI' || kind === 'IOS_PWA';
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
      'UNAVAILABLE',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.screenRecording,
      'Screen recording restriction',
      false,
      false,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.screenRecording),
      'Browser APIs cannot detect or prevent operating-system screen recording.',
      'UNAVAILABLE',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.appSwitch,
      'OS application switch restriction',
      false,
      false,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.appSwitch),
      'Operating-system application switching (Alt+Tab, app switcher) cannot be blocked by browser sandboxes.',
      'UNAVAILABLE',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.homeGesture,
      'Mobile home gesture restriction',
      false,
      false,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.homeGesture),
      isIos
        ? 'iOS home indicator and swipe navigation gestures are reserved for the operating system.'
        : 'Mobile swipe gestures and hardware navigation buttons cannot be intercepted by web pages.',
      'UNAVAILABLE',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.osShortcuts,
      'OS keyboard shortcut restriction',
      false,
      false,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.osShortcuts),
      'Global OS shortcuts (Windows key, Command+Tab, Ctrl+Alt+Del) are outside browser reach.',
      'UNAVAILABLE',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.processKill,
      'Browser process termination restriction',
      false,
      false,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.processKill),
      'The browser cannot prevent the user or OS from terminating the browser process.',
      'UNAVAILABLE',
    ),
    capability(
      KIOSK_CAPABILITY_IDS.secondDevice,
      'Secondary physical device restriction',
      false,
      false,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.secondDevice),
      'A web examination client cannot prevent a student from using another physical device.',
      'UNAVAILABLE',
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
      kind !== 'IOS_SAFARI',
      kind === 'IOS_PWA' ? true : false,
      requiredIds.includes(KIOSK_CAPABILITY_IDS.immersive),
      kind === 'IOS_SAFARI'
        ? 'iPhone Safari does not support the Element Fullscreen API; Add to Home Screen PWA mode provides borderless standalone view.'
        : kind === 'IOS_PWA'
          ? 'Installed iPhone PWA runs in borderless standalone display mode without Safari browser chrome.'
          : 'Fullscreen is requested when the browser grants permission; the student or browser may deny it.',
      kind === 'IOS_SAFARI' ? 'NOT_GUARANTEED' : kind === 'IOS_PWA' ? 'SUPPORTED' : 'NOT_GUARANTEED',
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
      isIos
        ? 'Safari / iOS does not expose custom OS file association registration; package is selected via standard Files/file picker.'
        : 'Available only when the Tauri PC bundle or an Android host bridge actually registers the file route.',
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
      if (link?.href) {
        let isExternal = false;
        try {
          const parsed = new URL(link.href, window.location.href);
          if (parsed.origin !== window.location.origin) {
            isExternal = true;
          }
        } catch {
          isExternal = true;
        }
        if (isExternal) {
          prevent(event, 'EXTERNAL_LINK_ATTEMPT', `External link activation was blocked: ${link.href}`);
        }
      }
    };
    let originalOpen: typeof window.open | null = null;
    if (restrictions.externalLinks && typeof window !== 'undefined') {
      try {
        originalOpen = window.open;
        window.open = (url?: string | URL, target?: string, features?: string) => {
          onViolation({
            violation: 'EXTERNAL_LINK_ATTEMPT',
            detail: `Opening external or new window (${url ?? 'about:blank'}) was blocked.`,
            prevented: true,
          });
          return null;
        };
      } catch {
        // window.open may be non-configurable in some environments
      }
    }
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
    const onPageHide = (event: PageTransitionEvent) =>
      onViolation({
        violation: 'PAGE_HIDDEN',
        detail: `Exam page hide event triggered${event.persisted ? ' (cached in back-forward cache)' : ''}.`,
        prevented: false,
      });
    const onPageShow = (event: PageTransitionEvent) =>
      onViolation({
        violation: 'RECOVERY',
        detail: `Exam page show event triggered${event.persisted ? ' (restored from back-forward cache)' : ''}.`,
        prevented: false,
      });
    const onFullscreenChange = () => {
      if (typeof document !== 'undefined' && !document.fullscreenElement) {
        onViolation({
          violation: 'FULLSCREEN_EXIT',
          detail: 'Fullscreen mode was exited during the examination.',
          prevented: false,
        });
      }
    };
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
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        onViolation({
          violation: 'VISIBILITY_CHANGE',
          detail: 'Exam window visibility state changed to hidden.',
          prevented: false,
        });
      } else {
        onViolation({
          violation: 'RECOVERY',
          detail: 'Exam window visibility restored to visible.',
          prevented: false,
        });
      }
    };
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
      window.addEventListener('pagehide', onPageHide);
      window.addEventListener('pageshow', onPageShow);
      document.addEventListener('visibilitychange', onVisibility);
      document.addEventListener('fullscreenchange', onFullscreenChange);
      document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    }
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    if (restrictions.navigation) {
      window.addEventListener('hashchange', restoreSecureRoute);
      window.addEventListener('popstate', restoreSecureRoute);
    }
    return () => {
      if (originalOpen && typeof window !== 'undefined') {
        try {
          window.open = originalOpen;
        } catch {
          // Ignore
        }
      }
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
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('pageshow', onPageShow);
        document.removeEventListener('visibilitychange', onVisibility);
        document.removeEventListener('fullscreenchange', onFullscreenChange);
        document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
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
      if (typeof document === 'undefined') return false;
      try {
        if (!document.fullscreenElement && !(document as any).webkitFullscreenElement) {
          if (document.documentElement.requestFullscreen) {
            await document.documentElement.requestFullscreen();
          } else if ((document.documentElement as any).webkitRequestFullscreen) {
            await (document.documentElement as any).webkitRequestFullscreen();
          }
        }
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
  return (
    policyMap?.[violation] ||
    (violation === 'VISIBILITY_CHANGE' || violation === 'PAGE_HIDDEN' || violation === 'FULLSCREEN_EXIT'
      ? policyMap?.['FOCUS_LOST']
      : undefined) ||
    (violation === 'NETWORK_LOSS' || violation === 'SERVER_DISCONNECT' || violation === 'RECOVERY'
      ? 'LOG'
      : 'WARN')
  );
}

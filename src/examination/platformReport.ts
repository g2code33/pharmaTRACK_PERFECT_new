/**
 * PharmaTRACK Platform Security Capability Matrix
 *
 * Central authoritative evaluation of security capabilities across all supported
 * client tiers: PC Native, Android Native, Web, and iPhone PWA.
 *
 * Every security control is rated strictly and honestly:
 * - SUPPORTED: Guaranteed and fully enforceable by the platform host.
 * - LIMITED: Partially enforceable, heuristic, or requiring external MDM/OS policy.
 * - UNAVAILABLE: Cannot be guaranteed by userspace software without making false claims.
 */

export type PlatformTier = 'PC Native' | 'Android Native' | 'Web' | 'iPhone PWA';
export type SecurityRating = 'SUPPORTED' | 'LIMITED' | 'UNAVAILABLE';

export interface SecurityControlRating {
  id: string;
  label: string;
  ratings: Record<PlatformTier, SecurityRating>;
  rationale: Record<PlatformTier, string>;
}

export interface PlatformCapabilityReport {
  generatedAt: string;
  platforms: PlatformTier[];
  controls: SecurityControlRating[];
}

export const PLATFORM_SECURITY_CONTROLS: SecurityControlRating[] = [
  {
    id: 'browser-navigation-block',
    label: 'Application Navigation Restriction',
    ratings: {
      'PC Native': 'SUPPORTED',
      'Android Native': 'SUPPORTED',
      'Web': 'SUPPORTED',
      'iPhone PWA': 'SUPPORTED',
    },
    rationale: {
      'PC Native': 'Tauri webview intercepts internal route changes and navigation events.',
      'Android Native': 'WebViewClient shouldOverrideUrlLoading blocks internal navigation away from exam.',
      'Web': 'Central React Router gate intercepts and audits navigation away from /examination/secure.',
      'iPhone PWA': 'Popstate and hashchange listeners restore exam route and audit navigation attempts.',
    },
  },
  {
    id: 'copy-paste-block',
    label: 'Copy, Cut & Paste Restriction',
    ratings: {
      'PC Native': 'SUPPORTED',
      'Android Native': 'SUPPORTED',
      'Web': 'SUPPORTED',
      'iPhone PWA': 'SUPPORTED',
    },
    rationale: {
      'PC Native': 'DOM clipboard events (copy, cut, paste) and OS shortcuts (Ctrl/Cmd+C/V/X) are blocked.',
      'Android Native': 'DOM clipboard events and text selection context actions are prevented.',
      'Web': 'DOM clipboard events and keyboard shortcuts are blocked and audited.',
      'iPhone PWA': 'iOS WebKit clipboard events and callout menus are suppressed in exam UI.',
    },
  },
  {
    id: 'printing-block',
    label: 'Print Restriction',
    ratings: {
      'PC Native': 'SUPPORTED',
      'Android Native': 'SUPPORTED',
      'Web': 'SUPPORTED',
      'iPhone PWA': 'SUPPORTED',
    },
    rationale: {
      'PC Native': 'Window beforeprint events and Ctrl/Cmd+P shortcuts are intercepted.',
      'Android Native': 'WebView print framework is disabled during exam.',
      'Web': 'Window beforeprint and key combinations are blocked; print stylesheets hide exam content.',
      'iPhone PWA': 'AirPrint and beforeprint handlers are intercepted.',
    },
  },
  {
    id: 'external-link-block',
    label: 'External Link & URL Restriction',
    ratings: {
      'PC Native': 'SUPPORTED',
      'Android Native': 'SUPPORTED',
      'Web': 'SUPPORTED',
      'iPhone PWA': 'SUPPORTED',
    },
    rationale: {
      'PC Native': 'Native open_external_url rejects non-local endpoints during active exam; window.open is blocked.',
      'Android Native': 'WebViewClient blocks non-exam schemes and external URLs, emitting audit events.',
      'Web': 'Link click interception and window.open override block external destinations.',
      'iPhone PWA': 'Link taps are prevented and audited; target="_blank" is suppressed.',
    },
  },
  {
    id: 'developer-tools-detection',
    label: 'Developer Tools Restriction',
    ratings: {
      'PC Native': 'SUPPORTED',
      'Android Native': 'SUPPORTED',
      'Web': 'LIMITED',
      'iPhone PWA': 'UNAVAILABLE',
    },
    rationale: {
      'PC Native': 'Native open_devtools command is denied in production and active exam; F12/Ctrl+Shift+I blocked.',
      'Android Native': 'WebView.setWebContentsDebuggingEnabled is false in release builds.',
      'Web': 'Shortcuts are blocked and console inspection heuristically audited, but browser devtools cannot be disabled.',
      'iPhone PWA': 'iOS Safari does not expose on-device devtools to students (requires tethered Mac).',
    },
  },
  {
    id: 'window-control-restriction',
    label: 'Window Manipulation (Close, Minimize, Resize)',
    ratings: {
      'PC Native': 'SUPPORTED',
      'Android Native': 'SUPPORTED',
      'Web': 'LIMITED',
      'iPhone PWA': 'LIMITED',
    },
    rationale: {
      'PC Native': 'Tauri window controls (close, minimize, maximize, resize, decorations) are disabled.',
      'Android Native': 'Lock-task mode prevents window manipulation and task dismissal.',
      'Web': 'Beforeunload prompts and audits exit attempts; browser chrome cannot be locked.',
      'iPhone PWA': 'Standalone PWA eliminates browser URL bar; iOS home indicator remains outside sandbox.',
    },
  },
  {
    id: 'screen-capture-restriction',
    label: 'Screen Capture / Screenshot Blocking',
    ratings: {
      'PC Native': 'UNAVAILABLE',
      'Android Native': 'SUPPORTED',
      'Web': 'UNAVAILABLE',
      'iPhone PWA': 'UNAVAILABLE',
    },
    rationale: {
      'PC Native': 'Desktop operating systems (Windows, macOS, Linux) do not provide portable capture prevention without kernel drivers.',
      'Android Native': 'WindowManager.LayoutParams.FLAG_SECURE reliably blocks screenshots and system screen recording.',
      'Web': 'Standard browser sandboxes have no API to prevent OS screenshots.',
      'iPhone PWA': 'iOS does not permit web pages or PWAs to block hardware screenshots.',
    },
  },
  {
    id: 'screen-recording-restriction',
    label: 'Screen Recording Blocking',
    ratings: {
      'PC Native': 'UNAVAILABLE',
      'Android Native': 'SUPPORTED',
      'Web': 'UNAVAILABLE',
      'iPhone PWA': 'UNAVAILABLE',
    },
    rationale: {
      'PC Native': 'Desktop OS recording utilities cannot be detected or blocked by userspace apps.',
      'Android Native': 'WindowManager.LayoutParams.FLAG_SECURE blacks out the window in screen recordings.',
      'Web': 'Browser sandbox cannot detect operating system screen recording.',
      'iPhone PWA': 'iOS screen recording cannot be blocked by WebKit sandboxes.',
    },
  },
  {
    id: 'os-app-switch-restriction',
    label: 'OS Application Switching Restriction',
    ratings: {
      'PC Native': 'LIMITED',
      'Android Native': 'SUPPORTED',
      'Web': 'UNAVAILABLE',
      'iPhone PWA': 'UNAVAILABLE',
    },
    rationale: {
      'PC Native': 'Window always-on-top and focus re-assertion pull window forward; global Alt+Tab/Win keys not blocked.',
      'Android Native': 'Android Lock-Task mode disables the Home button and Recents/Overview app switcher.',
      'Web': 'Browser sandbox cannot intercept Alt+Tab or OS task switching.',
      'iPhone PWA': 'iOS swipe gestures and app switcher cannot be intercepted by web apps.',
    },
  },
  {
    id: 'mobile-home-gesture-restriction',
    label: 'Mobile Home Gesture Restriction',
    ratings: {
      'PC Native': 'UNAVAILABLE',
      'Android Native': 'SUPPORTED',
      'Web': 'UNAVAILABLE',
      'iPhone PWA': 'UNAVAILABLE',
    },
    rationale: {
      'PC Native': 'Not applicable to desktop PC environments.',
      'Android Native': 'Lock-Task mode suppresses the home gesture and hardware navigation bar.',
      'Web': 'Mobile browsers cannot intercept operating system home gestures.',
      'iPhone PWA': 'iOS home indicator bar is reserved strictly for the iOS operating system.',
    },
  },
  {
    id: 'os-keyboard-shortcut-restriction',
    label: 'OS Global Keyboard Shortcuts',
    ratings: {
      'PC Native': 'LIMITED',
      'Android Native': 'SUPPORTED',
      'Web': 'UNAVAILABLE',
      'iPhone PWA': 'UNAVAILABLE',
    },
    rationale: {
      'PC Native': 'In-window shortcuts blocked; OS shortcuts (Ctrl+Alt+Del, Windows key) require dedicated OS kiosk shell.',
      'Android Native': 'Lock-Task mode blocks hardware buttons (Volume, Power menu, Overview).',
      'Web': 'Operating system global shortcuts bypass web browser event loops.',
      'iPhone PWA': 'Hardware buttons (Volume, Power) are reserved for iOS.',
    },
  },
  {
    id: 'browser-process-termination-restriction',
    label: 'Process Termination Restriction',
    ratings: {
      'PC Native': 'UNAVAILABLE',
      'Android Native': 'LIMITED',
      'Web': 'UNAVAILABLE',
      'iPhone PWA': 'UNAVAILABLE',
    },
    rationale: {
      'PC Native': 'Task Manager / SIGKILL cannot be blocked by userspace applications.',
      'Android Native': 'Lock-Task mode prevents task dismissal from Recents; OS can still terminate under extreme memory pressure.',
      'Web': 'Browser tab or process can be closed via OS task manager.',
      'iPhone PWA': 'iOS WebKit jetsam can terminate backgrounded web processes.',
    },
  },
  {
    id: 'secondary-device-restriction',
    label: 'Secondary Physical Device Restriction',
    ratings: {
      'PC Native': 'UNAVAILABLE',
      'Android Native': 'UNAVAILABLE',
      'Web': 'UNAVAILABLE',
      'iPhone PWA': 'UNAVAILABLE',
    },
    rationale: {
      'PC Native': 'Physical device isolation requires physical in-room proctoring across all client types.',
      'Android Native': 'Physical device isolation requires physical in-room proctoring across all client types.',
      'Web': 'Physical device isolation requires physical in-room proctoring across all client types.',
      'iPhone PWA': 'Physical device isolation requires physical in-room proctoring across all client types.',
    },
  },
  {
    id: 'focus-monitoring',
    label: 'Focus Loss Monitoring & Auditing',
    ratings: {
      'PC Native': 'SUPPORTED',
      'Android Native': 'SUPPORTED',
      'Web': 'SUPPORTED',
      'iPhone PWA': 'SUPPORTED',
    },
    rationale: {
      'PC Native': 'Native WindowEvent::Focused emits focus_lost and focus_restored audit entries.',
      'Android Native': 'Activity onWindowFocusChanged and onPause/onResume emit audit events.',
      'Web': 'Window blur/focus and document visibilitychange events record audit entries without automatic cheating accusations.',
      'iPhone PWA': 'Pagehide, pageshow, blur, and visibilitychange events audit lifecycle transitions.',
    },
  },
  {
    id: 'immersive-window',
    label: 'Immersive / Fullscreen Window',
    ratings: {
      'PC Native': 'SUPPORTED',
      'Android Native': 'SUPPORTED',
      'Web': 'LIMITED',
      'iPhone PWA': 'SUPPORTED',
    },
    rationale: {
      'PC Native': 'Tauri set_fullscreen(true) and set_decorations(false) enforce borderless fullscreen.',
      'Android Native': 'System UI sticky immersive mode hides navigation and status bars.',
      'Web': 'Element.requestFullscreen requires user gesture and can be dismissed with Escape.',
      'iPhone PWA': 'Standalone PWA mode runs borderless without Safari browser chrome.',
    },
  },
  {
    id: 'android-lock-task',
    label: 'Device Lock-Task / Kiosk Mode',
    ratings: {
      'PC Native': 'LIMITED',
      'Android Native': 'SUPPORTED',
      'Web': 'UNAVAILABLE',
      'iPhone PWA': 'UNAVAILABLE',
    },
    rationale: {
      'PC Native': 'Application window locks controls, but full OS lockdown requires Windows Assigned Access or Linux kiosk shell.',
      'Android Native': 'Activity startLockTask() locks the device screen, status bar, and home controls.',
      'Web': 'Web browsers cannot initiate OS-level device lock-task modes.',
      'iPhone PWA': 'iOS Single App Mode requires external MDM / Apple Configurator provisioning.',
    },
  },
  {
    id: 'pharmaexam-file-association',
    label: '.pharmaexam OS File Association',
    ratings: {
      'PC Native': 'SUPPORTED',
      'Android Native': 'SUPPORTED',
      'Web': 'UNAVAILABLE',
      'iPhone PWA': 'UNAVAILABLE',
    },
    rationale: {
      'PC Native': 'Tauri bundle registers OS file association for .pharmaexam with command line queue.',
      'Android Native': 'AndroidManifest registers intent-filter for .pharmaexam mimeType and file pattern.',
      'Web': 'Web browsers do not register OS file associations; standard HTML file picker is used.',
      'iPhone PWA': 'iOS Safari does not register web file handlers; Files app picker is used.',
    },
  },
];

export function getCentralPlatformCapabilityReport(): PlatformCapabilityReport {
  return {
    generatedAt: new Date().toISOString(),
    platforms: ['PC Native', 'Android Native', 'Web', 'iPhone PWA'],
    controls: PLATFORM_SECURITY_CONTROLS,
  };
}

export function formatCapabilityReportText(): string {
  const report = getCentralPlatformCapabilityReport();
  const lines: string[] = [];
  lines.push('PHARMATRACK CENTRAL PLATFORM CAPABILITY REPORT');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('='.repeat(80));

  for (const control of report.controls) {
    lines.push(`\n[${control.id}] ${control.label}`);
    lines.push('-'.repeat(80));
    for (const platform of report.platforms) {
      const rating = control.ratings[platform];
      const rationale = control.rationale[platform];
      lines.push(`  ${platform.padEnd(16)} : ${rating.padEnd(12)} - ${rationale}`);
    }
  }

  return lines.join('\n');
}

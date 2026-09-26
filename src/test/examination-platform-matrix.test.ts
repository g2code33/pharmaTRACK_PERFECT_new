import { describe, expect, it } from 'vitest';
import {
  formatCapabilityReportText,
  getCentralPlatformCapabilityReport,
  PLATFORM_SECURITY_CONTROLS,
  type PlatformTier,
  type SecurityRating,
} from '../examination/platformReport';

describe('PHARMATRACK — Central Platform Security Capability Matrix', () => {
  it('evaluates all 4 mandatory platform tiers: PC Native, Android Native, Web, iPhone PWA', () => {
    const report = getCentralPlatformCapabilityReport();
    expect(report.platforms).toEqual(['PC Native', 'Android Native', 'Web', 'iPhone PWA']);
    expect(report.controls.length).toBeGreaterThanOrEqual(16);
  });

  it('restricts all security ratings strictly to SUPPORTED, LIMITED, or UNAVAILABLE', () => {
    const validRatings: SecurityRating[] = ['SUPPORTED', 'LIMITED', 'UNAVAILABLE'];
    const platforms: PlatformTier[] = ['PC Native', 'Android Native', 'Web', 'iPhone PWA'];

    for (const control of PLATFORM_SECURITY_CONTROLS) {
      for (const platform of platforms) {
        const rating = control.ratings[platform];
        expect(validRatings).toContain(rating);
        expect(control.rationale[platform]).toBeDefined();
        expect(control.rationale[platform].length).toBeGreaterThan(10);
      }
    }
  });

  it('makes zero false claims about screen capture on Web, PC, and iPhone PWA', () => {
    const captureControl = PLATFORM_SECURITY_CONTROLS.find(
      (c) => c.id === 'screen-capture-restriction',
    )!;
    expect(captureControl.ratings['PC Native']).toBe('UNAVAILABLE');
    expect(captureControl.ratings['Web']).toBe('UNAVAILABLE');
    expect(captureControl.ratings['iPhone PWA']).toBe('UNAVAILABLE');
    // Android is the only platform that supports FLAG_SECURE
    expect(captureControl.ratings['Android Native']).toBe('SUPPORTED');
  });

  it('makes zero false claims about OS task lockdown on Web and iPhone PWA', () => {
    const lockTaskControl = PLATFORM_SECURITY_CONTROLS.find(
      (c) => c.id === 'android-lock-task',
    )!;
    expect(lockTaskControl.ratings['Web']).toBe('UNAVAILABLE');
    expect(lockTaskControl.ratings['iPhone PWA']).toBe('UNAVAILABLE');
    expect(lockTaskControl.ratings['PC Native']).toBe('LIMITED');
    expect(lockTaskControl.ratings['Android Native']).toBe('SUPPORTED');
  });

  it('honestly rates developer tools detection across platforms', () => {
    const devToolsControl = PLATFORM_SECURITY_CONTROLS.find(
      (c) => c.id === 'developer-tools-detection',
    )!;
    expect(devToolsControl.ratings['PC Native']).toBe('SUPPORTED');
    expect(devToolsControl.ratings['Android Native']).toBe('SUPPORTED');
    expect(devToolsControl.ratings['Web']).toBe('LIMITED');
    expect(devToolsControl.ratings['iPhone PWA']).toBe('UNAVAILABLE');
  });

  it('produces a human-readable formatted capability report string', () => {
    const text = formatCapabilityReportText();
    expect(text).toContain('PHARMATRACK CENTRAL PLATFORM CAPABILITY REPORT');
    expect(text).toContain('PC Native');
    expect(text).toContain('Android Native');
    expect(text).toContain('iPhone PWA');
    expect(text).toContain('SUPPORTED');
    expect(text).toContain('LIMITED');
    expect(text).toContain('UNAVAILABLE');
  });
});

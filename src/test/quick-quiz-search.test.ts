import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { quickQuizRouteFromAnyText } from '../utils/appLinks';

const layout = fs.readFileSync(path.resolve(__dirname, '../components/Layout.tsx'), 'utf8');

describe('search bar opens pasted quick quiz links', () => {
  it('wires the global search input to the quick quiz link parser', () => {
    expect(layout).toContain("import { quickQuizRouteFromAnyText } from '../utils/appLinks';");
    expect(layout).toContain('const quickQuizSearchRoute = useMemo(');
    expect(layout).toContain('const immediateQuickQuizRoute = useMemo(');
    expect(layout).toContain('placeholder="Search or paste a Quick Quiz link…"');
  });

  it('offers a direct open action and an Enter shortcut for pasted links', () => {
    expect(layout).toContain('Open Quick Quiz link');
    expect(layout).toContain('goToResult(immediateQuickQuizRoute)');
    expect(layout).toContain("if (e.key === 'Enter' && quickRoute) {");
    expect(layout).toContain('goToResult(quickRoute);');
  });

  it('routes every supported platform link shape into the in-app quiz route', () => {
    // Web and PWA links, desktop (exe/deb) window links, and APK deep links all
    // resolve to the same hash route the router already serves.
    expect(quickQuizRouteFromAnyText('https://pharmatrack-web.pages.dev/#/q/Short42')).toBe('/q/Short42');
    expect(quickQuizRouteFromAnyText('tauri://localhost/#/q/Short42')).toBe('/q/Short42');
    expect(quickQuizRouteFromAnyText('pharmatrack://quick-quiz?p=zPACK')).toBe('/quick-quiz?p=zPACK');
  });
});

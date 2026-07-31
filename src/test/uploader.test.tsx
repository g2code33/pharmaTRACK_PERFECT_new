/**
 * Guards for FileUploader.
 *
 * Uploads appeared to do nothing: files were read and processed, then silently
 * discarded. Two causes, both covered here.
 *
 *  1. Stale closure. `addFiles` was useCallback([maxSizeMb, ocrRequested]) but
 *     called `onComplete`, which callers pass as an inline arrow — a new
 *     function every render. The memoised callback therefore kept the FIRST
 *     render's `onComplete`, where `selectedTopicId` was still ''. Every
 *     finished upload hit `alert('Pick a topic first')` and was thrown away.
 *
 *  2. The accept list omitted formats sitting in real users' folders (.pptm,
 *     .doc), so the file picker greyed them out.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

const uploaderSrc = fs.readFileSync(
  path.resolve(__dirname, '../components/FileUploader.tsx'), 'utf8',
);

describe('stale closure', () => {
  /** Mirrors the original structure: memoised callback, changing handler. */
  const Buggy: React.FC<{ onDone: (v: string) => void }> = ({ onDone }) => {
    const [, force] = useState(0);
    const run = useCallback(() => { onDone('called'); }, []); // deps omit onDone
    return (
      <>
        <button onClick={() => force((n) => n + 1)}>rerender</button>
        <button onClick={run}>run</button>
      </>
    );
  };

  /** The fix: read the handler through a ref that is kept current. */
  const Fixed: React.FC<{ onDone: (v: string) => void }> = ({ onDone }) => {
    const [, force] = useState(0);
    const ref = useRef(onDone);
    useEffect(() => { ref.current = onDone; }, [onDone]);
    const run = useCallback(() => { ref.current('called'); }, []);
    return (
      <>
        <button onClick={() => force((n) => n + 1)}>rerender</button>
        <button onClick={run}>run</button>
      </>
    );
  };

  const scenario = (Component: React.FC<{ onDone: (v: string) => void }>) => {
    const seen: string[] = [];
    // Each handler closes over the topic id available at ITS render, exactly
    // like the inline arrow in StudyMaterials closes over selectedTopicId.
    const make = (topicId: string) => () => seen.push(topicId || 'REJECTED');

    const view = render(<Component onDone={make('')} />);
    // The user picks a topic; the parent re-renders with a fresh handler.
    view.rerender(<Component onDone={make('topic-123')} />);

    act(() => { screen.getByText('run').click(); });
    return seen;
  };

  it('demonstrates the bug: a memoised callback keeps the first handler', () => {
    expect(scenario(Buggy)).toEqual(['REJECTED']);
  });

  it('a ref keeps the handler current', () => {
    expect(scenario(Fixed)).toEqual(['topic-123']);
  });
});

describe('FileUploader wiring', () => {
  it('calls onComplete through a ref, not a captured prop', () => {
    expect(uploaderSrc).toContain('onCompleteRef.current(');
    expect(uploaderSrc).toMatch(/useEffect\(\(\) => \{ onCompleteRef\.current = onComplete; \}, \[onComplete\]\)/);
    // The old direct call must be gone.
    expect(uploaderSrc).not.toMatch(/^\s{6}onComplete\(\{/m);
  });

  it('reads the OCR checkbox through a ref so late toggles apply', () => {
    expect(uploaderSrc).toContain('ocrRequestedRef.current');
    expect(uploaderSrc).not.toMatch(/if \(!hasText && ocrRequested\)/);
  });

  it('accepts the formats students actually have', () => {
    const accept = uploaderSrc.match(/accept = '([^']+)'/)?.[1] ?? '';
    // .pptm and .doc were missing, so the picker greyed them out.
    for (const ext of ['.pdf', '.docx', '.doc', '.pptx', '.pptm', '.ppt', '.txt']) {
      expect(accept).toContain(ext);
    }
    expect(accept).toContain('image/*');
  });

  it('treats .pptm as a presentation', () => {
    // .pptm is a macro-enabled .pptx: identical OPC zip, so the same parser works.
    expect(uploaderSrc).toMatch(/ext === 'pptx' \|\| ext === 'pptm' \|\| ext === 'ppt'/);
  });
});

describe('completed uploads are never discarded', () => {
  const pages = ['../pages/StudyMaterials.tsx', '../pages/CourseDetail.tsx'];

  it.each(pages)('%s falls back to an Uploads topic', (rel) => {
    const src = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
    // The old guard threw the finished upload away.
    expect(src).not.toContain("alert('Pick a topic first, then upload.'); return;");
    expect(src).toContain("topicName: 'Uploads'");
    // And the resolved id must be used, not the stale state value.
    expect(src).toMatch(/getSlidesForTopic\(topicId\)/);
  });
});

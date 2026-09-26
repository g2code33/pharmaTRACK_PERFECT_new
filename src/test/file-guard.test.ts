/**
 * Phase 12 — upload file guard.
 *
 * The file picker's `accept` and the filename extension are suggestions, not
 * guarantees: a truncated download keeps its name, and a user can rename
 * anything. These tests pin the guard's behaviour against what the bytes
 * actually are, and — just as important — that a recoverable naming slip is a
 * warning rather than a silent loss of real study material.
 */
import { describe, it, expect } from 'vitest';
import { inspectFile, looksUnsafe, prettySize, sniffBytes, reconcileMeta } from '../utils/fileGuard';

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]; // %PDF-1.4
const ZIP = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]; // docx/pptx
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // legacy .doc/.ppt
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const EXE = [0x4d, 0x5a, 0x90, 0x00]; // MZ
const ELF = [0x7f, 0x45, 0x4c, 0x46];

/** A File whose content starts with `head`, padded to `size` bytes. */
function fileOf(name: string, head: number[], size = 4096): File {
  const body = new Uint8Array(Math.max(size, head.length));
  body.set(head, 0);
  // Plausible filler so text-sniffing doesn't see only zeros.
  for (let i = head.length; i < body.length; i += 1) body[i] = 0x20;
  return new File([body], name);
}

describe('sniffing', () => {
  it.each([
    ['PDF', PDF, 'pdf'],
    ['Office container', ZIP, 'docx'],
    ['legacy Office', OLE, 'ole'],
    ['PNG', PNG, 'image'],
    ['JPEG', JPEG, 'image'],
    ['unknown bytes', [0x20, 0x20, 0x20], 'text'],
  ] as const)('recognises %s', (_label, head, expected) => {
    expect(sniffBytes(new Uint8Array(head))).toBe(expected);
  });

  it('flags executables and archives as unsafe', () => {
    expect(looksUnsafe(new Uint8Array(EXE))).toContain('Windows executable');
    expect(looksUnsafe(new Uint8Array(ELF))).toContain('Linux executable');
    expect(looksUnsafe(new Uint8Array([0x1f, 0x8b]))).toContain('gzip');
  });

  it('does not flag real study material', () => {
    for (const head of [PDF, ZIP, OLE, PNG, JPEG]) {
      expect(looksUnsafe(new Uint8Array(head))).toBeNull();
    }
  });
});

describe('files the guard refuses', () => {
  it('rejects an empty file', async () => {
    const verdict = await inspectFile(new File([], 'lecture.pdf'));
    expect(verdict.ok).toBe(false);
    expect(verdict.blockedBy?.code).toBe('empty');
  });

  it('rejects an oversized file before reading it', async () => {
    const verdict = await inspectFile(fileOf('big.pdf', PDF, 2048), { maxBytes: 1024 });
    expect(verdict.ok).toBe(false);
    expect(verdict.blockedBy?.code).toBe('too_large');
    expect(verdict.blockedBy?.message).toContain('2.0 KB');
  });

  it('refuses a Windows executable however it is named', async () => {
    const verdict = await inspectFile(fileOf('lecture-4.pdf', EXE));
    expect(verdict.ok).toBe(false);
    expect(verdict.blockedBy?.code).toBe('unsafe');
    expect(verdict.blockedBy?.message).toContain('executable');
  });

  it('refuses an ELF binary renamed to .docx', async () => {
    const verdict = await inspectFile(fileOf('slides.docx', ELF));
    expect(verdict.ok).toBe(false);
    expect(verdict.blockedBy?.code).toBe('unsafe');
  });

  it('rejects a corrupt file: named PDF, contents are not', async () => {
    const verdict = await inspectFile(fileOf('lecture-4.pdf', [0x00, 0x01, 0x02, 0x03]));
    expect(verdict.ok).toBe(false);
    expect(verdict.blockedBy?.code).toBe('corrupt');
    expect(verdict.blockedBy?.message).toContain('corrupt');
  });

  it('rejects a corrupt file: named .docx, contents are not a container', async () => {
    const verdict = await inspectFile(fileOf('chapter-2.docx', [0x00, 0x01, 0x02, 0x03]));
    expect(verdict.ok).toBe(false);
    expect(verdict.blockedBy?.code).toBe('corrupt');
  });
});

describe('files the guard accepts', () => {
  it('accepts a real PDF', async () => {
    const verdict = await inspectFile(fileOf('lecture-4.pdf', PDF));
    expect(verdict.ok).toBe(true);
    expect(verdict.detected).toBe('pdf');
    expect(verdict.issues).toHaveLength(0);
  });

  it('accepts a real .docx', async () => {
    const verdict = await inspectFile(fileOf('notes.docx', ZIP));
    expect(verdict.ok).toBe(true);
    expect(verdict.detected).toBe('docx');
  });

  it('accepts a real .pptx', async () => {
    const verdict = await inspectFile(fileOf('slides.pptx', ZIP));
    expect(verdict.ok).toBe(true);
    expect(verdict.detected).toBe('pptx');
  });

  it('accepts images', async () => {
    expect((await inspectFile(fileOf('scan.png', PNG))).ok).toBe(true);
    expect((await inspectFile(fileOf('scan.jpg', JPEG))).ok).toBe(true);
  });

  it('accepts plain text', async () => {
    const file = new File([new TextEncoder().encode('Beta blockers lower heart rate.')], 'notes.txt');
    const verdict = await inspectFile(file);
    expect(verdict.ok).toBe(true);
    expect(verdict.detected).toBe('text');
  });
});

describe('recoverable surprises warn instead of losing material', () => {
  it('uploads a PDF that is misnamed .docx, and says so', async () => {
    const verdict = await inspectFile(fileOf('chapter-2.docx', PDF));
    // It is perfectly readable — refusing it would lose real study material.
    expect(verdict.ok).toBe(true);
    expect(verdict.detected).toBe('pdf');
    expect(verdict.issues.some((i) => i.severity === 'warn')).toBe(true);
    expect(verdict.issues[0].message).toContain('PDF');
  });

  it('keeps a legacy .doc but warns that slides cannot be extracted', async () => {
    const verdict = await inspectFile(fileOf('old-notes.doc', OLE));
    expect(verdict.detected).toBe('ole');
    expect(verdict.issues.some((i) => i.message.includes('legacy Office'))).toBe(true);
  });

  it('never reports both a blocking issue and ok', async () => {
    const cases = [
      fileOf('a.pdf', PDF), fileOf('a.pdf', EXE), fileOf('a.docx', ZIP),
      fileOf('a.pdf', [0x00]), new File([], 'a.pdf'),
    ];
    for (const file of cases) {
      const verdict = await inspectFile(file);
      expect(verdict.ok).toBe(!verdict.blockedBy);
    }
  });
});

describe('metadata reconciliation', () => {
  it('derives the title and kind from the real filename', () => {
    expect(reconcileMeta({ originalName: 'Lecture 4 - Autonomic.pdf' })).toEqual({
      title: 'Lecture 4 - Autonomic',
      materialKind: 'pdf',
    });
  });

  it('never leaves a material untitled or mislabelled', () => {
    expect(reconcileMeta({ title: '  ', originalName: 'slides.pptx' }).title).toBe('slides');
    expect(reconcileMeta({ title: 'Kept', originalName: 'scan.PNG' }).materialKind).toBe('image');
    expect(reconcileMeta({}).title).toBe('Untitled material');
  });
});

describe('prettySize', () => {
  it('formats the sizes a student sees', () => {
    expect(prettySize(0)).toBe('0 B');
    expect(prettySize(512)).toBe('512 B');
    expect(prettySize(1048576)).toBe('1.0 MB');
    expect(prettySize(100 * 1024 * 1024)).toBe('100 MB');
  });
});

/**
 * Phase 13 — offline OCR lifecycle.
 *
 * The OCR model is intentionally not downloaded in tests. Tesseract is mocked at
 * its worker boundary, while the application contract is real: progress is
 * reported, extracted text is trimmed, and the worker is always terminated so
 * a large scanned PDF cannot leak a WebAssembly worker.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  recognize: vi.fn(),
  terminate: vi.fn(),
}));

vi.mock('tesseract.js', () => ({
  createWorker: mocks.createWorker,
}));

import { ocrImage } from '../utils/ocr';

beforeEach(() => {
  mocks.recognize.mockReset();
  mocks.terminate.mockReset();
  mocks.createWorker.mockReset();
  mocks.recognize.mockResolvedValue({ data: { text: '  Beta blockers\nbronchospasm  ' } });
  mocks.terminate.mockResolvedValue(undefined);
  mocks.createWorker.mockResolvedValue({
    recognize: mocks.recognize,
    terminate: mocks.terminate,
  });
});

describe('offline OCR', () => {
  it('extracts image text, reports progress, and releases the worker', async () => {
    const progress: number[] = [];
    const text = await ocrImage(new Blob(['image bytes'], { type: 'image/png' }), (event) =>
      progress.push(event.progress),
    );

    expect(text).toBe('Beta blockers\nbronchospasm');
    expect(mocks.createWorker).toHaveBeenCalledWith('eng');
    expect(mocks.recognize).toHaveBeenCalledTimes(1);
    expect(progress).toEqual([0.3, 1]);
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates the worker even when recognition fails', async () => {
    mocks.recognize.mockRejectedValueOnce(new Error('OCR engine stopped'));

    await expect(ocrImage(new Blob(['scan'], { type: 'image/png' }))).rejects.toThrow(
      'OCR engine stopped',
    );
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
  });
});

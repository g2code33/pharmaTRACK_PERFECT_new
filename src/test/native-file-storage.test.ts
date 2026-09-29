import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeFiles = new Map<string, Uint8Array>();
const nativePartials = new Map<string, number[]>();

const mockInvoke = vi.fn(async (command: string, args: Record<string, any> = {}) => {
  const id = String(args.id);
  switch (command) {
    case 'save_material_file_start':
      nativePartials.set(id, []);
      return undefined;
    case 'save_material_file_chunk':
      nativePartials.get(id)?.push(...(args.bytes as number[]));
      return undefined;
    case 'save_material_file_finish':
      nativeFiles.set(id, Uint8Array.from(nativePartials.get(id) ?? []));
      nativePartials.delete(id);
      return undefined;
    case 'save_material_file_abort':
      nativePartials.delete(id);
      return undefined;
    case 'material_file_info': {
      const file = nativeFiles.get(id);
      return file ? { size: file.byteLength } : null;
    }
    case 'load_material_file_chunk': {
      const file = nativeFiles.get(id);
      if (!file) throw new Error('missing native file');
      const offset = Number(args.offset);
      const length = Number(args.length);
      return Array.from(file.slice(offset, offset + length));
    }
    case 'delete_material_file':
      nativeFiles.delete(id);
      nativePartials.delete(id);
      return undefined;
    default:
      throw new Error(`unknown command ${command}`);
  }
});

describe('native material file storage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
    vi.doMock('idb-keyval', () => ({
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => { throw new Error('IndexedDB write failed'); }),
      del: vi.fn(async () => undefined),
    }));
    nativeFiles.clear();
    nativePartials.clear();
    mockInvoke.mockClear();
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.doUnmock('@tauri-apps/api/core');
    vi.doUnmock('idb-keyval');
  });

  it('saves and reloads uploaded bytes through native app-data storage when IndexedDB fails', async () => {
    const { saveFile, loadFileBytes } = await import('../utils/storage');

    await expect(saveFile('doc-native-1', new Uint8Array([80, 68, 70, 1, 2, 3]))).resolves.toBe(true);

    expect(mockInvoke).toHaveBeenCalledWith('save_material_file_start', { id: 'doc-native-1' });
    expect(mockInvoke).toHaveBeenCalledWith('save_material_file_finish', { id: 'doc-native-1' });
    expect(nativeFiles.get('doc-native-1')).toEqual(new Uint8Array([80, 68, 70, 1, 2, 3]));

    const loaded = await loadFileBytes('doc-native-1');
    expect(loaded).toEqual(new Uint8Array([80, 68, 70, 1, 2, 3]));
  });

  it('deletes the native copy as well as the IndexedDB key', async () => {
    const { saveFile, deleteFile, loadFileBytes } = await import('../utils/storage');

    await saveFile('doc-native-2', new Uint8Array([1, 2, 3]));
    expect(await loadFileBytes('doc-native-2')).toEqual(new Uint8Array([1, 2, 3]));

    await deleteFile('doc-native-2');

    expect(nativeFiles.has('doc-native-2')).toBe(false);
    expect(await loadFileBytes('doc-native-2')).toBeNull();
  });
});

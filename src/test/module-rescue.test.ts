/**
 * Tests for the last-resort module loader.
 *
 * The behaviour that matters: a response labelled with the wrong MIME type is
 * still loadable when its bytes really are JavaScript, and when they are not,
 * the error says which file is wrong and what repairs it — it must not repeat
 * "'application/pdf' is not a valid JavaScript MIME type" at the user.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DamagedAssetError,
  assetNameFromUrl,
  describeDamagedAsset,
  isRouteModule,
  rescueModuleImport,
  rewriteModuleSpecifiers,
  servedKindLabel,
  sniffServedModule,
} from '../utils/moduleRescue';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const assetUrl = 'https://tauri.localhost/assets/StudyMaterials-BxWFNAMN.js';
const assetDirectory = 'https://tauri.localhost/assets/';

function fakeResponse(body: Uint8Array, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

const fakeFetch = (body: Uint8Array, status = 200) =>
  vi.fn(async () => fakeResponse(body, status)) as unknown as typeof fetch;

// jsdom's Blob predates Blob#text(); FileReader is the portable way to read it.
const readBlob = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

describe('sniffServedModule', () => {
  it('recognises a PDF by its magic bytes', () => {
    expect(sniffServedModule(encode('%PDF-1.7\n%âãÏÓ'))).toBe('pdf');
  });

  it('recognises the app shell being served for a chunk', () => {
    expect(sniffServedModule(encode('<!doctype html>\n<html lang="en">'))).toBe('html');
    expect(sniffServedModule(encode('  <html><head></head></html>'))).toBe('html');
  });

  it('recognises real JavaScript behind a BOM and leading whitespace', () => {
    expect(sniffServedModule(encode('\uFEFF  import{a}from"./vendor-react-x.js";'))).toBe(
      'javascript',
    );
  });

  it('treats binary payloads as not-JavaScript', () => {
    expect(sniffServedModule(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe('other');
  });

  it('treats an empty body as not-JavaScript', () => {
    expect(sniffServedModule(new Uint8Array())).toBe('other');
  });
});

describe('rewriteModuleSpecifiers', () => {
  it('makes static relative imports absolute', () => {
    const code = 'import{a}from"./vendor-react-BkPCH2eJ.js";export{b}from\'./x.js\';';
    const rewritten = rewriteModuleSpecifiers(code, assetUrl);
    expect(rewritten).toContain(`from"${assetDirectory}vendor-react-BkPCH2eJ.js"`);
    expect(rewritten).toContain(`from'${assetDirectory}x.js'`);
  });

  it('makes dynamic and side-effect relative imports absolute', () => {
    const code = 'const m=await import("./Chunk-abc.js");import "./index-BgTu-ZU-.css";';
    const rewritten = rewriteModuleSpecifiers(code, assetUrl);
    expect(rewritten).toContain(`import("${assetDirectory}Chunk-abc.js")`);
    expect(rewritten).toContain(`import "${assetDirectory}index-BgTu-ZU-.css"`);
  });

  it('pins import.meta.url to the original file so ?url assets still resolve', () => {
    const rewritten = rewriteModuleSpecifiers('new URL("x.ttf", import.meta.url)', assetUrl);
    expect(rewritten).toContain(JSON.stringify(assetUrl));
    expect(rewritten).not.toContain('import.meta.url');
  });

  it('leaves absolute and bare specifiers alone', () => {
    const code = 'import{x}from"https://example.com/x.js";import"react";';
    expect(rewriteModuleSpecifiers(code, assetUrl)).toBe(code);
  });
});

describe('isRouteModule', () => {
  it('accepts a plain function component', () => {
    expect(isRouteModule({ default: () => null })).toBe(true);
  });

  it('accepts a memo/forwardRef component object', () => {
    expect(isRouteModule({ default: { $$typeof: Symbol.for('react.memo') } })).toBe(true);
  });

  it('rejects a vendor chunk with no component', () => {
    expect(isRouteModule({})).toBe(false);
    expect(isRouteModule({ default: undefined })).toBe(false);
    expect(isRouteModule(null)).toBe(false);
  });
});

describe('damaged asset reporting', () => {
  it('names the file and says what to do instead of a MIME type', () => {
    const message = describeDamagedAsset(assetUrl, 'pdf', 12345);
    expect(message).toContain('StudyMaterials-BxWFNAMN.js');
    expect(message).toContain('PDF');
    expect(message).toMatch(/reinstall/i);
    expect(message).toMatch(/not affected/i);
    expect(message).not.toContain('is not a valid JavaScript MIME type');
  });

  it('extracts a readable file name', () => {
    expect(assetNameFromUrl(assetUrl)).toBe('StudyMaterials-BxWFNAMN.js');
    expect(assetNameFromUrl('https://tauri.localhost/assets/')).toBe('assets');
  });

  it('labels what arrived in place of the code', () => {
    expect(servedKindLabel('pdf')).toBe('a PDF document');
    expect(servedKindLabel('html')).toBe('a web page (index.html)');
    expect(servedKindLabel('other')).toBe('binary data');
  });
});

describe('rescueModuleImport', () => {
  it('rejects with the damaged-file error when the bytes are a PDF', async () => {
    const fetchImpl = fakeFetch(encode('%PDF-1.4 fake'));
    await expect(rescueModuleImport(assetUrl, fetchImpl)).rejects.toBeInstanceOf(DamagedAssetError);
    await expect(rescueModuleImport(assetUrl, fetchImpl)).rejects.toMatchObject({
      served: 'pdf',
      url: assetUrl,
    });
  });

  it('does not mistake an HTTP failure for a damaged file', async () => {
    const fetchImpl = fakeFetch(new Uint8Array(), 500);
    const error = await rescueModuleImport(assetUrl, fetchImpl).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DamagedAssetError);
    expect((error as Error).message).toContain('HTTP 500');
  });

  it('asks for the file without any cache, then imports it as text/javascript', async () => {
    const fetchImpl = fakeFetch(encode('import"./vendor-x.js";export default 1;'));
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    // The blob itself cannot be executed by jsdom; what matters is how it was
    // built from a correctly-labelled, fully-resolved copy of the source.
    await rescueModuleImport(assetUrl, fetchImpl).catch(() => undefined);

    expect(fetchImpl).toHaveBeenCalledWith(assetUrl, { cache: 'no-store' });
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/javascript');
    const source = await readBlob(blob);
    expect(source).toContain(`import"${assetDirectory}vendor-x.js"`);
    expect(source).toContain('export default 1');
  });
});

/**
 * Return bytes in the form accepted by Web Crypto in both browsers and the
 * Node 20/jsdom test environment. Node 20's Web Crypto rejects ArrayBuffers
 * created by jsdom, while accepting a Node Buffer. Browsers do not expose
 * Buffer, so they continue to receive a fresh native ArrayBuffer.
 */
export function asCryptoBuffer(bytes: Uint8Array): ArrayBuffer {
  const nodeBuffer = (
    globalThis as typeof globalThis & {
      Buffer?: { from(value: Uint8Array): Uint8Array };
    }
  ).Buffer;

  if (nodeBuffer && typeof nodeBuffer.from === 'function') {
    // The runtime value is a Buffer (and therefore a valid BufferSource), but
    // the DOM lib's ArrayBuffer typing cannot express that cross-runtime
    // compatibility without making browser builds depend on Node types.
    return nodeBuffer.from(bytes) as unknown as ArrayBuffer;
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

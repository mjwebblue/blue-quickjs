import { encodeDv } from '@blue-quickjs/dv';
import { serializeHostTape } from '@blue-quickjs/test-harness';
import type { HostTapeRecord } from '@blue-quickjs/quickjs-runtime';

const TEXT_ENCODER = new TextEncoder();

export async function hashDv(value: unknown): Promise<string> {
  const encoded = encodeDv(value);
  return sha256Hex(encoded);
}

export async function hashTape(tape: HostTapeRecord[]): Promise<string | null> {
  if (tape.length === 0) {
    return null;
  }
  return sha256Hex(serializeHostTape(tape));
}

export async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === 'string' ? TEXT_ENCODER.encode(input) : input;
  if (!globalThis.crypto?.subtle) {
    throw new Error('crypto.subtle is not available for hashing');
  }
  // WebCrypto expects a BufferSource backed by an ArrayBuffer. When `@types/node`
  // is in play, `Uint8Array` is typed as potentially backed by `SharedArrayBuffer`
  // which doesn't satisfy the DOM `BufferSource` type. Convert to `ArrayBuffer`
  // deterministically (copying only when needed).
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytesToArrayBuffer(bytes),
  );
  return bufferToHex(new Uint8Array(digest));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  if (buffer instanceof ArrayBuffer) {
    if (byteOffset === 0 && byteLength === buffer.byteLength) {
      return buffer;
    }
    return buffer.slice(byteOffset, byteOffset + byteLength);
  }

  // `buffer` is some other `ArrayBufferLike` (e.g. SharedArrayBuffer). Copy the
  // view into a fresh `ArrayBuffer`.
  return new Uint8Array(bytes).buffer;
}

function bufferToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

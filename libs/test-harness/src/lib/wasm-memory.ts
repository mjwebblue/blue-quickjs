export type WasmPtr = number | bigint;

export interface WasmMemoryModule {
  HEAPU8: Uint8Array;
  UTF8ToString(ptr: number, maxBytesToRead?: number): string;
}

export interface WasmModuleWithCwrap extends WasmMemoryModule {
  cwrap: (
    name: string,
    returnType: string | null,
    argTypes: Array<string | null>,
  ) => (...args: unknown[]) => unknown;
}

export function normalizePtr(ptr: WasmPtr): number {
  if (typeof ptr === 'number') {
    return ptr;
  }
  if (ptr > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Pointer exceeds JS safe integer range');
  }
  return Number(ptr);
}

export function writeBytes(
  module: WasmMemoryModule,
  malloc: (size: number) => WasmPtr,
  data: Uint8Array,
): WasmPtr {
  const ptr = malloc(data.length);
  const offset = normalizePtr(ptr);
  new Uint8Array(module.HEAPU8.buffer, offset, data.length).set(data);
  return ptr;
}

export function writeCString(
  module: WasmMemoryModule,
  malloc: (size: number) => WasmPtr,
  value: string,
): WasmPtr {
  const encoded = new TextEncoder().encode(value);
  const buffer = new Uint8Array(encoded.length + 1);
  buffer.set(encoded);
  buffer[encoded.length] = 0;
  return writeBytes(module, malloc, buffer);
}

export function readCString(module: WasmMemoryModule, ptr: WasmPtr): string {
  return module.UTF8ToString(normalizePtr(ptr));
}

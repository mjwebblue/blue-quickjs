import { encodeAbiManifest } from '@blue-quickjs/abi-manifest';
import { encodeDv } from '@blue-quickjs/dv';
import type { QuickjsWasmModule } from './runtime.js';
import {
  type InputEnvelope,
  type ProgramArtifact,
  validateInputEnvelope,
  validateProgramArtifact,
} from './quickjs-runtime.js';
import type { RuntimeInstance } from './runtime.js';

const UTF8_ENCODER = new TextEncoder();
const UINT64_MAX = (1n << 64n) - 1n;

type DetInitFn = (
  manifestPtr: number,
  manifestLength: number,
  hashPtr: number,
  contextPtr: number,
  contextLength: number,
  gasLimit: bigint,
) => number;

type DetEvalFn = (code: string) => number;
type DetSetGasLimitFn = (gasLimit: bigint) => number;
type EnableTapeFn = (capacity: number) => number;
type ReadTapeFn = () => number;
type EnableTraceFn = (enabled: number) => number;
type ReadTraceFn = () => number;

interface DeterministicExports {
  init: DetInitFn;
  eval: DetEvalFn;
  setGasLimit: DetSetGasLimitFn;
  freeRuntime: () => void;
  enableTape: EnableTapeFn;
  readTape: ReadTapeFn;
  enableTrace: EnableTraceFn;
  readTrace: ReadTraceFn;
}

export interface DeterministicVm {
  eval(code: string): string;
  setGasLimit(limit: bigint | number): void;
  enableTape(capacity: number): void;
  readTape(): string;
  enableGasTrace(enabled: boolean): void;
  readGasTrace(): string;
  dispose(): void;
}

export function initializeDeterministicVm(
  runtime: RuntimeInstance,
  program: ProgramArtifact,
  input: InputEnvelope,
  gasLimit: bigint | number,
): DeterministicVm {
  const normalizedGasLimit = normalizeGasLimit(gasLimit);
  const validatedProgram = validateProgramArtifact(program);
  const validatedInput = validateInputEnvelope(input);

  const manifestBytes = encodeAbiManifest(runtime.manifest);
  const contextBlob = encodeDv({
    event: validatedInput.event,
    eventCanonical: validatedInput.eventCanonical,
    steps: validatedInput.steps,
  });

  const ffi = createDeterministicExports(runtime.module);
  const manifestPtr = writeBytes(runtime.module, manifestBytes);
  const contextPtr =
    contextBlob.length > 0 ? writeBytes(runtime.module, contextBlob) : 0;
  const hashPtr = writeCString(
    runtime.module,
    validatedProgram.abiManifestHash,
  );

  try {
    const errorPtr = ffi.init(
      manifestPtr,
      manifestBytes.length,
      hashPtr,
      contextPtr,
      contextBlob.length,
      normalizedGasLimit,
    );
    if (errorPtr !== 0) {
      const message = readAndFreeCString(runtime.module, errorPtr);
      ffi.freeRuntime();
      throw new Error(`VM init failed: ${message}`);
    }
  } finally {
    runtime.module._free(manifestPtr);
    runtime.module._free(hashPtr);
    if (contextPtr) {
      runtime.module._free(contextPtr);
    }
  }

  return {
    eval(code: string): string {
      const ptr = ffi.eval(code);
      if (ptr === 0) {
        throw new Error('qjs_det_eval returned a null pointer');
      }
      return readAndFreeCString(runtime.module, ptr);
    },
    setGasLimit(limit: bigint | number): void {
      const normalized = normalizeGasLimit(limit);
      const rc = ffi.setGasLimit(normalized);
      if (rc !== 0) {
        throw new Error('failed to set gas limit');
      }
    },
    enableTape(capacity: number): void {
      if (!Number.isInteger(capacity) || capacity < 0) {
        throw new Error(
          `tape capacity must be a non-negative integer (received ${capacity})`,
        );
      }
      const rc = ffi.enableTape(capacity >>> 0);
      if (rc !== 0) {
        throw new Error('failed to enable host tape');
      }
    },
    readTape(): string {
      const ptr = ffi.readTape();
      if (ptr === 0) {
        throw new Error('qjs_det_read_tape returned a null pointer');
      }
      return readAndFreeCString(runtime.module, ptr);
    },
    enableGasTrace(enabled: boolean): void {
      const rc = ffi.enableTrace(enabled ? 1 : 0);
      if (rc !== 0) {
        throw new Error('failed to configure gas trace');
      }
    },
    readGasTrace(): string {
      const ptr = ffi.readTrace();
      if (ptr === 0) {
        throw new Error('qjs_det_read_trace returned a null pointer');
      }
      return readAndFreeCString(runtime.module, ptr);
    },
    dispose() {
      ffi.freeRuntime();
    },
  };
}

function createDeterministicExports(
  module: QuickjsWasmModule,
): DeterministicExports {
  const init = module.cwrap('qjs_det_init', 'number', [
    'number',
    'number',
    'number',
    'number',
    'number',
    'bigint',
  ]) as unknown as DetInitFn;

  const evalFn = module.cwrap('qjs_det_eval', 'number', [
    'string',
  ]) as unknown as DetEvalFn;
  const setGasLimit = module.cwrap('qjs_det_set_gas_limit', 'number', [
    'bigint',
  ]) as unknown as DetSetGasLimitFn;

  const freeRuntime = module.cwrap(
    'qjs_det_free',
    null,
    [],
  ) as unknown as () => void;
  const enableTape = module.cwrap('qjs_det_enable_tape', 'number', [
    'number',
  ]) as unknown as EnableTapeFn;
  const readTape = module.cwrap(
    'qjs_det_read_tape',
    'number',
    [],
  ) as unknown as ReadTapeFn;
  const enableTrace = module.cwrap('qjs_det_enable_trace', 'number', [
    'number',
  ]) as unknown as EnableTraceFn;
  const readTrace = module.cwrap(
    'qjs_det_read_trace',
    'number',
    [],
  ) as unknown as ReadTraceFn;

  return {
    init,
    eval: evalFn,
    setGasLimit,
    freeRuntime,
    enableTape,
    readTape,
    enableTrace,
    readTrace,
  };
}

function normalizeGasLimit(value: bigint | number): bigint {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('gasLimit must be finite');
    }
    if (value < 0) {
      throw new Error('gasLimit must be non-negative');
    }
    return BigInt(value);
  }

  if (typeof value !== 'bigint') {
    throw new Error('gasLimit must be a bigint or number');
  }

  if (value < 0n) {
    throw new Error('gasLimit must be non-negative');
  }

  if (value > UINT64_MAX) {
    throw new Error(`gasLimit exceeds uint64 range (${value})`);
  }

  return value;
}

function writeBytes(module: QuickjsWasmModule, data: Uint8Array): number {
  const ptr = module._malloc(data.length);
  if (ptr === 0) {
    throw new Error('malloc returned null for byte buffer');
  }
  new Uint8Array(module.HEAPU8.buffer, ptr, data.length).set(data);
  return ptr;
}

function writeCString(module: QuickjsWasmModule, value: string): number {
  const encoded = UTF8_ENCODER.encode(value);
  const ptr = module._malloc(encoded.length + 1);
  if (ptr === 0) {
    throw new Error('malloc returned null for string');
  }
  const view = new Uint8Array(module.HEAPU8.buffer, ptr, encoded.length + 1);
  view.set(encoded);
  view[encoded.length] = 0;
  return ptr;
}

function readAndFreeCString(module: QuickjsWasmModule, ptr: number): string {
  try {
    return module.UTF8ToString(ptr);
  } finally {
    module._free(ptr);
  }
}

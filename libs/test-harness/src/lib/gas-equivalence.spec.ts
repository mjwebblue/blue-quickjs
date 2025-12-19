import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test, beforeAll } from 'vitest';
import { decodeDv, encodeDv } from '@blue-quickjs/dv';
import {
  type QuickjsWasmBuildType,
  type QuickjsWasmVariant,
  getQuickjsWasmArtifacts,
} from '@blue-quickjs/quickjs-wasm-build';
import { HOST_V1_BYTES, HOST_V1_HASH } from './abi-manifest-fixtures.js';
import { DETERMINISM_INPUT } from './determinism-fixtures.js';
import {
  hexToBytes,
  parseDeterministicOutput,
  type DeterministicOutput,
} from './deterministic-output.js';
import {
  readCString,
  writeBytes,
  writeCString,
  type WasmPtr,
} from './wasm-memory.js';

interface ExpectedResult extends DeterministicOutput {
  value?: unknown;
}

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

const fixturesRoot = path.join(
  repoRoot,
  'tools',
  'quickjs-native-harness',
  'fixtures',
  'gas',
);

const nativeHarnessPath = path.join(
  repoRoot,
  'tools',
  'quickjs-native-harness',
  'dist',
  'quickjs-native-harness',
);

const cases = [
  {
    name: 'zero-precharge',
    fixture: 'zero-precharge.js',
    gasLimit: 0n,
  },
  {
    name: 'gc-checkpoint-budget',
    fixture: 'zero-precharge.js',
    gasLimit: 54n,
  },
  {
    name: 'loop-oog',
    fixture: 'loop-counter.js',
    gasLimit: 600n,
  },
  {
    name: 'constant',
    fixture: 'constant.js',
    gasLimit: 147n,
  },
  {
    name: 'addition',
    fixture: 'addition.js',
    gasLimit: 154n,
  },
  {
    name: 'string-repeat',
    fixture: 'string-repeat.js',
    gasLimit: 5000n,
  },
];

const wasmVariantEnv = process.env.QJS_WASM_VARIANT?.toLowerCase();
const wasmVariant: QuickjsWasmVariant =
  wasmVariantEnv === 'wasm64' ? 'wasm64' : 'wasm32';
const wasmBuildTypeEnv = process.env.QJS_WASM_BUILD_TYPE?.toLowerCase();
const wasmBuildType: QuickjsWasmBuildType =
  wasmBuildTypeEnv === 'debug' ? 'debug' : 'release';
const useNativeBaseline = wasmVariant === 'wasm64';
const HOST_TRANSPORT_SENTINEL = 0xffffffff >>> 0;
const MANIFEST_BYTES = HOST_V1_BYTES;
const MANIFEST_HASH = HOST_V1_HASH;
const CONTEXT_BLOB = encodeDv({
  event: DETERMINISM_INPUT.event,
  eventCanonical: DETERMINISM_INPUT.eventCanonical,
  steps: DETERMINISM_INPUT.steps,
});
const MANIFEST_HEX = bytesToHex(MANIFEST_BYTES);
const CONTEXT_HEX = bytesToHex(CONTEXT_BLOB);

const wasm32Expectations: Record<string, ExpectedResult> = {
  'zero-precharge': {
    kind: 'ERROR',
    payload: 'OutOfGas: out of gas',
    gasRemaining: 0n,
    gasUsed: 0n,
  },
  'gc-checkpoint-budget': {
    kind: 'ERROR',
    payload: 'OutOfGas: out of gas',
    gasRemaining: 0n,
    gasUsed: 54n,
  },
  'loop-oog': {
    kind: 'RESULT',
    payload: '02016c',
    value: 3,
    gasRemaining: 203n,
    gasUsed: 397n,
  },
  constant: {
    kind: 'RESULT',
    payload: '02014b',
    value: 1,
    gasRemaining: 58n,
    gasUsed: 89n,
  },
  addition: {
    kind: 'RESULT',
    payload: '02016c',
    value: 3,
    gasRemaining: 58n,
    gasUsed: 96n,
  },
  'string-repeat': {
    kind: 'RESULT',
    payload: '0201e980fa0c',
    value: 32768,
    gasRemaining: 2687n,
    gasUsed: 2313n,
  },
};

let wasmInit:
  | ((
      manifestPtr: WasmPtr,
      manifestLength: number,
      hashPtr: WasmPtr,
      contextPtr: WasmPtr,
      contextLength: number,
      gasLimit: bigint,
    ) => WasmPtr)
  | null = null;
let wasmEval: ((code: string) => WasmPtr) | null = null;
let wasmFreeRuntime: (() => void) | null = null;
let wasmMalloc: ((size: number) => WasmPtr) | null = null;
let wasmFree: ((ptr: WasmPtr) => void) | null = null;
let wasmModule: any = null;

beforeAll(async () => {
  const { loaderPath } = getQuickjsWasmArtifacts(wasmVariant, wasmBuildType);
  if (!existsSync(loaderPath)) {
    throw new Error(
      `Wasm loader not found at ${loaderPath}. Build quickjs-wasm-build with WASM_VARIANTS=${wasmVariant} WASM_BUILD_TYPES=${wasmBuildType}`,
    );
  }
  const moduleFactory = (await import(pathToFileURL(loaderPath).href)).default;
  wasmModule = await moduleFactory({
    host: {
      host_call: () => HOST_TRANSPORT_SENTINEL,
    },
  });
  const ptrReturnType = wasmVariant === 'wasm64' ? 'bigint' : 'number';
  const ptrArgType = wasmVariant === 'wasm64' ? 'bigint' : 'number';
  wasmInit = wasmModule.cwrap('qjs_det_init', ptrReturnType, [
    ptrArgType,
    'number',
    ptrArgType,
    ptrArgType,
    'number',
    'bigint',
  ]);
  wasmEval = wasmModule.cwrap('qjs_det_eval', ptrReturnType, ['string']);
  wasmFreeRuntime = wasmModule.cwrap('qjs_det_free', null, []);
  wasmMalloc = wasmModule.cwrap('malloc', ptrReturnType, ['number']);
  wasmFree = wasmModule.cwrap('free', null, [ptrArgType]);
});

function runNative(code: string, gasLimit: bigint): DeterministicOutput {
  const args = [
    '--gas-limit',
    gasLimit.toString(),
    '--report-gas',
    '--abi-manifest-hex',
    MANIFEST_HEX,
    '--abi-manifest-hash',
    MANIFEST_HASH,
    '--context-blob-hex',
    CONTEXT_HEX,
    '--eval',
    code,
  ];
  const result = spawnSync(nativeHarnessPath, args, {
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  return parseDeterministicOutput(result.stdout);
}

function runWasm(code: string, gasLimit: bigint): DeterministicOutput {
  if (
    !wasmEval ||
    !wasmInit ||
    !wasmFreeRuntime ||
    !wasmMalloc ||
    !wasmFree ||
    !wasmModule
  ) {
    throw new Error('Wasm harness not initialized');
  }

  const manifestPtr = writeBytes(wasmModule, wasmMalloc, MANIFEST_BYTES);
  const contextPtr =
    CONTEXT_BLOB.length > 0
      ? writeBytes(wasmModule, wasmMalloc, CONTEXT_BLOB)
      : 0;
  const hashPtr = writeCString(wasmModule, wasmMalloc, MANIFEST_HASH);

  try {
    const errorPtr = wasmInit(
      manifestPtr,
      MANIFEST_BYTES.length,
      hashPtr,
      contextPtr,
      CONTEXT_BLOB.length,
      gasLimit,
    );
    if (errorPtr !== 0) {
      const message = readCString(wasmModule, errorPtr);
      wasmFree(errorPtr);
      throw new Error(`wasm init failed: ${message}`);
    }

    const ptr = wasmEval(code);
    const raw = readCString(wasmModule, ptr);
    wasmFree(ptr);
    return parseDeterministicOutput(raw);
  } finally {
    wasmFree(manifestPtr);
    wasmFree(hashPtr);
    if (contextPtr) {
      wasmFree(contextPtr);
    }
    wasmFreeRuntime();
  }
}

describe('wasm gas outputs', () => {
  test.each(cases)('$name matches', ({ name, fixture, gasLimit }) => {
    const code = readFileSync(path.join(fixturesRoot, fixture), 'utf8');
    const wasm = runWasm(code, gasLimit);

    if (useNativeBaseline) {
      const native = runNative(code, gasLimit);
      expectHarnessResult(wasm, native);
      return;
    }

    const expected = wasm32Expectations[name];
    if (!expected) {
      throw new Error(`Missing wasm32 expectation for case ${name}`);
    }
    expectHarnessResult(wasm, expected);
  });
});

function expectHarnessResult(
  actual: DeterministicOutput,
  expected: ExpectedResult,
) {
  expect(actual.kind).toEqual(expected.kind);
  expect(actual.gasUsed).toEqual(expected.gasUsed);
  expect(actual.gasRemaining).toEqual(expected.gasRemaining);

  if (actual.kind === 'RESULT') {
    const decoded = decodeDv(hexToBytes(actual.payload));
    const expectedValue =
      expected.value ??
      tryDecodeExpectedPayload(expected.payload) ??
      expected.payload;
    expect(decoded).toEqual(expectedValue);
  } else {
    expect(actual.payload).toEqual(expected.payload);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function tryDecodeExpectedPayload(payload: string): unknown {
  const hexish = /^[0-9a-f]+$/i.test(payload) && payload.length % 2 === 0;
  if (hexish) {
    try {
      return decodeDv(hexToBytes(payload));
    } catch {
      // fall through
    }
  }
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

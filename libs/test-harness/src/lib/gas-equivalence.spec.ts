import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test, beforeAll } from 'vitest';
import {
  type QuickjsWasmVariant,
  getQuickjsWasmArtifacts,
} from '@blue-quickjs/quickjs-wasm-build';

type HarnessResultKind = 'RESULT' | 'ERROR';

interface HarnessResult {
  kind: HarnessResultKind;
  message: string;
  gasUsed: number;
  gasRemaining: number;
  // Optional fields supported by some harness outputs / future extensions.
  trace?: unknown;
  state?: unknown;
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
const useNativeBaseline = wasmVariant === 'wasm64';
const HOST_TRANSPORT_SENTINEL = 0xffffffff >>> 0;

const wasm32Expectations: Record<string, HarnessResult> = {
  'zero-precharge': {
    kind: 'ERROR',
    message: 'OutOfGas: out of gas',
    gasRemaining: 0,
    gasUsed: 0,
  },
  'gc-checkpoint-budget': {
    kind: 'ERROR',
    message: 'OutOfGas: out of gas',
    gasRemaining: 0,
    gasUsed: 54,
  },
  'loop-oog': {
    kind: 'RESULT',
    message: '3',
    gasRemaining: 30,
    gasUsed: 570,
  },
  constant: {
    kind: 'RESULT',
    message: '1',
    gasRemaining: 22,
    gasUsed: 125,
  },
  addition: {
    kind: 'RESULT',
    message: '3',
    gasRemaining: 22,
    gasUsed: 132,
  },
  'string-repeat': {
    kind: 'RESULT',
    message: '32768',
    gasRemaining: 2651,
    gasUsed: 2349,
  },
};

let wasmEval: ((code: string, gasLimit: bigint) => number) | null = null;
let wasmFree: ((ptr: number) => void) | null = null;
let wasmModule: any = null;

beforeAll(async () => {
  const { loaderPath } = getQuickjsWasmArtifacts(wasmVariant);
  if (!existsSync(loaderPath)) {
    throw new Error(
      `Wasm loader not found at ${loaderPath}. Build quickjs-wasm-build with WASM_VARIANTS=${wasmVariant}`,
    );
  }
  const moduleFactory = (await import(pathToFileURL(loaderPath).href)).default;
  wasmModule = await moduleFactory({
    host: {
      host_call: () => HOST_TRANSPORT_SENTINEL,
    },
  });
  wasmEval = wasmModule.cwrap('qjs_eval', 'number', ['string', 'bigint']);
  wasmFree = wasmModule.cwrap('qjs_free_output', null, ['number']);
});

function parseHarnessOutput(output: string): HarnessResult {
  const trimmed = output.trim();
  const match =
    /^(RESULT|ERROR)\s+(.*?)\s+GAS\s+remaining=(\d+)\s+used=(\d+)/.exec(
      trimmed,
    );
  if (!match) {
    throw new Error(`Unable to parse harness output: ${trimmed}`);
  }
  const [, kind, message, remaining, used] = match;
  return {
    kind: kind as HarnessResultKind,
    message,
    gasRemaining: Number(remaining),
    gasUsed: Number(used),
  };
}

function runNative(code: string, gasLimit: bigint): HarnessResult {
  const args = [
    '--gas-limit',
    gasLimit.toString(),
    '--report-gas',
    '--eval',
    code,
  ];
  const result = spawnSync(nativeHarnessPath, args, {
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  return parseHarnessOutput(result.stdout);
}

function runWasm(code: string, gasLimit: bigint): HarnessResult {
  if (!wasmEval || !wasmModule || !wasmFree) {
    throw new Error('Wasm harness not initialized');
  }
  const ptr = wasmEval(code, gasLimit);
  const raw = wasmModule.UTF8ToString(ptr);
  wasmFree(ptr);
  return parseHarnessOutput(raw);
}

function expectHarnessResult(
  actual: HarnessResult,
  expected: HarnessResult,
): void {
  expect(actual.kind).toEqual(expected.kind);
  expect(actual.message).toEqual(expected.message);
  expect(actual.gasUsed).toEqual(expected.gasUsed);
  expect(actual.gasRemaining).toEqual(expected.gasRemaining);
  if (expected.trace !== undefined) {
    expect(actual.trace ?? null).toEqual(expected.trace);
  }
  if (expected.state !== undefined) {
    expect(actual.state ?? null).toEqual(expected.state);
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

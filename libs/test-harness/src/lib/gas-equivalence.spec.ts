import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test, beforeAll } from 'vitest';
import { getQuickjsWasmArtifacts } from '@blue-quickjs/quickjs-wasm-build';

type HarnessResultKind = 'RESULT' | 'ERROR';

interface HarnessResult {
  kind: HarnessResultKind;
  message: string;
  gasUsed: number;
  gasRemaining: number;
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

let wasmEval: ((code: string, gasLimit: bigint) => bigint) | null = null;
let wasmFree: ((ptr: bigint) => void) | null = null;
let wasmModule: any = null;

beforeAll(async () => {
  const { loaderPath } = getQuickjsWasmArtifacts();
  const moduleFactory = (await import(pathToFileURL(loaderPath).href)).default;
  wasmModule = await moduleFactory();
  wasmEval = wasmModule.cwrap('qjs_eval', 'bigint', ['string', 'bigint']);
  wasmFree = wasmModule.cwrap('qjs_free_output', null, ['bigint']);
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
  const raw = wasmModule.UTF8ToString(Number(ptr));
  wasmFree(ptr);
  return parseHarnessOutput(raw);
}

describe('wasm vs native gas outputs', () => {
  test.each(cases)('$name matches', ({ fixture, gasLimit }) => {
    const code = readFileSync(path.join(fixturesRoot, fixture), 'utf8');
    const native = runNative(code, gasLimit);
    const wasm = runWasm(code, gasLimit);

    expect(wasm.kind).toEqual(native.kind);
    expect(wasm.message).toEqual(native.message);
    expect(wasm.gasUsed).toEqual(native.gasUsed);
    expect(wasm.gasRemaining).toEqual(native.gasRemaining);
  });
});

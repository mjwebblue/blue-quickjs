import {
  DETERMINISM_FIXTURES,
  type DeterminismFixtureBaseline,
} from '@blue-quickjs/test-harness';
import { type EvaluateResult, evaluate } from '@blue-quickjs/quickjs-runtime';
import {
  loadQuickjsWasmBinary,
  loadQuickjsWasmMetadata,
} from '@blue-quickjs/quickjs-wasm';
import { expect, test } from '@playwright/test';
import { hashDv, hashTape } from '../src/app/hash-utils.js';
import { mapByName, readBrowserResults } from './fixture-utils.js';

type FixtureSnapshot = {
  resultHash: string | null;
  errorCode: string | null;
  errorTag: string | null;
  gasUsed: string;
  gasRemaining: string;
  tapeHash: string | null;
  tapeLength: number;
};

type FixtureMatch = {
  resultHash: boolean;
  errorCode: boolean;
  errorTag: boolean;
  gasUsed: boolean;
  gasRemaining: boolean;
  tapeHash: boolean;
  tapeLength: boolean;
};

type FixtureResult = {
  name: string;
  expected: FixtureSnapshot;
  actual: FixtureSnapshot;
  matches: FixtureMatch;
};

const TAPE_CAPACITY = 32;

test('browser determinism fixtures match Node outputs', async ({ page }) => {
  const nodeResults = await runNodeFixtures();

  const browserResults = await readBrowserResults<FixtureResult>(
    page,
    '/determinism.html',
    '__DETERMINISM_RESULTS__',
    'determinism',
  );

  const nodeByName = mapByName(nodeResults);
  const browserByName = mapByName(browserResults);

  expect(browserByName.size).toBe(nodeByName.size);

  for (const [name, node] of nodeByName) {
    const browser = browserByName.get(name);
    expect(browser, `missing browser fixture ${name}`).toBeTruthy();
    if (!browser) {
      continue;
    }

    expect(node.actual).toEqual(node.expected);
    expect(browser.actual).toEqual(node.actual);
    expect(browser.expected).toEqual(node.expected);
    expect(browser.matches).toEqual(node.matches);
  }
});

async function runNodeFixtures(): Promise<FixtureResult[]> {
  const metadata = await loadQuickjsWasmMetadata();
  const wasmBinary = await loadQuickjsWasmBinary();

  const results: FixtureResult[] = [];
  for (const fixture of DETERMINISM_FIXTURES) {
    const host = fixture.createHost(fixture.input);
    const result = await evaluate({
      program: fixture.program,
      input: fixture.input,
      gasLimit: fixture.gasLimit,
      manifest: fixture.manifest,
      handlers: host.handlers,
      metadata,
      wasmBinary,
      tape: { capacity: TAPE_CAPACITY },
    });

    const actual = await summarizeFixture(result);
    const expected = normalizeExpected(fixture.expected);
    const matches = compareSnapshots(actual, expected);
    results.push({ name: fixture.name, actual, expected, matches });
  }

  return results;
}

function normalizeExpected(
  expected: DeterminismFixtureBaseline,
): FixtureSnapshot {
  return {
    resultHash: expected.resultHash,
    errorCode: expected.errorCode,
    errorTag: expected.errorTag,
    gasUsed: expected.gasUsed.toString(),
    gasRemaining: expected.gasRemaining.toString(),
    tapeHash: expected.tapeHash,
    tapeLength: expected.tapeLength,
  };
}

async function summarizeFixture(
  result: EvaluateResult,
): Promise<FixtureSnapshot> {
  const tape = result.tape ?? [];
  const tapeHash = await hashTape(tape);
  const resultHash = result.ok ? await hashDv(result.value) : null;
  const errorCode = result.ok ? null : result.error.code;
  const errorTag = result.ok
    ? null
    : 'tag' in result.error
      ? result.error.tag
      : null;

  return {
    resultHash,
    errorCode,
    errorTag,
    gasUsed: result.gasUsed.toString(),
    gasRemaining: result.gasRemaining.toString(),
    tapeHash,
    tapeLength: tape.length,
  };
}

function compareSnapshots(
  actual: FixtureSnapshot,
  expected: FixtureSnapshot,
): FixtureMatch {
  return {
    resultHash: actual.resultHash === expected.resultHash,
    errorCode: actual.errorCode === expected.errorCode,
    errorTag: actual.errorTag === expected.errorTag,
    gasUsed: actual.gasUsed === expected.gasUsed,
    gasRemaining: actual.gasRemaining === expected.gasRemaining,
    tapeHash: actual.tapeHash === expected.tapeHash,
    tapeLength: actual.tapeLength === expected.tapeLength,
  };
}

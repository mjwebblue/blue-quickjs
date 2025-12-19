import {
  GAS_SAMPLE_FIXTURES,
  parseDeterministicEvalOutput,
} from '@blue-quickjs/test-harness';
import {
  createRuntime,
  evaluate,
  initializeDeterministicVm,
} from '@blue-quickjs/quickjs-runtime';
import {
  loadQuickjsWasmBinary,
  loadQuickjsWasmMetadata,
} from '@blue-quickjs/quickjs-wasm';
import { expect, test } from '@playwright/test';
import { hashDv } from '../src/app/hash-utils.js';
import { mapByName, readBrowserResults } from './fixture-utils.js';

type FixtureSnapshot = {
  resultHash: string;
  gasUsed: string;
  gasRemaining: string;
};

type FixtureMatch = {
  resultHash: boolean;
  gasUsed: boolean;
  gasRemaining: boolean;
};

type RepeatSnapshot = {
  samples: string[];
  expectedGasUsed: string;
  match: boolean;
};

type FixtureResult = {
  name: string;
  expected: FixtureSnapshot;
  actual: FixtureSnapshot;
  matches: FixtureMatch;
  repeatSameContext?: RepeatSnapshot;
};

test('browser gas fixtures match Node outputs', async ({ page }) => {
  const nodeResults = await runNodeFixtures();

  const browserResults = await readBrowserResults<FixtureResult>(
    page,
    '/gas-samples.html',
    '__GAS_SAMPLE_RESULTS__',
    'gas sample',
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
    if (node.repeatSameContext) {
      expect(node.repeatSameContext.match).toBe(true);
      expect(browser.repeatSameContext).toEqual(node.repeatSameContext);
    }
  }
});

async function runNodeFixtures(): Promise<FixtureResult[]> {
  const metadata = await loadQuickjsWasmMetadata();
  const wasmBinary = await loadQuickjsWasmBinary();

  const results: FixtureResult[] = [];
  for (const fixture of GAS_SAMPLE_FIXTURES) {
    const host = fixture.createHost();
    const result = await evaluate({
      program: fixture.program,
      input: fixture.input,
      gasLimit: fixture.gasLimit,
      manifest: fixture.manifest,
      handlers: host.handlers,
      metadata,
      wasmBinary,
    });

    if (!result.ok) {
      throw new Error(`fixture ${fixture.name} failed: ${result.error.code}`);
    }

    const actual = await summarizeFixture(result);
    const expected = normalizeExpected(fixture.expected);
    const matches = compareSnapshots(actual, expected);
    const repeatSameContext = fixture.repeatSameContext
      ? await runRepeatSameContext(fixture, metadata, wasmBinary)
      : undefined;
    results.push({
      name: fixture.name,
      actual,
      expected,
      matches,
      repeatSameContext,
    });
  }

  return results;
}

function normalizeExpected(
  expected: (typeof GAS_SAMPLE_FIXTURES)[number]['expected'],
): FixtureSnapshot {
  return {
    resultHash: expected.resultHash,
    gasUsed: expected.gasUsed.toString(),
    gasRemaining: expected.gasRemaining.toString(),
  };
}

async function summarizeFixture(
  result: Awaited<ReturnType<typeof evaluate>>,
): Promise<FixtureSnapshot> {
  if (!result.ok) {
    throw new Error(result.message);
  }
  return {
    resultHash: await hashDv(result.value),
    gasUsed: result.gasUsed.toString(),
    gasRemaining: result.gasRemaining.toString(),
  };
}

function compareSnapshots(
  actual: FixtureSnapshot,
  expected: FixtureSnapshot,
): FixtureMatch {
  return {
    resultHash: actual.resultHash === expected.resultHash,
    gasUsed: actual.gasUsed === expected.gasUsed,
    gasRemaining: actual.gasRemaining === expected.gasRemaining,
  };
}

async function runRepeatSameContext(
  fixture: (typeof GAS_SAMPLE_FIXTURES)[number],
  metadata: Awaited<ReturnType<typeof loadQuickjsWasmMetadata>>,
  wasmBinary: Uint8Array,
): Promise<RepeatSnapshot> {
  if (!fixture.repeatSameContext) {
    return { samples: [], expectedGasUsed: '0', match: true };
  }

  const host = fixture.createHost();
  const runtime = await createRuntime({
    manifest: fixture.manifest,
    handlers: host.handlers,
    metadata,
    wasmBinary,
  });
  const vm = initializeDeterministicVm(
    runtime,
    fixture.program,
    fixture.input,
    fixture.gasLimit,
  );

  const samples: string[] = [];
  try {
    vm.setGasLimit(fixture.gasLimit);
    const warmup = parseDeterministicEvalOutput(vm.eval(fixture.program.code));
    if (warmup.kind === 'error') {
      throw new Error(`${fixture.name} warmup failed: ${warmup.error}`);
    }

    for (let i = 0; i < fixture.repeatSameContext.count; i += 1) {
      vm.setGasLimit(fixture.gasLimit);
      const output = parseDeterministicEvalOutput(
        vm.eval(fixture.program.code),
      );
      if (output.kind === 'error') {
        throw new Error(`${fixture.name} failed: ${output.error}`);
      }
      samples.push(output.gasUsed.toString());
    }
  } finally {
    vm.dispose();
  }

  const expectedGasUsed = fixture.repeatSameContext.expectedGasUsed.toString();
  const match =
    samples.length > 0 && samples.every((sample) => sample === expectedGasUsed);

  return { samples, expectedGasUsed, match };
}

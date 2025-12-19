import './gas-samples.element.css';

import {
  GAS_SAMPLE_FIXTURES,
  type GasFixtureBaseline,
  parseDeterministicEvalOutput,
} from '@blue-quickjs/test-harness';
import {
  type EvaluateResult,
  createRuntime,
  evaluate,
  initializeDeterministicVm,
} from '@blue-quickjs/quickjs-runtime';
import {
  loadQuickjsWasmBinary,
  loadQuickjsWasmMetadata,
} from '@blue-quickjs/quickjs-wasm';
import { hashDv } from './hash-utils.js';

type RunState = 'idle' | 'running' | 'done' | 'error';

interface FixtureSnapshot {
  resultHash: string;
  gasUsed: string;
  gasRemaining: string;
}

interface FixtureMatch {
  resultHash: boolean;
  gasUsed: boolean;
  gasRemaining: boolean;
}

interface RepeatSnapshot {
  samples: string[];
  expectedGasUsed: string;
  match: boolean;
}

interface FixtureResult {
  name: string;
  expected: FixtureSnapshot;
  actual: FixtureSnapshot;
  matches: FixtureMatch;
  repeatSameContext?: RepeatSnapshot;
}

declare global {
  interface Window {
    __GAS_SAMPLE_RESULTS__?: FixtureResult[];
    __GAS_SAMPLE_STATE__?: RunState;
  }
}

export class GasSamplesElement extends HTMLElement {
  private isRunning = false;

  connectedCallback() {
    this.render();
    void this.runHarness();
  }

  private async runHarness() {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.updateRunstate('running', 'Running gas samples');

    try {
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
          throw new Error(
            `fixture ${fixture.name} failed with ${result.error.code}`,
          );
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

      window.__GAS_SAMPLE_RESULTS__ = results;
      window.__GAS_SAMPLE_STATE__ = 'done';
      this.renderResults(results);
      this.updateRunstate('done', 'Done');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to run gas samples';
      this.updateRunstate('error', message);
      this.renderError(message);
      window.__GAS_SAMPLE_STATE__ = 'error';
    } finally {
      this.isRunning = false;
    }
  }

  private renderResults(results: FixtureResult[]) {
    const fixtures = this.querySelector<HTMLElement>('[data-fixtures]');
    if (fixtures) {
      fixtures.innerHTML = results
        .map((result) => {
          const allMatches =
            Object.values(result.matches).every(Boolean) &&
            (result.repeatSameContext?.match ?? true);
          return `
            <article class="fixture" data-match="${allMatches}">
              <h2>${result.name}</h2>
              <p>${allMatches ? 'match' : 'mismatch'}</p>
              <p>gas used: ${result.actual.gasUsed}</p>
              <p>gas remaining: ${result.actual.gasRemaining}</p>
              ${
                result.repeatSameContext
                  ? `<p>repeat same-context: ${
                      result.repeatSameContext.match ? 'ok' : 'mismatch'
                    }</p>`
                  : ''
              }
            </article>
          `;
        })
        .join('');
    }

    const raw = this.querySelector<HTMLElement>('[data-results]');
    if (raw) {
      raw.textContent = JSON.stringify(results, null, 2);
    }
  }

  private renderError(message: string) {
    const fixtures = this.querySelector<HTMLElement>('[data-fixtures]');
    if (fixtures) {
      fixtures.innerHTML = '';
    }
    const raw = this.querySelector<HTMLElement>('[data-results]');
    if (raw) {
      raw.textContent = message;
    }
  }

  private updateRunstate(state: RunState, label: string) {
    const runstate = this.querySelector<HTMLElement>('[data-runstate]');
    if (runstate) {
      runstate.textContent = label;
      runstate.setAttribute('data-runstate', state);
    }
  }

  private render() {
    this.innerHTML = `
      <main class="page">
        <header>
          <h1 class="title">Gas sample fixtures</h1>
          <p class="subtitle">
            Exercises representative scripts and allocation-heavy cases with deterministic gas.
          </p>
          <span class="runstate" data-runstate="idle">Idle</span>
        </header>
        <section class="fixtures" data-fixtures></section>
        <pre class="results" data-results>Waiting for results...</pre>
      </main>
    `;
  }
}

function normalizeExpected(expected: GasFixtureBaseline): FixtureSnapshot {
  return {
    resultHash: expected.resultHash,
    gasUsed: expected.gasUsed.toString(),
    gasRemaining: expected.gasRemaining.toString(),
  };
}

async function summarizeFixture(
  result: EvaluateResult,
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
    return {
      samples: [],
      expectedGasUsed: '0',
      match: true,
    };
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

customElements.define('blue-quickjs-gas-samples', GasSamplesElement);

import './determinism.element.css';

import {
  DETERMINISM_FIXTURES,
  type DeterminismFixtureBaseline,
} from '@blue-quickjs/test-harness';
import { type EvaluateResult, evaluate } from '@blue-quickjs/quickjs-runtime';
import {
  loadQuickjsWasmBinary,
  loadQuickjsWasmMetadata,
} from '@blue-quickjs/quickjs-wasm';
import { hashDv, hashTape } from './hash-utils.js';

type RunState = 'idle' | 'running' | 'done' | 'error';

interface FixtureSnapshot {
  resultHash: string | null;
  errorCode: string | null;
  errorTag: string | null;
  gasUsed: string;
  gasRemaining: string;
  tapeHash: string | null;
  tapeLength: number;
}

interface FixtureMatch {
  resultHash: boolean;
  errorCode: boolean;
  errorTag: boolean;
  gasUsed: boolean;
  gasRemaining: boolean;
  tapeHash: boolean;
  tapeLength: boolean;
}

interface FixtureResult {
  name: string;
  expected: FixtureSnapshot;
  actual: FixtureSnapshot;
  matches: FixtureMatch;
}

declare global {
  interface Window {
    __DETERMINISM_RESULTS__?: FixtureResult[];
    __DETERMINISM_STATE__?: RunState;
  }
}

const TAPE_CAPACITY = 32;

export class DeterminismElement extends HTMLElement {
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
    this.updateRunstate('running', 'Running determinism fixtures');

    try {
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

      window.__DETERMINISM_RESULTS__ = results;
      window.__DETERMINISM_STATE__ = 'done';
      this.renderResults(results);
      this.updateRunstate('done', 'Done');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to run determinism';
      this.updateRunstate('error', message);
      this.renderError(message);
      window.__DETERMINISM_STATE__ = 'error';
    } finally {
      this.isRunning = false;
    }
  }

  private renderResults(results: FixtureResult[]) {
    const fixtures = this.querySelector<HTMLElement>('[data-fixtures]');
    if (fixtures) {
      fixtures.innerHTML = results
        .map((result) => {
          const isMatch = Object.values(result.matches).every(Boolean);
          return `
            <article class="fixture" data-match="${isMatch}">
              <h2>${result.name}</h2>
              <p>${isMatch ? 'match' : 'mismatch'}</p>
              <p>gas used: ${result.actual.gasUsed}</p>
              <p>tape length: ${result.actual.tapeLength}</p>
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
          <h1 class="title">Determinism harness</h1>
          <p class="subtitle">
            Runs deterministic fixtures in the browser and exposes the results for Playwright.
          </p>
          <span class="runstate" data-runstate="idle">Idle</span>
        </header>
        <section class="fixtures" data-fixtures></section>
        <pre class="results" data-results>Waiting for results...</pre>
      </main>
    `;
  }
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

customElements.define('blue-quickjs-determinism', DeterminismElement);

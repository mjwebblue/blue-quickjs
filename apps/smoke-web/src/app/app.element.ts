import './app.element.css';

import QuickJSGasWasm from '@blue-quickjs/quickjs-wasm-build/quickjs-eval';
import { gasFixtures, type GasFixture } from './gas-fixtures';

type HarnessResultKind = 'RESULT' | 'ERROR';

interface HarnessResult {
  kind: HarnessResultKind;
  message: string;
  gasRemaining: number;
  gasUsed: number;
  state?: string | null;
  trace?: string | null;
  raw: string;
}

function parseHarnessOutput(raw: string): HarnessResult {
  const trimmed = raw.trim();
  const match =
    /^(RESULT|ERROR)\s+(.*?)\s+GAS\s+remaining=(\d+)\s+used=(\d+)(?:\s+STATE\s+([\w.-]+))?(?:\s+TRACE\s+(.*))?$/u.exec(
      trimmed,
    );
  if (!match) {
    throw new Error(`Unable to parse harness output: ${trimmed}`);
  }
  const [, kind, message, remaining, used, state, trace] = match;
  return {
    kind: kind as HarnessResultKind,
    message,
    gasRemaining: Number(remaining),
    gasUsed: Number(used),
    state: state ?? null,
    trace: trace?.trim() ?? null,
    raw: trimmed,
  };
}

function resultsMatch(actual: HarnessResult, expected: HarnessResult): boolean {
  const stateMatches =
    expected.state !== undefined && expected.state !== null
      ? (actual.state ?? null) === expected.state
      : true;
  const traceMatches = expected.trace ? actual.trace === expected.trace : true;
  return (
    actual.kind === expected.kind &&
    actual.message === expected.message &&
    actual.gasRemaining === expected.gasRemaining &&
    actual.gasUsed === expected.gasUsed &&
    stateMatches &&
    traceMatches
  );
}

async function createWasmRunner() {
  const module = await QuickJSGasWasm();
  const evalFn = module.cwrap('qjs_eval', 'number', ['string', 'bigint']);
  const freeFn = module.cwrap('qjs_free_output', null, ['number']);
  return (code: string, gasLimit: bigint) => {
    const ptr = evalFn(code, gasLimit);
    const output = module.UTF8ToString(ptr);
    freeFn(ptr);
    return output.trim();
  };
}

export class AppElement extends HTMLElement {
  private runnerPromise: Promise<
    (code: string, gasLimit: bigint) => string
  > | null = null;

  private isRunning = false;

  connectedCallback() {
    this.render();
    this.attachEvents();
    void this.runAll();
  }

  private attachEvents() {
    this.querySelector<HTMLButtonElement>('[data-run]')?.addEventListener(
      'click',
      () => this.runAll(),
    );
  }

  private async runAll() {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.updateRunstate('running', 'Running gas fixtures…');

    let runWasm: (code: string, gasLimit: bigint) => string;
    try {
      runWasm = await this.getRunner();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load wasm harness';
      this.setAllToError(message);
      this.updateRunstate('error', message);
      this.isRunning = false;
      return;
    }

    for (const fixture of gasFixtures) {
      await this.runFixture(runWasm, fixture);
    }

    this.updateRunstate('done', 'Done');
    this.isRunning = false;
  }

  private async runFixture(
    runWasm: (code: string, gasLimit: bigint) => string,
    fixture: GasFixture,
  ) {
    const caseEl = this.querySelector<HTMLElement>(
      `[data-test-case="${fixture.name}"]`,
    );
    const actualPre = caseEl?.querySelector<HTMLPreElement>('[data-actual]');
    const pill = caseEl?.querySelector<HTMLElement>('[data-pill]');

    caseEl?.setAttribute('data-status', 'running');
    if (pill) {
      pill.textContent = 'running';
    }
    if (actualPre) {
      actualPre.textContent = 'Running…';
    }

    try {
      const raw = runWasm(fixture.source, fixture.gasLimit);
      const actual = parseHarnessOutput(raw);
      const expected = parseHarnessOutput(fixture.expected);
      const match = resultsMatch(actual, expected);

      if (actualPre) {
        actualPre.textContent = actual.raw;
      }

      if (!match) {
        console.error('Gas mismatch', {
          fixture: fixture.name,
          expected,
          actual,
        });
      }

      caseEl?.setAttribute('data-status', match ? 'ok' : 'fail');
      if (pill) {
        pill.textContent = match ? 'ok' : 'fail';
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unexpected error running fixture';
      if (actualPre) {
        actualPre.textContent = message;
      }
      caseEl?.setAttribute('data-status', 'fail');
      if (pill) {
        pill.textContent = 'fail';
      }
      console.error('Error while running fixture', {
        fixture: fixture.name,
        error,
      });
    }
  }

  private async getRunner() {
    if (!this.runnerPromise) {
      this.runnerPromise = createWasmRunner();
    }
    return this.runnerPromise;
  }

  private setAllToError(message: string) {
    this.querySelectorAll<HTMLElement>('[data-test-case]').forEach((caseEl) => {
      caseEl.setAttribute('data-status', 'fail');
      const pill = caseEl.querySelector<HTMLElement>('[data-pill]');
      if (pill) {
        pill.textContent = 'fail';
      }
      const actualPre = caseEl.querySelector<HTMLPreElement>('[data-actual]');
      if (actualPre) {
        actualPre.textContent = message;
      }
    });
  }

  private updateRunstate(
    state: 'idle' | 'running' | 'done' | 'error',
    label: string,
  ) {
    const runstate = this.querySelector<HTMLElement>('[data-runstate]');
    if (runstate) {
      runstate.textContent = label;
      runstate.setAttribute('data-runstate', state);
    }
  }

  private render() {
    this.innerHTML = `
      <main class="page">
        <header class="hero">
          <p class="eyebrow">T-029C · Browser gas smoke</p>
          <h1>QuickJS wasm gas fixtures (browser)</h1>
          <p class="lede">
            Loads the deterministic QuickJS wasm harness in-browser and checks the gas
            outputs against the wasm32 baselines shared with the Node harness. Mismatches
            are logged to the console for debugging.
          </p>
          <div class="controls">
            <button type="button" data-run>Run again</button>
            <span class="runstate" data-runstate="idle">Idle</span>
          </div>
        </header>
        <section class="cases" aria-live="polite">
          ${gasFixtures
            .map(
              (fixture) => `
                <article class="case" data-test-case="${fixture.name}" data-status="pending">
                  <div class="case-header">
                    <div>
                      <p class="label">${fixture.name}</p>
                      <p class="meta">gas limit ${fixture.gasLimit.toString()}</p>
                    </div>
                    <span class="pill" data-pill>pending</span>
                  </div>
                  <div class="panels">
                    <div>
                      <p class="panel-title">expected</p>
                      <pre data-expected>${fixture.expected}</pre>
                    </div>
                    <div>
                      <p class="panel-title">actual</p>
                      <pre data-actual>waiting…</pre>
                    </div>
                  </div>
                </article>
              `,
            )
            .join('')}
        </section>
      </main>
    `;
  }
}

customElements.define('blue-quickjs-root', AppElement);

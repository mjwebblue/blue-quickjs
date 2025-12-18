import './app.element.css';

import {
  SMOKE_BASELINE,
  SMOKE_GAS_LIMIT,
  SMOKE_INPUT,
  SMOKE_MANIFEST,
  SMOKE_PROGRAM,
  createSmokeHost,
} from '@blue-quickjs/test-harness';
import { type EvaluateResult, evaluate } from '@blue-quickjs/quickjs-runtime';
import {
  loadQuickjsWasmBinary,
  loadQuickjsWasmMetadata,
  type QuickjsWasmBuildMetadata,
} from '@blue-quickjs/quickjs-wasm';
import { hashDv, hashTape, sha256Hex } from './hash-utils.js';

type RunState = 'idle' | 'running' | 'done' | 'error';

interface SmokeDisplay {
  status: 'ok' | 'error';
  manifestHash: string;
  wasmHash: string | null;
  wasmExpected: string | null;
  engineBuildHash: string | null;
  resultHash: string | null;
  gasUsed: bigint;
  gasRemaining: bigint;
  tapeHash: string | null;
  tapeLength: number;
  emittedCount: number;
  errorCode: string;
  errorTag: string;
  raw: string;
}

interface WasmArtifacts {
  metadata: QuickjsWasmBuildMetadata;
  wasmBinary: Uint8Array;
  wasmHash: string;
  expectedWasmHash: string | null;
  engineBuildHash: string | null;
}

const EXPECTED = {
  resultHash: SMOKE_BASELINE.resultHash,
  gasUsed: SMOKE_BASELINE.gasUsed.toString(),
  gasRemaining: SMOKE_BASELINE.gasRemaining.toString(),
  tapeHash: SMOKE_BASELINE.tapeHash,
  tapeLength: SMOKE_BASELINE.tapeLength.toString(),
  emittedCount: SMOKE_BASELINE.emittedCount.toString(),
  errorCode: 'none',
  errorTag: 'none',
} as const;

export class AppElement extends HTMLElement {
  private isRunning = false;

  private artifactsPromise: Promise<WasmArtifacts> | null = null;

  connectedCallback() {
    this.render();
    this.attachEvents();
    this.setBaselineExpectations();
    void this.runSmoke();
  }

  private attachEvents() {
    this.querySelector<HTMLButtonElement>('[data-run]')?.addEventListener(
      'click',
      () => this.runSmoke(),
    );
  }

  private async runSmoke() {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.updateRunstate('running', 'Running browser smoke fixture…');

    try {
      const artifacts = await this.loadArtifacts();
      this.setExpected('wasm-hash', artifacts.expectedWasmHash ?? 'n/a');
      if (artifacts.engineBuildHash) {
        this.updateText(
          '[data-field="engine-hash"] [data-actual]',
          artifacts.engineBuildHash,
        );
      }

      const display = await this.executeSmoke(artifacts);
      this.applyDisplay(display);
      this.updateRunstate('done', 'Done');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to run smoke fixture';
      this.showError(message);
      this.updateRunstate('error', message);
    } finally {
      this.isRunning = false;
    }
  }

  private async loadArtifacts(): Promise<WasmArtifacts> {
    if (!this.artifactsPromise) {
      this.artifactsPromise = (async () => {
        const metadata = await loadQuickjsWasmMetadata();
        const wasmBinary = await loadQuickjsWasmBinary();
        const wasmHash = await sha256Hex(wasmBinary);
        const expectedWasmHash =
          metadata.variants?.wasm32?.release?.wasm.sha256 ?? null;
        const engineBuildHash =
          metadata.variants?.wasm32?.release?.engineBuildHash ??
          metadata.engineBuildHash ??
          null;

        return {
          metadata,
          wasmBinary,
          wasmHash,
          expectedWasmHash,
          engineBuildHash,
        };
      })();
    }
    return this.artifactsPromise;
  }

  private async executeSmoke(artifacts: WasmArtifacts): Promise<SmokeDisplay> {
    const host = createSmokeHost(SMOKE_INPUT);
    const result = await evaluate({
      program: SMOKE_PROGRAM,
      input: SMOKE_INPUT,
      gasLimit: SMOKE_GAS_LIMIT,
      manifest: SMOKE_MANIFEST,
      handlers: host.handlers,
      metadata: artifacts.metadata,
      wasmBinary: artifacts.wasmBinary,
      tape: { capacity: 16 },
    });

    return this.toDisplay(result, host.emitted.length, artifacts);
  }

  private async toDisplay(
    result: EvaluateResult,
    emittedCount: number,
    artifacts: WasmArtifacts,
  ): Promise<SmokeDisplay> {
    const tapeHash = await hashTape(result.tape ?? []);
    const resultHash = result.ok ? await hashDv(result.value) : null;
    const errorCode = result.ok ? EXPECTED.errorCode : result.error.code;
    const errorTag = result.ok
      ? EXPECTED.errorTag
      : 'tag' in result.error
        ? (result.error.tag ?? 'unknown')
        : 'unknown';

    return {
      status: result.ok ? 'ok' : 'error',
      manifestHash: SMOKE_PROGRAM.abiManifestHash,
      wasmHash: artifacts.wasmHash,
      wasmExpected: artifacts.expectedWasmHash,
      engineBuildHash: artifacts.engineBuildHash,
      resultHash,
      gasUsed: result.gasUsed,
      gasRemaining: result.gasRemaining,
      tapeHash,
      tapeLength: result.tape?.length ?? 0,
      emittedCount,
      errorCode,
      errorTag,
      raw: result.raw.trim(),
    };
  }

  private applyDisplay(display: SmokeDisplay) {
    const match = {
      wasmHash:
        display.wasmExpected !== null
          ? display.wasmHash === display.wasmExpected
          : true,
      resultHash:
        display.resultHash !== null &&
        display.resultHash === EXPECTED.resultHash,
      gasUsed: display.gasUsed === BigInt(EXPECTED.gasUsed),
      gasRemaining: display.gasRemaining === BigInt(EXPECTED.gasRemaining),
      tapeHash:
        display.tapeHash !== null && display.tapeHash === EXPECTED.tapeHash,
      tapeLength: display.tapeLength.toString() === EXPECTED.tapeLength,
      emitted: display.emittedCount.toString() === EXPECTED.emittedCount,
      errorCode: display.errorCode === EXPECTED.errorCode,
      errorTag: display.errorTag === EXPECTED.errorTag,
    };

    this.updateStatus(display.status);
    this.updateMetric('wasm-hash', display.wasmHash ?? 'unavailable', {
      expected: display.wasmExpected ?? undefined,
      match: match.wasmHash,
    });
    this.updateMetric('result-hash', display.resultHash ?? 'n/a', {
      expected: EXPECTED.resultHash,
      match: match.resultHash,
    });
    this.updateMetric('gas-used', display.gasUsed.toString(), {
      expected: EXPECTED.gasUsed,
      match: match.gasUsed,
    });
    this.updateMetric('gas-remaining', display.gasRemaining.toString(), {
      expected: EXPECTED.gasRemaining,
      match: match.gasRemaining,
    });
    this.updateMetric('tape-hash', display.tapeHash ?? 'n/a', {
      expected: EXPECTED.tapeHash,
      match: match.tapeHash,
    });
    this.updateMetric('tape-length', display.tapeLength.toString(), {
      expected: EXPECTED.tapeLength,
      match: match.tapeLength,
    });
    this.updateMetric('emits', display.emittedCount.toString(), {
      expected: EXPECTED.emittedCount,
      match: match.emitted,
    });
    this.updateMetric('error-code', display.errorCode, {
      expected: EXPECTED.errorCode,
      match: match.errorCode,
    });
    this.updateMetric('error-tag', display.errorTag, {
      expected: EXPECTED.errorTag,
      match: match.errorTag,
    });

    this.updateText(
      '[data-field="manifest-hash"] [data-actual]',
      display.manifestHash,
    );
    if (display.engineBuildHash) {
      this.updateText(
        '[data-field="engine-hash"] [data-actual]',
        display.engineBuildHash,
      );
    }

    const raw = this.querySelector<HTMLElement>('[data-raw]');
    if (raw) {
      raw.textContent = display.raw || '—';
    }
  }

  private setBaselineExpectations() {
    this.setExpected('result-hash', EXPECTED.resultHash);
    this.setExpected('gas-used', EXPECTED.gasUsed);
    this.setExpected('gas-remaining', EXPECTED.gasRemaining);
    this.setExpected('tape-hash', EXPECTED.tapeHash);
    this.setExpected('tape-length', EXPECTED.tapeLength);
    this.setExpected('emits', EXPECTED.emittedCount);
    this.setExpected('error-code', EXPECTED.errorCode);
    this.setExpected('error-tag', EXPECTED.errorTag);
  }

  private updateMetric(
    field: string,
    actual: string,
    options?: { expected?: string; match?: boolean },
  ) {
    const card = this.querySelector<HTMLElement>(`[data-field="${field}"]`);
    const actualEl = card?.querySelector<HTMLElement>('[data-actual]');
    if (actualEl) {
      actualEl.textContent = actual;
    }
    if (options?.expected !== undefined) {
      this.setExpected(field, options.expected);
      if (options.match !== undefined && card) {
        card.setAttribute('data-match', options.match ? 'true' : 'false');
      }
    }
  }

  private setExpected(field: string, expected: string) {
    const card = this.querySelector<HTMLElement>(`[data-field="${field}"]`);
    const expectedEl = card?.querySelector<HTMLElement>('[data-expected]');
    if (expectedEl) {
      expectedEl.textContent = expected;
    }
  }

  private updateStatus(status: 'ok' | 'error') {
    const card = this.querySelector<HTMLElement>('[data-field="status"]');
    if (card) {
      card.setAttribute('data-status', status);
      const actualEl = card.querySelector<HTMLElement>('[data-actual]');
      if (actualEl) {
        actualEl.textContent = status;
      }
    }
  }

  private updateRunstate(state: RunState, label: string) {
    const runstate = this.querySelector<HTMLElement>('[data-runstate]');
    if (runstate) {
      runstate.textContent = label;
      runstate.setAttribute('data-runstate', state);
    }
  }

  private showError(message: string) {
    this.updateStatus('error');
    const cards = this.querySelectorAll<HTMLElement>('[data-field]');
    cards.forEach((card) => {
      if (!card.dataset.match) {
        card.setAttribute('data-match', 'false');
      }
    });
    const raw = this.querySelector<HTMLElement>('[data-raw]');
    if (raw) {
      raw.textContent = message;
    }
  }

  private updateText(selector: string, value: string) {
    const el = this.querySelector<HTMLElement>(selector);
    if (el) {
      el.textContent = value;
    }
  }

  private render() {
    this.innerHTML = `
      <main class="page">
        <header class="hero">
          <p class="eyebrow">T-071 · Browser smoke</p>
          <h1>Deterministic QuickJS (browser)</h1>
          <p class="lede">
            Runs the Host.v1 smoke fixture in-browser using the same wasm bytes as the Node runner,
            then compares the hashes against the Node baseline.
          </p>
          <div class="controls">
            <button type="button" data-run>Run again</button>
            <span class="runstate" data-runstate="idle">Idle</span>
          </div>
        </header>
        <section class="metrics">
          <article class="card" data-field="status">
            <p class="label">status</p>
            <p class="value" data-actual>not run</p>
          </article>
          <article class="card" data-field="wasm-hash">
            <p class="label">wasm sha256</p>
            <p class="value" data-actual>loading…</p>
            <p class="meta">expected <span data-expected>loading…</span></p>
          </article>
          <article class="card" data-field="engine-hash">
            <p class="label">engine build</p>
            <p class="value" data-actual>loading…</p>
          </article>
          <article class="card" data-field="manifest-hash">
            <p class="label">manifest hash</p>
            <p class="value" data-actual>${SMOKE_PROGRAM.abiManifestHash}</p>
          </article>
          <article class="card" data-field="result-hash">
            <p class="label">result hash</p>
            <p class="value" data-actual>waiting…</p>
            <p class="meta">expected <span data-expected>—</span></p>
          </article>
          <article class="card" data-field="gas-used">
            <p class="label">gas used</p>
            <p class="value" data-actual>—</p>
            <p class="meta">expected <span data-expected>—</span></p>
          </article>
          <article class="card" data-field="gas-remaining">
            <p class="label">gas remaining</p>
            <p class="value" data-actual>—</p>
            <p class="meta">expected <span data-expected>—</span></p>
          </article>
          <article class="card" data-field="tape-hash">
            <p class="label">tape hash</p>
            <p class="value" data-actual>—</p>
            <p class="meta">expected <span data-expected>—</span></p>
          </article>
          <article class="card" data-field="tape-length">
            <p class="label">tape length</p>
            <p class="value" data-actual>—</p>
            <p class="meta">expected <span data-expected>—</span></p>
          </article>
          <article class="card" data-field="emits">
            <p class="label">host emits</p>
            <p class="value" data-actual>—</p>
            <p class="meta">expected <span data-expected>—</span></p>
          </article>
          <article class="card" data-field="error-code">
            <p class="label">error code</p>
            <p class="value" data-actual>—</p>
            <p class="meta">expected <span data-expected>—</span></p>
          </article>
          <article class="card" data-field="error-tag">
            <p class="label">error tag</p>
            <p class="value" data-actual>—</p>
            <p class="meta">expected <span data-expected>—</span></p>
          </article>
        </section>
        <section class="raw">
          <p class="panel-title">raw output</p>
          <pre data-raw>waiting…</pre>
        </section>
      </main>
    `;
  }
}

customElements.define('blue-quickjs-root', AppElement);

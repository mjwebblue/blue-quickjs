import { createHash } from 'crypto';

import { encodeDv, type DV } from '@blue-quickjs/dv';
import { type EvaluateResult, evaluate } from '@blue-quickjs/quickjs-runtime';

import {
  SMOKE_GAS_LIMIT,
  SMOKE_INPUT,
  SMOKE_MANIFEST,
  SMOKE_PROGRAM,
  createSmokeHost,
  type SmokeHostEnvironment,
  serializeHostTape,
} from './fixtures.js';

export interface SmokeSummary {
  status: 'ok' | 'error' | 'fatal';
  manifestHash: string;
  resultHash?: string;
  gasUsed: bigint;
  gasRemaining: bigint;
  tapeCount: number;
  tapeHash?: string;
  raw: string;
  value?: DV;
  emitted: DV[];
  error?: {
    kind: string;
    code?: string;
    tag?: string;
    message: string;
  };
}

export interface SmokeRunnerOptions {
  debug?: boolean;
  log?: (line: string) => void;
}

export async function runSmokeNode(
  options?: SmokeRunnerOptions,
): Promise<SmokeSummary> {
  const logger = options?.log ?? defaultLog;
  let host: SmokeHostEnvironment | null = null;

  try {
    host = createSmokeHost();
    const result = await evaluate({
      program: SMOKE_PROGRAM,
      input: SMOKE_INPUT,
      gasLimit: SMOKE_GAS_LIMIT,
      manifest: SMOKE_MANIFEST,
      handlers: host.handlers,
      tape: { capacity: 16 },
    });
    const summary = summarize(result, host.emitted);
    logSummary(summary, logger, options?.debug);
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const summary: SmokeSummary = {
      status: 'fatal',
      manifestHash: SMOKE_PROGRAM.abiManifestHash,
      gasUsed: 0n,
      gasRemaining: 0n,
      tapeCount: 0,
      raw: message,
      emitted: host?.emitted ?? [],
      error: { kind: 'fatal', message },
    };
    logSummary(summary, logger, options?.debug);
    return summary;
  }
}

function summarize(result: EvaluateResult, emitted: DV[]): SmokeSummary {
  const tapeHash =
    result.tape && result.tape.length > 0
      ? hashString(serializeHostTape(result.tape))
      : undefined;

  if (result.ok) {
    return {
      status: 'ok',
      manifestHash: SMOKE_PROGRAM.abiManifestHash,
      resultHash: hashDv(result.value),
      gasUsed: result.gasUsed,
      gasRemaining: result.gasRemaining,
      tapeCount: result.tape?.length ?? 0,
      tapeHash,
      raw: result.raw,
      value: result.value,
      emitted,
    };
  }

  return {
    status: 'error',
    manifestHash: SMOKE_PROGRAM.abiManifestHash,
    gasUsed: result.gasUsed,
    gasRemaining: result.gasRemaining,
    tapeCount: result.tape?.length ?? 0,
    tapeHash,
    raw: result.raw,
    error: {
      kind: result.error.kind,
      code: result.error.code,
      tag: 'tag' in result.error ? result.error.tag : undefined,
      message: result.message,
    },
    emitted,
  };
}

function hashDv(value: DV): string {
  const bytes = encodeDv(value);
  return createHash('sha256').update(bytes).digest('hex');
}

function hashString(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function logSummary(
  summary: SmokeSummary,
  log: (line: string) => void,
  debug?: boolean,
): void {
  log('smoke-node fixture');
  log(`manifest hash : ${summary.manifestHash}`);
  log(`status        : ${summary.status}`);

  if (summary.status === 'ok' && summary.resultHash) {
    log(`result hash   : ${summary.resultHash}`);
  }

  if (summary.error) {
    const code = summary.error.code ?? 'unknown';
    const tag = summary.error.tag ?? 'n/a';
    log(`error         : ${summary.error.kind} code=${code} tag=${tag}`);
    log(`message       : ${summary.error.message}`);
  }

  log(`gas used      : ${summary.gasUsed.toString()}`);
  log(`gas remaining : ${summary.gasRemaining.toString()}`);
  log(`host tape     : ${summary.tapeCount}`);
  log(`host emits    : ${summary.emitted.length}`);
  if (summary.tapeHash) {
    log(`tape hash     : ${summary.tapeHash}`);
  }

  if (debug && summary.value !== undefined) {
    log('dv (debug)    :');
    for (const line of formatDv(summary.value)) {
      log(`  ${line}`);
    }
  }

  if (debug && summary.emitted.length > 0) {
    log('emitted (debug):');
    for (const payload of summary.emitted) {
      for (const line of formatDv(payload)) {
        log(`  ${line}`);
      }
    }
  }

  log(`raw           : ${summary.raw.trim()}`);
}

function formatDv(value: DV): string[] {
  const pretty = JSON.stringify(value, null, 2);
  return pretty ? pretty.split('\n') : [];
}

function defaultLog(line: string): void {
  console.log(line);
}

import type { DV } from '@blue-quickjs/dv';
import { HOST_V1_HASH, HOST_V1_MANIFEST } from './abi-manifest-fixtures.js';

export interface SmokeProgramArtifact {
  code: string;
  abiId: string;
  abiVersion: number;
  abiManifestHash: string;
  engineBuildHash?: string;
  runtimeFlags?: Record<string, string | number | boolean>;
}

export interface SmokeInputEnvelope {
  event: DV;
  eventCanonical: DV;
  steps: DV;
  document: {
    id?: string;
    hash?: string;
    epoch?: number;
  };
  hostContext?: DV;
}

export const SMOKE_PROGRAM: SmokeProgramArtifact = {
  code: `
    (() => {
      const doc = document("path/to/doc");
      const canonicalDoc = document.canonical("path/to/doc");
      Host.v1.emit({ path: doc.path, canonical: canonicalDoc.canonical });
      return {
        marker: "smoke-node",
        doc,
        canonicalDoc,
        event,
        steps
      };
    })()
  `.trim(),
  abiId: 'Host.v1',
  abiVersion: 1,
  abiManifestHash: HOST_V1_HASH,
};

export const SMOKE_INPUT: SmokeInputEnvelope = {
  event: { type: 'demo', payload: { id: 1, state: 'ready' } },
  eventCanonical: { type: 'demo', payload: { id: 1, state: 'ready' } },
  steps: [
    { name: 'ingest', status: 'done' },
    { name: 'analyze', status: 'pending' },
  ],
  document: {
    id: 'doc-demo',
    hash: HOST_V1_HASH,
    epoch: 7,
  },
  hostContext: { requestId: 'smoke-node', locale: 'en-US' },
};

export const SMOKE_GAS_LIMIT = 50_000n;

export const SMOKE_MANIFEST = HOST_V1_MANIFEST;

export interface SmokeHostHandlers {
  document: {
    get: (path: string) => { ok: DV; units: number };
    getCanonical: (path: string) => { ok: DV; units: number };
  };
  emit: (value: DV) => { ok: null; units: number };
}

export interface SmokeHostEnvironment {
  handlers: SmokeHostHandlers;
  emitted: DV[];
}

export function createSmokeHost(
  input: SmokeInputEnvelope,
): SmokeHostEnvironment {
  const emitted: DV[] = [];
  const context = input.hostContext ?? {};
  const requestId =
    typeof context === 'object' &&
    context &&
    'requestId' in context &&
    typeof (context as Record<string, unknown>).requestId === 'string'
      ? String((context as Record<string, unknown>).requestId)
      : null;
  const snapshot: DV = {
    requestId,
    epoch: input.document.epoch ?? null,
  };
  const documentHash = input.document.hash ?? HOST_V1_HASH;

  const handlers: SmokeHostHandlers = {
    document: {
      get: (path: string) => ({
        ok: {
          path,
          snapshot,
        },
        units: 9,
      }),
      getCanonical: (path: string) => ({
        ok: {
          canonical: path,
          hash: documentHash,
          snapshot,
        },
        units: 7,
      }),
    },
    emit: (value: DV) => {
      emitted.push(value);
      return { ok: null, units: 1 };
    },
  };

  return { handlers, emitted };
}

export interface SmokeBaseline {
  manifestHash: string;
  resultHash: string;
  gasUsed: bigint;
  gasRemaining: bigint;
  emittedCount: number;
  tapeLength: number;
  tapeHash: string;
}

export const SMOKE_BASELINE: SmokeBaseline = {
  manifestHash: HOST_V1_HASH,
  resultHash:
    '75f844894a9c3cf3da958906adbce5943dd87cfa669992e125970f6d080f201d',
  gasUsed: 1976n,
  gasRemaining: 48024n,
  emittedCount: 1,
  tapeLength: 3,
  tapeHash: 'cb2d35a1616faeeeef73a608c2eaab03d040c4244ecc17a66d2a6fc3c17fa174',
};

export interface SmokeTapeRecord {
  fnId: number;
  reqLen: number;
  respLen: number;
  units: number;
  gasPre: bigint;
  gasPost: bigint;
  isError: boolean;
  chargeFailed: boolean;
  reqHash: string;
  respHash: string;
}

export function serializeHostTape(tape: SmokeTapeRecord[]): string {
  return JSON.stringify(
    tape.map((record) => ({
      fnId: record.fnId,
      reqLen: record.reqLen,
      respLen: record.respLen,
      units: record.units,
      gasPre: record.gasPre.toString(),
      gasPost: record.gasPost.toString(),
      isError: record.isError,
      chargeFailed: record.chargeFailed,
      reqHash: record.reqHash,
      respHash: record.respHash,
    })),
  );
}

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

export function createSmokeHost(): SmokeHostEnvironment {
  const emitted: DV[] = [];
  const documentHash = HOST_V1_HASH;

  const handlers: SmokeHostHandlers = {
    document: {
      get: (path: string) => ({
        ok: {
          path,
        },
        units: 9,
      }),
      getCanonical: (path: string) => ({
        ok: {
          canonical: path,
          hash: documentHash,
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
    '4a13893d4d564c7c9e7dcb0b6bbc028b824268585a0cbbdb19ac28a34138f293',
  gasUsed: 1638n,
  gasRemaining: 48362n,
  emittedCount: 1,
  tapeLength: 3,
  tapeHash: '2ca437d26207d59b369ae74a448d497a79ae482071d61ff8b05fa78a7d5b570f',
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

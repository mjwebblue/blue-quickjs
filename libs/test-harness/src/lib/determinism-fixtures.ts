import type { AbiManifest } from '@blue-quickjs/abi-manifest';
import type { DV } from '@blue-quickjs/dv';
import { HOST_V1_HASH, HOST_V1_MANIFEST } from './abi-manifest-fixtures.js';

export interface DeterminismProgramArtifact {
  code: string;
  abiId: string;
  abiVersion: number;
  abiManifestHash: string;
  engineBuildHash?: string;
  runtimeFlags?: Record<string, string | number | boolean>;
}

export interface DeterminismInputEnvelope {
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

export const DETERMINISM_INPUT: DeterminismInputEnvelope = {
  event: { type: 'analysis', payload: { id: 42, mode: 'full' } },
  eventCanonical: { type: 'analysis', payload: { id: 42, mode: 'full' } },
  steps: [
    { name: 'ingest', status: 'done' },
    { name: 'review', status: 'queued' },
    { name: 'publish', status: 'pending' },
  ],
  document: {
    id: 'doc-det',
    hash: HOST_V1_HASH,
    epoch: 3,
  },
  hostContext: { requestId: 'det-req', locale: 'en-US' },
};

export const DETERMINISM_GAS_LIMIT = 50_000n;

export interface DeterminismHostHandlers {
  document: {
    get: (
      path: string,
    ) => { ok: DV; units: number } | { err: HostError; units: number };
    getCanonical: (
      path: string,
    ) => { ok: DV; units: number } | { err: HostError; units: number };
  };
  emit: (
    value: DV,
  ) => { ok: null; units: number } | { err: HostError; units: number };
}

export interface DeterminismHostEnvironment {
  handlers: DeterminismHostHandlers;
  emitted: DV[];
}

export interface DeterminismFixtureBaseline {
  resultHash: string | null;
  errorCode: string | null;
  errorTag: string | null;
  gasUsed: bigint;
  gasRemaining: bigint;
  tapeHash: string | null;
  tapeLength: number;
}

export interface DeterminismFixture {
  name: string;
  program: DeterminismProgramArtifact;
  input: DeterminismInputEnvelope;
  gasLimit: bigint;
  manifest: AbiManifest;
  createHost: (input: DeterminismInputEnvelope) => DeterminismHostEnvironment;
  expected: DeterminismFixtureBaseline;
}

type HostError = {
  code: 'INVALID_PATH' | 'LIMIT_EXCEEDED' | 'NOT_FOUND';
  tag: 'host/invalid_path' | 'host/limit' | 'host/not_found';
};

const HOST_ERRORS: Record<string, HostError> = {
  invalid: { code: 'INVALID_PATH', tag: 'host/invalid_path' },
  limit: { code: 'LIMIT_EXCEEDED', tag: 'host/limit' },
  missing: { code: 'NOT_FOUND', tag: 'host/not_found' },
};

const ERROR_PATHS = new Map<string, HostError>([
  ['missing/doc', HOST_ERRORS.missing],
  ['invalid/path', HOST_ERRORS.invalid],
  ['limit/doc', HOST_ERRORS.limit],
]);

export function createDeterminismHost(
  input: DeterminismInputEnvelope,
): DeterminismHostEnvironment {
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

  const resolveError = (path: string): HostError | null =>
    ERROR_PATHS.get(path) ?? null;

  const handlers: DeterminismHostHandlers = {
    document: {
      get: (path: string) => {
        const error = resolveError(path);
        if (error) {
          return { err: error, units: 2 };
        }
        return {
          ok: {
            path,
            snapshot,
          },
          units: 9,
        };
      },
      getCanonical: (path: string) => {
        const error = resolveError(path);
        if (error) {
          return { err: error, units: 2 };
        }
        return {
          ok: {
            canonical: path,
            hash: documentHash,
            snapshot,
          },
          units: 7,
        };
      },
    },
    emit: (value: DV) => {
      emitted.push(value);
      return { ok: null, units: 1 };
    },
  };

  return { handlers, emitted };
}

const BASE_PROGRAM = {
  abiId: 'Host.v1',
  abiVersion: 1,
  abiManifestHash: HOST_V1_HASH,
} satisfies Omit<DeterminismProgramArtifact, 'code'>;

export const DETERMINISM_FIXTURES: DeterminismFixture[] = [
  {
    name: 'doc-read',
    program: {
      ...BASE_PROGRAM,
      code: `
        (() => {
          const doc = document("path/to/doc");
          return {
            marker: "det-doc",
            doc,
            event,
            steps
          };
        })()
      `.trim(),
    },
    input: DETERMINISM_INPUT,
    gasLimit: DETERMINISM_GAS_LIMIT,
    manifest: HOST_V1_MANIFEST,
    createHost: createDeterminismHost,
    expected: {
      resultHash:
        '40c9b59e50a58568400ad03cf9f026de644f674eed0b51393b594797069974e9',
      errorCode: null,
      errorTag: null,
      gasUsed: 1242n,
      gasRemaining: 48758n,
      tapeHash:
        'b88714d181f77f9c6c1a1e85423668b7beae39820bdef7b329afee67b6140858',
      tapeLength: 1,
    },
  },
  {
    name: 'doc-canonical',
    program: {
      ...BASE_PROGRAM,
      code: `
        (() => {
          const canonical = document.canonical("path/to/canonical");
          return {
            marker: "det-canonical",
            canonical,
            eventCanonical
          };
        })()
      `.trim(),
    },
    input: DETERMINISM_INPUT,
    gasLimit: DETERMINISM_GAS_LIMIT,
    manifest: HOST_V1_MANIFEST,
    createHost: createDeterminismHost,
    expected: {
      resultHash:
        '3e006c88185e9042869b23947b0adb5a7981ca3378ea8362999e6b6ffef79b81',
      errorCode: null,
      errorTag: null,
      gasUsed: 1211n,
      gasRemaining: 48789n,
      tapeHash:
        '5788f4d85b26f9211566f18a4ef10b38a0feac8233fbb7528f10ab13d03e0a30',
      tapeLength: 1,
    },
  },
  {
    name: 'multi-host',
    program: {
      ...BASE_PROGRAM,
      code: `
        (() => {
          const first = document("path/to/first");
          const second = document.canonical("path/to/second");
          Host.v1.emit({ first: first.path, canonical: second.canonical });
          const third = document("path/to/third");
          return {
            marker: "det-multi",
            first,
            second,
            third
          };
        })()
      `.trim(),
    },
    input: DETERMINISM_INPUT,
    gasLimit: DETERMINISM_GAS_LIMIT,
    manifest: HOST_V1_MANIFEST,
    createHost: createDeterminismHost,
    expected: {
      resultHash:
        'd08c59d53e0936b30b13737bed03ee058b26fbf0999300f7bc5a8e81c2394eab',
      errorCode: null,
      errorTag: null,
      gasUsed: 2276n,
      gasRemaining: 47724n,
      tapeHash:
        'df27956ff58e25691a39b9deefe243eb080d5235daadad1355beb94a79e85165',
      tapeLength: 4,
    },
  },
  {
    name: 'host-gas-paths',
    program: {
      ...BASE_PROGRAM,
      code: `
        (() => {
          const shortDoc = document("doc");
          const mediumDoc = document("path/to/medium");
          const longDoc = document.canonical("path/to/a/very/long/document/path");
          return {
            marker: "det-host-gas",
            shortDoc,
            mediumDoc,
            longDoc
          };
        })()
      `.trim(),
    },
    input: DETERMINISM_INPUT,
    gasLimit: DETERMINISM_GAS_LIMIT,
    manifest: HOST_V1_MANIFEST,
    createHost: createDeterminismHost,
    expected: {
      resultHash:
        '1b32c406ba95ebbb5a7d8feb85f1bc8af54cb89b51abc51ed7a32aaac77b7e48',
      errorCode: null,
      errorTag: null,
      gasUsed: 2055n,
      gasRemaining: 47945n,
      tapeHash:
        'ac5206968957830c83b2e66c06a97e779c4fdebe595a63fc386ffcb0122368aa',
      tapeLength: 3,
    },
  },
  {
    name: 'canon-ops',
    program: {
      ...BASE_PROGRAM,
      code: `
        (() => {
          const payloadId = canon.at(event, ["payload", "id"]);
          const mode = canon.at(eventCanonical, ["payload", "mode"]);
          const stepName = canon.at(steps, [1, "name"]);
          const cloned = canon.unwrap(event);
          return {
            marker: "det-canon",
            payloadId,
            mode,
            stepName,
            cloned
          };
        })()
      `.trim(),
    },
    input: DETERMINISM_INPUT,
    gasLimit: DETERMINISM_GAS_LIMIT,
    manifest: HOST_V1_MANIFEST,
    createHost: createDeterminismHost,
    expected: {
      resultHash:
        'b19cd2f9dc8d93cb259a85f365378dd4e5b97f0a93adff0ac7d3f0b89c10ac2f',
      errorCode: null,
      errorTag: null,
      gasUsed: 1932n,
      gasRemaining: 48068n,
      tapeHash: null,
      tapeLength: 0,
    },
  },
  {
    name: 'host-error-invalid',
    program: {
      ...BASE_PROGRAM,
      code: `
        (() => {
          document("invalid/path");
          return { marker: "det-invalid" };
        })()
      `.trim(),
    },
    input: DETERMINISM_INPUT,
    gasLimit: DETERMINISM_GAS_LIMIT,
    manifest: HOST_V1_MANIFEST,
    createHost: createDeterminismHost,
    expected: {
      resultHash: null,
      errorCode: 'INVALID_PATH',
      errorTag: 'host/invalid_path',
      gasUsed: 776n,
      gasRemaining: 49224n,
      tapeHash:
        '79af1be3f347fffc766bbe0baef9a183f0d6ee206468954d8f2adb9c146b9ddc',
      tapeLength: 1,
    },
  },
  {
    name: 'host-error-limit',
    program: {
      ...BASE_PROGRAM,
      code: `
        (() => {
          document("limit/doc");
          return { marker: "det-limit" };
        })()
      `.trim(),
    },
    input: DETERMINISM_INPUT,
    gasLimit: DETERMINISM_GAS_LIMIT,
    manifest: HOST_V1_MANIFEST,
    createHost: createDeterminismHost,
    expected: {
      resultHash: null,
      errorCode: 'LIMIT_EXCEEDED',
      errorTag: 'host/limit',
      gasUsed: 774n,
      gasRemaining: 49226n,
      tapeHash:
        '4894237cf19c834c9bff793693a158be3443e56df132773f6c61c7aed456a088',
      tapeLength: 1,
    },
  },
  {
    name: 'host-error',
    program: {
      ...BASE_PROGRAM,
      code: `
        (() => {
          document("missing/doc");
          return { marker: "det-error" };
        })()
      `.trim(),
    },
    input: DETERMINISM_INPUT,
    gasLimit: DETERMINISM_GAS_LIMIT,
    manifest: HOST_V1_MANIFEST,
    createHost: createDeterminismHost,
    expected: {
      resultHash: null,
      errorCode: 'NOT_FOUND',
      errorTag: 'host/not_found',
      gasUsed: 771n,
      gasRemaining: 49229n,
      tapeHash:
        'a540c3ce0fd4043d8c3262e3c1ae2bc6bb50d3e17d0cc1dd2a8af8957eaca013',
      tapeLength: 1,
    },
  },
];

import { decodeDv } from '@blue-quickjs/dv';
import { HOST_V1_HASH, HOST_V1_MANIFEST } from '@blue-quickjs/test-harness';
import { initializeDeterministicVm } from './deterministic-init.js';
import type { HostDispatcherHandlers } from './host-dispatcher.js';
import { parseHexToBytes } from './hex-utils.js';
import { createRuntime } from './runtime.js';
import type { InputEnvelope, ProgramArtifact } from './quickjs-runtime.js';

const BASE_PROGRAM: ProgramArtifact = {
  code: 'export default 1;',
  abiId: 'Host.v1',
  abiVersion: 1,
  abiManifestHash: HOST_V1_HASH,
};
const TEST_GAS_LIMIT = 10_000n;

const BASE_INPUT: InputEnvelope = {
  event: { type: 'create', payload: { id: 1 } },
  eventCanonical: { type: 'create', payload: { id: 1 } },
  steps: [{ name: 'first' }],
};

describe('initializeDeterministicVm', () => {
  it('installs ergonomic globals and freezes injected values', async () => {
    const runtime = await createRuntime({
      manifest: HOST_V1_MANIFEST,
      handlers: createHandlers(),
    });

    const vm = initializeDeterministicVm(
      runtime,
      BASE_PROGRAM,
      BASE_INPUT,
      TEST_GAS_LIMIT,
    );
    try {
      const output = vm.eval(`
        (() => {
          const docResult = document("path/to/doc");
          return {
            docType: typeof document,
            docCanonicalType: typeof document.canonical,
            documentExtensible: Object.isExtensible(document),
            canonExtensible: Object.isExtensible(canon),
            eventFrozen: Object.isFrozen(event),
            stepsFrozen: Object.isFrozen(steps),
            docResult
          };
        })()
      `);

      const parsed = parseEvalOutput(output);
      if (parsed.kind === 'ERROR') {
        throw new Error(`eval failed: ${parsed.message}`);
      }
      expect(parsed.kind).toBe('RESULT');
      expect(parsed.value).toMatchObject({
        docType: 'function',
        docCanonicalType: 'function',
        documentExtensible: false,
        canonExtensible: false,
        eventFrozen: true,
        stepsFrozen: true,
        docResult: { path: 'path/to/doc' },
      });
    } finally {
      vm.dispose();
    }
  });

  it('fails when the provided manifest hash does not match the bytes', async () => {
    const runtime = await createRuntime({
      manifest: HOST_V1_MANIFEST,
      handlers: createHandlers(),
    });
    const badProgram: ProgramArtifact = {
      ...BASE_PROGRAM,
      abiManifestHash: '0'.repeat(64),
    };

    expect(() =>
      initializeDeterministicVm(
        runtime,
        badProgram,
        BASE_INPUT,
        TEST_GAS_LIMIT,
      ),
    ).toThrow(/manifest hash/i);
  });
});

function createHandlers(
  overrides?: Partial<HostDispatcherHandlers>,
): HostDispatcherHandlers {
  return {
    document: {
      get:
        overrides?.document?.get ??
        ((path: string) => ({ ok: { path }, units: 5 })),
      getCanonical:
        overrides?.document?.getCanonical ??
        ((path: string) => ({ ok: { canonical: path }, units: 3 })),
    },
    emit:
      overrides?.emit ??
      (() => ({
        ok: null,
        units: 1,
      })),
  };
}

function parseEvalOutput(raw: string): {
  kind: 'RESULT' | 'ERROR';
  message: string;
  value: unknown;
  gasRemaining: number;
  gasUsed: number;
} {
  const match =
    /^(RESULT|ERROR)\s+(.+?)\s+GAS\s+remaining=(\d+)\s+used=(\d+)/.exec(
      raw.trim(),
    );
  if (!match) {
    throw new Error(`Unable to parse eval output: ${raw}`);
  }

  const [, kind, payload, remaining, used] = match;
  const value =
    kind === 'RESULT' ? decodeDv(parseHexToBytes(payload)) : payload.trim();

  return {
    kind: kind as 'RESULT' | 'ERROR',
    message: payload,
    value,
    gasRemaining: Number(remaining),
    gasUsed: Number(used),
  };
}

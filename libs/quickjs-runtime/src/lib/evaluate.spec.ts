import { HOST_V1_HASH, HOST_V1_MANIFEST } from '@blue-quickjs/test-harness';
import { vi } from 'vitest';
import { evaluate } from './evaluate.js';
import type { HostDispatcherHandlers } from './host-dispatcher.js';
import type { InputEnvelope, ProgramArtifact } from './quickjs-runtime.js';

const TEST_GAS_LIMIT = 50_000n;

const BASE_PROGRAM: ProgramArtifact = {
  code: 'document("path/to/doc")',
  abiId: 'Host.v1',
  abiVersion: 1,
  abiManifestHash: HOST_V1_HASH,
};

const BASE_INPUT: InputEnvelope = {
  event: { type: 'create', payload: { id: 1 } },
  eventCanonical: { type: 'create', payload: { id: 1 } },
  steps: [{ name: 'first' }],
  document: {
    id: 'doc-1',
    hash: HOST_V1_HASH,
    epoch: 1,
  },
  hostContext: { requestId: 'req-1' },
};

describe('evaluate', () => {
  it('returns DV results with gas accounting', async () => {
    const handlers = createHandlers();
    const result = await evaluate({
      program: BASE_PROGRAM,
      input: BASE_INPUT,
      gasLimit: TEST_GAS_LIMIT,
      manifest: HOST_V1_MANIFEST,
      handlers,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(result.value).toEqual({ path: 'path/to/doc' });
    expect(typeof result.gasUsed).toBe('bigint');
    expect(typeof result.gasRemaining).toBe('bigint');
    expect(handlers.document.get).toHaveBeenCalledTimes(1);
  });

  it('maps VM errors to a structured failure', async () => {
    const handlers = createHandlers();
    const result = await evaluate({
      program: { ...BASE_PROGRAM, code: 'document(123)' },
      input: BASE_INPUT,
      gasLimit: TEST_GAS_LIMIT,
      manifest: HOST_V1_MANIFEST,
      handlers,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected VM failure');
    }
    expect(result.type).toBe('vm-error');
    expect(result.error.kind).toBe('js-exception');
    expect(result.error.code).toBe('JS_EXCEPTION');
    expect(result.error.message).toMatch(/document/i);
    expect(handlers.document.get).not.toHaveBeenCalled();
  });

  it('treats non-JSON payloads as invalid outputs', async () => {
    const result = await evaluate({
      program: { ...BASE_PROGRAM, code: 'void 0' },
      input: BASE_INPUT,
      gasLimit: TEST_GAS_LIMIT,
      manifest: HOST_V1_MANIFEST,
      handlers: createHandlers(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected invalid output');
    }

    expect(result.type).toBe('invalid-output');
    expect(result.error.code).toBe('INVALID_OUTPUT');
    expect(result.message).toMatch(/non-JSON/i);
  });

  it('maps HostError failures to code/tag using the manifest', async () => {
    const handlers = createHandlers({
      document: {
        get: vi.fn(() => ({
          err: { code: 'NOT_FOUND', tag: 'host/not_found' },
          units: 2,
        })),
      },
    });

    const result = await evaluate({
      program: BASE_PROGRAM,
      input: BASE_INPUT,
      gasLimit: TEST_GAS_LIMIT,
      manifest: HOST_V1_MANIFEST,
      handlers,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected host error');
    }

    expect(result.type).toBe('vm-error');
    expect(result.error.kind).toBe('host-error');
    if (result.error.kind !== 'host-error') {
      throw new Error('expected host-error');
    }
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.tag).toBe('host/not_found');
  });

  it('surfaces OutOfGas as a stable code/tag', async () => {
    const result = await evaluate({
      program: { ...BASE_PROGRAM, code: 'let n = 0; while (true) { n += 1; }' },
      input: BASE_INPUT,
      gasLimit: 50n,
      manifest: HOST_V1_MANIFEST,
      handlers: createHandlers(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected OOG');
    }

    expect(result.type).toBe('vm-error');
    expect(result.error.kind).toBe('out-of-gas');
    if (result.error.kind !== 'out-of-gas') {
      throw new Error('expected out-of-gas');
    }
    expect(result.error.code).toBe('OOG');
    expect(result.error.tag).toBe('vm/out_of_gas');
  });

  it('rejects engine build hash mismatches', async () => {
    const program: ProgramArtifact = {
      ...BASE_PROGRAM,
      engineBuildHash: '0'.repeat(64),
    };

    await expect(
      evaluate({
        program,
        input: BASE_INPUT,
        gasLimit: TEST_GAS_LIMIT,
        manifest: HOST_V1_MANIFEST,
        handlers: createHandlers(),
      }),
    ).rejects.toThrow(/enginebuildhash/i);
  });

  it('returns host-call tape when requested', async () => {
    const result = await evaluate({
      program: BASE_PROGRAM,
      input: BASE_INPUT,
      gasLimit: TEST_GAS_LIMIT,
      manifest: HOST_V1_MANIFEST,
      handlers: createHandlers(),
      tape: { capacity: 8 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(result.tape).toBeDefined();
    expect(result.tape?.length).toBeGreaterThan(0);
    const [record] = result.tape ?? [];
    expect(record.fnId).toBe(getFnId('document.get'));
    expect(typeof record.gasPre).toBe('bigint');
    expect(typeof record.gasPost).toBe('bigint');
    expect(record.reqHash).toHaveLength(64);
    expect(record.respHash).toHaveLength(64);
  });

  it('returns gas trace when requested', async () => {
    const result = await evaluate({
      program: { ...BASE_PROGRAM, code: '1 + 2' },
      input: BASE_INPUT,
      gasLimit: TEST_GAS_LIMIT,
      manifest: HOST_V1_MANIFEST,
      handlers: createHandlers(),
      gasTrace: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(result.gasTrace).toBeDefined();
    expect((result.gasTrace?.opcodeCount ?? 0n) >= 0n).toBe(true);
    expect((result.gasTrace?.allocationBytes ?? 0n) >= 0n).toBe(true);
  });
});

function createHandlers(
  overrides?: Partial<{
    document: Partial<HostDispatcherHandlers['document']>;
    emit: HostDispatcherHandlers['emit'];
  }>,
): HostDispatcherHandlers {
  return {
    document: {
      get:
        overrides?.document?.get ??
        vi.fn((path: string) => ({ ok: { path }, units: 5 })),
      getCanonical:
        overrides?.document?.getCanonical ??
        vi.fn((path: string) => ({ ok: { canonical: path }, units: 3 })),
    },
    emit:
      overrides?.emit ??
      vi.fn(() => ({
        ok: null,
        units: 1,
      })),
  };
}

function getFnId(path: string): number {
  const fn = HOST_V1_MANIFEST.functions.find(
    (entry) => entry.js_path.join('.') === path,
  );
  if (!fn) {
    throw new Error(`missing fn_id for ${path}`);
  }
  return fn.fn_id;
}

import { decodeDv, encodeDv } from '@blue-quickjs/dv';
import {
  DETERMINISM_INPUT,
  HOST_V1_HASH,
  HOST_V1_MANIFEST,
  hexToBytes,
  parseDeterministicOutput,
} from '@blue-quickjs/test-harness';
import { type HostDispatcherHandlers } from './host-dispatcher.js';
import { initializeDeterministicVm } from './deterministic-init.js';
import { createRuntime } from './runtime.js';

describe('createRuntime', () => {
  it('instantiates the wasm module and evaluates code', async () => {
    const runtime = await createRuntime({
      manifest: HOST_V1_MANIFEST,
      handlers: createHandlers(),
    });

    const vm = initializeDeterministicVm(
      runtime,
      PROGRAM,
      DETERMINISM_INPUT,
      500n,
    );
    const output = vm.eval(PROGRAM.code);
    const parsed = parseDeterministicOutput(output);
    expect(parsed.kind).toBe('RESULT');
    expect(parsed.gasUsed > 0n).toBe(true);
    expect(parsed.gasRemaining >= 0n).toBe(true);
    expect(decodeDv(hexToBytes(parsed.payload))).toBe(3);
    vm.dispose();
  });

  it('wires host_call to the manifest-backed dispatcher', async () => {
    const handlers = createHandlers();
    const runtime = await createRuntime({
      manifest: HOST_V1_MANIFEST,
      handlers,
    });

    const requestBytes = encodeDv(['path/to/doc']);
    const reqPtr = runtime.module._malloc(requestBytes.length);
    const respPtr = runtime.module._malloc(512);

    const heap = new Uint8Array(runtime.module.HEAPU8.buffer);
    heap.subarray(reqPtr, reqPtr + requestBytes.length).set(requestBytes);

    const written = runtime.hostCall(
      DOC_GET_ID,
      reqPtr,
      requestBytes.length,
      respPtr,
      512,
    );
    expect(typeof written).toBe('number');
    expect(written).toBeGreaterThan(0);

    const envelope = decodeDv(
      heap.subarray(respPtr, respPtr + Number(written)),
    ) as {
      ok?: unknown;
      units: number;
    };

    expect(envelope).toEqual({
      ok: { path: 'path/to/doc' },
      units: 5,
    });
    expect(handlers.document.get).toHaveBeenCalledTimes(1);

    runtime.module._free(reqPtr);
    runtime.module._free(respPtr);
  });
});

const DOC_GET_ID = getFnId('document.get');
const PROGRAM = {
  code: '(() => 1 + 2)()',
  abiId: 'Host.v1',
  abiVersion: 1,
  abiManifestHash: HOST_V1_HASH,
};

function createHandlers(
  overrides?: Partial<HostDispatcherHandlers>,
): HostDispatcherHandlers {
  return {
    document: {
      get:
        overrides?.document?.get ??
        vi.fn((path: string) => ({
          ok: { path },
          units: 5,
        })),
      getCanonical:
        overrides?.document?.getCanonical ??
        vi.fn((path: string) => ({
          ok: { canonical: path },
          units: 3,
        })),
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

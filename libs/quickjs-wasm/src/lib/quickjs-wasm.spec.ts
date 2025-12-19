import {
  getQuickjsWasmArtifact,
  listAvailableQuickjsWasmBuildTargets,
  loadQuickjsWasmBinary,
  loadQuickjsWasmLoaderSource,
  loadQuickjsWasmMetadata,
} from './quickjs-wasm.js';
import { decodeDv, encodeDv } from '@blue-quickjs/dv';
import {
  DETERMINISM_INPUT,
  HOST_V1_BYTES,
  HOST_V1_HASH,
  hexToBytes,
  parseDeterministicOutput,
} from '@blue-quickjs/test-harness';
import {
  type WasmModuleWithCwrap,
  readCString,
  writeBytes,
  writeCString,
  type WasmPtr,
} from '@blue-quickjs/test-harness';

const WASM_MAGIC_HEADER = [0x00, 0x61, 0x73, 0x6d];
const HOST_TRANSPORT_SENTINEL = 0xffffffff >>> 0;
const CONTEXT_BLOB = encodeDv({
  event: DETERMINISM_INPUT.event,
  eventCanonical: DETERMINISM_INPUT.eventCanonical,
  steps: DETERMINISM_INPUT.steps,
});

type HarnessResultKind = 'RESULT' | 'ERROR';

interface HarnessResult {
  kind: HarnessResultKind;
  payload: string;
  gasRemaining: bigint;
  gasUsed: bigint;
}

describe('quickjs wasm artifacts', () => {
  it('exposes build metadata with at least one variant', async () => {
    const metadata = await loadQuickjsWasmMetadata();
    expect(metadata.quickjsVersion).toBeTruthy();
    expect(Object.keys(metadata.variants ?? {})).not.toHaveLength(0);
  });

  it('loads wasm bytes for each available variant', async () => {
    const metadata = await loadQuickjsWasmMetadata();
    const targets = listAvailableQuickjsWasmBuildTargets(metadata);
    expect(targets.length).toBeGreaterThan(0);

    for (const { variant, buildType } of targets) {
      const bytes = await loadQuickjsWasmBinary(variant, buildType, metadata);
      expect(bytes.length).toBeGreaterThan(WASM_MAGIC_HEADER.length);
      expect(Array.from(bytes.slice(0, WASM_MAGIC_HEADER.length))).toEqual(
        WASM_MAGIC_HEADER,
      );
    }
  });

  it('resolves loader source for each available variant', async () => {
    const metadata = await loadQuickjsWasmMetadata();
    const targets = listAvailableQuickjsWasmBuildTargets(metadata);
    expect(targets.length).toBeGreaterThan(0);

    for (const { variant, buildType } of targets) {
      const artifact = await getQuickjsWasmArtifact(
        variant,
        buildType,
        metadata,
      );
      const loaderSource = await loadQuickjsWasmLoaderSource(
        variant,
        buildType,
        metadata,
      );
      expect(loaderSource.length).toBeGreaterThan(0);
      expect(loaderSource).toContain('host_call');
      expect(artifact.variantMetadata.engineBuildHash).toBeTruthy();
      expect(artifact.variantMetadata.buildType).toBe(buildType);
    }
  });

  it('evaluates a sample program for each available build target', async () => {
    const metadata = await loadQuickjsWasmMetadata();
    const targets = listAvailableQuickjsWasmBuildTargets(metadata);
    expect(targets.length).toBeGreaterThan(0);

    const baselineByVariant = new Map<string, HarnessResult>();

    for (const { variant, buildType } of targets) {
      const artifact = await getQuickjsWasmArtifact(
        variant,
        buildType,
        metadata,
      );
      const { default: moduleFactory } = await import(artifact.loaderUrl.href);
      const module = await moduleFactory({
        thisProgram: 'thisProgram',
        arguments: [],
        host: {
          host_call: () => HOST_TRANSPORT_SENTINEL,
        },
      });
      const { init, evalFn, freeRuntime, malloc, free, readCString } =
        createDeterministicFns(module, variant);

      const manifestPtr = writeBytes(module, malloc, HOST_V1_BYTES);
      const contextPtr =
        CONTEXT_BLOB.length > 0 ? writeBytes(module, malloc, CONTEXT_BLOB) : 0;
      const hashPtr = writeCStringWithVariant(
        HOST_V1_HASH,
        malloc,
        module,
        variant,
      );
      if (typeof manifestPtr === 'number') {
        new Uint8Array(
          module.HEAPU8.buffer,
          manifestPtr,
          HOST_V1_BYTES.length,
        ).set(HOST_V1_BYTES);
      } else {
        new Uint8Array(
          module.HEAPU8.buffer,
          Number(manifestPtr),
          HOST_V1_BYTES.length,
        ).set(HOST_V1_BYTES);
      }
      if (contextPtr) {
        if (typeof contextPtr === 'number') {
          new Uint8Array(
            module.HEAPU8.buffer,
            contextPtr,
            CONTEXT_BLOB.length,
          ).set(CONTEXT_BLOB);
        } else {
          new Uint8Array(
            module.HEAPU8.buffer,
            Number(contextPtr),
            CONTEXT_BLOB.length,
          ).set(CONTEXT_BLOB);
        }
      }

      try {
        const errorPtr = init(
          manifestPtr,
          HOST_V1_BYTES.length,
          hashPtr,
          contextPtr,
          CONTEXT_BLOB.length,
          500n,
        );
        if (errorPtr !== 0) {
          const message = readCString(errorPtr);
          free(errorPtr);
          throw new Error(`init failed: ${message}`);
        }

        const resultPtr = evalFn('1 + 2');
        const parsed = parseDeterministicOutput(readCString(resultPtr));
        free(resultPtr);

        expect(parsed.kind).toBe('RESULT');
        expect(decodeDv(hexToBytes(parsed.payload))).toBe(3);

        const baseline = baselineByVariant.get(variant);
        if (baseline) {
          expect(parsed.payload).toBe(baseline.payload);
          expect(parsed.kind).toBe(baseline.kind);
          expect(parsed.gasRemaining).toBe(baseline.gasRemaining);
          expect(parsed.gasUsed).toBe(baseline.gasUsed);
        } else {
          baselineByVariant.set(variant, parsed);
        }
      } finally {
        free(manifestPtr);
        free(hashPtr);
        if (contextPtr) {
          free(contextPtr);
        }
        freeRuntime();
      }
    }
  });
});

function createDeterministicFns(module: WasmModuleWithCwrap, variant: string) {
  const ptrType = variant === 'wasm64' ? 'bigint' : 'number';
  const init = module.cwrap('qjs_det_init', ptrType, [
    ptrType,
    'number',
    ptrType,
    ptrType,
    'number',
    'bigint',
  ]) as (
    manifestPtr: WasmPtr,
    manifestSize: number,
    hashPtr: WasmPtr,
    contextPtr: WasmPtr,
    contextSize: number,
    gasLimit: bigint,
  ) => WasmPtr;
  const evalFn = module.cwrap('qjs_det_eval', ptrType, ['string']) as (
    code: string,
  ) => WasmPtr;
  const freeRuntime = module.cwrap('qjs_det_free', null, []) as () => void;
  const malloc = module.cwrap('malloc', ptrType, ['number']) as (
    size: number,
  ) => WasmPtr;
  const free = module.cwrap('free', null, [ptrType]) as (ptr: WasmPtr) => void;

  const readCStringBound = (ptr: WasmPtr) => readCString(module, ptr);

  return {
    init,
    evalFn,
    freeRuntime,
    malloc,
    free,
    readCString: readCStringBound,
  };
}

function writeCStringWithVariant(
  value: string,
  malloc: (size: number) => WasmPtr,
  module: WasmModuleWithCwrap,
  variant: string,
): WasmPtr {
  const ptr = writeCString(module, malloc, value);
  return variant === 'wasm64' ? BigInt(ptr) : ptr;
}

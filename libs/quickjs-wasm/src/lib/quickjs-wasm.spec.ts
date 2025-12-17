import {
  getQuickjsWasmArtifact,
  listAvailableQuickjsWasmBuildTargets,
  loadQuickjsWasmBinary,
  loadQuickjsWasmLoaderSource,
  loadQuickjsWasmMetadata,
} from './quickjs-wasm.js';

const WASM_MAGIC_HEADER = [0x00, 0x61, 0x73, 0x6d];
const HOST_TRANSPORT_SENTINEL = 0xffffffff >>> 0;

type HarnessResultKind = 'RESULT' | 'ERROR';

interface HarnessResult {
  kind: HarnessResultKind;
  message: string;
  gasRemaining: number;
  gasUsed: number;
}

function parseHarnessOutput(output: string): HarnessResult {
  const trimmed = output.trim();
  const match =
    /^(RESULT|ERROR)\s+(.*?)\s+GAS\s+remaining=(\d+)\s+used=(\d+)/.exec(
      trimmed,
    );
  if (!match) {
    throw new Error(`Unable to parse harness output: ${trimmed}`);
  }
  const [, kind, message, remaining, used] = match;
  return {
    kind: kind as HarnessResultKind,
    message,
    gasRemaining: Number(remaining),
    gasUsed: Number(used),
  };
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
      const ptrReturnType = variant === 'wasm64' ? 'bigint' : 'number';
      const ptrArgType = variant === 'wasm64' ? 'bigint' : 'number';
      const evalFn = module.cwrap('qjs_eval', ptrReturnType, [
        'string',
        'bigint',
      ]);
      const freeFn = module.cwrap('qjs_free_output', null, [ptrArgType]);
      const ptr = evalFn('1 + 2', BigInt(500));
      const ptrNumber =
        typeof ptr === 'bigint'
          ? Number(ptr <= BigInt(Number.MAX_SAFE_INTEGER) ? ptr : BigInt(0))
          : ptr;
      if (typeof ptr === 'bigint' && ptr > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Pointer exceeds JS safe integer range');
      }
      const raw = module.UTF8ToString(ptrNumber);
      freeFn(ptr);

      const parsed = parseHarnessOutput(raw);
      expect(parsed.kind).toBe('RESULT');
      expect(parsed.message).toBe('3');

      const baseline = baselineByVariant.get(variant);
      if (baseline) {
        expect(parsed.message).toBe(baseline.message);
        expect(parsed.kind).toBe(baseline.kind);
        expect(parsed.gasRemaining).toBe(baseline.gasRemaining);
        expect(parsed.gasUsed).toBe(baseline.gasUsed);
      } else {
        baselineByVariant.set(variant, parsed);
      }
    }
  });
});

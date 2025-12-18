import { encodeDv, decodeDv } from '@blue-quickjs/dv';
import { HOST_V1_MANIFEST } from '@blue-quickjs/test-harness';
import {
  type DocumentHostHandlers,
  type EmitHostHandler,
  type HostDispatchResult,
  type HostDispatcher,
  type HostCallMemory,
  createHostCallImport,
  createHostDispatcher,
} from './host-dispatcher.js';

const DOC_GET_ID = getFnId('document.get');
const DOC_GET_CANONICAL_ID = getFnId('document.getCanonical');
const EMIT_ID = getFnId('emit');
const UINT32_MAX = 0xffffffff;

describe('host dispatcher', () => {
  it('dispatches document.get successfully', () => {
    const handlers = createHandlers();
    const dispatcher = createHostDispatcher(HOST_V1_MANIFEST, handlers);

    const request = encodeDv(['path/to/doc']);
    const result = dispatcher.dispatch(DOC_GET_ID, request);
    const envelope = expectResponse(result);

    expect(envelope).toEqual({
      ok: { path: 'path/to/doc' },
      units: 5,
    });
    expect(handlers.document.get).toHaveBeenCalledTimes(1);
  });

  it('surface host errors from handlers deterministically', () => {
    const handlers = createHandlers({
      get: () => ({
        err: { code: 'NOT_FOUND', tag: 'host/not_found', details: 'missing' },
        units: 2,
      }),
    });
    const dispatcher = createHostDispatcher(HOST_V1_MANIFEST, handlers);

    const result = dispatcher.dispatch(DOC_GET_ID, encodeDv(['missing/path']));
    const envelope = expectResponse(result);

    expect(envelope).toEqual({
      err: { code: 'NOT_FOUND', details: 'missing' },
      units: 2,
    });
  });

  it('enforces arg utf8 limits before invoking handlers', () => {
    const handlers = createHandlers();
    const dispatcher = createHostDispatcher(HOST_V1_MANIFEST, handlers);
    const longPath = 'x'.repeat(3000);

    const result = dispatcher.dispatch(DOC_GET_ID, encodeDv([longPath]));
    const envelope = expectResponse(result);

    expect(handlers.document.get).not.toHaveBeenCalled();
    expect(envelope).toEqual({
      err: { code: 'LIMIT_EXCEEDED' },
      units: 0,
    });
  });

  it('returns fatal on unknown fn_id', () => {
    const handlers = createHandlers();
    const dispatcher = createHostDispatcher(HOST_V1_MANIFEST, handlers);
    const result = dispatcher.dispatch(999, encodeDv(['ignored']));

    const fatal = expectFatal(result);
    expect(fatal.error.code).toBe('UNKNOWN_FUNCTION');
  });

  it('returns a limit error when handler units exceed manifest bounds', () => {
    const handlers = createHandlers({
      getCanonical: () => ({
        ok: { canonical: true },
        units: 10_000,
      }),
    });
    const dispatcher = createHostDispatcher(HOST_V1_MANIFEST, handlers);

    const result = dispatcher.dispatch(
      DOC_GET_CANONICAL_ID,
      encodeDv(['path']),
    );
    const envelope = expectResponse(result);

    expect(envelope).toEqual({
      err: { code: 'LIMIT_EXCEEDED' },
      units: 0,
    });
  });

  it('validates emit return_schema null', () => {
    const handlers = createHandlers({
      emit: () => ({ ok: 'not-null' as never, units: 1 }),
    });
    const dispatcher = createHostDispatcher(HOST_V1_MANIFEST, handlers);

    const result = dispatcher.dispatch(EMIT_ID, encodeDv(['value']));
    const fatal = expectFatal(result);
    expect(fatal.error.code).toBe('HANDLER_ERROR');
  });

  it('adapts to wasm host_call import and writes response bytes', () => {
    const handlers = createHandlers();
    const dispatcher = createHostDispatcher(HOST_V1_MANIFEST, handlers);
    const memory = createMemory();
    const hostCall = createHostCallImport(dispatcher, memory);

    const request = encodeDv(['path/to/doc']);
    const reqPtr = 64;
    const respPtr = 256;
    const respCap = 512;
    const mem = new Uint8Array(memory.buffer);
    mem.subarray(reqPtr, reqPtr + request.length).set(request);

    const written = hostCall(
      DOC_GET_ID,
      reqPtr,
      request.length,
      respPtr,
      respCap,
    );
    expect(written).toBeGreaterThan(0);

    const envelope = decodeDv(mem.subarray(respPtr, respPtr + written)) as {
      ok?: unknown;
      units: number;
    };
    expect(envelope).toEqual({ ok: { path: 'path/to/doc' }, units: 5 });
  });

  it('returns transport sentinel on overlapping request/response ranges', () => {
    const handlers = createHandlers();
    const dispatcher = createHostDispatcher(HOST_V1_MANIFEST, handlers);
    const memory = createMemory();
    const hostCall = createHostCallImport(dispatcher, memory);

    const request = encodeDv(['path/to/doc']);
    const reqPtr = 64;
    const reqLen = request.length;
    const respPtr = reqPtr + reqLen - 1;
    const respCap = 128;
    const mem = new Uint8Array(memory.buffer);
    mem.subarray(reqPtr, reqPtr + reqLen).set(request);

    const written = hostCall(DOC_GET_ID, reqPtr, reqLen, respPtr, respCap);
    expect(written).toBe(UINT32_MAX);
  });

  it('returns transport sentinel for unknown fn_id', () => {
    const dispatcher = createHostDispatcher(HOST_V1_MANIFEST, createHandlers());
    const memory = createMemory();
    const hostCall = createHostCallImport(dispatcher, memory);

    const request = encodeDv(['ignored']);
    const mem = new Uint8Array(memory.buffer);
    mem.subarray(0, request.length).set(request);

    const written = hostCall(999, 0, request.length, 128, 256);
    expect(written).toBe(UINT32_MAX);
  });

  it('guards against reentrancy', () => {
    const memory = createMemory();
    const mem = new Uint8Array(memory.buffer);
    const request = encodeDv(['path']);
    mem.subarray(0, request.length).set(request);

    const dispatcher: HostDispatcher = {
      manifest: HOST_V1_MANIFEST,
      dispatch: vi.fn((fnId, reqBytes): HostDispatchResult => {
        expect(fnId).toBe(DOC_GET_ID);
        expect(Array.from(reqBytes)).toEqual(Array.from(request));
        const sentinel = hostCall(DOC_GET_ID, 0, request.length, 256, 512);
        expect(sentinel).toBe(UINT32_MAX);
        return {
          kind: 'response',
          envelope: encodeDv({ ok: null, units: 0 }),
        };
      }),
    };

    const hostCall = createHostCallImport(dispatcher, memory);
    const written = hostCall(DOC_GET_ID, 0, request.length, 64, 128);
    expect(written).toBeGreaterThan(0);
  });
});

function expectResponse(result: HostDispatchResult): {
  ok?: unknown;
  err?: unknown;
  units: number;
} {
  expect(result.kind).toBe('response');
  return decodeDv(
    (result as Extract<typeof result, { kind: 'response' }>).envelope,
  ) as {
    ok?: unknown;
    err?: unknown;
    units: number;
  };
}

function expectFatal(
  result: HostDispatchResult,
): Extract<HostDispatchResult, { kind: 'fatal' }> {
  expect(result.kind).toBe('fatal');
  return result as Extract<HostDispatchResult, { kind: 'fatal' }>;
}

function createHandlers(
  overrides?: Partial<{
    get: DocumentHostHandlers['get'];
    getCanonical: DocumentHostHandlers['getCanonical'];
    emit: EmitHostHandler['emit'];
  }>,
) {
  return {
    document: {
      get:
        overrides?.get ?? vi.fn((path: string) => ({ ok: { path }, units: 5 })),
      getCanonical:
        overrides?.getCanonical ??
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

function createMemory(): HostCallMemory {
  const WebAssemblyMemory = (
    globalThis as {
      WebAssembly?: {
        Memory?: new (opts: { initial: number }) => HostCallMemory;
      };
    }
  ).WebAssembly?.Memory;
  if (!WebAssemblyMemory) {
    throw new Error('WebAssembly.Memory is not available in this environment');
  }
  return new WebAssemblyMemory({ initial: 1 });
}

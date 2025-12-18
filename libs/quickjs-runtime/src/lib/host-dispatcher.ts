import {
  type AbiFunction,
  type AbiManifest,
  type CanonicalAbiManifest,
  validateAbiManifest,
} from '@blue-quickjs/abi-manifest';
import {
  type DV,
  DV_LIMIT_DEFAULTS,
  type DvLimits,
  DvError,
  decodeDv,
  encodeDv,
  validateDv,
} from '@blue-quickjs/dv';

const UINT32_MAX = 0xffffffff;
const UTF8 = new TextEncoder();

export interface HostCallError {
  code: string;
  tag: string;
  details?: DV;
}

export type HostCallResult<T extends DV | null = DV> =
  | { ok: T; units: number }
  | { err: HostCallError; units: number };

export interface DocumentHostHandlers {
  get(path: string): HostCallResult<DV>;
  getCanonical(path: string): HostCallResult<DV>;
}

export interface EmitHostHandler {
  emit(value: DV): HostCallResult<null>;
}

export interface HostDispatcherHandlers {
  document: DocumentHostHandlers;
  emit?: EmitHostHandler['emit'];
}

export interface HostDispatcherOptions {
  /**
   * Override DV limits applied to request decoding and response encoding.
   */
  dvLimits?: Partial<DvLimits>;
  /**
   * Enforce a specific ABI identity (defaults to Host.v1) to avoid pairing the
   * dispatcher with a mismatched manifest.
   */
  expectedAbiId?: string;
  expectedAbiVersion?: number;
}

export type HostDispatchResult =
  | { kind: 'response'; envelope: Uint8Array }
  | { kind: 'fatal'; error: HostDispatcherError };

export type HostDispatcherErrorCode =
  | 'UNKNOWN_FUNCTION'
  | 'INVALID_REQUEST'
  | 'INVALID_ARGUMENTS'
  | 'HANDLER_ERROR'
  | 'RESPONSE_LIMIT';

export class HostDispatcherError extends Error {
  constructor(
    public readonly code: HostDispatcherErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HostDispatcherError';
  }
}

export interface HostDispatcher {
  readonly manifest: CanonicalAbiManifest;
  dispatch(
    fnId: number,
    requestBytes: ArrayBufferView | ArrayBuffer,
  ): HostDispatchResult;
}

export interface HostCallMemory {
  buffer: ArrayBuffer;
}

export type HostCallImport = (
  fnId: number,
  reqPtr: number,
  reqLen: number,
  respPtr: number,
  respCap: number,
) => number;

export function createHostDispatcher(
  manifest: AbiManifest,
  handlers: HostDispatcherHandlers,
  options?: HostDispatcherOptions,
): HostDispatcher {
  const canonical = validateAbiManifest(manifest);
  const expectedAbiId = options?.expectedAbiId ?? 'Host.v1';
  const expectedAbiVersion = options?.expectedAbiVersion ?? 1;
  if (canonical.abi_id !== expectedAbiId) {
    throw new HostDispatcherError(
      'INVALID_REQUEST',
      `manifest abi_id mismatch: expected ${expectedAbiId}, received ${canonical.abi_id}`,
    );
  }
  if (canonical.abi_version !== expectedAbiVersion) {
    throw new HostDispatcherError(
      'INVALID_REQUEST',
      `manifest abi_version mismatch: expected ${expectedAbiVersion}, received ${canonical.abi_version}`,
    );
  }

  const dvLimits = normalizeDvLimits(options?.dvLimits);
  const bindings = buildBindings(canonical.functions, handlers);

  return {
    manifest: canonical,
    dispatch(
      fnId: number,
      requestBytes: ArrayBufferView | ArrayBuffer,
    ): HostDispatchResult {
      const normalizedFnId = toUint32(fnId);
      const binding = bindings.get(normalizedFnId);
      if (!binding) {
        return fatal('UNKNOWN_FUNCTION', `unknown fn_id ${normalizedFnId}`);
      }

      const request = asUint8Array(requestBytes);
      if (request.length > binding.fn.limits.max_request_bytes) {
        if (binding.limitExceededEnvelope) {
          return encodeEnvelope(
            binding.fn,
            binding.limitExceededEnvelope,
            dvLimits,
          );
        }
        return fatalLimitError(binding.fn);
      }

      const decodeLimits = {
        ...dvLimits,
        maxEncodedBytes: Math.min(
          dvLimits.maxEncodedBytes,
          binding.fn.limits.max_request_bytes,
        ),
      };

      let args: DV;
      try {
        args = decodeDv(request, { limits: decodeLimits });
      } catch (err) {
        return fatal(
          'INVALID_REQUEST',
          `failed to decode request for fn_id=${normalizedFnId}: ${stringifyError(err)}`,
          err,
        );
      }

      if (!Array.isArray(args)) {
        return fatal(
          'INVALID_ARGUMENTS',
          `request for fn_id=${normalizedFnId} must be a DV array`,
        );
      }
      if (args.length !== binding.fn.arity) {
        return fatal(
          'INVALID_ARGUMENTS',
          `fn_id=${normalizedFnId} expected ${binding.fn.arity} args, received ${args.length}`,
        );
      }

      try {
        return binding.dispatch(args, dvLimits);
      } catch (err) {
        return fatal(
          'HANDLER_ERROR',
          `fn_id=${normalizedFnId} handler threw: ${stringifyError(err)}`,
          err,
        );
      }
    },
  };
}

export function createHostCallImport(
  dispatcher: HostDispatcher,
  memory: HostCallMemory,
): HostCallImport {
  let inProgress = false;
  return (fnId, reqPtr, reqLen, respPtr, respCap) => {
    if (inProgress) {
      return UINT32_MAX;
    }
    inProgress = true;
    try {
      const mem = new Uint8Array(memory.buffer);
      const reqOffset = toUint32(reqPtr);
      const reqLength = toUint32(reqLen);
      const respOffset = toUint32(respPtr);
      const respCapacity = toUint32(respCap);
      const fn = toUint32(fnId);

      if (
        !withinBounds(mem, reqOffset, reqLength) ||
        !withinBounds(mem, respOffset, respCapacity)
      ) {
        return UINT32_MAX;
      }
      if (rangesOverlap(reqOffset, reqLength, respOffset, respCapacity)) {
        return UINT32_MAX;
      }

      const request = mem.subarray(reqOffset, reqOffset + reqLength);
      const result = dispatcher.dispatch(fn, request);
      if (result.kind === 'fatal') {
        return UINT32_MAX;
      }

      if (result.envelope.length > respCapacity) {
        return UINT32_MAX;
      }

      mem
        .subarray(respOffset, respOffset + result.envelope.length)
        .set(result.envelope);
      return result.envelope.length >>> 0;
    } catch {
      return UINT32_MAX;
    } finally {
      inProgress = false;
    }
  };
}

type HostFunctionBinding = {
  fn: CanonicalFunction;
  dispatch(args: DV[], dvLimits: DvLimits): HostDispatchResult;
  limitExceededEnvelope?: HostResponseEnvelope;
};

type CanonicalFunction = AbiFunction & {
  errorTagMap: Map<string, string>;
};

type HostResponseEnvelope =
  | { ok: DV; units: number }
  | { err: { code: string; details?: DV }; units: number };

function buildBindings(
  functions: AbiFunction[],
  handlers: HostDispatcherHandlers,
): Map<number, HostFunctionBinding> {
  const bindings = new Map<number, HostFunctionBinding>();
  const byPath = new Map<string, CanonicalFunction>();
  for (const fn of functions) {
    const canonical = withErrorTags(fn);
    byPath.set(canonical.js_path.join('.'), canonical);
  }

  const documentGet = byPath.get('document.get');
  const documentGetCanonical = byPath.get('document.getCanonical');
  if (!documentGet || !documentGetCanonical) {
    throw new HostDispatcherError(
      'INVALID_REQUEST',
      'Host.v1 manifest must include document.get and document.getCanonical',
    );
  }

  const emitFn = byPath.get('emit');
  if (emitFn && !handlers.emit) {
    throw new HostDispatcherError(
      'INVALID_REQUEST',
      'manifest declares emit but no emit handler was provided',
    );
  }
  if (!emitFn && handlers.emit) {
    throw new HostDispatcherError(
      'INVALID_REQUEST',
      'emit handler provided but manifest does not declare emit',
    );
  }

  bindings.set(
    documentGet.fn_id,
    buildDocumentBinding(documentGet, handlers.document.get),
  );
  bindings.set(
    documentGetCanonical.fn_id,
    buildDocumentBinding(documentGetCanonical, handlers.document.getCanonical),
  );

  if (emitFn && handlers.emit) {
    bindings.set(emitFn.fn_id, buildEmitBinding(emitFn, handlers.emit));
  }

  if (functions.length !== bindings.size) {
    const knownIds = [...bindings.keys()].sort((a, b) => a - b).join(', ');
    const manifestIds = functions.map((fn) => fn.fn_id).sort((a, b) => a - b);
    throw new HostDispatcherError(
      'INVALID_REQUEST',
      `dispatcher does not implement all manifest functions (implemented: ${knownIds}; manifest: ${manifestIds.join(', ')})`,
    );
  }

  return bindings;
}

function buildDocumentBinding(
  fn: CanonicalFunction,
  handler: DocumentHostHandlers['get'],
): HostFunctionBinding {
  assertDocumentShape(fn);
  const limitExceededEnvelope = createLimitEnvelope(fn);
  return {
    fn,
    limitExceededEnvelope,
    dispatch(args: DV[], dvLimits: DvLimits): HostDispatchResult {
      const [path] = args;
      if (typeof path !== 'string') {
        return fatal(
          'INVALID_ARGUMENTS',
          `fn_id=${fn.fn_id} expected string path argument`,
        );
      }

      const utf8Max = fn.limits.arg_utf8_max?.[0];
      if (utf8Max !== undefined) {
        const byteLen = UTF8.encode(path).byteLength;
        if (byteLen > utf8Max) {
          if (limitExceededEnvelope) {
            return encodeEnvelope(fn, limitExceededEnvelope, dvLimits);
          }
          return fatal(
            'INVALID_ARGUMENTS',
            `fn_id=${fn.fn_id} path exceeds utf8 limit (${byteLen} > ${utf8Max})`,
          );
        }
      }

      const result = handler(path);
      return encodeResult(fn, result, dvLimits, limitExceededEnvelope);
    },
  };
}

function buildEmitBinding(
  fn: CanonicalFunction,
  handler: EmitHostHandler['emit'],
): HostFunctionBinding {
  assertEmitShape(fn);
  const limitExceededEnvelope = createLimitEnvelope(fn);
  return {
    fn,
    limitExceededEnvelope,
    dispatch(args: DV[], dvLimits: DvLimits): HostDispatchResult {
      const [value] = args;
      const result = handler(value);
      return encodeResult(fn, result, dvLimits, limitExceededEnvelope);
    },
  };
}

function encodeResult(
  fn: CanonicalFunction,
  result: HostCallResult,
  dvLimits: DvLimits,
  limitExceededEnvelope?: HostResponseEnvelope,
): HostDispatchResult {
  if (result === null || typeof result !== 'object') {
    return fatal('HANDLER_ERROR', `fn_id=${fn.fn_id} returned invalid result`);
  }

  const hasOk = 'ok' in result;
  const hasErr = 'err' in result;
  if (hasOk === hasErr) {
    return fatal(
      'HANDLER_ERROR',
      `fn_id=${fn.fn_id} result must contain exactly one of ok or err`,
    );
  }

  if (!('units' in result)) {
    return fatal('HANDLER_ERROR', `fn_id=${fn.fn_id} result.units is required`);
  }

  let units: number | null;
  try {
    units = normalizeUint(
      (result as { units: unknown }).units,
      fn.limits.max_units,
      'result.units',
      !!limitExceededEnvelope,
    );
  } catch (err) {
    if (err instanceof HostDispatcherError) {
      return fatal(err.code, err.message, err);
    }
    throw err;
  }
  if (units === null) {
    if (limitExceededEnvelope) {
      return encodeEnvelope(fn, limitExceededEnvelope, dvLimits);
    }
    return fatal(
      'INVALID_ARGUMENTS',
      `fn_id=${fn.fn_id} units exceed max_units (${fn.limits.max_units})`,
    );
  }

  if ('ok' in result) {
    if (fn.return_schema.type === 'null' && result.ok !== null) {
      return fatal(
        'HANDLER_ERROR',
        `fn_id=${fn.fn_id} must return null for return_schema "null"`,
      );
    }
    if (fn.return_schema.type === 'dv') {
      try {
        validateDv(result.ok, {
          limits: cappedDvLimits(dvLimits, fn.limits.max_response_bytes),
        });
      } catch (err) {
        return handleDvValidationError(
          fn,
          err,
          limitExceededEnvelope,
          dvLimits,
        );
      }
    }

    return encodeEnvelope(
      fn,
      { ok: result.ok, units },
      dvLimits,
      limitExceededEnvelope,
    );
  }

  if (
    result.err === null ||
    typeof result.err !== 'object' ||
    typeof result.err.code !== 'string' ||
    typeof result.err.tag !== 'string'
  ) {
    return fatal(
      'HANDLER_ERROR',
      `fn_id=${fn.fn_id} returned malformed err payload`,
    );
  }
  const manifestTag = fn.errorTagMap.get(result.err.code);
  if (!manifestTag) {
    return fatal(
      'HANDLER_ERROR',
      `fn_id=${fn.fn_id} returned unknown error code ${result.err.code}`,
    );
  }
  if (result.err.tag !== manifestTag) {
    return fatal(
      'HANDLER_ERROR',
      `fn_id=${fn.fn_id} error tag mismatch for code ${result.err.code}: expected ${manifestTag}, received ${result.err.tag}`,
    );
  }

  if (result.err.details !== undefined) {
    try {
      validateDv(result.err.details, {
        limits: cappedDvLimits(dvLimits, fn.limits.max_response_bytes),
      });
    } catch (err) {
      return handleDvValidationError(fn, err, limitExceededEnvelope, dvLimits);
    }
  }

  return encodeEnvelope(
    fn,
    {
      err:
        result.err.details === undefined
          ? { code: result.err.code }
          : { code: result.err.code, details: result.err.details },
      units,
    },
    dvLimits,
    limitExceededEnvelope,
  );
}

function encodeEnvelope(
  fn: CanonicalFunction,
  envelope: HostResponseEnvelope,
  dvLimits: DvLimits,
  limitExceededEnvelope?: HostResponseEnvelope,
): HostDispatchResult {
  const encodeLimits = cappedDvLimits(dvLimits, fn.limits.max_response_bytes);
  try {
    const bytes = encodeDv(envelope, { limits: encodeLimits });
    return { kind: 'response', envelope: bytes };
  } catch (err) {
    if (limitExceededEnvelope && isSizeRelatedDvError(err)) {
      try {
        const bytes = encodeDv(limitExceededEnvelope, { limits: encodeLimits });
        return { kind: 'response', envelope: bytes };
      } catch (limitErr) {
        return fatal(
          'RESPONSE_LIMIT',
          `fn_id=${fn.fn_id} failed to encode limit response: ${stringifyError(limitErr)}`,
          limitErr,
        );
      }
    }

    return fatal(
      'RESPONSE_LIMIT',
      `fn_id=${fn.fn_id} failed to encode response: ${stringifyError(err)}`,
      err,
    );
  }
}

function createLimitEnvelope(
  fn: CanonicalFunction,
): HostResponseEnvelope | undefined {
  if (!fn.errorTagMap.has('LIMIT_EXCEEDED')) {
    return undefined;
  }
  return { err: { code: 'LIMIT_EXCEEDED' }, units: 0 };
}

function assertDocumentShape(fn: CanonicalFunction): void {
  if (fn.arity !== 1 || fn.arg_schema.length !== 1) {
    throw new HostDispatcherError(
      'INVALID_REQUEST',
      `document.* functions must have arity 1 (fn_id=${fn.fn_id})`,
    );
  }
  if (fn.arg_schema[0]?.type !== 'string') {
    throw new HostDispatcherError(
      'INVALID_REQUEST',
      `document.* functions must take a string argument (fn_id=${fn.fn_id})`,
    );
  }
  if (fn.return_schema.type !== 'dv') {
    throw new HostDispatcherError(
      'INVALID_REQUEST',
      `document.* functions must return DV (fn_id=${fn.fn_id})`,
    );
  }
}

function assertEmitShape(fn: CanonicalFunction): void {
  if (fn.arity !== 1 || fn.arg_schema.length !== 1) {
    throw new HostDispatcherError(
      'INVALID_REQUEST',
      `emit must have arity 1 (fn_id=${fn.fn_id})`,
    );
  }
  if (fn.arg_schema[0]?.type !== 'dv') {
    throw new HostDispatcherError(
      'INVALID_REQUEST',
      `emit must take a DV argument (fn_id=${fn.fn_id})`,
    );
  }
  if (fn.return_schema.type !== 'null') {
    throw new HostDispatcherError(
      'INVALID_REQUEST',
      `emit must return null (fn_id=${fn.fn_id})`,
    );
  }
}

function handleDvValidationError(
  fn: CanonicalFunction,
  err: unknown,
  limitExceededEnvelope: HostResponseEnvelope | undefined,
  dvLimits: DvLimits,
): HostDispatchResult {
  if (limitExceededEnvelope && isSizeRelatedDvError(err)) {
    return encodeEnvelope(fn, limitExceededEnvelope, dvLimits);
  }
  return fatal(
    'HANDLER_ERROR',
    `fn_id=${fn.fn_id} produced non-DV value: ${stringifyError(err)}`,
    err,
  );
}

function cappedDvLimits(limits: DvLimits, maxBytes: number): DvLimits {
  return {
    ...limits,
    maxEncodedBytes: Math.min(limits.maxEncodedBytes, maxBytes),
  };
}

function normalizeDvLimits(limits?: Partial<DvLimits>): DvLimits {
  return {
    maxDepth: limits?.maxDepth ?? DV_LIMIT_DEFAULTS.maxDepth,
    maxEncodedBytes:
      limits?.maxEncodedBytes ?? DV_LIMIT_DEFAULTS.maxEncodedBytes,
    maxStringBytes: limits?.maxStringBytes ?? DV_LIMIT_DEFAULTS.maxStringBytes,
    maxArrayLength: limits?.maxArrayLength ?? DV_LIMIT_DEFAULTS.maxArrayLength,
    maxMapLength: limits?.maxMapLength ?? DV_LIMIT_DEFAULTS.maxMapLength,
  };
}

function toUint32(value: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return 0;
  }
  return value >>> 0;
}

function normalizeUint(
  value: unknown,
  max: number,
  path: string,
  allowOverflow?: boolean,
): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HostDispatcherError(
      'HANDLER_ERROR',
      `${path} must be an integer`,
    );
  }
  if (Object.is(value, -0)) {
    throw new HostDispatcherError('HANDLER_ERROR', `${path} must not be -0`);
  }
  if (value < 0 || value > UINT32_MAX) {
    throw new HostDispatcherError(
      'HANDLER_ERROR',
      `${path} must be between 0 and ${UINT32_MAX}`,
    );
  }
  if (value > max) {
    if (allowOverflow) {
      return null;
    }
    throw new HostDispatcherError(
      'HANDLER_ERROR',
      `${path} exceeds max_units (${value} > ${max})`,
    );
  }
  return value;
}

function fatal(
  code: HostDispatcherErrorCode,
  message: string,
  cause?: unknown,
): HostDispatchResult {
  return {
    kind: 'fatal',
    error: new HostDispatcherError(code, message, { cause }),
  };
}

function fatalLimitError(fn: CanonicalFunction): HostDispatchResult {
  return fatal(
    'INVALID_ARGUMENTS',
    `fn_id=${fn.fn_id} request exceeded max_request_bytes (${fn.limits.max_request_bytes})`,
  );
}

function asUint8Array(input: ArrayBufferView | ArrayBuffer): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

function isSizeRelatedDvError(err: unknown): boolean {
  return (
    err instanceof DvError &&
    (err.code === 'ENCODED_TOO_LARGE' ||
      err.code === 'STRING_TOO_LONG' ||
      err.code === 'ARRAY_TOO_LONG' ||
      err.code === 'MAP_TOO_LONG' ||
      err.code === 'DEPTH_EXCEEDED')
  );
}

function withErrorTags(fn: AbiFunction): CanonicalFunction {
  const errorTagMap = new Map<string, string>();
  for (const entry of fn.error_codes) {
    errorTagMap.set(entry.code, entry.tag);
  }
  return { ...fn, errorTagMap };
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function withinBounds(
  view: Uint8Array,
  offset: number,
  length: number,
): boolean {
  if (length === 0) {
    return offset <= view.byteLength;
  }
  if (offset > view.byteLength) {
    return false;
  }
  return length <= view.byteLength - offset;
}

function rangesOverlap(
  aOffset: number,
  aLength: number,
  bOffset: number,
  bLength: number,
): boolean {
  if (aLength === 0 || bLength === 0) {
    return false;
  }
  return aOffset < bOffset + bLength && bOffset < aOffset + aLength;
}

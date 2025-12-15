import { DV_LIMIT_DEFAULTS, encodeDv } from '@blue-quickjs/dv';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

const UINT32_MAX = 0xffffffff;
const JS_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export type AbiEffect = 'READ' | 'EMIT' | 'MUTATE';

export interface AbiSchemaString {
  type: 'string';
}

export interface AbiSchemaDv {
  type: 'dv';
}

export interface AbiSchemaNull {
  type: 'null';
}

export type AbiSchema = AbiSchemaString | AbiSchemaDv | AbiSchemaNull;

export interface AbiGasParameters {
  schedule_id: string;
  base: number;
  k_arg_bytes: number;
  k_ret_bytes: number;
  k_units: number;
}

export interface AbiLimits {
  max_request_bytes: number;
  max_response_bytes: number;
  max_units: number;
  arg_utf8_max?: number[];
}

export interface AbiErrorCode {
  code: string;
  tag: string;
}

export interface AbiFunction {
  fn_id: number;
  js_path: string[];
  effect: AbiEffect;
  arity: number;
  arg_schema: AbiSchema[];
  return_schema: AbiSchema;
  gas: AbiGasParameters;
  limits: AbiLimits;
  error_codes: AbiErrorCode[];
}

export interface AbiManifest {
  abi_id: string;
  abi_version: number;
  functions: AbiFunction[];
}

export type CanonicalAbiFunction = AbiFunction;
export type CanonicalAbiManifest = AbiManifest & {
  functions: CanonicalAbiFunction[];
};

export type AbiManifestErrorCode =
  | 'INVALID_TYPE'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'INVALID_VALUE'
  | 'OUT_OF_RANGE'
  | 'UNSORTED'
  | 'DUPLICATE'
  | 'PATH_CONFLICT';

export class AbiManifestError extends Error {
  constructor(
    public readonly code: AbiManifestErrorCode,
    message: string,
    public readonly path?: string,
  ) {
    super(path ? `${message} (${path})` : message);
    this.name = 'AbiManifestError';
  }
}

export interface AbiManifestBytes {
  bytes: Uint8Array;
  hash: string;
  manifest: CanonicalAbiManifest;
}

export function validateAbiManifest(
  manifest: AbiManifest,
): CanonicalAbiManifest {
  const normalized = validateManifestRoot(manifest);
  ensureUniqueFnIds(normalized.functions);
  ensureFunctionsSorted(normalized.functions);
  ensureNoJsPathConflicts(normalized.functions);
  return normalized;
}

export function encodeAbiManifest(manifest: AbiManifest): Uint8Array {
  const canonical = validateAbiManifest(manifest);
  return encodeDv(canonical);
}

export function hashAbiManifest(manifest: AbiManifest): AbiManifestBytes {
  const canonical = validateAbiManifest(manifest);
  const bytes = encodeDv(canonical);
  return {
    bytes,
    hash: hashAbiManifestBytes(bytes),
    manifest: canonical,
  };
}

export function hashAbiManifestBytes(
  bytes: ArrayBufferView | ArrayBuffer | Uint8Array,
): string {
  const view =
    bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return bytesToHex(sha256(view));
}

function validateManifestRoot(manifest: AbiManifest): CanonicalAbiManifest {
  const value = expectPlainObject(manifest, 'manifest');
  enforceExactKeys(value, ['abi_id', 'abi_version', 'functions'], 'manifest');

  const abiId = expectNonEmptyString(value.abi_id, 'manifest.abi_id');
  const abiVersion = expectUint32(value.abi_version, 'manifest.abi_version', {
    min: 1,
  });
  const functions = expectArray(value.functions, 'manifest.functions').map(
    (fn, index) => validateFunction(fn, `manifest.functions[${index}]`),
  );

  return {
    abi_id: abiId,
    abi_version: abiVersion,
    functions,
  };
}

function validateFunction(value: unknown, path: string): CanonicalAbiFunction {
  const fn = expectPlainObject(value, path);
  enforceExactKeys(
    fn,
    [
      'fn_id',
      'js_path',
      'effect',
      'arity',
      'arg_schema',
      'return_schema',
      'gas',
      'limits',
      'error_codes',
    ],
    path,
  );

  const fnId = expectUint32(fn.fn_id, `${path}.fn_id`, { min: 1 });
  const jsPath = validateJsPath(fn.js_path, `${path}.js_path`);
  const effect = validateEffect(fn.effect, `${path}.effect`);
  const arity = expectUint32(fn.arity, `${path}.arity`);
  const argSchema = validateArgSchemas(
    expectArray(fn.arg_schema, `${path}.arg_schema`),
    arity,
    `${path}.arg_schema`,
  );
  const returnSchema = validateSchema(
    fn.return_schema,
    `${path}.return_schema`,
  );
  const gas = validateGas(fn.gas, `${path}.gas`);
  const limits = validateLimits(fn.limits, argSchema, arity, `${path}.limits`);
  const errorCodes = validateErrorCodes(
    expectArray(fn.error_codes, `${path}.error_codes`),
    `${path}.error_codes`,
  );
  ensureGasMaxChargeWithinBounds(gas, limits, `${path}.gas`);

  return {
    fn_id: fnId,
    js_path: jsPath,
    effect,
    arity,
    arg_schema: argSchema,
    return_schema: returnSchema,
    gas,
    limits,
    error_codes: errorCodes,
  };
}

function validateJsPath(value: unknown, path: string): string[] {
  const segments = expectArray(value, path);
  if (segments.length === 0) {
    throw error(
      'INVALID_VALUE',
      'js_path must contain at least one segment',
      path,
    );
  }

  return segments.map((segment, index) => {
    const segmentPath = `${path}[${index}]`;
    const str = expectNonEmptyString(segment, segmentPath);
    if (!JS_PATH_SEGMENT.test(str)) {
      throw error(
        'INVALID_VALUE',
        `js_path segment must match ${JS_PATH_SEGMENT.source}: ${str}`,
        segmentPath,
      );
    }
    if (FORBIDDEN_SEGMENTS.has(str)) {
      throw error(
        'INVALID_VALUE',
        `js_path segment is forbidden: ${str}`,
        segmentPath,
      );
    }
    return str;
  });
}

function validateEffect(value: unknown, path: string): AbiEffect {
  if (value !== 'READ' && value !== 'EMIT' && value !== 'MUTATE') {
    throw error('INVALID_VALUE', 'effect must be READ, EMIT, or MUTATE', path);
  }
  return value;
}

function validateArgSchemas(
  schemas: unknown[],
  arity: number,
  path: string,
): AbiSchema[] {
  if (schemas.length !== arity) {
    throw error(
      'INVALID_VALUE',
      `arg_schema length (${schemas.length}) must equal arity (${arity})`,
      path,
    );
  }
  return schemas.map((schema, index) =>
    validateSchema(schema, `${path}[${index}]`),
  );
}

function validateSchema(value: unknown, path: string): AbiSchema {
  const schema = expectPlainObject(value, path);
  enforceExactKeys(schema, ['type'], path);

  if (
    schema.type === 'string' ||
    schema.type === 'dv' ||
    schema.type === 'null'
  ) {
    return { type: schema.type };
  }

  throw error(
    'INVALID_VALUE',
    `unsupported schema type: ${String(schema.type)}`,
    path,
  );
}

function validateGas(value: unknown, path: string): AbiGasParameters {
  const gas = expectPlainObject(value, path);
  enforceExactKeys(
    gas,
    ['schedule_id', 'base', 'k_arg_bytes', 'k_ret_bytes', 'k_units'],
    path,
  );

  return {
    schedule_id: expectNonEmptyString(gas.schedule_id, `${path}.schedule_id`),
    base: expectUint32(gas.base, `${path}.base`),
    k_arg_bytes: expectUint32(gas.k_arg_bytes, `${path}.k_arg_bytes`),
    k_ret_bytes: expectUint32(gas.k_ret_bytes, `${path}.k_ret_bytes`),
    k_units: expectUint32(gas.k_units, `${path}.k_units`),
  };
}

function validateLimits(
  value: unknown,
  argSchema: AbiSchema[],
  arity: number,
  path: string,
): AbiLimits {
  const limits = expectPlainObject(value, path);
  enforceExactKeys(
    limits,
    ['max_request_bytes', 'max_response_bytes', 'max_units', 'arg_utf8_max'],
    path,
    ['arg_utf8_max'],
  );

  const maxRequestBytes = expectUint32(
    limits.max_request_bytes,
    `${path}.max_request_bytes`,
    {
      min: 1,
      max: DV_LIMIT_DEFAULTS.maxEncodedBytes,
    },
  );
  const maxResponseBytes = expectUint32(
    limits.max_response_bytes,
    `${path}.max_response_bytes`,
    {
      min: 1,
      max: DV_LIMIT_DEFAULTS.maxEncodedBytes,
    },
  );
  const maxUnits = expectUint32(limits.max_units, `${path}.max_units`);

  let argUtf8Max: number[] | undefined;
  if (limits.arg_utf8_max !== undefined) {
    const parsed = expectArray(limits.arg_utf8_max, `${path}.arg_utf8_max`);
    if (parsed.length !== arity) {
      throw error(
        'INVALID_VALUE',
        `arg_utf8_max length (${parsed.length}) must equal arity (${arity})`,
        `${path}.arg_utf8_max`,
      );
    }
    argUtf8Max = parsed.map((entry, index) => {
      const limit = expectUint32(entry, `${path}.arg_utf8_max[${index}]`, {
        min: 1,
        max: DV_LIMIT_DEFAULTS.maxStringBytes,
      });
      if (argSchema[index].type !== 'string') {
        throw error(
          'INVALID_VALUE',
          'arg_utf8_max may only be used for string arguments',
          `${path}.arg_utf8_max[${index}]`,
        );
      }
      return limit;
    });
  }

  return {
    max_request_bytes: maxRequestBytes,
    max_response_bytes: maxResponseBytes,
    max_units: maxUnits,
    ...(argUtf8Max ? { arg_utf8_max: argUtf8Max } : {}),
  };
}

function validateErrorCodes(codes: unknown[], path: string): AbiErrorCode[] {
  const parsed = codes.map((entry, index) =>
    validateErrorCode(entry, `${path}[${index}]`),
  );
  ensureErrorCodesSorted(parsed, path);
  return parsed;
}

function validateErrorCode(value: unknown, path: string): AbiErrorCode {
  const code = expectPlainObject(value, path);
  enforceExactKeys(code, ['code', 'tag'], path);
  return {
    code: expectNonEmptyString(code.code, `${path}.code`),
    tag: expectNonEmptyString(code.tag, `${path}.tag`),
  };
}

function ensureFunctionsSorted(functions: CanonicalAbiFunction[]): void {
  for (let i = 1; i < functions.length; i += 1) {
    if (functions[i - 1].fn_id >= functions[i].fn_id) {
      throw error(
        'UNSORTED',
        'functions must be sorted by ascending fn_id without duplicates',
        'manifest.functions',
      );
    }
  }
}

function ensureUniqueFnIds(functions: CanonicalAbiFunction[]): void {
  const seen = new Set<number>();
  for (const fn of functions) {
    if (seen.has(fn.fn_id)) {
      throw error(
        'DUPLICATE',
        `duplicate fn_id ${fn.fn_id}`,
        'manifest.functions',
      );
    }
    seen.add(fn.fn_id);
  }
}

function ensureErrorCodesSorted(codes: AbiErrorCode[], path: string): void {
  for (let i = 1; i < codes.length; i += 1) {
    const previous = codes[i - 1].code;
    const current = codes[i].code;
    if (previous > current) {
      throw error('UNSORTED', 'error_codes must be sorted by code', path);
    }
    if (previous === current) {
      throw error('DUPLICATE', `duplicate error code ${current}`, path);
    }
  }
}

function ensureNoJsPathConflicts(functions: CanonicalAbiFunction[]): void {
  for (let i = 0; i < functions.length; i += 1) {
    for (let j = i + 1; j < functions.length; j += 1) {
      if (isPathConflict(functions[i].js_path, functions[j].js_path)) {
        throw error(
          'PATH_CONFLICT',
          `js_path collision between "${functions[i].js_path.join('.')}" and "${functions[j].js_path.join('.')}"`,
          'manifest.functions',
        );
      }
    }
  }
}

function isPathConflict(a: string[], b: string[]): boolean {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function expectPlainObject(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw error('INVALID_TYPE', 'expected object', path);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw error('INVALID_TYPE', 'expected plain object', path);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw error('INVALID_TYPE', 'expected array', path);
  }
  return value;
}

function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw error('INVALID_TYPE', 'expected string', path);
  }
  if (value.length === 0) {
    throw error('INVALID_VALUE', 'string must be non-empty', path);
  }
  return value;
}

function expectUint32(
  value: unknown,
  path: string,
  bounds?: { min?: number; max?: number },
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw error('INVALID_TYPE', 'expected integer', path);
  }
  if (Object.is(value, -0)) {
    throw error('INVALID_VALUE', 'integer must not be -0', path);
  }
  const min = bounds?.min ?? 0;
  const max = bounds?.max ?? UINT32_MAX;
  if (value < min || value > max) {
    throw error(
      'OUT_OF_RANGE',
      `value ${value} must be in [${min}, ${max}]`,
      path,
    );
  }
  return value;
}

function enforceExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
  optional?: string[],
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional ?? []);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw error('UNKNOWN_FIELD', `unknown field "${key}"`, path);
    }
  }
  for (const key of allowed) {
    if (optionalSet.has(key)) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw error('MISSING_FIELD', `missing required field "${key}"`, path);
    }
  }
}

function ensureGasMaxChargeWithinBounds(
  gas: AbiGasParameters,
  limits: AbiLimits,
  path: string,
): void {
  const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
  const base = BigInt(gas.base);
  const argBytes = BigInt(gas.k_arg_bytes) * BigInt(limits.max_request_bytes);
  const retBytes = BigInt(gas.k_ret_bytes) * BigInt(limits.max_response_bytes);
  const hostUnits = BigInt(gas.k_units) * BigInt(limits.max_units);
  const total = base + argBytes + retBytes + hostUnits;
  if (total > UINT64_MAX) {
    throw error('OUT_OF_RANGE', 'gas charges overflow uint64 bounds', path);
  }
}

function error(
  code: AbiManifestErrorCode,
  message: string,
  path?: string,
): AbiManifestError {
  return new AbiManifestError(code, message, path);
}

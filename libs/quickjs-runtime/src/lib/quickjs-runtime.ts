import {
  DV,
  DV_LIMIT_DEFAULTS,
  DvError,
  DvLimits,
  validateDv,
} from '@blue-quickjs/dv';

const UINT32_MAX = 0xffffffff;
const SHA256_HEX_LENGTH = 64;
const HEX_RE = /^[0-9a-f]+$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export type RuntimeFlagValue = string | number | boolean;

export interface ProgramArtifact {
  code: string;
  abiId: string;
  abiVersion: number;
  abiManifestHash: string;
  engineBuildHash?: string;
  runtimeFlags?: Record<string, RuntimeFlagValue>;
}

export interface ProgramArtifactLimits {
  maxCodeUnits: number;
  maxAbiIdLength: number;
  maxRuntimeFlags: number;
  maxRuntimeFlagKeyLength: number;
  maxRuntimeFlagStringLength: number;
}

export const PROGRAM_LIMIT_DEFAULTS: Readonly<ProgramArtifactLimits> = {
  maxCodeUnits: 1_048_576, // 1 MiB in UTF-16 code units
  maxAbiIdLength: 128,
  maxRuntimeFlags: 32,
  maxRuntimeFlagKeyLength: 64,
  maxRuntimeFlagStringLength: 256,
};

export interface ProgramValidationOptions {
  limits?: Partial<ProgramArtifactLimits>;
}

export interface InputEnvelope {
  event: DV;
  eventCanonical: DV;
  steps: DV;
}

export interface InputValidationOptions {
  dvLimits?: Partial<DvLimits>;
}

export type RuntimeValidationErrorCode =
  | 'INVALID_TYPE'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'EMPTY_STRING'
  | 'EXCEEDS_LIMIT'
  | 'INVALID_HEX'
  | 'OUT_OF_RANGE'
  | 'FORBIDDEN_KEY'
  | 'TOO_MANY_ITEMS'
  | 'DV_INVALID';

export class RuntimeValidationError extends Error {
  constructor(
    public readonly code: RuntimeValidationErrorCode,
    message: string,
    public readonly path?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RuntimeValidationError';
  }
}

export function validateProgramArtifact(
  value: unknown,
  options?: ProgramValidationOptions,
): ProgramArtifact {
  const limits = normalizeProgramLimits(options?.limits);
  const program = expectPlainObject(value, 'program');
  enforceExactKeys(
    program,
    [
      'code',
      'abiId',
      'abiVersion',
      'abiManifestHash',
      'engineBuildHash',
      'runtimeFlags',
    ],
    'program',
  );

  const code = expectString(program.code, 'program.code', {
    maxLength: limits.maxCodeUnits,
    allowEmpty: true,
  });
  const abiId = expectString(program.abiId, 'program.abiId', {
    maxLength: limits.maxAbiIdLength,
  });
  const abiVersion = expectUint(
    program.abiVersion,
    1,
    UINT32_MAX,
    'program.abiVersion',
  );
  const abiManifestHash = expectHexString(
    program.abiManifestHash,
    'program.abiManifestHash',
    { exactLength: SHA256_HEX_LENGTH },
  );
  const engineBuildHash =
    program.engineBuildHash !== undefined
      ? expectHexString(program.engineBuildHash, 'program.engineBuildHash', {
          exactLength: SHA256_HEX_LENGTH,
        })
      : undefined;

  const runtimeFlags =
    program.runtimeFlags !== undefined
      ? validateRuntimeFlags(
          program.runtimeFlags,
          limits,
          'program.runtimeFlags',
        )
      : undefined;

  return {
    code,
    abiId,
    abiVersion,
    abiManifestHash,
    engineBuildHash,
    runtimeFlags,
  };
}

export function validateInputEnvelope(
  value: unknown,
  options?: InputValidationOptions,
): InputEnvelope {
  const dvLimits = normalizeDvLimits(options?.dvLimits);
  const input = expectPlainObject(value, 'input');
  enforceExactKeys(input, ['event', 'eventCanonical', 'steps'], 'input');

  const event = validateDvField(input.event, dvLimits, 'input.event');
  const eventCanonical = validateDvField(
    input.eventCanonical,
    dvLimits,
    'input.eventCanonical',
  );
  const steps = validateDvField(input.steps, dvLimits, 'input.steps');

  return {
    event,
    eventCanonical,
    steps,
  };
}

function validateRuntimeFlags(
  value: unknown,
  limits: ProgramArtifactLimits,
  path: string,
): Record<string, RuntimeFlagValue> {
  const flags = expectPlainObject(value, path);
  const keys = Object.keys(flags);
  if (keys.length > limits.maxRuntimeFlags) {
    throw runtimeError(
      'TOO_MANY_ITEMS',
      `${path} has ${keys.length} entries; maxRuntimeFlags=${limits.maxRuntimeFlags}`,
      path,
    );
  }

  const result: Record<string, RuntimeFlagValue> = {};
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw runtimeError(
        'FORBIDDEN_KEY',
        `${path} may not use reserved key "${key}"`,
        `${path}.${key}`,
      );
    }
    const normalizedKey = expectString(key, `${path} key`, {
      maxLength: limits.maxRuntimeFlagKeyLength,
    });
    const flagValue = flags[key];
    if (typeof flagValue === 'string') {
      result[normalizedKey] = expectString(flagValue, `${path}.${key}`, {
        maxLength: limits.maxRuntimeFlagStringLength,
        allowEmpty: true,
      });
    } else if (typeof flagValue === 'boolean') {
      result[normalizedKey] = flagValue;
    } else if (typeof flagValue === 'number') {
      result[normalizedKey] = expectFiniteNumber(flagValue, `${path}.${key}`);
    } else {
      throw runtimeError(
        'INVALID_TYPE',
        `${path}.${key} must be a string, number, or boolean`,
        `${path}.${key}`,
      );
    }
  }

  return result;
}

function validateDvField(value: unknown, limits: DvLimits, path: string): DV {
  try {
    validateDv(value, { limits });
    return value as DV;
  } catch (err) {
    if (err instanceof DvError) {
      throw runtimeError(
        'DV_INVALID',
        `${path} is not valid DV: ${err.message}`,
        path,
        err,
      );
    }
    throw err;
  }
}

function expectPlainObject(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw runtimeError('INVALID_TYPE', `${path} must be a plain object`, path);
  }
  return value as Record<string, unknown>;
}

function enforceExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw runtimeError(
        'UNKNOWN_FIELD',
        `${path} contains unknown field "${key}"`,
        `${path}.${key}`,
      );
    }
  }
}

function expectString(
  value: unknown,
  path: string,
  options?: { maxLength?: number; allowEmpty?: boolean },
): string {
  if (typeof value !== 'string') {
    throw runtimeError('INVALID_TYPE', `${path} must be a string`, path);
  }
  if (!options?.allowEmpty && value.length === 0) {
    throw runtimeError('EMPTY_STRING', `${path} must not be empty`, path);
  }
  if (options?.maxLength !== undefined && value.length > options.maxLength) {
    throw runtimeError(
      'EXCEEDS_LIMIT',
      `${path} exceeds maxLength (${value.length} > ${options.maxLength})`,
      path,
    );
  }
  return value;
}

function expectHexString(
  value: unknown,
  path: string,
  options: { exactLength?: number; maxLength?: number },
): string {
  const hex = expectString(value, path);
  if (options.exactLength !== undefined && hex.length !== options.exactLength) {
    throw runtimeError(
      'INVALID_HEX',
      `${path} must be ${options.exactLength} hex characters`,
      path,
    );
  }
  if (options.maxLength !== undefined && hex.length > options.maxLength) {
    throw runtimeError(
      'EXCEEDS_LIMIT',
      `${path} exceeds maxLength (${hex.length} > ${options.maxLength})`,
      path,
    );
  }
  if (hex.length % 2 !== 0) {
    throw runtimeError(
      'INVALID_HEX',
      `${path} must have an even number of hex characters`,
      path,
    );
  }
  if (!HEX_RE.test(hex)) {
    throw runtimeError('INVALID_HEX', `${path} must be lowercase hex`, path);
  }
  return hex;
}

function expectUint(
  value: unknown,
  min: number,
  max: number,
  path: string,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw runtimeError('INVALID_TYPE', `${path} must be an integer`, path);
  }
  if (Object.is(value, -0)) {
    throw runtimeError('OUT_OF_RANGE', `${path} must not be -0`, path);
  }
  if (value < min || value > max) {
    throw runtimeError(
      'OUT_OF_RANGE',
      `${path} must be between ${min} and ${max}`,
      path,
    );
  }
  return value;
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw runtimeError('INVALID_TYPE', `${path} must be a finite number`, path);
  }
  if (Object.is(value, -0)) {
    throw runtimeError('OUT_OF_RANGE', `${path} must not be -0`, path);
  }
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw runtimeError(
      'OUT_OF_RANGE',
      `${path} exceeds safe integer range`,
      path,
    );
  }
  return value;
}

function normalizeProgramLimits(
  overrides?: Partial<ProgramArtifactLimits>,
): ProgramArtifactLimits {
  return {
    maxCodeUnits:
      overrides?.maxCodeUnits ?? PROGRAM_LIMIT_DEFAULTS.maxCodeUnits,
    maxAbiIdLength:
      overrides?.maxAbiIdLength ?? PROGRAM_LIMIT_DEFAULTS.maxAbiIdLength,
    maxRuntimeFlags:
      overrides?.maxRuntimeFlags ?? PROGRAM_LIMIT_DEFAULTS.maxRuntimeFlags,
    maxRuntimeFlagKeyLength:
      overrides?.maxRuntimeFlagKeyLength ??
      PROGRAM_LIMIT_DEFAULTS.maxRuntimeFlagKeyLength,
    maxRuntimeFlagStringLength:
      overrides?.maxRuntimeFlagStringLength ??
      PROGRAM_LIMIT_DEFAULTS.maxRuntimeFlagStringLength,
  };
}

function normalizeDvLimits(overrides?: Partial<DvLimits>): DvLimits {
  return {
    maxDepth: overrides?.maxDepth ?? DV_LIMIT_DEFAULTS.maxDepth,
    maxEncodedBytes:
      overrides?.maxEncodedBytes ?? DV_LIMIT_DEFAULTS.maxEncodedBytes,
    maxStringBytes:
      overrides?.maxStringBytes ?? DV_LIMIT_DEFAULTS.maxStringBytes,
    maxArrayLength:
      overrides?.maxArrayLength ?? DV_LIMIT_DEFAULTS.maxArrayLength,
    maxMapLength: overrides?.maxMapLength ?? DV_LIMIT_DEFAULTS.maxMapLength,
  };
}

function runtimeError(
  code: RuntimeValidationErrorCode,
  message: string,
  path?: string,
  cause?: unknown,
): RuntimeValidationError {
  return new RuntimeValidationError(code, message, path, { cause });
}

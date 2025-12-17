import type { AbiManifest } from '@blue-quickjs/abi-manifest';
import {
  type DV,
  DV_LIMIT_DEFAULTS,
  type DvLimits,
  validateDv,
} from '@blue-quickjs/dv';
import { initializeDeterministicVm } from './deterministic-init.js';
import type {
  HostDispatcherHandlers,
  HostDispatcherOptions,
} from './host-dispatcher.js';
import {
  type InputEnvelope,
  type InputValidationOptions,
  type ProgramArtifact,
  validateInputEnvelope,
  validateProgramArtifact,
} from './quickjs-runtime.js';
import {
  type RuntimeArtifactSelection,
  type RuntimeInstance,
  createRuntime,
} from './runtime.js';
import {
  createInvalidOutputError,
  mapVmError,
  type EvaluateInvalidOutputDetail,
  type EvaluateVmErrorDetail,
} from './evaluate-errors.js';

export interface EvaluateOptions
  extends RuntimeArtifactSelection, HostDispatcherOptions {
  program: ProgramArtifact;
  input: InputEnvelope;
  gasLimit: bigint | number;
  manifest: AbiManifest;
  handlers: HostDispatcherHandlers;
  inputValidation?: InputValidationOptions;
  /**
   * DV limits applied to the returned value.
   */
  outputDvLimits?: Partial<DvLimits>;
  /**
   * Enable host-call tape recording (capacity defaults to 128; max 1024).
   */
  tape?: { capacity?: number };
  /**
   * Enable gas trace recording for the evaluation.
   */
  gasTrace?: boolean;
}

export type EvaluateSuccess = {
  ok: true;
  value: DV;
  gasUsed: bigint;
  gasRemaining: bigint;
  raw: string;
  tape?: HostTapeRecord[];
  gasTrace?: GasTrace;
};

type EvaluateFailureBase = {
  ok: false;
  type: 'vm-error' | 'invalid-output';
  message: string;
  gasUsed: bigint;
  gasRemaining: bigint;
  raw: string;
  tape?: HostTapeRecord[];
  gasTrace?: GasTrace;
};

export type EvaluateVmError = EvaluateFailureBase & {
  type: 'vm-error';
  error: EvaluateVmErrorDetail;
};

export type EvaluateInvalidOutputError = EvaluateFailureBase & {
  type: 'invalid-output';
  error: EvaluateInvalidOutputDetail;
};

export type EvaluateError = EvaluateVmError | EvaluateInvalidOutputError;

export type EvaluateResult = EvaluateSuccess | EvaluateError;

const HOST_TAPE_MAX_CAPACITY = 1024;

export async function evaluate(
  options: EvaluateOptions,
): Promise<EvaluateResult> {
  const program = validateProgramArtifact(options.program);
  const input = validateInputEnvelope(options.input, options.inputValidation);

  const runtime = await createRuntime({
    manifest: options.manifest,
    handlers: options.handlers,
    variant: options.variant,
    buildType: options.buildType,
    metadata: options.metadata,
    wasmBinary: options.wasmBinary,
    dvLimits: options.dvLimits,
    expectedAbiId: program.abiId,
    expectedAbiVersion: program.abiVersion,
  });

  assertEngineBuildHash(program, runtime);

  const vm = initializeDeterministicVm(
    runtime,
    program,
    input,
    options.gasLimit,
  );

  if (options.tape) {
    const capacity = options.tape.capacity ?? 128;
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new Error('tape capacity must be a non-negative integer');
    }
    if (capacity > HOST_TAPE_MAX_CAPACITY) {
      throw new Error(
        `tape capacity exceeds max (${HOST_TAPE_MAX_CAPACITY}); received ${capacity}`,
      );
    }
    vm.enableTape(capacity);
  }

  if (options.gasTrace) {
    vm.enableGasTrace(true);
  }

  try {
    const raw = vm.eval(program.code);
    const parsed = parseEvalOutput(raw);
    const tape = options.tape ? parseTape(vm.readTape()) : undefined;
    const trace = options.gasTrace
      ? parseGasTrace(vm.readGasTrace())
      : undefined;

    if (parsed.kind === 'error') {
      const error = mapVmError(parsed.payload, runtime.manifest);
      return {
        ok: false,
        type: 'vm-error',
        message: error.message,
        error,
        gasUsed: parsed.gasUsed,
        gasRemaining: parsed.gasRemaining,
        raw,
        tape,
        gasTrace: trace,
      };
    }

    const decoded = decodeResultPayload(parsed.payload, options.outputDvLimits);
    if (decoded.kind === 'error') {
      const error = createInvalidOutputError(decoded.message, decoded.cause);
      return {
        ok: false,
        type: 'invalid-output',
        message: error.message,
        error,
        gasUsed: parsed.gasUsed,
        gasRemaining: parsed.gasRemaining,
        raw,
        tape,
        gasTrace: trace,
      };
    }

    return {
      ok: true,
      value: decoded.value,
      gasUsed: parsed.gasUsed,
      gasRemaining: parsed.gasRemaining,
      raw,
      tape,
      gasTrace: trace,
    };
  } finally {
    vm.dispose();
  }
}

type ParsedEvalOutput = {
  kind: 'result' | 'error';
  payload: string;
  gasRemaining: bigint;
  gasUsed: bigint;
};

function parseEvalOutput(raw: string): ParsedEvalOutput {
  const normalized = raw.trim();

  let kind: 'RESULT' | 'ERROR';
  if (normalized.startsWith('RESULT')) {
    kind = 'RESULT';
  } else if (normalized.startsWith('ERROR')) {
    kind = 'ERROR';
  } else {
    throw new Error(`Unexpected VM output prefix: ${normalized}`);
  }

  const withoutKind = normalized.slice(kind.length).trimStart();
  const trailerMarker = ' GAS remaining=';
  const usedMarker = ' used=';

  const trailerIdx = withoutKind.lastIndexOf(trailerMarker);
  if (trailerIdx < 0) {
    throw new Error(`Missing gas trailer in VM output: ${normalized}`);
  }

  const payload = withoutKind.slice(0, trailerIdx).trimEnd();
  const trailer = withoutKind.slice(trailerIdx + trailerMarker.length);
  const usedIdx = trailer.lastIndexOf(usedMarker);
  if (usedIdx < 0) {
    throw new Error(`Missing used= trailer in VM output: ${normalized}`);
  }

  const remainingStr = trailer.slice(0, usedIdx).trim();
  const usedStr = trailer.slice(usedIdx + usedMarker.length).trim();

  return {
    kind: kind === 'RESULT' ? 'result' : 'error',
    payload,
    gasRemaining: parseUint64(remainingStr, 'gasRemaining'),
    gasUsed: parseUint64(usedStr, 'gasUsed'),
  };
}

type DecodedResultPayload =
  | { kind: 'ok'; value: DV }
  | { kind: 'error'; message: string; cause?: unknown };

function decodeResultPayload(
  payload: string,
  limits?: Partial<DvLimits>,
): DecodedResultPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    return {
      kind: 'error',
      message: `VM returned non-JSON result: ${String(err)}`,
      cause: err,
    };
  }

  try {
    validateDv(parsed, { limits: normalizeDvLimits(limits) });
    return { kind: 'ok', value: parsed as DV };
  } catch (err) {
    return {
      kind: 'error',
      message: `VM returned non-DV value: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    };
  }
}

export interface HostTapeRecord {
  fnId: number;
  reqLen: number;
  respLen: number;
  units: number;
  gasPre: bigint;
  gasPost: bigint;
  isError: boolean;
  chargeFailed: boolean;
  reqHash: string;
  respHash: string;
}

function parseTape(raw: string): HostTapeRecord[] {
  const parsed = parseJson(raw, 'tape');
  if (!Array.isArray(parsed)) {
    throw new Error('tape payload is not an array');
  }

  return parsed.map((record, idx) => {
    if (record === null || typeof record !== 'object') {
      throw new Error(`tape record ${idx} is not an object`);
    }

    const fnId = expectUint32(record.fnId, `tape[${idx}].fnId`);
    const reqLen = expectUint32(record.reqLen, `tape[${idx}].reqLen`);
    const respLen = expectUint32(record.respLen, `tape[${idx}].respLen`);
    const units = expectUint32(record.units, `tape[${idx}].units`);
    const gasPre = expectBigIntString(record.gasPre, `tape[${idx}].gasPre`);
    const gasPost = expectBigIntString(record.gasPost, `tape[${idx}].gasPost`);
    const isError = Boolean(record.isError);
    const chargeFailed = Boolean(record.chargeFailed);
    const reqHash = expectHex(record.reqHash, `tape[${idx}].reqHash`, 64);
    const respHash = expectHex(record.respHash, `tape[${idx}].respHash`, 64);

    return {
      fnId,
      reqLen,
      respLen,
      units,
      gasPre,
      gasPost,
      isError,
      chargeFailed,
      reqHash,
      respHash,
    };
  });
}

export interface GasTrace {
  opcodeCount: bigint;
  opcodeGas: bigint;
  arrayCbBaseCount: bigint;
  arrayCbBaseGas: bigint;
  arrayCbPerElCount: bigint;
  arrayCbPerElGas: bigint;
  allocationCount: bigint;
  allocationBytes: bigint;
  allocationGas: bigint;
}

function parseGasTrace(raw: string): GasTrace {
  const obj = expectRecord(parseJson(raw, 'gasTrace'), 'gasTrace');

  return {
    opcodeCount: expectBigIntString(obj.opcodeCount, 'gasTrace.opcodeCount'),
    opcodeGas: expectBigIntString(obj.opcodeGas, 'gasTrace.opcodeGas'),
    arrayCbBaseCount: expectBigIntString(
      obj.arrayCbBaseCount,
      'gasTrace.arrayCbBaseCount',
    ),
    arrayCbBaseGas: expectBigIntString(
      obj.arrayCbBaseGas,
      'gasTrace.arrayCbBaseGas',
    ),
    arrayCbPerElCount: expectBigIntString(
      obj.arrayCbPerElCount,
      'gasTrace.arrayCbPerElCount',
    ),
    arrayCbPerElGas: expectBigIntString(
      obj.arrayCbPerElGas,
      'gasTrace.arrayCbPerElGas',
    ),
    allocationCount: expectBigIntString(
      obj.allocationCount,
      'gasTrace.allocationCount',
    ),
    allocationBytes: expectBigIntString(
      obj.allocationBytes,
      'gasTrace.allocationBytes',
    ),
    allocationGas: expectBigIntString(
      obj.allocationGas,
      'gasTrace.allocationGas',
    ),
  };
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${label} payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function expectUint32(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  if (value > 0xffffffff) {
    throw new Error(`${path} exceeds uint32`);
  }
  return value;
}

function expectBigIntString(value: unknown, path: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new Error(`${path} must be non-negative`);
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string`);
  }
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) {
      throw new Error(`${path} must be non-negative`);
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `${path} is not a valid bigint string: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function expectHex(value: unknown, path: string, length: number): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a hex string`);
  }
  if (value.length !== length) {
    throw new Error(`${path} must be ${length} hex characters`);
  }
  if (!/^[0-9a-f]+$/.test(value)) {
    throw new Error(`${path} must be lowercase hex`);
  }
  return value;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} payload is not an object`);
  }
  return value as Record<string, unknown>;
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

function parseUint64(text: string, label: string): bigint {
  try {
    const value = BigInt(text);
    if (value < 0n) {
      throw new Error(`${label} must be non-negative`);
    }
    return value;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : `Invalid ${label} value`;
    throw new Error(`${message}: ${text}`);
  }
}

function assertEngineBuildHash(
  program: ProgramArtifact,
  runtime: RuntimeInstance,
): void {
  if (!program.engineBuildHash) {
    return;
  }

  const runtimeHash =
    runtime.artifact.variantMetadata.engineBuildHash ??
    runtime.metadata.engineBuildHash ??
    null;

  if (!runtimeHash) {
    throw new Error(
      'Engine build hash is unavailable; cannot verify program.engineBuildHash',
    );
  }

  if (runtimeHash !== program.engineBuildHash) {
    throw new Error(
      `engineBuildHash mismatch: program=${program.engineBuildHash} runtime=${runtimeHash}`,
    );
  }
}

export type {
  EvaluateInvalidOutputDetail,
  EvaluateVmErrorDetail,
} from './evaluate-errors.js';

import { DvError } from '@blue-quickjs/dv';
import {
  InputEnvelope,
  PROGRAM_LIMIT_DEFAULTS,
  ProgramArtifact,
  RuntimeValidationError,
  validateInputEnvelope,
  validateProgramArtifact,
} from './quickjs-runtime.js';

const SAMPLE_HASH =
  '8d50b2a3f4c5d6e7f8c9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1';

describe('validateProgramArtifact', () => {
  const baseProgram: ProgramArtifact = {
    code: 'export const x = 1;',
    abiId: 'Host.v1',
    abiVersion: 1,
    abiManifestHash: SAMPLE_HASH,
    engineBuildHash: SAMPLE_HASH,
  };

  it('accepts a well-formed program artifact', () => {
    expect(validateProgramArtifact(baseProgram)).toEqual(baseProgram);
  });

  it('rejects invalid manifest hashes', () => {
    expect(() =>
      validateProgramArtifact({
        ...baseProgram,
        abiManifestHash: 'abc',
      }),
    ).toThrow(RuntimeValidationError);
  });

  it('rejects code that exceeds the configured limit', () => {
    const bigCode = 'a'.repeat(PROGRAM_LIMIT_DEFAULTS.maxCodeUnits + 1);
    expect(() =>
      validateProgramArtifact({
        ...baseProgram,
        code: bigCode,
      }),
    ).toThrow(RuntimeValidationError);
  });

  it('rejects null or empty engineBuildHash values', () => {
    expect(() =>
      validateProgramArtifact({
        ...baseProgram,
        engineBuildHash: null as unknown as string,
      }),
    ).toThrow(RuntimeValidationError);

    expect(() =>
      validateProgramArtifact({
        ...baseProgram,
        engineBuildHash: '',
      }),
    ).toThrow(RuntimeValidationError);
  });
});

describe('validateInputEnvelope', () => {
  const baseInput: InputEnvelope = {
    event: { type: 'create', payload: { id: 1 } },
    eventCanonical: { type: 'create', payload: { id: 1 } },
    steps: [],
  };

  it('accepts a well-formed input envelope', () => {
    expect(validateInputEnvelope(baseInput)).toEqual(baseInput);
  });

  it('rejects invalid DV fields with a wrapped error', () => {
    expect(() =>
      validateInputEnvelope({
        ...baseInput,
        event: Symbol('x') as unknown as InputEnvelope['event'],
      }),
    ).toThrow(RuntimeValidationError);
  });

  it('applies DV limits to all DV fields', () => {
    const dvLimits = { maxEncodedBytes: 8 };
    expect(() =>
      validateInputEnvelope(
        {
          ...baseInput,
          event: 'abcdefghijk',
        },
        { dvLimits },
      ),
    ).toThrow(RuntimeValidationError);
  });

  it('rejects unknown fields', () => {
    expect(() =>
      validateInputEnvelope({
        ...baseInput,
        extra: 123 as unknown as InputEnvelope['steps'],
      }),
    ).toThrow(RuntimeValidationError);
  });

  it('provides DvError as the cause for DV failures', () => {
    try {
      validateInputEnvelope({
        ...baseInput,
        eventCanonical: BigInt(1) as unknown as InputEnvelope['eventCanonical'],
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeValidationError);
      expect((err as RuntimeValidationError).cause).toBeInstanceOf(DvError);
      return;
    }
    throw new Error('expected RuntimeValidationError');
  });
});

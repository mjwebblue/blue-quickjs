import { createHash } from 'crypto';

import { encodeDv } from '@blue-quickjs/dv';
import {
  DETERMINISM_FIXTURES,
  type DeterminismFixtureBaseline,
  serializeHostTape,
} from '@blue-quickjs/test-harness';
import {
  type EvaluateResult,
  evaluate,
  type HostTapeRecord,
} from '@blue-quickjs/quickjs-runtime';

interface FixtureSnapshot {
  resultHash: string | null;
  errorCode: string | null;
  errorTag: string | null;
  gasUsed: string;
  gasRemaining: string;
  tapeHash: string | null;
  tapeLength: number;
}

const TAPE_CAPACITY = 32;

describe('smoke-node determinism fixtures', () => {
  it('matches expected outputs for all fixtures', async () => {
    for (const fixture of DETERMINISM_FIXTURES) {
      const host = fixture.createHost();
      const result = await evaluate({
        program: fixture.program,
        input: fixture.input,
        gasLimit: fixture.gasLimit,
        manifest: fixture.manifest,
        handlers: host.handlers,
        tape: { capacity: TAPE_CAPACITY },
      });

      const actual = await summarizeFixture(result);
      const expected = normalizeExpected(fixture.expected);
      expect(actual).toEqual(expected);
    }
  });
});

function normalizeExpected(
  expected: DeterminismFixtureBaseline,
): FixtureSnapshot {
  return {
    resultHash: expected.resultHash,
    errorCode: expected.errorCode,
    errorTag: expected.errorTag,
    gasUsed: expected.gasUsed.toString(),
    gasRemaining: expected.gasRemaining.toString(),
    tapeHash: expected.tapeHash,
    tapeLength: expected.tapeLength,
  };
}

async function summarizeFixture(
  result: EvaluateResult,
): Promise<FixtureSnapshot> {
  const tape = result.tape ?? [];
  const tapeHash = hashTape(tape);
  const resultHash = result.ok ? hashDv(result.value) : null;
  const errorCode = result.ok ? null : result.error.code;
  const errorTag = result.ok
    ? null
    : 'tag' in result.error
      ? result.error.tag
      : null;

  return {
    resultHash,
    errorCode,
    errorTag,
    gasUsed: result.gasUsed.toString(),
    gasRemaining: result.gasRemaining.toString(),
    tapeHash,
    tapeLength: tape.length,
  };
}

function hashDv(value: unknown): string {
  const encoded = encodeDv(value);
  return sha256Hex(encoded);
}

function hashTape(tape: HostTapeRecord[]): string | null {
  if (tape.length === 0) {
    return null;
  }
  return sha256Hex(serializeHostTape(tape));
}

function sha256Hex(input: Uint8Array | string): string {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return createHash('sha256').update(bytes).digest('hex');
}

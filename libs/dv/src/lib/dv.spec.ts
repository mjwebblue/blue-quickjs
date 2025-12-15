import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DV,
  DV_LIMIT_DEFAULTS,
  DvError,
  DvErrorCode,
  decodeDv,
  encodeDv,
  isDv,
} from './dv.js';

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const expectCode = (fn: () => unknown, code: DvErrorCode): void => {
  try {
    fn();
    throw new Error('expected function to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(DvError);
    expect((err as DvError).code).toBe(code);
  }
};

describe('encodeDv / decodeDv', () => {
  it('encodes canonical primitives and examples', () => {
    expect(hex(encodeDv(null))).toBe('f6');
    expect(hex(encodeDv(true))).toBe('f5');
    expect(hex(encodeDv(-1))).toBe('20');
    expect(hex(encodeDv(['hello', 1.5]))).toBe(
      '826568656c6c6ffb3ff8000000000000',
    );
    expect(hex(encodeDv({ b: 2, aa: 1 }))).toBe('a261620262616101');
  });

  it('rejects unsupported JS types and invalid numbers, and canonicalizes -0', () => {
    expectCode(() => encodeDv(Symbol('x')), 'UNSUPPORTED_TYPE');
    expectCode(() => encodeDv(NaN), 'NAN_OR_INF');
    expectCode(() => encodeDv(Number.POSITIVE_INFINITY), 'NAN_OR_INF');
    expectCode(
      () => encodeDv(Number.MAX_SAFE_INTEGER + 1),
      'INTEGER_OUT_OF_RANGE',
    );
    expect(decodeDv(encodeDv(-0))).toBe(0);
  });

  it('enforces depth, size, and string limits', () => {
    expectCode(
      () => encodeDv([[]], { limits: { maxDepth: 1 } }),
      'DEPTH_EXCEEDED',
    );
    expectCode(
      () => encodeDv('aaaa', { limits: { maxStringBytes: 3 } }),
      'STRING_TOO_LONG',
    );
    expectCode(
      () => encodeDv('abcd', { limits: { maxEncodedBytes: 3 } }),
      'ENCODED_TOO_LARGE',
    );
  });

  it('rejects invalid UTF-8 and malformed strings', () => {
    expectCode(() => encodeDv('a\uD800'), 'INVALID_STRING');
    expectCode(() => decodeDv(Uint8Array.from([0x61])), 'TRUNCATED');
    const invalidBytes = Uint8Array.from([0x62, 0xc3, 0x28]);
    expect(() => decodeDv(invalidBytes)).toThrowError(
      expect.objectContaining({ code: 'INVALID_UTF8' }),
    );
    expectCode(
      () =>
        decodeDv(
          Uint8Array.from([
            0xfb, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          ]),
        ),
      'NON_CANONICAL_FLOAT',
    ); // float64 zero must use integer encoding
    expectCode(
      () =>
        decodeDv(
          Uint8Array.from([
            0xfb, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          ]),
        ),
      'NON_CANONICAL_FLOAT',
    ); // float64 -0 must canonicalize to +0 integer form
  });

  it('rejects non-canonical or forbidden CBOR encodings', () => {
    expectCode(
      () => decodeDv(Uint8Array.from([0x18, 0x01])),
      'NON_CANONICAL_LENGTH',
    ); // integer 1 using uint8
    expectCode(
      () => decodeDv(Uint8Array.from([0xfa, 0x3f, 0x80, 0x00, 0x00])),
      'NON_CANONICAL_FLOAT',
    ); // float32
    expectCode(
      () =>
        decodeDv(
          Uint8Array.from([
            0xfb, 0x3f, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          ]),
        ),
      'NON_CANONICAL_FLOAT',
    ); // float64 encoding of integer 1
    expectCode(
      () =>
        decodeDv(
          Uint8Array.from([
            0x3b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
          ]),
        ),
      'INTEGER_OUT_OF_RANGE',
    ); // -9007199254740992 (one below MIN_SAFE_INTEGER)
    expectCode(() => decodeDv(Uint8Array.from([0x40])), 'UNSUPPORTED_CBOR'); // byte string
    expectCode(
      () =>
        decodeDv(
          Uint8Array.from([0xa2, 0x62, 0x61, 0x61, 0x01, 0x61, 0x62, 0x02]),
        ),
      'KEY_ORDER',
    ); // map keys out of order
    expectCode(
      () =>
        decodeDv(Uint8Array.from([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02])),
      'DUPLICATE_KEY',
    );
  });

  it('roundtrips and canonicalizes under property-based generation', () => {
    const limits = {
      maxDepth: 4,
      maxArrayLength: 6,
      maxMapLength: 6,
      maxStringBytes: 64,
      maxEncodedBytes: 256,
    };

    const stringArb = fc
      .array(fc.integer({ min: 0x20, max: 0x7e }), { maxLength: 16 })
      .map((codes) => String.fromCharCode(...codes));
    const floatArb = fc
      .double({ min: -1e6, max: 1e6, noDefaultInfinity: true, noNaN: true })
      .filter((n) => !Number.isInteger(n));

    const primitive = fc.oneof(
      fc.constant(null),
      fc.boolean(),
      fc.integer({ min: -1_000, max: 1_000 }),
      floatArb,
      stringArb,
    );

    const dvMemo = (depth: number): fc.Arbitrary<DV> =>
      depth <= 0
        ? primitive
        : fc.oneof(
            primitive,
            fc.array(dvMemo(depth - 1), { maxLength: 4 }),
            fc.dictionary(stringArb, dvMemo(depth - 1), { maxKeys: 4 }),
          );

    const dvArb: fc.Arbitrary<DV> = dvMemo(3);

    fc.assert(
      fc.property(dvArb, (value) => {
        const encoded = encodeDv(value, { limits });
        const decoded = decodeDv(encoded, { limits });
        expect(isDv(decoded, { limits: DV_LIMIT_DEFAULTS })).toBe(true);
        const reencoded = encodeDv(decoded, { limits });
        expect(hex(encoded)).toBe(hex(reencoded));
      }),
      { numRuns: 150 },
    );
  });
});

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AbiManifest,
  AbiManifestError,
  encodeAbiManifest,
  hashAbiManifest,
  hashAbiManifestBytes,
  validateAbiManifest,
} from './abi-manifest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(
  here,
  '../../../test-harness/fixtures/abi-manifest',
);

const HOST_V1_MANIFEST_PATH = path.join(fixturesDir, 'host-v1.json');
const HOST_V1_BYTES_HEX = readText('host-v1.bytes.hex');
const HOST_V1_HASH = readText('host-v1.hash');

const HOST_V1_MANIFEST: AbiManifest = JSON.parse(
  readFileSync(HOST_V1_MANIFEST_PATH, 'utf8'),
);
const HOST_V1_BYTES = new Uint8Array(Buffer.from(HOST_V1_BYTES_HEX, 'hex'));

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function readText(filename: string): string {
  return readFileSync(path.join(fixturesDir, filename), 'utf8').trim();
}

describe('abi-manifest', () => {
  it('produces canonical bytes and hash for the Host.v1 manifest', () => {
    const { bytes, hash, manifest } = hashAbiManifest(HOST_V1_MANIFEST);
    expect(manifest).toEqual(validateAbiManifest(HOST_V1_MANIFEST));
    expect(new Uint8Array(bytes)).toEqual(HOST_V1_BYTES);
    expect(hex(bytes)).toEqual(HOST_V1_BYTES_HEX);
    expect(hash).toEqual(HOST_V1_HASH);
  });

  it('hashes manifests deterministically regardless of key insertion order', () => {
    const reordered = {
      functions: HOST_V1_MANIFEST.functions.map((fn) => ({
        error_codes: fn.error_codes.map((entry) => ({
          tag: entry.tag,
          code: entry.code,
        })),
        limits: fn.limits.arg_utf8_max
          ? {
              max_units: fn.limits.max_units,
              arg_utf8_max: [...fn.limits.arg_utf8_max],
              max_response_bytes: fn.limits.max_response_bytes,
              max_request_bytes: fn.limits.max_request_bytes,
            }
          : {
              max_response_bytes: fn.limits.max_response_bytes,
              max_units: fn.limits.max_units,
              max_request_bytes: fn.limits.max_request_bytes,
            },
        gas: {
          k_units: fn.gas.k_units,
          base: fn.gas.base,
          k_ret_bytes: fn.gas.k_ret_bytes,
          schedule_id: fn.gas.schedule_id,
          k_arg_bytes: fn.gas.k_arg_bytes,
        },
        return_schema: { type: fn.return_schema.type },
        arg_schema: fn.arg_schema.map((schema) => ({ type: schema.type })),
        arity: fn.arity,
        effect: fn.effect,
        js_path: [...fn.js_path],
        fn_id: fn.fn_id,
      })),
      abi_version: HOST_V1_MANIFEST.abi_version,
      abi_id: HOST_V1_MANIFEST.abi_id,
    } satisfies AbiManifest;

    const { bytes, hash } = hashAbiManifest(reordered);
    expect(new Uint8Array(bytes)).toEqual(HOST_V1_BYTES);
    expect(hash).toEqual(HOST_V1_HASH);
  });

  it('rejects unsorted functions', () => {
    const badManifest: AbiManifest = {
      ...HOST_V1_MANIFEST,
      functions: [...HOST_V1_MANIFEST.functions].reverse(),
    };
    expect(() => validateAbiManifest(badManifest)).toThrow(AbiManifestError);
  });

  it('rejects js_path collisions', () => {
    const manifest: AbiManifest = {
      abi_id: 'Host.v1',
      abi_version: 1,
      functions: [
        {
          ...HOST_V1_MANIFEST.functions[0],
          js_path: ['emit'],
          fn_id: 1,
        },
        {
          ...HOST_V1_MANIFEST.functions[1],
          js_path: ['emit', 'nested'],
          fn_id: 2,
        },
      ],
    };

    expect(() => validateAbiManifest(manifest)).toThrow(AbiManifestError);
  });

  it('requires arg_utf8_max only on string args', () => {
    const manifest: AbiManifest = {
      abi_id: 'Host.v1',
      abi_version: 1,
      functions: [
        {
          fn_id: 1,
          js_path: ['emit'],
          effect: 'EMIT',
          arity: 1,
          arg_schema: [{ type: 'dv' }],
          return_schema: { type: 'null' },
          gas: {
            schedule_id: 'emit-v1',
            base: 1,
            k_arg_bytes: 0,
            k_ret_bytes: 0,
            k_units: 0,
          },
          limits: {
            max_request_bytes: 64,
            max_response_bytes: 64,
            max_units: 0,
            arg_utf8_max: [8],
          },
          error_codes: [],
        },
      ],
    };

    expect(() => encodeAbiManifest(manifest)).toThrow(AbiManifestError);
  });

  it('rejects unsorted error_codes', () => {
    const manifest: AbiManifest = {
      ...HOST_V1_MANIFEST,
      functions: [
        {
          ...HOST_V1_MANIFEST.functions[0],
          error_codes: [
            { code: 'LIMIT_EXCEEDED', tag: 'host/limit' },
            { code: 'INVALID_PATH', tag: 'host/invalid_path' },
          ],
        },
      ],
    };

    expect(() => validateAbiManifest(manifest)).toThrow(AbiManifestError);
  });

  it('rejects reserved host error codes', () => {
    const manifest: AbiManifest = {
      ...HOST_V1_MANIFEST,
      functions: [
        {
          ...HOST_V1_MANIFEST.functions[0],
          error_codes: [
            { code: 'HOST_ENVELOPE_INVALID', tag: 'host/envelope_invalid' },
          ],
        },
      ],
    };

    expect(() => validateAbiManifest(manifest)).toThrow(AbiManifestError);
  });

  it('rejects forbidden js_path segments', () => {
    const manifest: AbiManifest = {
      ...HOST_V1_MANIFEST,
      functions: [
        {
          ...HOST_V1_MANIFEST.functions[0],
          js_path: ['__proto__'],
        },
      ],
    };

    expect(() => validateAbiManifest(manifest)).toThrow(AbiManifestError);
  });

  it('rejects unknown fields in function entries', () => {
    const manifest: AbiManifest = {
      ...HOST_V1_MANIFEST,
      // @ts-expect-error extra field for validation test
      functions: [{ ...HOST_V1_MANIFEST.functions[0], extra: true }],
    };

    expect(() => validateAbiManifest(manifest)).toThrow(AbiManifestError);
  });

  it('rejects -0 in uint32 fields', () => {
    const manifest: AbiManifest = {
      ...HOST_V1_MANIFEST,
      abi_version: -0,
    };
    expect(() => validateAbiManifest(manifest)).toThrow(AbiManifestError);
  });

  it('rejects manifests whose gas charges overflow uint64 bounds', () => {
    const manifest: AbiManifest = {
      abi_id: 'Host.v1',
      abi_version: 1,
      functions: [
        {
          fn_id: 1,
          js_path: ['emit'],
          effect: 'EMIT',
          arity: 1,
          arg_schema: [{ type: 'dv' }],
          return_schema: { type: 'null' },
          gas: {
            schedule_id: 'emit-v1',
            base: 0xffffffff,
            k_arg_bytes: 0xffffffff,
            k_ret_bytes: 0xffffffff,
            k_units: 0xffffffff,
          },
          limits: {
            max_request_bytes: 1_048_576,
            max_response_bytes: 1_048_576,
            max_units: 0xffffffff,
          },
          error_codes: [],
        },
      ],
    };

    expect(() => validateAbiManifest(manifest)).toThrow(AbiManifestError);
  });

  it('hashes existing bytes directly', () => {
    expect(hashAbiManifestBytes(HOST_V1_BYTES)).toEqual(HOST_V1_HASH);

    const bytes = encodeAbiManifest(HOST_V1_MANIFEST);
    expect(new Uint8Array(bytes)).toEqual(HOST_V1_BYTES);
    expect(hashAbiManifestBytes(bytes)).toEqual(HOST_V1_HASH);
  });
});

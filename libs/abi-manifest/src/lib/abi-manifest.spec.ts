import { Buffer } from 'node:buffer';

import {
  AbiManifest,
  AbiManifestError,
  encodeAbiManifest,
  hashAbiManifest,
  hashAbiManifestBytes,
  validateAbiManifest,
} from './abi-manifest.js';

const HOST_V1_MANIFEST: AbiManifest = {
  abi_id: 'Host.v1',
  abi_version: 1,
  functions: [
    {
      fn_id: 1,
      js_path: ['document', 'get'],
      effect: 'READ',
      arity: 1,
      arg_schema: [{ type: 'string' }],
      return_schema: { type: 'dv' },
      gas: {
        schedule_id: 'doc-read-v1',
        base: 20,
        k_arg_bytes: 1,
        k_ret_bytes: 1,
        k_units: 1,
      },
      limits: {
        max_request_bytes: 4096,
        max_response_bytes: 262144,
        max_units: 1000,
        arg_utf8_max: [2048],
      },
      error_codes: [
        { code: 'INVALID_PATH', tag: 'host/invalid_path' },
        { code: 'LIMIT_EXCEEDED', tag: 'host/limit' },
        { code: 'NOT_FOUND', tag: 'host/not_found' },
      ],
    },
    {
      fn_id: 2,
      js_path: ['document', 'getCanonical'],
      effect: 'READ',
      arity: 1,
      arg_schema: [{ type: 'string' }],
      return_schema: { type: 'dv' },
      gas: {
        schedule_id: 'doc-read-v1',
        base: 20,
        k_arg_bytes: 1,
        k_ret_bytes: 1,
        k_units: 1,
      },
      limits: {
        max_request_bytes: 4096,
        max_response_bytes: 262144,
        max_units: 1000,
        arg_utf8_max: [2048],
      },
      error_codes: [
        { code: 'INVALID_PATH', tag: 'host/invalid_path' },
        { code: 'LIMIT_EXCEEDED', tag: 'host/limit' },
        { code: 'NOT_FOUND', tag: 'host/not_found' },
      ],
    },
    {
      fn_id: 3,
      js_path: ['emit'],
      effect: 'EMIT',
      arity: 1,
      arg_schema: [{ type: 'dv' }],
      return_schema: { type: 'null' },
      gas: {
        schedule_id: 'emit-v1',
        base: 5,
        k_arg_bytes: 1,
        k_ret_bytes: 0,
        k_units: 1,
      },
      limits: {
        max_request_bytes: 32768,
        max_response_bytes: 64,
        max_units: 1024,
      },
      error_codes: [{ code: 'LIMIT_EXCEEDED', tag: 'host/limit' }],
    },
  ],
};

const HOST_V1_BYTES_HEX =
  'a3666162695f696467486f73742e76316966756e6374696f6e7383a963676173a5646261736514676b5f756e697473016b6b5f6172675f6279746573016b6b5f7265745f6279746573016b7363686564756c655f69646b646f632d726561642d76316561726974790165666e5f696401666566666563746452454144666c696d697473a4696d61785f756e6974731903e86c6172675f757466385f6d617881190800716d61785f726571756573745f6279746573191000726d61785f726573706f6e73655f62797465731a00040000676a735f706174688268646f63756d656e74636765746a6172675f736368656d6181a1647479706566737472696e676b6572726f725f636f64657383a26374616771686f73742f696e76616c69645f7061746864636f64656c494e56414c49445f50415448a2637461676a686f73742f6c696d697464636f64656e4c494d49545f4558434545444544a2637461676e686f73742f6e6f745f666f756e6464636f6465694e4f545f464f554e446d72657475726e5f736368656d61a16474797065626476a963676173a5646261736514676b5f756e697473016b6b5f6172675f6279746573016b6b5f7265745f6279746573016b7363686564756c655f69646b646f632d726561642d76316561726974790165666e5f696402666566666563746452454144666c696d697473a4696d61785f756e6974731903e86c6172675f757466385f6d617881190800716d61785f726571756573745f6279746573191000726d61785f726573706f6e73655f62797465731a00040000676a735f706174688268646f63756d656e746c67657443616e6f6e6963616c6a6172675f736368656d6181a1647479706566737472696e676b6572726f725f636f64657383a26374616771686f73742f696e76616c69645f7061746864636f64656c494e56414c49445f50415448a2637461676a686f73742f6c696d697464636f64656e4c494d49545f4558434545444544a2637461676e686f73742f6e6f745f666f756e6464636f6465694e4f545f464f554e446d72657475726e5f736368656d61a16474797065626476a963676173a5646261736505676b5f756e697473016b6b5f6172675f6279746573016b6b5f7265745f6279746573006b7363686564756c655f696467656d69742d76316561726974790165666e5f6964036665666665637464454d4954666c696d697473a3696d61785f756e697473190400716d61785f726571756573745f6279746573198000726d61785f726573706f6e73655f62797465731840676a735f706174688164656d69746a6172675f736368656d6181a164747970656264766b6572726f725f636f64657381a2637461676a686f73742f6c696d697464636f64656e4c494d49545f45584345454445446d72657475726e5f736368656d61a16474797065646e756c6c6b6162695f76657273696f6e01';

const HOST_V1_HASH =
  'e23b0b2ee169900bbde7aff78e6ce20fead1715c60f8a8e3106d9959450a3d34';

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

describe('abi-manifest', () => {
  it('produces canonical bytes and hash for the Host.v1 manifest', () => {
    const { bytes, hash, manifest } = hashAbiManifest(HOST_V1_MANIFEST);
    expect(manifest).toEqual(validateAbiManifest(HOST_V1_MANIFEST));
    expect(hex(bytes)).toEqual(HOST_V1_BYTES_HEX);
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
    const bytes = encodeAbiManifest(HOST_V1_MANIFEST);
    expect(hashAbiManifestBytes(bytes)).toEqual(HOST_V1_HASH);
  });
});

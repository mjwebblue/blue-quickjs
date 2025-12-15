#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jiti from 'jiti';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const harnessPath = path.join(
  repoRoot,
  'tools',
  'quickjs-native-harness',
  'dist',
  'quickjs-native-harness',
);

if (!existsSync(harnessPath)) {
  throw new Error(
    `Native harness not found at ${harnessPath}. Build quickjs-native-harness first.`,
  );
}

const require = jiti(import.meta.url);
const { encodeDv, decodeDv } = require('../../../libs/dv/src/index.ts');

const encodeFixtures = [
  { name: 'null', expr: 'null', value: null },
  { name: 'boolean', expr: 'true', value: true },
  { name: 'int', expr: '42', value: 42 },
  { name: 'negative-int', expr: '-17', value: -17 },
  { name: 'float', expr: '1.5', value: 1.5 },
  { name: 'string', expr: '"hello"', value: 'hello' },
  { name: 'string-null-byte', expr: '"a\\u0000b"', value: 'a\u0000b' },
  { name: 'unicode', expr: '"\\u263a"', value: '\u263a' },
  { name: 'array', expr: '["hello", 1.5, -1]', value: ['hello', 1.5, -1] },
  { name: 'object-ordering', expr: '({ b: 2, aa: 1 })', value: { b: 2, aa: 1 } },
  {
    name: 'null-proto-object',
    expr: '(() => { const o = Object.create(null); o.a = 1; o.b = "c"; return o; })()',
    value: Object.assign(Object.create(null), { a: 1, b: 'c' }),
  },
  {
    name: 'nested',
    expr: '({ nested: [1, { z: "hi" }], flag: false })',
    value: { nested: [1, { z: 'hi' }], flag: false },
  },
  {
    name: 'object-global-object-replacement',
    expr: '(() => { function Fake() {} Fake.prototype = { hacked: true }; globalThis.Object = Fake; return { a: 1 }; })()',
    value: { a: 1 },
  },
  {
    name: 'emoji-non-bmp',
    expr: '"\\uD83D\\uDE00"',
    value: '\uD83D\uDE00',
  },
  { name: 'empty-array', expr: '[]', value: [] },
  { name: 'empty-object', expr: '({})', value: {} },
  { name: 'negative-zero', expr: '-0', value: -0 },
];

const encodeErrorFixtures = [
  {
    name: 'encode-lone-surrogate',
    expr: '"a\\uD800"',
    value: 'a\uD800',
    errorContains: 'lone surrogate code points',
  },
];

const decodeErrorFixtures = [
  {
    name: 'decode-non-canonical-int-width',
    hex: '1801',
    errorContains: 'length not using shortest encoding',
  },
  {
    name: 'decode-float32',
    hex: 'fa3f800000',
    errorContains: 'only float64 is allowed',
  },
  {
    name: 'decode-byte-string',
    hex: '40',
    errorContains: 'unsupported CBOR major type',
  },
  {
    name: 'decode-trailing-bytes',
    hex: 'f6f6',
    errorContains: 'unexpected trailing bytes after DV value',
  },
  {
    name: 'decode-non-text-map-key',
    hex: 'a10101',
    errorContains: 'map keys must be text strings',
  },
  {
    name: 'decode-map-key-order',
    hex: 'a262616101616202',
    errorContains: 'map keys are not in canonical order',
  },
];

const toHex = (bytes) =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const runHarness = (args, label) => {
  const result = spawnSync(harnessPath, args, { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  return {
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    status: result.status ?? 0,
    label,
  };
};

const expectSuccess = (result, prefix) => {
  if (result.status !== 0) {
    throw new Error(
      `${result.label ?? 'harness'} exited with ${result.status}: stdout="${result.stdout}" stderr="${result.stderr}"`,
    );
  }
  if (!result.stdout.startsWith(prefix)) {
    throw new Error(
      `Unexpected output for ${result.label ?? 'harness'}: stdout="${result.stdout}" stderr="${result.stderr}"`,
    );
  }
};

const expectError = (result, context) => {
  if (result.status === 0) {
    throw new Error(
      `Expected harness error for ${context}, got status=0 stdout="${result.stdout}" stderr="${result.stderr}"`,
    );
  }
  const prefix = 'ERROR ';
  if (!result.stdout.startsWith(prefix)) {
    throw new Error(
      `Expected error output for ${context}: stdout="${result.stdout}" stderr="${result.stderr}" status=${result.status}`,
    );
  }
  return result.stdout.slice(prefix.length);
};

const runHarnessEncode = (expr) => {
  const result = runHarness(['--dv-encode', '--eval', expr], `encode ${expr}`);
  expectSuccess(result, 'DV ');
  return result.stdout.slice('DV '.length);
};

const runHarnessDecode = (hex) => {
  const result = runHarness(['--dv-decode', hex], `decode ${hex}`);
  expectSuccess(result, 'DVRESULT ');
  return result.stdout.slice('DVRESULT '.length);
};

const runHarnessEncodeError = (expr) => {
  const result = runHarness(['--dv-encode', '--eval', expr], `encode ${expr}`);
  return expectError(result, `encode ${expr}`);
};

const runHarnessDecodeError = (hex) => {
  const result = runHarness(['--dv-decode', hex], `decode ${hex}`);
  return expectError(result, `decode ${hex}`);
};

for (const fixture of encodeFixtures) {
  const encoded = encodeDv(fixture.value);
  const expectedHex = toHex(encoded);
  const harnessHex = runHarnessEncode(fixture.expr);
  assert.strictEqual(
    harnessHex,
    expectedHex,
    `encode mismatch for ${fixture.name}`,
  );

  const expectedJson = JSON.stringify(decodeDv(encoded));
  const harnessJson = runHarnessDecode(expectedHex);
  assert.strictEqual(
    harnessJson,
    expectedJson,
    `decode mismatch for ${fixture.name}`,
  );
}

for (const fixture of encodeErrorFixtures) {
  assert.throws(
    () => encodeDv(fixture.value),
    new RegExp(fixture.errorContains),
    `TS encode should reject ${fixture.name}`,
  );
  const harnessError = runHarnessEncodeError(fixture.expr);
  assert.ok(
    harnessError.includes(fixture.errorContains),
    `encode error mismatch for ${fixture.name}: ${harnessError}`,
  );
}

for (const fixture of decodeErrorFixtures) {
  assert.throws(
    () => decodeDv(Buffer.from(fixture.hex, 'hex')),
    new RegExp(fixture.errorContains),
    `TS decode should reject ${fixture.name}`,
  );
  const harnessError = runHarnessDecodeError(fixture.hex);
  assert.ok(
    harnessError.includes(fixture.errorContains),
    `decode error mismatch for ${fixture.name}: ${harnessError}`,
  );
}

console.log('DV parity against TS reference: ok');
console.log('DV rejection parity cases: ok');

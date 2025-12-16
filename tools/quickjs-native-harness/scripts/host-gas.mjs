#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..', '..');
const harnessRoot = join(repoRoot, 'tools', 'quickjs-native-harness');
const fixturesRoot = join(
  repoRoot,
  'libs',
  'test-harness',
  'fixtures',
  'abi-manifest',
);
const binPath = join(harnessRoot, 'dist', 'quickjs-native-harness');

if (!existsSync(binPath)) {
  console.error(`Harness binary not found at ${binPath}. Run build first.`);
  process.exit(1);
}

const manifestHex = readFileSync(
  join(fixturesRoot, 'host-v1.bytes.hex'),
  'utf8',
).replace(/[\r\n\s]+/g, '');
const manifestHash = readFileSync(join(fixturesRoot, 'host-v1.hash'), 'utf8')
  .replace(/[\r\n\s]+/g, '')
  .trim();
const manifestArgs = [
  '--abi-manifest-hex',
  manifestHex,
  '--abi-manifest-hash',
  manifestHash,
];

const cases = [
  {
    name: 'document-get-ok',
    code: "Host.v1.document.get('foo')",
    requestExpr: "['foo']",
    responseExpr: "({ ok: 'foo', units: 1 })",
    units: 1,
    gas: { base: 20, kArg: 1, kRet: 1, kUnits: 1 },
  },
  {
    name: 'document-get-error',
    code: "Host.v1.document.get('missing')",
    requestExpr: "['missing']",
    responseExpr: "({ err: { code: 'NOT_FOUND' }, units: 2 })",
    units: 2,
    gas: { base: 20, kArg: 1, kRet: 1, kUnits: 1 },
  },
  {
    name: 'emit-null',
    code: 'Host.v1.emit({ a: 1 })',
    requestExpr: '[{ a: 1 }]',
    responseExpr: '({ ok: null, units: 0 })',
    units: 0,
    gas: { base: 5, kArg: 1, kRet: 0, kUnits: 1 },
  },
];

function dvLength(expr) {
  const result = spawnSync(binPath, ['--dv-encode', '--eval', expr], {
    encoding: 'utf8',
  });
  if (result.error) {
    throw new Error(`dv encode spawn error: ${result.error.message}`);
  }
  const stdout = (result.stdout || '').trim();
  const match = stdout.match(/^DV\s+([0-9a-fA-F]+)$/);
  if (!match) {
    throw new Error(`Unexpected dv encode output: ${stdout}`);
  }
  const hex = match[1].replace(/\s+/g, '');
  return hex.length / 2;
}

function runHarness(code) {
  const args = [
    ...manifestArgs,
    '--gas-limit',
    '10000',
    '--report-gas',
    '--gas-trace',
    '--eval',
    code,
  ];
  const result = spawnSync(binPath, args, { encoding: 'utf8' });
  if (result.error) {
    throw new Error(`harness spawn error: ${result.error.message}`);
  }
  const stdout = (result.stdout || '').trim();
  if (!stdout) {
    throw new Error('Harness produced no stdout');
  }
  const usedMatch = stdout.match(/used=(\d+)/);
  const traceMatch = stdout.match(/TRACE (\{.*\})/);
  if (!usedMatch || !traceMatch) {
    throw new Error(`Missing gas or trace in output: ${stdout}`);
  }

  const used = Number(usedMatch[1]);
  const trace = JSON.parse(traceMatch[1]);
  return { used, trace, raw: stdout, status: result.status };
}

function computeNonHostGas(trace) {
  const opcode = Number(trace.opcodeGas || 0);
  const arrayBase = Number(trace.arrayCbBase?.gas || 0);
  const arrayPerEl = Number(trace.arrayCbPerEl?.gas || 0);
  const alloc = Number(trace.alloc?.gas || 0);
  return opcode + arrayBase + arrayPerEl + alloc;
}

const failures = [];

for (const test of cases) {
  const reqLen = dvLength(test.requestExpr);
  const respLen = dvLength(test.responseExpr);
  const expectedHostGas =
    test.gas.base +
    test.gas.kArg * reqLen +
    test.gas.kRet * respLen +
    test.gas.kUnits * test.units;

  const run = runHarness(test.code);
  const nonHost = computeNonHostGas(run.trace);
  const hostGas = run.used - nonHost;

  if (hostGas !== expectedHostGas) {
    failures.push({
      name: test.name,
      expected: expectedHostGas,
      actual: hostGas,
      raw: run.raw,
    });
  }
}

if (failures.length > 0) {
  console.error('Host gas mismatches:');
  for (const failure of failures) {
    console.error(
      `- ${failure.name}: expected ${failure.expected}, actual ${failure.actual}`,
    );
    console.error(`  output: ${failure.raw}`);
  }
  process.exit(1);
}

console.log(`Host gas suite passed (${cases.length} cases)`);

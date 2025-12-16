#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..', '..');
const harnessRoot = join(repoRoot, 'tools', 'quickjs-native-harness');
const fixturesRoot = join(harnessRoot, 'fixtures');
const binPath = join(harnessRoot, 'dist', 'quickjs-native-harness');
const fixturesPath = join(scriptDir, 'gas-goldens.json');
const manifestHex = readFileSync(
  join(
    repoRoot,
    'libs',
    'test-harness',
    'fixtures',
    'abi-manifest',
    'host-v1.bytes.hex',
  ),
  'utf8',
).replace(/[\r\n\s]+/g, '');
const manifestHash = readFileSync(
  join(
    repoRoot,
    'libs',
    'test-harness',
    'fixtures',
    'abi-manifest',
    'host-v1.hash',
  ),
  'utf8',
).trim();
const manifestArgs = [
  '--abi-manifest-hex',
  manifestHex,
  '--abi-manifest-hash',
  manifestHash,
];

if (!existsSync(binPath)) {
  console.error(`Harness binary not found at ${binPath}. Run build first.`);
  process.exit(1);
}

const cases = JSON.parse(readFileSync(fixturesPath, 'utf8'));

const failures = [];

for (const testCase of cases) {
  const codePath = join(fixturesRoot, testCase.fixture);
  const code = readFileSync(codePath, 'utf8');
  const args = [...manifestArgs, ...(testCase.args || []), '--eval', code];

  const result = spawnSync(binPath, args, { encoding: 'utf8' });
  const stdout = (result.stdout || '').trim();
  if (result.error) {
    failures.push({
      name: testCase.name,
      expected: testCase.expected,
      actual: `spawn error: ${result.error.message}`,
    });
    continue;
  }

  if (stdout !== testCase.expected) {
    failures.push({
      name: testCase.name,
      expected: testCase.expected,
      actual: stdout,
    });
  }
}

if (failures.length > 0) {
  console.error('Gas golden mismatches:');
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
    console.error(`  expected: ${failure.expected}`);
    console.error(`  actual:   ${failure.actual}`);
  }
  process.exit(1);
}

console.log(`Gas golden suite passed (${cases.length} cases)`);

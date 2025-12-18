import type { AbiManifest } from '@blue-quickjs/abi-manifest';
import { HOST_V1_HASH, HOST_V1_MANIFEST } from './abi-manifest-fixtures.js';
import {
  DETERMINISM_INPUT,
  type DeterminismInputEnvelope,
  type DeterminismHostEnvironment,
  type DeterminismProgramArtifact,
  createDeterminismHost,
} from './determinism-fixtures.js';

export interface GasFixtureBaseline {
  resultHash: string;
  gasUsed: bigint;
  gasRemaining: bigint;
}

export interface GasFixtureRepeatBaseline {
  count: number;
  expectedGasUsed: bigint;
}

export interface GasFixture {
  name: string;
  program: DeterminismProgramArtifact;
  input: DeterminismInputEnvelope;
  gasLimit: bigint;
  manifest: AbiManifest;
  createHost: (input: DeterminismInputEnvelope) => DeterminismHostEnvironment;
  expected: GasFixtureBaseline;
  repeatSameContext?: GasFixtureRepeatBaseline;
}

export const GAS_SAMPLE_GAS_LIMIT = 1_000_000n;

const BASE_PROGRAM = {
  abiId: 'Host.v1',
  abiVersion: 1,
  abiManifestHash: HOST_V1_HASH,
} satisfies Omit<DeterminismProgramArtifact, 'code'>;

export const GAS_SAMPLE_FIXTURES: GasFixture[] = [
  {
    name: 'return-1',
    program: {
      ...BASE_PROGRAM,
      code: '(() => 1)()',
    },
    input: DETERMINISM_INPUT,
    gasLimit: GAS_SAMPLE_GAS_LIMIT,
    manifest: HOST_V1_MANIFEST,
    createHost: createDeterminismHost,
    expected: {
      resultHash:
        '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a',
      gasUsed: 179n,
      gasRemaining: 999821n,
    },
  },
  {
    name: 'loop-1k',
    program: {
      ...BASE_PROGRAM,
      code: `
        (() => {
          let sum = 0;
          for (let i = 0; i < 1000; i += 1) {
            sum += i;
          }
          return sum;
        })()
      `.trim(),
    },
    input: DETERMINISM_INPUT,
    gasLimit: GAS_SAMPLE_GAS_LIMIT,
    manifest: HOST_V1_MANIFEST,
    createHost: createDeterminismHost,
    expected: {
      resultHash:
        '5092d78885546599f50436ac88fee579843061290508ac2ef0efa541297e405b',
      gasUsed: 17347n,
      gasRemaining: 982653n,
    },
  },
  {
    name: 'loop-10k',
    program: {
      ...BASE_PROGRAM,
      code: `
        (() => {
          let sum = 0;
          for (let i = 0; i < 10000; i += 1) {
            sum += i;
          }
          return sum;
        })()
      `.trim(),
    },
    input: DETERMINISM_INPUT,
    gasLimit: GAS_SAMPLE_GAS_LIMIT,
    manifest: HOST_V1_MANIFEST,
    createHost: createDeterminismHost,
    expected: {
      resultHash:
        'a3fa3495623f19996818ce7b196fc524e687ef2cc4910a6ff628a76460c4e557',
      gasUsed: 170347n,
      gasRemaining: 829653n,
    },
    repeatSameContext: {
      count: 5,
      expectedGasUsed: 170347n,
    },
  },
  {
    name: 'string-concat',
    program: {
      ...BASE_PROGRAM,
      code: `
        (() => {
          const arr = [];
          for (let i = 0; i < 1000; i += 1) {
            arr.push({ x: i, y: i * 2, s: "item" + i });
          }
          return arr.length;
        })()
      `.trim(),
    },
    input: DETERMINISM_INPUT,
    gasLimit: GAS_SAMPLE_GAS_LIMIT,
    manifest: HOST_V1_MANIFEST,
    createHost: createDeterminismHost,
    expected: {
      resultHash:
        '5e8f74961ede79063fa728a34d36f7baf4a563b225df62e4eb9349b94d612a3f',
      gasUsed: 61139n,
      gasRemaining: 938861n,
    },
  },
  {
    name: 'object-alloc',
    program: {
      ...BASE_PROGRAM,
      code: `
        (() => {
          const arr = [];
          for (let i = 0; i < 1000; i += 1) {
            arr.push({ x: i, y: i * 2, z: i * 3 });
          }
          return arr.length;
        })()
      `.trim(),
    },
    input: DETERMINISM_INPUT,
    gasLimit: GAS_SAMPLE_GAS_LIMIT,
    manifest: HOST_V1_MANIFEST,
    createHost: createDeterminismHost,
    expected: {
      resultHash:
        '5e8f74961ede79063fa728a34d36f7baf4a563b225df62e4eb9349b94d612a3f',
      gasUsed: 51115n,
      gasRemaining: 948885n,
    },
  },
  {
    name: 'array-ops',
    program: {
      ...BASE_PROGRAM,
      code: `
        (() => {
          const arr = new Array(1000);
          for (let i = 0; i < 1000; i += 1) {
            arr[i] = i * 2 + 1;
          }
          let sum = 0;
          for (let i = 0; i < 1000; i += 1) {
            sum += arr[i];
          }
          return sum;
        })()
      `.trim(),
    },
    input: DETERMINISM_INPUT,
    gasLimit: GAS_SAMPLE_GAS_LIMIT,
    manifest: HOST_V1_MANIFEST,
    createHost: createDeterminismHost,
    expected: {
      resultHash:
        'cbbec14103147af122feaff2419ad885d372d04bfd9d0af1714dd20dff24b6e3',
      gasUsed: 40203n,
      gasRemaining: 959797n,
    },
  },
];

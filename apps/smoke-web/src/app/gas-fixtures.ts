/* eslint-disable @nx/enforce-module-boundaries */

import additionSource from '../../../../tools/quickjs-native-harness/fixtures/gas/addition.js?raw';
import constantSource from '../../../../tools/quickjs-native-harness/fixtures/gas/constant.js?raw';
import loopCounterSource from '../../../../tools/quickjs-native-harness/fixtures/gas/loop-counter.js?raw';
import stringRepeatSource from '../../../../tools/quickjs-native-harness/fixtures/gas/string-repeat.js?raw';
import zeroPrechargeSource from '../../../../tools/quickjs-native-harness/fixtures/gas/zero-precharge.js?raw';

export interface GasFixture {
  name: string;
  gasLimit: bigint;
  expected: string;
  source: string;
}

export const gasFixtures: GasFixture[] = [
  {
    name: 'zero-precharge',
    gasLimit: 0n,
    expected: 'ERROR OutOfGas: out of gas GAS remaining=0 used=0',
    source: zeroPrechargeSource.trim(),
  },
  {
    name: 'gc-checkpoint-budget',
    gasLimit: 54n,
    expected: 'ERROR OutOfGas: out of gas GAS remaining=0 used=54',
    source: zeroPrechargeSource.trim(),
  },
  {
    name: 'loop-oog',
    gasLimit: 600n,
    expected: 'RESULT 3 GAS remaining=30 used=570',
    source: loopCounterSource.trim(),
  },
  {
    name: 'constant',
    gasLimit: 147n,
    expected: 'RESULT 1 GAS remaining=22 used=125',
    source: constantSource.trim(),
  },
  {
    name: 'addition',
    gasLimit: 154n,
    expected: 'RESULT 3 GAS remaining=22 used=132',
    source: additionSource.trim(),
  },
  {
    name: 'string-repeat',
    gasLimit: 5000n,
    expected: 'RESULT 32768 GAS remaining=2651 used=2349',
    source: stringRepeatSource.trim(),
  },
];

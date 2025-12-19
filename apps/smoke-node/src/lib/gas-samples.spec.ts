import { createHash } from 'crypto';

import { encodeDv } from '@blue-quickjs/dv';
import {
  GAS_SAMPLE_FIXTURES,
  parseDeterministicEvalOutput,
} from '@blue-quickjs/test-harness';
import {
  createRuntime,
  evaluate,
  initializeDeterministicVm,
} from '@blue-quickjs/quickjs-runtime';

describe('smoke-node gas samples', () => {
  it('captures baseline usage for representative scripts', async () => {
    for (const fixture of GAS_SAMPLE_FIXTURES) {
      const host = fixture.createHost();
      const result = await evaluate({
        program: fixture.program,
        input: fixture.input,
        gasLimit: fixture.gasLimit,
        manifest: fixture.manifest,
        handlers: host.handlers,
      });

      if (!result.ok) {
        throw new Error(
          `expected ${fixture.name} to succeed, got ${result.error.code}`,
        );
      }

      expect({
        resultHash: hashDv(result.value),
        gasUsed: result.gasUsed.toString(),
        gasRemaining: result.gasRemaining.toString(),
      }).toEqual({
        resultHash: fixture.expected.resultHash,
        gasUsed: fixture.expected.gasUsed.toString(),
        gasRemaining: fixture.expected.gasRemaining.toString(),
      });
    }
  });

  it('produces identical gas usage across repeated runs', async () => {
    const repeatFixture = GAS_SAMPLE_FIXTURES.find(
      (fixture) => fixture.repeatSameContext,
    );
    if (!repeatFixture || !repeatFixture.repeatSameContext) {
      throw new Error('missing repeat gas fixture');
    }

    const host = repeatFixture.createHost();
    const runtime = await createRuntime({
      manifest: repeatFixture.manifest,
      handlers: host.handlers,
    });
    const vm = initializeDeterministicVm(
      runtime,
      repeatFixture.program,
      repeatFixture.input,
      repeatFixture.gasLimit,
    );

    const measurements: string[] = [];
    try {
      vm.setGasLimit(repeatFixture.gasLimit);
      const warmup = parseDeterministicEvalOutput(
        vm.eval(repeatFixture.program.code),
      );
      if (warmup.kind === 'error') {
        throw new Error(`${repeatFixture.name} warmup failed: ${warmup.error}`);
      }

      for (let i = 0; i < repeatFixture.repeatSameContext.count; i += 1) {
        vm.setGasLimit(repeatFixture.gasLimit);
        const output = parseDeterministicEvalOutput(
          vm.eval(repeatFixture.program.code),
        );
        if (output.kind === 'error') {
          throw new Error(`${repeatFixture.name} failed: ${output.error}`);
        }
        measurements.push(output.gasUsed.toString());
      }
    } finally {
      vm.dispose();
    }

    const unique = new Set(measurements);
    expect(unique.size).toBe(1);
    expect(measurements[0]).toBe(
      repeatFixture.repeatSameContext.expectedGasUsed.toString(),
    );
  });
});

function hashDv(value: unknown): string {
  const encoded = encodeDv(value);
  return sha256Hex(encoded);
}

function sha256Hex(input: Uint8Array | string): string {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return createHash('sha256').update(bytes).digest('hex');
}

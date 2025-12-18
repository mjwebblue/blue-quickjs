import { SMOKE_BASELINE, SMOKE_PROGRAM } from './fixtures.js';
import { runSmokeNode } from './smoke-node.js';

describe('smokeNode', () => {
  it('runs the sample fixture and reports a stable summary', async () => {
    const log: string[] = [];
    const summary = await runSmokeNode({ log: (line) => log.push(line) });

    expect(summary.status).toBe('ok');
    expect(summary.manifestHash).toBe(SMOKE_PROGRAM.abiManifestHash);
    expect(summary.manifestHash).toBe(SMOKE_BASELINE.manifestHash);
    expect(summary.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.resultHash).toBe(SMOKE_BASELINE.resultHash);
    expect(summary.gasUsed).toBe(SMOKE_BASELINE.gasUsed);
    expect(summary.gasRemaining).toBe(SMOKE_BASELINE.gasRemaining);
    expect(summary.tapeCount).toBe(SMOKE_BASELINE.tapeLength);
    expect(summary.tapeHash).toBe(SMOKE_BASELINE.tapeHash);
    expect(summary.emitted.length).toBe(SMOKE_BASELINE.emittedCount);
    expect(summary.value).toMatchObject({ marker: 'smoke-node' });
    expect(log.some((line) => line.includes('result hash'))).toBe(true);
  });
});

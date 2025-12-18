import { runSmokeNode } from './lib/smoke-node.js';

const args = new Set(process.argv.slice(2));
const debug =
  args.has('--debug') || process.env.SMOKE_NODE_DEBUG === '1' || false;
const quiet = args.has('--quiet') || args.has('-q');

const summary = await runSmokeNode({
  debug,
  log: quiet ? () => undefined : undefined,
});

if (summary.status !== 'ok') {
  process.exitCode = 1;
}

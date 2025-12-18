# smoke-node

Node smoke runner for the deterministic QuickJS wasm evaluator.

## Usage

- `pnpm nx serve smoke-node` – builds and runs the sample fixture with mock host handlers, printing DV result hash, gas used/remaining, host tape count, and any error code/tag.
- `pnpm nx serve smoke-node -- --debug` – also pretty-prints the DV payloads and emitted values.
- `pnpm nx serve smoke-node -- --quiet` – suppresses logs (useful for CI sanity checks).

## Development

- Build: `pnpm nx build smoke-node`
- Test: `pnpm nx test smoke-node`

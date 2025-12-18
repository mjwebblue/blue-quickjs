# Release Checklist

Scope: steps to publish deterministic engine + ABI packages.

## Preflight

- Confirm the working tree is clean and `vendor/quickjs` is pinned to the intended commit.
- Run `pnpm lint`, `pnpm nx typecheck`, `pnpm nx test`, and `pnpm nx build`.

## Wasm build + metadata

- Run `pnpm nx build quickjs-wasm-build`.
- Verify `libs/quickjs-wasm-build/dist/quickjs-wasm-build.metadata.json`:
  - `engineBuildHash` is present.
  - `variants.wasm32.release.engineBuildHash` matches `sha256` of `quickjs-eval.wasm`.
- Run `pnpm nx build quickjs-wasm` and confirm `libs/quickjs-wasm/dist/wasm` contains
  wasm, loader, and metadata assets.

## Manifest + fixtures

- If the manifest changed:
  - Re-encode + hash with `@blue-quickjs/abi-manifest`.
  - Update `libs/test-harness/fixtures/abi-manifest/*` and any tests that pin `HOST_V1_HASH`.

## Versioning

- Choose the semver bump per `docs/release-policy.md`.
- Update versions in:
  - `libs/dv/package.json`
  - `libs/abi-manifest/package.json`
  - `libs/quickjs-wasm/package.json`
  - `libs/quickjs-runtime/package.json`

## Publish

- Publish the four packages from their package roots after build (dist/ is included in `files`).
- Tag the release and record the engine build hash + manifest hash in the release notes.

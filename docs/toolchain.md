# Toolchain — Emscripten/emsdk

Deterministic Wasm builds rely on a pinned Emscripten toolchain. We vendor `emsdk` locally under `tools/emsdk` and lock the version in `tools/scripts/emsdk-version.txt`.

Baseline anchors: see `docs/baseline-1.md` (deterministic execution constraints) and `docs/baseline-2.md` (host ABI contract that must be consistent across environments).

## Pinned version
- Emscripten/emsdk: `3.1.56` (see `tools/scripts/emsdk-version.txt`).
- Install location: `tools/emsdk` (ignored from commits).

## Local setup
1) From repo root: `tools/scripts/setup-emsdk.sh`  
   - Clones `emsdk` into `tools/emsdk` if missing.  
   - Installs + activates the pinned version.
2) Load env into your shell for the session: `source tools/emsdk/emsdk_env.sh`.
3) Verify: `emcc --version` should report `3.1.56`.

Notes:
- Script is idempotent; rerun after pulling a new pinned version.
- Keep `emsdk` network access unblocked during install.

## CI caching
- Cache the `tools/emsdk` directory keyed by the contents of `tools/scripts/emsdk-version.txt`.
- CI step order:
  1) Restore `tools/emsdk` cache (if any).
  2) Run `tools/scripts/setup-emsdk.sh` to ensure the pinned version is present.
  3) `source tools/emsdk/emsdk_env.sh` before build steps.

## Usage reminders
- Nx targets that compile QuickJS to Wasm should depend on `emcc` from the sourced env, not a system install.
- If multiple shells are used, each shell must source `emsdk_env.sh` before invoking build scripts.

## Deterministic Wasm build settings
- `libs/quickjs-wasm-build/scripts/build-wasm.sh` sets `SOURCE_DATE_EPOCH=1704067200` (override by exporting your own) and passes `-sDETERMINISTIC=1` so wasm/loader bytes do not pick up timestamps or host env differences.
- Memory is fixed: `-sINITIAL_MEMORY=33554432` and `-sMAXIMUM_MEMORY=33554432` with `-sALLOW_MEMORY_GROWTH=0`, a 1 MiB stack, and `-sALLOW_TABLE_GROWTH=0`.
- Host surface only: the Emscripten filesystem is stripped (`-sFILESYSTEM=0`), and the environment is limited to `node,web` with `-sNO_EXIT_RUNTIME=1`; no FS/network syscalls are available to the wasm module.
- Built artifacts record these settings in `dist/quickjs-wasm-build.metadata.json` under `build.memory` and `build.determinism` for auditability.
- By default the build emits both release and debug wasm32 artifacts; set `WASM_BUILD_TYPES=release` to skip debug. Debug builds add Emscripten assertions/stack-overflow checks while keeping the same deterministic VM semantics.

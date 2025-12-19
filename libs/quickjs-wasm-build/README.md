# quickjs-wasm-build

Early Emscripten build of the deterministic QuickJS fork with gas metering.

## Building

- Ensure the pinned toolchain is installed (`tools/scripts/setup-emsdk.sh`) and `vendor/quickjs` is initialized.
- Run `pnpm nx build quickjs-wasm-build` to compile the wasm harness and emit both release and debug wasm32 artifacts (`quickjs-eval{,-debug}.{js,wasm}`) to `libs/quickjs-wasm-build/dist/`. TypeScript outputs also land in this directory.
- Set `WASM_BUILD_TYPES=release` to skip debug builds, or `WASM_BUILD_TYPES=release,debug` (default) to emit both. Set `WASM_VARIANTS=wasm32,wasm64` to also emit the memory64 artifacts (`quickjs-eval-wasm64{,-debug}.{js,wasm}`) used with `QJS_WASM_VARIANT=wasm64` in tests.
- Wasm memory is fixed at 32 MiB (1 MiB stack) with growth disabled; the Emscripten filesystem is stripped (`-sFILESYSTEM=0`), and we build with `-sDETERMINISTIC=1` plus a pinned `SOURCE_DATE_EPOCH=1704067200` to avoid timestamp/env noise in the wasm/loader.
- The build also emits `quickjs-wasm-build.metadata.json` in `dist/`, capturing the QuickJS version/commit, pinned emscripten version, deterministic build settings (memory + flags), per-variant/per-build-type artifact sizes and SHA-256 hashes (including the `buildType` and flags used), and `engineBuildHash` (sha256 of wasm bytes, with the top-level hash pointing at wasm32 release when present). Access it via `getQuickjsWasmMetadataPath()` / `readQuickjsWasmMetadata()`.

The ESM loader exports a `QuickJSGasWasm` factory; the harness exports deterministic ABI entrypoints only:

- `qjs_det_init(manifest_ptr, manifest_len, manifest_hash_hex_ptr, context_ptr, context_len, gas_limit)` installs the ABI manifest/hash and optional DV-encoded context blob while wiring the imported `host_call`.
- `qjs_det_eval(code)` evaluates source with the installed manifest/context and returns a `char*` string of the form `RESULT <dv-hex> GAS remaining=<n> used=<n>` (or `ERROR …` on failure).
- `qjs_det_set_gas_limit(gas_limit)`, `qjs_det_free()`, `qjs_det_enable_tape(capacity)` / `qjs_det_read_tape()`, and `qjs_det_enable_trace(enabled)` / `qjs_det_read_trace()` mirror the native harness controls.

Strings returned from the harness are allocated with `malloc`; free them with the exported `_free` helper. The wasm module expects a `host.host_call` import. When you don't have a dispatcher wired yet, pass a stub that returns the transport sentinel:

```ts
const module = await QuickJSGasWasm({
  host: {
    host_call: () => 0xffffffff >>> 0,
  },
});
```

## Running unit tests

Run `pnpm nx test quickjs-wasm-build` to execute the Vitest suite (path helper assertions).

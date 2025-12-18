# Determinism Profile (Baseline #1)

Scope: capture the deterministic VM configuration required by Baseline #1 for both native and Wasm builds. This document is normative and must match harness assertions.

## Deterministic init entrypoints

- `JS_NewDeterministicRuntime(out_rt, out_ctx)` creates a runtime/context in deterministic mode, disables GC heuristics, and sets gas to `JS_GAS_UNLIMITED` by default.
- `JS_InitDeterministicContext(ctx, options)` must run before user code. It:
  - requires manifest bytes and a lowercase hex hash; size limit 1 MiB (`JS_DETERMINISTIC_MAX_MANIFEST_BYTES`)
  - validates `sha256(manifest_bytes)` against the provided hash and throws `ManifestError` with code `ABI_MANIFEST_HASH_MISMATCH` on mismatch
  - copies manifest bytes into the context and installs `Host.v1` functions from the manifest
  - optionally copies a context blob (max 1 MiB) and installs ergonomic globals
  - sets the gas limit to `options.gas_limit`

## Enabled intrinsics

The deterministic init only loads these intrinsic sets:

- `JS_AddIntrinsicBaseObjects`
- `JS_AddIntrinsicEval`
- `JS_AddIntrinsicJSON`
- `JS_AddIntrinsicMapSet`

`Date`, `RegExp`, `Proxy`, TypedArrays, Promise, and WeakRef intrinsics are not loaded in deterministic mode.

## Disabled or stubbed APIs (deterministic TypeError)

The following globals or methods exist but throw the exact TypeError shown:

- `eval(...)` -> `TypeError: eval is disabled in deterministic mode`
- `Function(...)` -> `TypeError: Function is disabled in deterministic mode`
- Function constructor paths (`Function.prototype.constructor`, arrow/generator constructors) -> `TypeError: Function constructor is disabled in deterministic mode`
- `RegExp` and regex literals -> `TypeError: RegExp is disabled in deterministic mode`
- `Proxy` -> `TypeError: Proxy is disabled in deterministic mode`
- `Promise` and statics (`resolve`, `reject`, `all`, `race`, `any`, `allSettled`) -> `TypeError: Promise is disabled in deterministic mode`
- `Math.random()` -> `TypeError: Math.random is disabled in deterministic mode`
- `ArrayBuffer` -> `TypeError: ArrayBuffer is disabled in deterministic mode`
- `SharedArrayBuffer` -> `TypeError: SharedArrayBuffer is disabled in deterministic mode`
- `DataView` -> `TypeError: DataView is disabled in deterministic mode`
- Typed arrays: `Uint8Array`, `Uint8ClampedArray`, `Int8Array`, `Uint16Array`, `Int16Array`, `Uint32Array`, `Int32Array`, `BigInt64Array`, `BigUint64Array`, `Float16Array`, `Float32Array`, `Float64Array` -> `TypeError: Typed arrays are disabled in deterministic mode`
- `Atomics` -> `TypeError: Atomics is disabled in deterministic mode`
- `WebAssembly` -> `TypeError: WebAssembly is disabled in deterministic mode`
- `console.log/info/warn/error/debug` -> `TypeError: console is disabled in deterministic mode`
- `print` -> `TypeError: print is disabled in deterministic mode`
- `JSON.parse` -> `TypeError: JSON.parse is disabled in deterministic mode`
- `JSON.stringify` -> `TypeError: JSON.stringify is disabled in deterministic mode`
- `Array.prototype.sort` -> `TypeError: Array.prototype.sort is disabled in deterministic mode`

Notes:

- `Math` exists, but `Math.random` is replaced with a deterministic stub and always throws `TypeError: Math.random is disabled in deterministic mode`.
  The internal RNG state is still seeded to `1` during deterministic init so that any accidental native use of the RNG (outside the JS surface) is deterministic rather than time-based.
- The `console` object exists and is created with a null prototype (`Object.create(null)`).
  Only `log`, `info`, `warn`, `error`, and `debug` are defined, each as a stub that throws
  `TypeError: console is disabled in deterministic mode`. Other `console.*` members are absent
  unless user code adds them.

## Absent globals

The deterministic init does not install these globals; `typeof` returns `"undefined"`:

- `Date`
- `setTimeout` / `setInterval`
- `queueMicrotask`

## Host namespace and ergonomic globals

- `Host` and `Host.v1` are created with null prototypes.
- All Host namespaces are `Object.preventExtensions`, and their properties are non-writable and non-configurable.
- `JS_InitHostFromManifest` installs `Host.v1` functions from the ABI manifest; `js_path` collisions are rejected (see `docs/abi-manifest.md`).

When a context blob is supplied, `JS_InitErgonomicGlobals` installs:

- `document(path)` and `document.canonical(path)` wrappers around `Host.v1.document.get` and `Host.v1.document.getCanonical`. The function objects are non-extensible.
- `event`, `eventCanonical`, `steps`: DV values decoded from the context blob. Values are deep-frozen; missing keys default to `null`.
- `canon.unwrap(value)`: DV-encodes and decodes `value` and returns a deep-frozen clone.
- `canon.at(value, pathArray)`: `pathArray` must be an array of strings or integers; strings are limited to DV max string bytes and indexes to DV max array length. Returns `undefined` when a path is missing; throws deterministic TypeError for invalid path elements or out-of-range indexes.

## Wasm determinism settings

Wasm builds pin deterministic toolchain and memory settings (see `docs/toolchain.md`):

- Fixed memory: 32 MiB initial/maximum, 1 MiB stack, no memory growth, no table growth.
- Filesystem disabled; environment restricted to node,web; no exit runtime.

## Gas and GC

Canonical gas and GC checkpoints are part of the deterministic profile; see `docs/gas-schedule.md`.

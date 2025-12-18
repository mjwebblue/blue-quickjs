# Determinism Profile (Baseline #1)

Baseline anchor: see `docs/baseline-1.md`.

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

## Rationale for disabled / stubbed / absent APIs (informative)

Deterministic mode is intended to be **bit-for-bit reproducible** given the same:

1. program bytes,
2. ABI manifest bytes + hash,
3. context blob, and
4. host responses.

To make that property realistic (and to keep gas/metering tractable), the profile removes
or stubs JS features that:

- read ambient state (time, environment, entropy),
- introduce scheduler-dependent ordering (async jobs, timers, concurrency),
- expose platform-dependent representations (byte layouts, NaN payloads),
- have large/engine-version-dependent performance cliffs (hard to meter deterministically), or
- bypass the capability model (any I/O must go through manifest-defined `Host.v1` calls).

### Dynamic code generation

Disabled:

- `eval`, `Function`, and all Function-constructor paths.

Why:

- **Auditing / capability control:** deterministic runs should execute only the code supplied up front.
  Dynamic compilation makes it harder to reason about what code will run and to enforce a stable,
  minimal surface.
- **Deterministic metering:** parse/compile cost depends on input size and internal compiler details;
  charging it deterministically is possible but adds complexity and version coupling.

### Time, scheduling, and asynchrony

Absent/disabled:

- `Date`
- `setTimeout` / `setInterval`
- `queueMicrotask`
- `Promise`

Why:

- **Ambient time + host event loop:** wall-clock time, timer resolution, and task scheduling are not
  part of the deterministic transcript, so they would diverge across hosts and runs.
- **Ordering:** microtask/task ordering depends on host integration and re-entrancy points; keeping the
  execution model strictly run-to-completion avoids “who scheduled first?” nondeterminism.

### Randomness / entropy

Disabled:

- `Math.random()`

Why:

- **Entropy source:** any RNG seeded from time/OS entropy breaks reproducibility.
- **Accidental native RNG use:** seeding the internal RNG to a constant (while still throwing at the JS
  surface) keeps any unintended native RNG usage deterministic.

### Binary buffers, shared memory, and low-level representation

Disabled:

- `ArrayBuffer`, `DataView`, typed arrays (`Uint8Array`, `Float64Array`, …)
- `SharedArrayBuffer`
- `Atomics`

Why:

- **Representation leaks:** typed views can observe IEEE-754 edge cases like NaN payload bits and `-0`
  canonicalization, which can vary across engines/architectures/toolchains even when “numeric” results
  look equivalent at a higher level.
- **Metering + resource bounds:** bulk byte operations can move a lot of data per op; without a very
  careful cost model they are an easy way to create large, host-dependent execution time/memory usage.
- **Concurrency:** `SharedArrayBuffer` + `Atomics` require multi-agent semantics; thread scheduling and
  race outcomes are inherently nondeterministic unless the entire scheduler is part of the transcript.

### WebAssembly

Disabled:

- `WebAssembly`

Why:

- **Second VM / semantics surface:** it introduces a second execution engine with its own edge cases
  (notably around floating-point NaNs and traps), expanding the “things that must be identical” across
  platforms.
- **Metering:** Wasm enables high-throughput compute that can bypass VM-level gas assumptions unless it
  is separately metered.

### I/O and side effects

Disabled:

- `console.*`
- `print`

Why:

- **Side effects outside the transcript:** writing to stdout/stderr or host consoles is observable and
  host-dependent. Deterministic mode requires that all observable effects go through manifest-defined
  host calls (e.g. `Host.v1.emit`) where responses/limits are pinned by the ABI manifest.

### JSON.parse / JSON.stringify

Disabled:

- `JSON.parse`
- `JSON.stringify`

Why:

- **Non-canonical interchange:** JSON cannot represent many DV/JS values (e.g. `BigInt`, `NaN`,
  `Infinity`, and it does not preserve `-0` reliably), which makes it a poor “canonical” format for
  deterministic interchange.
- **Cross-platform float conversions:** number parsing/printing is a common source of subtle
  cross-toolchain differences if any part of the implementation delegates to platform conversion
  routines. Deterministic mode prefers DV canonical encoding for interchange.

### Engine-version-dependent behavior and performance cliffs

Disabled:

- `RegExp` (and regex literals)
- `Proxy`
- `Array.prototype.sort`

Why:

- **RegExp:** regex engines can have super-linear behavior (catastrophic backtracking) and large
  internal state; execution cost is difficult to meter deterministically and can vary with engine
  implementation details.
- **Proxy:** proxies can introduce hidden re-entrancy (traps firing during seemingly “simple”
  operations) and make it harder to reason about which operations are pure vs. user-code-driven,
  complicating deterministic gas accounting and auditing.
- **sort:** sorting is only fully deterministic when the comparator defines a total order. With
  inconsistent comparators (common in the wild), the resulting permutation can vary across engines or
  algorithm choices (stable/unstable, pivot strategy). Disabling `sort` prevents accidental reliance
  on those engine-dependent outcomes.

### Why some things throw instead of being absent

In deterministic mode we use two patterns:

- **Absent globals** (e.g. `Date`) keep the surface minimal and make feature-detection reliable.
- **Deterministic stubs** (throwing a fixed `TypeError`) are used when:
  - the intrinsic is normally present once a base set is loaded, or
  - we want failures to be loud and message-stable for harness assertions, rather than silently
    falling back to host-dependent behavior.

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

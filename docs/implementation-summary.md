# Implementation summary

This document summarizes what is **implemented in this repository**, and how it maps to:

- [Baseline #1 – Deterministic JS engine](./baseline-1.md)
- [Baseline #2 – Host ABI + DV contract](./baseline-2.md)
- [Implementation plan](./implementation-plan.md)

For deep/normative details, this doc always points to the corresponding reference spec in `docs/`.

---

## What this repo provides

At a high level, the repo provides a deterministic evaluator:

> **evaluate(P, I, G, Host) → (Result, Gas, optional traces)**

Where:

- **P** is a *program artifact* (JS code plus ABI identity/pinning metadata).
- **I** is a *deterministic input envelope* injected into the VM (event, eventCanonical, steps).
- **G** is a *gas limit* (uint64).
- **Host** is a *manifest-backed set of synchronous host functions* exposed through a single ABI syscall.

The evaluator runs JavaScript inside a **QuickJS VM compiled to WebAssembly** under a **determinism profile**, and only allows host interaction through a **manifest-locked ABI** (the `host_call` import). Values crossing this boundary are encoded as **Deterministic Values (DV)**.

If you are new to the concepts:
- DV is explained in depth in [DV wire format](./dv-wire-format.md).
- The Host ABI is explained in depth in [Host call ABI](./host-call-abi.md) and [ABI manifest](./abi-manifest.md).
- Gas and the schedule are specified in [Gas schedule](./gas-schedule.md).
- The determinism profile (what JS features exist / don’t exist) is in [Determinism profile](./determinism-profile.md).

---

## Core concepts and vocabulary

These terms are used consistently across docs and code:

- **VM**: the deterministic QuickJS instance (inside Wasm).
- **Host**: the embedding environment (Node or browser).
- **ABI**: the *binary-level* interface between VM and Host (`host_call`), plus its manifest.
- **Manifest**: the declarative “API surface” describing which host functions exist, their IDs, gas parameters, limits, and error codes. See [ABI manifest](./abi-manifest.md).
- **DV (Deterministic Value)**: the canonical wire format for all values crossing the VM boundary. See [DV wire format](./dv-wire-format.md).
- **Gas**: deterministic resource accounting used to bound execution. See [Gas schedule](./gas-schedule.md).
- **Tape**: an optional deterministic audit trace of host calls (fnId, sizes, units, hashes, gas breakdown). See [Observability](./observability.md) and the tape section in [Host call ABI](./host-call-abi.md).

---

## Architecture at a glance

### Dataflow

```
Program artifact P + Input I + Gas limit G + Manifest + Host handlers
            |
            v
     Wasm QuickJS runtime
  (deterministic init + Host.v1)
            |
            v
    Deterministic JS evaluation
            |
            +--> DV result OR deterministic error
            +--> gasUsed / gasRemaining
            +--> optional: host-call tape, gas trace
```

### Why the “manifest-locked ABI” exists

Normal JavaScript can call arbitrary host APIs (filesystem, network, time, randomness…). That destroys determinism.

This repo instead uses a **single syscall** (`host_call`) plus a **manifest** to define and pin exactly what the VM is allowed to do. This achieves:

- A *small, auditable interface* between VM and Host.
- *Deterministic validation* on both sides (request/response shape, limits, error codes).
- *Versioning and pinning* (programs declare the ABI identity/hash they expect).
- A clean boundary for metering and tracing.

Details: [Baseline #2](./baseline-2.md), [Host call ABI](./host-call-abi.md), [ABI manifest](./abi-manifest.md).

---

## What happens when you run code

This repo implements the full end-to-end pipeline from the implementation plan (see [Implementation plan](./implementation-plan.md)). The core “run” steps are:

### 1) Host loads the runtime (Wasm + dispatcher)

The TypeScript SDK loads the prebuilt wasm artifact(s) and wires the imported `host_call` function to a **manifest-backed dispatcher**.

Code pointers:
- Runtime loader: `libs/quickjs-runtime/src/lib/runtime.ts`
- Host dispatcher: `libs/quickjs-runtime/src/lib/host-dispatcher.ts`
- Wasm artifacts packaging: `libs/quickjs-wasm/` and `libs/quickjs-wasm-build/`

Build determinism details: [Toolchain](./toolchain.md).

### 2) Deterministic init handshake (manifest + hash + context blob + gas)

Before evaluating user code, the VM is initialized with:

- **Manifest bytes** (canonical encoding)
- **Manifest hash** (from `P.abiManifestHash`) for pinning/anti-confusion
- **Context blob** (DV-encoded `I.event`, `I.eventCanonical`, `I.steps`)
- **Gas limit** `G`

If the expected hash does not match the bytes, initialization fails deterministically.

Reference spec: [Baseline #2](./baseline-2.md) and [ABI manifest](./abi-manifest.md).  
SDK guide: [TypeScript SDK usage](./sdk.md).

### 3) Determinism profile is installed

During deterministic init, the VM configures QuickJS to match the deterministic feature set:

- Disables or stubs nondeterministic APIs (`Date`, `Math.random`, etc.).
- Disables features that would make execution depend on host implementation details.
- Ensures the environment is “closed” (frozen globals, no ambient I/O APIs).

Reference spec: [Determinism profile](./determinism-profile.md).

### 4) Host API surface is installed from the manifest

From the manifest, the VM installs a frozen, read-only namespace (e.g. `Host.v1.*`) and optionally ergonomic globals (`document`, `document.canonical`, `canon`, `event`, `steps`) that map to those host functions.

Reference spec: [Baseline #2](./baseline-2.md) and [Host call ABI](./host-call-abi.md).  
Ergonomics and injected globals: [Determinism profile](./determinism-profile.md).

### 5) User JS is evaluated and must return a DV

The evaluator runs JS with deterministic gas metering enabled. The final return value must be DV-encodable, otherwise evaluation fails deterministically.

Return encoding details: [DV wire format](./dv-wire-format.md).  
Evaluation API: [TypeScript SDK usage](./sdk.md).

---

## Deterministic Value (DV)

DV is the repository’s “universal value model” for **all boundary crossings**:

- Program outputs
- Host call arguments and results
- Context blob injected into the VM
- Manifest canonical encoding/hashing

DV is a deliberately small subset: `null`, `boolean`, `int/float` (restricted), `string`, `bytes`, `array`, `map`, with **canonical encoding** rules and **size limits**.

Reference spec: [DV wire format](./dv-wire-format.md).

Why DV instead of JSON?

- JSON has no bytes type.
- JSON has multiple valid serializations for the same data (key order, float formatting).
- We need *canonical bytes* for hashing, reproducible fixtures, and cross-language parity (C ↔ TS).

---

## Gas and host-call metering

Gas is a deterministic *budget* that bounds execution (similar in spirit to EVM gas, but used here as a runtime limit rather than a fee).

### What is metered

The VM charges gas for:

- **Interpreter opcodes** (flat cost per step)
- **Certain builtins** (notably array callbacks) to avoid “free” work inside C loops
- **Memory allocations** (scaled by bytes) to bound allocation-heavy attacks
- **GC checkpoints** (a fixed cost) at deterministic points
- **Host calls** via manifest-defined parameters

Reference spec: [Gas schedule](./gas-schedule.md).

### How host-call gas is charged (two phase)

For each host call, gas is billed in two phases using manifest gas parameters:

- **Pre-charge** (before calling the host):
  - `gas_pre = base + k_arg_bytes * request_bytes`
- **Post-charge** (after the host response is parsed):
  - `gas_post = k_ret_bytes * response_bytes + k_units * units`

Where:
- `request_bytes` is the DV-encoded args array.
- `response_bytes` is the DV-encoded response envelope.
- `units` is a host-reported scalar (used to represent host work not visible inside the VM).

Reference spec: [Gas schedule](./gas-schedule.md) and [ABI manifest](./abi-manifest.md).

**Why two phases?**

- The VM must have enough gas *before* the host call to prevent “free” host effects.
- The VM can only know `response_bytes` and `units` *after* the host returns.

A key semantic: **OOG on the post-charge happens after the host executed**, so host effects may already have occurred (e.g. `emit`). This is explicitly documented in the gas schedule and baseline, and is important when designing host side-effects.

---

## ABI limits and why they matter

There are two layers of limits:

1. **Global DV limits** (hard caps to prevent pathological values)
2. **Per-function ABI limits** (declared in the manifest to bound each call)

Per-function limits include:

- `max_request_bytes`
- `max_response_bytes`
- `max_units`
- `arg_utf8_max` (per-argument string limits, in UTF-8 bytes)

Reference spec: [ABI manifest](./abi-manifest.md) and [Host call ABI](./host-call-abi.md).  
Developer guide with rationale and enforcement points: [ABI limits explained](./abi-limits.md).

---

## Observability: gas trace and host-call tape

Deterministic systems are hard to debug because “printing” can itself introduce nondeterminism.

This repo provides two deterministic observability tools:

- **Gas trace**: aggregate counters attributing VM gas to opcodes, array callback builtins, and allocations.
- **Host-call tape**: bounded per-call records including hashes of the encoded request/response bytes and the gas breakdown.

How to enable and interpret: [Observability](./observability.md).

---

## Error model at a glance

Evaluation can fail deterministically in a few broad ways:

- **OutOfGas**: the VM gas counter hits zero. This is raised as an **uncatchable** VM error (run halts).  
  Spec: [Gas schedule](./gas-schedule.md).

- **HostError**: the host returned a valid `err` envelope (with an error `code` declared in the manifest).  
  The VM throws an `Error` with `name = "HostError"` plus stable `code`, `tag`, and optional `details`.  
  Spec: [Baseline #2](./baseline-2.md), [Host call ABI](./host-call-abi.md).

  Two reserved HostErrors are used for ABI violations:
  - `HOST_TRANSPORT` / `host/transport` (transport-level failure)
  - `HOST_ENVELOPE_INVALID` / `host/envelope_invalid` (malformed or policy-violating envelope)

- **ManifestError**: the VM rejected the manifest bytes or manifest hash pinning at init time.  
  Spec: [ABI manifest](./abi-manifest.md).

- **JS errors (TypeError/RangeError/SyntaxError/...)**: normal JS errors from user code *or* from deterministic stubs (e.g. calling a disabled API).  
  Spec: [Determinism profile](./determinism-profile.md).

On the host side, the TypeScript SDK maps raw VM errors into a stable `EvaluateResult` shape. See:
- `libs/quickjs-runtime/src/lib/evaluate-errors.ts`
- `libs/quickjs-runtime/src/lib/evaluate.ts`


## Repo implementation map (where the main pieces live)

### QuickJS fork (C)

- `vendor/quickjs/quickjs.c`
  - deterministic runtime/context creation
  - interpreter gas metering and allocation gas charging
  - deterministic GC checkpoint support
  - gas trace support
- `vendor/quickjs/quickjs-host.c`
  - manifest parsing/validation
  - Host.v1 wrapper generation and argument validation (`arg_utf8_max`)
  - `host_call` bridge + envelope parsing + HostError mapping
  - optional host-call tape
- `vendor/quickjs/quickjs-dv.c`
  - DV encode/decode and canonicalization helpers used at the boundary
- `vendor/quickjs/quickjs-sha256.c`
  - SHA-256 used for tape request/response hashing
- `vendor/quickjs/quickjs-wasm-entry.c`
  - exported wasm functions: init/eval/setGasLimit/tape/trace/free

Reference details: [Host call ABI](./host-call-abi.md), [DV wire format](./dv-wire-format.md), [Gas schedule](./gas-schedule.md).

### TypeScript SDK and utilities

- `libs/quickjs-runtime/`
  - `evaluate()` convenience API and stable result model
  - `createRuntime()` loader + dispatcher wiring
  - `initializeDeterministicVm()` init handshake
- `libs/abi-manifest/`
  - schema validation
  - canonical manifest encoding and hashing
- `libs/dv/`
  - DV reference encode/decode used by the host dispatcher and tests
- `libs/test-harness/`
  - fixtures (Host.v1 manifest, determinism inputs, gas samples)
  - output parsing utilities
- `libs/quickjs-wasm-build/` + `libs/quickjs-wasm/`
  - deterministic wasm build pipeline and artifact metadata

---

## Build determinism (Wasm artifacts)

The wasm engine bytes are part of the deterministic surface, so builds are treated as reproducible, pinned artifacts:

- **Pinned toolchain**: Emscripten/emsdk is locked (see `docs/toolchain.md`).
- **Deterministic build flags**: wasm output is built with `-sDETERMINISTIC=1` and a pinned `SOURCE_DATE_EPOCH`.
- **Fixed memory model**: wasm memory is fixed (no growth), with a fixed stack size and no table growth.
- **No ambient host APIs**: the Emscripten filesystem is disabled; the module is built for `node,web`.
- **Auditable metadata**: build outputs record hashes, sizes, and flags in `quickjs-wasm-build.metadata.json`.
- **Release + debug builds**: debug builds add assertions/stack checks while preserving the same deterministic VM semantics.

Details and exact flags: [Toolchain](./toolchain.md).


## Key decisions (planning → implementation)

The implementation plan captures tasks and acceptance criteria; this section summarizes the biggest decisions that shaped the final code.

### 1) Disable vs meter vs re-implement JS features

Many JS features are either nondeterministic (time, randomness) or hard to meter precisely (some builtins do heavy work in C). The chosen strategy is:

- **Disable** features that would compromise determinism and are not required.
- **Meter** the key “footguns” (allocation, array callbacks, host calls).
- Prefer **simple stable costs** over micro-optimizing per-op semantics.

See: [Determinism profile](./determinism-profile.md), [Gas schedule](./gas-schedule.md).

### 2) Single syscall (`host_call`) instead of many imports

Instead of importing one wasm function per host capability, we use a single function:

- simpler to version and audit
- consistent gas/limits enforcement
- allows manifest-driven installation of `Host.v1.*`

See: [Host call ABI](./host-call-abi.md), [Baseline #2](./baseline-2.md).

### 3) Canonical DV bytes everywhere

To keep cross-environment parity (C ↔ TS, Node ↔ browser), every boundary value uses DV:

- stable hashing
- stable tests/fixtures
- deterministic error behavior for malformed/oversized values

See: [DV wire format](./dv-wire-format.md).

### 4) Manifest pinning by hash

Programs specify the manifest hash they were built against. The VM validates bytes+hash at init to prevent “same ABI id/version but different semantics”.

See: [ABI manifest](./abi-manifest.md), [Release policy](./release-policy.md).

### 5) Two-phase host-call gas + bounded traces

Host-call gas is two-phase to fairly account for both request encoding and host work.

Traces are **bounded** (tape capacity max) and **deterministic** (hashes, numeric counters) to avoid introducing nondeterminism.

See: [Gas schedule](./gas-schedule.md), [Observability](./observability.md).

---

## How to extend the system (high level)

The most common extension is “add a new Host function” (new capability). The workflow is:

1. Extend the manifest (new function entry, gas, limits, errors).
2. Implement the handler in the host dispatcher.
3. Add/extend fixtures + tests.
4. Consider ABI id/version policy (breaking vs non-breaking changes).

Details: [ABI manifest](./abi-manifest.md), [Host call ABI](./host-call-abi.md), [Release policy](./release-policy.md).

---

## Known limitations / non-goals (current state)

- Only **wasm32** is supported by the TypeScript runtime integration (pointer sizes are treated as 32-bit). See runtime notes in the implementation plan and SDK docs.
- Wasm memory is configured for determinism (fixed sizing; no growth). See [Toolchain](./toolchain.md).
- The determinism profile is intentionally restrictive; many JS APIs are not available. See [Determinism profile](./determinism-profile.md).
- “Gas trace” attributes only VM-internal categories; host-call gas is billed but not counted inside trace totals. See [Gas schedule](./gas-schedule.md) and [Observability](./observability.md).


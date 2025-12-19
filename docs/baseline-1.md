# Baseline #1 — Deterministic Execution + Canonical Gas

This document is the **baseline-level contract** for deterministic evaluation and gas metering in this repository. Many other docs reference “Baseline #1”; those references are anchored here.

Baseline docs are intentionally **high-level and invariant-focused**. The detailed, normative specifications live in:

- Deterministic runtime surface/profile: `docs/determinism-profile.md`
- Gas rules and constants: `docs/gas-schedule.md`
- DV rules used for inputs/outputs and ABI bytes: `docs/dv-wire-format.md`
- Host ABI and manifest pinning (cross-cutting): `docs/baseline-2.md`

## 0. Scope

Baseline #1 defines:

- what “deterministic” means for this evaluator,
- what the canonical gas number is (and is not),
- which classes of JS features are forbidden/disabled for determinism,
- and what must be true across environments (Node + browser) for the same input.

It does **not** define the host ABI surface (that is Baseline #2).

## 1. Core invariant (normative)

For any fixed triple \((P, I, G)\), evaluation must be **bit-for-bit reproducible** across environments that run the same pinned engine build:

- **Outputs**: the returned DV value (or deterministic error classification) must match.
- **Gas**: gas used/remaining must match, including the **exact out-of-gas boundary**.
- **Host-call observations** (if host calls are involved): order and charging must be deterministic (see Baseline #2).

Definitions:

- **P (Program artifact)**: JS source plus pins for ABI/engine (see `libs/quickjs-runtime` types and Baseline #2 for ABI pins).
- **I (Input envelope)**: deterministic external inputs (event/eventCanonical/steps) injected via deterministic init.
- **G**: gas budget (uint64) applied inside the VM.

## 2. “Same engine everywhere” (normative)

- The evaluator must ship/instantiate the **same QuickJS-in-Wasm bytes** in Node and browsers.
- Engine identity (or equivalent immutable metadata) is pinnable via `P` (see runtime types and `docs/implementation-plan.md` for the broader architecture).

## 3. Deterministic capability profile (normative)

Determinism depends on a strict JS surface:

- **No ambient time**: `Date`, timers, and time APIs are absent/disabled.
- **No randomness**: `Math.random` is deterministically disabled.
- **No async scheduling**: Promises/microtasks/timers are disabled or absent; evaluation is run-to-completion.
- **No low-level byte/NaN observability**: typed arrays / `ArrayBuffer` / `DataView` / `WebAssembly` are disabled.
- **No dynamic code generation**: `eval` and `Function` are disabled.
- **No unmetered heavy builtins**: selected high-risk APIs (e.g. `JSON.parse`, `JSON.stringify`, `Array.prototype.sort`) are deterministically disabled.

The exact list and the required deterministic error messages are specified in `docs/determinism-profile.md`.

## 4. Canonical gas (normative)

### 4.1 Canonical gas is **inside QuickJS**

- The only gas number treated as canonical is the VM’s internal gas counter.
- Wasm-instruction counting (or host wall-clock) is **not** used as canonical gas.

### 4.2 Gas is semantic, versioned, and deterministic

Gas charging must be:

- **deterministic** (no dependence on allocator layout differences across hosts),
- **versioned** (a single “gas version” identifier governs the schedule),
- **complete** (no large work can be performed without corresponding deterministic charges).

The authoritative gas schedule and constants are specified in `docs/gas-schedule.md`.

## 5. Resource bounds and memory determinism (normative)

- Wasm memory sizing must be fixed (no growth) and toolchain pinned (see `docs/toolchain.md`).
- DV decoding/encoding and manifest processing must apply explicit limits (see `docs/dv-wire-format.md`).

## 6. Tests required by the baseline (normative)

The repository must include tests that demonstrate:

- **Node vs browser parity** for a representative fixture set: same outputs, same gas, same errors.
- **Deterministic OOG boundary**: the same program with the same gas budget fails at the same semantic boundary everywhere.

The harness and smoke strategy is described in `docs/sprint-review.md` and implemented across `apps/smoke-*` and `libs/test-harness`.

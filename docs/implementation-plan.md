# Deterministic QuickJS-in-Wasm Evaluator (Nx Monorepo) — Implementation Plan (Baseline #1 + #2 Compliant)

This file is the “source of truth” execution plan for Codex (Cursor IDE) to implement a deterministic QuickJS-in-Wasm **JS evaluator** with:

- **Canonical gas metering inside QuickJS** (Baseline #1),
- A **manifest-locked, numeric-ID, single-dispatcher host ABI** (Baseline #2),
- A **read-only Blue-style JS context** (`document()`, `event`, `steps`, `canon`) intended to be embedded by Blue’s external `document-processor`.

This repo intentionally does **not** implement document overlay/commit logic. That remains the responsibility of `document-processor`.
However, Baseline #2 still applies: even read-only `document(path)` is a host capability and must be exposed through the syscall/manifest/DV model.

---

## Overview (end state)

- **Nx monorepo** (TypeScript-first) using **pnpm**, with consistent tooling (lint/format/test/build) and CI.
- **QuickJS fork** lives as a **git submodule** at `vendor/quickjs` (pinned commit). All determinism + gas + host ABI changes live in that fork.
- **Deterministic execution profile** is enforced in the VM init: time/random/async/network/fs/locale are removed or stubbed; typed arrays / ArrayBuffer / WebAssembly are disabled; dangerous features like `eval`/`Function` are disabled (Baseline #1 §1B–§1C, §3).
- **Canonical gas** is implemented inside QuickJS: opcode metering, metered C builtins, allocation charges, deterministic GC checkpoints (Baseline #1 §2B).
- **Single syscall ABI (`host_call`)** for all host capabilities: `fn_id + request_bytes -> response_bytes`, with **manifest mapping**, **manifest hash validation**, and **DV canonical encoding** (Baseline #2 §1.1–§1.4, §2).
- VM exposes a frozen **`Host.v1`** namespace generated from the manifest, and provides ergonomic globals:
  `document(path)`, `document.canonical(path)`, `event`, `eventCanonical`, `steps`, `canon.unwrap`, `canon.at` (Baseline #2 §1.5, §6.4, §9).
- **Host implementation is provided by the embedder** (e.g., `document-processor`) via a JS-side dispatcher used to implement `host_call`. No overlay/commit logic exists here.
- **Emscripten build pipeline** produces deterministic Wasm with fixed memory sizing (Baseline #1 §2C) in `libs/quickjs-wasm-build`, packaged in `libs/quickjs-wasm`.
- **SDK** in `libs/quickjs-runtime` loads the same Wasm bytes in Node and browsers, initializes `(P, I, G)`, wires host dispatch, evaluates JS deterministically, and returns DV output + gas used + optional tape.
- **Test harness** verifies determinism and exact OOG point across Node and browser (Playwright), plus DV/manifest parity tests and host-call gas accounting.

---

## Proposed repository layout

```text
/
  vendor/
    quickjs/                    # git submodule: your fork
  libs/
    dv/                         # DV types + canonical encode/decode + validation
    abi-manifest/               # ABI manifest schema + canonicalization + hashing
    quickjs-wasm-build/         # Emscripten build pipeline (Nx executor/targets)
    quickjs-wasm/               # Published artifacts: wasm bytes + loader + metadata
    quickjs-runtime/            # SDK: instantiate, init (P,I,G), evaluate, return DV+gas+tape
    test-harness/               # Fixtures + golden tests + cross-env runners
  apps/
    smoke-node/                 # minimal CLI runner (dev + debugging)
    smoke-web/                  # minimal browser runner (dev + determinism checks)
  tools/
    quickjs-native-harness/     # native harness sources for fast VM iteration (non-wasm)
    nx-executors/               # custom executors (optional), build helpers
    scripts/                    # toolchain setup (emsdk), checks
  docs/
    determinism-profile.md
    gas-schedule.md
    dv-wire-format.md
    abi-manifest.md
    host-call-abi.md
    implementation-plan.md      # (this file)
```

---

## Key integration boundary with `document-processor`

This repo exports a deterministic evaluator. The external embedder (`document-processor`) is responsible for:

- workflow orchestration (step sequencing),
- document overlay/commit/rollback logic,
- providing the document snapshot context and **deterministic host-call implementation** for:

  - `Host.v1.document.get(path)`
  - `Host.v1.document.getCanonical(path)`

- transforming the evaluator’s returned DV value into downstream workflow outputs / updates.

This repo ensures:

- host calls are made through Baseline #2’s syscall layer,
- gas is charged deterministically for host calls (size + units),
- no hidden channels exist in the VM-provided API.

---

# Current repo snapshot (kickoff)

- Nx 22.2 workspace scaffold exists with pnpm (`nx.json`, `tsconfig.base.json`, `package.json`, `pnpm-workspace.yaml`).
- `pnpm-workspace.yaml` only includes `libs/*`; `libs/` is empty and no `apps/` projects exist yet.
- `node_modules/` is present; no lint/format configs or root scripts yet; `README.md` is the default Nx placeholder.
- Docs folder currently only has this plan; toolchain/docs stubs are missing.

## Working set (first Codex pass)

- [x] T-000: Finish workspace bootstrap (root scripts, engines policy, verify `pnpm nx graph`/`run-many`).
- [x] T-001: Add lint/format/.editorconfig/.gitignore and repo lint workflow.
- [ ] T-002: Scaffold empty libs/apps per proposed layout; wire minimal tests. (`quickjs-wasm` lib scaffolded)
- [ ] T-005: Create doc stubs and link from README.
- [ ] README: Replace Nx boilerplate with repo overview and doc links.

---

# Phase P0 — Monorepo bootstrap and standards

### T-000: Initialize Nx workspace with pnpm

**Phase:** P0 – Monorepo bootstrap and standards
**Status:** DONE
**Depends on:** None

**Goal:**
Create the Nx monorepo scaffold with pnpm workspaces, consistent TypeScript configuration, and a baseline build/test story.

**Current state:** Nx workspace files configured (`nx.json`, `tsconfig.base.json`, `package.json`, `pnpm-workspace.yaml` with apps/libs/tools), engines policy + scripts added, .nvmrc pinned to Node 20.17.0; baseline Nx commands verified.

**Detailed tasks:**

- [x] Initialize Nx workspace (integrated monorepo style) with TypeScript support.
- [x] Configure pnpm workspace (`pnpm-workspace.yaml`) and root `package.json` scripts.
- [x] Add Node engine version policy (`.nvmrc` and `package.json#engines`).
- [x] Add base `tsconfig.base.json` and workspace path aliases strategy.
- [x] Verify `pnpm nx graph` runs.

**Implementation hints (for Codex):**

- Root-level files: `nx.json`, `tsconfig.base.json`, `package.json`, `pnpm-workspace.yaml`.
- Use Nx plugins appropriate for TS libs and Node/browser apps.

**Acceptance criteria:**

- [x] `pnpm install` succeeds.
- [x] `pnpm nx graph` runs without errors.
- [x] `pnpm nx run-many -t test` runs (even if no projects exist yet).

---

### T-001: Establish repo-wide lint/format conventions

**Phase:** P0 – Monorepo bootstrap and standards
**Status:** DONE
**Depends on:** T-000

**Goal:**
Standardize formatting and linting so Codex can make consistent changes across the repo.

**Current state:**
Repo-wide Prettier config/ignore, ESLint base ignores, `.editorconfig`, and root `pnpm lint` (with Prettier enforced via ESLint) are in place and passing. Format script removed; use `pnpm lint --fix` for formatting.

**Detailed tasks:**

- [x] Add Prettier config and ignore files.
- [x] Add ESLint config for TypeScript projects.
- [x] Configure Nx lint targets for libs and apps.
- [x] Add `.editorconfig`, `.gitignore`.
- [x] Add root scripts: `pnpm lint` (formatting via `pnpm lint --fix`).

**Implementation hints (for Codex):**

- Keep rules pragmatic; avoid style churn.
- Ensure configs work for ESM-first TS.

**Acceptance criteria:**

- [x] `pnpm lint` runs successfully.

---

### T-002: Create initial libs/apps skeletons (empty but buildable)

**Phase:** P0 – Monorepo bootstrap and standards
**Status:** TODO
**Depends on:** T-001

**Goal:**
Create Nx projects for all major libs and smoke apps so later tickets can wire functionality incrementally.

**Current state:**
`quickjs-wasm` publishable library scaffolded; remaining libs/apps are pending.

**Detailed tasks:**

- [ ] Create publishable library projects under `libs/`:

  - [ ] `dv`
  - [ ] `abi-manifest`
  - [ ] `quickjs-wasm-build`
  - [ ] `quickjs-wasm`
  - [ ] `quickjs-runtime`
  - [ ] `test-harness`

- [ ] Create apps under `apps/`: `smoke-node`, `smoke-web`.
- [ ] Ensure each project has `project.json` `src/index.ts`, and a trivial test.

**Acceptance criteria:**

- [ ] `pnpm nx run-many -t build` succeeds.
- [ ] `pnpm nx run-many -t test` succeeds.

---

### T-003: Add QuickJS fork as git submodule at `vendor/quickjs`

**Phase:** P0 – Monorepo bootstrap and standards
**Status:** TODO
**Depends on:** T-000

**Goal:**
Bring your QuickJS fork into the monorepo as a pinned submodule under `vendor/quickjs`.

**Detailed tasks:**

- [ ] Add the git submodule under `vendor/quickjs`.
- [ ] Add `vendor/README.md` documenting submodule update workflow and pinning rules.
- [ ] Add a root README snippet explaining fork ownership and update process.

**Implementation hints (for Codex):**

- Keep QuickJS modifications inside the submodule.
- Ensure Nx ignores `vendor/quickjs` as a project.

**Acceptance criteria:**

- [ ] Fresh clone + `git submodule update --init --recursive` populates `vendor/quickjs`.
- [ ] `vendor/quickjs` contains expected QuickJS sources.

---

### T-004: Pin Emscripten toolchain (local + CI)

**Phase:** P0 – Monorepo bootstrap and standards
**Status:** TODO
**Depends on:** T-000

**Goal:**
Pin emsdk/emcc version and provide repeatable setup.

**Detailed tasks:**

- [ ] Record pinned emsdk version in `tools/scripts/emsdk-version.txt`.
- [ ] Add setup docs + scripts to install/activate pinned emsdk.
- [ ] Add CI notes for caching emsdk directory.
- [ ] Create `docs/toolchain.md`.

**Implementation hints (for Codex):**

- Scripts should be idempotent.
- Avoid relying on system emcc.

**Acceptance criteria:**

- [ ] `emcc --version` matches pinned version after setup.
- [ ] `docs/toolchain.md` is sufficient for a clean machine setup.

---

### T-005: Add docs scaffolding for determinism/gas/DV/ABI

**Phase:** P0 – Monorepo bootstrap and standards
**Status:** TODO
**Depends on:** T-001

**Goal:**
Create documentation placeholders aligned to Baseline #1 and #2.

**Detailed tasks:**

- [ ] Create `docs/determinism-profile.md`.
- [ ] Create `docs/gas-schedule.md`.
- [ ] Create `docs/dv-wire-format.md`.
- [ ] Create `docs/abi-manifest.md`.
- [ ] Create `docs/host-call-abi.md`.
- [ ] Link docs from root `README.md`.

**Implementation hints (for Codex):**

- Keep docs short initially; later tickets fill details.
- Each doc should reference relevant Baseline sections.

**Acceptance criteria:**

- [ ] Docs exist and are linked.
- [ ] Each doc cites Baseline #1/#2 sections.

---

# Phase P1 — QuickJS native harness and deterministic capability profile

### T-010: Create a minimal native (non-Wasm) harness for the QuickJS fork

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-003, T-002

**Goal:**
Enable fast iteration on QuickJS changes by compiling and running the fork natively, with deterministic init and stable output capture.

**Detailed tasks:**

- [ ] Add C harness under `tools/quickjs-native-harness/` that can:

  - [ ] create runtime/context using the deterministic init entrypoint,
  - [ ] evaluate a provided JS source string,
  - [ ] return stable JSON-like output (DV bytes or a stable text format) and stable error codes.

- [ ] Add Nx targets to build and run harness tests.
- [ ] Add a minimal smoke test script.

**Implementation hints (for Codex):**

- Do not use QuickJS `qjs` shell; write your own harness to control init.
- Output must not include nondeterministic stack traces.

**Acceptance criteria:**

- [ ] `pnpm nx build quickjs-native-harness` produces a runnable binary.
- [ ] `pnpm nx test quickjs-native-harness` runs at least one deterministic test.

---

### T-011: Implement deterministic VM init hook in QuickJS fork

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-010, T-005

**Goal:**
Centralize deterministic runtime/context initialization so native and wasm use the same profile.

**Baseline references:** Baseline #1 §1B, §3; Baseline #2 §6.1, §6.3

**Detailed tasks:**

- [ ] Add a single “deterministic init” function in the fork that:

  - [ ] creates runtime/context,
  - [ ] installs minimal safe builtins,
  - [ ] removes or stubs forbidden capabilities deterministically,
  - [ ] prepares placeholders for `Host` namespace (to be installed from manifest later).

- [ ] Ensure harness uses this init.

**Implementation hints (for Codex):**

- Favor removing globals or replacing them with deterministic stubs that throw stable errors.
- Use null-prototype objects where applicable.

**Acceptance criteria:**

- [ ] A test asserts forbidden globals are absent/stubbed.
- [ ] Global descriptors for injected names are stable across runs.

---

### T-012: Disable time, randomness, timers, and locale channels

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-011

**Goal:**
Remove nondeterminism sources: time/randomness/timers/locale.

**Baseline references:** Baseline #1 §1B–§1C; Baseline #2 §0.3

**Detailed tasks:**

- [ ] Disable/stub: `Date`, timing APIs, timers.
- [ ] Disable/stub `Math.random` (or remove entirely).
- [ ] Ensure no locale-dependent APIs are exposed.
- [ ] Add tests proving stable behavior.

**Implementation hints (for Codex):**

- Decide “missing” vs “throws deterministic error” per API and document.

**Acceptance criteria:**

- [ ] Capability tests pass and show no time/random/locale leaks.

---

### T-013: Disable async/Promises/job queue

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-011

**Goal:**
Enforce no async behavior and no hidden scheduling.

**Baseline references:** Baseline #1 §1B; Baseline #2 §4.4

**Detailed tasks:**

- [ ] Remove/disable Promise, async functions, microtask processing.
- [ ] Ensure VM doesn’t run jobs implicitly after evaluation.
- [ ] Add tests verifying `Promise` absent and no microtasks run.

**Acceptance criteria:**

- [ ] Async features are unavailable or deterministically rejected.

---

### T-014: Disable eval/Function, RegExp, Proxy

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-011

**Goal:**
Remove high-risk features excluded by Baseline #1 until explicitly supported/metered.

**Baseline references:** Baseline #1 §3

**Detailed tasks:**

- [ ] Disable/stub `eval` and `Function`.
- [ ] Disable/stub `RegExp`.
- [ ] Disable/stub `Proxy`.
- [ ] Add deterministic failure tests.

**Acceptance criteria:**

- [ ] Scripts attempting these features fail deterministically.

---

### T-015: Disable typed arrays / ArrayBuffer / DataView / WebAssembly exposure

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-011

**Goal:**
Prevent float/NaN payload observability and low-level channels.

**Baseline references:** Baseline #1 §1B, §3

**Detailed tasks:**

- [ ] Disable/stub ArrayBuffer, DataView, typed arrays, WebAssembly.
- [ ] Add tests confirming they are unreachable.

**Acceptance criteria:**

- [ ] These globals are absent/stubbed deterministically.

---

### T-016: Disable console/print; provide deterministic logging path placeholder

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-011

**Goal:**
Prevent nondeterministic host logging. Logging (if any) must be via deterministic host ABI (Baseline #2 §5).

**Baseline references:** Baseline #2 §5

**Detailed tasks:**

- [ ] Remove/stub `print`/`console` (if present in your embed) or ensure they do nothing deterministically.
- [ ] Document recommended deterministic logging mechanism: `Host.v1.emit(...)` (implemented later).
- [ ] Add tests that logging does not escape to host console.

**Acceptance criteria:**

- [ ] No console output occurs from VM execution in harness tests.

---

### T-017: Capability profile conformance test suite

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-012, T-013, T-014, T-015, T-016

**Goal:**
Lock down the deterministic profile with regression tests.

**Detailed tasks:**

- [ ] Add a suite of scripts checking:

  - [ ] forbidden globals are missing/stubbed,
  - [ ] key injected globals are immutable,
  - [ ] global property enumeration is stable for injected names.

- [ ] Add golden/snapshot outputs.

**Acceptance criteria:**

- [ ] Running the suite twice yields identical outputs.

---

# Phase P2 — Canonical gas metering inside QuickJS fork

### T-020: Add gas state to runtime/context

**Phase:** P2 – Canonical gas metering inside QuickJS fork
**Status:** TODO
**Depends on:** T-010

**Goal:**
Introduce canonical gas state and deterministic OOG errors.

**Baseline references:** Baseline #1 §2B

**Detailed tasks:**

- [ ] Add gas fields: gas remaining, gas limit, schedule/version id.
- [ ] Add charge/check helpers.
- [ ] Define deterministic OOG error tag/code distinct from HostError.

**Acceptance criteria:**

- [ ] Harness can trigger OOG deterministically by setting a low gas limit.

---

### T-021: Implement opcode/bytecode metering in interpreter loop

**Phase:** P2 – Canonical gas metering inside QuickJS fork
**Status:** TODO
**Depends on:** T-020

**Goal:**
Charge gas per executed opcode using a versioned cost table.

**Baseline references:** Baseline #1 §2B.1

**Detailed tasks:**

- [ ] Insert gas charge at opcode dispatch (charge-before-execute).
- [ ] Define explicit opcode cost table in one file.
- [ ] Add tests asserting exact gas used for small programs.

**Acceptance criteria:**

- [ ] Gas usage is stable across repeated runs.

---

### T-022: Define deterministic OOG boundary semantics

**Phase:** P2 – Canonical gas metering inside QuickJS fork
**Status:** TODO
**Depends on:** T-021

**Goal:**
Ensure exact out-of-gas point is stable across environments.

**Baseline references:** Baseline #1 §2

**Detailed tasks:**

- [ ] Specify and implement OOG boundaries: opcode precharge, builtin loop checks, host-call boundaries (later).
- [ ] Add tests that hit OOG at a known boundary and assert last successful observable state.

**Acceptance criteria:**

- [ ] OOG boundary tests pass deterministically.

---

### T-023: Meter C-builtins that loop in C (Array.map/filter/reduce)

**Phase:** P2 – Canonical gas metering inside QuickJS fork
**Status:** TODO
**Depends on:** T-021

**Goal:**
Prevent cheap bytecode / expensive builtin loops.

**Baseline references:** Baseline #1 §2B.2

**Detailed tasks:**

- [ ] Add base + per-element charges + OOG checks in map/filter/reduce.
- [ ] Add tests verifying linear scaling and deterministic OOG index.

**Acceptance criteria:**

- [ ] OOG occurs at the same element index for a fixed gas budget.

---

### T-024: Audit and meter/disable other heavy builtins

**Phase:** P2 – Canonical gas metering inside QuickJS fork
**Status:** TODO
**Depends on:** T-017, T-021

**Goal:**
Ensure no builtin performs unmetered large work.

**Baseline references:** Baseline #1 §2B.2, §3

**Detailed tasks:**

- [ ] Inventory heavy builtins (e.g., sort, JSON parse/stringify, string ops).
- [ ] For each: meter deterministically or disable in profile.
- [ ] Update docs and tests accordingly.

**Acceptance criteria:**

- [ ] At least 3 heavy builtin behaviors are covered by tests.

---

### T-025: Allocation gas via allocator hooks

**Phase:** P2 – Canonical gas metering inside QuickJS fork
**Status:** TODO
**Depends on:** T-020

**Goal:**
Charge gas deterministically by requested allocation bytes.

**Baseline references:** Baseline #1 §2B.3

**Detailed tasks:**

- [ ] Wrap allocator hooks; charge `base + bytes*k`.
- [ ] Define realloc charging rule and document it.
- [ ] Add tests for predictable allocations.

**Acceptance criteria:**

- [ ] Allocation-heavy scripts consume deterministic gas and can OOG deterministically.

---

### T-026: Deterministic GC checkpoints and charging

**Phase:** P2 – Canonical gas metering inside QuickJS fork
**Status:** TODO
**Depends on:** T-025

**Goal:**
Run GC only at deterministic checkpoints; charge deterministically.

**Baseline references:** Baseline #1 §2B.3

**Detailed tasks:**

- [ ] Disable/neutralize heuristic auto-GC triggers.
- [ ] Add explicit GC checkpoints at controlled points (init/eval/end, and later after host calls).
- [ ] Define deterministic GC gas rule and test it.

**Acceptance criteria:**

- [ ] GC occurs only at checkpoints; charges match tests.

---

### T-027: Optional gas trace facility

**Phase:** P2 – Canonical gas metering inside QuickJS fork
**Status:** TODO
**Depends on:** T-021

**Goal:**
Enable deterministic gas tracing for golden tests (aggregated counts).

**Detailed tasks:**

- [ ] Add optional trace: opcode counts, builtin charges, allocation totals.
- [ ] Provide a stable export path for harness tests.

**Acceptance criteria:**

- [ ] Trace output is stable and snapshot-testable.

---

### T-028: Native gas golden tests

**Phase:** P2 – Canonical gas metering inside QuickJS fork
**Status:** TODO
**Depends on:** T-022, T-023, T-025, T-026, T-027

**Goal:**
Lock in gas semantics before wasm and host ABI.

**Detailed tasks:**

- [ ] Create representative scripts and expected gas numbers / OOG boundaries.
- [ ] Add harness runner that asserts exact gas used and outcomes.

**Acceptance criteria:**

- [ ] Golden suite passes with exact expected values.

---

# Phase P3 — Baseline #2 host ABI: DV + manifest + single dispatcher + Host.v1

### T-030: Decide and document canonical DV wire encoding

**Phase:** P3 – Host ABI (DV + manifest + syscall)
**Status:** TODO
**Depends on:** T-005

**Goal:**
Pick one canonical encoding for DV used for args/returns and (preferably) manifest bytes.

**Baseline references:** Baseline #2 §2.7

**Detailed tasks:**

- [ ] Evaluate candidate formats (canonical CBOR, JCS, custom minimal binary).
- [ ] Choose one and fully specify it in `docs/dv-wire-format.md`:

  - [ ] type tags, lengths, UTF-8 handling,
  - [ ] numeric restrictions: finite, no NaN/Inf, no -0 (canonicalize),
  - [ ] object key uniqueness + canonical key ordering,
  - [ ] max sizes/depth.

- [ ] Add examples (at least 5) with expected encoded form described.

**Acceptance criteria:**

- [ ] `docs/dv-wire-format.md` is normative and unambiguous.

---

### T-031: Implement DV encode/decode in TypeScript (`libs/dv`)

**Phase:** P3 – Host ABI (DV + manifest + syscall)
**Status:** TODO
**Depends on:** T-030, T-002

**Goal:**
Provide TS reference implementation for DV validation and canonical encode/decode.

**Baseline references:** Baseline #2 §2.1–§2.7

**Detailed tasks:**

- [ ] Define DV TS types and runtime validators.
- [ ] Implement canonical encode/decode per spec.
- [ ] Enforce numeric/string/object rules and limits.
- [ ] Add property-based tests for roundtrip and canonicalization.

**Acceptance criteria:**

- [ ] `pnpm nx test dv` passes; includes non-canonical input tests.

---

### T-032: Implement VM-side DV encode/decode (QuickJS fork)

**Phase:** P3 – Host ABI (DV + manifest + syscall)
**Status:** TODO
**Depends on:** T-030, T-010

**Goal:**
Implement C encode/decode for DV to bridge JS values and request/response bytes deterministically.

**Baseline references:** Baseline #2 §2, §6.2

**Detailed tasks:**

- [ ] JS→DV conversion enforcing DV restrictions deterministically.
- [ ] DV→JS conversion preserving canonical key insertion order.
- [ ] Enforce limits.
- [ ] Add harness tests that compare encoded bytes to TS reference fixtures.

**Acceptance criteria:**

- [ ] Byte-level parity tests vs `libs/dv` pass for a shared fixture set.

---

### T-033: Define ABI manifest schema and canonical serialization

**Phase:** P3 – Host ABI (DV + manifest + syscall)
**Status:** TODO
**Depends on:** T-030, T-005

**Goal:**
Define manifest schema, canonical bytes, and hashing rules.

**Baseline references:** Baseline #2 §1.3–§1.4, §7

**Detailed tasks:**

- [ ] Write `docs/abi-manifest.md` specifying:

  - [ ] top-level fields (`abi_id`, `abi_version`, entries),
  - [ ] entry fields: `fn_id`, `js_path`, `arity`, `arg_schema`, `return_schema`, `effect`, `gas_schedule_id`, `limits`, `error_codes`,
  - [ ] canonical serialization rules (prefer DV encoding from T-030),
  - [ ] hash algorithm + output format.

- [ ] Define a minimal schema language sufficient for initial functions (don’t overbuild).

**Acceptance criteria:**

- [ ] Doc includes a complete example manifest for `Host.v1` with at least document.get/getCanonical.

---

### T-034: Implement manifest tooling in TypeScript (`libs/abi-manifest`)

**Phase:** P3 – Host ABI (DV + manifest + syscall)
**Status:** TODO
**Depends on:** T-031, T-033

**Goal:**
Provide TS tools to create canonical manifest bytes and compute `abi_manifest_hash` for inclusion in `P`.

**Baseline references:** Baseline #2 §1.3

**Detailed tasks:**

- [ ] Implement manifest types + validators.
- [ ] Implement canonical serialization to bytes.
- [ ] Implement hashing function (same as VM).
- [ ] Add tests asserting stable bytes and hash for a fixture manifest.

**Acceptance criteria:**

- [ ] `pnpm nx test abi-manifest` passes with stable fixture hashes.

---

### T-035: Define the initial ABI surface manifest (v1) used by this evaluator

**Phase:** P3 – Host ABI (DV + manifest + syscall)
**Status:** TODO
**Depends on:** T-033

**Goal:**
Lock down the minimal host ABI surface required by the read-only evaluator.

**Baseline references:** Baseline #2 §1.4, §9

**Detailed tasks:**

- [ ] Create a fixture manifest (checked into `libs/test-harness/fixtures/`) that defines:

  - [ ] `Host.v1.document.get(path)` (READ)
  - [ ] `Host.v1.document.getCanonical(path)` (READ)
  - [ ] Optional: `Host.v1.emit(value)` (EMIT) for deterministic logging/tape (recommended)

- [ ] Define per-function limits and error codes (path invalid, not found, limit exceeded).
- [ ] Define per-function gas schedule parameters (base, k_arg_bytes, k_out_bytes, k_units).

**Acceptance criteria:**

- [ ] Fixture manifest can be serialized + hashed by `libs/abi-manifest` reproducibly.

---

### T-036: Implement VM-side manifest hash validation during initialization

**Phase:** P3 – Host ABI (DV + manifest + syscall)
**Status:** TODO
**Depends on:** T-033, T-010

**Goal:**
VM receives manifest bytes at init, computes hash, and exact-matches `abi_manifest_hash` pinned in `P`.

**Baseline references:** Baseline #2 §1.3

**Detailed tasks:**

- [ ] Implement the hash algorithm in C (matching TS).
- [ ] Add VM init API parameters for: manifest bytes, expected hash, gas limit, and context blob.
- [ ] On mismatch, fail deterministically with fixed error code/tag.

**Acceptance criteria:**

- [ ] Harness test verifies correct manifest passes and incorrect hash fails deterministically.

---

### T-037: Specify the Wasm `host_call` import ABI and memory ownership

**Phase:** P3 – Host ABI (DV + manifest + syscall)
**Status:** TODO
**Depends on:** T-005

**Goal:**
Define the exact Wasm import signature and buffer ownership rules implementing `host_call(fn_id, request_bytes) -> response_bytes`.

**Baseline references:** Baseline #2 §1.1, §4.4

**Detailed tasks:**

- [ ] Write `docs/host-call-abi.md` specifying:
  - [ ] function signature (fn_id + ptr/len for req; plus a response mechanism),
  - [ ] max request/response sizes,
  - [ ] error behavior for malformed responses,
  - [ ] memory ownership (who allocates response bytes and how VM reads them),
  - [ ] explicit no-reentrancy rule (host_call cannot call back into VM).

**Acceptance criteria:**

- [ ] The ABI doc is unambiguous enough to implement in both wasm host (TS) and VM (C).

---

### T-038: Implement VM-side syscall dispatcher plumbing + reentrancy guard

**Phase:** P3 – Host ABI (DV + manifest + syscall)
**Status:** TODO
**Depends on:** T-037, T-020

**Goal:**
Add a single syscall path from VM to host with deterministic guardrails.

**Baseline references:** Baseline #2 §1.1, §4.4

**Detailed tasks:**

- [ ] Implement `host_call` invocation layer in the fork that works in both:

  - [ ] native harness (function pointer callback), and
  - [ ] wasm build (imported function).

- [ ] Add a reentrancy guard preventing nested host calls.
- [ ] Add deterministic failures for oversized request/response.

**Acceptance criteria:**

- [ ] Native harness can register a host_call stub and receive deterministic responses.
- [ ] Reentrancy is detected and fails deterministically.

---

### T-039: Define and implement the host-call response envelope + deterministic HostError

**Phase:** P3 – Host ABI (DV + manifest + syscall)
**Status:** TODO
**Depends on:** T-032, T-038

**Goal:**
Standardize host responses as `Ok(DV)` or `Err({code, tag, details?})` plus deterministic `units`.

**Baseline references:** Baseline #2 §1.6, §3.2

**Detailed tasks:**

- [ ] Define the response envelope structure (as DV) including:

  - [ ] ok vs err,
  - [ ] `units` (u32),
  - [ ] optional metadata needed for charging/tape.

- [ ] Implement parsing/validation in VM.
- [ ] Implement deterministic error throwing: `HostError` with stable `{code, tag}`.

**Acceptance criteria:**

- [ ] VM throws deterministic HostError for Err responses.
- [ ] Malformed envelopes are rejected with deterministic VM error.

---

### T-040: Generate `Host.v1` namespace from manifest in VM

**Phase:** P3 – Host ABI (DV + manifest + syscall)
**Status:** TODO
**Depends on:** T-036, T-039, T-035

**Goal:**
Expose host functions in JS as `Host.v1.*`, generated from manifest entries (js_path), frozen and immutable.

**Baseline references:** Baseline #2 §1.5, §6.2–§6.3

**Detailed tasks:**

- [ ] Parse manifest entries and install nested namespace objects (null prototype).
- [ ] For each entry, create a JS wrapper that:

  - [ ] validates args by `arg_schema`,
  - [ ] DV-encodes args,
  - [ ] performs pre-charge gas (base + arg_bytes),
  - [ ] calls host_call(fn_id, req_bytes),
  - [ ] validates response envelope,
  - [ ] performs post-charge gas (out_bytes + units),
  - [ ] returns DV or throws HostError.

- [ ] Freeze and make namespaces non-extensible, non-writable, non-configurable.

**Acceptance criteria:**

- [ ] With the fixture manifest, `Host.v1.document.get` exists and is callable.
- [ ] Attempts to mutate `Host` or sub-objects fail deterministically.

---

### T-041: Install Blue-style ergonomic globals using Host.v1 wrappers

**Phase:** P3 – Host ABI (DV + manifest + syscall)
**Status:** TODO
**Depends on:** T-040

**Goal:**
Provide `document()`, `event`, `steps`, and `canon` helpers consistent with Blue’s JS context, while keeping Host.v1 canonical.

**Baseline references:** Baseline #2 §6.4–§6.5, §9

**Detailed tasks:**

- [ ] Implement `document(path)` as a wrapper calling `Host.v1.document.get(path)`.
- [ ] Implement `document.canonical(path)` calling `Host.v1.document.getCanonical(path)`.
- [ ] Accept injected DV values for `event`, `eventCanonical`, `steps` from input envelope `I` (wired later).
- [ ] Implement `canon.unwrap` and `canon.at` as pure JS helpers (loaded deterministically by init).
- [ ] Freeze/lock `document`, `event`, `eventCanonical`, `steps`, `canon`.

**Acceptance criteria:**

- [ ] A test script can call `document("x")` and read `event`/`steps`.
- [ ] Helpers behave deterministically and cannot be overridden by user code.

---

### T-042: Implement two-phase gas charging for host calls (VM)

**Phase:** P3 – Host ABI (DV + manifest + syscall)
**Status:** TODO
**Depends on:** T-040, T-022

**Goal:**
Ensure host calls incur deterministic gas independent of host performance.

**Baseline references:** Baseline #2 §3.2–§3.4

**Detailed tasks:**

- [ ] Implement pre-charge: base + arg_bytes \* k_arg.
- [ ] Implement post-charge: out*bytes * k*out + units * k_units.
- [ ] Ensure OOG after host returns results in deterministic abort with no additional effects (for READ-only this is simpler; still must be deterministic).
- [ ] Add tests for host-call gas formulas using a mock host_call stub.

**Acceptance criteria:**

- [ ] Gas charged for host calls matches expected formula exactly.

---

### T-043: Add optional VM-side tape for auditing host calls

**Phase:** P3 – Host ABI (DV + manifest + syscall)
**Status:** TODO
**Depends on:** T-042

**Goal:**
Provide deterministic audit traces (request/response hashes, fn_id, gas breakdown).

**Baseline references:** Baseline #2 §5

**Detailed tasks:**

- [ ] Define tape record fields and hashing algorithm(s) (document).
- [ ] Implement bounded tape buffer in VM.
- [ ] Expose tape output deterministically as part of evaluation result.

**Acceptance criteria:**

- [ ] Tape enabled runs produce identical tape across repeated executions.

---

# Phase P4 — Emscripten build pipeline and deterministic Wasm artifacts

### T-050: Implement `libs/quickjs-wasm-build` pipeline scaffolding

**Phase:** P4 – Emscripten build and deterministic artifacts
**Status:** TODO
**Depends on:** T-003, T-004, T-002

**Goal:**
Compile the forked QuickJS to Wasm using pinned Emscripten.

**Baseline references:** Baseline #1 §1A

**Detailed tasks:**

- [ ] Add Nx build target invoking emcc on QuickJS sources + fork changes.
- [ ] Emit `.wasm` + loader/glue into deterministic `dist/` paths.
- [ ] Emit build metadata (engine build hash placeholder).

**Acceptance criteria:**

- [ ] `pnpm nx build quickjs-wasm-build` produces wasm + JS glue outputs.

---

### T-051: Enforce deterministic Wasm memory sizing + disable nondeterministic Emscripten features

**Phase:** P4 – Emscripten build and deterministic artifacts
**Status:** TODO
**Depends on:** T-050

**Goal:**
Freeze memory growth and remove nondeterministic runtime features.

**Baseline references:** Baseline #1 §2C

**Detailed tasks:**

- [ ] Configure fixed memory sizing (min == max or strictly controlled).
- [ ] Ensure no FS/network/syscalls.
- [ ] Ensure build outputs don’t embed timestamps or env-dependent differences.
- [ ] Document chosen flags in `docs/toolchain.md`.

**Acceptance criteria:**

- [ ] Wasm memory growth is disabled/fixed per build inspection.
- [ ] Wasm bytes hash is stable across repeated builds with identical inputs.

---

### T-052: Package artifacts into `libs/quickjs-wasm`

**Phase:** P4 – Emscripten build and deterministic artifacts
**Status:** TODO
**Depends on:** T-050, T-002

**Goal:**
Publish Wasm bytes + loader and metadata in a consumable library.

**Detailed tasks:**

- [ ] Define public API for getting wasm bytes (Node + browser).
- [ ] Ensure `.wasm` is included in package output.
- [ ] Export engine metadata (engine build hash, feature flags).

**Acceptance criteria:**

- [ ] Node script can import `quickjs-wasm` and obtain wasm bytes.
- [ ] Browser app can load wasm from the same package.

---

### T-053: Add release and debug Wasm variants (same semantics)

**Phase:** P4 – Emscripten build and deterministic artifacts
**Status:** TODO
**Depends on:** T-051

**Goal:**
Provide two variants without changing semantics (debug adds assertions/tape, not behavior).

**Baseline references:** Baseline #1 §1A

**Detailed tasks:**

- [ ] Add release build config.
- [ ] Add debug config (asserts/tracing).
- [ ] Ensure runtime can select variant and that variant identity is pinnable via `P` metadata.

**Acceptance criteria:**

- [ ] Both variants build and run the same sample program successfully.

---

### T-054: Optional Wasm-level safety fuse (non-canonical)

**Phase:** P4 – Emscripten build and deterministic artifacts
**Status:** TODO
**Depends on:** T-051

**Goal:**
Add an optional safety fuse (not canonical gas) to prevent runaway computation.

**Baseline references:** Baseline #1 §2A

**Detailed tasks:**

- [ ] Choose a fuse mechanism (wasm-instrument or equivalent).
- [ ] Ensure fuse is optional and produces deterministic failure.
- [ ] Document that canonical gas remains the QuickJS meter.

**Acceptance criteria:**

- [ ] Fuse can be triggered deterministically in a test without affecting canonical gas accounting.

---

# Phase P5 — TypeScript SDK (`libs/quickjs-runtime`) + host dispatcher adapter

### T-060: Define program artifact `P` and input envelope `I` types

**Phase:** P5 – TypeScript runtime SDK
**Status:** TODO
**Depends on:** T-034, T-031

**Goal:**
Make `(P, I, G)` explicit and version-pin critical ABI/engine fields.

**Baseline references:** Baseline #2 §1.3; Baseline #1 §1C

**Detailed tasks:**

- [ ] Define `P` structure in TS including:

  - [ ] code (source string for now),
  - [ ] `abi_id`, `abi_version`,
  - [ ] `abi_manifest_hash`,
  - [ ] optional `engine_build_hash` / runtime flags.

- [ ] Define `I` structure in TS including:

  - [ ] `event` DV, `eventCanonical` DV, `steps` DV,
  - [ ] a document snapshot identity (epoch/hash/id) for auditability,
  - [ ] any additional deterministic inputs required by host calls.

- [ ] Add validation helpers.

**Acceptance criteria:**

- [ ] `quickjs-runtime` can validate P and I and produce deterministic validation errors.

---

### T-061: Implement TS host dispatcher adapter that powers wasm `host_call`

**Phase:** P5 – TypeScript runtime SDK
**Status:** TODO
**Depends on:** T-031, T-037, T-035

**Goal:**
Implement the host-side `host_call` function in TS, using embedder-provided deterministic document access and optional emit handling.

**Baseline references:** Baseline #2 §1.1–§1.2, §3.4, §4.4

**Detailed tasks:**

- [ ] Define a minimal embedder-facing interface for document reads (read-only):

  - [ ] `get(path) -> { ok DV | err {code,tag,details?}, units }`
  - [ ] `getCanonical(path) -> { ok DV | err ..., units }`
  - (units is required unless you can prove a tight bound from sizes alone.)

- [ ] Implement a dispatcher that:

  - [ ] receives `fn_id` + request bytes,
  - [ ] DV-decodes args,
  - [ ] routes to correct handler based on fn_id,
  - [ ] enforces manifest limits (max req/resp bytes, max units),
  - [ ] returns DV-encoded response envelope bytes.

- [ ] Ensure deterministic errors on malformed requests or unknown fn_id.

**Implementation hints (for Codex):**

- Manifest is authoritative. Do not accept functions not in the manifest.
- Keep dispatch synchronous; enforce no reentrancy (lock).

**Acceptance criteria:**

- [ ] Given mock handlers, dispatcher returns stable response bytes and units.
- [ ] Unknown fn_id yields deterministic Err response.

---

### T-062: Implement `quickjs-runtime` Wasm instantiation (Node + browser)

**Phase:** P5 – TypeScript runtime SDK
**Status:** TODO
**Depends on:** T-052, T-061

**Goal:**
Load the same wasm bytes everywhere and instantiate with the TS `host_call` adapter.

**Baseline references:** Baseline #1 §1A; Baseline #2 §6.1

**Detailed tasks:**

- [ ] Load wasm bytes via `libs/quickjs-wasm` in Node and browser.
- [ ] Instantiate wasm with imports including `host_call` per `docs/host-call-abi.md`.
- [ ] Provide a `createRuntime()` API that prepares an instance for evaluation.

**Acceptance criteria:**

- [ ] Node and browser can instantiate runtime successfully using the same wasm bytes.

---

### T-063: Implement runtime initialization handshake (manifest bytes, hash, I blob, gas)

**Phase:** P5 – TypeScript runtime SDK
**Status:** TODO
**Depends on:** T-060, T-062, T-036

**Goal:**
Initialize VM deterministically with manifest validation and injected globals before user code runs.

**Baseline references:** Baseline #2 §6.1–§6.2

**Detailed tasks:**

- [ ] Pass manifest bytes to VM and provide expected manifest hash from `P`.
- [ ] Pass `I` as canonical DV bytes (preferred) or a deterministic context blob.
- [ ] Set gas limit `G`.
- [ ] Ensure VM installs `Host.v1` and Blue-style globals before evaluating code.

**Acceptance criteria:**

- [ ] Manifest hash mismatch fails deterministically.
- [ ] Injected globals exist and are immutable.

---

### T-064: Implement `evaluate(P, I, G, host)` API and result model

**Phase:** P5 – TypeScript runtime SDK
**Status:** TODO
**Depends on:** T-063, T-041, T-042

**Goal:**
Provide a single-call deterministic evaluator entrypoint suitable for embedding in `document-processor`.

**Baseline references:** Baseline #1 §1–§2; Baseline #2 §0.3

**Detailed tasks:**

- [ ] Implement `evaluate()` that:

  - [ ] validates P and I,
  - [ ] initializes VM,
  - [ ] evaluates `P.code`,
  - [ ] returns result DV (or deterministic error), gas used/remaining, and optional tape.

- [ ] Ensure return value is DV-validated (JS can only return DV types or deterministic error).

**Acceptance criteria:**

- [ ] Same `(P,I,G)` yields identical result across Node and browser for a fixture set.

---

### T-065: Stable error mapping (VM OOG vs HostError vs DV/manifest errors)

**Phase:** P5 – TypeScript runtime SDK
**Status:** TODO
**Depends on:** T-064

**Goal:**
Expose stable error objects in TS without leaking host-specific data.

**Baseline references:** Baseline #2 §1.6; Baseline #1 determinism

**Detailed tasks:**

- [ ] Define structured error types with stable `code/tag` fields.
- [ ] Map VM-thrown deterministic errors into these types.
- [ ] Ensure stack traces are not part of determinism comparisons (optionally available only in debug mode).

**Acceptance criteria:**

- [ ] Errors match by code/tag across Node/browser for the same failure.

---

### T-066: Ensure returned JS values are DV-only (enforce in VM and TS)

**Phase:** P5 – TypeScript runtime SDK
**Status:** TODO
**Depends on:** T-064, T-031, T-032

**Goal:**
Prevent nondeterministic or unsupported return types from escaping the evaluator.

**Baseline references:** Baseline #2 §2.1

**Detailed tasks:**

- [ ] VM enforces return type conversion into DV (or deterministic error).
- [ ] TS validates returned DV bytes and rejects malformed outputs deterministically.
- [ ] Add tests for forbidden return types (functions, undefined, symbols, BigInt, etc.).

**Acceptance criteria:**

- [ ] Forbidden return types produce deterministic errors across environments.

---

# Phase P6 — Smoke apps (developer UX)

### T-070: Node smoke runner (`apps/smoke-node`)

**Phase:** P6 – Smoke apps
**Status:** TODO
**Depends on:** T-064

**Goal:**
Provide a CLI-like dev runner for quick debugging and fixtures.

**Detailed tasks:**

- [ ] Load sample fixture `(P, I, G, manifest)` and create a mock host implementation.
- [ ] Run evaluate and print a stable summary: result DV hash, gas used, tape count, error code/tag.
- [ ] Provide a “debug” mode that prints decoded DV JSON (still deterministic).

**Acceptance criteria:**

- [ ] `pnpm nx serve smoke-node` runs a sample deterministically.

---

### T-071: Browser smoke runner (`apps/smoke-web`)

**Phase:** P6 – Smoke apps
**Status:** TODO
**Depends on:** T-064, T-053

**Goal:**
Run the same fixtures in browser and show stable results and wasm hash.

**Detailed tasks:**

- [ ] Load wasm from `quickjs-wasm`.
- [ ] Run the same fixture set as Node.
- [ ] Display: wasm hash, result hash, gas used, error code/tag, tape hash.

**Acceptance criteria:**

- [ ] Browser output matches Node output for the same fixtures.

---

# Phase P7 — Determinism & gas test harnesses, CI, docs hardening

### T-080: Cross-environment determinism harness (Node vs headless browser)

**Phase:** P7 – Determinism & CI
**Status:** TODO
**Depends on:** T-071, T-028, T-064

**Goal:**
Prove Baseline determinism: same `(P, I, G)` yields identical outputs and OOG points in Node and browser.

**Baseline references:** Baseline #1 §1–§2; Baseline #2 §0.3

**Detailed tasks:**

- [ ] Set up Playwright to run `smoke-web` headlessly or run a direct test page.
- [ ] Create fixtures in `libs/test-harness`: P, I, G, manifest bytes + expected hashes.
- [ ] Compare Node vs browser outputs:
  - [ ] returned DV bytes hash,
  - [ ] error code/tag (if any),
  - [ ] gas used/remaining,
  - [ ] tape hash (if enabled).

**Acceptance criteria:**

- [ ] At least 5 fixtures pass cross-env with exact equality of compared fields.

---

### T-081: Host-call determinism + gas-by-size/units tests

**Phase:** P7 – Determinism & CI
**Status:** TODO
**Depends on:** T-042, T-061, T-080

**Goal:**
Verify host-call charging and deterministic behavior for document reads.

**Baseline references:** Baseline #2 §3.2–§3.4

**Detailed tasks:**

- [ ] Add fixtures that call `document()` repeatedly with varying paths.
- [ ] Use mock host that returns deterministic DV and units.
- [ ] Assert gas formula correctness (pre/post charge) and OOG boundaries on host calls.
- [ ] Assert deterministic Err responses for invalid path/not found/limit exceeded.

**Acceptance criteria:**

- [ ] Gas and errors match exactly across Node/browser for host-call-heavy scripts.

---

### T-082: Manifest pinning tests (wrong hash, wrong manifest, wrong fn_id mapping)

**Phase:** P7 – Determinism & CI
**Status:** TODO
**Depends on:** T-036, T-064

**Goal:**
Ensure ABI pinning is enforced deterministically.

**Baseline references:** Baseline #2 §1.3–§1.4

**Detailed tasks:**

- [ ] Test: manifest hash mismatch fails deterministically.
- [ ] Test: manifest entry order changes but canonical serialization yields same hash (if canonicalized).
- [ ] Test: unknown fn_id invoked fails deterministically.

**Acceptance criteria:**

- [ ] All ABI mismatch scenarios are deterministic and code/tag stable.

---

### T-083: CI pipeline (build, test, wasm build, browser tests)

**Phase:** P7 – Determinism & CI
**Status:** TODO
**Depends on:** T-080, T-004

**Goal:**
Add CI that builds and tests everything including headless browser determinism and wasm builds.

**Detailed tasks:**

- [ ] Add CI workflow steps: install, lint, unit tests, native harness tests, wasm build, Playwright tests.
- [ ] Cache pnpm store and emsdk.
- [ ] Upload wasm artifacts as CI artifacts (optional).

**Acceptance criteria:**

- [ ] CI passes from a clean checkout.
- [ ] Determinism tests are not flaky.

---

### T-084: Documentation hardening (make docs normative)

**Phase:** P7 – Determinism & CI
**Status:** TODO
**Depends on:** T-080

**Goal:**
Update docs to match implementation and tests.

**Detailed tasks:**

- [ ] Finalize determinism profile doc (exact allowed/disabled APIs).
- [ ] Finalize gas schedule doc (opcode costs, builtin costs, alloc/GC, host call costs).
- [ ] Finalize DV wire format and manifest docs with examples.
- [ ] Add “Determinism checklist” in root README.

**Acceptance criteria:**

- [ ] Docs contain testable statements that match harness assertions.

---

### T-085: Release packaging strategy (pin engine + ABI)

**Phase:** P7 – Determinism & CI
**Status:** TODO
**Depends on:** T-053, T-064

**Goal:**
Define versioning/publishing so consumers can pin engine/ABI reliably.

**Baseline references:** Baseline #1 §1A; Baseline #2 §7

**Detailed tasks:**

- [ ] Define publishing for `quickjs-wasm`, `quickjs-runtime`, `dv`, `abi-manifest`.
- [ ] Define how `engine_build_hash` is computed and exposed.
- [ ] Define semver policy: what changes require new engine hash, new manifest, or new fn_id.
- [ ] Add release checklist doc.

**Acceptance criteria:**

- [ ] Release policy is documented and aligns with P pinning requirements.

---

## Appendix A — Minimal required ABI surface (v1)

The initial manifest should define at least:

- `Host.v1.document.get(path: string) -> DV` (READ)
- `Host.v1.document.getCanonical(path: string) -> DV` (READ)
- Optional but recommended for deterministic logging:
  - `Host.v1.emit(value: DV) -> null` (EMIT)

Ergonomic aliases:

- `document(path)` calls `Host.v1.document.get(path)`
- `document.canonical(path)` calls `Host.v1.document.getCanonical(path)`
- `event`, `eventCanonical`, `steps` injected from input envelope `I`
- `canon.unwrap` and `canon.at` are pure JS helpers installed by init

---

## Appendix B — Invariants checklist (what tests must prove)

- **Determinism:** Same `(P, I, G)` ⇒ same outputs + same exact OOG point across Node and browser.
- **Canonical gas:** opcode + metered C builtins + deterministic alloc/GC; not wasm instruction counts.
- **Strict capability profile:** no time/random/async/network/fs/locale leaks; no typed arrays/ArrayBuffer/WebAssembly.
- **Baseline #2 ABI:** single dispatcher + numeric fn_id + manifest-locked mapping + manifest hash validation.
- **DV restrictions:** only allowed types; numeric restrictions; canonical key ordering; deterministic encoding.
- **Two-phase host-call charging:** base+arg bytes before call; out bytes+units after; deterministic OOG boundaries.
- **No reentrancy:** host_call cannot call back into VM or nest host calls.

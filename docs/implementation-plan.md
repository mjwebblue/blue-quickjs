# Deterministic QuickJS-in-Wasm Runtime (Nx Monorepo) — Implementation Plan

This file is the “source of truth” execution plan for Codex (Cursor IDE) to implement a deterministic QuickJS-in-Wasm runtime with canonical gas metering and a manifest-locked deterministic host-call ABI.

---

## Overview (end state)

- **Nx monorepo** (TypeScript-first) using **pnpm**, with consistent tooling (lint/format/test/build) and CI.
- **QuickJS fork** lives as a **git submodule** at `vendor/quickjs` (pinned commit), with deterministic + gas + syscall ABI changes made in the fork.
- **Canonical gas metering is inside QuickJS** (bytecode/opcode-level + metered C builtins + deterministic allocation/GC charging), per **Baseline #1 §2B**.
- **Wasm artifacts** are built via **Emscripten** in a dedicated package `libs/quickjs-wasm-build/`, producing a deterministic `.wasm` with **fixed memory sizing** (min == max) per **Baseline #1 §2C**.
- A distributable package `libs/quickjs-wasm/` contains the **Wasm bytes + loader glue + build metadata** (engine build hash, feature flags).
- A TypeScript SDK `libs/quickjs-runtime/` provides a clean API to:

  - load/instantiate the **same Wasm bytes** in Node and browsers (Baseline #1 §1A),
  - initialize the VM with `(P, I, G)` and enforce deterministic profile,
  - connect host functions through a **single syscall dispatcher** with a **manifest-locked numeric-ID ABI** (Baseline #2 §1.1–1.4).

- A host library `libs/host/` implements:

  - host dispatcher `host_call(fn_id, req_bytes) -> resp_bytes`,
  - DV (Deterministic Value) validation + canonical wire encoding,
  - transactional overlay and document helpers (`document(path)`, `document.canonical(path)`, etc.),
  - deterministic “tape” for auditing (optional) (Baseline #2 §5).

- `libs/blue-integration/` adapts this runtime into Blue’s Sequential Workflow JS context (`event`, `eventCanonical`, `document`, `steps`, `canon`) without redesigning Blue’s document processor.
- Determinism and gas are validated by a **cross-environment test harness** (Node + headless browser via Playwright), including OOG point equality and overlay rollback determinism (Baselines #1 and #2).

---

## Proposed repository layout

```
/
  vendor/
    quickjs/                  # git submodule: your fork
  libs/
    dv/                       # DV types + canonical encode/decode + validation
    abi-manifest/             # ABI manifest schema + canonicalization + hashing
    quickjs-wasm-build/       # Emscripten build pipeline (Nx executor/targets)
    quickjs-wasm/             # Published artifacts: wasm bytes + loader + metadata
    quickjs-runtime/          # SDK: instantiate, run, inject context, handle host_call
    host/                     # Host dispatcher + overlay + document helpers + tape
    blue-integration/         # Adapters to Blue sequential workflow context
    test-harness/             # Shared fixtures + golden tests + cross-env runners
  apps/
    smoke-node/               # minimal CLI runner (dev + debugging)
    smoke-web/                # minimal browser runner (dev + determinism checks)
  tools/
    nx-executors/             # custom executors (optional), build helpers
    scripts/                  # pinned toolchain setup, checks
  docs/
    determinism-profile.md
    gas-schedule.md
    dv-wire-format.md
    abi-manifest.md
    implementation-plan.md
```

---

## How to use this plan with Codex (Cursor IDE)

- Codex should always pick the **next `Status: TODO` ticket** whose dependencies are all done.
- Each ticket is designed to be implemented in one focused session: create/modify files, add tests, update Nx targets, and commit.
- After completing a ticket, update its `Status` to `DONE` in this file (keep the ticket content; only change status).
- Prefer **small, observable increments**: each ticket has acceptance criteria that can be tested with `pnpm nx test ...`, `pnpm nx build ...`, or a smoke runner.

---

# Phase P0 — Monorepo bootstrap and standards

### T-000: Initialize Nx workspace with pnpm

**Phase:** P0 – Monorepo bootstrap and standards
**Status:** DONE
**Depends on:** None

**Goal:**
Create the Nx monorepo scaffold with pnpm workspaces, consistent TypeScript configuration, and a baseline build/test story.

**Detailed tasks:**

- [ ] Initialize Nx workspace (integrated monorepo style) with TypeScript support.
- [ ] Configure pnpm workspace (`pnpm-workspace.yaml`) and root `package.json` scripts.
- [ ] Add Node engine version policy (e.g., `.nvmrc` and/or `package.json#engines`).
- [ ] Add base `tsconfig.base.json` and workspace path aliases strategy.
- [ ] Verify `pnpm nx graph` runs.

**Implementation hints (for Codex):**

- Root-level files: `nx.json`, `tsconfig.base.json`, `package.json`, `pnpm-workspace.yaml`.
- Use Nx plugins appropriate for TS libs and Node apps (`@nx/js`, `@nx/node`, etc.).

**Acceptance criteria:**

- [ ] `pnpm install` succeeds.
- [ ] `pnpm nx graph` renders without errors.
- [ ] A placeholder `pnpm nx run-many -t test` runs (even if no projects yet).

---

### T-001: Establish repo-wide lint/format conventions

**Phase:** P0 – Monorepo bootstrap and standards
**Status:** TODO
**Depends on:** T-000

**Goal:**
Standardize formatting and linting so Codex can make consistent changes across the repo.

**Detailed tasks:**

- [ ] Add Prettier config and ignore files.
- [ ] Add ESLint config for TypeScript projects.
- [ ] Configure Nx lint targets for future libs.
- [ ] Add EditorConfig and basic repo hygiene (`.gitignore`).
- [ ] Add a root `pnpm format` and `pnpm lint` script.

**Implementation hints (for Codex):**

- Keep rules pragmatic; avoid heavy style debates.
- Ensure configs work for ESM-first TypeScript output.

**Acceptance criteria:**

- [ ] `pnpm format` runs and formats at least the repo config files.
- [ ] `pnpm lint` runs successfully (no projects yet is acceptable if it exits cleanly).

---

### T-002: Create initial libs/apps skeletons (empty but buildable)

**Phase:** P0 – Monorepo bootstrap and standards
**Status:** TODO
**Depends on:** T-001

**Goal:**
Create Nx projects for all major libs and smoke apps so later tickets can wire functionality incrementally.

**Detailed tasks:**

- [ ] Create publishable library projects under `libs/`:

  - [ ] `dv`
  - [ ] `abi-manifest`
  - [ ] `quickjs-wasm-build`
  - [ ] `quickjs-wasm`
  - [ ] `quickjs-runtime`
  - [ ] `host`
  - [ ] `blue-integration`
  - [ ] `test-harness`

- [ ] Create apps under `apps/`: `smoke-node`, `smoke-web`.
- [ ] Ensure each project has: `project.json`, `package.json`, `src/index.ts`, and a trivial test.

**Implementation hints (for Codex):**

- Prefer Nx “package-based” libs where each package has its own `package.json`.
- Use a single TS build approach repo-wide (Nx `tsc` executor or `tsup`) and keep it consistent.

**Acceptance criteria:**

- [ ] `pnpm nx run-many -t build` succeeds (even if builds are trivial).
- [ ] `pnpm nx run-many -t test` succeeds (trivial tests).

---

### T-003: Add QuickJS fork as git submodule at `vendor/quickjs`

**Phase:** P0 – Monorepo bootstrap and standards
**Status:** TODO
**Depends on:** T-000

**Goal:**
Bring your QuickJS fork into the monorepo as a pinned submodule under `vendor/quickjs`.

**Detailed tasks:**

- [ ] Add the git submodule under `vendor/quickjs`.
- [ ] Add `vendor/README.md` documenting submodule update workflow.
- [ ] Add a root doc snippet describing that changes to QuickJS happen in the fork and are referenced by submodule commit.

**Implementation hints (for Codex):**

- Keep QuickJS modifications inside the submodule, not copied into `libs/`.
- Ensure the repo doesn’t accidentally treat submodule files as Nx projects.

**Acceptance criteria:**

- [ ] Fresh clone + `git submodule update --init --recursive` produces `vendor/quickjs` populated.
- [ ] A minimal `ls vendor/quickjs` shows expected QuickJS sources.

---

### T-004: Add toolchain pinning strategy for Emscripten (local + CI)

**Phase:** P0 – Monorepo bootstrap and standards
**Status:** TODO
**Depends on:** T-000

**Goal:**
Pin Emscripten/emsdk version and provide a repeatable local setup so Wasm builds are stable and deterministic.

**Detailed tasks:**

- [ ] Choose a pinned emsdk version and record it in `tools/scripts/emsdk-version.txt` (or similar).
- [ ] Add a setup script (documented) to install/activate pinned emsdk locally.
- [ ] Add CI notes on caching emsdk install directories.
- [ ] Add a `docs/toolchain.md` describing prerequisites.

**Implementation hints (for Codex):**

- Keep the toolchain path out of repo state; scripts should be idempotent.
- Don’t assume system emcc; always prefer pinned emsdk.

**Acceptance criteria:**

- [ ] A developer can follow docs to run `emcc --version` and see the pinned version.
- [ ] CI can install the pinned toolchain in a single job step (even if CI isn’t added yet).

---

### T-005: Add docs scaffolding for determinism/gas/ABI specs

**Phase:** P0 – Monorepo bootstrap and standards
**Status:** TODO
**Depends on:** T-001

**Goal:**
Create documentation placeholders that later tickets will fill in, aligned with Baseline #1 and Baseline #2.

**Detailed tasks:**

- [ ] Create `docs/determinism-profile.md` (capabilities allowed/removed).
- [ ] Create `docs/gas-schedule.md` (versioned gas tables, opcode + builtin + host-call).
- [ ] Create `docs/dv-wire-format.md` (DV canonical encoding spec placeholder).
- [ ] Create `docs/abi-manifest.md` (manifest schema and hashing placeholder).
- [ ] Link these docs from root `README.md`.

**Implementation hints (for Codex):**

- Keep these docs short initially; later tickets will add details as decisions finalize.

**Acceptance criteria:**

- [ ] Docs exist and are linked from root `README.md`.
- [ ] Each doc references the relevant baseline sections explicitly.

---

# Phase P1 — QuickJS harness and deterministic capability profile

### T-010: Create a minimal native (non-Wasm) engine harness for QuickJS fork

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-003, T-002

**Goal:**
Enable fast iteration on QuickJS changes by compiling and running the fork natively in a small harness used for unit tests and debugging.

**Detailed tasks:**

- [ ] Add a small C harness program (in-repo, but building against `vendor/quickjs`) that can:

  - [ ] create runtime/context,
  - [ ] run a provided JS source string,
  - [ ] return exit code + captured output/exception in a stable format.

- [ ] Add an Nx target (likely in `libs/quickjs-wasm-build` or `tools/`) to build the native harness.
- [ ] Add a smoke test that runs the harness with a trivial script.

**Implementation hints (for Codex):**

- Put harness sources in a dedicated folder (e.g., `tools/quickjs-native-harness/`).
- Avoid depending on QuickJS `qjs` shell; create your own harness so you control init and builtins.

**Acceptance criteria:**

- [ ] `pnpm nx run <harness-project>:build` produces a runnable binary.
- [ ] `pnpm nx run <harness-project>:test` runs at least one script and verifies output deterministically.

---

### T-011: Implement deterministic “expression profile” initialization hook

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-010, T-005

**Goal:**
Centralize VM initialization so every environment (native/Wasm) installs the same deterministic capability profile before user code runs.

**Baseline references:** Baseline #1 §1B, §3; Baseline #2 §6.1, §6.3

**Detailed tasks:**

- [ ] Add an engine init function in the QuickJS fork that:

  - [ ] creates runtime/context,
  - [ ] installs required standard builtins (minimal set),
  - [ ] removes/overrides forbidden builtins deterministically,
  - [ ] freezes namespace objects required by your ABI (`Host` placeholder for now).

- [ ] Ensure initialization is callable from the native harness (and later from Wasm init).
- [ ] Update `docs/determinism-profile.md` with the concrete list of global APIs enabled/disabled.

**Implementation hints (for Codex):**

- Keep initialization logic in the fork (inside `vendor/quickjs`), not in host TS.
- Use `null`-prototype objects where feasible for injected namespaces.

**Acceptance criteria:**

- [ ] A test script can assert missing APIs (e.g., `typeof Date === "undefined"` or a deterministic stub behavior).
- [ ] Initialization produces the same global keys order and same descriptors in repeated runs.

---

### T-012: Disable/virtualize time, randomness, and locale channels

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-011

**Goal:**
Eliminate the main nondeterminism channels by removing or stubbing time and randomness APIs.

**Baseline references:** Baseline #1 §1B, §1C; Baseline #2 §0.3

**Detailed tasks:**

- [ ] Remove/disable/stub: `Date`, any performance timing API you might expose, and any timers (if present).
- [ ] Remove/disable/stub `Math.random` (or replace with deterministic seeded RNG if you later decide to allow it).
- [ ] Ensure no locale-dependent formatting APIs are exposed (QuickJS default lacks Intl; ensure you don’t add any).
- [ ] Add tests verifying that these APIs are absent or deterministic stubs with fixed error codes/messages.

**Implementation hints (for Codex):**

- Prefer making forbidden globals non-writable/non-configurable so user code can’t reintroduce capabilities.
- Document exact behavior for each forbidden API: “missing” vs “throws deterministic error”.

**Acceptance criteria:**

- [ ] A test suite confirms no time/random/locale leaks via globals.
- [ ] Behavior matches across at least two runs and two different machines (local verification).

---

### T-013: Disable async, Promises, and reentrancy primitives

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-011

**Goal:**
Enforce “no async” to keep scheduling deterministic and eliminate hidden concurrency.

**Baseline references:** Baseline #1 §1B (“Ban async”), Baseline #2 §4.4 (“No reentrancy”)

**Detailed tasks:**

- [ ] Remove/disable `Promise`, async functions, microtask/job queue execution, and `queueMicrotask` if present.
- [ ] Ensure host calls are synchronous and cannot callback into JS during a host call (guard will be added later; here ensure core VM doesn’t do jobs).
- [ ] Add tests verifying `Promise` is absent and that async syntax is rejected or deterministic-stubbed (depending on chosen policy).

**Implementation hints (for Codex):**

- Decide policy for async syntax:

  - easiest: allow parsing but `Promise` missing causes runtime failures, or
  - stricter: reject async constructs at compile time (requires parser changes).

- Start with the easiest policy and document it; stricter enforcement can be a later hardening ticket.

**Acceptance criteria:**

- [ ] `typeof Promise === "undefined"` (or deterministic stub) under the profile.
- [ ] No jobs are executed “after” script completion unless explicitly invoked by the host (which should be disallowed).

---

### T-014: Disable dynamic code execution and high-risk features (eval/Function/RegExp/Proxy)

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-011

**Goal:**
Remove features explicitly excluded in Baseline #1 §3 until they are explicitly metered/virtualized.

**Baseline references:** Baseline #1 §3 (“Exclude until explicitly meter/virtualize”)

**Detailed tasks:**

- [ ] Disable/stub `eval` and `Function` constructor after initial program load.
- [ ] Disable/stub `RegExp`.
- [ ] Disable/stub `Proxy`.
- [ ] Add tests verifying these features cannot be used by user code and fail deterministically.

**Implementation hints (for Codex):**

- You still need _some_ form of “initial program evaluation”; that’s host-driven and can be allowed even if runtime `eval` is stubbed.
- Ensure the stubbing can’t be reversed by user code (non-writable/non-configurable).

**Acceptance criteria:**

- [ ] `eval("1+1")` fails deterministically.
- [ ] `new Function("return 1")` fails deterministically.
- [ ] `new RegExp("a")` fails deterministically.
- [ ] `new Proxy({}, {})` fails deterministically.

---

### T-015: Disable typed arrays / ArrayBuffer / DataView / WebAssembly exposure

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-011

**Goal:**
Prevent float/NaN payload observability and other low-level channels by removing binary data features.

**Baseline references:** Baseline #1 §1B (“Close NaN/float observability”) and §3 (“Exclude typed arrays / ArrayBuffer / DataView / WebAssembly”)

**Detailed tasks:**

- [ ] Disable/stub: `ArrayBuffer`, `DataView`, typed array constructors, and `WebAssembly`.
- [ ] Add tests confirming these are absent and not reachable through other globals.

**Implementation hints (for Codex):**

- If QuickJS builds these conditionally, prefer compile-time disable; otherwise, remove from global object deterministically during init.

**Acceptance criteria:**

- [ ] `typeof ArrayBuffer === "undefined"` (or deterministic stub) under profile.
- [ ] `typeof WebAssembly === "undefined"` (or deterministic stub) under profile.

---

### T-016: Capability profile conformance tests (native harness)

**Phase:** P1 – QuickJS harness and deterministic capability profile
**Status:** TODO
**Depends on:** T-012, T-013, T-014, T-015

**Goal:**
Lock down the deterministic profile with regression tests so future QuickJS changes don’t reintroduce nondeterminism.

**Baseline references:** Baseline #1 §1B–§1C, §3

**Detailed tasks:**

- [ ] Add a test suite (native harness) that runs a set of scripts asserting:

  - [ ] forbidden globals are missing/stubbed,
  - [ ] descriptors are non-writable/non-configurable where required,
  - [ ] `Object.getOwnPropertyNames(globalThis)` is stable for injected names.

- [ ] Add a snapshot or golden file for global property descriptors (stable format).

**Implementation hints (for Codex):**

- Keep tests deterministic; avoid any environment-dependent assertions.

**Acceptance criteria:**

- [ ] `pnpm nx test <native-harness-project>` passes with stable snapshot output.

---

# Phase P2 — Canonical gas metering inside the QuickJS fork

### T-020: Add canonical gas state to runtime/context

**Phase:** P2 – Canonical gas metering inside the QuickJS fork
**Status:** TODO
**Depends on:** T-010

**Goal:**
Introduce a canonical gas counter into QuickJS runtime/context that can be decremented deterministically.

**Baseline references:** Baseline #1 §2B (fork approach)

**Detailed tasks:**

- [ ] Add fields to runtime/context for: gas remaining, gas limit, and “gas schedule/version id”.
- [ ] Add helper functions/macros to: charge gas, check OOG, and produce a deterministic OOG exception.
- [ ] Define deterministic OOG error tag/code for the VM layer (distinct from HostError).

**Implementation hints (for Codex):**

- Treat the gas schedule as versioned; document where the version string/hash is defined (e.g., compile-time constant).
- Keep OOG behavior consistent across native and Wasm builds.

**Acceptance criteria:**

- [ ] A test can set gas to a small number and reliably trigger OOG at the same point repeatedly.
- [ ] The thrown error has a stable tag/code and does not include host-dependent text.

---

### T-021: Implement opcode/bytecode metering in the interpreter loop

**Phase:** P2 – Canonical gas metering inside the QuickJS fork
**Status:** TODO
**Depends on:** T-020

**Goal:**
Make gas canonical by charging per executed QuickJS opcode, per a versioned cost table.

**Baseline references:** Baseline #1 §2B.1 (“Bytecode/opcode metering”)

**Detailed tasks:**

- [ ] Identify the core bytecode execution loop in QuickJS and insert gas charging at opcode dispatch.
- [ ] Define a versioned opcode cost table (constant mapping opcode -> cost).
- [ ] Ensure costs are deterministic and independent of allocator/GC performance.
- [ ] Add a test that measures exact gas consumption for a small fixed program.

**Implementation hints (for Codex):**

- Charge gas _before_ executing the opcode to ensure OOG point is well-defined.
- Make the cost table easy to diff/review (single file with explicit mapping).

**Acceptance criteria:**

- [ ] For a fixed script, gas used is identical across multiple runs.
- [ ] Changing the cost table changes gas deterministically (test asserts the exact number).

---

### T-022: Define deterministic OOG point semantics

**Phase:** P2 – Canonical gas metering inside the QuickJS fork
**Status:** TODO
**Depends on:** T-021

**Goal:**
Lock down where and how execution halts when gas runs out so it’s identical across Node and browser.

**Baseline references:** Baseline #1 §2 (“same (P,I,G) ⇒ same OOG point”)

**Detailed tasks:**

- [ ] Specify and implement whether OOG triggers:

  - [ ] before opcode execution,
  - [ ] at builtin loop iteration boundaries,
  - [ ] at host-call boundaries (later).

- [ ] Ensure OOG error is deterministic (no stack trace variability, no platform info).
- [ ] Add tests that demonstrate the same instruction boundary triggers OOG for a given gas budget.

**Implementation hints (for Codex):**

- Provide a “gas probe” test program that runs a known number of steps and can be tuned to hit OOG on a particular statement.

**Acceptance criteria:**

- [ ] A test asserts exact output and exact point of failure (e.g., last successful side-effect in JS-visible state) before OOG.

---

### T-023: Meter C-builtins that loop in C (Array.map/filter/reduce first)

**Phase:** P2 – Canonical gas metering inside the QuickJS fork
**Status:** TODO
**Depends on:** T-021

**Goal:**
Prevent “cheap bytecode / expensive C loop” DoS by charging per-iteration inside C builtins.

**Baseline references:** Baseline #1 §2B.2 (“Meter C-builtins that loop in C”)

**Detailed tasks:**

- [ ] Add deterministic charges inside `Array.prototype.map`, `filter`, `reduce` implementations:

  - [ ] base cost per call,
  - [ ] per-element cost,
  - [ ] OOG checks within the loop.

- [ ] Confirm callback execution still charges opcode gas as usual.
- [ ] Add tests for large arrays to ensure gas scales linearly and OOG occurs mid-iteration deterministically.

**Implementation hints (for Codex):**

- Ensure “holes” in arrays and property lookups follow deterministic rules; charge by iteration semantics you choose (document it).

**Acceptance criteria:**

- [ ] With a fixed gas budget, `map` over N elements consistently OOGs at the same element index across repeated runs.
- [ ] Gas for `map` grows predictably with array length (test asserts formula).

---

### T-024: Audit and either meter or remove other heavy builtins

**Phase:** P2 – Canonical gas metering inside the QuickJS fork
**Status:** TODO
**Depends on:** T-021, T-016

**Goal:**
Ensure no builtin can do unmetered large work. Either add metering or exclude it from the deterministic profile.

**Baseline references:** Baseline #1 §2B.2 (general), §3 (exclude until metered)

**Detailed tasks:**

- [ ] Inventory QuickJS builtins that can do large work in C:

  - [ ] `Array.prototype.sort`, `String.prototype.repeat`, `JSON.parse/stringify`, etc.

- [ ] For each: choose one action:

  - [ ] add deterministic metering (base + per-unit), or
  - [ ] disable/stub in profile until later.

- [ ] Update `docs/determinism-profile.md` and `docs/gas-schedule.md`.
- [ ] Add regression tests for chosen behavior.

**Implementation hints (for Codex):**

- Start conservative: if unsure, disable until you’re ready to meter.
- Document “units” clearly (bytes processed, elements processed, etc.).

**Acceptance criteria:**

- [ ] No identified builtin can process unbounded input without either metering or being disabled.
- [ ] Tests cover at least 3 heavy builtin cases.

---

### T-025: Allocation gas metering via custom allocator hooks

**Phase:** P2 – Canonical gas metering inside the QuickJS fork
**Status:** TODO
**Depends on:** T-020

**Goal:**
Charge gas deterministically for allocations by requested bytes, independent of allocator behavior.

**Baseline references:** Baseline #1 §2B.3 (“Allocation and GC gas”)

**Detailed tasks:**

- [ ] Wrap QuickJS malloc/realloc/free hooks with a metering layer.
- [ ] Define a deterministic cost function: `alloc_gas = bytes * k_alloc + base`.
- [ ] Ensure the requested size is the charged quantity (not actual allocated).
- [ ] Add tests that allocate predictable sizes and assert gas cost.

**Implementation hints (for Codex):**

- Be careful with realloc semantics: charge based on delta or full requested size (choose and document).
- Ensure failed allocations produce deterministic errors (memory vs gas vs limit).

**Acceptance criteria:**

- [ ] A test that performs N allocations of known sizes yields exact expected gas usage.
- [ ] OOG during allocation triggers deterministic OOG, not host/OS allocation errors.

---

### T-026: Deterministic GC scheduling and charging

**Phase:** P2 – Canonical gas metering inside the QuickJS fork
**Status:** TODO
**Depends on:** T-025

**Goal:**
Prevent GC timing variability by running GC only at deterministic checkpoints and charging per schedule-defined rule.

**Baseline references:** Baseline #1 §2B.3 (“run GC only at deterministic checkpoints”)

**Detailed tasks:**

- [ ] Disable or neutralize auto-GC triggers that vary based on runtime heuristics.
- [ ] Add explicit GC checkpoints controlled by the embedding API (e.g., before/after eval, after host calls, end of run).
- [ ] Define deterministic GC gas charging rule (e.g., based on bytes allocated since last GC, or fixed charge per checkpoint).
- [ ] Add tests proving GC happens only at checkpoints and gas charges are deterministic.

**Implementation hints (for Codex):**

- Keep the charging rule simple and stable; document it in `docs/gas-schedule.md`.
- Ensure checkpoint placement is consistent in native and wasm execution paths.

**Acceptance criteria:**

- [ ] GC runs at deterministic, test-observable checkpoints only.
- [ ] GC gas charge is identical across runs for the same allocation pattern.

---

### T-027: Add an optional “gas trace” facility for testing and auditing

**Phase:** P2 – Canonical gas metering inside the QuickJS fork
**Status:** TODO
**Depends on:** T-021

**Goal:**
Expose a deterministic internal trace of gas charges (opcode counts, builtin charges) to support golden tests.

**Baseline references:** Baseline #1 §2, Baseline #2 §5 (tape concept aligns)

**Detailed tasks:**

- [ ] Add a compile-time flag or runtime option to collect a gas trace.
- [ ] Trace should include: opcode id counts, builtin charge events, allocation charges (aggregated).
- [ ] Provide a stable export path for the harness to read the trace after execution.

**Implementation hints (for Codex):**

- Keep trace data bounded; aggregate counts rather than logging every opcode by default.

**Acceptance criteria:**

- [ ] A test can run a script and snapshot the trace in a stable format.
- [ ] Trace is identical across repeated runs.

---

### T-028: Native gas conformance tests (goldens)

**Phase:** P2 – Canonical gas metering inside the QuickJS fork
**Status:** TODO
**Depends on:** T-022, T-023, T-025, T-026, T-027

**Goal:**
Lock in canonical gas behavior for representative programs before introducing Wasm and host ABI complexity.

**Baseline references:** Baseline #1 §2 (deterministic gas), §3 (feature set)

**Detailed tasks:**

- [ ] Create a set of sample programs and expected gas usage (golden values).
- [ ] Include cases for:

  - [ ] pure arithmetic/loops,
  - [ ] array map/filter/reduce,
  - [ ] allocations,
  - [ ] OOG boundary.

- [ ] Add a test runner that loads program strings and asserts exact gas used and/or exact OOG point.

**Implementation hints (for Codex):**

- Keep programs small and deterministic; avoid any excluded APIs.

**Acceptance criteria:**

- [ ] `pnpm nx test <native-harness-project>` runs gas goldens and passes.
- [ ] Goldens include at least one OOG test with a deterministic boundary.

---

# Phase P3 — Deterministic Host-Call ABI in the VM (syscall + DV + manifest)

### T-030: Decide and document the canonical DV wire encoding

**Phase:** P3 – Deterministic Host-Call ABI in the VM
**Status:** TODO
**Depends on:** T-005

**Goal:**
Select one canonical encoding for DV (and potentially manifest bytes) and document it so both C (VM) and TS (host) can implement identically.

**Baseline references:** Baseline #2 §2.7 (“Choose one canonical encoding”)

**Detailed tasks:**

- [ ] Evaluate encoding options for DV:

  - [ ] canonical CBOR,
  - [ ] JCS (RFC 8785),
  - [ ] custom minimal binary encoding for `{null,bool,string,finite double,array,map<string,DV>}`.

- [ ] Choose one and write the normative spec in `docs/dv-wire-format.md`:

  - [ ] type tags, length encoding, string encoding (UTF-8),
  - [ ] object key ordering rule,
  - [ ] numeric restrictions enforcement and canonicalization (`-0 => +0`, forbid NaN/Inf),
  - [ ] maximum sizes / depth limits.

- [ ] Write an ADR-style decision note (short) explaining the choice and tradeoffs.

**Implementation hints (for Codex):**

- Strong bias: choose an encoding you can implement in small, dependency-light C and TS code and keep stable forever.
- Remember Baseline #2 §2.4: “Insertion order in JS must match canonical order” implies decode order matters.

**Acceptance criteria:**

- [ ] `docs/dv-wire-format.md` contains a fully specified encoding for all DV types + limits.
- [ ] The spec includes at least 5 explicit examples with expected byte-level or structured outputs (no actual code needed).

---

### T-031: Define ABI manifest schema and canonical serialization format

**Phase:** P3 – Deterministic Host-Call ABI in the VM
**Status:** TODO
**Depends on:** T-030

**Goal:**
Define the manifest structure (normative fields) and how its bytes are canonicalized for hashing and VM validation.

**Baseline references:** Baseline #2 §1.3–1.4

**Detailed tasks:**

- [ ] Define a concrete manifest schema with at least:

  - [ ] `abi_id`, `abi_version`,
  - [ ] entries array with `fn_id`, `js_path`, `arity`, `arg_schema`, `return_schema`, `effect`, `gas_schedule_id`, `limits`, `error_codes`.

- [ ] Decide how manifest bytes are produced:

  - [ ] DV-wire encoded structure, or
  - [ ] some canonical JSON if chosen in T-030.

- [ ] Document the schema in `docs/abi-manifest.md` including canonical ordering rules.

**Implementation hints (for Codex):**

- Prefer the manifest be encoded using the _same canonical encoding as DV_, to avoid multiple canonicalization stacks.
- Ensure `fn_id` stability rules are explicit: “Semantics of a given fn_id must never change”.

**Acceptance criteria:**

- [ ] `docs/abi-manifest.md` defines the manifest schema, canonicalization, and hashing inputs precisely.
- [ ] The doc includes at least one full example manifest (structural, not huge).

---

### T-032: Implement DV encode/decode in TypeScript (`libs/dv`)

**Phase:** P3 – Deterministic Host-Call ABI in the VM
**Status:** TODO
**Depends on:** T-030, T-002

**Goal:**
Provide the host-side reference implementation for DV validation and canonical encode/decode.

**Baseline references:** Baseline #2 §2.1–2.7

**Detailed tasks:**

- [ ] Define DV TypeScript types and runtime validators.
- [ ] Implement canonical encoding and decoding per `docs/dv-wire-format.md`.
- [ ] Enforce numeric rules: finite, no NaN/Inf, no -0, safe-integer requirements where specified by schemas.
- [ ] Enforce UTF-8 validity and string limits.
- [ ] Enforce object key uniqueness + canonical key ordering.
- [ ] Add property-based tests for encode/decode roundtrip and canonicalization.

**Implementation hints (for Codex):**

- Keep encoding deterministic with no reliance on JS engine object enumeration order; always sort keys explicitly.

**Acceptance criteria:**

- [ ] `pnpm nx test dv` passes and includes roundtrip tests.
- [ ] Known “non-canonical” inputs are rejected or canonicalized as specified.

---

### T-033: Implement ABI manifest tooling in TypeScript (`libs/abi-manifest`)

**Phase:** P3 – Deterministic Host-Call ABI in the VM
**Status:** TODO
**Depends on:** T-031, T-032

**Goal:**
Create TS types + canonical serialization + hashing for ABI manifests, producing `abi_manifest_hash` for `P`.

**Baseline references:** Baseline #2 §1.3–1.4

**Detailed tasks:**

- [ ] Define manifest TS types matching `docs/abi-manifest.md`.
- [ ] Implement canonical serialization (using DV encoding from `libs/dv`).
- [ ] Implement hashing function used for `abi_manifest_hash` (algorithm must match VM-side later).
- [ ] Provide a small CLI or build step to generate:

  - [ ] manifest bytes,
  - [ ] manifest hash,
  - [ ] a human-readable summary (for debugging).

- [ ] Add tests verifying stable bytes/hash for a sample manifest fixture.

**Implementation hints (for Codex):**

- Pin hash algorithm and output format (hex/base64) and document it.

**Acceptance criteria:**

- [ ] Given a fixed manifest fixture, the produced hash is stable and test-asserted.
- [ ] The output bytes are canonical and unchanged across runs.

---

### T-034: Define the low-level Wasm host-call boundary ABI (ptr/len semantics)

**Phase:** P3 – Deterministic Host-Call ABI in the VM
**Status:** TODO
**Depends on:** T-031

**Goal:**
Specify the concrete Wasm import/export ABI that implements the conceptual `host_call(fn_id, request_bytes) -> response_bytes`.

**Baseline references:** Baseline #2 §1.1 (“Single syscall-style primitive”), §4.4 (“No reentrancy”)

**Detailed tasks:**

- [ ] Define the exact imported function signature(s) the Wasm will use (e.g., `fn_id: u32`, pointers, lengths).
- [ ] Define memory ownership rules for request/response buffers:

  - [ ] how VM allocates request bytes,
  - [ ] how host returns response bytes (copy-in, shared scratch buffer, or host-to-wasm write).

- [ ] Define size limits and deterministic error handling at this boundary.
- [ ] Document this in `docs/abi-manifest.md` or a new `docs/host-call-abi.md`.

**Implementation hints (for Codex):**

- Keep it simple and portable across Node and browser.
- Make sure the ABI supports returning both DV payload and meta (units used, error code) deterministically.

**Acceptance criteria:**

- [ ] A document exists with an unambiguous ABI contract (types, memory, limits, error behavior).
- [ ] The contract explicitly forbids reentrancy and async behavior.

---

### T-035: Implement VM-side hash function and manifest hash validation (QuickJS fork)

**Phase:** P3 – Deterministic Host-Call ABI in the VM
**Status:** TODO
**Depends on:** T-033, T-010

**Goal:**
Implement manifest hash checking in the VM: compute `hash(manifest_bytes)` and compare to `abi_manifest_hash` pinned in `P`.

**Baseline references:** Baseline #2 §1.3 (“manifest hash exact-match”)

**Detailed tasks:**

- [ ] Add a VM init API that receives:

  - [ ] manifest bytes,
  - [ ] expected manifest hash from `P`,
  - [ ] context blob `I` (later),
  - [ ] gas limit `G`.

- [ ] Compute hash of provided manifest bytes using the pinned algorithm.
- [ ] On mismatch, halt deterministically with a fixed error code/tag.

**Implementation hints (for Codex):**

- Keep “invalid manifest” errors distinct from HostError and OOG.

**Acceptance criteria:**

- [ ] A harness test passes correct manifest bytes/hash and initializes successfully.
- [ ] With a wrong hash, VM fails deterministically with the same error code every time.

---

### T-036: Implement VM-side DV encoding/decoding for host calls (QuickJS fork)

**Phase:** P3 – Deterministic Host-Call ABI in the VM
**Status:** TODO
**Depends on:** T-030, T-010

**Goal:**
Provide C implementations for encoding JS values into DV wire bytes and decoding DV bytes back to JS values deterministically.

**Baseline references:** Baseline #2 §2.1–2.7, §6.2

**Detailed tasks:**

- [ ] Implement JS->DV conversion enforcing DV restrictions: types, numeric restrictions, key ordering.
- [ ] Implement DV->JS conversion ensuring insertion order matches canonical order.
- [ ] Enforce maximum sizes / depth limits deterministically.
- [ ] Add native harness tests that:

  - [ ] encode arguments,
  - [ ] decode responses,
  - [ ] roundtrip selected DV values with stable results.

**Implementation hints (for Codex):**

- Use null-prototype objects where applicable; define properties in canonical order.

**Acceptance criteria:**

- [ ] VM DV encode/decode passes a parity test vs TS `libs/dv` for a shared fixture set (byte-level match).
- [ ] Invalid DV inputs are rejected with deterministic error tags.

---

### T-037: Implement syscall dispatcher glue in the VM (QuickJS fork)

**Phase:** P3 – Deterministic Host-Call ABI in the VM
**Status:** TODO
**Depends on:** T-034, T-020, T-036

**Goal:**
Add a single VM->Host syscall path (`host_call`) and integrate it with gas charging and deterministic error behavior.

**Baseline references:** Baseline #2 §1.1, §3.1–3.4, §4.4

**Detailed tasks:**

- [ ] Add an abstraction in the fork for performing a host call given:

  - [ ] `fn_id`,
  - [ ] request bytes,
  - [ ] effect class.

- [ ] Add a reentrancy guard so host calls cannot be nested.
- [ ] Define a response envelope format that can represent `Ok(DV)` or `Err({code,tag,details?})` plus `units` metadata.
- [ ] Add deterministic error throwing for HostError.

**Implementation hints (for Codex):**

- Keep response envelope parsing strict and deterministic; reject malformed responses with a fixed VM error.

**Acceptance criteria:**

- [ ] Native harness can install a stub host dispatcher and perform a trivial host call end-to-end.
- [ ] Reentrant calls are rejected deterministically.

---

### T-038: Implement Host.v1 namespace installation from manifest (QuickJS fork)

**Phase:** P3 – Deterministic Host-Call ABI in the VM
**Status:** TODO
**Depends on:** T-035, T-037, T-031

**Goal:**
Expose host functions to JS as a frozen `Host.v1.*` namespace generated from the manifest mapping `js_path -> fn_id`.

**Baseline references:** Baseline #2 §1.5, §6.2–6.3

**Detailed tasks:**

- [ ] Parse manifest entries and generate JS wrapper functions that:

  - [ ] validate args per `arg_schema`,
  - [ ] encode args to canonical DV bytes,
  - [ ] charge gas: base + arg_bytes before syscall,
  - [ ] call syscall dispatcher by `fn_id`,
  - [ ] validate/parse response DV,
  - [ ] charge gas: out_bytes + units after syscall,
  - [ ] return DV or throw HostError.

- [ ] Create namespace objects with null prototype and set: non-extensible, non-writable, non-configurable.
- [ ] Ensure `Host`, `Host.v1`, and nested objects are frozen.

**Implementation hints (for Codex):**

- Manifest should be the only source of truth; avoid hardcoded extra globals beyond permitted convenience aliases.

**Acceptance criteria:**

- [ ] A test manifest with 2 functions produces `globalThis.Host.v1...` functions callable from JS.
- [ ] Attempting to modify `Host` or nested namespaces fails (in strict mode) or is no-op deterministically.

---

### T-039: Inject Blue-style convenience globals (document/event/steps/canon) via deterministic init

**Phase:** P3 – Deterministic Host-Call ABI in the VM
**Status:** TODO
**Depends on:** T-038

**Goal:**
Provide the ergonomic surface API used by Blue: `event`, `eventCanonical`, `document(path)`, `document.canonical(path)`, `steps`, and `canon` helpers.

**Baseline references:** Baseline #2 §1.5, §6.4–6.5, §9

**Detailed tasks:**

- [ ] Implement `document(path)` and `document.canonical(path)` as wrappers over `Host.v1.document.get/getCanonical`.
- [ ] Inject `event`, `eventCanonical`, and `steps` as DV values from `I` (plumbed later).
- [ ] Add `canon.unwrap` and `canon.at` as pure JS helpers (initially), consistent with baseline.
- [ ] Freeze/lock these globals as appropriate so user code can’t override them.

**Implementation hints (for Codex):**

- Ensure `document` is a function object with an attached `.canonical` property/method, mirroring the Blue docs.

**Acceptance criteria:**

- [ ] A test script can read `event`, `steps`, and call `document("x")` and receive a deterministic DV result.
- [ ] Globals are present and stable across runs; modifications are prevented.

---

### T-040: Implement host-call two-phase gas charging semantics in VM

**Phase:** P3 – Deterministic Host-Call ABI in the VM
**Status:** TODO
**Depends on:** T-037, T-021, T-038

**Goal:**
Enforce Baseline #2’s two-phase charging and “no cheap-call/expensive-host DoS” constraints.

**Baseline references:** Baseline #2 §3.2–3.4

**Detailed tasks:**

- [ ] Before syscall: charge base + `arg_bytes*k_arg` deterministically.
- [ ] After syscall: validate response, compute `out_bytes`, read returned `units`, and charge `out_bytes*k_out + units*k_units`.
- [ ] Ensure OOG during post-charge aborts deterministically with no visible effects.
- [ ] Define deterministic host limits: max request size, max response size, max units.
- [ ] Add tests:

  - [ ] OOG before syscall prevents host invocation,
  - [ ] OOG after syscall aborts and host overlay is rolled back (host-side tests later).

**Implementation hints (for Codex):**

- VM must treat malformed or oversized responses as deterministic errors.
- VM should not rely on wall time or host work; only metered quantities.

**Acceptance criteria:**

- [ ] Host calls consistently charge gas proportional to request/response sizes and units.
- [ ] OOG behavior matches the spec and is test-verified.

---

### T-041: Add optional VM-side “tape” hooks for auditing host calls

**Phase:** P3 – Deterministic Host-Call ABI in the VM
**Status:** TODO
**Depends on:** T-037, T-040

**Goal:**
Provide optional deterministic logging/auditing of host calls for debugging and determinism verification.

**Baseline references:** Baseline #2 §5 (“tape”)

**Detailed tasks:**

- [ ] Define what tape records (at minimum): `fn_id`, hash(req_bytes), hash(resp_bytes), gas charged (split).
- [ ] Ensure tape is bounded and rollback-able in the host sense (recorded data returned as output, not printed).
- [ ] Provide an export path for tape retrieval after run.

**Implementation hints (for Codex):**

- Tape can be behind a feature flag to avoid overhead in production builds.

**Acceptance criteria:**

- [ ] A run can enable tape and retrieve it deterministically as a DV value.
- [ ] Tape content is identical across repeated runs.

---

# Phase P4 — Emscripten build pipeline and deterministic Wasm artifacts

### T-050: Implement `libs/quickjs-wasm-build` build pipeline scaffolding

**Phase:** P4 – Emscripten build pipeline and deterministic Wasm artifacts
**Status:** TODO
**Depends on:** T-003, T-004, T-002

**Goal:**
Create a dedicated build package that compiles the QuickJS fork to Wasm via Emscripten.

**Baseline references:** Baseline #1 §1A (same engine everywhere)

**Detailed tasks:**

- [ ] Create an Nx build target for `quickjs-wasm-build` that invokes emcc on QuickJS sources + your fork additions.
- [ ] Produce outputs into a deterministic directory, e.g. `dist/libs/quickjs-wasm-build/<variant>/`.
- [ ] Generate a small metadata file alongside outputs (engine build hash placeholder, feature flags).

**Implementation hints (for Codex):**

- Use Nx caching by ensuring inputs/outputs are declared correctly in `project.json`.
- Keep “variant” concept (release/debug) but start with one.

**Acceptance criteria:**

- [ ] `pnpm nx build quickjs-wasm-build` produces a `.wasm` and JS loader artifact.
- [ ] Output paths are stable and compatible with later packaging.

---

### T-051: Enforce deterministic Wasm memory sizing and disable nondeterministic Emscripten features

**Phase:** P4 – Emscripten build pipeline and deterministic Wasm artifacts
**Status:** TODO
**Depends on:** T-050

**Goal:**
Make the Wasm build deterministic across environments by freezing memory growth and removing Emscripten runtime features that could introduce variability.

**Baseline references:** Baseline #1 §2C (“Freeze memory growth behavior”)

**Detailed tasks:**

- [ ] Set fixed memory sizing (min == max or explicitly controlled) in Emscripten flags.
- [ ] Ensure no filesystem, no environment-based feature detection, and no host-dependent syscalls are compiled in.
- [ ] Ensure build outputs are stable (no timestamps embedded; stable module name if relevant).
- [ ] Document the chosen Emscripten flags rationale in `docs/toolchain.md`.

**Implementation hints (for Codex):**

- Prefer a single `.wasm` binary used in both Node and browser; avoid conditional compilation by environment.
- If Emscripten emits different glue for node/web, ensure the `.wasm` bytes remain identical.

**Acceptance criteria:**

- [ ] Wasm build has fixed memory sizing as verified by inspection tooling or emitted metadata.
- [ ] The produced `.wasm` byte hash is stable across two builds on the same machine (deterministic build inputs).

---

### T-052: Package Wasm artifacts into `libs/quickjs-wasm` for consumption

**Phase:** P4 – Emscripten build pipeline and deterministic Wasm artifacts
**Status:** TODO
**Depends on:** T-050, T-002

**Goal:**
Create a package that publishes the Wasm bytes + loader and exposes a stable import API for Node and browsers.

**Baseline references:** Baseline #1 §1A

**Detailed tasks:**

- [ ] Define `libs/quickjs-wasm` public API:

  - [ ] `getWasmBytes()` or `wasmUrl`/`wasmBytes` accessors,
  - [ ] metadata export (engine build hash, abi support).

- [ ] Wire `quickjs-wasm` build to depend on `quickjs-wasm-build` output.
- [ ] Ensure `.wasm` is included in package artifacts and works with bundlers.

**Implementation hints (for Codex):**

- Node: load `.wasm` via fs/URL; Browser: `fetch` via `new URL(..., import.meta.url)`.
- Keep a single `.wasm` file for both environments.

**Acceptance criteria:**

- [ ] `pnpm nx build quickjs-wasm` produces a package output containing `.wasm` and loader code.
- [ ] A small Node script can import the package and obtain Wasm bytes.

---

### T-053: Build “release” and “debug” Wasm variants (same semantics)

**Phase:** P4 – Emscripten build pipeline and deterministic Wasm artifacts
**Status:** TODO
**Depends on:** T-051, T-050

**Goal:**
Provide at least two variants: a production build and a debug build with additional assertions/tracing without changing semantics.

**Baseline references:** Baseline #1 §1A (engine bytes pinned as part of P)

**Detailed tasks:**

- [ ] Add `release` variant build config.
- [ ] Add `debug` variant build config (extra asserts, optional tape enabled).
- [ ] Ensure variants are separately addressable in `quickjs-wasm` exports and pinned by program artifact `P`.

**Implementation hints (for Codex):**

- Be explicit about what differs in debug (logging hooks only); do not alter opcode costs or behavior.

**Acceptance criteria:**

- [ ] Both variants build successfully.
- [ ] A smoke test can instantiate either variant and run a basic script.

---

### T-054: Optional Wasm-level safety fuse (non-canonical meter)

**Phase:** P4 – Emscripten build pipeline and deterministic Wasm artifacts
**Status:** TODO
**Depends on:** T-051

**Goal:**
Add an optional Wasm-instruction “fuse” to prevent runaway execution, while keeping canonical gas inside QuickJS.

**Baseline references:** Baseline #1 §2A (“keep wasm-instrument as a hard safety fuse, but not canonical gas”)

**Detailed tasks:**

- [ ] Choose a safety fuse approach (e.g., wasm-instrument, host-side step counter, or Emscripten runtime hook).
- [ ] Ensure the fuse produces deterministic abort behavior (fixed error code) but is not used as canonical gas.
- [ ] Document fuse semantics and its relationship to canonical gas in `docs/gas-schedule.md`.

**Implementation hints (for Codex):**

- Start with conservative defaults; fuse limit should exceed any reasonable canonical gas budget for typical workloads.

**Acceptance criteria:**

- [ ] A test can trigger the fuse deterministically when canonical gas is set very high (fuse as last-resort).
- [ ] Canonical gas accounting remains unchanged when the fuse is enabled.

---

# Phase P5 — TypeScript runtime SDK and host-side implementation

### T-060: Implement `libs/host` dispatcher interface and error model

**Phase:** P5 – TypeScript runtime SDK and host-side implementation
**Status:** TODO
**Depends on:** T-032, T-033

**Goal:**
Define the host dispatcher contract (single syscall) and deterministic error model used by the runtime.

**Baseline references:** Baseline #2 §1.1, §1.6, §3.4, §4.4

**Detailed tasks:**

- [ ] Define TS interfaces for:

  - [ ] host-call request: `fn_id`, request bytes, effect, context pointers,
  - [ ] host-call response: ok/err DV payload + units + meta.

- [ ] Define deterministic error codes/tags used by host functions (manifest-declared).
- [ ] Implement a reentrancy guard at host dispatcher level (host_call cannot be nested).
- [ ] Add tests that validate deterministic error shapes and size limits.

**Implementation hints (for Codex):**

- Host should never throw raw JS errors across the boundary; always return the structured `Err({code, tag, details?})`.

**Acceptance criteria:**

- [ ] `pnpm nx test host` passes and includes structured error conformance tests.
- [ ] Reentrancy is detected and returned as a deterministic error.

---

### T-061: Implement transactional overlay library (`libs/host` or `libs/overlay`)

**Phase:** P5 – TypeScript runtime SDK and host-side implementation
**Status:** TODO
**Depends on:** T-060

**Goal:**
Provide the rollback-able overlay that holds document mutations and emitted events until commit.

**Baseline references:** Baseline #1 §4 (“Deterministic rollback”), Baseline #2 §4.2–4.3

**Detailed tasks:**

- [ ] Define overlay data model: snapshot reference + staged patches + staged emits.
- [ ] Implement atomic `applyPatch` operations with deterministic ordering.
- [ ] Implement `commit()` and `rollback()` semantics.
- [ ] Add deterministic serialization/hashing for overlay state (for tests/tape).

**Implementation hints (for Codex):**

- Keep overlay operations pure and deterministic; avoid relying on insertion order except where you control it.

**Acceptance criteria:**

- [ ] Overlay can apply patches and then rollback to original snapshot deterministically.
- [ ] Overlay commit produces a deterministic final state (test fixture compares).

---

### T-062: Implement deterministic document helpers and path resolution

**Phase:** P5 – TypeScript runtime SDK and host-side implementation
**Status:** TODO
**Depends on:** T-061

**Goal:**
Implement the document host functions behind `Host.v1.document.get/getCanonical` and define deterministic path semantics + units computation.

**Baseline references:** Baseline #2 §3.2 (units), §6.4 (document helpers), §9 (path resolution semantics tied to ABI version)

**Detailed tasks:**

- [ ] Define deterministic path grammar and resolution rules (absolute/relative, root).
- [ ] Implement `document.get(path)` reading from snapshot + overlay-so-far.
- [ ] Implement `document.getCanonical(path)` returning canonical node DV representation (versioned).
- [ ] Compute deterministic `units` for these operations (e.g., segments traversed, nodes visited) and enforce limits.
- [ ] Add tests for path resolution and deterministic `units`.

**Implementation hints (for Codex):**

- Units must upper-bound host work. If path resolution might traverse large structures, ensure limits exist and errors are deterministic (`OOG_HOST_UNITS` or similar).

**Acceptance criteria:**

- [ ] For a fixed document + path, `get` returns the same DV bytes across Node and browser.
- [ ] `units` returned is deterministic and matches tests.
- [ ] Exceeding limits returns deterministic errors.

---

### T-063: Implement host function registry driven by ABI manifest

**Phase:** P5 – TypeScript runtime SDK and host-side implementation
**Status:** TODO
**Depends on:** T-033, T-060, T-062

**Goal:**
Map `fn_id -> implementation` in the host based on the manifest, enforcing effect classes and limits.

**Baseline references:** Baseline #2 §1.2–1.4, §4.1–4.3

**Detailed tasks:**

- [ ] Implement a registry that loads manifest entries and binds `fn_id` to handler functions.
- [ ] Validate at startup: manifest `abi_id/abi_version` supported, all required handlers present.
- [ ] Enforce effect class semantics:

  - [ ] PURE/READ cannot mutate overlay,
  - [ ] WRITE/EMIT mutate overlay only.

- [ ] Enforce per-function limits (arg sizes, units caps, response size).

**Implementation hints (for Codex):**

- Treat manifest as part of `P`: do not allow runtime addition of functions outside the manifest.

**Acceptance criteria:**

- [ ] Host fails deterministically when a manifest references an unknown `fn_id`.
- [ ] Host enforces effect class restrictions (tests assert WRITE is rejected in READ-only contexts if configured).

---

### T-064: Implement `libs/quickjs-runtime` VM instantiation API (Node + browser)

**Phase:** P5 – TypeScript runtime SDK and host-side implementation
**Status:** TODO
**Depends on:** T-052, T-060

**Goal:**
Create the SDK wrapper that instantiates the Wasm VM, wires the `host_call` import, and provides a `runProgram()` API.

**Baseline references:** Baseline #1 §1A, §1C; Baseline #2 §6.1–6.2

**Detailed tasks:**

- [ ] Load Wasm bytes from `libs/quickjs-wasm` in Node and browser.
- [ ] Instantiate Wasm with an import that implements the host-call boundary ABI from T-034.
- [ ] Implement runtime init flow:

  - [ ] pass manifest bytes, expected manifest hash, context blob `I`, gas limit `G`, and feature flags,
  - [ ] validate init failures deterministically.

- [ ] Provide `runProgram({ programArtifactP, inputEnvelopeI, gasG, host })` returning:

  - [ ] return DV value or error,
  - [ ] gas used/remaining,
  - [ ] overlay/effects (committed or staged based on policy),
  - [ ] optional tape.

**Implementation hints (for Codex):**

- Keep host_call synchronous and non-reentrant; use a lock around host dispatch.
- Ensure the runtime loads the **same wasm bytes** in both environments.

**Acceptance criteria:**

- [ ] A Node smoke test can run a trivial program returning a DV value.
- [ ] A browser smoke test (in `apps/smoke-web`) can run the same program and get identical result.

---

### T-065: Implement program artifact `P` format and loader

**Phase:** P5 – TypeScript runtime SDK and host-side implementation
**Status:** TODO
**Depends on:** T-033, T-064

**Goal:**
Define and implement the `P` format that pins `abi_manifest_hash` (and optionally `engine_build_hash`) as required by Baseline #2.

**Baseline references:** Baseline #2 §1.3, Baseline #1 §1A

**Detailed tasks:**

- [ ] Define a TS type for `ProgramArtifactP` including at least:

  - [ ] JS source (or bytecode later),
  - [ ] `abi_id`, `abi_version`, `abi_manifest_hash`,
  - [ ] optional `engine_build_hash` and runtime feature flags.

- [ ] Implement loader/validator for `P` (file or in-memory).
- [ ] Add tests verifying that mismatched manifest hash prevents execution deterministically.

**Implementation hints (for Codex):**

- Keep `P` JSON-serializable so it can be stored and transported easily; avoid embedding non-deterministic metadata.

**Acceptance criteria:**

- [ ] `runProgram()` rejects mismatched manifest hash deterministically.
- [ ] `P` validation rejects missing fields with deterministic error tags.

---

### T-066: Implement `I` (Input envelope) schema and VM injection mapping

**Phase:** P5 – TypeScript runtime SDK and host-side implementation
**Status:** TODO
**Depends on:** T-064, T-032

**Goal:**
Define `I` and ensure per-run injection of `event`, `eventCanonical`, and `steps` into the VM deterministically.

**Baseline references:** Baseline #1 §1C, Baseline #2 §6.1, §6.4

**Detailed tasks:**

- [ ] Define TS types for input envelope `I` (document snapshot epoch, event payload, steps results, etc.).
- [ ] Define deterministic serialization of `I` into the context blob passed to VM.
- [ ] Ensure VM injects `event`, `eventCanonical`, `steps` as DV values derived solely from `I`.
- [ ] Add tests verifying that VM sees exactly the provided `I` values and cannot access other external data.

**Implementation hints (for Codex):**

- Prefer passing `I` as canonical DV bytes to keep a single canonicalization pipeline.

**Acceptance criteria:**

- [ ] Same `(P,I,G)` run in Node and browser yields identical injected values and identical results.
- [ ] Modifying the host environment (timezone, locale) does not affect any injected value.

---

### T-067: Implement stable error mapping across VM/Host boundaries

**Phase:** P5 – TypeScript runtime SDK and host-side implementation
**Status:** TODO
**Depends on:** T-060, T-064

**Goal:**
Expose stable error objects in TS/JS without leaking environment details, while preserving deterministic codes/tags.

**Baseline references:** Baseline #2 §1.6, §0.3

**Detailed tasks:**

- [ ] Define error classes/types: `HostError`, `OutOfGasError`, `InvalidManifestError`, `InvalidDVError`, etc.
- [ ] Map VM-thrown deterministic errors into these structured errors.
- [ ] Ensure no host-dependent stack traces or OS messages are included in the observable error surface (or gate them behind debug mode explicitly excluded from determinism tests).

**Implementation hints (for Codex):**

- Determinism tests should compare codes/tags and structured data, not stack traces.

**Acceptance criteria:**

- [ ] Errors returned from `runProgram()` include stable `code`/`tag` and optional DV `details`.
- [ ] Running in Node vs browser yields the same error identity (code/tag) for the same failure.

---

# Phase P6 — Blue Sequential Workflow integration and examples

### T-070: Implement `libs/blue-integration` context adapter

**Phase:** P6 – Blue Sequential Workflow integration and examples
**Status:** TODO
**Depends on:** T-062, T-064, T-066

**Goal:**
Provide an adapter layer that plugs this runtime into the Blue Sequential Workflow JS context surface without redesigning Blue internals.

**Baseline references:** Baseline #2 §9 (“Mapping to current Blue JavaScript context”)

**Detailed tasks:**

- [ ] Implement a function like `createBlueWorkflowRuntime(...)` that:

  - [ ] builds the input envelope `I` from Blue workflow inputs,
  - [ ] creates host functions that read from Blue document snapshot and overlay,
  - [ ] configures the manifest and program artifact `P`.

- [ ] Ensure `document()`, `document.canonical()`, `event`, `steps`, `canon` match Blue docs.
- [ ] Add fixture-based tests based on the Blue context examples (minimal subset).

**Implementation hints (for Codex):**

- Keep this package thin; the deterministic logic must live in `dv`, `host`, and `quickjs-runtime`.

**Acceptance criteria:**

- [ ] Integration tests show the Blue-style globals work as expected for at least 2 sample workflows.
- [ ] Determinism holds for those samples across Node and browser (full cross-env tests will come later).

---

### T-071: Create Node smoke runner app (`apps/smoke-node`)

**Phase:** P6 – Blue Sequential Workflow integration and examples
**Status:** TODO
**Depends on:** T-064, T-065, T-060

**Goal:**
Provide a CLI-like runner for local development and debugging that executes a program artifact against an input envelope with a configured host.

**Detailed tasks:**

- [ ] Implement a simple command or script entry that:

  - [ ] loads `P` and `I` fixtures,
  - [ ] runs the VM with a specified gas budget,
  - [ ] prints deterministic result summary (codes/tags/bytes sizes), not raw host logs.

- [ ] Include an option to enable tape output.

**Implementation hints (for Codex):**

- Avoid printing nondeterministic data; keep output stable for test snapshots.

**Acceptance criteria:**

- [ ] `pnpm nx serve smoke-node` (or equivalent) can run a sample and prints a stable summary.
- [ ] The runner can exit with nonzero code on deterministic error.

---

### T-072: Create browser smoke runner app (`apps/smoke-web`)

**Phase:** P6 – Blue Sequential Workflow integration and examples
**Status:** TODO
**Depends on:** T-064, T-052

**Goal:**
Provide a minimal browser app that loads the same Wasm bytes and runs the same fixture programs as Node.

**Baseline references:** Baseline #1 §1A

**Detailed tasks:**

- [ ] Create a minimal web app (Vite or Nx web tooling) that:

  - [ ] loads Wasm from `quickjs-wasm`,
  - [ ] runs the same sample `P/I/G` fixtures as `smoke-node`,
  - [ ] displays deterministic results in-page.

- [ ] Ensure the `.wasm` served is identical to the Node-loaded bytes (verify hash in dev mode).

**Implementation hints (for Codex):**

- Add a small “hash display” of wasm bytes for debugging determinism.

**Acceptance criteria:**

- [ ] Opening the app runs the sample and shows deterministic result.
- [ ] The wasm hash shown matches the Node runner’s wasm hash for the same build.

---

# Phase P7 — Determinism & gas test harnesses, CI, and documentation hardening

### T-080: Cross-environment determinism harness (Node vs browser)

**Phase:** P7 – Determinism & gas test harnesses, CI, and documentation
**Status:** TODO
**Depends on:** T-072, T-071, T-028, T-064

**Goal:**
Prove Baseline #1 and #2 invariants by running the same fixtures in Node and in a headless browser and comparing outputs + exact OOG points.

**Baseline references:** Baseline #1 §1–§2, Baseline #2 §0.3

**Detailed tasks:**

- [ ] Set up Playwright test runner (or similar) to run `apps/smoke-web` headlessly.
- [ ] Create shared fixtures in `libs/test-harness`: `(P, I, G)` plus expected results.
- [ ] Run the same fixtures in Node tests and in browser tests and compare:

  - [ ] return value (DV bytes),
  - [ ] thrown error (code/tag),
  - [ ] gas used/remaining,
  - [ ] overlay/effects outputs,
  - [ ] tape (if enabled).

- [ ] Add a helper that normalizes output into a canonical JSON for diffing (no nondeterministic fields).

**Implementation hints (for Codex):**

- Compare DV bytes, not JS objects, to avoid subtle ordering differences slipping in.
- Include at least one fixture that triggers OOG at a deterministic boundary.

**Acceptance criteria:**

- [ ] `pnpm nx test test-harness` runs Node+browser determinism tests and passes.
- [ ] At least 5 fixtures pass cross-environment with exact gas equality.

---

### T-081: Host-call determinism and limits conformance tests

**Phase:** P7 – Determinism & gas test harnesses, CI, and documentation
**Status:** TODO
**Depends on:** T-063, T-040, T-080

**Goal:**
Validate host-call determinism, gas-by-size/unit charging, and deterministic limit failures.

**Baseline references:** Baseline #2 §0.3, §3.2–3.4, §1.6

**Detailed tasks:**

- [ ] Add tests that:

  - [ ] call a READ function with varying arg sizes and assert gas formula,
  - [ ] exceed request/response size limits and assert deterministic errors,
  - [ ] exceed host units and assert deterministic `OOG_HOST_UNITS` (or equivalent).

- [ ] Add tests verifying that host cannot do large work “for free”.

**Implementation hints (for Codex):**

- Use synthetic host functions in test harness that simulate units and response sizes predictably.

**Acceptance criteria:**

- [ ] Gas for host calls matches declared schedule for multiple sizes/units cases.
- [ ] Limit errors are stable and match expected codes/tags.

---

### T-082: Rollback determinism tests (OOG/unhandled error ⇒ discard overlay)

**Phase:** P7 – Determinism & gas test harnesses, CI, and documentation
**Status:** TODO
**Depends on:** T-061, T-080

**Goal:**
Ensure state mutation is outside JS heap and rollback behavior is deterministic on OOG or fatal error.

**Baseline references:** Baseline #1 §4, Baseline #2 §4.2

**Detailed tasks:**

- [ ] Create a fixture that performs WRITE calls then triggers OOG.
- [ ] Assert overlay is discarded and no writes are committed.
- [ ] Create a fixture that triggers a deterministic fatal error and assert rollback.
- [ ] Add tests verifying the overlay remains intact only on success.

**Implementation hints (for Codex):**

- Decide and document which errors cause full rollback (likely any uncaught exception + OOG).

**Acceptance criteria:**

- [ ] OOG/unhandled error results in zero committed overlay changes.
- [ ] Successful run results in expected committed overlay changes.

---

### T-083: CI pipeline (build, test, wasm build, browser tests)

**Phase:** P7 – Determinism & gas test harnesses, CI, and documentation
**Status:** TODO
**Depends on:** T-080, T-004

**Goal:**
Add CI that reliably builds and tests the entire system, including headless browser determinism tests and wasm builds.

**Detailed tasks:**

- [ ] Add GitHub Actions workflows (or your CI) to run:

  - [ ] install (pnpm),
  - [ ] lint/format check,
  - [ ] TypeScript tests,
  - [ ] native harness tests,
  - [ ] wasm build,
  - [ ] Playwright browser determinism tests.

- [ ] Cache pnpm store and emsdk.
- [ ] Upload wasm build artifacts as CI artifacts (optional) for inspection.

**Implementation hints (for Codex):**

- Ensure emsdk is installed via the pinned version from T-004.

**Acceptance criteria:**

- [ ] CI passes on a clean run.
- [ ] CI fails deterministically when determinism fixtures fail (no flaky tests).

---

### T-084: Documentation hardening (determinism profile, gas schedule, ABI/DV specs)

**Phase:** P7 – Determinism & gas test harnesses, CI, and documentation
**Status:** TODO
**Depends on:** T-080

**Goal:**
Turn the placeholder docs into normative references that match implementation and tests.

**Baseline references:** Baselines #1 and #2 (all)

**Detailed tasks:**

- [ ] Update `docs/determinism-profile.md` with the exact exposed APIs and stubbing strategy.
- [ ] Update `docs/gas-schedule.md` with: opcode costs, builtin costs, allocation/GC costs, host-call schedule model.
- [ ] Update `docs/dv-wire-format.md` with final encoding spec + examples.
- [ ] Update `docs/abi-manifest.md` with schema, hashing rules, and evolution policy (fn_id immutability).
- [ ] Add a “Security & determinism checklist” section to root `README.md`.

**Implementation hints (for Codex):**

- Align docs with tests: docs should describe what tests assert.

**Acceptance criteria:**

- [ ] Docs cover all baseline invariants with explicit “testable statements”.
- [ ] A new contributor can run determinism tests end-to-end using docs alone.

---

### T-085: Release packaging strategy for Wasm and SDK libs

**Phase:** P7 – Determinism & gas test harnesses, CI, and documentation
**Status:** TODO
**Depends on:** T-052, T-064

**Goal:**
Define how libs are versioned and published so that program artifacts `P` can pin engine/ABI versions reliably.

**Baseline references:** Baseline #1 §1A (engine bytes pinned), Baseline #2 §7 (versioning and evolution)

**Detailed tasks:**

- [ ] Decide publishing strategy for:

  - [ ] `quickjs-wasm` (contains wasm bytes),
  - [ ] `quickjs-runtime`, `host`, `dv`, `abi-manifest`, `blue-integration`.

- [ ] Define how `engine_build_hash` is generated and distributed.
- [ ] Define compatibility policy: which semver changes require new `abi_version` / new manifest / new `fn_id`s.
- [ ] Add a release checklist doc.

**Implementation hints (for Codex):**

- Ensure release process doesn’t rebuild wasm differently per environment; ideally build once in CI and publish those bytes.

**Acceptance criteria:**

- [ ] A documented release workflow exists and is consistent with `P` pinning requirements.
- [ ] `engine_build_hash` is accessible at runtime and can be recorded into `P`.

---

## Appendix: Suggested initial ABI surface (Host.v1)

This is not a redesign—just a concrete starting point consistent with Baseline #2. Use this to seed your initial manifest fixture and host registry.

- `Host.v1.document.get(path: string) -> DV` (READ)
- `Host.v1.document.getCanonical(path: string) -> CanonicalNodeDV` (READ)
- `Host.v1.overlay.applyPatch(patchOps: PatchOp[]) -> null` (WRITE)
- `Host.v1.emit(event: DV) -> null` (EMIT)
- `Host.v1.debug.tapeEnabled() -> boolean` (PURE) (optional)

(Exact schemas and limits live in the manifest; gas schedules are declarative per Baseline #2 §3.2.)

---

## Appendix: Global invariants checklist (what tests must eventually prove)

- **Determinism:** Same `(P, I, G)` ⇒ same outputs + same exact OOG point across Node and browser. (Baseline #1, Baseline #2 §0.3)
- **Canonical gas:** opcode + metered C builtins + deterministic allocation/GC, not wasm instruction counts. (Baseline #1 §2B)
- **Strict capability profile:** no time/random/async/network/fs/locale leaks; no typed arrays / AB / WebAssembly. (Baseline #1 §1B, §3)
- **Single syscall ABI:** `fn_id` + canonical bytes; manifest-locked mapping; VM validates manifest hash. (Baseline #2 §1.1–1.4)
- **DV restrictions:** only allowed types; numeric restrictions; canonical key ordering; deterministic encoding. (Baseline #2 §2)
- **Two-phase charging:** host calls charged deterministically by sizes + units; no expensive host work for free. (Baseline #2 §3)
- **Rollback:** overlay discarded on OOG/fatal error; no partial commit. (Baseline #1 §4, Baseline #2 §4)

---

If you want, I can also add a **“starter fixture set”** section (names of programs + expected outputs/gas) that Codex can implement as the very first determinism tests, but I avoided pre-choosing your exact fixture semantics here to keep this plan aligned with your “implementation choices later” constraint.

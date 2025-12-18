# QuickJS wasm gas harness (T-029) — temporary notes

This documents the early wasm gas harness from T-029 (no host ABI) so P4 hardening can proceed without accidentally changing the P2 gas contracts.

Baseline anchor: see `docs/baseline-1.md` (canonical gas) and `docs/baseline-2.md` (host ABI; this harness predates it).

## Stable for P2.5

- Entry points and output format: `qjs_eval(code, gas_limit)` and `qjs_free_output(ptr)` emitting `RESULT|ERROR … GAS remaining=<n> used=<n> [TRACE …]` are relied on by the Node and browser gas harnesses.
- Artifact names/paths: release + debug builds under `libs/quickjs-wasm-build/dist/quickjs-eval{,-debug}{,-wasm64}.{js,wasm}` resolved via `getQuickjsWasmArtifacts(<variant>, <buildType>)` (buildType defaults to `release`); harnesses import the ESM loader directly from that location.
- wasm32 gas baselines are pinned by fixtures in `libs/test-harness/src/lib/gas-equivalence.spec.ts` (zero-precharge, gc-checkpoint-budget, loop-oog, constant, addition, string-repeat). wasm64 remains a debug-only variant intended to mirror native when available; the browser smoke page now focuses on the Host.v1 baseline.
- Core gas semantics from P2 (opcode/alloc/GC charging and OOG boundaries) plus the textual GAS reporting must stay stable even if the wasm build flags change.

## Temporary limitations (allowed to evolve in P4)

- No host ABI/manifest/Host.v1 yet; `qjs_eval` simply runs source and `JSONStringify`s the result, so non-JSON-returnable values will throw and DV is not enforced.
- wasm32 gas numbers diverge from native due to 32-bit allocator layout; wasm32 is the browser-compatible default and now the chosen canonical variant. wasm64 builds are not planned/supported because of portability limits; if we ever revisit memory64, expect to re-baseline fixtures intentionally.
- Emscripten flags are provisional: release uses `-O2` + `-sASSERTIONS=0`, debug adds runtime checks (`-sASSERTIONS=2`, `-sSTACK_OVERFLOW_CHECK=2`) but retains the same deterministic memory/FS/table settings (`NO_EXIT_RUNTIME`, `INITIAL_MEMORY=32MiB`, `STACK_SIZE=1MiB`, `ALLOW_MEMORY_GROWTH=0`, `WASM_BIGINT=1`). Further P4 adjustments are allowed as long as the pinned gas outputs remain unchanged.
- Artifacts are not packaged/published and carry no manifest hash or engine metadata beyond the wasm-build metadata emitted alongside them; they are only consumed by the internal gas harnesses for now.

## P4 hardening reminders

- Decide the canonical wasm variant (wasm32 with padded allocator vs wasm64) and lock the gas numbers before layering in the host ABI.
- Add build metadata/hashes and deterministic packaging in `quickjs-wasm`.
- Revisit memory sizing/fuse/config for determinism without moving gas baselines.
- Replace the JSON-stringify harness with DV-aware plumbing once host ABI wiring lands. Note: the deterministic entrypoint `qjs_det_eval` already returns DV-encoded bytes as lowercase hex; only the legacy `qjs_eval` harness remains JSON-stringified for gas baselines.

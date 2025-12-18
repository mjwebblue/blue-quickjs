# BlueQuickjs

Deterministic QuickJS-in-Wasm evaluator monorepo (Nx + pnpm), tracking a hardened QuickJS fork and SDK/tooling to run it.

## QuickJS fork
- Submodule at `vendor/quickjs` (origin `git@blue.github.com:mjwebblue/quickjs.git`).
- Fresh checkout: `git submodule update --init --recursive`.
- Update the pin after landing changes in the fork: `cd vendor/quickjs && git fetch origin && git checkout <new-ref>` then `cd .. && git add vendor/quickjs && git commit -m "chore: bump quickjs submodule"`.
- Do QuickJS edits in the fork repository and only commit the pinned SHA here.

## Workspace basics
- Install deps: `pnpm install`.
- Visualize projects: `pnpm nx graph`.
- Run tests across projects: `pnpm nx run-many -t test`.
- Apply lint fixes: `pnpm lint --fix`.

## Toolchain
- Emscripten is pinned to `3.1.56`; install via `tools/scripts/setup-emsdk.sh`, then `source tools/emsdk/emsdk_env.sh`. See `docs/toolchain.md` for details and CI cache notes.

## Docs
- Determinism profile: `docs/determinism-profile.md`
- Gas schedule: `docs/gas-schedule.md`
- DV wire format: `docs/dv-wire-format.md`
- ABI manifest: `docs/abi-manifest.md`
- Host call ABI: `docs/host-call-abi.md`

## Determinism checklist
- Same `(P, I, G)` yields identical result bytes, gas used/remaining, and host-call tape hashes across Node and browser.
- Deterministic capability profile: time/random/async/IO/typed arrays/WebAssembly disabled; use `Host.v1` for IO (`docs/determinism-profile.md`).
- Canonical gas: opcode/builtin/allocation/GC charges plus two-phase host-call gas (`docs/gas-schedule.md`).
- DV and manifest: canonical DV encoding, safe numeric range, sorted keys, size caps, manifest hash pinning (`docs/dv-wire-format.md`, `docs/abi-manifest.md`).
- Host ABI: `host_call` envelope, deterministic error mapping, and reentrancy rules (`docs/host-call-abi.md`).

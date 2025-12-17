# AGENTS.md

Guidance for automated coding agents (and humans) working in this repository.

## Repo overview

- **Monorepo tooling**: Nx + pnpm workspaces.
- **Languages**: TypeScript (ESM), plus C for QuickJS harnesses/build scripts.
- **Core goal**: Deterministic QuickJS evaluation in Wasm with gas metering.

Key locations:

- **Apps**: `apps/*` (e.g. browser and node smoke projects)
- **Libraries**: `libs/*` (e.g. DV, wasm runtime/build, test harness)
- **Tooling**: `tools/*` (e.g. native harness, emsdk bootstrap scripts)
- **QuickJS fork pin**: `vendor/quickjs` (git submodule)
- **Specs/docs**: `docs/*` (determinism profile, gas schedule, DV wire format, host ABI)

## Environment expectations

- **Node**: `>= 20.17.0` (see root `package.json`).
- **Package manager**: `pnpm` (workspace in `pnpm-workspace.yaml`).

## Common workflows (Nx)

From repo root:

- **Install deps**: `pnpm install`
- **Build all**: `pnpm build`
- **Test all**: `pnpm test`
- **Typecheck all**: `pnpm typecheck`
- **Lint all**: `pnpm lint`

Run a single project target:

- `pnpm nx build <project>`
- `pnpm nx test <project>`
- `pnpm nx typecheck <project>`
- `pnpm nx lint <project>`

Passing extra args to underlying tools:

- **Fix lint** (recommended): `pnpm nx run-many -t lint --all -- --fix`
- **Single project fix**: `pnpm nx lint <project> -- --fix`

## Wasm toolchain (emsdk)

QuickJS Wasm builds require a **pinned Emscripten** toolchain.

- Install/activate pinned version: `tools/scripts/setup-emsdk.sh`
- Load env in your shell session: `source tools/emsdk/emsdk_env.sh`
- Verify: `emcc --version` should report the pinned version (`3.1.56`).

See `docs/toolchain.md` for details and CI cache notes.

## QuickJS Wasm build outputs

`libs/quickjs-wasm-build` compiles the deterministic QuickJS fork + wasm harness and emits:

- Release + debug artifacts for wasm32 (canonical):
  `libs/quickjs-wasm-build/dist/quickjs-eval{,-debug}.{js,wasm}`
- Optional memory64 builds: set `WASM_VARIANTS=wasm32,wasm64` to also emit
  `quickjs-eval-wasm64{,-debug}.{js,wasm}`.
- Control build types with `WASM_BUILD_TYPES=release,debug` (defaults to both).

Build:

- `pnpm nx build quickjs-wasm-build`

Notes:

- wasm32 is the chosen canonical variant; wasm64 is for debugging only and not broadly portable.

## Smoke / integration checks

Browser smoke (Playwright):

- `pnpm nx run smoke-web:e2e`
  - Starts a Vite server on `http://localhost:4300` and runs `apps/smoke-web/tests/*`.

Node smoke:

- `pnpm nx test smoke-node`

Native harness (standalone binary):

- `pnpm nx build quickjs-native-harness`
- `pnpm nx test quickjs-native-harness`
- Manual run: `tools/quickjs-native-harness/dist/quickjs-native-harness --eval "1 + 2"`

## Coding conventions

- **TypeScript is strict** (`tsconfig.base.json`); prefer explicit, deterministic behavior.
- **ESM** is the default; many packages use `"type": "module"`.
- **Imports**: Prefer workspace path aliases (`@blue-quickjs/*`) when appropriate.
- **Formatting**: ESLint + Prettier (flat config). Keep changes minimal and consistent.

When touching determinism/gas/DV/ABI behavior, consult the normative docs:

- `docs/determinism-profile.md`
- `docs/gas-schedule.md`
- `docs/dv-wire-format.md`
- `docs/host-call-abi.md`

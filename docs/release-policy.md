# Release Policy (Engine + ABI Pinning)

Scope: define publishing and versioning policy so consumers can pin engine + ABI deterministically (Baseline #1 §1A; Baseline #2 §7).

## Published packages

- `@blue-quickjs/dv`: DV encode/decode + validation (pure TS).
- `@blue-quickjs/abi-manifest`: manifest schema + canonical DV encoding + hashing (depends on DV).
- `@blue-quickjs/quickjs-wasm`: packaged wasm + loader + build metadata (`quickjs-wasm-build.metadata.json`).
- `@blue-quickjs/quickjs-runtime`: SDK to evaluate `(P, I, G)` with manifest-backed host dispatch.

Internal-only (not published):

- `@blue-quickjs/quickjs-wasm-build` (build pipeline)
- `@blue-quickjs/test-harness` (fixtures/tests)

## Pinning inputs

A deterministic program artifact `P` should pin:

- `abiId`, `abiVersion`
- `abiManifestHash` (sha256 of canonical manifest bytes)
- `engineBuildHash` (optional but strongly recommended)

`@blue-quickjs/quickjs-runtime` validates these fields and rejects mismatches when provided.

## engine_build_hash

Definition:

- `engineBuildHash = sha256(wasm_bytes)` for a given variant + buildType.
- Lowercase hex, 64 characters.

Exposure:

- `quickjs-wasm-build.metadata.json` includes:
  - `variants.<variant>.<buildType>.engineBuildHash` for every emitted artifact.
  - Top-level `engineBuildHash`, set to the canonical engine hash (`wasm32` + `release`) when present.
- `@blue-quickjs/quickjs-wasm` exposes these values via `loadQuickjsWasmMetadata()` and
  `QuickjsWasmArtifact.variantMetadata.engineBuildHash`.

Usage:

- Consumers should embed the canonical hash in `P.engineBuildHash` to pin the engine.
- If running a non-canonical build (debug or wasm64), pin to that variant's `engineBuildHash` instead.

## abi_manifest_hash

Definition:

- `abiManifestHash = sha256(encodeAbiManifest(manifest))` using canonical DV encoding
  (`@blue-quickjs/abi-manifest`).

All manifest byte changes produce a new hash and must be reflected in `P.abiManifestHash`.

## Semver policy (packages)

Semver communicates JS/TS API compatibility; engine/ABI pinning is done via hashes.

- `@blue-quickjs/quickjs-wasm` + `@blue-quickjs/quickjs-runtime` are released together
  with the same version.
  - Major: deterministic semantics changes (gas schedule, determinism profile, host-call ABI,
    manifest schema, or other changes that can alter outputs or OOG boundaries).
  - Minor: additive APIs or new Host.v1 functions (new `fn_id`) that do not invalidate
    existing programs.
  - Patch: bugfixes or packaging changes that do not change deterministic outputs.

- `@blue-quickjs/dv`:
  - Major: wire-format changes, numeric rules/limits changes.
  - Minor: additive helpers/options.
  - Patch: bugfixes with identical wire format.

- `@blue-quickjs/abi-manifest`:
  - Major: manifest schema or validation rule changes.
  - Minor: additive helpers/options.
  - Patch: bugfixes.

## Change triggers (hashes and IDs)

New `engineBuildHash` is required when:

- Any change to the QuickJS fork, deterministic init/profile, gas schedule, host-call ABI,
  memory sizing, toolchain version, or build flags alters the wasm bytes.
- Rebuilding with different Emscripten/flags also produces a new hash.

New `abiManifestHash` is required when:

- Any manifest field changes: function list, `fn_id`, `js_path`, `arg_schema`,
  `return_schema`, gas, limits, or `error_codes`.

New `fn_id` is required when:

- Introducing a new host capability, or changing the signature/meaning of an existing one.
- `fn_id` values are never reused.

`abi_version` / `abi_id` policy:

- Bump `abi_version` when the manifest schema or host-call ABI changes in a way that older
  hosts/VMs cannot interpret.
- For incompatible surface changes, use a new `abi_id` (e.g., `Host.v2`).

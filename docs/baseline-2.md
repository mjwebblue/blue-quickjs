# Baseline #2 — Host ABI (Manifest-Locked) + DV Wire Format

This document is the **baseline-level contract** for the host ABI in this repository. Many other docs reference “Baseline #2”; those references are anchored here.

Baseline docs are intentionally **invariant-focused**. The detailed, normative specifications live in:

- DV canonical encoding and limits: `docs/dv-wire-format.md`
- Host-call Wasm import ABI and ownership: `docs/host-call-abi.md`
- ABI manifest schema, canonicalization, hashing, and validation rules: `docs/abi-manifest.md`
- Host-call gas formula and constants: `docs/gas-schedule.md`

## 0. Scope and terms (normative)

Baseline #2 defines how deterministic external capabilities are exposed to the VM via a **single dispatcher syscall**, using:

- a **manifest** mapping stable numeric IDs (`fn_id`) to JS wrapper paths and policy,
- **DV** (Deterministic Value) as the only cross-boundary value model,
- and a deterministic response envelope (Ok/Err + `units`) with manifest-driven error mapping.

Terms:

- **VM**: the deterministic QuickJS runtime (native and Wasm builds).
- **Host**: the embedder (Node or browser) implementing the syscall import and document access.
- **P**: program artifact that pins the ABI manifest hash (and optionally engine identity).
- **I**: deterministic input envelope injected as a context blob / DV.
- **DV**: deterministic value model + canonical encoding.

## 1. Core invariants (normative)

### 1.1 Single dispatcher

All host capabilities are invoked through a **single syscall-style primitive**:

- VM calls `host_call(fn_id, request_bytes) -> response_bytes`.
- Dispatch selection is **numeric `fn_id`** only; strings are ergonomics only.

The Wasm import signature and buffer ownership rules are specified in `docs/host-call-abi.md`.

### 1.2 Manifest-locked ABI surface

The ABI manifest is the **single source of truth** for:

- which `fn_id` values exist,
- how they are exposed into JS (via `js_path` under `Host.v1`),
- arity and argument/return schemas,
- gas parameters and deterministic limits,
- allowed host error codes and their deterministic tags.

The manifest schema and validation rules are specified in `docs/abi-manifest.md`.

### 1.3 Manifest pinning by hash

Each program artifact `P` must pin:

- `abi_id` and `abi_version`
- `abi_manifest_hash = sha256(manifest_bytes)` (lowercase hex)

At VM initialization:

- the host provides `manifest_bytes`,
- the VM hashes those bytes and must **exact-match** `abi_manifest_hash`,
- mismatch is a deterministic failure (ManifestError).

### 1.4 DV-only wire values

All cross-boundary values are DV:

- **request_bytes** is the canonical DV encoding of a positional args array.
- **response_bytes** is the canonical DV encoding of a response envelope.

DV types, canonical encoding rules, and limits are specified in `docs/dv-wire-format.md`.

## 2. Response envelope and deterministic errors (normative)

The host must return one of two envelope shapes (encoded as DV):

- Ok: `{ "ok": <DV>, "units": <uint32> }`
- Err: `{ "err": { "code": <string>, "details"?: <DV> }, "units": <uint32> }`

Invariants:

- Envelope contains `units` and **exactly one** of `ok` or `err`.
- Unknown keys make the envelope invalid.
- `units` is bounded by manifest `max_units`.
- For `err`, `code` must be listed in the manifest; the VM derives the deterministic error `tag` from the manifest mapping.

Non-manifest failures are surfaced as reserved deterministic VM errors:

- `HOST_TRANSPORT` / `host/transport` for syscall transport failures
- `HOST_ENVELOPE_INVALID` / `host/envelope_invalid` for malformed envelopes

The envelope contract is specified in `docs/abi-manifest.md` and `docs/host-call-abi.md`.

## 3. Deterministic limits (normative)

Every host call is bounded by:

- global DV limits (encoded bytes, depth, string bytes, container sizes),
- plus per-function manifest limits (`max_request_bytes`, `max_response_bytes`, `max_units`),
- plus any tighter implementation limits (allowed as defense-in-depth, but must be deterministic).

## 4. Deterministic host-call gas (normative)

Host calls are charged deterministically in two phases using manifest parameters:

- Pre-charge: `base + (k_arg_bytes * request_bytes)`
- Post-charge: `(k_ret_bytes * response_bytes) + (k_units * units)`

Canonical gas rules and constants are specified in `docs/gas-schedule.md` and manifest gas fields in `docs/abi-manifest.md`.

## 5. No reentrancy, no async (normative)

- `host_call` is synchronous and non-reentrant.
- The host must not call back into the VM during a host call.
- Any async work must be handled outside VM execution; the ABI boundary is strictly call/return.

## 6. JS projection surface (normative)

The VM projects the manifest into JS as:

- `Host` and `Host.v1` namespaces created with null prototypes,
- namespace objects are non-extensible; function properties are non-writable and non-configurable,
- ergonomic globals may be installed (`document`, `event`, `steps`, `canon`) but must be deterministic and pinned by the deterministic init contract.

The current manifest ABI id/version is `Host.v1` (see `docs/abi-manifest.md` and `docs/determinism-profile.md`).



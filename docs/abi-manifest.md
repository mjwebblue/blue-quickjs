# ABI Manifest (Baseline #2)

The ABI manifest maps **numeric function IDs** to host capabilities and is the single source of truth for generating `Host.v1` and validating host responses. The manifest is canonicalized and hashed; both the VM and host dispatcher must consume identical bytes (Baseline #2 §1.1–§1.4, §6.1–§6.3).

## Canonical structure

- Manifest is a **DV map** (see `docs/dv-wire-format.md`) encoded canonically with the DV encoder. All integers must be within the DV safe range (`abs(n) <= 2^53 - 1`).
- **Uint32 convention:** Any field described as `uint32` MUST be a DV number that is an integer in `[0, 2^32 - 1]` (finite, no `-0`).
- Unless noted, all string fields are UTF-8 strings (definite-length only) and compared case-sensitively.
- Arrays are **ordered**; producers MUST emit arrays in the prescribed canonical order (otherwise the manifest is invalid).

### Top-level fields

- `abi_id` (string): Must be `"Host.v1"` in the current implementation (validation rejects other values). This is the string baked into `P`.
- `abi_version` (uint32): Must be `1` in the current implementation (validation rejects other values).
- `functions` (array): Ordered by ascending `fn_id` and must contain at least one entry. Each entry is a map described below. `fn_id` values MUST be unique.

No other top-level keys are permitted; unknown keys make the manifest invalid.

### Function entry fields

Each function is a DV map with the following fields (no extras):

- `fn_id` (uint32): Numeric ID used by the VM when calling `host_call`. Range: `1`–`2^32 - 1`.
- `js_path` (array<string>): Property path relative to `Host.v1` used to install the JS wrapper (e.g., `["document", "get"]`). Segments MUST be non-empty, match `[A-Za-z0-9_-]+`, and the array MUST contain at least one segment. The following segment values are forbidden: `__proto__`, `prototype`, `constructor`.
- `effect` (string enum): `"READ" | "EMIT" | "MUTATE"`. Determines host-side semantics and auditing. For P3, only `READ`/`EMIT` are used.
- `arity` (uint32): Exact number of positional arguments accepted by the host function.
- `arg_schema` (array): Length MUST equal `arity`. Each item is a schema map (see **Schema language** below).
- `return_schema` (map): Schema describing the return value (see **Schema language**).
- `gas` (map): Gas parameters for two-phase charging:
  - `schedule_id` (string): Identifier for the gas schedule entry (ties into `docs/gas-schedule.md`). The VM does not validate this value; it is for audit/traceability.
  - `base` (uint32): Pre-charge base units per call.
  - `k_arg_bytes` (uint32): Pre-charge multiplier for request bytes.
  - `k_ret_bytes` (uint32): Post-charge multiplier for **response envelope bytes**.
  - `k_units` (uint32): Post-charge multiplier for host-reported `units`.
- `limits` (map): Deterministic bounds enforced before/after the host call:
  - `max_request_bytes` (uint32): Upper bound on encoded request size sent to host.
  - `max_response_bytes` (uint32): Upper bound on encoded response envelope received from host.
  - `max_units` (uint32): Upper bound on host-reported `units`.
  - Optional `arg_utf8_max` (array<uint32>): Per-arg UTF-8 byte limits when `type: "string"`; length MUST match `arity` if present.
- `error_codes` (array): Ordered list of allowed host error variants. Each item is a map:
  - `code` (string): Stable code returned by host (e.g., `"INVALID_PATH"`).
  - `tag` (string): Deterministic error tag surfaced in VM (`HostError.tag`), e.g., `"host/invalid_path"`.

### Schema language (arg and return)

Schema maps are intentionally small to keep canonicalization obvious. Allowed shapes:

- `{ "type": "string" }` — UTF-8 string; if paired with `arg_utf8_max`, that limit applies.
- `{ "type": "dv" }` — Any DV value (subject to global DV limits).
- `{ "type": "null" }` — Literal `null` (useful for `emit` returning nothing).

Unknown `type` values or extra keys make the manifest invalid.

### Request/response bytes (normative)

- `request_bytes` MUST be the canonical DV encoding of a **DV array** of positional arguments, with length exactly equal to `arity`. Each element MUST validate against the corresponding `arg_schema` entry. `max_request_bytes` applies to this encoded args array.
- `response_bytes` MUST be the canonical DV encoding of the **response envelope**. The envelope MUST be either:
  - Ok: `{ "ok": <DV>, "units": <uint32> }`
  - Err: `{ "err": { "code": <string>, "details"?: <DV> }, "units": <uint32> }`

- Envelope invariants:
  - Envelope MUST contain `units` and **exactly one** of `ok` or `err`.
  - Unknown keys make the response invalid.
  - `units` MUST satisfy `0 <= units <= max_units`.
  - For `err`, `code` MUST be listed in the manifest `error_codes`; the VM derives the error `tag` from the manifest mapping for that code. Responses with unknown codes are invalid.

Example envelopes:

- Ok: `{ "ok": { "path": "doc" }, "units": 9 }`
- Err: `{ "err": { "code": "NOT_FOUND" }, "units": 2 }`

`max_response_bytes` applies to the entire encoded response envelope. `max_units` applies to the `units` field in either envelope shape.

## Canonical serialization + hashing

1. Build the manifest object using the schema above. `functions` MUST already be sorted ascending by `fn_id` (unsorted manifests are invalid); `error_codes` MUST be sorted ascending by `code` within each function. `js_path` order is significant and MUST match the desired property chain.
2. Encode the manifest with the canonical DV encoder (definite-length CBOR subset; see `docs/dv-wire-format.md`). Do not JSON-serialize.
3. Compute `abi_manifest_hash = sha256(manifest_bytes)` and render as **lowercase hex without prefix** (64 characters).
4. The hash (and raw `manifest_bytes`) are what the VM pins during initialization; any byte change alters the hash.

## Example: `Host.v1` read-only surface

This example covers the minimal read-only surface required by the evaluator. Gas numbers and limits are illustrative; downstream tickets can refine them while keeping the structure stable.

```json
{
  "abi_id": "Host.v1",
  "abi_version": 1,
  "functions": [
    {
      "fn_id": 1,
      "js_path": ["document", "get"],
      "effect": "READ",
      "arity": 1,
      "arg_schema": [{ "type": "string" }],
      "return_schema": { "type": "dv" },
      "gas": { "schedule_id": "doc-read-v1", "base": 20, "k_arg_bytes": 1, "k_ret_bytes": 1, "k_units": 1 },
      "limits": { "max_request_bytes": 4096, "max_response_bytes": 262144, "max_units": 1000, "arg_utf8_max": [2048] },
      "error_codes": [
        { "code": "INVALID_PATH", "tag": "host/invalid_path" },
        { "code": "LIMIT_EXCEEDED", "tag": "host/limit" },
        { "code": "NOT_FOUND", "tag": "host/not_found" }
      ]
    },
    {
      "fn_id": 2,
      "js_path": ["document", "getCanonical"],
      "effect": "READ",
      "arity": 1,
      "arg_schema": [{ "type": "string" }],
      "return_schema": { "type": "dv" },
      "gas": { "schedule_id": "doc-read-v1", "base": 20, "k_arg_bytes": 1, "k_ret_bytes": 1, "k_units": 1 },
      "limits": { "max_request_bytes": 4096, "max_response_bytes": 262144, "max_units": 1000, "arg_utf8_max": [2048] },
      "error_codes": [
        { "code": "INVALID_PATH", "tag": "host/invalid_path" },
        { "code": "LIMIT_EXCEEDED", "tag": "host/limit" },
        { "code": "NOT_FOUND", "tag": "host/not_found" }
      ]
    },
    {
      "fn_id": 3,
      "js_path": ["emit"],
      "effect": "EMIT",
      "arity": 1,
      "arg_schema": [{ "type": "dv" }],
      "return_schema": { "type": "null" },
      "gas": { "schedule_id": "emit-v1", "base": 5, "k_arg_bytes": 1, "k_ret_bytes": 0, "k_units": 1 },
      "limits": { "max_request_bytes": 32768, "max_response_bytes": 64, "max_units": 1024 },
      "error_codes": [
        { "code": "LIMIT_EXCEEDED", "tag": "host/limit" }
      ]
    }
  ]
}
```

When canonically DV-encoded, these bytes are hashed with SHA-256 to produce the `abi_manifest_hash` that must be echoed in `P`. Tooling in `libs/abi-manifest` (T-034) will emit the canonical bytes and hash for this fixture.

## Validation expectations (VM + tooling)

- Reject manifests that include unknown keys, out-of-range integers (including `-0`), unsorted `functions`/`error_codes`, or duplicate `fn_id`/`code`.
- Reject `js_path` collisions: no two entries may share the same `js_path`, and no `js_path` may be a prefix of another.
- Enforce `arity === arg_schema.length` and (if present) `arg_utf8_max.length === arity`; if provided, `arg_utf8_max[i]` requires `arg_schema[i].type` to be `"string"`. Because `arg_utf8_max` must cover every argument, manifests may only include it when **all** arguments are strings.
- `max_request_bytes`/`max_response_bytes` MUST be <= DV global max (1 MiB encoded) and non-zero; they apply to the fully encoded request array / response envelope bytes.
- Gas parameters must be non-negative integers; `schedule_id` is an opaque identifier and is not validated by the VM. Gas arithmetic MUST be performed with explicit overflow checks (e.g., 64-bit intermediates); overflow during manifest validation invalidates the manifest.
- `error_codes` is a set of allowed host error variants represented as an array sorted by `code` for canonical encoding.
- Responses must obey the envelope rules above: exactly one of `ok`/`err`, `units` within bounds, no extra keys, and `err.code` MUST exist in `error_codes` (tag is derived from the manifest mapping).

Implementations MAY impose tighter bounds (e.g., max `abi_id` length, max `js_path` segments, max `functions.length`, max `code`/`tag` length) in addition to the DV global limits to reduce attack surface.

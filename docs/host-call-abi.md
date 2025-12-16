# Host Call ABI (Baseline #2)

Scope: describe the single-dispatcher syscall (`host_call`) and generated `Host.v1` surface per Baseline #2 (e.g., §1.5, §2, §6.4, §9).

## Goals
- Define the Wasm import shape for `host_call` and the memory ownership contract.
- Describe request/response bytes (DV), limits, and deterministic error handling.
- Explain how this import underpins the generated `Host.v1` surface and ergonomic globals.

## Wasm import surface (T-037)

All Wasm builds use wasm32 with a single exported `memory` (little-endian data layout; growth is disabled for determinism). The VM issues host calls through one import:

```wat
(import "host" "host_call"
  (func $host_call (param i32 i32 i32 i32 i32) (result i32)))
```

Parameter meanings (all interpreted as `uint32` on the host side):
- `fn_id`: manifest function id (MUST be >= 1)
- `req_ptr`, `req_len`: request byte slice `[req_ptr, req_ptr + req_len)`
- `resp_ptr`, `resp_capacity`: response scratch slice `[resp_ptr, resp_ptr + resp_capacity)`
Return value: `resp_len` (uint32) or the sentinel `0xffffffff`.

Params are wasm `i32` values (module/name as shown above) and MUST be interpreted as unsigned `uint32` on the host side (e.g., `>>> 0` in JS) since JavaScript receives them as signed Numbers. Endianness does **not** apply to the params themselves; they are register values. The request/response **bytes** follow DV/CBOR rules, which are big-endian where CBOR specifies (see `docs/dv-wire-format.md`).

### Request bytes

- `request_bytes` is a contiguous region `[req_ptr, req_ptr + req_len)`.
- The VM guarantees `req_len` is within the global DV limit (1 MiB) and the manifest `max_request_bytes` for the target `fn_id`.
- The slice is **read-only** for the host and is only valid for the duration of the call.
- The bytes are the canonical DV encoding of the args array; see `docs/abi-manifest.md` for arg validation rules.

### Response bytes and ownership

- The VM allocates a scratch buffer and passes its address as `resp_ptr` with capacity `resp_capacity`. The capacity is at least `min(max_response_bytes, DV max)` for the function being invoked.
- The host must write the **entire encoded response envelope** (DV map) into this buffer starting at `resp_ptr` and return the exact length. Do not zero-terminate or write past `resp_capacity`.
- The host must **not retain** references to `memory.buffer` or assume the buffer persists across calls; the VM may reuse or overwrite it immediately after the call returns.
- **Return value:**
  - Success: return the response length in bytes (`0 <= len <= resp_capacity`). The VM will slice `[resp_ptr, resp_ptr + len)` to decode the envelope.
  - Fatal transport failure: return `UINT32_MAX` (`0xffffffff`). The VM treats this as an unrecoverable host-call failure and throws `HostError { code: "HOST_TRANSPORT", tag: "host/transport" }` (not a manifest-specified `err` envelope).
- If the encoded response would exceed `resp_capacity`, the host must not write partial bytes. It must instead return `UINT32_MAX` (fatal) or encode a manifest-defined limit error (e.g., `LIMIT_EXCEEDED`) **that fits** within `resp_capacity`.

### Limits and validity

- `req_len` and the encoded response length must both respect:
  - the global DV encoded-byte cap (1 MiB; see `docs/dv-wire-format.md`), **and**
  - the per-function `max_request_bytes` / `max_response_bytes` declared in the manifest.
- The response envelope must follow the manifest contract (`ok`/`err` + `units`; see `docs/abi-manifest.md`). Unknown keys, missing `units`, codes not listed in `error_codes`, or lengths greater than `resp_capacity` are deterministic VM errors.
- The host import itself must never trap; all host-side failures should result in either a valid `err` envelope or the fatal `UINT32_MAX` sentinel.
- Request and response regions are intended to be non-overlapping; the VM arranges offsets accordingly, but host adapters should still treat detected overlap as a fatal transport condition (`UINT32_MAX`).

### Deterministic error mapping (non-manifest failures)

- `UINT32_MAX` return **or** a host trap **or** a returned length greater than `resp_capacity` is surfaced as `HostError { code: "HOST_TRANSPORT", tag: "host/transport" }`.
- The return value is interpreted as `uint32`; any value that exceeds `resp_capacity` after coercion (including negative i32 values wrapped to large uint32) is treated as `HOST_TRANSPORT`.
- A response that cannot be DV-decoded, violates envelope structure (missing `units`, both/none of `ok`/`err`, unknown keys), has `units` out of bounds, or uses an `err.code` not listed in the manifest is surfaced as `HostError { code: "HOST_ENVELOPE_INVALID", tag: "host/envelope_invalid" }`.
- Manifest-declared `err.code` values map to their manifest `tag` as usual; the two codes above are reserved for transport/envelope failures and are **not** driven by the manifest.
- Manifest tooling/validation MUST reject manifests that attempt to declare `HOST_TRANSPORT` or `HOST_ENVELOPE_INVALID` in `error_codes`.

> Implementation note: until T-039 wires the final HostError surface, the VM temporarily surfaces transport/envelope failures as `TypeError` in tests; the shape above is the intended end state.

### Reentrancy and scheduling

- `host_call` is **synchronous** and **non-reentrant**. The host must not:
  - call back into the same VM (no nested `host_call`, no exported QuickJS entrypoints),
  - suspend/yield to an event loop that could observe or mutate VM state mid-call.
- The host may read/write the provided memory region and run pure synchronous logic only. Any async or delayed work must be handled outside the VM invocation.

### Reference implementation sketch (TS host)

```ts
function host_call(fn_id, req_ptr, req_len, resp_ptr, resp_cap) {
  try {
    fn_id >>>= 0;
    req_ptr >>>= 0;
    req_len >>>= 0;
    resp_ptr >>>= 0;
    resp_cap >>>= 0;

    const mem = new Uint8Array(memory.buffer);
    if (req_ptr > mem.byteLength || req_len > mem.byteLength - req_ptr) {
      return 0xffffffff;
    }
    if (resp_ptr > mem.byteLength || resp_cap > mem.byteLength - resp_ptr) {
      return 0xffffffff;
    }
    const req = mem.subarray(req_ptr, req_ptr + req_len);
    const resp = dispatchToManifestFunction(fn_id, req); // returns Uint8Array DV envelope
    if (resp.length > resp_cap) return 0xffffffff;
    mem.subarray(resp_ptr, resp_ptr + resp.length).set(resp);
    return resp.length >>> 0;
  } catch {
    return 0xffffffff;
  }
}
```

`dispatchToManifestFunction` is responsible for DV decode/encode, manifest limit checks, and producing the envelope (Ok/Err) defined in `docs/abi-manifest.md`. The VM side will DV-decode the bytes and map manifest error codes to deterministic `HostError` tags.

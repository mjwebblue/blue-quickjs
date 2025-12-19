# ABI limits explained

This doc explains the **limits** used in the Host ABI: what they mean, where they are enforced, and why they exist.

For the normative schema and validation rules, see:
- [ABI manifest](./abi-manifest.md)
- [Host call ABI](./host-call-abi.md)
- [DV wire format](./dv-wire-format.md)

This document is intentionally more explanatory (developer-oriented) than the spec docs.

---

## Two layers of limits

There are *two* distinct limit layers in this repo:

### 1) Global DV limits (hard caps)

DV encoding/decoding has hard caps to prevent pathological values that would otherwise cause:

- huge allocations,
- deep recursion,
- long decoding times.

These are part of the DV contract and apply everywhere DV is used.

Reference: [DV wire format](./dv-wire-format.md) (Limits section).

### 2) Per-function ABI limits (manifest policy)

Every host function in the manifest can additionally specify limits that bound each call:

- `max_request_bytes`
- `max_response_bytes`
- `max_units`
- `arg_utf8_max` (optional, per-arg)

These exist even though DV already has global caps, because different host functions have very different “safe” input/output shapes.

Reference: [ABI manifest](./abi-manifest.md) (Function entries / limits).

---

## The per-function limits

### `max_request_bytes`

**What it is:**  
Maximum number of bytes in the DV-encoded **args array** sent to the host.

**Where it is enforced:**
- **VM-side**: before executing the host call, the VM DV-encodes the args array. If the encoded byte length exceeds `max_request_bytes`, the call is rejected deterministically *before* invoking the host.
- **Host-side dispatcher**: also treats oversized requests as invalid / limit-exceeded (depending on whether `LIMIT_EXCEEDED` is declared).

**Why it exists:**
- Prevents the host from needing to decode arbitrarily large payloads.
- Makes “size of request” a clear part of the ABI contract.
- Helps keep worst-case host memory/CPU bounded even if the VM had a high gas limit.

**Design choice:** request size limits are about **host safety**, not VM gas. Gas is still charged (pre-charge) based on `request_bytes`; the limit is an additional hard stop.

**Related docs:** [Host call ABI](./host-call-abi.md), [Gas schedule](./gas-schedule.md).

---

### `max_response_bytes`

**What it is:**  
Maximum number of bytes in the DV-encoded **response envelope** returned by the host.

**Where it is enforced:**
- **VM-side**:
  - The VM passes `resp_capacity = max_response_bytes` to `host_call`.
  - If the host returns more bytes than capacity, that is a **transport-level ABI violation**.
  - The VM also DV-decodes and validates the envelope; malformed/invalid envelopes are deterministic host errors.
- **Host-side dispatcher**:
  - Ensures the response it encodes fits into the provided `resp_capacity`.
  - If it can’t fit, it should return a deterministic “limit exceeded” envelope *if and only if* the manifest declares an error code for it.

**Why it exists:**
- Prevents the VM from needing to accept arbitrarily large data from the host.
- Avoids ambiguous behavior where the host could “stream” more data than expected.
- Makes memory planning explicit: a larger `max_response_bytes` means more peak buffer space needed per call.

**Important subtlety:**  
In this implementation, the VM uses a per-context response buffer sized for `max_response_bytes`. Choosing very large `max_response_bytes` values increases memory pressure in the VM. Keep these values tight.

**Related docs:** [Host call ABI](./host-call-abi.md), [DV wire format](./dv-wire-format.md).

---

### `max_units`

**What it is:**  
Maximum allowed value of the host-reported `units` field in response envelopes.

**Where it is enforced:**
- **VM-side**: after decoding the response envelope, the VM checks `units <= max_units`. If violated, the response is invalid relative to the manifest.
- **Host-side dispatcher**: should enforce this when it receives a handler result (or when it computes units itself). If a handler returns too-large units, the dispatcher can return a “limit exceeded” envelope (if the manifest supports it).

**Why it exists:**
- `units` participates in gas charging (`k_units * units`). Unbounded units would allow:
  - overflow / undefined billing behavior,
  - host bugs that accidentally make calls “impossibly expensive”.
- Makes the “work signal” from host explicit and bounded.

**Design choice:**  
`max_units` is a policy decision per function. Some functions may legitimately need `max_units = 0` (meaning “this call must always report 0 units”).

**Related docs:** [ABI manifest](./abi-manifest.md), [Gas schedule](./gas-schedule.md).

---

### `arg_utf8_max`

**What it is:**  
An optional per-argument maximum length for **string** arguments, measured in **UTF‑8 byte length**.

Example: `arg_utf8_max: [2048]` means “this function has arity 1, and its only argument must be a string of at most 2048 UTF‑8 bytes”.

**Where it is enforced:**
- **VM-side**: in the generated `Host.v1.*` wrapper before encoding the request. This avoids work (and avoids calling the host) when arguments are clearly out of bounds.
- **Host-side dispatcher**: enforces it too for defense-in-depth (and because the host may be used with other clients).

**Why it exists (even though `max_request_bytes` exists):**
- It is much clearer and more stable to bound *each string argument* (e.g. a document path) than to rely on the total request size.
- It prevents a single huge string from consuming most of the request budget and/or causing host-side hot paths (e.g. filesystem-like path parsing) to behave unexpectedly.

**Design choices:**
- The limit is measured in **UTF‑8 bytes**, not JS code points. This matches what crosses the ABI (bytes) and is stable across runtimes.
- If present, `arg_utf8_max.length` must equal the manifest function’s arity, so the rule is unambiguous.

**Related docs:** [ABI manifest](./abi-manifest.md), [Host call ABI](./host-call-abi.md).

---

## DV global limits (hard caps)

DV uses a single shared default limits profile across the repo (both the C implementation in QuickJS and the TS reference codec).

The default DV limits are:

- `maxDepth`: **64**
- `maxEncodedBytes`: **1,048,576** (1 MiB)
- `maxStringBytes`: **262,144** (256 KiB)
- `maxArrayLength`: **65,535**
- `maxMapLength`: **65,535**

These caps apply anywhere DV is encoded/decoded.

Reference (canonical): [DV wire format](./dv-wire-format.md).

**Why there are both DV caps and ABI caps:**
- DV caps protect the codec and prevent “format-level” worst cases.
- ABI caps express *per-capability policy* (what a particular host call should accept/return).

---

## Other relevant limits (implementation details)

These are not per-function manifest fields, but they matter for the “shape” of the system and show up as hard caps in the VM:

- **Max manifest bytes**: **1,048,576** (1 MiB)
- **Max context blob bytes**: **1,048,576** (1 MiB)
- **Host-call tape capacity**: max **1,024** records (bounded ring buffer)
- **Wasm memory configuration** (build-time):
  - initial/maximum wasm memory: **33,554,432** bytes (32 MiB)
  - wasm stack size: **1,048,576** bytes (1 MiB)
  - memory/table growth disabled (fixed sizing)

Reference docs:
- Build/runtime caps: [Determinism profile](./determinism-profile.md), [Toolchain](./toolchain.md)
- Tape: [Observability](./observability.md), [Host call ABI](./host-call-abi.md)

---

## The initial Host.v1 limits (what we chose and why)

The repo includes a Host.v1 fixture manifest used by tests and smoke apps. The specific numbers are **policy**, not DV law, but they are important because they become part of the pinned ABI surface.

This is the intent behind the initial choices:

### `document.get(path)` and `document.getCanonical(path)`

- `arg_utf8_max: [2048]`
  - A path-like identifier should be small; 2 KiB is generous while still bounding worst cases.
- `max_request_bytes: 4096`
  - Leaves headroom for DV encoding overhead while still keeping requests “small”.
- `max_response_bytes: 262144` (256 KiB)
  - Chosen to align with the DV default max string size and allow moderately sized documents without enabling multi‑MB transfers.
- `max_units: 1000`
  - Keeps “document read work” bounded even if units are tied to content size or number of internal operations.

### `emit(value)` (Host side-effect)

- `max_request_bytes: 32768` (32 KiB)
  - Emissions may legitimately carry more data than a simple path string, but still need a hard cap.
- `max_response_bytes: 64`
  - `emit` returns `null` in the “ok” case plus `units`, so the response should stay tiny.
- `max_units: 1024`
  - Keeps the “work signal” bounded. In a real host, units might be proportional to bytes emitted or downstream work.

If you want to change these values, treat it as an **ABI policy change** and consult the compatibility rules in [Release policy](./release-policy.md).

---

## Practical guidance for adding new host functions

When you design a new host function, start by choosing limits intentionally:

1. Decide whether arguments should be strings with `arg_utf8_max` (common for IDs/paths).
2. Choose `max_request_bytes` to bound total DV request size.
3. Choose `max_response_bytes` to bound the largest response you want the VM to accept.
4. Define `units` meaning, pick `max_units`, and select a gas multiplier `k_units`.
5. Decide if the function should support a “limit exceeded” error code (so the host can respond deterministically when it can’t fit a response or must reject oversized inputs).

Then implement the handler and update fixtures/tests.

References:
- Manifest rules: [ABI manifest](./abi-manifest.md)
- Transport details: [Host call ABI](./host-call-abi.md)
- Host-call gas billing: [Gas schedule](./gas-schedule.md)
- Compatibility: [Release policy](./release-policy.md)


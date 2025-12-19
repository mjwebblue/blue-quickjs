# Observability: host-call tape and gas trace

Deterministic runtimes can’t rely on “normal” debugging patterns:

- printing/logging can be nondeterministic (timing, ordering, host differences),
- stack traces often include host-specific details,
- performance counters may differ between Node and browsers.

This repo therefore provides **deterministic observability** tools that are safe to use in golden tests and reproducibility checks:

1. **Host-call tape** (per-call audit records)
2. **Gas trace** (aggregate VM gas attribution)

These tools are optional and are enabled by the TypeScript SDK (see [SDK usage](./sdk.md)).

---

## Host-call tape

### What it is

The tape is a **bounded ring buffer** in the VM that records information about each successful host call:

- which function was called (`fnId`)
- sizes (`reqLen`, `respLen`)
- the host-reported `units`
- the computed gas breakdown (`gasPre`, `gasPost`)
- whether the response was an `err` envelope (`isError`)
- whether post-charging failed (`chargeFailed`)
- SHA-256 hashes of the encoded request/response bytes (`reqHash`, `respHash`)

The tape is designed for:

- determinism auditing (compare hashes and sizes across environments),
- debugging “which host call caused this failure?”,
- producing stable regression fixtures.

Normative details: the tape section in [Host call ABI](./host-call-abi.md).

### How to enable it

In the TS SDK:

- `evaluate({ ..., tape: { capacity: N } })`
- or (lower-level) `vm.enableTape(N)` via `initializeDeterministicVm`

See: [SDK usage](./sdk.md).

Capacity notes:
- `capacity = 0` disables recording.
- Capacity is bounded by a VM maximum (to prevent unbounded memory growth). See [Host call ABI](./host-call-abi.md).

### What exactly gets recorded (and when)

A tape record is appended **after**:

1. the host call returns,
2. the VM successfully parses the DV response envelope,
3. the VM attempts the post-charge.

Implications:

- **Pre-charge OOG**: no host call occurs, so there is no tape record.
- **Transport errors** (host returned sentinel or overran capacity): no record is appended.
- **Envelope invalid** (response is not a valid envelope): no record is appended.
- **Post-charge OOG**: a record *is appended* with `chargeFailed = true`, then the VM throws OutOfGas.

This design prioritizes “records represent real host executions” over “record every attempt”.

### Interpreting the fields

Note on types:
- `gasPre` and `gasPost` are 64-bit values in the VM. When serialized to JSON, they are emitted as **decimal strings** (so they are not truncated by JS number limits). The TS SDK parses them into `bigint`.
- `reqHash` and `respHash` are SHA‑256 digests serialized as **lowercase hex**.

- `gasPre`: best-effort computed as `base + k_arg_bytes * reqLen` (see [Gas schedule](./gas-schedule.md)).
- `gasPost`: best-effort computed as `k_ret_bytes * respLen + k_units * units`.
- `chargeFailed`:
  - `false` means post-charge was applied successfully.
  - `true` means the VM could not apply the post-charge (commonly OutOfGas, or an overflow guard).
- `isError`:
  - `true` means the envelope contained `err` (a HostError path).
  - `false` means the envelope contained `ok`.

- `reqHash` / `respHash`:
  - SHA-256 of the encoded request/response bytes.
  - The tape intentionally stores hashes (not the full payload) to keep memory small and avoid leaking large blobs.

### Practical debugging patterns

- **Compare tapes across environments** (Node vs browser): differences usually mean host behavior isn’t deterministic, or the VM/manifest version differs.
- **Find the last host call before OOG**: look for the final record with `chargeFailed=true` (or simply the last record if the run failed immediately after a call).
- **Spot response bloat**: check `respLen` against `max_response_bytes` policies; huge responses often indicate “host is returning too much”.

---

## Gas trace

### What it is

Gas trace is an optional aggregate attribution structure recorded inside the VM. It helps answer:

- “Was gas used mostly on opcodes, allocations, or builtin array callbacks?”
- “Why did two scripts with the same output cost different gas?”

It reports totals for:

- opcode count and opcode gas
- array callback “base” charges and per-element charges
- allocation count, allocation bytes, and allocation gas

Normative details: [Gas schedule](./gas-schedule.md) (Gas trace section).

### How to enable it

In the TS SDK:

- `evaluate({ ..., gasTrace: true })`

Or (lower-level):

- `vm.enableGasTrace(true)` and then `vm.readGasTrace()`.

See: [SDK usage](./sdk.md).

### What it does *not* include

The trace does **not** include host-call gas. Host calls are billed against the VM gas counter, but they are accounted separately.

If you want to estimate host-call gas from an `EvaluateResult` that includes a trace:

```
hostCallGas ≈ gasUsed - (opcodeGas + arrayCbGas + allocationGas + gcCheckpointGas)
```

The exact accounting and the checkpoint behavior are described in [Gas schedule](./gas-schedule.md).

### Interpreting trace output

Typical interpretations:

- High `allocationBytes` / `allocationGas`: code is allocation-heavy (large strings/arrays/maps, repeated concatenations, etc.).
- High `arrayCb*`: code is using `.map/.filter/.reduce`-style builtins (metered because they run loops in C).
- High `opcodeGas`: code is mostly “pure interpreter steps” (loops, arithmetic, property access).

---

## A note on determinism and traces

Both tape and gas trace are designed to be deterministic **given**:

- the same program `P`,
- the same input `I`,
- the same gas limit `G`,
- the same manifest,
- and a deterministic host implementation.

They are safe to include in golden tests and reproducibility baselines (see fixtures in `libs/test-harness`).

---

## See also

- [SDK usage](./sdk.md) (how to turn these on)
- [Host call ABI](./host-call-abi.md) (tape details and ABI mechanics)
- [Gas schedule](./gas-schedule.md) (what is metered and trace semantics)
- [Implementation summary](./implementation-summary.md) (how it all fits together)


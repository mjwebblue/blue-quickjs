# Gas Schedule (Baseline #1)

Scope: define canonical gas units for QuickJS execution and host calls per Baseline #1. This document is normative and must match harness assertions.

## Gas version and limits

- `JS_GAS_VERSION_LATEST = 1`
- Gas amounts are uint64.
- `JS_GAS_UNLIMITED` disables charging and reports gas used as 0.
- `JS_UseGas` subtracts from `gas_remaining`; if `amount > gas_remaining`, it sets `gas_remaining = 0` and throws an uncatchable `OutOfGas: out of gas` error.

## Opcode gas

- Every bytecode opcode defined in `quickjs-opcode.h` costs `1` gas per dispatch.
- Temporary or unknown opcodes (outside `OP_COUNT`) cost `0`.

## Builtin callback gas

The following array methods charge deterministic callback gas: `every`, `some`, `forEach`, `map`, `filter`, `reduce`, `reduceRight` (including typed arrays).

Charges:

- Base: `JS_GAS_ARRAY_CB_BASE = 5` once per call, before the loop starts.
- Per element: `JS_GAS_ARRAY_CB_PER_ELEMENT = 2` before each element is processed.

The per-element charge is applied for each iteration step, even when a hole is skipped or a callback returns early.

## Allocation gas

Each allocation charges:

- Base: `JS_GAS_ALLOC_BASE = 3`
- Byte charge: `1` gas per `16` requested bytes (`JS_GAS_ALLOC_PER_BYTE_SHIFT = 4`)

Formula:

- `JS_GAS_ALLOC_BASE + ceil(size / 16)` where `size` is the requested allocation size.

## Garbage collection (GC) checkpoints

- Automatic GC heuristics are disabled in deterministic mode (`js_trigger_gc` is a no-op and GC threshold is set to `-1`).
- A deterministic counter tracks requested allocation bytes. When it reaches `JS_DET_GC_THRESHOLD_BYTES = 512 * 1024`, `det_gc_pending` is set.
- `JS_RunGCCheckpoint(ctx)` runs GC only when `det_gc_pending` is set; it then clears the flag and counter.
- GC costs `0` gas; allocation gas amortizes it.
- Checkpoints are invoked at deterministic points (pre/post eval and around host calls).

## Host-call gas (Baseline #2)

Host-call gas uses parameters from the ABI manifest `gas` fields (see `docs/abi-manifest.md`).

- Pre-charge before the host call:
  - `gas_pre = base + (k_arg_bytes * request_bytes)`
- Post-charge after response parse:
  - `gas_post = (k_ret_bytes * response_bytes) + (k_units * units)`

Where:

- `request_bytes` is the encoded DV args array.
- `response_bytes` is the encoded DV response envelope.

Overflow during charge throws `TypeError: host_call gas overflow`. OOG on pre-charge aborts before the host call executes; OOG on post-charge aborts after response parse with host effects already applied.

## Gas trace (optional)

- `JS_EnableGasTrace` reports aggregate counts for opcode gas, array callback gas, and allocation gas.
- Host-call gas is billed but not included in the trace totals; tests compute host gas as `gasUsed - (opcode + array + allocation)`.

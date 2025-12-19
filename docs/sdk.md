# TypeScript SDK usage

This doc explains how to use the TypeScript runtime SDK (`libs/quickjs-runtime`) to run deterministic QuickJS-in-Wasm programs with:

- a manifest-locked Host ABI
- deterministic DV inputs/outputs
- deterministic gas metering
- optional tape + gas trace

Conceptual overview: [Implementation summary](./implementation-summary.md).  
ABI and DV specs: [Baseline #2](./baseline-2.md), [ABI manifest](./abi-manifest.md), [Host call ABI](./host-call-abi.md), [DV wire format](./dv-wire-format.md).

---

## Quick start: `evaluate()`

The easiest path is the one-shot convenience API:

```ts
import { evaluate } from '@blue-quickjs/quickjs-runtime';
import { HOST_V1_MANIFEST } from '@blue-quickjs/test-harness';

// Your program artifact (code + ABI pinning metadata)
const program = {
  abiId: 'Host.v1',
  abiVersion: 1,
  abiManifestHash: '…', // sha256(hex) of canonical manifest bytes
  code: `
    const doc = document('path/to/doc');
    emit({ type: 'seen', path: doc.path });
    doc
  `,
};

// Your deterministic input envelope
const input = {
  event: { type: 'example', payload: { id: 42 } },
  eventCanonical: { type: 'example', payload: { id: 42 } },
  steps: [{ name: 'start', status: 'done' }],
};

// Your host implementation (handlers matching the manifest)
const handlers = {
  document: {
    get: (path: string) => ({ ok: { path }, units: 1 }),
    getCanonical: (path: string) => ({ ok: { path }, units: 1 }),
  },
  emit: (value: unknown) => ({ ok: null, units: 1 }),
};

const result = await evaluate({
  program,
  input,
  gasLimit: 50_000n,
  manifest: HOST_V1_MANIFEST,
  handlers,

  // Optional:
  tape: { capacity: 32 },
  gasTrace: true,
});

if (!result.ok) {
  console.error(result.error); // stable code/tag/message model
  process.exit(1);
}

console.log('DV value:', result.value);
console.log('gas used:', result.gasUsed.toString());
console.log('gas remaining:', result.gasRemaining.toString());
```

### What you get back

`evaluate()` returns a structured `EvaluateResult`:

- On success: `{ ok: true, value, gasUsed, gasRemaining, raw, tape?, gasTrace? }`
- On failure:
  - VM error: `{ ok: false, type: 'vm-error', error: {kind, code, tag, ...}, gasUsed, gasRemaining, raw, tape?, gasTrace? }`
  - Invalid output: `{ ok: false, type: 'invalid-output', error: {code:'INVALID_OUTPUT', ...}, ... }`

Stable error mapping is part of the baseline contract. See [Baseline #2](./baseline-2.md) and the runtime implementation in `libs/quickjs-runtime/src/lib/evaluate-errors.ts`.

---

## Inputs you must provide

### 1) Program artifact (`P`)

A program artifact is “code + ABI identity/pinning metadata”. The SDK validates:

- `abiId` (e.g. `"Host.v1"`)
- `abiVersion` (integer)
- `abiManifestHash` (lowercase hex)
- `code` (string)

Some environments also provide `engineBuildHash` pinning; if present, the SDK checks that the wasm runtime build hash matches.

Optional fields:

- `engineBuildHash` (lowercase hex; sha256 of the wasm bytes)

Program artifact limits (validation defaults used by `evaluate()` and `initializeDeterministicVm()`):

- `maxCodeUnits`: 1,048,576 UTF-16 code units (string length of `code`); caps the source size before any VM work begins.
- `maxAbiIdLength`: 128; bounds the ABI identifier string length.

Why these limits exist:

- **Deterministic failure**: reject oversized or malformed artifacts before VM init, so errors are consistent across runtimes.
- **Resource safety**: bound untrusted inputs to avoid large allocations or expensive parsing before gas metering applies.
- **Defensive surface**: keep metadata (ABI ids, hashes) within sane bounds and avoid abuse like huge inputs.

The hash pinning rules are described in:
- [ABI manifest](./abi-manifest.md) (canonical encoding + hash)
- [Release policy](./release-policy.md)

### 2) Input envelope (`I`)

The input envelope is DV-encodable data injected into the VM as ergonomic globals.

The canonical shape used by this repo’s fixtures includes:

- `event`
- `eventCanonical`
- `steps`

Additional keys are rejected by validation; the input envelope is limited to the event payloads + steps that are injected as ergonomic globals.

Reference: [Determinism profile](./determinism-profile.md) (Injected globals).

---

## Manifests and handlers

### Manifest

The manifest describes the ABI surface and is used by:

- the VM (to install `Host.v1.*` wrappers and enforce limits/gas/errors),
- the host dispatcher (to decode requests and validate responses).

Spec: [ABI manifest](./abi-manifest.md).

### Handlers

Handlers are your host implementation of the manifest.

In the default Host.v1 shape, handlers look like:

- `document.get(path: string) → { ok: DV, units } | { err: HostError, units }`
- `document.getCanonical(path: string) → …`
- `emit(value: DV) → { ok: null, units } | { err: HostError, units }`

(Exact shape depends on your manifest.)

Host call mechanics: [Host call ABI](./host-call-abi.md).

---

## Limits and how they surface

The manifest defines per-function limits like `max_request_bytes`, `max_response_bytes`, `max_units`, and `arg_utf8_max`.

- Some limit violations are rejected **before** the host call (e.g., `arg_utf8_max`).
- Others are rejected **after** the host call (e.g., response too big).
- Some hosts can respond with a deterministic “limit exceeded” error envelope if the manifest declares an error code for it.

Explanatory guide: [ABI limits explained](./abi-limits.md).

---

## Gas and metering

You provide `gasLimit` as a bigint or number.

Gas accounting is performed inside the VM:

- interpreter steps, allocations, selected builtins, GC checkpoints
- host-call gas derived from manifest parameters

Spec: [Gas schedule](./gas-schedule.md).

If execution runs out of gas, the VM throws an uncatchable OutOfGas error. In the `EvaluateResult`, this maps to `{ kind: 'out-of-gas', code:'OOG', tag:'vm/out_of_gas' }`.

---

## Optional debugging / observability

### Host-call tape

Enable with:

```ts
tape: { capacity: 128 } // default is 128 when enabled; max is 1024
```

The result will include `result.tape` (array of host-call records).

### Gas trace

Enable with:

```ts
gasTrace: true
```

The result will include `result.gasTrace` (aggregate counters).

Details: [Observability](./observability.md).

---

## Advanced usage: reuse a runtime and/or VM

### Reuse the wasm runtime (recommended)

If you need to run many programs, you can reuse a loaded runtime (wasm instance) and create fresh VMs:

```ts
import { createRuntime, initializeDeterministicVm } from '@blue-quickjs/quickjs-runtime';

const runtime = await createRuntime({ manifest, handlers });

for (const job of jobs) {
  const vm = initializeDeterministicVm(runtime, job.program, job.input, job.gasLimit);
  try {
    const raw = vm.eval(job.program.code);
    // parse raw or use evaluate() if you want structured results
  } finally {
    vm.dispose();
  }
}
```

### Reuse the same VM context (only if you want persistent state)

You can call `vm.eval()` multiple times without re-initializing. This can be useful for:

- benchmarks,
- REPL-like usage,
- workflows where persistent global state is desired.

But remember:
- global mutations persist,
- gas determinism depends on running the same code in the same state.

See the gas sample fixtures in `libs/test-harness` for examples.

---

## See also

- [Implementation summary](./implementation-summary.md)
- [Determinism profile](./determinism-profile.md)
- [Host call ABI](./host-call-abi.md)
- [ABI manifest](./abi-manifest.md)
- [DV wire format](./dv-wire-format.md)
- [Gas schedule](./gas-schedule.md)

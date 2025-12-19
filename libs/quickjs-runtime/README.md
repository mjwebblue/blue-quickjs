# @blue-quickjs/quickjs-runtime

TypeScript runtime SDK for **deterministic QuickJS-in-Wasm** evaluation with:

- manifest-locked Host ABI (`host_call`)
- Deterministic Value (DV) boundary encoding
- deterministic gas metering
- optional host-call tape + gas trace

If you are looking for the conceptual architecture and contracts, start with:
- `docs/README.md`
- `docs/implementation-summary.md`

---

## Quick start

```ts
import { evaluate } from '@blue-quickjs/quickjs-runtime';
import { HOST_V1_MANIFEST, HOST_V1_HASH } from '@blue-quickjs/test-harness';

const result = await evaluate({
  program: {
    code: '(() => 1 + 2)()',
    abiId: 'Host.v1',
    abiVersion: 1,
    abiManifestHash: HOST_V1_HASH,
  },
  input: {
    event: { type: 'example' },
    eventCanonical: { type: 'example' },
    steps: [],
  },
  gasLimit: 50_000n,
  manifest: HOST_V1_MANIFEST,
  handlers: {
    document: {
      get: (path: string) => ({ ok: { path }, units: 1 }),
      getCanonical: (path: string) => ({ ok: { canonical: path }, units: 1 }),
    },
    emit: (value: unknown) => ({ ok: null, units: 1 }),
  },

  // Optional observability:
  tape: { capacity: 32 },
  gasTrace: true,
});

if (!result.ok) {
  throw new Error(result.error.message);
}

console.log(result.value, result.gasUsed, result.gasRemaining);
```

---

## Docs

- SDK guide: `docs/sdk.md`
- Implementation overview: `docs/implementation-summary.md`
- ABI + DV reference:
  - `docs/baseline-2.md`
  - `docs/abi-manifest.md`
  - `docs/host-call-abi.md`
  - `docs/dv-wire-format.md`
- Gas:
  - `docs/baseline-1.md`
  - `docs/gas-schedule.md`
- Limits:
  - `docs/abi-limits.md`
- Observability:
  - `docs/observability.md`

---

## Building / testing

This library is part of an Nx workspace.

- Build: `pnpm nx build quickjs-runtime`
- Test: `pnpm nx test quickjs-runtime`


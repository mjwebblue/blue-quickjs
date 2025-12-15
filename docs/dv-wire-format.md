# DV Wire Format (Baseline #2)

Scope: normative description of the deterministic value (DV) encoding/decoding rules per Baseline #2 (e.g., §1.4, §6.4).

## Decision (T-030)
- DV is encoded as a deterministic subset of CBOR (RFC 8949) using only definite-length items and no tags.
- Allowed types match the JS surface available in the deterministic VM: `null`, `boolean`, `number`, UTF-8 text strings, arrays, and objects (maps with string keys). Byte strings, typed arrays, and user-defined extensions are not part of DV.
- Encoding is canonical and stable across environments so both the TS (`libs/dv`) and C (QuickJS fork) implementations can compare bytes directly.

## Canonical type set
- `null` → CBOR simple value 22 (`0xf6`).
- `boolean` → simple value 20/21 (`0xf4`/`0xf5`).
- `number` → finite only. Encode integers with CBOR major types 0/1 (unsigned/negative) using the shortest length; encode non-integers as float64 (`0xfb <ieee754-be>`). Reject `NaN`, `±Inf`, and canonicalize `-0` to `0`.
- `string` → CBOR text (major type 3) with a definite length; payload must be well-formed UTF-8 (no lone surrogates). No normalization is applied; bytes are preserved.
- `array` → CBOR array (major type 4) with a definite element count; element order is preserved.
- `object` → CBOR map (major type 5) with a definite entry count; keys must be text strings, unique, and sorted by the deterministic CBOR key ordering (shorter encoded keys first, then bytewise lexicographic).

Forbidden: CBOR tags (`0xc0`…), indefinite lengths (`0x5f/0x7f/0x9f/0xbf`), simple values other than null/booleans, `undefined`, half/float32 encodings, byte strings, and any value that violates the numeric rules above.

## Encoding rules and limits
- **Endianness:** Follow CBOR: integer lengths are big-endian; float64 is IEEE 754 big-endian.
- **Integers:** Accept only integers in `[-2^53 + 1, 2^53 - 1]`. Use the shortest additional-info width (0–23 inline, 24→uint8, 25→uint16, 26→uint32, 27→uint64). Negative integers use major type 1 with the `-1 - n` convention.
- **Floats:** Only float64 (`0xfb`). Encode `+0` as the unsigned integer zero form, not as a float. Reject payloads that round-trip to `NaN`/`±Inf`/`-0`.
- **Strings:** Length is the UTF-8 byte length. Reject invalid UTF-8 and strings whose encoded byte length exceeds the limit.
- **Arrays/objects:** Length is the element count/entry count, not byte length. Map keys are text only; reject duplicates and out-of-order keys. A map’s key order is determined by the deterministic CBOR ordering of the key encodings (length-first, then bytewise).
- **Depth/size limits (global defaults):**
  - Maximum container nesting depth: 64 (arrays/maps increment depth).
  - Maximum encoded byte length of a single DV value: 1 MiB.
  - Maximum string byte length: 256 KiB.
  - Maximum array items: 65,535; maximum map entries: 65,535.
  - Implementations may impose stricter per-call limits (e.g., manifest-bound request/response sizes) but must not exceed these without an explicit opt-in.
- **Error handling:** Any violation (forbidden type, bad UTF-8, NaN/Inf, limits exceeded, unsorted/duplicate keys, non-canonical integer width) is a deterministic DV-format error.

## Encoding examples
(Hex is contiguous CBOR encoding.)

- `null` → `f6`
- `true` → `f5`
- `-1` → `20`
- `["hello", 1.5]` → `82 65 68 65 6c 6c 6f fb 3f f8 00 00 00 00 00 00`
- `{ "ok": true }` → `a1 62 6f 6b f5`
- `{ "b": 2, "aa": 1 }` (note length-first key ordering) → `a2 61 62 02 62 61 61 01`

## Interop notes
- Manifest serialization (T-033) and host-call envelopes (T-039) use the same DV canonicalization rules.
- `canon.unwrap`/`canon.at` operate on decoded DV values and must not create out-of-domain types; re-encoding must be byte-identical if the value is unchanged.

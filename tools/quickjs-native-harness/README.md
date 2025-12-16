# quickjs-native-harness

Minimal native harness for the QuickJS fork. Builds a standalone binary that evaluates a JS string and returns deterministic output (`RESULT <json>` or `ERROR <message>`).

## Usage
- Build: `pnpm nx build quickjs-native-harness`
- Test: `pnpm nx test quickjs-native-harness`
- Manual run: `tools/quickjs-native-harness/dist/quickjs-native-harness --eval "1 + 2"`
- Gas goldens: `tools/quickjs-native-harness/scripts/gas-goldens.mjs` consumes fixtures under
  `tools/quickjs-native-harness/fixtures/gas` and is invoked by the test script.
- Manifest validation: pass `--abi-manifest-hex <hex>` (or `--abi-manifest-hex-file <path>`) and
  `--abi-manifest-hash <sha256-hex>` to initialize the VM with a pinned ABI manifest. An optional
  `--context-blob-hex <hex>` can be provided for future context blobs.
- SHA helper: `--sha256-hex <hex>` prints the SHA-256 digest for the provided hex bytes (handy for
  cross-checking vectors).

Notes:
- Uses the fork's deterministic init (`JS_NewDeterministicRuntime`): global scope excludes `Date`, `eval`, `Function`, `Proxy`, `RegExp`, typed arrays, `Promise`/`WeakRef` and reserves a null-prototype `Host.v1` placeholder.
- Build artifacts live under `tools/quickjs-native-harness/dist`.

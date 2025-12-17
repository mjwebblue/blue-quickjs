#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"
BIN="${REPO_ROOT}/tools/quickjs-native-harness/dist/quickjs-native-harness"

# Ensure build is present.
"${SCRIPT_DIR}/build.sh" >/dev/null

HOST_MANIFEST_HEX="$(tr -d '\r\n' < "${REPO_ROOT}/libs/test-harness/fixtures/abi-manifest/host-v1.bytes.hex")"
HOST_MANIFEST_HASH="$(tr -d '\r\n' < "${REPO_ROOT}/libs/test-harness/fixtures/abi-manifest/host-v1.hash")"
COMMON_ARGS=(--abi-manifest-hex "${HOST_MANIFEST_HEX}" --abi-manifest-hash "${HOST_MANIFEST_HASH}")
BAD_MANIFEST_HASH="0000000000000000000000000000000000000000000000000000000000000000"
SHA_EMPTY="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
SHA_ABC="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
SHA_LONG="248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
HOST_ERR_ENVELOPE_HEX="a263657272a164636f6465694e4f545f464f554e4465756e69747303"
HOST_INVALID_ENVELOPE_HEX="a1626f6b01"
HOST_OK_ENVELOPE_HEX="a2626f6ba16576616c75656568656c6c6f65756e69747305"
HOST_UNITS_STRING_HEX="a2626f6b0165756e6974736135"
HOST_UNITS_FLOAT_HEX="a2626f6b0165756e697473fb3ff8000000000000"
HOST_ERR_CODE_NUMBER_HEX="a263657272a164636f6465187b65756e69747300"
HOST_UNITS_ZERO_HEX="a2626f6b0065756e69747300"
HOST_UNITS_ONE_HEX="a2626f6b0065756e69747301"
CONTEXT_BLOB_HEX="a3656576656e74a163666f6f01657374657073826273316273326e6576656e7443616e6f6e6963616ca163626172f5"

assert_output() {
  local name="$1"
  local code="$2"
  local expected="$3"
  shift 3

  local output
  output="$("${BIN}" "${COMMON_ARGS[@]}" "$@" --eval "${code}" || true)"

  if [[ "${output}" != "${expected}" ]]; then
    echo "Harness output mismatch for '${name}'" >&2
    echo " expected: ${expected}" >&2
    echo "   actual: ${output}" >&2
    exit 1
  fi
}

assert_host_call() {
  local name="$1"
  local expected="$2"
  shift 2

  local output
  output="$("${BIN}" "${COMMON_ARGS[@]}" "$@" || true)"

  if [[ "${output}" != "${expected}" ]]; then
    echo "Harness host_call mismatch for '${name}'" >&2
    echo " expected: ${expected}" >&2
    echo "   actual: ${output}" >&2
    exit 1
  fi
}

assert_sha() {
  local name="$1"
  local hex="$2"
  local expected="$3"

  local output
  output="$("${BIN}" --sha256-hex "${hex}" || true)"

  if [[ "${output}" != "${expected}" ]]; then
    echo "SHA mismatch for '${name}'" >&2
    echo " expected: ${expected}" >&2
    echo "   actual: ${output}" >&2
    exit 1
  fi
}

assert_reject() {
  local name="$1"
  shift
  if "${BIN}" "$@" >/dev/null 2>&1; then
    echo "Expected failure for '${name}', but command succeeded" >&2
    exit 1
  fi
}

host_descriptor_js="$(cat <<'EOF'
(() => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'Host');
  const v1 = Host && Host.v1;
  return {
    configurable: desc ? desc.configurable : null,
    enumerable: desc ? desc.enumerable : null,
    writable: desc ? desc.writable : null,
    hostType: typeof Host,
    v1Type: typeof v1,
    v1NullProto: v1 ? Object.getPrototypeOf(v1) === null : null
  };
})()
EOF
)"

capability_snapshot_js="$(cat <<'EOF'
(() => {
  const capture = (fn) => {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  };

  return {
    eval: capture(() => eval('1 + 1')),
    Function: capture(() => Function('return 1')()),
    RegExp: capture(() => new RegExp('a')),
    Proxy: capture(() => new Proxy({}, {})),
    Promise: capture(() => Promise.resolve(1)),
    MathRandom: capture(() => Math.random()),
    Date: capture(() => typeof Date),
    setTimeout: capture(() => typeof setTimeout),
    ArrayBuffer: capture(() => new ArrayBuffer(4)),
    SharedArrayBuffer: capture(() => new SharedArrayBuffer(4)),
    DataView: capture(() => new DataView()),
    Uint8Array: capture(() => new Uint8Array(4)),
    Atomics: capture(() => Atomics()),
    WebAssembly: capture(() => WebAssembly()),
    consoleLog: capture(() => console.log('x')),
    print: capture(() => print('x')),
    globalOrder: capture(() =>
      Object.getOwnPropertyNames(globalThis).filter(
        (n) => n === 'Host' || n === 'console' || n === 'print'
      )
    ),
    hostImmutable: capture(() => {
      const before = Host;
      Host = 123;
      const after = Host;
      const original = Host.v1.document.get;
      let added = false;
      try {
        Host.v1.added = 1;
        added = Object.prototype.hasOwnProperty.call(Host.v1, 'added');
      } catch (_) {
        added = false;
      }
      let overwrite = null;
      try {
        let threw = false;
        (() => {
          'use strict';
          try {
            Host.v1.document.get = () => 'pwn';
          } catch (_) {
            threw = true;
          }
        })();
        const desc = Object.getOwnPropertyDescriptor(Host.v1.document, 'get');
        overwrite = {
          same: Host.v1.document.get === original,
          threw,
          writable: desc ? desc.writable : null,
          configurable: desc ? desc.configurable : null
        };
      } catch (_) {
        overwrite = null;
      }
      return {
        sameRef: before === after,
        hasV1: !!after.v1,
        added,
        desc: Object.getOwnPropertyDescriptor(globalThis, 'Host'),
        protoNull: Object.getPrototypeOf(Host) === null,
        v1ProtoNull: Object.getPrototypeOf(Host.v1) === null,
        hostIsExtensible: Object.isExtensible(Host),
        hostV1Extensible: Object.isExtensible(Host.v1),
        overwrite
      };
    })
  };
})()
EOF
)"

ergonomic_globals_js="$(cat <<'EOF'
(() => {
  const docDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const canonicalDesc = Object.getOwnPropertyDescriptor(document, 'canonical');
  return {
    document: {
      value: document('foo'),
      canonical: document.canonical('bar'),
      desc: docDesc
        ? {
            writable: docDesc.writable,
            enumerable: docDesc.enumerable,
            configurable: docDesc.configurable
          }
        : null,
      canonicalDesc: canonicalDesc
        ? {
            writable: canonicalDesc.writable,
            enumerable: canonicalDesc.enumerable,
            configurable: canonicalDesc.configurable
          }
        : null,
      extensible: Object.isExtensible(document)
    },
    context: {
      event,
      eventCanonical,
      steps,
      frozen: {
        event: Object.isFrozen(event),
        eventCanonical: Object.isFrozen(eventCanonical),
        steps: Object.isFrozen(steps)
      }
    }
  };
})()
EOF
)"

canon_helpers_js="$(cat <<'EOF'
(() => {
  const value = canon.unwrap({ b: 2, a: { z: 9 } });
  return {
    keys: Object.keys(value),
    nested: canon.at(value, ['a', 'z']),
    missing: canon.at(value, ['missing']) ?? null,
    badPath: (() => {
      try {
        canon.at(value, 'oops');
        return 'no error';
      } catch (e) {
        return String(e);
      }
    })(),
    frozen: Object.isFrozen(value)
  };
})()
EOF
)"

assert_output "basic addition" "1 + 2" "RESULT 3"
assert_output "manifest hash mismatch" "1 + 1" "ERROR ManifestError: abi manifest hash mismatch" --abi-manifest-hash "${BAD_MANIFEST_HASH}"
assert_sha "sha256 empty" "" "SHA256 ${SHA_EMPTY}"
assert_sha "sha256 abc" "616263" "SHA256 ${SHA_ABC}"
assert_sha "sha256 long" "6162636462636465636465666465666765666768666768696768696a68696a6b696a6b6c6a6b6c6d6b6c6d6e6c6d6e6f6d6e6f706e6f7071" "SHA256 ${SHA_LONG}"
assert_reject "dv-decode with sha256" --dv-decode "a0" --sha256-hex "${SHA_EMPTY}"
assert_output "eval disabled" "eval('1 + 1')" "ERROR TypeError: eval is disabled in deterministic mode"
assert_output "Function disabled" "(new Function('return 7'))()" "ERROR TypeError: Function is disabled in deterministic mode"
assert_output "Function ctor via Function.prototype.constructor" "(() => { const RealFunction = (function () {}).constructor; return RealFunction('return 3')(); })()" "ERROR TypeError: Function constructor is disabled in deterministic mode"
assert_output "Function ctor via arrow constructor" "(() => { const RealFunction = (() => {}).constructor; return RealFunction('return 4')(); })()" "ERROR TypeError: Function constructor is disabled in deterministic mode"
assert_output "Function ctor via generator constructor" "(() => { const GenFunction = (function* () {}).constructor; return GenFunction('return 5')(); })()" "ERROR TypeError: Function constructor is disabled in deterministic mode"
assert_output "RegExp constructor disabled" "new RegExp('a')" "ERROR TypeError: RegExp is disabled in deterministic mode"
assert_output "RegExp literal disabled" "'abc'.match(/a/)" "ERROR TypeError: RegExp is disabled in deterministic mode"
assert_output "Proxy disabled" "new Proxy({}, {})" "ERROR TypeError: Proxy is disabled in deterministic mode"
assert_output "Math.random disabled" "Math.random()" "ERROR TypeError: Math.random is disabled in deterministic mode"
assert_output "ArrayBuffer disabled" "new ArrayBuffer(4)" "ERROR TypeError: ArrayBuffer is disabled in deterministic mode"
assert_output "SharedArrayBuffer disabled" "new SharedArrayBuffer(4)" "ERROR TypeError: SharedArrayBuffer is disabled in deterministic mode"
assert_output "DataView disabled" "new DataView()" "ERROR TypeError: DataView is disabled in deterministic mode"
assert_output "Typed arrays disabled" "new Uint8Array(4)" "ERROR TypeError: Typed arrays are disabled in deterministic mode"
assert_output "Atomics disabled" "Atomics()" "ERROR TypeError: Atomics is disabled in deterministic mode"
assert_output "WebAssembly disabled" "WebAssembly()" "ERROR TypeError: WebAssembly is disabled in deterministic mode"
assert_output "console disabled" "console.log('x')" "ERROR TypeError: console is disabled in deterministic mode"
assert_output "print disabled" "print('x')" "ERROR TypeError: print is disabled in deterministic mode"
assert_output "JSON.parse disabled" "JSON.parse('[]')" "ERROR TypeError: JSON.parse is disabled in deterministic mode"
assert_output "JSON.stringify disabled" "JSON.stringify({ a: 1 })" "ERROR TypeError: JSON.stringify is disabled in deterministic mode"
assert_output "Array.sort disabled" "[3, 1, 2].sort()" "ERROR TypeError: Array.prototype.sort is disabled in deterministic mode"
assert_output "Date missing" "typeof Date" "RESULT \"undefined\""
assert_output "Timers missing" "typeof setTimeout" "RESULT \"undefined\""
assert_output "Promise disabled" "Promise.resolve(1)" "ERROR TypeError: Promise is disabled in deterministic mode"
assert_output "queueMicrotask missing" "typeof queueMicrotask" "RESULT \"undefined\""
assert_output "Host descriptor" "${host_descriptor_js}" "RESULT {\"configurable\":false,\"enumerable\":false,\"writable\":false,\"hostType\":\"object\",\"v1Type\":\"object\",\"v1NullProto\":true}"
assert_output "capability snapshot" "${capability_snapshot_js}" "RESULT {\"eval\":{\"ok\":false,\"error\":\"TypeError: eval is disabled in deterministic mode\"},\"Function\":{\"ok\":false,\"error\":\"TypeError: Function is disabled in deterministic mode\"},\"RegExp\":{\"ok\":false,\"error\":\"TypeError: RegExp is disabled in deterministic mode\"},\"Proxy\":{\"ok\":false,\"error\":\"TypeError: Proxy is disabled in deterministic mode\"},\"Promise\":{\"ok\":false,\"error\":\"TypeError: Promise is disabled in deterministic mode\"},\"MathRandom\":{\"ok\":false,\"error\":\"TypeError: Math.random is disabled in deterministic mode\"},\"Date\":{\"ok\":true,\"value\":\"undefined\"},\"setTimeout\":{\"ok\":true,\"value\":\"undefined\"},\"ArrayBuffer\":{\"ok\":false,\"error\":\"TypeError: ArrayBuffer is disabled in deterministic mode\"},\"SharedArrayBuffer\":{\"ok\":false,\"error\":\"TypeError: SharedArrayBuffer is disabled in deterministic mode\"},\"DataView\":{\"ok\":false,\"error\":\"TypeError: DataView is disabled in deterministic mode\"},\"Uint8Array\":{\"ok\":false,\"error\":\"TypeError: Typed arrays are disabled in deterministic mode\"},\"Atomics\":{\"ok\":false,\"error\":\"TypeError: Atomics is disabled in deterministic mode\"},\"WebAssembly\":{\"ok\":false,\"error\":\"TypeError: WebAssembly is disabled in deterministic mode\"},\"consoleLog\":{\"ok\":false,\"error\":\"TypeError: console is disabled in deterministic mode\"},\"print\":{\"ok\":false,\"error\":\"TypeError: print is disabled in deterministic mode\"},\"globalOrder\":{\"ok\":true,\"value\":[\"console\",\"print\",\"Host\"]},\"hostImmutable\":{\"ok\":true,\"value\":{\"sameRef\":true,\"hasV1\":true,\"added\":false,\"desc\":{\"value\":{},\"writable\":false,\"enumerable\":false,\"configurable\":false},\"protoNull\":true,\"v1ProtoNull\":true,\"hostIsExtensible\":false,\"hostV1Extensible\":false,\"overwrite\":{\"same\":true,\"threw\":true,\"writable\":false,\"configurable\":false}}}}"
assert_output "ergonomic globals" "${ergonomic_globals_js}" "RESULT {\"document\":{\"value\":\"foo\",\"canonical\":\"bar\",\"desc\":{\"writable\":false,\"enumerable\":false,\"configurable\":false},\"canonicalDesc\":{\"writable\":false,\"enumerable\":false,\"configurable\":false},\"extensible\":false},\"context\":{\"event\":{\"foo\":1},\"eventCanonical\":{\"bar\":true},\"steps\":[\"s1\",\"s2\"],\"frozen\":{\"event\":true,\"eventCanonical\":true,\"steps\":true}}}" --context-blob-hex "${CONTEXT_BLOB_HEX}"
assert_output "Host.v1 document.get ok" "Host.v1.document.get('foo')" "RESULT \"foo\""
assert_output "Host.v1 document.getCanonical ok" "Host.v1.document.getCanonical('bar')" "RESULT \"bar\""
assert_output "Host.v1 emit" "Host.v1.emit({ a: 1 })" "RESULT null"
assert_output "Host.v1 document missing" "Host.v1.document.get('missing')" "ERROR HostError: host/not_found"
assert_output "Host.v1 document arg type" "Host.v1.document.get(123)" "ERROR TypeError: Host.v1.document.get argument 1 must be a string"
assert_output "Host.v1 document arg utf8 limit" "Host.v1.document.get('x'.repeat(2050))" "ERROR TypeError: Host.v1.document.get argument 1 exceeds utf8 limit (2050 > 2048)"
assert_output "canon helpers" "${canon_helpers_js}" "RESULT {\"keys\":[\"a\",\"b\"],\"nested\":9,\"missing\":null,\"badPath\":\"TypeError: canon.at path must be an array\",\"frozen\":true}" --context-blob-hex "${CONTEXT_BLOB_HEX}"
assert_host_call "host_call echo" "HOSTCALL 0a0b0c GAS remaining=100 used=0" --host-call "0a0b0c" --gas-limit 100 --report-gas
assert_host_call "host_call request limit" "ERROR TypeError: host_call request exceeds max_request_bytes" --host-call "010203" --host-max-request 2
assert_host_call "host_call response limit" "ERROR HostError: host/transport" --host-call "0a0b0c" --host-max-request 3 --host-max-response 2
assert_host_call "host_call reentrancy guard" "ERROR TypeError: host_call is already in progress" --host-call "aa" --host-reentrant
assert_host_call "host_call dispatcher exception" "ERROR TypeError: host stub exception" --host-call "aa" --host-exception
assert_host_call "host_call err envelope" "ERROR HostError: host/not_found" --host-call "${HOST_ERR_ENVELOPE_HEX}" --host-parse-envelope --host-max-units 10
assert_host_call "host_call envelope invalid" "ERROR HostError: host/envelope_invalid" --host-call "${HOST_INVALID_ENVELOPE_HEX}" --host-parse-envelope
assert_host_call "host_call units must be number" "ERROR HostError: host/envelope_invalid" --host-call "${HOST_UNITS_STRING_HEX}" --host-parse-envelope
assert_host_call "host_call units must be integer" "ERROR HostError: host/envelope_invalid" --host-call "${HOST_UNITS_FLOAT_HEX}" --host-parse-envelope
assert_host_call "host_call err.code must be string" "ERROR HostError: host/envelope_invalid" --host-call "${HOST_ERR_CODE_NUMBER_HEX}" --host-parse-envelope
assert_host_call "host_call max_units zero allowed" "HOSTRESP 0 UNITS 0" --host-call "${HOST_UNITS_ZERO_HEX}" --host-parse-envelope --host-max-units 0
assert_host_call "host_call units above max_units zero" "ERROR HostError: host/envelope_invalid" --host-call "${HOST_UNITS_ONE_HEX}" --host-parse-envelope --host-max-units 0
assert_host_call "host_call ok envelope" "HOSTRESP {\"value\":\"hello\"} UNITS 5" --host-call "${HOST_OK_ENVELOPE_HEX}" --host-parse-envelope --host-max-units 10

node "${SCRIPT_DIR}/gas-goldens.mjs"
node "${SCRIPT_DIR}/host-gas.mjs"
node "${SCRIPT_DIR}/dv-parity.mjs"

echo "quickjs-native-harness test passed"

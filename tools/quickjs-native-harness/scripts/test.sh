#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"
BIN="${REPO_ROOT}/tools/quickjs-native-harness/dist/quickjs-native-harness"

# Ensure build is present.
"${SCRIPT_DIR}/build.sh" >/dev/null

assert_output() {
  local name="$1"
  local code="$2"
  local expected="$3"
  shift 3

  local output
  output="$("${BIN}" "$@" --eval "${code}" || true)"

  if [[ "${output}" != "${expected}" ]]; then
    echo "Harness output mismatch for '${name}'" >&2
    echo " expected: ${expected}" >&2
    echo "   actual: ${output}" >&2
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
      let added = false;
      try {
        Host.v1.added = 1;
        added = Object.prototype.hasOwnProperty.call(Host.v1, 'added');
      } catch (_) {
        added = false;
      }
      return {
        sameRef: before === after,
        hasV1: !!after.v1,
        added,
        desc: Object.getOwnPropertyDescriptor(globalThis, 'Host'),
        protoNull: Object.getPrototypeOf(Host) === null,
        v1ProtoNull: Object.getPrototypeOf(Host.v1) === null,
        hostIsExtensible: Object.isExtensible(Host),
        hostV1Extensible: Object.isExtensible(Host.v1)
      };
    })
  };
})()
EOF
)"

assert_output "basic addition" "1 + 2" "RESULT 3"
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
assert_output "capability snapshot" "${capability_snapshot_js}" "RESULT {\"eval\":{\"ok\":false,\"error\":\"TypeError: eval is disabled in deterministic mode\"},\"Function\":{\"ok\":false,\"error\":\"TypeError: Function is disabled in deterministic mode\"},\"RegExp\":{\"ok\":false,\"error\":\"TypeError: RegExp is disabled in deterministic mode\"},\"Proxy\":{\"ok\":false,\"error\":\"TypeError: Proxy is disabled in deterministic mode\"},\"Promise\":{\"ok\":false,\"error\":\"TypeError: Promise is disabled in deterministic mode\"},\"MathRandom\":{\"ok\":false,\"error\":\"TypeError: Math.random is disabled in deterministic mode\"},\"Date\":{\"ok\":true,\"value\":\"undefined\"},\"setTimeout\":{\"ok\":true,\"value\":\"undefined\"},\"ArrayBuffer\":{\"ok\":false,\"error\":\"TypeError: ArrayBuffer is disabled in deterministic mode\"},\"SharedArrayBuffer\":{\"ok\":false,\"error\":\"TypeError: SharedArrayBuffer is disabled in deterministic mode\"},\"DataView\":{\"ok\":false,\"error\":\"TypeError: DataView is disabled in deterministic mode\"},\"Uint8Array\":{\"ok\":false,\"error\":\"TypeError: Typed arrays are disabled in deterministic mode\"},\"Atomics\":{\"ok\":false,\"error\":\"TypeError: Atomics is disabled in deterministic mode\"},\"WebAssembly\":{\"ok\":false,\"error\":\"TypeError: WebAssembly is disabled in deterministic mode\"},\"consoleLog\":{\"ok\":false,\"error\":\"TypeError: console is disabled in deterministic mode\"},\"print\":{\"ok\":false,\"error\":\"TypeError: print is disabled in deterministic mode\"},\"globalOrder\":{\"ok\":true,\"value\":[\"console\",\"print\",\"Host\"]},\"hostImmutable\":{\"ok\":true,\"value\":{\"sameRef\":true,\"hasV1\":true,\"added\":false,\"desc\":{\"value\":{},\"writable\":false,\"enumerable\":false,\"configurable\":false},\"protoNull\":true,\"v1ProtoNull\":true,\"hostIsExtensible\":false,\"hostV1Extensible\":false}}}"

node "${SCRIPT_DIR}/gas-goldens.mjs"
node "${SCRIPT_DIR}/dv-parity.mjs"

echo "quickjs-native-harness test passed"

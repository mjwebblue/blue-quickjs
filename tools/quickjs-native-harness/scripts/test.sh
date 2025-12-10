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

  local output
  output="$("${BIN}" --eval "${code}" || true)"

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
assert_output "Date missing" "typeof Date" "RESULT \"undefined\""
assert_output "Timers missing" "typeof setTimeout" "RESULT \"undefined\""
assert_output "Promise disabled" "Promise.resolve(1)" "ERROR TypeError: Promise is disabled in deterministic mode"
assert_output "queueMicrotask missing" "typeof queueMicrotask" "RESULT \"undefined\""
assert_output "Host descriptor" "${host_descriptor_js}" "RESULT {\"configurable\":false,\"enumerable\":false,\"writable\":false,\"hostType\":\"object\",\"v1Type\":\"object\",\"v1NullProto\":true}"

echo "quickjs-native-harness test passed"

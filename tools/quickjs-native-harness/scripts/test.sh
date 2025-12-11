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

counter_loop_js="$(cat <<'EOF'
(() => {
  globalThis.__counter = 0;
  for (let i = 0; i < 3; i++) {
    globalThis.__counter++;
  }
  return globalThis.__counter;
})()
EOF
)"

zero_gas_touch_js="$(cat <<'EOF'
(() => {
  globalThis.__touched = true;
  return 'never';
})()
EOF
)"

array_map_single_js="$(cat <<'EOF'
(() => {
  globalThis.__calls = 0;
  [1].map((v) => {
    __calls++;
    return v;
  });
  return __calls;
})()
EOF
)"

array_map_multi_js="$(cat <<'EOF'
(() => {
  globalThis.__calls = 0;
  [1, 2, 3, 4, 5].map((v) => {
    __calls++;
    return v;
  });
  return __calls;
})()
EOF
)"

array_filter_multi_js="$(cat <<'EOF'
(() => {
  globalThis.__filterCount = 0;
  [1, 2, 3, 4, 5].filter((v) => {
    __filterCount++;
    return v % 2;
  });
  return __filterCount;
})()
EOF
)"

array_reduce_multi_js="$(cat <<'EOF'
(() => {
  globalThis.__reduceCount = 0;
  return [1, 2, 3, 4, 5].reduce((acc, v) => {
    __reduceCount++;
    return acc + v;
  }, 0);
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
assert_output "out of gas" "1 + 2" "ERROR OutOfGas: out of gas" --gas-limit 0
assert_output "precharge prevents any progress" "${zero_gas_touch_js}" "ERROR OutOfGas: out of gas GAS remaining=0 used=0 STATE undefined" --gas-limit 0 --report-gas --dump-global __touched
assert_output "constant gas accounting" "1" "RESULT 1 GAS remaining=0 used=3" --gas-limit 3 --report-gas
assert_output "addition gas accounting" "1 + 2" "RESULT 3 GAS remaining=0 used=5" --gas-limit 5 --report-gas
assert_output "addition OOG boundary" "1 + 2" "ERROR OutOfGas: out of gas" --gas-limit 4
assert_output "loop OOG boundary state" "${counter_loop_js}" "ERROR OutOfGas: out of gas GAS remaining=0 used=54 STATE 3" --gas-limit 54 --report-gas --dump-global __counter
assert_output "Array.map single element gas" "${array_map_single_js}" "RESULT 1 GAS remaining=12 used=28 STATE 1" --gas-limit 40 --report-gas --dump-global __calls
assert_output "Array.map multi element gas" "${array_map_multi_js}" "RESULT 5 GAS remaining=36 used=64 STATE 5" --gas-limit 100 --report-gas --dump-global __calls
assert_output "Array.map OOG boundary" "${array_map_multi_js}" "ERROR OutOfGas: out of gas GAS remaining=0 used=55 STATE 4" --gas-limit 55 --report-gas --dump-global __calls
assert_output "Array.filter OOG boundary" "${array_filter_multi_js}" "ERROR OutOfGas: out of gas GAS remaining=0 used=60 STATE 4" --gas-limit 60 --report-gas --dump-global __filterCount
assert_output "Array.reduce OOG boundary" "${array_reduce_multi_js}" "ERROR OutOfGas: out of gas GAS remaining=0 used=61 STATE 4" --gas-limit 61 --report-gas --dump-global __reduceCount
assert_output "Host descriptor" "${host_descriptor_js}" "RESULT {\"configurable\":false,\"enumerable\":false,\"writable\":false,\"hostType\":\"object\",\"v1Type\":\"object\",\"v1NullProto\":true}"
assert_output "capability snapshot" "${capability_snapshot_js}" "RESULT {\"eval\":{\"ok\":false,\"error\":\"TypeError: eval is disabled in deterministic mode\"},\"Function\":{\"ok\":false,\"error\":\"TypeError: Function is disabled in deterministic mode\"},\"RegExp\":{\"ok\":false,\"error\":\"TypeError: RegExp is disabled in deterministic mode\"},\"Proxy\":{\"ok\":false,\"error\":\"TypeError: Proxy is disabled in deterministic mode\"},\"Promise\":{\"ok\":false,\"error\":\"TypeError: Promise is disabled in deterministic mode\"},\"MathRandom\":{\"ok\":false,\"error\":\"TypeError: Math.random is disabled in deterministic mode\"},\"Date\":{\"ok\":true,\"value\":\"undefined\"},\"setTimeout\":{\"ok\":true,\"value\":\"undefined\"},\"ArrayBuffer\":{\"ok\":false,\"error\":\"TypeError: ArrayBuffer is disabled in deterministic mode\"},\"SharedArrayBuffer\":{\"ok\":false,\"error\":\"TypeError: SharedArrayBuffer is disabled in deterministic mode\"},\"DataView\":{\"ok\":false,\"error\":\"TypeError: DataView is disabled in deterministic mode\"},\"Uint8Array\":{\"ok\":false,\"error\":\"TypeError: Typed arrays are disabled in deterministic mode\"},\"Atomics\":{\"ok\":false,\"error\":\"TypeError: Atomics is disabled in deterministic mode\"},\"WebAssembly\":{\"ok\":false,\"error\":\"TypeError: WebAssembly is disabled in deterministic mode\"},\"consoleLog\":{\"ok\":false,\"error\":\"TypeError: console is disabled in deterministic mode\"},\"print\":{\"ok\":false,\"error\":\"TypeError: print is disabled in deterministic mode\"},\"globalOrder\":{\"ok\":true,\"value\":[\"console\",\"print\",\"Host\"]},\"hostImmutable\":{\"ok\":true,\"value\":{\"sameRef\":true,\"hasV1\":true,\"added\":false,\"desc\":{\"value\":{},\"writable\":false,\"enumerable\":false,\"configurable\":false},\"protoNull\":true,\"v1ProtoNull\":true,\"hostIsExtensible\":false,\"hostV1Extensible\":false}}}"

echo "quickjs-native-harness test passed"

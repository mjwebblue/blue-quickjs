#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"
PROJECT_ROOT="${REPO_ROOT}/libs/quickjs-wasm-build"
QJS_DIR="${REPO_ROOT}/vendor/quickjs"
OUT_DIR="${PROJECT_ROOT}/dist"

ENV_SCRIPT="${REPO_ROOT}/tools/emsdk/emsdk_env.sh"
if [[ ! -f "${ENV_SCRIPT}" ]]; then
  echo "Emscripten env not found at ${ENV_SCRIPT}. Run tools/scripts/setup-emsdk.sh first." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${ENV_SCRIPT}" >/dev/null

if ! command -v emcc >/dev/null 2>&1; then
  echo "emcc not available after sourcing ${ENV_SCRIPT}" >&2
  exit 1
fi

VERSION="$(cat "${QJS_DIR}/VERSION")"

SRC_FILES=(
  "${QJS_DIR}/quickjs.c"
  "${QJS_DIR}/dtoa.c"
  "${QJS_DIR}/libregexp.c"
  "${QJS_DIR}/libunicode.c"
  "${QJS_DIR}/cutils.c"
  "${QJS_DIR}/quickjs-libc.c"
  "${PROJECT_ROOT}/src/wasm/quickjs_wasm.c"
)

EMCC_FLAGS=(
  -std=gnu11
  -O2
  -Wall
  -Wextra
  -Wno-unused-parameter
  -Wno-missing-field-initializers
  -funsigned-char
  -fwrapv
  -I"${QJS_DIR}"
  -D_GNU_SOURCE
  "-DCONFIG_VERSION=\"${VERSION}\""
  -sASSERTIONS=0
  -sENVIRONMENT=node,web
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sNO_EXIT_RUNTIME=1
  -sINITIAL_MEMORY=33554432
  -sALLOW_MEMORY_GROWTH=0
  -sMEMORY64=1
  -sSTACK_SIZE=1048576
  -sEXPORT_NAME=QuickJSGasWasm
  "-sEXPORTED_FUNCTIONS=['_qjs_eval','_qjs_free_output','_malloc','_free']"
  "-sEXPORTED_RUNTIME_METHODS=['cwrap','ccall','UTF8ToString','lengthBytesUTF8']"
)

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

emcc "${SRC_FILES[@]}" "${EMCC_FLAGS[@]}" -o "${OUT_DIR}/quickjs-eval.js"

echo "Built QuickJS wasm harness:"
echo "  JS:   ${OUT_DIR}/quickjs-eval.js"
echo "  Wasm: ${OUT_DIR}/quickjs-eval.wasm"

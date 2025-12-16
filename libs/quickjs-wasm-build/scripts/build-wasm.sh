#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"
PROJECT_ROOT="${REPO_ROOT}/libs/quickjs-wasm-build"
QJS_DIR="${REPO_ROOT}/vendor/quickjs"
OUT_DIR="${PROJECT_ROOT}/dist"
VARIANTS_RAW="${WASM_VARIANTS:-wasm32}"

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
  "${QJS_DIR}/quickjs-dv.c"
  "${QJS_DIR}/quickjs-sha256.c"
  "${QJS_DIR}/dtoa.c"
  "${QJS_DIR}/libregexp.c"
  "${QJS_DIR}/libunicode.c"
  "${QJS_DIR}/cutils.c"
  "${QJS_DIR}/quickjs-libc.c"
  "${PROJECT_ROOT}/src/wasm/quickjs_wasm.c"
)

COMMON_EMCC_FLAGS=(
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
  -sSTACK_SIZE=1048576
  -sERROR_ON_UNDEFINED_SYMBOLS=0
  -sEXPORT_NAME=QuickJSGasWasm
  -sWASM_BIGINT=1
  "-sEXPORTED_FUNCTIONS=['_qjs_eval','_qjs_free_output','_malloc','_free']"
  "-sEXPORTED_RUNTIME_METHODS=['cwrap','ccall','UTF8ToString','lengthBytesUTF8']"
)

inject_host_imports() {
  local js_file="$1"
  node -e "
    const fs = require('fs');
    const file = process.argv[1];
    let source = fs.readFileSync(file, 'utf8');
    if (!source.includes('var info={\"env\":wasmImports,\"wasi_snapshot_preview1\":wasmImports};')) {
      throw new Error(\`Unable to find wasm import object in \${file} for host injection\`);
    }
    if (!source.includes('info[\"host\"]=')) {
      const marker = 'var info={\"env\":wasmImports,\"wasi_snapshot_preview1\":wasmImports};';
      source = source.replace(
        marker,
        \`\${marker}info[\"host\"]=Module[\"host\"]||{host_call:function(){return 0xffffffff;}};\`,
      );
      fs.writeFileSync(file, source);
    }
  " -- "${js_file}"
}

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

IFS=',' read -ra REQUESTED_VARIANTS <<< "${VARIANTS_RAW// /,}"
if [[ ${#REQUESTED_VARIANTS[@]} -eq 0 ]]; then
  REQUESTED_VARIANTS=("wasm32")
fi

for variant in "${REQUESTED_VARIANTS[@]}"; do
  normalized_variant="$(echo "${variant}" | tr '[:upper:]' '[:lower:]')"
  suffix=""
  declare -a variant_flags=()
  emcc_args=("${SRC_FILES[@]}" "${COMMON_EMCC_FLAGS[@]}")

  case "${normalized_variant}" in
    wasm32)
      suffix=""
      ;;
    wasm64 | memory64 | mem64)
      suffix="-wasm64"
      variant_flags+=(-sMEMORY64=1)
      normalized_variant="wasm64"
      emcc_args+=("${variant_flags[@]}")
      ;;
    *)
      echo "Unknown WASM variant '${variant}'. Expected wasm32 or wasm64." >&2
      exit 1
      ;;
  esac

  emcc "${emcc_args[@]}" -o "${OUT_DIR}/quickjs-eval${suffix}.js"
  inject_host_imports "${OUT_DIR}/quickjs-eval${suffix}.js"

  echo "Built QuickJS wasm harness (${normalized_variant}):"
  echo "  JS:   ${OUT_DIR}/quickjs-eval${suffix}.js"
  echo "  Wasm: ${OUT_DIR}/quickjs-eval${suffix}.wasm"
done

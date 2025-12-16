#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"
QJS_DIR="${REPO_ROOT}/vendor/quickjs"
OUT_DIR="${REPO_ROOT}/tools/quickjs-native-harness/dist"
OBJ_DIR="${OUT_DIR}/obj"
CC_BIN="${CC:-cc}"

VERSION="$(cat "${QJS_DIR}/VERSION")"

mkdir -p "${OBJ_DIR}"

CFLAGS=(
  -std=gnu11
  -O2
  -Wall
  -Wextra
  -Wno-unused-parameter
  -Wno-missing-field-initializers
  -fPIC
  -funsigned-char
  -fwrapv
  -I"${QJS_DIR}"
  -D_GNU_SOURCE
  "-DCONFIG_VERSION=\"${VERSION}\""
)

LDFLAGS=(
  -lm
  -pthread
)

UNAME_OUT="$(uname -s)"
if [[ "${UNAME_OUT}" != "Darwin" ]]; then
  LDFLAGS+=(-ldl)
fi

SRC_FILES=(
  "${QJS_DIR}/quickjs.c"
  "${QJS_DIR}/quickjs-dv.c"
  "${QJS_DIR}/quickjs-sha256.c"
  "${QJS_DIR}/dtoa.c"
  "${QJS_DIR}/libregexp.c"
  "${QJS_DIR}/libunicode.c"
  "${QJS_DIR}/cutils.c"
  "${QJS_DIR}/quickjs-libc.c"
  "${REPO_ROOT}/tools/quickjs-native-harness/src/harness.c"
)

OBJ_FILES=()
for src in "${SRC_FILES[@]}"; do
  obj="${OBJ_DIR}/$(basename "${src%.*}").o"
  "${CC_BIN}" "${CFLAGS[@]}" -c "${src}" -o "${obj}"
  OBJ_FILES+=("${obj}")
done

"${CC_BIN}" -o "${OUT_DIR}/quickjs-native-harness" "${OBJ_FILES[@]}" "${LDFLAGS[@]}"

echo "Built ${OUT_DIR}/quickjs-native-harness"

#include "quickjs.h"
#include "quickjs-internal.h"
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  JSRuntime *rt;
  JSContext *ctx;
} HarnessRuntime;

typedef struct {
  const char *code;
  uint64_t gas_limit;
  int report_gas;
  int report_trace;
  const char *dump_global;
  int dv_encode;
  const char *dv_decode_hex;
  const char *abi_manifest_hex;
  const char *abi_manifest_file;
  const char *abi_manifest_hash;
  const char *context_blob_hex;
  const char *sha256_hex;
} HarnessOptions;

typedef struct {
  uint64_t gas_remaining;
  int has_trace;
  JSGasTrace trace;
} HarnessSnapshot;

static int print_exception(JSContext *ctx, const HarnessOptions *options);
static void free_runtime(HarnessRuntime *runtime);
static int run_sha256(const HarnessOptions *options);

static int hex_value(char c) {
  if (c >= '0' && c <= '9') {
    return c - '0';
  }
  if (c >= 'a' && c <= 'f') {
    return 10 + (c - 'a');
  }
  if (c >= 'A' && c <= 'F') {
    return 10 + (c - 'A');
  }
  return -1;
}

static int parse_hex_string(const char *hex, uint8_t **out, size_t *out_len) {
  size_t len = strlen(hex);
  size_t digit_count = 0;

  for (size_t i = 0; i < len; i++) {
    char c = hex[i];
    if (c == ' ' || c == '\n' || c == '\r' || c == '\t') {
      continue;
    }
    if (hex_value(c) < 0) {
      fprintf(stderr, "Invalid hex digit in input\n");
      return 1;
    }
    digit_count++;
  }

  if ((digit_count % 2) != 0) {
    fprintf(stderr, "Invalid hex string (odd number of digits)\n");
    return 1;
  }

  size_t byte_len = digit_count / 2;
  if (byte_len == 0) {
    *out = NULL;
    *out_len = 0;
    return 0;
  }

  uint8_t *buf = (uint8_t *)malloc(byte_len);
  if (!buf) {
    fprintf(stderr, "Out of memory parsing hex string\n");
    return 1;
  }

  int pending = -1;
  size_t out_index = 0;
  for (size_t i = 0; i < len; i++) {
    char c = hex[i];
    if (c == ' ' || c == '\n' || c == '\r' || c == '\t') {
      continue;
    }
    int value = hex_value(c);
    if (value < 0) {
      free(buf);
      fprintf(stderr, "Invalid hex digit in input\n");
      return 1;
    }
    if (pending < 0) {
      pending = value;
    } else {
      buf[out_index++] = (uint8_t)((pending << 4) | value);
      pending = -1;
    }
  }

  *out = buf;
  *out_len = byte_len;
  return 0;
}

static char *read_file_to_string(const char *path) {
  FILE *file = fopen(path, "rb");
  if (!file) {
    fprintf(stderr, "Failed to open %s: %s\n", path, strerror(errno));
    return NULL;
  }

  if (fseek(file, 0, SEEK_END) != 0) {
    fprintf(stderr, "Failed to seek %s\n", path);
    fclose(file);
    return NULL;
  }

  long size = ftell(file);
  if (size < 0 || fseek(file, 0, SEEK_SET) != 0) {
    fprintf(stderr, "Failed to determine size for %s\n", path);
    fclose(file);
    return NULL;
  }

  char *buffer = (char *)malloc((size_t)size + 1);
  if (!buffer) {
    fprintf(stderr, "Out of memory reading %s\n", path);
    fclose(file);
    return NULL;
  }

  size_t read_bytes = fread(buffer, 1, (size_t)size, file);
  fclose(file);
  buffer[read_bytes] = '\0';
  return buffer;
}

static void print_hex_buffer(const uint8_t *data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    fprintf(stdout, "%02x", data[i]);
  }
}

static int run_sha256(const HarnessOptions *options) {
  uint8_t *bytes = NULL;
  size_t len = 0;
  uint8_t hash[32];
  char hex[65];

  if (parse_hex_string(options->sha256_hex, &bytes, &len) != 0) {
    return 2;
  }

  js_sha256(bytes ? bytes : (const uint8_t *)"", len, hash);
  js_sha256_to_hex(hash, hex);
  free(bytes);

  fprintf(stdout, "SHA256 %s\n", hex);
  return 0;
}

static int init_runtime(HarnessRuntime *runtime, const HarnessOptions *options) {
  uint8_t *manifest_bytes = NULL;
  size_t manifest_len = 0;
  uint8_t *context_blob = NULL;
  size_t context_blob_len = 0;
  char *manifest_hex_from_file = NULL;
  int rc = 0;

  if (JS_NewDeterministicRuntime(&runtime->rt, &runtime->ctx) != 0) {
    fprintf(stderr, "init: JS_NewDeterministicRuntime failed\n");
    return 1;
  }

  if (options->abi_manifest_hash && !options->abi_manifest_hex && !options->abi_manifest_file) {
    fprintf(stderr, "--abi-manifest-hash requires manifest bytes\n");
    rc = 2;
    goto cleanup;
  }

  if (options->abi_manifest_hex && options->abi_manifest_file) {
    fprintf(stderr, "Provide either --abi-manifest-hex or --abi-manifest-hex-file, not both\n");
    rc = 2;
    goto cleanup;
  }

  if (options->abi_manifest_hex || options->abi_manifest_file) {
    const char *manifest_hex = options->abi_manifest_hex;

    if (options->abi_manifest_file) {
      manifest_hex_from_file = read_file_to_string(options->abi_manifest_file);
      if (!manifest_hex_from_file) {
        rc = 1;
        goto cleanup;
      }
      manifest_hex = manifest_hex_from_file;
    }

    if (!options->abi_manifest_hash) {
      fprintf(stderr, "--abi-manifest-hash is required when providing manifest bytes\n");
      rc = 2;
      goto cleanup;
    }

    if (!manifest_hex) {
      fprintf(stderr, "abi manifest hex is missing\n");
      rc = 2;
      goto cleanup;
    }

    if (parse_hex_string(manifest_hex, &manifest_bytes, &manifest_len) != 0) {
      rc = 2;
      goto cleanup;
    }

    if (options->context_blob_hex &&
        parse_hex_string(options->context_blob_hex, &context_blob, &context_blob_len) != 0) {
      rc = 2;
      goto cleanup;
    }

    JSDeterministicInitOptions init_opts = {
        .manifest_bytes = manifest_bytes,
        .manifest_size = manifest_len,
        .manifest_hash_hex = options->abi_manifest_hash,
        .context_blob = context_blob,
        .context_blob_size = context_blob_len,
        .gas_limit = options->gas_limit,
    };

    if (JS_InitDeterministicContext(runtime->ctx, &init_opts) != 0) {
      rc = print_exception(runtime->ctx, options);
      goto cleanup;
    }
  }

cleanup:
  free(manifest_bytes);
  free(context_blob);
  free(manifest_hex_from_file);

  if (rc != 0) {
    free_runtime(runtime);
  }

  return rc;
}

static void free_runtime(HarnessRuntime *runtime) {
  if (runtime->ctx) {
    JS_FreeContext(runtime->ctx);
    runtime->ctx = NULL;
  }
  if (runtime->rt) {
    JS_FreeRuntime(runtime->rt);
    runtime->rt = NULL;
  }
}

static void print_gas_suffix(const HarnessOptions *options, const HarnessSnapshot *snapshot) {
  if (!options->report_gas || snapshot == NULL) {
    return;
  }

  uint64_t remaining = snapshot->gas_remaining;
  if (options->gas_limit == JS_GAS_UNLIMITED) {
    fprintf(stdout, " GAS remaining=%" PRIu64, remaining);
  } else {
    uint64_t used = options->gas_limit - remaining;
    fprintf(stdout, " GAS remaining=%" PRIu64 " used=%" PRIu64, remaining, used);
  }
}

static void print_state_suffix(JSContext *ctx, const HarnessOptions *options) {
  if (!options->dump_global) {
    return;
  }

  JSValue global = JS_GetGlobalObject(ctx);
  if (JS_IsException(global)) {
    fprintf(stdout, " STATE <global unavailable>");
    return;
  }

  JSValue value = JS_GetPropertyStr(ctx, global, options->dump_global);
  JS_FreeValue(ctx, global);
  if (JS_IsException(value)) {
    fprintf(stdout, " STATE <read error>");
    JS_FreeValue(ctx, value);
    return;
  }

  JSValue json = JS_JSONStringify(ctx, value, JS_UNDEFINED, JS_UNDEFINED);
  JS_FreeValue(ctx, value);
  if (JS_IsException(json)) {
    fprintf(stdout, " STATE <stringify error>");
    JS_FreeValue(ctx, json);
    return;
  }

  if (JS_IsUndefined(json)) {
    fprintf(stdout, " STATE undefined");
    JS_FreeValue(ctx, json);
    return;
  }

  const char *json_str = JS_ToCString(ctx, json);
  if (!json_str) {
    fprintf(stdout, " STATE <stringify error>");
    JS_FreeValue(ctx, json);
    return;
  }

  fprintf(stdout, " STATE %s", json_str);
  JS_FreeCString(ctx, json_str);
  JS_FreeValue(ctx, json);
}

static void print_trace_suffix(const HarnessOptions *options, const HarnessSnapshot *snapshot) {
  if (!options->report_trace || snapshot == NULL) {
    return;
  }

  if (!snapshot->has_trace) {
    fprintf(stdout, " TRACE <unavailable>");
    return;
  }

  fprintf(stdout,
          " TRACE {\"opcodeCount\":%" PRIu64 ",\"opcodeGas\":%" PRIu64
          ",\"arrayCbBase\":{\"count\":%" PRIu64 ",\"gas\":%" PRIu64
          "},\"arrayCbPerEl\":{\"count\":%" PRIu64 ",\"gas\":%" PRIu64
          "},\"alloc\":{\"count\":%" PRIu64 ",\"bytes\":%" PRIu64 ",\"gas\":%" PRIu64 "}",
          snapshot->trace.opcode_count, snapshot->trace.opcode_gas,
          snapshot->trace.builtin_array_cb_base_count, snapshot->trace.builtin_array_cb_base_gas,
          snapshot->trace.builtin_array_cb_per_element_count,
          snapshot->trace.builtin_array_cb_per_element_gas, snapshot->trace.allocation_count,
          snapshot->trace.allocation_bytes, snapshot->trace.allocation_gas);

  fputc('}', stdout);
}

static int print_exception(JSContext *ctx, const HarnessOptions *options) {
  HarnessSnapshot snapshot = {0};
  JSValue exception = JS_GetException(ctx);
  const char *msg = JS_ToCString(ctx, exception);
  snapshot.gas_remaining = JS_GetGasRemaining(ctx);
  if (options->report_trace) {
    snapshot.has_trace = JS_ReadGasTrace(ctx, &snapshot.trace) == 0;
  }
  if (msg) {
    fprintf(stdout, "ERROR %s", msg);
    print_gas_suffix(options, &snapshot);
    print_state_suffix(ctx, options);
    print_trace_suffix(options, &snapshot);
    fprintf(stdout, "\n");
    JS_FreeCString(ctx, msg);
  } else {
    fprintf(stdout, "ERROR <exception>\n");
  }
  JS_FreeValue(ctx, exception);
  return 1;
}

static int run_gc_checkpoint(JSContext *ctx, const HarnessOptions *options) {
  if (JS_RunGCCheckpoint(ctx) == 0) {
    return 0;
  }

  return print_exception(ctx, options);
}

static int encode_dv_source(JSContext *ctx, const HarnessOptions *options) {
  if (run_gc_checkpoint(ctx, options) != 0) {
    return 1;
  }

  JSValue result = JS_Eval(ctx, options->code, strlen(options->code), "<eval>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(result)) {
    JS_FreeValue(ctx, result);
    if (run_gc_checkpoint(ctx, options) != 0) {
      return 1;
    }
    return print_exception(ctx, options);
  }

  JSDvBuffer buffer = {0};
  int encode_rc = JS_EncodeDV(ctx, result, NULL, &buffer);
  JS_FreeValue(ctx, result);

  if (encode_rc != 0) {
    if (run_gc_checkpoint(ctx, options) != 0) {
      JS_FreeDVBuffer(ctx, &buffer);
      return 1;
    }
    JS_FreeDVBuffer(ctx, &buffer);
    return print_exception(ctx, options);
  }

  if (run_gc_checkpoint(ctx, options) != 0) {
    JS_FreeDVBuffer(ctx, &buffer);
    return 1;
  }

  HarnessSnapshot snapshot = {0};
  snapshot.gas_remaining = JS_GetGasRemaining(ctx);
  if (options->report_trace) {
    snapshot.has_trace = JS_ReadGasTrace(ctx, &snapshot.trace) == 0;
  }

  fprintf(stdout, "DV ");
  print_hex_buffer(buffer.data, buffer.length);
  print_gas_suffix(options, &snapshot);
  print_trace_suffix(options, &snapshot);
  fprintf(stdout, "\n");

  JS_FreeDVBuffer(ctx, &buffer);
  return 0;
}

static int decode_dv_hex(JSContext *ctx, const HarnessOptions *options) {
  uint8_t *bytes = NULL;
  size_t byte_len = 0;

  if (parse_hex_string(options->dv_decode_hex, &bytes, &byte_len) != 0) {
    return 2;
  }

  if (run_gc_checkpoint(ctx, options) != 0) {
    free(bytes);
    return 1;
  }

  JSValue decoded = JS_DecodeDV(ctx, bytes, byte_len, NULL);
  free(bytes);
  if (JS_IsException(decoded)) {
    if (run_gc_checkpoint(ctx, options) != 0) {
      return 1;
    }
    return print_exception(ctx, options);
  }

  JSValue json = JS_JSONStringify(ctx, decoded, JS_UNDEFINED, JS_UNDEFINED);
  JS_FreeValue(ctx, decoded);

  if (JS_IsException(json)) {
    if (run_gc_checkpoint(ctx, options) != 0) {
      return 1;
    }
    return print_exception(ctx, options);
  }

  const char *json_str = JS_ToCString(ctx, json);
  if (!json_str) {
    JS_FreeValue(ctx, json);
    fprintf(stdout, "ERROR <stringify>\n");
    return 1;
  }

  if (run_gc_checkpoint(ctx, options) != 0) {
    JS_FreeCString(ctx, json_str);
    JS_FreeValue(ctx, json);
    return 1;
  }

  HarnessSnapshot snapshot = {0};
  snapshot.gas_remaining = JS_GetGasRemaining(ctx);
  if (options->report_trace) {
    snapshot.has_trace = JS_ReadGasTrace(ctx, &snapshot.trace) == 0;
  }

  fprintf(stdout, "DVRESULT %s", json_str);
  print_gas_suffix(options, &snapshot);
  print_trace_suffix(options, &snapshot);
  fprintf(stdout, "\n");

  JS_FreeCString(ctx, json_str);
  JS_FreeValue(ctx, json);
  return 0;
}

static int eval_source(JSContext *ctx, const char *code, const HarnessOptions *options) {
  if (run_gc_checkpoint(ctx, options) != 0) {
    return 1;
  }

  JSValue result = JS_Eval(ctx, code, strlen(code), "<eval>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(result)) {
    JS_FreeValue(ctx, result);
    if (run_gc_checkpoint(ctx, options) != 0) {
      return 1;
    }
    return print_exception(ctx, options);
  }

  JSValue json = JS_JSONStringify(ctx, result, JS_UNDEFINED, JS_UNDEFINED);
  JS_FreeValue(ctx, result);

  if (JS_IsException(json)) {
    if (run_gc_checkpoint(ctx, options) != 0) {
      return 1;
    }
    return print_exception(ctx, options);
  }

  const char *json_str = JS_ToCString(ctx, json);
  if (!json_str) {
    JS_FreeValue(ctx, json);
    fprintf(stdout, "ERROR <stringify>\n");
    return 1;
  }

  if (run_gc_checkpoint(ctx, options) != 0) {
    JS_FreeCString(ctx, json_str);
    JS_FreeValue(ctx, json);
    return 1;
  }

  HarnessSnapshot snapshot = {0};
  snapshot.gas_remaining = JS_GetGasRemaining(ctx);
  if (options->report_trace) {
    snapshot.has_trace = JS_ReadGasTrace(ctx, &snapshot.trace) == 0;
  }

  fprintf(stdout, "RESULT %s", json_str);
  print_gas_suffix(options, &snapshot);
  print_state_suffix(ctx, options);
  print_trace_suffix(options, &snapshot);
  fprintf(stdout, "\n");

  JS_FreeCString(ctx, json_str);
  JS_FreeValue(ctx, json);
  return 0;
}

static void print_usage(const char *prog) {
  fprintf(stderr,
          "Usage:\n"
          "  %s [--gas-limit <u64>] [--report-gas] [--gas-trace] [--dump-global <name>] [--abi-manifest-hex <hex> | --abi-manifest-hex-file <path>] [--abi-manifest-hash <hex>] [--context-blob-hex <hex>] --eval \"<js-source>\"\n"
          "  %s --dv-encode --eval \"<js-source>\"\n"
          "  %s --dv-decode <hex-string>\n"
          "  %s --sha256-hex <hex-string>\n",
          prog,
          prog,
          prog,
          prog);
}

static int parse_args(int argc, char **argv, HarnessOptions *opts) {
  opts->code = NULL;
  opts->gas_limit = JS_GAS_UNLIMITED;
  opts->report_gas = 0;
  opts->report_trace = 0;
  opts->dump_global = NULL;
  opts->dv_encode = 0;
  opts->dv_decode_hex = NULL;
  opts->abi_manifest_hex = NULL;
  opts->abi_manifest_file = NULL;
  opts->abi_manifest_hash = NULL;
  opts->context_blob_hex = NULL;
  opts->sha256_hex = NULL;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--eval") == 0) {
      if (i + 1 >= argc) {
        print_usage(argv[0]);
        return 2;
      }
      opts->code = argv[++i];
      continue;
    }

    if (strcmp(argv[i], "--gas-limit") == 0) {
      if (i + 1 >= argc) {
        print_usage(argv[0]);
        return 2;
      }
      const char *value = argv[++i];
      char *endptr = NULL;
      errno = 0;
      unsigned long long parsed = strtoull(value, &endptr, 10);
      if (errno != 0 || endptr == value || *endptr != '\0') {
        fprintf(stderr, "Invalid --gas-limit: %s\n", value);
        return 2;
      }
      opts->gas_limit = (uint64_t)parsed;
      continue;
    }

    if (strcmp(argv[i], "--report-gas") == 0) {
      opts->report_gas = 1;
      continue;
    }

    if (strcmp(argv[i], "--gas-trace") == 0) {
      opts->report_trace = 1;
      continue;
    }

    if (strcmp(argv[i], "--dv-encode") == 0) {
      opts->dv_encode = 1;
      continue;
    }

    if (strcmp(argv[i], "--dv-decode") == 0) {
      if (i + 1 >= argc) {
        print_usage(argv[0]);
        return 2;
      }
      opts->dv_decode_hex = argv[++i];
      continue;
    }

    if (strcmp(argv[i], "--abi-manifest-hex") == 0) {
      if (i + 1 >= argc) {
        print_usage(argv[0]);
        return 2;
      }
      opts->abi_manifest_hex = argv[++i];
      continue;
    }

    if (strcmp(argv[i], "--abi-manifest-hex-file") == 0) {
      if (i + 1 >= argc) {
        print_usage(argv[0]);
        return 2;
      }
      opts->abi_manifest_file = argv[++i];
      continue;
    }

    if (strcmp(argv[i], "--abi-manifest-hash") == 0) {
      if (i + 1 >= argc) {
        print_usage(argv[0]);
        return 2;
      }
      opts->abi_manifest_hash = argv[++i];
      continue;
    }

    if (strcmp(argv[i], "--context-blob-hex") == 0) {
      if (i + 1 >= argc) {
        print_usage(argv[0]);
        return 2;
      }
      opts->context_blob_hex = argv[++i];
      continue;
    }

    if (strcmp(argv[i], "--sha256-hex") == 0) {
      if (i + 1 >= argc) {
        print_usage(argv[0]);
        return 2;
      }
      opts->sha256_hex = argv[++i];
      continue;
    }

    if (strcmp(argv[i], "--dump-global") == 0) {
      if (i + 1 >= argc) {
        print_usage(argv[0]);
        return 2;
      }
      opts->dump_global = argv[++i];
      continue;
    }

    print_usage(argv[0]);
    return 2;
  }

  if (opts->dv_decode_hex) {
    if (opts->code != NULL || opts->dv_encode) {
      print_usage(argv[0]);
      return 2;
    }
    return 0;
  }

  if (opts->sha256_hex) {
    if (opts->code != NULL || opts->dv_encode || opts->dv_decode_hex) {
      print_usage(argv[0]);
      return 2;
    }
    return 0;
  }

  if (opts->code == NULL) {
    print_usage(argv[0]);
    return 2;
  }

  return 0;
}

int main(int argc, char **argv) {
  HarnessOptions options;
  int parse_result = parse_args(argc, argv, &options);
  if (parse_result != 0) {
    return parse_result;
  }

  if (options.sha256_hex) {
    return run_sha256(&options);
  }

  HarnessRuntime runtime = {0};

  int init_rc = init_runtime(&runtime, &options);
  if (init_rc != 0) {
    return init_rc;
  }

  JS_SetGasLimit(runtime.ctx, options.gas_limit);

  if (options.report_trace) {
    if (JS_EnableGasTrace(runtime.ctx, 1) != 0) {
      fprintf(stderr, "init: failed to enable gas trace\n");
      free_runtime(&runtime);
      return 1;
    }
  }

  int rc = 0;
  if (options.dv_decode_hex) {
    rc = decode_dv_hex(runtime.ctx, &options);
  } else {
    if (run_gc_checkpoint(runtime.ctx, &options) != 0) {
      free_runtime(&runtime);
      return 1;
    }
    if (options.dv_encode) {
      rc = encode_dv_source(runtime.ctx, &options);
    } else {
      rc = eval_source(runtime.ctx, options.code, &options);
    }
  }

  free_runtime(&runtime);
  return rc;
}

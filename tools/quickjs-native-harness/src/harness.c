#include "quickjs.h"
#include "quickjs-host.h"
#include "quickjs-internal.h"
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef enum {
  HOST_STUB_MODE_ECHO = 0,
  HOST_STUB_MODE_MANIFEST = 1
} HostStubMode;

typedef struct {
  HostStubMode mode;
  int trigger_reentrancy;
  int trigger_exception;
} HostStubConfig;

typedef struct {
  JSRuntime *rt;
  JSContext *ctx;
  int host_stub_enabled;
  HostStubConfig host_stub;
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
  const char *host_call_hex;
  uint32_t host_call_fn_id;
  uint32_t host_call_max_request;
  uint32_t host_call_max_response;
  int host_call_reentrant;
  int host_call_exception;
  int host_call_parse_envelope;
  uint32_t host_call_max_units;
  int host_call_max_units_provided;
} HarnessOptions;

typedef struct {
  uint64_t gas_remaining;
  int has_trace;
  JSGasTrace trace;
} HarnessSnapshot;

typedef struct {
  JSHostErrorEntry entries[3];
  size_t count;
} HostErrorTable;

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

static void free_default_host_errors(JSContext *ctx, HostErrorTable *table) {
  if (!table) {
    return;
  }

  for (size_t i = 0; i < table->count; i++) {
    if (table->entries[i].code_atom != JS_ATOM_NULL) {
      JS_FreeAtom(ctx, table->entries[i].code_atom);
    }
    if (table->entries[i].tag_atom != JS_ATOM_NULL) {
      JS_FreeAtom(ctx, table->entries[i].tag_atom);
    }
    table->entries[i].code_atom = JS_ATOM_NULL;
    table->entries[i].tag_atom = JS_ATOM_NULL;
  }
  table->count = 0;
}

static int init_default_host_errors(JSContext *ctx, HostErrorTable *table) {
  if (!table) {
    return -1;
  }

  const char *codes[] = {"INVALID_PATH", "LIMIT_EXCEEDED", "NOT_FOUND"};
  const char *tags[] = {"host/invalid_path", "host/limit", "host/not_found"};
  const size_t count = sizeof(codes) / sizeof(codes[0]);

  table->count = 0;
  for (size_t i = 0; i < count; i++) {
    JSAtom code_atom = JS_NewAtom(ctx, codes[i]);
    JSAtom tag_atom = JS_NewAtom(ctx, tags[i]);
    if (code_atom == JS_ATOM_NULL || tag_atom == JS_ATOM_NULL) {
      if (code_atom != JS_ATOM_NULL) {
        JS_FreeAtom(ctx, code_atom);
      }
      if (tag_atom != JS_ATOM_NULL) {
        JS_FreeAtom(ctx, tag_atom);
      }
      free_default_host_errors(ctx, table);
      return -1;
    }

    table->entries[i].code_atom = code_atom;
    table->entries[i].tag_atom = tag_atom;
  }

  table->count = count;
  return 0;
}

static uint32_t harness_manifest_host_call(JSContext *ctx,
                                           uint32_t fn_id,
                                           const uint8_t *req_ptr,
                                           uint32_t req_len,
                                           uint8_t *resp_ptr,
                                           uint32_t resp_capacity) {
  JSValue req = JS_UNDEFINED;
  JSValue arg0 = JS_UNDEFINED;
  JSValue envelope = JS_UNDEFINED;
  JSValue err_obj = JS_UNDEFINED;
  JSValue ok_val = JS_UNDEFINED;
  JSDvBuffer resp = {0};
  uint32_t units = 1;
  const char *error_code = NULL;
  uint32_t resp_len = JS_HOST_CALL_TRANSPORT_ERROR;

  req = JS_DecodeDV(ctx, req_ptr, req_len, &JS_DV_LIMIT_DEFAULTS);
  if (JS_IsException(req)) {
    goto done;
  }

  if (!JS_IsArray(ctx, req)) {
    goto done;
  }

  arg0 = JS_GetPropertyUint32(ctx, req, 0);
  if (JS_IsException(arg0)) {
    goto done;
  }

  envelope = JS_NewObjectProto(ctx, JS_NULL);
  if (JS_IsException(envelope)) {
    goto done;
  }

  if (fn_id == 1 || fn_id == 2) {
    if (!JS_IsString(arg0)) {
      goto done;
    }
    const char *path = JS_ToCString(ctx, arg0);
    if (!path) {
      goto done;
    }
    if (strcmp(path, "missing") == 0) {
      error_code = "NOT_FOUND";
      units = 2;
    } else if (strcmp(path, "limit") == 0) {
      error_code = "LIMIT_EXCEEDED";
      units = 3;
    }
    JS_FreeCString(ctx, path);

    if (error_code) {
      err_obj = JS_NewObjectProto(ctx, JS_NULL);
      if (JS_IsException(err_obj)) {
        goto done;
      }
      if (JS_SetPropertyStr(ctx, err_obj, "code", JS_NewString(ctx, error_code)) < 0) {
        goto done;
      }
    } else {
      ok_val = JS_DupValue(ctx, arg0);
    }
  } else if (fn_id == 3) {
    ok_val = JS_NULL;
    units = 0;
  } else {
    goto done;
  }

  if (error_code) {
    if (JS_SetPropertyStr(ctx, envelope, "err", err_obj) < 0) {
      goto done;
    }
    err_obj = JS_UNDEFINED;
  } else {
    if (JS_SetPropertyStr(ctx, envelope, "ok", ok_val) < 0) {
      goto done;
    }
    ok_val = JS_UNDEFINED;
  }

  if (JS_SetPropertyStr(ctx, envelope, "units", JS_NewUint32(ctx, units)) < 0) {
    goto done;
  }

  if (JS_EncodeDV(ctx, envelope, &JS_DV_LIMIT_DEFAULTS, &resp) != 0) {
    goto done;
  }

  if (resp.length > resp_capacity) {
    goto done;
  }

  memcpy(resp_ptr, resp.data, resp.length);
  resp_len = (uint32_t)resp.length;

done:
  if (resp.data) {
    JS_FreeDVBuffer(ctx, &resp);
  }
  if (!JS_IsUndefined(ok_val)) {
    JS_FreeValue(ctx, ok_val);
  }
  if (!JS_IsUndefined(err_obj)) {
    JS_FreeValue(ctx, err_obj);
  }
  if (!JS_IsUndefined(envelope)) {
    JS_FreeValue(ctx, envelope);
  }
  if (!JS_IsUndefined(arg0)) {
    JS_FreeValue(ctx, arg0);
  }
  if (!JS_IsUndefined(req)) {
    JS_FreeValue(ctx, req);
  }
  return resp_len;
}

static uint32_t harness_host_call(JSContext *ctx,
                                  uint32_t fn_id,
                                  const uint8_t *req_ptr,
                                  uint32_t req_len,
                                  uint8_t *resp_ptr,
                                  uint32_t resp_capacity,
                                  void *opaque) {
  HostStubConfig *config = (HostStubConfig *)opaque;

  if (config && config->trigger_reentrancy) {
    JSHostCallResult nested = {0};
    uint32_t max_req = req_len > 0 ? req_len : 1;
    uint32_t max_resp = resp_capacity > 0 ? resp_capacity : 1;

    if (max_req < max_resp) {
      max_req = max_resp;
    }

    (void)JS_HostCall(ctx, fn_id, req_ptr, req_len, max_req, max_resp, &nested);
    if (!JS_HasException(ctx)) {
      JS_ThrowTypeError(ctx, "host_call is already in progress");
    }
    return JS_HOST_CALL_TRANSPORT_ERROR;
  }

  if (config && config->trigger_exception) {
    JS_ThrowTypeError(ctx, "host stub exception");
    return req_len;
  }

  if (config && config->mode == HOST_STUB_MODE_MANIFEST) {
    return harness_manifest_host_call(ctx, fn_id, req_ptr, req_len, resp_ptr, resp_capacity);
  }

  if (req_len > resp_capacity) {
    return JS_HOST_CALL_TRANSPORT_ERROR;
  }

  if (req_len > 0) {
    memcpy(resp_ptr, req_ptr, req_len);
  }

  return req_len;
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

  const int enable_host_stub =
      options->host_call_hex != NULL || manifest_bytes != NULL || manifest_hex_from_file != NULL;

  if (enable_host_stub) {
    runtime->host_stub.mode =
        options->host_call_hex != NULL ? HOST_STUB_MODE_ECHO : HOST_STUB_MODE_MANIFEST;
    runtime->host_stub.trigger_reentrancy = options->host_call_reentrant;
    runtime->host_stub.trigger_exception = options->host_call_exception;
    runtime->host_stub_enabled = 1;
    if (JS_SetHostCallDispatcher(runtime->rt, harness_host_call, &runtime->host_stub) != 0) {
      rc = 1;
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
    fprintf(stdout, "ERROR <exception>");
    print_gas_suffix(options, &snapshot);
    print_state_suffix(ctx, options);
    print_trace_suffix(options, &snapshot);
    fprintf(stdout, "\n");
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

static int run_host_call(HarnessRuntime *runtime, const HarnessOptions *options) {
  uint8_t *req_bytes = NULL;
  size_t req_len = 0;
  JSHostCallResult result = {0};
  HostErrorTable error_table = {0};
  uint32_t max_req = options->host_call_max_request;
  uint32_t max_resp = options->host_call_max_response;
  uint32_t max_units =
      options->host_call_max_units_provided ? options->host_call_max_units : 1000;

  if (parse_hex_string(options->host_call_hex, &req_bytes, &req_len) != 0) {
    return 2;
  }

  if (max_req == 0) {
    if (req_len > UINT32_MAX) {
      free(req_bytes);
      fprintf(stderr, "host_call request too large\n");
      return 2;
    }
    max_req = req_len > 0 ? (uint32_t)req_len : 1;
  }

  if (max_resp == 0) {
    max_resp = max_req > 0 ? max_req : 1;
  }

  if (run_gc_checkpoint(runtime->ctx, options) != 0) {
    free(req_bytes);
    return 1;
  }

  int rc = JS_HostCall(runtime->ctx,
                       options->host_call_fn_id,
                       req_bytes,
                       req_len,
                       max_req,
                       max_resp,
                       &result);
  if (rc != 0) {
    free(req_bytes);
    if (run_gc_checkpoint(runtime->ctx, options) != 0) {
      return 1;
    }
    return print_exception(runtime->ctx, options);
  }

  if (run_gc_checkpoint(runtime->ctx, options) != 0) {
    free(req_bytes);
    return 1;
  }

  if (options->host_call_parse_envelope) {
    if (init_default_host_errors(runtime->ctx, &error_table) != 0) {
      free(req_bytes);
      return print_exception(runtime->ctx, options);
    }

    JSHostResponseValidation validation = {
        .max_units = max_units,
        .errors = error_table.entries,
        .error_count = error_table.count,
    };
    JSHostResponse parsed;

    if (JS_ParseHostResponse(runtime->ctx, result.data, result.length, &validation, &parsed) != 0) {
      free_default_host_errors(runtime->ctx, &error_table);
      free(req_bytes);
      return print_exception(runtime->ctx, options);
    }

    if (parsed.is_error) {
      JS_ThrowHostError(runtime->ctx, parsed.err_code_atom, parsed.err_tag_atom, parsed.err_details);
      JS_FreeHostResponse(runtime->ctx, &parsed);
      free_default_host_errors(runtime->ctx, &error_table);
      free(req_bytes);
      return print_exception(runtime->ctx, options);
    }

    HarnessSnapshot snapshot = {0};
    snapshot.gas_remaining = JS_GetGasRemaining(runtime->ctx);
    if (options->report_trace) {
      snapshot.has_trace = JS_ReadGasTrace(runtime->ctx, &snapshot.trace) == 0;
    }

    JSValue json = JS_JSONStringify(runtime->ctx, parsed.ok, JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException(json)) {
      JS_FreeHostResponse(runtime->ctx, &parsed);
      free_default_host_errors(runtime->ctx, &error_table);
      free(req_bytes);
      return print_exception(runtime->ctx, options);
    }

    const char *json_str = JS_ToCString(runtime->ctx, json);
    if (!json_str) {
      JS_FreeValue(runtime->ctx, json);
      JS_FreeHostResponse(runtime->ctx, &parsed);
      free_default_host_errors(runtime->ctx, &error_table);
      free(req_bytes);
      fprintf(stdout, "ERROR <stringify>");
      print_gas_suffix(options, &snapshot);
      print_state_suffix(runtime->ctx, options);
      print_trace_suffix(options, &snapshot);
      fprintf(stdout, "\n");
      return 1;
    }

    fprintf(stdout, "HOSTRESP %s UNITS %" PRIu32, json_str, parsed.units);
    JS_FreeCString(runtime->ctx, json_str);
    JS_FreeValue(runtime->ctx, json);
    JS_FreeHostResponse(runtime->ctx, &parsed);
    free_default_host_errors(runtime->ctx, &error_table);
    print_gas_suffix(options, &snapshot);
    print_state_suffix(runtime->ctx, options);
    print_trace_suffix(options, &snapshot);
    fprintf(stdout, "\n");
    free(req_bytes);
    return 0;
  }

  HarnessSnapshot snapshot = {0};
  snapshot.gas_remaining = JS_GetGasRemaining(runtime->ctx);
  if (options->report_trace) {
    snapshot.has_trace = JS_ReadGasTrace(runtime->ctx, &snapshot.trace) == 0;
  }

  fprintf(stdout, "HOSTCALL ");
  print_hex_buffer(result.data, result.length);
  print_gas_suffix(options, &snapshot);
  print_state_suffix(runtime->ctx, options);
  print_trace_suffix(options, &snapshot);
  fprintf(stdout, "\n");

  free(req_bytes);
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
          "  %s --host-call <hex-string> [--host-fn-id <u32>] [--host-max-request <u32>] [--host-max-response <u32>] [--host-max-units <u32>] [--host-parse-envelope] [--host-reentrant] [--host-exception] [--gas-limit <u64>] [--report-gas] [--gas-trace] [--abi-manifest-hex <hex> | --abi-manifest-hex-file <path>] [--abi-manifest-hash <hex>] [--context-blob-hex <hex>]\n"
          "  %s --sha256-hex <hex-string>\n",
          prog,
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
  opts->host_call_hex = NULL;
  opts->host_call_fn_id = 1;
  opts->host_call_max_request = 0;
  opts->host_call_max_response = 0;
  opts->host_call_reentrant = 0;
  opts->host_call_exception = 0;
  opts->host_call_parse_envelope = 0;
  opts->host_call_max_units = 0;
  opts->host_call_max_units_provided = 0;

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

    if (strcmp(argv[i], "--host-call") == 0) {
      if (i + 1 >= argc) {
        print_usage(argv[0]);
        return 2;
      }
      opts->host_call_hex = argv[++i];
      continue;
    }

    if (strcmp(argv[i], "--host-fn-id") == 0) {
      if (i + 1 >= argc) {
        print_usage(argv[0]);
        return 2;
      }
      const char *value = argv[++i];
      char *endptr = NULL;
      errno = 0;
      unsigned long parsed = strtoul(value, &endptr, 10);
      if (errno != 0 || endptr == value || *endptr != '\0' ||
          parsed > UINT32_MAX || parsed == 0) {
        fprintf(stderr, "Invalid --host-fn-id: %s\n", value);
        return 2;
      }
      opts->host_call_fn_id = (uint32_t)parsed;
      continue;
    }

    if (strcmp(argv[i], "--host-max-request") == 0) {
      if (i + 1 >= argc) {
        print_usage(argv[0]);
        return 2;
      }
      const char *value = argv[++i];
      char *endptr = NULL;
      errno = 0;
      unsigned long parsed = strtoul(value, &endptr, 10);
      if (errno != 0 || endptr == value || *endptr != '\0' ||
          parsed > UINT32_MAX) {
        fprintf(stderr, "Invalid --host-max-request: %s\n", value);
        return 2;
      }
      opts->host_call_max_request = (uint32_t)parsed;
      continue;
    }

    if (strcmp(argv[i], "--host-max-response") == 0) {
      if (i + 1 >= argc) {
        print_usage(argv[0]);
        return 2;
      }
      const char *value = argv[++i];
      char *endptr = NULL;
      errno = 0;
      unsigned long parsed = strtoul(value, &endptr, 10);
      if (errno != 0 || endptr == value || *endptr != '\0' ||
          parsed > UINT32_MAX) {
        fprintf(stderr, "Invalid --host-max-response: %s\n", value);
        return 2;
      }
      opts->host_call_max_response = (uint32_t)parsed;
      continue;
    }

    if (strcmp(argv[i], "--host-max-units") == 0) {
      if (i + 1 >= argc) {
        print_usage(argv[0]);
        return 2;
      }
      const char *value = argv[++i];
      char *endptr = NULL;
      errno = 0;
      unsigned long parsed = strtoul(value, &endptr, 10);
      if (errno != 0 || endptr == value || *endptr != '\0' || parsed > UINT32_MAX) {
        fprintf(stderr, "Invalid --host-max-units: %s\n", value);
        return 2;
      }
      opts->host_call_max_units = (uint32_t)parsed;
      opts->host_call_max_units_provided = 1;
      continue;
    }

    if (strcmp(argv[i], "--host-reentrant") == 0) {
      opts->host_call_reentrant = 1;
      continue;
    }

    if (strcmp(argv[i], "--host-exception") == 0) {
      opts->host_call_exception = 1;
      continue;
    }

    if (strcmp(argv[i], "--host-parse-envelope") == 0) {
      opts->host_call_parse_envelope = 1;
      continue;
    }

    print_usage(argv[0]);
    return 2;
  }

  const int host_call_mode = opts->host_call_hex != NULL || opts->host_call_parse_envelope;

  if (opts->dv_decode_hex) {
    if (opts->code != NULL || opts->dv_encode || host_call_mode || opts->sha256_hex) {
      print_usage(argv[0]);
      return 2;
    }
    return 0;
  }

  if (opts->sha256_hex) {
    if (opts->code != NULL || opts->dv_encode || opts->dv_decode_hex ||
        host_call_mode) {
      print_usage(argv[0]);
      return 2;
    }
    return 0;
  }

  if (host_call_mode) {
    if (opts->code != NULL || opts->dv_encode) {
      print_usage(argv[0]);
      return 2;
    }
    if (opts->host_call_hex == NULL) {
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
  } else if (options.host_call_hex) {
    rc = run_host_call(&runtime, &options);
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

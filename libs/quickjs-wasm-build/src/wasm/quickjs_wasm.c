#include "quickjs.h"
#include "quickjs-host.h"
#include <emscripten/emscripten.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The wasm module imports a single host_call symbol provided by the embedder.
   Keep the signature aligned with docs/host-call-abi.md (all uint32 params). */
__attribute__((import_module("host"), import_name("host_call")))
extern uint32_t host_call(uint32_t fn_id,
                          uint32_t req_ptr,
                          uint32_t req_len,
                          uint32_t resp_ptr,
                          uint32_t resp_capacity);

static JSRuntime *det_rt = NULL;
static JSContext *det_ctx = NULL;
static uint64_t det_gas_limit = JS_GAS_UNLIMITED;

static void free_det_runtime(void) {
  if (det_ctx) {
    JS_FreeContext(det_ctx);
    det_ctx = NULL;
  }
  if (det_rt) {
    JS_FreeRuntime(det_rt);
    det_rt = NULL;
  }
  det_gas_limit = JS_GAS_UNLIMITED;
}

static uint32_t wasm_host_call(JSContext *ctx,
                               uint32_t fn_id,
                               const uint8_t *req_ptr,
                               uint32_t req_len,
                               uint8_t *resp_ptr,
                               uint32_t resp_capacity,
                               void *opaque) {
  (void)ctx;
  (void)opaque;

  if (!req_ptr && req_len > 0) {
    return JS_HOST_CALL_TRANSPORT_ERROR;
  }

  return host_call(fn_id,
                   (uint32_t)(uintptr_t)req_ptr,
                   req_len,
                   (uint32_t)(uintptr_t)resp_ptr,
                   resp_capacity);
}

static char *dup_printf(const char *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  int needed = vsnprintf(NULL, 0, fmt, args);
  va_end(args);
  if (needed < 0) {
    return NULL;
  }

  char *buf = (char *)malloc((size_t)needed + 1);
  if (!buf) {
    return NULL;
  }

  va_start(args, fmt);
  vsnprintf(buf, (size_t)needed + 1, fmt, args);
  va_end(args);
  return buf;
}

static uint64_t gas_used(uint64_t gas_limit, uint64_t gas_remaining) {
  if (gas_limit == JS_GAS_UNLIMITED) {
    return 0;
  }
  return gas_limit - gas_remaining;
}

static char *format_with_gas(const char *kind, const char *payload, uint64_t gas_limit,
                             uint64_t gas_remaining, const JSGasTrace *trace) {
  if (trace) {
    return dup_printf(
        "%s %s GAS remaining=%" PRIu64 " used=%" PRIu64
        " TRACE {\"opcodeCount\":%" PRIu64 ",\"opcodeGas\":%" PRIu64
        ",\"arrayCbBase\":{\"count\":%" PRIu64 ",\"gas\":%" PRIu64
        "},\"arrayCbPerEl\":{\"count\":%" PRIu64 ",\"gas\":%" PRIu64
        "},\"alloc\":{\"count\":%" PRIu64 ",\"bytes\":%" PRIu64 ",\"gas\":%" PRIu64 "}}",
        kind, payload, gas_remaining, gas_used(gas_limit, gas_remaining), trace->opcode_count,
        trace->opcode_gas, trace->builtin_array_cb_base_count, trace->builtin_array_cb_base_gas,
        trace->builtin_array_cb_per_element_count, trace->builtin_array_cb_per_element_gas,
        trace->allocation_count, trace->allocation_bytes, trace->allocation_gas);
  }

  return dup_printf("%s %s GAS remaining=%" PRIu64 " used=%" PRIu64, kind, payload, gas_remaining,
                    gas_used(gas_limit, gas_remaining));
}

static int read_gas_trace(JSContext *ctx, JSGasTrace *trace) {
  if (!trace) {
    return 0;
  }
  return JS_ReadGasTrace(ctx, trace) == 0;
}

static char *format_exception(JSContext *ctx, uint64_t gas_limit, const char *fallback,
                              const JSGasTrace *trace) {
  JSValue exception = JS_GetException(ctx);
  const char *msg = JS_ToCString(ctx, exception);
  uint64_t remaining = JS_GetGasRemaining(ctx);

  const char *payload = msg ? msg : fallback;
  char *out = format_with_gas("ERROR", payload, gas_limit, remaining, trace);

  if (msg) {
    JS_FreeCString(ctx, msg);
  }
  JS_FreeValue(ctx, exception);
  return out;
}

static int run_gc_checkpoint(JSContext *ctx) { return JS_RunGCCheckpoint(ctx); }

static char *hex32(const uint8_t *bytes, size_t length)
{
  static const char *HEX = "0123456789abcdef";
  char *out;

  if (!bytes || length != 32)
    return NULL;

  out = malloc(65);
  if (!out)
    return NULL;

  for (size_t i = 0; i < 32; i++) {
    out[i * 2] = HEX[(bytes[i] >> 4) & 0x0f];
    out[i * 2 + 1] = HEX[bytes[i] & 0x0f];
  }
  out[64] = '\0';
  return out;
}

static char *hex_bytes(const uint8_t *bytes, size_t length)
{
  static const char *HEX = "0123456789abcdef";
  char *out;

  if (length > 0 && !bytes)
    return NULL;

  out = malloc((length * 2) + 1);
  if (!out)
    return NULL;

  for (size_t i = 0; i < length; i++) {
    out[i * 2] = HEX[(bytes[i] >> 4) & 0x0f];
    out[i * 2 + 1] = HEX[bytes[i] & 0x0f];
  }
  out[length * 2] = '\0';
  return out;
}

static int js_set_prop(JSContext *ctx, JSValue obj, const char *name, JSValue val)
{
  if (JS_IsException(val))
    return -1;
  if (JS_DefinePropertyValueStr(ctx, obj, name, val,
                                JS_PROP_C_W_E) < 0) {
    JS_FreeValue(ctx, val);
    return -1;
  }
  return 0;
}

EMSCRIPTEN_KEEPALIVE
char *qjs_det_init(const uint8_t *manifest_bytes,
                   uint32_t manifest_size,
                   const char *manifest_hash_hex,
                   const uint8_t *context_blob,
                   uint32_t context_blob_size,
                   uint64_t gas_limit) {
  free_det_runtime();
  det_gas_limit = gas_limit;

  if (JS_NewDeterministicRuntime(&det_rt, &det_ctx) != 0) {
    return dup_printf("ERROR <init> GAS remaining=0 used=0");
  }

  if (JS_SetHostCallDispatcher(det_rt, wasm_host_call, NULL) != 0) {
    free_det_runtime();
    return dup_printf("ERROR <host dispatcher> GAS remaining=0 used=0");
  }

  JSDeterministicInitOptions opts = {
      .manifest_bytes = manifest_bytes,
      .manifest_size = manifest_size,
      .manifest_hash_hex = manifest_hash_hex,
      .context_blob = context_blob,
      .context_blob_size = context_blob_size,
      .gas_limit = gas_limit,
  };

  if (JS_InitDeterministicContext(det_ctx, &opts) != 0) {
    char *out = format_exception(det_ctx, det_gas_limit, "<init>", NULL);
    free_det_runtime();
    return out;
  }

  if (run_gc_checkpoint(det_ctx) != 0) {
    char *out = format_exception(det_ctx, det_gas_limit, "<gc checkpoint>", NULL);
    free_det_runtime();
    return out;
  }

  return NULL;
}

EMSCRIPTEN_KEEPALIVE
char *qjs_det_eval(const char *code) {
  if (!det_ctx || !det_rt) {
    return dup_printf("ERROR <uninitialized> GAS remaining=0 used=0");
  }

  if (run_gc_checkpoint(det_ctx) != 0) {
    return format_exception(det_ctx, det_gas_limit, "<gc checkpoint>", NULL);
  }

  JSValue result = JS_Eval(det_ctx, code, strlen(code), "<eval>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(result)) {
    JS_FreeValue(det_ctx, result);
    return format_exception(det_ctx, det_gas_limit, "<exception>", NULL);
  }

  JSDvBuffer dv = {0};
  if (JS_EncodeDV(det_ctx, result, &JS_DV_LIMIT_DEFAULTS, &dv) != 0) {
    JS_FreeValue(det_ctx, result);
    char *out = format_exception(det_ctx, det_gas_limit, "<dv encode>", NULL);
    JS_FreeDVBuffer(det_ctx, &dv);
    return out;
  }

  JS_FreeValue(det_ctx, result);

  if (run_gc_checkpoint(det_ctx) != 0) {
    JS_FreeDVBuffer(det_ctx, &dv);
    return format_exception(det_ctx, det_gas_limit, "<gc checkpoint>", NULL);
  }

  char *hex = hex_bytes(dv.data, dv.length);
  JS_FreeDVBuffer(det_ctx, &dv);
  if (!hex) {
    uint64_t remaining = JS_GetGasRemaining(det_ctx);
    return format_with_gas("ERROR", "<dv encode>", det_gas_limit, remaining, NULL);
  }

  uint64_t remaining = JS_GetGasRemaining(det_ctx);
  char *out = format_with_gas("RESULT", hex, det_gas_limit, remaining, NULL);
  free(hex);
  return out;
}

EMSCRIPTEN_KEEPALIVE
int qjs_det_set_gas_limit(uint64_t gas_limit) {
  if (!det_ctx || !det_rt) {
    return -1;
  }

  det_gas_limit = gas_limit;
  JS_SetGasLimit(det_ctx, gas_limit);
  return 0;
}

EMSCRIPTEN_KEEPALIVE
void qjs_det_free(void) { free_det_runtime(); }

EMSCRIPTEN_KEEPALIVE
int qjs_det_enable_tape(uint32_t capacity)
{
  if (!det_ctx || !det_rt)
    return -1;

  return JS_EnableHostTape(det_ctx, capacity);
}

EMSCRIPTEN_KEEPALIVE
char *qjs_det_read_tape(void)
{
  JSHostTapeRecord *records = NULL;
  size_t count = 0;
  size_t to_read = 0;
  JSValue arr = JS_UNDEFINED;
  JSValue json = JS_UNDEFINED;
  const char *json_str = NULL;
  char *out = NULL;

  if (!det_ctx || !det_rt)
    return dup_printf("[]");

  count = JS_GetHostTapeLength(det_ctx);
  if (count == 0)
    return dup_printf("[]");

  to_read = count > JS_HOST_TAPE_MAX_CAPACITY ? JS_HOST_TAPE_MAX_CAPACITY : count;
  records = js_mallocz(det_ctx, sizeof(JSHostTapeRecord) * to_read);
  if (!records)
    return dup_printf("[]");

  if (JS_ReadHostTape(det_ctx, records, to_read, &count) != 0) {
    js_free(det_ctx, records);
    return dup_printf("[]");
  }

  arr = JS_NewArray(det_ctx);
  if (JS_IsException(arr))
    goto done;

  for (size_t i = 0; i < count; i++) {
    JSValue obj = JS_NewObjectProto(det_ctx, JS_NULL);
    char *req_hex = NULL;
    char *resp_hex = NULL;
    char gas_pre_buf[32];
    char gas_post_buf[32];

    if (JS_IsException(obj))
      goto loop_error;

    if (js_set_prop(det_ctx, obj, "fnId", JS_NewUint32(det_ctx, records[i].fn_id)) < 0)
      goto loop_error;
    if (js_set_prop(det_ctx, obj, "reqLen", JS_NewUint32(det_ctx, records[i].req_len)) < 0)
      goto loop_error;
    if (js_set_prop(det_ctx, obj, "respLen", JS_NewUint32(det_ctx, records[i].resp_len)) < 0)
      goto loop_error;
    if (js_set_prop(det_ctx, obj, "units", JS_NewUint32(det_ctx, records[i].units)) < 0)
      goto loop_error;
    snprintf(gas_pre_buf, sizeof(gas_pre_buf), "%" PRIu64, records[i].gas_pre);
    snprintf(gas_post_buf, sizeof(gas_post_buf), "%" PRIu64, records[i].gas_post);
    if (js_set_prop(det_ctx, obj, "gasPre", JS_NewString(det_ctx, gas_pre_buf)) < 0)
      goto loop_error;
    if (js_set_prop(det_ctx, obj, "gasPost", JS_NewString(det_ctx, gas_post_buf)) < 0)
      goto loop_error;
    if (js_set_prop(det_ctx, obj, "isError", JS_NewBool(det_ctx, records[i].is_error)) < 0)
      goto loop_error;
    if (js_set_prop(det_ctx, obj, "chargeFailed", JS_NewBool(det_ctx, records[i].charge_failed)) < 0)
      goto loop_error;

    req_hex = hex32(records[i].req_hash, sizeof(records[i].req_hash));
    resp_hex = hex32(records[i].resp_hash, sizeof(records[i].resp_hash));
    if (!req_hex || !resp_hex) {
      if (req_hex)
        free(req_hex);
      if (resp_hex)
        free(resp_hex);
      goto loop_error;
    }

    if (js_set_prop(det_ctx, obj, "reqHash", JS_NewString(det_ctx, req_hex)) < 0) {
      free(req_hex);
      free(resp_hex);
      goto loop_error;
    }
    if (js_set_prop(det_ctx, obj, "respHash", JS_NewString(det_ctx, resp_hex)) < 0) {
      free(req_hex);
      free(resp_hex);
      goto loop_error;
    }

    free(req_hex);
    free(resp_hex);

    if (JS_SetPropertyUint32(det_ctx, arr, (uint32_t)i, obj) < 0) {
      JS_FreeValue(det_ctx, obj);
      goto done;
    }

    continue;

  loop_error:
    JS_FreeValue(det_ctx, obj);
    goto done;
  }

  json = JS_JSONStringify(det_ctx, arr, JS_UNDEFINED, JS_UNDEFINED);
  if (JS_IsException(json))
    goto done;

  json_str = JS_ToCString(det_ctx, json);
  if (!json_str)
    goto done;

  out = dup_printf("%s", json_str);
  JS_FreeCString(det_ctx, json_str);

done:
  if (records)
    js_free(det_ctx, records);
  if (!JS_IsUndefined(arr))
    JS_FreeValue(det_ctx, arr);
  if (!JS_IsUndefined(json))
    JS_FreeValue(det_ctx, json);

  if (!out)
    return dup_printf("[]");
  return out;
}

EMSCRIPTEN_KEEPALIVE
int qjs_det_enable_trace(int enabled)
{
  if (!det_ctx || !det_rt)
    return -1;

  if (JS_EnableGasTrace(det_ctx, enabled ? 1 : 0) != 0)
    return -1;

  if (enabled) {
    if (JS_ResetGasTrace(det_ctx) != 0)
      return -1;
  }
  return 0;
}

EMSCRIPTEN_KEEPALIVE
char *qjs_det_read_trace(void)
{
  JSGasTrace trace = {0};

  if (det_ctx && det_rt) {
    if (JS_ReadGasTrace(det_ctx, &trace) != 0) {
      memset(&trace, 0, sizeof(trace));
    }
  }

  return dup_printf(
      "{\"opcodeCount\":\"%" PRIu64 "\",\"opcodeGas\":\"%" PRIu64
      "\",\"arrayCbBaseCount\":\"%" PRIu64 "\",\"arrayCbBaseGas\":\"%" PRIu64
      "\",\"arrayCbPerElCount\":\"%" PRIu64
      "\",\"arrayCbPerElGas\":\"%" PRIu64
      "\",\"allocationCount\":\"%" PRIu64 "\",\"allocationBytes\":\"%" PRIu64
      "\",\"allocationGas\":\"%" PRIu64 "\"}",
      trace.opcode_count, trace.opcode_gas, trace.builtin_array_cb_base_count,
      trace.builtin_array_cb_base_gas, trace.builtin_array_cb_per_element_count,
      trace.builtin_array_cb_per_element_gas, trace.allocation_count,
      trace.allocation_bytes, trace.allocation_gas);
}

EMSCRIPTEN_KEEPALIVE
char *qjs_eval(const char *code, uint64_t gas_limit) {
  JSRuntime *rt = NULL;
  JSContext *ctx = NULL;
  char *output = NULL;
  JSGasTrace trace = {0};
  int trace_enabled = 0;

  if (JS_NewDeterministicRuntime(&rt, &ctx) != 0) {
    return dup_printf("ERROR <init> GAS remaining=0 used=0");
  }

  JS_SetGasLimit(ctx, gas_limit);
  trace_enabled = (JS_EnableGasTrace(ctx, 1) == 0);

  if (run_gc_checkpoint(ctx) != 0) {
    const JSGasTrace *trace_ptr =
        trace_enabled && read_gas_trace(ctx, &trace) ? &trace : NULL;
    output = format_exception(ctx, gas_limit, "<gc checkpoint>", trace_ptr);
    goto cleanup;
  }

  JSValue result = JS_Eval(ctx, code, strlen(code), "<eval>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(result)) {
    JS_FreeValue(ctx, result);
    if (run_gc_checkpoint(ctx) != 0) {
      const JSGasTrace *trace_ptr =
          trace_enabled && read_gas_trace(ctx, &trace) ? &trace : NULL;
      output = format_exception(ctx, gas_limit, "<gc checkpoint>", trace_ptr);
      goto cleanup;
    }
    const JSGasTrace *trace_ptr = trace_enabled && read_gas_trace(ctx, &trace) ? &trace : NULL;
    output = format_exception(ctx, gas_limit, "<exception>", trace_ptr);
    goto cleanup;
  }

  JSValue json = JS_JSONStringify(ctx, result, JS_UNDEFINED, JS_UNDEFINED);
  JS_FreeValue(ctx, result);

  if (JS_IsException(json)) {
    if (run_gc_checkpoint(ctx) != 0) {
      const JSGasTrace *trace_ptr =
          trace_enabled && read_gas_trace(ctx, &trace) ? &trace : NULL;
      output = format_exception(ctx, gas_limit, "<gc checkpoint>", trace_ptr);
      goto cleanup;
    }
    const JSGasTrace *trace_ptr = trace_enabled && read_gas_trace(ctx, &trace) ? &trace : NULL;
    output = format_exception(ctx, gas_limit, "<stringify>", trace_ptr);
    JS_FreeValue(ctx, json);
    goto cleanup;
  }

  const char *json_str = JS_ToCString(ctx, json);
  if (!json_str) {
    uint64_t remaining = JS_GetGasRemaining(ctx);
    const JSGasTrace *trace_ptr = trace_enabled && read_gas_trace(ctx, &trace) ? &trace : NULL;
    output = format_with_gas("ERROR", "<stringify>", gas_limit, remaining, trace_ptr);
    JS_FreeValue(ctx, json);
    goto cleanup;
  }

  if (run_gc_checkpoint(ctx) != 0) {
    const JSGasTrace *trace_ptr =
        trace_enabled && read_gas_trace(ctx, &trace) ? &trace : NULL;
    output = format_exception(ctx, gas_limit, "<gc checkpoint>", trace_ptr);
    JS_FreeCString(ctx, json_str);
    JS_FreeValue(ctx, json);
    goto cleanup;
  }

  uint64_t remaining = JS_GetGasRemaining(ctx);
  const JSGasTrace *trace_ptr = trace_enabled && read_gas_trace(ctx, &trace) ? &trace : NULL;
  output = format_with_gas("RESULT", json_str, gas_limit, remaining, trace_ptr);

  JS_FreeCString(ctx, json_str);
  JS_FreeValue(ctx, json);

cleanup:
  if (ctx) {
    JS_FreeContext(ctx);
  }
  if (rt) {
    JS_FreeRuntime(rt);
  }
  if (!output) {
    return dup_printf("ERROR <internal> GAS remaining=0 used=0");
  }
  return output;
}

EMSCRIPTEN_KEEPALIVE
void qjs_free_output(char *ptr) {
  if (ptr) {
    free(ptr);
  }
}

#include "quickjs.h"
#include <emscripten/emscripten.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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

EMSCRIPTEN_KEEPALIVE
char *qjs_eval(const char *code, uint64_t gas_limit) {
  JSRuntime *rt = NULL;
  JSContext *ctx = NULL;
  char *output = NULL;
  JSGasTrace trace;
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

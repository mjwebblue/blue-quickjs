#include "quickjs.h"
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
  const char *dump_global;
} HarnessOptions;

static int init_runtime(HarnessRuntime *runtime) {
  if (JS_NewDeterministicRuntime(&runtime->rt, &runtime->ctx) != 0) {
    fprintf(stderr, "init: JS_NewDeterministicRuntime failed\n");
    return 1;
  }

  return 0;
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

static void print_gas_suffix(JSContext *ctx, const HarnessOptions *options) {
  if (!options->report_gas) {
    return;
  }

  uint64_t remaining = JS_GetGasRemaining(ctx);
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

static int print_exception(JSContext *ctx, const HarnessOptions *options) {
  JSValue exception = JS_GetException(ctx);
  const char *msg = JS_ToCString(ctx, exception);
  if (msg) {
    fprintf(stdout, "ERROR %s", msg);
    print_gas_suffix(ctx, options);
    print_state_suffix(ctx, options);
    fprintf(stdout, "\n");
    JS_FreeCString(ctx, msg);
  } else {
    fprintf(stdout, "ERROR <exception>\n");
  }
  JS_FreeValue(ctx, exception);
  return 1;
}

static int eval_source(JSContext *ctx, const char *code, const HarnessOptions *options) {
  JSValue result = JS_Eval(ctx, code, strlen(code), "<eval>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(result)) {
    JS_FreeValue(ctx, result);
    return print_exception(ctx, options);
  }

  JSValue json = JS_JSONStringify(ctx, result, JS_UNDEFINED, JS_UNDEFINED);
  JS_FreeValue(ctx, result);

  if (JS_IsException(json)) {
    return print_exception(ctx, options);
  }

  const char *json_str = JS_ToCString(ctx, json);
  if (!json_str) {
    JS_FreeValue(ctx, json);
    fprintf(stdout, "ERROR <stringify>\n");
    return 1;
  }

  fprintf(stdout, "RESULT %s", json_str);
  print_gas_suffix(ctx, options);
  print_state_suffix(ctx, options);
  fprintf(stdout, "\n");

  JS_FreeCString(ctx, json_str);
  JS_FreeValue(ctx, json);
  return 0;
}

static void print_usage(const char *prog) {
  fprintf(stderr,
          "Usage: %s [--gas-limit <u64>] [--report-gas] [--dump-global <name>] --eval \"<js-source>\"\n",
          prog);
}

static int parse_args(int argc, char **argv, HarnessOptions *opts) {
  opts->code = NULL;
  opts->gas_limit = JS_GAS_UNLIMITED;
  opts->report_gas = 0;
  opts->dump_global = NULL;

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

  HarnessRuntime runtime = {0};

  if (init_runtime(&runtime) != 0) {
    free_runtime(&runtime);
    return 1;
  }

  JS_SetGasLimit(runtime.ctx, options.gas_limit);

  int rc = eval_source(runtime.ctx, options.code, &options);
  free_runtime(&runtime);
  return rc;
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type QuickjsWasmVariant = 'wasm32' | 'wasm64';

export const QUICKJS_WASM_BASENAME = 'quickjs-eval.wasm';
export const QUICKJS_WASM_LOADER_BASENAME = 'quickjs-eval.js';
export const QUICKJS_WASM64_BASENAME = 'quickjs-eval-wasm64.wasm';
export const QUICKJS_WASM64_LOADER_BASENAME = 'quickjs-eval-wasm64.js';

const artifactDir = path.resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
  'dist',
);

const ARTIFACTS: Record<QuickjsWasmVariant, { wasm: string; loader: string }> =
  {
    wasm32: {
      wasm: QUICKJS_WASM_BASENAME,
      loader: QUICKJS_WASM_LOADER_BASENAME,
    },
    wasm64: {
      wasm: QUICKJS_WASM64_BASENAME,
      loader: QUICKJS_WASM64_LOADER_BASENAME,
    },
  };

export function getQuickjsWasmArtifacts(
  variant: QuickjsWasmVariant = 'wasm32',
) {
  const entry = ARTIFACTS[variant];
  return {
    wasmPath: path.join(artifactDir, entry.wasm),
    loaderPath: path.join(artifactDir, entry.loader),
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUICKJS_WASM64_BASENAME,
  QUICKJS_WASM64_DEBUG_BASENAME,
  QUICKJS_WASM64_DEBUG_LOADER_BASENAME,
  QUICKJS_WASM64_LOADER_BASENAME,
  QUICKJS_WASM_BASENAME,
  QUICKJS_WASM_DEBUG_BASENAME,
  QUICKJS_WASM_DEBUG_LOADER_BASENAME,
  QUICKJS_WASM_LOADER_BASENAME,
  QUICKJS_WASM_METADATA_BASENAME,
  type QuickjsWasmBuildMetadata,
  type QuickjsWasmBuildType,
  type QuickjsWasmVariant,
} from './quickjs-wasm-constants.js';

function resolveArtifactDir(): string {
  const baseUrl = new URL('../..', import.meta.url);
  if (baseUrl.protocol === 'file:') {
    return path.resolve(fileURLToPath(baseUrl), 'dist');
  }
  // In browser-ish bundler contexts (vitest/jsdom) import.meta.url can be http(s),
  // so fall back to the workspace-relative dist path.
  return path.resolve(process.cwd(), 'libs/quickjs-wasm-build/dist');
}

const artifactDir = resolveArtifactDir();

const ARTIFACTS: Record<
  QuickjsWasmVariant,
  Record<QuickjsWasmBuildType, { wasm: string; loader: string }>
> = {
  wasm32: {
    release: {
      wasm: QUICKJS_WASM_BASENAME,
      loader: QUICKJS_WASM_LOADER_BASENAME,
    },
    debug: {
      wasm: QUICKJS_WASM_DEBUG_BASENAME,
      loader: QUICKJS_WASM_DEBUG_LOADER_BASENAME,
    },
  },
  wasm64: {
    release: {
      wasm: QUICKJS_WASM64_BASENAME,
      loader: QUICKJS_WASM64_LOADER_BASENAME,
    },
    debug: {
      wasm: QUICKJS_WASM64_DEBUG_BASENAME,
      loader: QUICKJS_WASM64_DEBUG_LOADER_BASENAME,
    },
  },
};

export function getQuickjsWasmArtifacts(
  variant: QuickjsWasmVariant = 'wasm32',
  buildType: QuickjsWasmBuildType = 'release',
) {
  const entry = ARTIFACTS[variant][buildType];
  return {
    wasmPath: path.join(artifactDir, entry.wasm),
    loaderPath: path.join(artifactDir, entry.loader),
  };
}

export function getQuickjsWasmMetadataPath() {
  return path.join(artifactDir, QUICKJS_WASM_METADATA_BASENAME);
}

export function readQuickjsWasmMetadata(
  metadataPath: string = getQuickjsWasmMetadataPath(),
): QuickjsWasmBuildMetadata {
  if (!fs.existsSync(metadataPath)) {
    throw new Error(
      `QuickJS wasm metadata not found at ${metadataPath}. Did you run pnpm nx build quickjs-wasm-build?`,
    );
  }
  const raw = fs.readFileSync(metadataPath, 'utf8');
  return JSON.parse(raw) as QuickjsWasmBuildMetadata;
}

export {
  QUICKJS_WASM_BASENAME,
  QUICKJS_WASM_LOADER_BASENAME,
  QUICKJS_WASM_DEBUG_BASENAME,
  QUICKJS_WASM_DEBUG_LOADER_BASENAME,
  QUICKJS_WASM64_BASENAME,
  QUICKJS_WASM64_LOADER_BASENAME,
  QUICKJS_WASM64_DEBUG_BASENAME,
  QUICKJS_WASM64_DEBUG_LOADER_BASENAME,
  QUICKJS_WASM_METADATA_BASENAME,
};

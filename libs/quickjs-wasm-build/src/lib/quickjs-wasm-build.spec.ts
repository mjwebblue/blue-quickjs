import path from 'node:path';

import {
  QUICKJS_WASM_BASENAME,
  QUICKJS_WASM_LOADER_BASENAME,
  QUICKJS_WASM64_BASENAME,
  QUICKJS_WASM64_LOADER_BASENAME,
  getQuickjsWasmArtifacts,
} from './quickjs-wasm-build.js';

describe('getQuickjsWasmArtifacts', () => {
  const normalize = (p: string) => p.split(path.sep).join('/');

  it('returns stable dist paths (wasm32 default)', () => {
    const artifacts = getQuickjsWasmArtifacts();
    const wasm = normalize(artifacts.wasmPath);
    const loader = normalize(artifacts.loaderPath);

    expect(wasm).toMatch(/libs\/quickjs-wasm-build\/dist\/quickjs-eval\.wasm$/);
    expect(loader).toMatch(/libs\/quickjs-wasm-build\/dist\/quickjs-eval\.js$/);
  });

  it('returns stable dist paths (wasm64)', () => {
    const artifacts = getQuickjsWasmArtifacts('wasm64');
    const wasm = normalize(artifacts.wasmPath);
    const loader = normalize(artifacts.loaderPath);

    expect(wasm).toMatch(
      /libs\/quickjs-wasm-build\/dist\/quickjs-eval-wasm64\.wasm$/,
    );
    expect(loader).toMatch(
      /libs\/quickjs-wasm-build\/dist\/quickjs-eval-wasm64\.js$/,
    );
  });

  it('exports the artifact basenames', () => {
    expect(QUICKJS_WASM_BASENAME).toBe('quickjs-eval.wasm');
    expect(QUICKJS_WASM_LOADER_BASENAME).toBe('quickjs-eval.js');
    expect(QUICKJS_WASM64_BASENAME).toBe('quickjs-eval-wasm64.wasm');
    expect(QUICKJS_WASM64_LOADER_BASENAME).toBe('quickjs-eval-wasm64.js');
  });
});

/// <reference types='vitest' />
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as path from 'path';
import { defineConfig, Plugin, type ResolvedConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { type QuickjsWasmBuildMetadata } from '@blue-quickjs/quickjs-wasm-build';

const QUICKJS_WASM_METADATA_BASENAME = 'quickjs-wasm-build.metadata.json';
const WASM_BUILD_DIST = path.resolve(
  import.meta.dirname,
  '../quickjs-wasm-build/dist',
);

function copyWasmArtifactsPlugin(): Plugin {
  let outDir: string | null = null;
  let metadata: QuickjsWasmBuildMetadata | null = null;

  return {
    name: 'quickjs-wasm-artifacts',
    apply: 'build',
    configResolved(resolved: ResolvedConfig) {
      outDir = path.resolve(resolved.root, resolved.build.outDir ?? 'dist');
    },
    buildStart() {
      const metadataPath = path.join(
        WASM_BUILD_DIST,
        QUICKJS_WASM_METADATA_BASENAME,
      );
      if (!fs.existsSync(metadataPath)) {
        throw new Error(
          `QuickJS wasm metadata missing at ${metadataPath}. Run "pnpm nx build quickjs-wasm-build" before building quickjs-wasm.`,
        );
      }
      const raw = fs.readFileSync(metadataPath, 'utf8');
      metadata = JSON.parse(raw) as QuickjsWasmBuildMetadata;
    },
    async writeBundle() {
      if (!outDir) {
        throw new Error('quickjs-wasm output directory was not resolved.');
      }
      if (!metadata) {
        throw new Error('quickjs-wasm metadata was not loaded before bundle.');
      }

      const destDir = path.join(outDir, 'wasm');
      await fsp.rm(destDir, { recursive: true, force: true });
      await fsp.mkdir(destDir, { recursive: true });

      const copyArtifact = async (filename: string) => {
        const sourcePath = path.join(WASM_BUILD_DIST, filename);
        if (!fs.existsSync(sourcePath)) {
          throw new Error(
            `Expected QuickJS wasm artifact "${filename}" was not found in ${WASM_BUILD_DIST}.`,
          );
        }
        await fsp.copyFile(sourcePath, path.join(destDir, filename));
      };

      await copyArtifact(QUICKJS_WASM_METADATA_BASENAME);
      for (const builds of Object.values(metadata.variants ?? {})) {
        if (!builds) continue;
        for (const variant of Object.values(builds ?? {})) {
          if (!variant) continue;
          await copyArtifact(variant.wasm.filename);
          await copyArtifact(variant.loader.filename);
        }
      }
    },
  };
}

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/quickjs-wasm',
  plugins: [
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(import.meta.dirname, 'tsconfig.lib.json'),
    }),
    copyWasmArtifactsPlugin(),
  ],
  // Uncomment this if you are using workers.
  // worker: {
  //  plugins: [],
  // },
  // Configuration for building your library.
  // See: https://vite.dev/guide/build.html#library-mode
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      // Could also be a dictionary or array of multiple entry points.
      entry: 'src/index.ts',
      name: 'quickjs-wasm',
      fileName: 'index',
      // Change this to the formats you want to support.
      // Don't forget to update your package.json as well.
      formats: ['es' as const],
    },
    rollupOptions: {
      // External packages that should not be bundled into your library.
      external: ['node:fs/promises', 'node:url'],
    },
  },
  test: {
    name: 'quickjs-wasm',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));

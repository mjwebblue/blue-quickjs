import {
  QUICKJS_WASM64_BASENAME,
  QUICKJS_WASM64_LOADER_BASENAME,
  QUICKJS_WASM64_DEBUG_BASENAME,
  QUICKJS_WASM64_DEBUG_LOADER_BASENAME,
  QUICKJS_WASM_BASENAME,
  QUICKJS_WASM_LOADER_BASENAME,
  QUICKJS_WASM_DEBUG_BASENAME,
  QUICKJS_WASM_DEBUG_LOADER_BASENAME,
  QUICKJS_WASM_METADATA_BASENAME,
  type QuickjsWasmBuildMetadata,
  type QuickjsWasmBuildVariantMetadata,
  type QuickjsWasmBuildType,
  type QuickjsWasmVariant,
} from '@blue-quickjs/quickjs-wasm-build';

export interface QuickjsWasmArtifact {
  variant: QuickjsWasmVariant;
  buildType: QuickjsWasmBuildType;
  wasmUrl: URL;
  loaderUrl: URL;
  variantMetadata: QuickjsWasmBuildVariantMetadata;
}

export type {
  QuickjsWasmBuildArtifactInfo,
  QuickjsWasmBuildMetadata,
  QuickjsWasmBuildVariantMetadata,
  QuickjsWasmBuildType,
  QuickjsWasmVariant,
} from '@blue-quickjs/quickjs-wasm-build';

const PACKAGE_WASM_DIR = './wasm';
const FALLBACK_BUILD_DIR = '../../../quickjs-wasm-build/dist';
const DEFAULT_VARIANT: QuickjsWasmVariant = 'wasm32';
const DEFAULT_BUILD_TYPE: QuickjsWasmBuildType = 'release';

const PACKAGE_ASSET_URLS: Record<string, URL> = {
  [QUICKJS_WASM_METADATA_BASENAME]: new URL(
    `${PACKAGE_WASM_DIR}/${QUICKJS_WASM_METADATA_BASENAME}`,
    import.meta.url,
  ),
  [QUICKJS_WASM_BASENAME]: new URL(
    `${PACKAGE_WASM_DIR}/${QUICKJS_WASM_BASENAME}`,
    import.meta.url,
  ),
  [QUICKJS_WASM_LOADER_BASENAME]: new URL(
    `${PACKAGE_WASM_DIR}/${QUICKJS_WASM_LOADER_BASENAME}`,
    import.meta.url,
  ),
  [QUICKJS_WASM_DEBUG_BASENAME]: new URL(
    `${PACKAGE_WASM_DIR}/${QUICKJS_WASM_DEBUG_BASENAME}`,
    import.meta.url,
  ),
  [QUICKJS_WASM_DEBUG_LOADER_BASENAME]: new URL(
    `${PACKAGE_WASM_DIR}/${QUICKJS_WASM_DEBUG_LOADER_BASENAME}`,
    import.meta.url,
  ),
  [QUICKJS_WASM64_BASENAME]: new URL(
    `${PACKAGE_WASM_DIR}/${QUICKJS_WASM64_BASENAME}`,
    import.meta.url,
  ),
  [QUICKJS_WASM64_LOADER_BASENAME]: new URL(
    `${PACKAGE_WASM_DIR}/${QUICKJS_WASM64_LOADER_BASENAME}`,
    import.meta.url,
  ),
  [QUICKJS_WASM64_DEBUG_BASENAME]: new URL(
    `${PACKAGE_WASM_DIR}/${QUICKJS_WASM64_DEBUG_BASENAME}`,
    import.meta.url,
  ),
  [QUICKJS_WASM64_DEBUG_LOADER_BASENAME]: new URL(
    `${PACKAGE_WASM_DIR}/${QUICKJS_WASM64_DEBUG_LOADER_BASENAME}`,
    import.meta.url,
  ),
};

const VARIANT_FILENAMES: Record<
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

export async function loadQuickjsWasmMetadata(): Promise<QuickjsWasmBuildMetadata> {
  const metadataUrl = await resolveArtifactUrl(QUICKJS_WASM_METADATA_BASENAME);
  const raw = await readUrlText(metadataUrl);
  try {
    return JSON.parse(raw) as QuickjsWasmBuildMetadata;
  } catch (error) {
    throw new Error(
      `Failed to parse QuickJS wasm metadata from ${metadataUrl}: ${String(error)}`,
    );
  }
}

export async function getQuickjsWasmArtifact(
  variant: QuickjsWasmVariant = DEFAULT_VARIANT,
  buildType: QuickjsWasmBuildType = DEFAULT_BUILD_TYPE,
  metadata?: QuickjsWasmBuildMetadata,
): Promise<QuickjsWasmArtifact> {
  const resolvedMetadata = metadata ?? (await loadQuickjsWasmMetadata());
  const buildMatrix = resolvedMetadata.variants?.[variant];
  const variantMetadata = buildMatrix?.[buildType];
  if (!variantMetadata) {
    const available =
      buildMatrix && Object.keys(buildMatrix).length > 0
        ? ` Available build types: ${Object.keys(buildMatrix).join(', ')}.`
        : '';
    throw new Error(
      `Wasm variant "${variant}" (${buildType}) is not available.${available} Run "pnpm nx build quickjs-wasm-build" to regenerate artifacts.`,
    );
  }

  const filenames = VARIANT_FILENAMES[variant][buildType];
  const wasmUrl = await resolveArtifactUrl(
    variantMetadata.wasm?.filename ?? filenames.wasm,
  );
  const loaderUrl = await resolveArtifactUrl(
    variantMetadata.loader?.filename ?? filenames.loader,
  );

  return {
    variant,
    buildType,
    wasmUrl,
    loaderUrl,
    variantMetadata,
  };
}

export async function loadQuickjsWasmBinary(
  variant: QuickjsWasmVariant = DEFAULT_VARIANT,
  buildType: QuickjsWasmBuildType = DEFAULT_BUILD_TYPE,
  metadata?: QuickjsWasmBuildMetadata,
): Promise<Uint8Array> {
  const artifact = await getQuickjsWasmArtifact(variant, buildType, metadata);
  return readUrlBinary(artifact.wasmUrl);
}

export async function loadQuickjsWasmLoaderSource(
  variant: QuickjsWasmVariant = DEFAULT_VARIANT,
  buildType: QuickjsWasmBuildType = DEFAULT_BUILD_TYPE,
  metadata?: QuickjsWasmBuildMetadata,
): Promise<string> {
  const artifact = await getQuickjsWasmArtifact(variant, buildType, metadata);
  return readUrlText(artifact.loaderUrl);
}

export function listAvailableQuickjsWasmVariants(
  metadata: QuickjsWasmBuildMetadata,
): QuickjsWasmVariant[] {
  return Object.keys(metadata.variants ?? {}) as QuickjsWasmVariant[];
}

export function listAvailableQuickjsWasmBuildTypes(
  metadata: QuickjsWasmBuildMetadata,
  variant: QuickjsWasmVariant,
): QuickjsWasmBuildType[] {
  return Object.keys(
    metadata.variants?.[variant] ?? {},
  ) as QuickjsWasmBuildType[];
}

export function listAvailableQuickjsWasmBuildTargets(
  metadata: QuickjsWasmBuildMetadata,
): Array<{ variant: QuickjsWasmVariant; buildType: QuickjsWasmBuildType }> {
  const entries: Array<{
    variant: QuickjsWasmVariant;
    buildType: QuickjsWasmBuildType;
  }> = [];
  const variants = metadata.variants ?? {};
  for (const variant of Object.keys(variants) as QuickjsWasmVariant[]) {
    for (const buildType of Object.keys(
      variants[variant] ?? {},
    ) as QuickjsWasmBuildType[]) {
      entries.push({ variant, buildType });
    }
  }
  return entries;
}

async function resolveArtifactUrl(filename: string): Promise<URL> {
  const packageUrl = getPackageAssetUrl(filename);
  if (!isFileUrl(packageUrl) || (await fileExists(packageUrl))) {
    return packageUrl;
  }

  const fallbackUrl = new URL(
    `${FALLBACK_BUILD_DIR}/${filename}`,
    import.meta.url,
  );
  if (await fileExists(fallbackUrl)) {
    return fallbackUrl;
  }

  throw new Error(
    `QuickJS wasm artifact "${filename}" is missing. Run "pnpm nx build quickjs-wasm-build" to generate wasm artifacts before building quickjs-wasm.`,
  );
}

function getPackageAssetUrl(filename: string): URL {
  const known = PACKAGE_ASSET_URLS[filename];
  if (known) {
    return known;
  }
  return new URL(`${PACKAGE_WASM_DIR}/${filename}`, import.meta.url);
}

async function fileExists(url: URL): Promise<boolean> {
  if (!isFileUrl(url)) {
    return false;
  }
  try {
    const { access } = await import('node:fs/promises');
    await access(await toFilePath(url));
    return true;
  } catch {
    return false;
  }
}

function isFileUrl(url: URL) {
  return url.protocol === 'file:';
}

async function readUrlBinary(url: URL): Promise<Uint8Array> {
  if (isFileUrl(url)) {
    const { readFile } = await import('node:fs/promises');
    const buffer = await readFile(await toFilePath(url));
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  if (typeof fetch !== 'function') {
    throw new Error(
      `Cannot load QuickJS wasm artifact from ${url.toString()}: fetch is not available in this environment.`,
    );
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch QuickJS wasm artifact from ${url.toString()}: ${response.status} ${response.statusText}`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

async function readUrlText(url: URL): Promise<string> {
  const bytes = await readUrlBinary(url);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(bytes);
}

async function toFilePath(url: URL): Promise<string> {
  try {
    const { fileURLToPath } = await import('node:url');
    return fileURLToPath(url);
  } catch (error) {
    throw new Error(
      `Unable to resolve file path for ${url.toString()}: ${String(error)}`,
    );
  }
}

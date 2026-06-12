const DEFAULT_BROWSER_VENDOR_MODULE_URL = '/vendor/occt-kernel/dist/sketch-toolkit.mjs';
const DEFAULT_BROWSER_LOCAL_MODULE_URL = new URL('../../../node_modules/occt-kernel-wasm/dist/sketch-toolkit.mjs', import.meta.url)
  .href;
const DEFAULT_BROWSER_CDN_MODULE_URL = 'https://cdn.jsdelivr.net/npm/occt-kernel-wasm/dist/sketch-toolkit.mjs';

let cachedToolkit = null;
let cachedModule = null;
let cachedLoadError = null;
let cachedPromise = null;

function isNodeRuntime() {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

function getCreateSketchToolkit(imported) {
  if (typeof imported?.createSketchToolkit === 'function') return imported.createSketchToolkit;
  if (typeof imported?.default?.createSketchToolkit === 'function') return imported.default.createSketchToolkit;
  if (typeof imported?.default === 'function') return imported.default;
  return null;
}

async function loadNodeModuleCandidates() {
  const { existsSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const siblingDistModule = path.resolve(currentDir, '../../../../occt-kernel-wasm/dist/sketch-toolkit.js');
  const candidates = [];

  if (existsSync(siblingDistModule)) {
    candidates.push(pathToFileURL(siblingDistModule).href);
  }

  candidates.push('occt-kernel-wasm/sketch-toolkit');
  return candidates;
}

async function loadNodeSketchToolkit() {
  const candidates = await loadNodeModuleCandidates();
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const imported = await import(candidate);
      const createSketchToolkit = getCreateSketchToolkit(imported);
      if (typeof createSketchToolkit !== 'function') {
        throw new Error(`Module did not expose createSketchToolkit: ${candidate}`);
      }
      cachedModule = imported;
      return await createSketchToolkit();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Failed to load the mandatory sketch toolkit in Node.js');
}

async function loadBrowserSketchToolkit() {
  const candidates = [
    DEFAULT_BROWSER_VENDOR_MODULE_URL,
    DEFAULT_BROWSER_LOCAL_MODULE_URL,
    DEFAULT_BROWSER_CDN_MODULE_URL,
  ];
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const imported = await import(/* @vite-ignore */ candidate);
      const createSketchToolkit = getCreateSketchToolkit(imported);
      if (typeof createSketchToolkit !== 'function') {
        throw new Error(`Module did not expose createSketchToolkit: ${candidate}`);
      }
      cachedModule = imported;
      return await createSketchToolkit();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Failed to load the mandatory sketch toolkit in this browser runtime');
}

export async function loadSketchToolkit() {
  if (cachedToolkit) return cachedToolkit;
  if (cachedPromise) return cachedPromise;

  cachedPromise = (async () => {
    try {
      cachedToolkit = isNodeRuntime()
        ? await loadNodeSketchToolkit()
        : await loadBrowserSketchToolkit();
      cachedLoadError = null;
      return cachedToolkit;
    } catch (error) {
      cachedToolkit = null;
      cachedLoadError = error instanceof Error
        ? error
        : new Error(String(error));
      throw cachedLoadError;
    }
  })();

  return cachedPromise;
}

export function getCachedSketchToolkit() {
  return cachedToolkit;
}

export function getCachedSketchToolkitModule() {
  return cachedModule;
}

export function sketchToolkitReadySync() {
  return !!cachedToolkit;
}

export function getSharedSketchToolkitSync() {
  if (cachedToolkit) {
    return cachedToolkit;
  }
  if (cachedLoadError) {
    throw cachedLoadError;
  }
  throw new Error('Sketch toolkit preload has not completed yet');
}

export function getSharedSketchToolkitModuleSync() {
  if (cachedModule) {
    return cachedModule;
  }
  if (cachedLoadError) {
    throw cachedLoadError;
  }
  throw new Error('Sketch toolkit module preload has not completed yet');
}

export function getSketchToolkitLoadError() {
  return cachedLoadError;
}

if (isNodeRuntime()) {
  await loadSketchToolkit().catch(() => null);
}
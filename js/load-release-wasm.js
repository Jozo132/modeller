let cachedModulePromise = null;
let cacheBustCounter = 0;

function loadModule(specifier) {
  return import(specifier);
}

export function isRetryableWasmLoadError(error) {
  if (!error) return false;
  const name = String(error.name || '');
  const message = String(error.message || '');
  return name === 'RuntimeError'
    || name === 'CompileError'
    || name === 'LinkError'
    || /WebAssembly|WASM|unreachable|compile|instantiate/i.test(message);
}

export function invalidateReleaseWasmModuleCache() {
  cachedModulePromise = null;
}

export async function loadReleaseWasmModule(options = {}) {
  const { fresh = false } = options;
  if (!fresh && cachedModulePromise) return cachedModulePromise;

  const specifier = fresh
    ? `../build/release.js?cacheBust=${Date.now()}-${++cacheBustCounter}`
    : '../build/release.js';
  const loadFreshModule = () => loadModule(`../build/release.js?cacheBust=${Date.now()}-${++cacheBustCounter}`);
  const loadPromise = fresh ? loadFreshModule() : loadModule(specifier);

  if (!fresh) {
    cachedModulePromise = loadPromise;
  }

  try {
    const mod = await loadPromise;
    if (!fresh) {
      cachedModulePromise = Promise.resolve(mod);
    }
    return mod;
  } catch (error) {
    if (!fresh) {
      cachedModulePromise = null;
      if (isRetryableWasmLoadError(error)) {
        const freshModule = await loadFreshModule();
        cachedModulePromise = Promise.resolve(freshModule);
        return freshModule;
      }
    }
    throw error;
  }
}

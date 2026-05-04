let cachedModulePromise = null;
let cacheBustCounter = 0;
const RELEASE_WASM_MODULE_SPECIFIER = '../build/release.js';

function loadModule(specifier) {
  return import(specifier);
}

function buildFreshSpecifier() {
  return `${RELEASE_WASM_MODULE_SPECIFIER}?cacheBust=${Date.now()}-${++cacheBustCounter}`;
}

function loadFreshModule() {
  return loadModule(buildFreshSpecifier());
}

export function isRetryableWasmLoadError(error) {
  if (!error) return false;
  const name = String(error.name || '');
  const message = String(error.message || '');
  const hasRetryableMessage = /WebAssembly|WASM|wasm|unreachable|compile|instantiate/i.test(message);
  return (name === 'RuntimeError' && hasRetryableMessage)
    || name === 'CompileError'
    || name === 'LinkError'
    || hasRetryableMessage;
}

export function invalidateReleaseWasmModuleCache() {
  cachedModulePromise = null;
}

export async function loadReleaseWasmModule(options = {}) {
  const { fresh = false } = options;
  if (!fresh && cachedModulePromise) return cachedModulePromise;

  const loadPromise = fresh ? loadFreshModule() : loadModule(RELEASE_WASM_MODULE_SPECIFIER);

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
        const retryPromise = loadFreshModule().then((freshModule) => {
          cachedModulePromise = Promise.resolve(freshModule);
          return freshModule;
        }).catch((retryError) => {
          cachedModulePromise = null;
          throw retryError;
        });
        cachedModulePromise = retryPromise;
        return retryPromise;
      }
    }
    throw error;
  }
}

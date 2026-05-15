// js/cad/occt/OcctKernelLoader.js -- optional OCCT WASM loader facade.

const DIST_ENV_KEYS = ['OCCT_KERNEL_DIST', 'CAD_OCCT_KERNEL_DIST'];
const JS_ENV_KEYS = ['OCCT_KERNEL_JS', 'CAD_OCCT_KERNEL_JS'];
const WASM_ENV_KEYS = ['OCCT_KERNEL_WASM', 'CAD_OCCT_KERNEL_WASM'];

let cachedKey = null;
let cachedPromise = null;
let cachedLoaded = null;

function isNodeRuntime() {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

function isBrowserRuntime() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

function readEnv(keys, env = undefined) {
  const source = env || (typeof process !== 'undefined' ? process.env : null);
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (value != null && String(value).trim() !== '') return String(value);
  }
  return null;
}

async function nodeDeps() {
  const [{ createRequire }, fs, path, url] = await Promise.all([
    import('node:module'),
    import('node:fs'),
    import('node:path'),
    import('node:url'),
  ]);
  return { createRequire, fs, path, pathToFileURL: url.pathToFileURL };
}

async function resolveNodePaths(options = {}) {
  const { path } = await nodeDeps();
  const distPath = options.distPath || options.distDir || readEnv(DIST_ENV_KEYS);
  const jsPath = options.jsPath || readEnv(JS_ENV_KEYS)
    || (distPath ? path.join(distPath, 'occt-kernel.js') : null);
  const wasmPath = options.wasmPath || readEnv(WASM_ENV_KEYS)
    || (distPath ? path.join(distPath, 'occt-kernel.wasm') : null);
  return { distPath, jsPath, wasmPath };
}

function resolveBrowserPaths(options = {}) {
  const distUrl = options.distUrl || options.distPath || readEnv(DIST_ENV_KEYS);
  const jsUrl = options.jsUrl || options.jsPath || readEnv(JS_ENV_KEYS)
    || (distUrl ? `${String(distUrl).replace(/\/$/, '')}/occt-kernel.js` : null);
  const wasmUrl = options.wasmUrl || options.wasmPath || readEnv(WASM_ENV_KEYS)
    || (distUrl ? `${String(distUrl).replace(/\/$/, '')}/occt-kernel.wasm` : null);
  return { distUrl, jsUrl, wasmUrl };
}

async function loadNodeFactory(jsPath) {
  if (!jsPath) throw new Error('OCCT loader requires jsPath or OCCT_KERNEL_DIST in Node.js');
  const { createRequire, pathToFileURL } = await nodeDeps();
  const require = createRequire(import.meta.url);
  try {
    return require(jsPath);
  } catch (error) {
    const message = String(error?.message || '');
    if (error?.code !== 'ERR_REQUIRE_ESM' && !message.includes('ES Module')) throw error;
    const imported = await import(pathToFileURL(jsPath).href);
    return imported.default || imported.createOcctKernelModule || imported;
  }
}

async function loadBrowserFactory(jsUrl) {
  if (typeof globalThis.createOcctKernelModule === 'function') {
    return globalThis.createOcctKernelModule;
  }
  if (!jsUrl) throw new Error('OCCT loader requires jsUrl or OCCT_KERNEL_DIST in the browser');
  if (!isBrowserRuntime()) throw new Error('OCCT browser script loading is unavailable outside a DOM runtime');

  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = jsUrl;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load OCCT script: ${jsUrl}`));
    document.head.appendChild(script);
  });

  if (typeof globalThis.createOcctKernelModule !== 'function') {
    throw new Error('OCCT script loaded but did not expose createOcctKernelModule');
  }
  return globalThis.createOcctKernelModule;
}

function normalizeFactory(factory) {
  if (typeof factory === 'function') return factory;
  if (typeof factory?.default === 'function') return factory.default;
  if (typeof factory?.createOcctKernelModule === 'function') return factory.createOcctKernelModule;
  throw new Error('OCCT factory is not callable');
}

function buildCacheKey(options = {}) {
  return JSON.stringify({
    distPath: options.distPath || options.distDir || null,
    distUrl: options.distUrl || null,
    jsPath: options.jsPath || null,
    jsUrl: options.jsUrl || null,
    wasmPath: options.wasmPath || null,
    wasmUrl: options.wasmUrl || null,
    hasFactory: !!options.factory,
    hasWasmBinary: !!options.wasmBinary,
  });
}

async function buildModuleOptions(options, paths) {
  const moduleOptions = {
    print: options.print || (() => {}),
    printErr: options.printErr || (() => {}),
    ...(options.moduleOptions || {}),
  };

  if (options.wasmBinary) {
    moduleOptions.wasmBinary = options.wasmBinary;
  } else if (isNodeRuntime() && paths.wasmPath && options.readWasmBinary !== false) {
    const { fs } = await nodeDeps();
    moduleOptions.wasmBinary = fs.readFileSync(paths.wasmPath);
  }

  if (!moduleOptions.locateFile) {
    if (isNodeRuntime()) {
      const { path } = await nodeDeps();
      moduleOptions.locateFile = (file) => {
        if (paths.wasmPath && file === path.basename(paths.wasmPath)) return paths.wasmPath;
        return paths.distPath ? path.join(paths.distPath, file) : file;
      };
    } else {
      moduleOptions.locateFile = (file) => {
        if (paths.wasmUrl && /\.wasm$/i.test(file)) return paths.wasmUrl;
        return paths.distUrl ? `${String(paths.distUrl).replace(/\/$/, '')}/${file}` : file;
      };
    }
  }

  return moduleOptions;
}

async function loadUncached(options = {}) {
  const paths = isNodeRuntime()
    ? await resolveNodePaths(options)
    : resolveBrowserPaths(options);
  const rawFactory = options.factory || (isNodeRuntime()
    ? await loadNodeFactory(paths.jsPath)
    : await loadBrowserFactory(paths.jsUrl));
  const factory = normalizeFactory(rawFactory);
  const moduleOptions = await buildModuleOptions(options, paths);
  const ready = factory(moduleOptions);
  const module = ready && typeof ready.then === 'function'
    ? await ready
    : (ready?.ready && typeof ready.ready.then === 'function' ? await ready.ready : ready);

  if (!module || typeof module.OcctKernel !== 'function') {
    throw new Error('OCCT module loaded but OcctKernel class is unavailable');
  }

  return { module, factory, paths };
}

export async function loadOcctKernelModule(options = {}) {
  const key = buildCacheKey(options);
  if (!options.fresh && cachedLoaded && cachedKey === key) return Promise.resolve(cachedLoaded);
  if (!options.fresh && cachedPromise && cachedKey === key) return cachedPromise;
  cachedKey = key;
  cachedPromise = loadUncached(options)
    .then((loaded) => {
      if (cachedKey === key) cachedLoaded = loaded;
      return loaded;
    })
    .catch((error) => {
      if (cachedKey === key) {
        cachedKey = null;
        cachedPromise = null;
        cachedLoaded = null;
      }
      throw error;
    });
  return cachedPromise;
}

export function invalidateOcctKernelModuleCache() {
  cachedKey = null;
  cachedPromise = null;
  cachedLoaded = null;
}

export function getCachedOcctKernelModule(options = {}) {
  const key = buildCacheKey(options);
  if (!cachedLoaded || cachedKey !== key) return null;
  return cachedLoaded;
}

export function occtKernelReadySync(options = {}) {
  return !!getCachedOcctKernelModule(options)?.module;
}

export function getOcctKernelStatus(module) {
  const prototype = module?.OcctKernel?.prototype;
  const methodNames = prototype
    ? Object.getOwnPropertyNames(prototype).filter((name) => name !== 'constructor')
    : [];
  return {
    available: typeof module?.OcctKernel === 'function',
    memoryBytes: module?.HEAPU8?.length ?? 0,
    hasCcall: typeof module?.ccall === 'function',
    hasCwrap: typeof module?.cwrap === 'function',
    hasMalloc: typeof module?._malloc === 'function',
    hasFree: typeof module?._free === 'function',
    methodNames,
  };
}

export function resolveOcctKernelEnv() {
  return {
    distPath: readEnv(DIST_ENV_KEYS),
    jsPath: readEnv(JS_ENV_KEYS),
    wasmPath: readEnv(WASM_ENV_KEYS),
  };
}
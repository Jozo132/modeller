// js/cad/occt/OcctKernelLoader.js -- optional OCCT WASM loader facade.

const DIST_ENV_KEYS = ['OCCT_KERNEL_DIST', 'CAD_OCCT_KERNEL_DIST'];
const JS_ENV_KEYS = ['OCCT_KERNEL_JS', 'CAD_OCCT_KERNEL_JS'];
const WASM_ENV_KEYS = ['OCCT_KERNEL_WASM', 'CAD_OCCT_KERNEL_WASM'];
const DEFAULT_BROWSER_LOCAL_DIST_URL = new URL('../../../node_modules/occt-kernel-wasm/dist', import.meta.url)
  .href
  .replace(/\/$/, '');
const DEFAULT_BROWSER_VENDOR_DIST_URL = new URL('../../../vendor/occt-kernel/dist', import.meta.url)
  .href
  .replace(/\/$/, '');
const DEFAULT_BROWSER_CDN_DIST_URL = 'https://cdn.jsdelivr.net/npm/occt-kernel-wasm/dist';
const DEFAULT_BROWSER_DIST_URL = DEFAULT_BROWSER_VENDOR_DIST_URL;
const DEFAULT_NODE_PACKAGE_NAME = 'occt-kernel-wasm';

function normalizeDistLocation(location) {
  return String(location || '').replace(/\/$/, '');
}

function buildBrowserDistPaths(distUrl) {
  const normalizedDistUrl = normalizeDistLocation(distUrl);
  return {
    distUrl: normalizedDistUrl,
    jsUrl: `${normalizedDistUrl}/occt-kernel.js`,
    wasmUrl: `${normalizedDistUrl}/occt-kernel.wasm`,
    apiUrl: `${normalizedDistUrl}/index.mjs`,
  };
}

function uniquePathSets(pathSets = []) {
  const out = [];
  const seen = new Set();
  for (const pathSet of pathSets) {
    if (!pathSet) continue;
    const key = JSON.stringify(pathSet);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pathSet);
  }
  return out;
}

function hasExplicitBrowserPathOverrides(options = {}) {
  return !!(
    options.distUrl
    || options.distPath
    || options.jsUrl
    || options.jsPath
    || options.wasmUrl
    || options.wasmPath
    || options.apiUrl
    || options.wrapperUrl
    || readEnv(DIST_ENV_KEYS)
    || readEnv(JS_ENV_KEYS)
    || readEnv(WASM_ENV_KEYS)
  );
}

function hasExplicitNodePathOverrides(options = {}) {
  return !!(
    options.distPath
    || options.distDir
    || options.jsPath
    || options.wasmPath
    || options.apiPath
    || options.wrapperPath
  );
}
const OCCT_RUNTIME_STATUS_KEY = '__CAD_OCCT_KERNEL_STATUS__';

let cachedKey = null;
let cachedPromise = null;
let cachedLoaded = null;

function isNodeRuntime() {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

function isBrowserRuntime() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

function isWorkerRuntime() {
  return typeof WorkerGlobalScope !== 'undefined'
    && typeof self !== 'undefined'
    && self instanceof WorkerGlobalScope;
}

function getRuntimeLabel() {
  if (isNodeRuntime()) return 'node';
  if (isWorkerRuntime()) return 'worker';
  if (isBrowserRuntime()) return 'browser';
  return 'unknown';
}

function summarizePaths(paths = {}) {
  return {
    dist: paths.distUrl || paths.distPath || null,
    js: paths.jsUrl || paths.jsPath || null,
    wasm: paths.wasmUrl || paths.wasmPath || null,
  };
}

function writeRuntimeStatus(update = {}) {
  const previous = typeof globalThis?.[OCCT_RUNTIME_STATUS_KEY] === 'object' && globalThis[OCCT_RUNTIME_STATUS_KEY]
    ? globalThis[OCCT_RUNTIME_STATUS_KEY]
    : {};
  const next = {
    ...previous,
    ...update,
    runtime: update.runtime || previous.runtime || getRuntimeLabel(),
    updatedAt: new Date().toISOString(),
  };
  if (typeof globalThis !== 'undefined') {
    globalThis[OCCT_RUNTIME_STATUS_KEY] = next;
  }
  return next;
}

function logRuntimeStatus(level, message, status) {
  const logger = globalThis?.console?.[level];
  if (typeof logger === 'function') {
    logger(`[OCCT] ${message}`, status);
  }
}

function publishReadyStatus(loaded, source = 'fresh') {
  const kernelStatus = getOcctKernelStatus(loaded?.module);
  const status = writeRuntimeStatus({
    state: 'ready',
    source,
    paths: summarizePaths(loaded?.paths),
    available: kernelStatus.available,
    memoryBytes: kernelStatus.memoryBytes,
    methodCount: kernelStatus.methodNames.length,
    hasCcall: kernelStatus.hasCcall,
    hasCwrap: kernelStatus.hasCwrap,
    hasMalloc: kernelStatus.hasMalloc,
    hasFree: kernelStatus.hasFree,
  });
  if (source !== 'cache') {
    logRuntimeStatus('info', 'kernel ready', status);
  }
  return status;
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
  return {
    createRequire,
    fs,
    path,
    fileURLToPath: url.fileURLToPath,
    pathToFileURL: url.pathToFileURL,
  };
}

async function resolveWorkspaceSiblingNodePaths() {
  const { fs, path, fileURLToPath } = await nodeDeps();
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const siblingRepoRoot = path.resolve(currentDir, '../../../../occt-kernel-wasm');
  const distPath = path.join(siblingRepoRoot, 'dist');
  const jsPath = path.join(distPath, 'occt-kernel.js');
  const wasmPath = path.join(distPath, 'occt-kernel.wasm');
  const apiPath = path.join(distPath, 'index.js');
  if (!fs.existsSync(jsPath) || !fs.existsSync(wasmPath) || !fs.existsSync(apiPath)) {
    return null;
  }
  return {
    distPath,
    jsPath,
    wasmPath,
    apiPath,
  };
}

async function resolveNodePaths(options = {}) {
  const { path } = await nodeDeps();
  const distPath = options.distPath || options.distDir || readEnv(DIST_ENV_KEYS);
  const jsPath = options.jsPath || readEnv(JS_ENV_KEYS)
    || (distPath ? path.join(distPath, 'occt-kernel.js') : null);
  const wasmPath = options.wasmPath || readEnv(WASM_ENV_KEYS)
    || (distPath ? path.join(distPath, 'occt-kernel.wasm') : null);
  const apiPath = options.apiPath || options.wrapperPath
    || (distPath ? path.join(distPath, 'index.js') : null);
  return { distPath, jsPath, wasmPath, apiPath };
}

async function resolveInstalledNodePackagePaths() {
  const { createRequire, path } = await nodeDeps();
  const require = createRequire(import.meta.url);
  try {
    const jsPath = require.resolve(`${DEFAULT_NODE_PACKAGE_NAME}/occt-kernel.js`);
    const wasmPath = require.resolve(`${DEFAULT_NODE_PACKAGE_NAME}/occt-kernel.wasm`);
    const apiPath = require.resolve(DEFAULT_NODE_PACKAGE_NAME);
    return {
      distPath: path.dirname(jsPath),
      jsPath,
      wasmPath,
      apiPath,
    };
  } catch {
    return null;
  }
}

async function resolveNodePathCandidates(options = {}) {
  const explicitPaths = await resolveNodePaths(options);
  if (hasExplicitNodePathOverrides(options)) {
    return [explicitPaths];
  }

  const workspaceSiblingPaths = await resolveWorkspaceSiblingNodePaths();
  const installedPackagePaths = await resolveInstalledNodePackagePaths();
  return uniquePathSets([
    workspaceSiblingPaths,
    installedPackagePaths,
    explicitPaths,
  ]);
}

function resolveBrowserPaths(options = {}) {
  const distUrl = options.distUrl || options.distPath || readEnv(DIST_ENV_KEYS) || DEFAULT_BROWSER_DIST_URL;
  const jsUrl = options.jsUrl || options.jsPath || readEnv(JS_ENV_KEYS)
    || (distUrl ? `${String(distUrl).replace(/\/$/, '')}/occt-kernel.js` : null);
  const wasmUrl = options.wasmUrl || options.wasmPath || readEnv(WASM_ENV_KEYS)
    || (distUrl ? `${String(distUrl).replace(/\/$/, '')}/occt-kernel.wasm` : null);
  const apiUrl = options.apiUrl || options.wrapperUrl
    || (distUrl ? `${String(distUrl).replace(/\/$/, '')}/index.mjs` : null);
  return { distUrl, jsUrl, wasmUrl, apiUrl };
}

function resolveBrowserPathCandidates(options = {}) {
  if (hasExplicitBrowserPathOverrides(options)) {
    return [resolveBrowserPaths(options)];
  }

  return uniquePathSets([
    buildBrowserDistPaths(DEFAULT_BROWSER_VENDOR_DIST_URL),
    buildBrowserDistPaths(DEFAULT_BROWSER_LOCAL_DIST_URL),
    buildBrowserDistPaths(DEFAULT_BROWSER_CDN_DIST_URL),
  ]);
}

async function loadNodeModule(modulePath) {
  if (!modulePath) throw new Error('OCCT loader requires a module path in Node.js');
  const { createRequire, pathToFileURL } = await nodeDeps();
  const require = createRequire(import.meta.url);
  try {
    return require(modulePath);
  } catch (error) {
    const message = String(error?.message || '');
    if (error?.code !== 'ERR_REQUIRE_ESM' && !message.includes('ES Module')) throw error;
    const imported = await import(pathToFileURL(modulePath).href);
    return imported.default || imported;
  }
}

async function loadNodeFactory(jsPath) {
  if (!jsPath) throw new Error('OCCT loader requires jsPath or OCCT_KERNEL_DIST in Node.js');
  const imported = await loadNodeModule(jsPath);
  return imported.default || imported.createOcctKernelModule || imported;
}

async function loadNodeApiModule(apiPath) {
  if (!apiPath) return null;
  try {
    return await loadNodeModule(apiPath);
  } catch {
    return null;
  }
}

async function loadWorkerFactory(jsUrl) {
  if (typeof fetch !== 'function' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    if (typeof importScripts === 'function') {
      importScripts(jsUrl);
      return globalThis.createOcctKernelModule;
    }
    throw new Error('OCCT worker script loading requires fetch/Blob support');
  }

  const response = await fetch(jsUrl, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`Failed to load OCCT worker script: ${jsUrl}`);
  }

  const source = (await response.text()).replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  const moduleSource = `${source}\nexport default (typeof createOcctKernelModule === 'function' ? createOcctKernelModule : (typeof globalThis.createOcctKernelModule === 'function' ? globalThis.createOcctKernelModule : undefined));\n`;
  const blobUrl = URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' }));

  try {
    const imported = await import(/* @vite-ignore */ blobUrl);
    return imported?.default || imported?.createOcctKernelModule || globalThis.createOcctKernelModule || imported;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function loadBrowserFactory(jsUrl) {
  if (typeof globalThis.createOcctKernelModule === 'function') {
    return globalThis.createOcctKernelModule;
  }
  if (!jsUrl) throw new Error('OCCT loader requires jsUrl or OCCT_KERNEL_DIST in the browser');
  if (isWorkerRuntime()) {
    const factory = await loadWorkerFactory(jsUrl);
    return normalizeFactory(factory);
  }
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

async function loadBrowserApiModule(apiUrl) {
  if (!apiUrl) return null;
  try {
    return await import(/* @vite-ignore */ apiUrl);
  } catch {
    return null;
  }
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
    apiPath: options.apiPath || options.wrapperPath || null,
    apiUrl: options.apiUrl || options.wrapperUrl || null,
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
  const pathCandidates = isNodeRuntime()
    ? await resolveNodePathCandidates(options)
    : resolveBrowserPathCandidates(options);
  let lastError = null;

  for (const paths of pathCandidates) {
    try {
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

      const apiModule = options.apiModule || (isNodeRuntime()
        ? await loadNodeApiModule(paths.apiPath)
        : await loadBrowserApiModule(paths.apiUrl));

      return { module, factory, apiModule, paths };
    } catch (error) {
      lastError = error;
    }
  }

  throw (lastError || new Error('OCCT module load failed for all configured paths'));
}

export async function loadOcctKernelModule(options = {}) {
  const key = buildCacheKey(options);
  if (!options.fresh && cachedLoaded && cachedKey === key) {
    publishReadyStatus(cachedLoaded, 'cache');
    return Promise.resolve(cachedLoaded);
  }
  if (!options.fresh && cachedPromise && cachedKey === key) {
    writeRuntimeStatus({
      state: 'loading',
      source: 'pending',
    });
    return cachedPromise;
  }
  cachedKey = key;
  writeRuntimeStatus({
    state: 'loading',
    source: options.fresh ? 'fresh-reload' : 'fresh',
  });
  cachedPromise = loadUncached(options)
    .then((loaded) => {
      if (cachedKey === key) cachedLoaded = loaded;
      publishReadyStatus(loaded, options.fresh ? 'fresh-reload' : 'fresh');
      return loaded;
    })
    .catch((error) => {
      const status = writeRuntimeStatus({
        state: 'error',
        source: options.fresh ? 'fresh-reload' : 'fresh',
        error: error?.message || String(error),
      });
      logRuntimeStatus('error', 'kernel load failed', status);
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

export function getOcctKernelRuntimeStatus() {
  return writeRuntimeStatus({});
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

writeRuntimeStatus({
  state: 'idle',
  source: 'bootstrap',
  paths: summarizePaths({ distUrl: DEFAULT_BROWSER_DIST_URL }),
});
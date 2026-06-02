// js/persist.js — Browser persistence for project state
import { state } from './state.js';
import { Scene } from './cad/index.js';
import { info, warn, error } from './logger.js';

const STORAGE_KEY = 'cad-modeller-project';
const VIEW_STATE_STORAGE_KEY = `${STORAGE_KEY}:view`;
const PROJECT_SCHEMA_VERSION = 4;
const PROJECT_IMAGE_CONTAINER_VERSION = 1;
const PROJECT_IMAGE_CONTAINER_KIND = 'project-image';
const PROJECT_IMAGE_IDB_KEY_PREFIX = `${STORAGE_KEY}:image`;
const PROJECT_RECORD_CONTAINER_VERSION = 1;
const PROJECT_RECORD_CONTAINER_KIND = 'project-record';
const PROJECT_RECORD_IDB_KEY_PREFIX = `${STORAGE_KEY}:record`;
const SAVE_DEBOUNCE_MS = 500;
const VIEW_SAVE_DEBOUNCE_MS = 120;

let _saveTimer = null;
let _viewSaveTimer = null;
let _viewport = null;
let _partManager = null;
let _renderer3d = null;
let _getWorkspaceMode = null;
let _getSessionState = null;
let _getScenes = null;
let _getCamConfig = null;
let _cbrepStoreFactory = null;
let _cbrepStorePromise = null;

/** Register the viewport instance for persistence. */
export function setViewport(vp) { _viewport = vp; }

/** Register the PartManager instance for persistence. */
export function setPartManagerForPersist(pm) { _partManager = pm; }

/** Register the 3D renderer for orbit state persistence. */
export function setRendererForPersist(r) { _renderer3d = r; }

/** Register a callback that returns the current workspace mode string. */
export function setWorkspaceModeGetter(fn) { _getWorkspaceMode = fn; }

/** Register a callback that returns transient session state needed for restore. */
export function setSessionStateGetter(fn) { _getSessionState = fn; }

/** Register a callback that returns named camera scenes. */
export function setScenesGetter(fn) { _getScenes = fn; }

/** Register a callback that returns the top-level CAM config. */
export function setCamConfigGetter(fn) { _getCamConfig = fn; }

/** Register a factory for the external CBREP payload store. */
export function setCbrepPersistStoreFactory(factory) {
  _cbrepStoreFactory = factory;
  _cbrepStorePromise = null;
}

async function _getCbrepStore() {
  if (_cbrepStoreFactory) {
    return await _cbrepStoreFactory();
  }
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB not available');
  }
  if (!_cbrepStorePromise) {
    _cbrepStorePromise = import('../packages/cache/BrowserIdbCacheStore.js')
      .then(({ BrowserIdbCacheStore }) => new BrowserIdbCacheStore());
  }
  return await _cbrepStorePromise;
}

function _utf8Encode(text) {
  return new TextEncoder().encode(String(text ?? ''));
}

function _utf8Decode(buffer) {
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : (ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer));
  return new TextDecoder().decode(bytes);
}

function _toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) {
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return new Uint8Array(bytes).buffer;
}

function _hashProjectImagePayload(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}-${text.length.toString(16)}`;
}

function _hashProjectRecordPayload(text) {
  return _hashProjectImagePayload(text);
}

function _makeProjectImageManifest(key, hash) {
  return {
    version: PROJECT_IMAGE_CONTAINER_VERSION,
    kind: PROJECT_IMAGE_CONTAINER_KIND,
    storage: 'idb',
    key,
    encoding: 'utf8',
    hash,
  };
}

function _makeProjectRecordManifest(key, hash, encoding) {
  return {
    version: PROJECT_RECORD_CONTAINER_VERSION,
    kind: PROJECT_RECORD_CONTAINER_KIND,
    storage: 'idb',
    key,
    encoding,
    hash,
  };
}

function _isProjectRecordManifest(value) {
  return !!value
    && typeof value === 'object'
    && value.kind === PROJECT_RECORD_CONTAINER_KIND
    && value.storage === 'idb'
    && typeof value.key === 'string'
    && value.key.length > 0;
}

async function _compressProjectRecordPayload(text) {
  const encoded = _utf8Encode(text);
  if (typeof CompressionStream !== 'function' || typeof Blob === 'undefined' || typeof Response === 'undefined') {
    return {
      encoding: 'utf8',
      payload: _toArrayBuffer(encoded),
    };
  }

  try {
    const compressed = await new Response(
      new Blob([encoded]).stream().pipeThrough(new CompressionStream('gzip'))
    ).arrayBuffer();
    return {
      encoding: 'gzip+utf8',
      payload: compressed,
    };
  } catch {
    return {
      encoding: 'utf8',
      payload: _toArrayBuffer(encoded),
    };
  }
}

async function _decompressProjectRecordPayload(raw, encoding) {
  if (!raw) return null;
  if (encoding === 'gzip+utf8') {
    if (typeof DecompressionStream !== 'function' || typeof Blob === 'undefined' || typeof Response === 'undefined') {
      throw new Error('gzip project payload requires DecompressionStream support');
    }
    const inflated = await new Response(
      new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))
    ).arrayBuffer();
    return _utf8Decode(inflated);
  }
  return _utf8Decode(raw);
}

async function _persistProjectRecordPayload(text) {
  if (!text || (!_cbrepStoreFactory && typeof indexedDB === 'undefined')) {
    return null;
  }

  const hash = _hashProjectRecordPayload(text);
  const key = `${PROJECT_RECORD_IDB_KEY_PREFIX}:${hash}`;
  try {
    const store = await _getCbrepStore();
    const compressed = await _compressProjectRecordPayload(text);
    await store.put(key, compressed.payload);
    return _makeProjectRecordManifest(key, hash, compressed.encoding);
  } catch (err) {
    warn('Failed to persist project snapshot to IndexedDB', err?.message || String(err));
    return null;
  }
}

async function _loadProjectRecordPayload(manifest) {
  if (!_isProjectRecordManifest(manifest)) {
    return null;
  }

  try {
    const store = await _getCbrepStore();
    const raw = await store.get(manifest.key);
    if (!raw) {
      return null;
    }
    const text = await _decompressProjectRecordPayload(raw, manifest.encoding || 'utf8');
    if (!text) {
      return null;
    }
    if (manifest.hash && _hashProjectRecordPayload(text) !== manifest.hash) {
      warn('Ignoring mismatched project snapshot payload from IndexedDB', `${manifest.key}`);
      return null;
    }
    return JSON.parse(text);
  } catch (err) {
    warn('Failed to restore project snapshot from IndexedDB', err?.message || String(err));
    return null;
  }
}

async function _deletePersistedProjectRecord(manifest) {
  if (!_isProjectRecordManifest(manifest)) {
    return;
  }
  try {
    const store = await _getCbrepStore();
    await store.delete(manifest.key);
  } catch {
    // Best-effort cleanup only.
  }
}

async function _persistProjectImagePayload(dataUrl) {
  if (!dataUrl || (!_cbrepStoreFactory && typeof indexedDB === 'undefined')) {
    return null;
  }

  const hash = _hashProjectImagePayload(dataUrl);
  const key = `${PROJECT_IMAGE_IDB_KEY_PREFIX}:${hash}`;
  try {
    const store = await _getCbrepStore();
    const container = {
      version: PROJECT_IMAGE_CONTAINER_VERSION,
      kind: PROJECT_IMAGE_CONTAINER_KIND,
      encoding: 'utf8',
      hash,
      payload: dataUrl,
      savedAt: Date.now(),
    };
    await store.put(key, _toArrayBuffer(_utf8Encode(JSON.stringify(container))));
    return _makeProjectImageManifest(key, hash);
  } catch (err) {
    warn('Failed to persist project image to IndexedDB; keeping inline snapshot', err?.message || String(err));
    return null;
  }
}

async function _loadProjectImagePayload(manifest) {
  if (!manifest || manifest.storage !== 'idb' || !manifest.key) {
    return null;
  }

  try {
    const store = await _getCbrepStore();
    const raw = await store.get(manifest.key);
    if (!raw) {
      return null;
    }

    const container = JSON.parse(_utf8Decode(raw));
    if (container.version !== PROJECT_IMAGE_CONTAINER_VERSION || container.kind !== PROJECT_IMAGE_CONTAINER_KIND) {
      warn('Ignoring unsupported project image container version from IndexedDB', `${container.kind || 'unknown'}@${container.version ?? 'unknown'}`);
      return null;
    }
    if (manifest.hash && container.hash && manifest.hash !== container.hash) {
      warn('Ignoring mismatched project image payload from IndexedDB', `${manifest.hash} !== ${container.hash}`);
      return null;
    }

    return typeof container.payload === 'string' ? container.payload : null;
  } catch (err) {
    warn('Failed to restore project image from IndexedDB', err?.message || String(err));
    return null;
  }
}

async function _deletePersistedProjectImage(manifest) {
  if (!manifest || manifest.storage !== 'idb' || !manifest.key) {
    return;
  }
  try {
    const store = await _getCbrepStore();
    await store.delete(manifest.key);
  } catch {
    // Best-effort cleanup only.
  }
}

function _collectProjectImageManifests(node, manifests = []) {
  if (!node || typeof node !== 'object') {
    return manifests;
  }
  if (Array.isArray(node)) {
    for (const value of node) {
      _collectProjectImageManifests(value, manifests);
    }
    return manifests;
  }

  if (node.type === 'image' && node.dataUrlManifest?.storage === 'idb' && node.dataUrlManifest?.key) {
    manifests.push(node.dataUrlManifest);
  }

  for (const value of Object.values(node)) {
    _collectProjectImageManifests(value, manifests);
  }
  return manifests;
}

async function _externalizeProjectImagePayloads(node) {
  const activeKeys = new Set();
  const persistedByHash = new Map();

  async function visit(value) {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        await visit(entry);
      }
      return;
    }

    if (value.type === 'image' && typeof value.dataUrl === 'string' && value.dataUrl.length > 0) {
      const hash = _hashProjectImagePayload(value.dataUrl);
      let manifest = persistedByHash.get(hash);
      if (!manifest) {
        manifest = await _persistProjectImagePayload(value.dataUrl);
        if (manifest) {
          persistedByHash.set(hash, manifest);
        }
      }
      if (manifest) {
        value.dataUrlManifest = manifest;
        delete value.dataUrl;
        activeKeys.add(manifest.key);
      }
    }

    for (const entry of Object.values(value)) {
      await visit(entry);
    }
  }

  await visit(node);
  return activeKeys;
}

async function _hydrateProjectImagePayloads(node) {
  async function visit(value) {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        await visit(entry);
      }
      return;
    }

    if (value.type === 'image' && !value.dataUrl && value.dataUrlManifest) {
      const payload = await _loadProjectImagePayload(value.dataUrlManifest);
      if (payload) {
        value.dataUrl = payload;
      }
    }

    for (const entry of Object.values(value)) {
      await visit(entry);
    }
  }

  await visit(node);
}

function _readStoredProjectEntry() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function _readStoredProjectRecord(entry = _readStoredProjectEntry()) {
  if (!entry) return null;
  if (_isProjectRecordManifest(entry)) {
    return await _loadProjectRecordPayload(entry);
  }
  return entry;
}

function _captureViewState() {
  const viewState = {
    version: 1,
  };

  if (_viewport) {
    viewState.viewport = {
      zoom: _viewport.zoom,
      panX: _viewport.panX,
      panY: _viewport.panY,
    };
  }

  if (_renderer3d && _renderer3d.getOrbitState) {
    viewState.orbit = _renderer3d.getOrbitState();
  }

  return viewState;
}

function _readStoredViewState() {
  try {
    const raw = localStorage.getItem(VIEW_STATE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function _applyViewStateOverlay(data, viewState = _readStoredViewState()) {
  if (!data || !viewState || typeof viewState !== 'object') {
    return data;
  }

  if (viewState.viewport) {
    data.viewport = viewState.viewport;
  }
  if (viewState.orbit) {
    data.orbit = viewState.orbit;
  }
  return data;
}

/**
 * Serialize the full project (scene, layers, settings, part, orbit) to a plain object.
 */
function projectToJSON() {
  const json = {
    version: PROJECT_SCHEMA_VERSION,
    scene: state.scene.serialize(),
    layers: state.layers.map(l => ({ ...l })),
    activeLayer: state.activeLayer,
    gridSize: state.gridSize,
    gridVisible: state.gridVisible,
    snapEnabled: state.snapEnabled,
    orthoEnabled: state.orthoEnabled,
    autoCoincidence: state.autoCoincidence,
    viewport: _viewport ? { zoom: _viewport.zoom, panX: _viewport.panX, panY: _viewport.panY } : null,
  };

  // 3D Part state
  if (_partManager) {
    const part = _partManager.getPart();
    if (part) {
      json.part = part.serialize();
    }
  }

  // 3D orbit camera state
  if (_renderer3d && _renderer3d.getOrbitState) {
    json.orbit = _renderer3d.getOrbitState();
  }

  // Workspace mode
  if (_getWorkspaceMode) {
    json.workspaceMode = _getWorkspaceMode();
  }

  // Transient UI/session state
  if (_getSessionState) {
    json.sessionState = _getSessionState();
  }

  // CAM setup and operations are file data, not transient session state.
  if (_getCamConfig) {
    json.cam = _getCamConfig();
  }

  // Named camera scenes
  if (_getScenes) {
    json.scenes = _getScenes();
  }

  return json;
}

/**
 * Restore project state from a plain object.
 */
async function projectFromJSON(data) {
  if (!data || data.version == null) return { ok: false, hasViewport: false };

  await _hydrateProjectImagePayloads(data);

  // Backward compatible: v2 projects lack part/orbit/workspaceMode fields,
  // which will be null in the returned object. The caller handles this gracefully.

  // Restore scene
  if (data.scene) {
    state.scene = Scene.deserialize(data.scene);
  }
  state.selectedEntities = [];

  // Restore layers
  if (Array.isArray(data.layers) && data.layers.length > 0) {
    state.layers = data.layers;
  }

  // Restore settings
  if (data.activeLayer) state.activeLayer = data.activeLayer;
  if (data.gridSize != null) state.gridSize = data.gridSize;
  if (data.gridVisible != null) state.gridVisible = data.gridVisible;
  if (data.snapEnabled != null) state.snapEnabled = data.snapEnabled;
  if (data.orthoEnabled != null) state.orthoEnabled = data.orthoEnabled;
  if (data.autoCoincidence != null) state.autoCoincidence = data.autoCoincidence;

  // Restore viewport
  let hasViewport = false;
  if (data.viewport && _viewport) {
    _viewport.zoom = data.viewport.zoom;
    _viewport.panX = data.viewport.panX;
    _viewport.panY = data.viewport.panY;
    hasViewport = true;
  }

  // Reset history (undo/redo doesn't survive reload)
  state._undoStack = [];
  state._redoStack = [];

  return {
    ok: true,
    hasViewport,
    part: data.part || null,
    orbit: data.orbit || null,
    scenes: Array.isArray(data.scenes) ? data.scenes : [],
    workspaceMode: data.workspaceMode || null,
    sessionState: data.sessionState || null,
    cam: data.cam || null,
  };
}

/**
 * Save current project to localStorage.
 */
export async function saveProject() {
  try {
    const previousEntry = _readStoredProjectEntry();
    const previous = await _readStoredProjectRecord(previousEntry);
    const previousImageManifests = _collectProjectImageManifests(previous);
    const json = projectToJSON();

    const activeImageKeys = await _externalizeProjectImagePayloads(json);

    const rawProject = JSON.stringify(json);
    let nextStoredEntry = json;
    let nextProjectManifest = null;

    try {
      localStorage.setItem(STORAGE_KEY, rawProject);
    } catch (err) {
      const fallbackManifest = await _persistProjectRecordPayload(rawProject);
      if (!fallbackManifest) {
        throw err;
      }
      nextProjectManifest = fallbackManifest;
      nextStoredEntry = fallbackManifest;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(fallbackManifest));
      info('Project snapshot externalized to IndexedDB after localStorage quota pressure', { key: fallbackManifest.key, encoding: fallbackManifest.encoding });
    }

    if (_isProjectRecordManifest(previousEntry)) {
      const shouldDeletePreviousProject = !nextProjectManifest || previousEntry.key !== nextProjectManifest.key;
      if (shouldDeletePreviousProject) {
        await _deletePersistedProjectRecord(previousEntry);
      }
    }

    localStorage.removeItem(VIEW_STATE_STORAGE_KEY);

    for (const manifest of previousImageManifests) {
      if (!activeImageKeys.has(manifest.key)) {
        await _deletePersistedProjectImage(manifest);
      }
    }
  } catch (err) {
    warn('Failed to save project to localStorage', err.message);
  }
}

/**
 * Debounced save — collapses rapid changes into a single write.
 */
export function debouncedSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    void saveProject();
  }, SAVE_DEBOUNCE_MS);
}

export function saveViewState() {
  try {
    localStorage.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify(_captureViewState()));
  } catch (err) {
    warn('Failed to save view state to localStorage', err?.message || String(err));
  }
}

export function debouncedSaveViewState() {
  if (_viewSaveTimer) clearTimeout(_viewSaveTimer);
  _viewSaveTimer = setTimeout(() => {
    _viewSaveTimer = null;
    saveViewState();
  }, VIEW_SAVE_DEBOUNCE_MS);
}

/**
 * Load project from localStorage. Returns true if a project was restored.
 */
export async function loadProject() {
  try {
    const entry = _readStoredProjectEntry();
    if (!entry) return false;
    const data = _applyViewStateOverlay(await _readStoredProjectRecord(entry));
    if (!data) return false;
    const result = await projectFromJSON(data);
    if (result.ok) {
      info('Project restored from browser storage', { entities: state.entities.length, layers: state.layers.length, hasViewport: result.hasViewport });
    }
    return result;
  } catch (err) {
    error('Failed to load project from localStorage', err);
    return false;
  }
}

/**
 * Clear saved project from localStorage.
 */
export function clearSavedProject() {
  const previousEntry = _readStoredProjectEntry();
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(VIEW_STATE_STORAGE_KEY);

  void (async () => {
    const previous = await _readStoredProjectRecord(previousEntry);
    if (_isProjectRecordManifest(previousEntry)) {
      await _deletePersistedProjectRecord(previousEntry);
    }
    for (const manifest of _collectProjectImageManifests(previous)) {
      await _deletePersistedProjectImage(manifest);
    }
  })();

  info('Saved project cleared from browser storage');
}

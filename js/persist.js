// js/persist.js — Browser persistence for project state
import { state } from './state.js';
import { Scene } from './cad/index.js';
import { info, warn, error } from './logger.js';

const STORAGE_KEY = 'cad-modeller-project';
const PROJECT_SCHEMA_VERSION = 4;
const FINAL_CBREP_CONTAINER_VERSION = 1;
const FINAL_CBREP_CONTAINER_KIND = 'final-cbrep-snapshot';
const FINAL_CBREP_IDB_KEY = `${STORAGE_KEY}:final-cbrep`;
const PROJECT_IMAGE_CONTAINER_VERSION = 1;
const PROJECT_IMAGE_CONTAINER_KIND = 'project-image';
const PROJECT_IMAGE_IDB_KEY_PREFIX = `${STORAGE_KEY}:image`;
const SAVE_DEBOUNCE_MS = 500;

let _saveTimer = null;
let _viewport = null;
let _partManager = null;
let _renderer3d = null;
let _getWorkspaceMode = null;
let _getSessionState = null;
let _getScenes = null;
let _getCamConfig = null;
let _cbrepStoreFactory = null;

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
export function setCbrepPersistStoreFactory(factory) { _cbrepStoreFactory = factory; }

async function _getCbrepStore() {
  if (_cbrepStoreFactory) {
    return _cbrepStoreFactory();
  }
  const { BrowserIdbCacheStore } = await import('./cache/index.js');
  return new BrowserIdbCacheStore();
}

function _utf8Encode(text) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text);
  }
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(text, 'utf8'));
  }
  throw new Error('No UTF-8 encoder available');
}

function _utf8Decode(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(bytes);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('utf8');
  }
  throw new Error('No UTF-8 decoder available');
}

function _toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function _makeFinalCbrepManifest(storage, hash = null) {
  return {
    version: FINAL_CBREP_CONTAINER_VERSION,
    kind: FINAL_CBREP_CONTAINER_KIND,
    storage,
    key: storage === 'idb' ? FINAL_CBREP_IDB_KEY : null,
    encoding: 'base64',
    compression: 'none',
    hash: hash || null,
  };
}

function _hashProjectImagePayload(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}-${text.length.toString(16)}`;
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

async function _persistFinalCbrepPayload(payload, hash) {
  if (!payload) {
    return { payload: null, manifest: null };
  }

  if (_cbrepStoreFactory || typeof indexedDB !== 'undefined') {
    try {
      const store = await _getCbrepStore();
      const container = {
        version: FINAL_CBREP_CONTAINER_VERSION,
        kind: FINAL_CBREP_CONTAINER_KIND,
        encoding: 'base64',
        compression: 'none',
        hash: hash || null,
        payload,
        savedAt: Date.now(),
      };
      await store.put(FINAL_CBREP_IDB_KEY, _toArrayBuffer(_utf8Encode(JSON.stringify(container))));
      return {
        payload: null,
        manifest: _makeFinalCbrepManifest('idb', hash),
      };
    } catch (err) {
      warn('Failed to persist final CBREP to IndexedDB; falling back to localStorage', err?.message || String(err));
    }
  }

  return {
    payload,
    manifest: _makeFinalCbrepManifest('inline', hash),
  };
}

async function _loadFinalCbrepState(data) {
  const inlinePayload = data.finalCbrepPayload || data.part?._finalCbrepPayload || null;
  const manifest = data.finalCbrepContainer || (inlinePayload ? _makeFinalCbrepManifest('inline', data.finalCbrepHash || data.part?._finalCbrepHash || null) : null);
  const hash = data.finalCbrepHash || manifest?.hash || data.part?._finalCbrepHash || null;

  if (inlinePayload) {
    return { payload: inlinePayload, hash, manifest };
  }

  if (!manifest || manifest.storage !== 'idb') {
    return { payload: null, hash, manifest };
  }

  try {
    const store = await _getCbrepStore();
    const raw = await store.get(manifest.key || FINAL_CBREP_IDB_KEY);
    if (!raw) {
      return { payload: null, hash, manifest };
    }

    const container = JSON.parse(_utf8Decode(raw));
    if (container.version !== FINAL_CBREP_CONTAINER_VERSION || container.kind !== FINAL_CBREP_CONTAINER_KIND) {
      warn('Ignoring unsupported final CBREP container version from IndexedDB', `${container.kind || 'unknown'}@${container.version ?? 'unknown'}`);
      return { payload: null, hash, manifest };
    }
    if (manifest.hash && container.hash && manifest.hash !== container.hash) {
      warn('Ignoring mismatched final CBREP payload from IndexedDB', `${manifest.hash} !== ${container.hash}`);
      return { payload: null, hash, manifest };
    }

    return {
      payload: container.payload || null,
      hash: container.hash || hash,
      manifest,
    };
  } catch (err) {
    warn('Failed to restore final CBREP from IndexedDB', err?.message || String(err));
    return { payload: null, hash, manifest };
  }
}

async function _deletePersistedFinalCbrep(manifest) {
  if (!manifest || manifest.storage !== 'idb') {
    return;
  }
  try {
    const store = await _getCbrepStore();
    await store.delete(manifest.key || FINAL_CBREP_IDB_KEY);
  } catch {
    // Best-effort cleanup only.
  }
}

function _readStoredProjectRecord() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
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

  const finalCbrep = await _loadFinalCbrepState(data);

  return {
    ok: true,
    hasViewport,
    part: data.part || null,
    orbit: data.orbit || null,
    scenes: Array.isArray(data.scenes) ? data.scenes : [],
    workspaceMode: data.workspaceMode || null,
    sessionState: data.sessionState || null,
    cam: data.cam || null,
    finalCbrepPayload: finalCbrep.payload,
    finalCbrepHash: finalCbrep.hash,
    finalCbrepContainer: finalCbrep.manifest,
  };
}

/**
 * Save current project to localStorage.
 */
export async function saveProject() {
  try {
    const previous = _readStoredProjectRecord();
    const previousManifest = previous?.finalCbrepContainer || null;
    const previousImageManifests = _collectProjectImageManifests(previous);
    const json = projectToJSON();
    const payload = json.part?._finalCbrepPayload || null;
    const hash = json.part?._finalCbrepHash || null;

    if (json.part && json.part._finalCbrepPayload) {
      delete json.part._finalCbrepPayload;
    }

    delete json.finalCbrepPayload;
    delete json.finalCbrepHash;
    delete json.finalCbrepContainer;

    if (payload) {
      const persisted = await _persistFinalCbrepPayload(payload, hash);
      json.finalCbrepHash = persisted.manifest?.hash || hash || null;
      json.finalCbrepContainer = persisted.manifest;
      if (persisted.payload) {
        json.finalCbrepPayload = persisted.payload;
      }
      if (previousManifest?.storage === 'idb' && persisted.manifest?.storage !== 'idb') {
        await _deletePersistedFinalCbrep(previousManifest);
      }
    } else if (previousManifest) {
      await _deletePersistedFinalCbrep(previousManifest);
    }

    const activeImageKeys = await _externalizeProjectImagePayloads(json);

    localStorage.setItem(STORAGE_KEY, JSON.stringify(json));

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

/**
 * Load project from localStorage. Returns true if a project was restored.
 */
export async function loadProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
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
  const previous = _readStoredProjectRecord();
  localStorage.removeItem(STORAGE_KEY);
  if (previous?.finalCbrepContainer) {
    void _deletePersistedFinalCbrep(previous.finalCbrepContainer);
  }
  for (const manifest of _collectProjectImageManifests(previous)) {
    void _deletePersistedProjectImage(manifest);
  }
  info('Saved project cleared from browser storage');
}

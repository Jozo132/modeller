// js/persist.js — Browser persistence for project state
import { state } from './state.js';
import { Scene } from './cad/index.js';
import { info, warn, error } from './logger.js';

const STORAGE_KEY = 'cad-modeller-project';
const PROJECT_SCHEMA_VERSION = 4;
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
    const previous = _readStoredProjectRecord();
    const previousImageManifests = _collectProjectImageManifests(previous);
    const json = projectToJSON();

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
  for (const manifest of _collectProjectImageManifests(previous)) {
    void _deletePersistedProjectImage(manifest);
  }
  info('Saved project cleared from browser storage');
}

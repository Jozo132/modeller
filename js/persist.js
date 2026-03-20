// js/persist.js — LocalStorage persistence for project state
import { state } from './state.js';
import { Scene } from './cad/index.js';
import { info, warn, error } from './logger.js';

const STORAGE_KEY = 'cad-modeller-project';
const SAVE_DEBOUNCE_MS = 500;

let _saveTimer = null;
let _viewport = null;
let _partManager = null;
let _renderer3d = null;
let _getWorkspaceMode = null;
let _getSessionState = null;

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

/**
 * Serialize the full project (scene, layers, settings, part, orbit) to a plain object.
 */
function projectToJSON() {
  const json = {
    version: 3,
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

  return json;
}

/**
 * Restore project state from a plain object.
 */
function projectFromJSON(data) {
  if (!data || data.version == null) return { ok: false, hasViewport: false };

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
    workspaceMode: data.workspaceMode || null,
    sessionState: data.sessionState || null,
  };
}

/**
 * Save current project to localStorage.
 */
export function saveProject() {
  try {
    const json = projectToJSON();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(json));
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
    saveProject();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Load project from localStorage. Returns true if a project was restored.
 */
export function loadProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    const result = projectFromJSON(data);
    if (result.ok) {
      info('Project restored from localStorage', { entities: state.entities.length, layers: state.layers.length, hasViewport: result.hasViewport });
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
  localStorage.removeItem(STORAGE_KEY);
  info('Saved project cleared from localStorage');
}

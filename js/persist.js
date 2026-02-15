// js/persist.js — LocalStorage persistence for project state
import { state } from './state.js';
import { Scene } from './cad/index.js';
import { info, warn, error } from './logger.js';

const STORAGE_KEY = 'dxf-modeller-project';
const SAVE_DEBOUNCE_MS = 500;

let _saveTimer = null;
let _viewport = null;

/** Register the viewport instance for persistence. */
export function setViewport(vp) { _viewport = vp; }

/**
 * Serialize the full project (scene, layers, settings) to a plain object.
 */
function projectToJSON() {
  return {
    version: 2,
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
}

/**
 * Restore project state from a plain object.
 */
function projectFromJSON(data) {
  if (!data || data.version == null) return { ok: false, hasViewport: false };

  // Restore scene
  if (data.scene) {
    state.scene = Scene.deserialize(data.scene);
  } else if (Array.isArray(data.entities)) {
    // Legacy v1 format — just clear, can't restore old entities
    state.scene.clear();
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

  return { ok: true, hasViewport };
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
    const { ok, hasViewport } = projectFromJSON(data);
    if (ok) {
      info('Project restored from localStorage', { entities: state.entities.length, layers: state.layers.length, hasViewport });
    }
    return { ok, hasViewport };
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

// js/cmod.js — CAD Modeller Open Design (.cmod) project import/export
//
// File format: JSON with a .cmod extension. Contains the full parametric model
// state: feature tree, sketches, planes, variables, camera orbit, settings,
// and computed metadata for debugging/validation.

import { state } from './state.js';
import { Scene } from './cad/index.js';
import {
  calculateMeshVolume, calculateBoundingBox, calculateSurfaceArea,
  detectDisconnectedBodies, calculateWallThickness, countInvertedFaces,
} from './cad/CSG.js';
import { info, warn, error } from './logger.js';

const FORMAT_ID = 'CAD Modeller Open Design';
const FORMAT_VERSION = 1;

// External dependencies injected at startup
let _viewport = null;
let _partManager = null;
let _renderer3d = null;
let _getWorkspaceMode = null;
let _getSessionState = null;
let _getScenes = null;

/** Register viewport for persistence. */
export function setCmodViewport(vp) { _viewport = vp; }

/** Register PartManager for persistence. */
export function setCmodPartManager(pm) { _partManager = pm; }

/** Register 3D renderer (orbit state). */
export function setCmodRenderer(r) { _renderer3d = r; }

/** Register workspace mode getter. */
export function setCmodWorkspaceModeGetter(fn) { _getWorkspaceMode = fn; }

/** Register session state getter. */
export function setCmodSessionStateGetter(fn) { _getSessionState = fn; }

/** Register scenes getter (returns array of named camera presets). */
export function setCmodScenesGetter(fn) { _getScenes = fn; }

// -----------------------------------------------------------------------
// Metadata computation
// -----------------------------------------------------------------------

function _computeMetadata(part) {
  const meta = {
    createdWith: FORMAT_ID,
    exportedAt: new Date().toISOString(),
  };

  if (!part) return meta;

  const features = part.getFeatures();
  meta.featureCount = features.length;
  meta.featureTypes = features.map(f => f.type);

  const geo = part.getFinalGeometry();
  if (geo && geo.geometry) {
    const geometry = geo.geometry;
    const faces = geometry.faces || [];
    meta.faceCount = faces.length;
    meta.volume = +calculateMeshVolume(geometry).toFixed(6);
    meta.surfaceArea = +calculateSurfaceArea(geometry).toFixed(6);

    const bb = calculateBoundingBox(geometry);
    meta.boundingBox = bb;
    meta.width = +(bb.max.x - bb.min.x).toFixed(6);
    meta.height = +(bb.max.y - bb.min.y).toFixed(6);
    meta.depth = +(bb.max.z - bb.min.z).toFixed(6);

    const edges = geometry.edges || [];
    const paths = geometry.paths || [];
    meta.edgeCount = edges.length;
    meta.pathCount = paths.length;

    const bodies = detectDisconnectedBodies(geometry);
    meta.bodyCount = bodies.bodyCount;
    meta.bodySizes = bodies.bodySizes;

    const wt = calculateWallThickness(geometry);
    meta.minWallThickness = +wt.minThickness.toFixed(6);
    meta.maxWallThickness = +wt.maxThickness.toFixed(6);
    meta.invertedFaceCount = countInvertedFaces(geometry);
  }

  return meta;
}

// -----------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------

/**
 * Serialize the entire project to a .cmod object.
 * @returns {Object} The complete project data.
 */
export function projectToCMOD() {
  const cmod = {
    format: FORMAT_ID,
    version: FORMAT_VERSION,
  };

  // 2D scene (primitives, constraints, variables)
  cmod.scene = state.scene.serialize();

  // Layers
  cmod.layers = state.layers.map(l => ({ ...l }));
  cmod.activeLayer = state.activeLayer;

  // Settings
  cmod.settings = {
    gridSize: state.gridSize,
    gridVisible: state.gridVisible,
    snapEnabled: state.snapEnabled,
    orthoEnabled: state.orthoEnabled,
    autoCoincidence: state.autoCoincidence,
  };

  // 2D viewport
  if (_viewport) {
    cmod.viewport = { zoom: _viewport.zoom, panX: _viewport.panX, panY: _viewport.panY };
  }

  // 3D Part (feature tree, sketches, planes)
  const part = _partManager ? _partManager.getPart() : null;
  if (part) {
    cmod.part = part.serialize();
  }

  // Camera orbit
  if (_renderer3d && _renderer3d.getOrbitState) {
    cmod.orbit = _renderer3d.getOrbitState();
  }

  // Workspace mode & session
  if (_getWorkspaceMode) {
    cmod.workspaceMode = _getWorkspaceMode();
  }
  if (_getSessionState) {
    cmod.sessionState = _getSessionState();
  }

  // Named camera scenes (for repeatable renders)
  if (_getScenes) {
    cmod.scenes = _getScenes();
  }

  // Computed metadata (for debugging / validation)
  cmod.metadata = _computeMetadata(part);

  return cmod;
}

/**
 * Export the project as a .cmod file download.
 * @param {string} [filename] - Download filename (defaults to timestamped name).
 */
export function downloadCMOD(filename) {
  try {
    const cmod = projectToCMOD();
    if (!filename) {
      const partName = cmod.part ? (cmod.part.name || 'project') : 'project';
      const safe = partName.replace(/[^a-zA-Z0-9_-]/g, '_');
      filename = `${safe}.cmod`;
    }
    const json = JSON.stringify(cmod, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    info('CMOD download triggered', { filename, size: json.length });
  } catch (err) {
    error('CMOD download failed', err);
  }
}

// -----------------------------------------------------------------------
// Import
// -----------------------------------------------------------------------

/**
 * Parse and validate a .cmod JSON object.
 * @param {Object} data - Parsed JSON.
 * @returns {{ ok: boolean, error?: string, data?: Object }}
 */
function _validateCMOD(data) {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'Invalid file: not a JSON object.' };
  }
  if (data.format !== FORMAT_ID) {
    return { ok: false, error: `Unknown format: expected "${FORMAT_ID}", got "${data.format}".` };
  }
  if (typeof data.version !== 'number' || data.version < 1) {
    return { ok: false, error: `Invalid version: ${data.version}.` };
  }
  if (data.version > FORMAT_VERSION) {
    return { ok: false, error: `File version ${data.version} is newer than supported (${FORMAT_VERSION}). Please update the application.` };
  }
  return { ok: true };
}

/**
 * Restore project state from a .cmod object.
 * Returns structured result so the caller can finish restoring 3D state.
 * @param {Object} data - Parsed .cmod JSON.
 * @returns {{ ok: boolean, error?: string, hasViewport: boolean, part?: Object, orbit?: Object, workspaceMode?: string, sessionState?: Object, metadata?: Object }}
 */
export function projectFromCMOD(data) {
  const check = _validateCMOD(data);
  if (!check.ok) return { ok: false, hasViewport: false, error: check.error };

  // Restore scene
  if (data.scene) {
    state.scene = Scene.deserialize(data.scene);
  }
  state.selectedEntities = [];

  // Restore layers
  if (Array.isArray(data.layers) && data.layers.length > 0) {
    state.layers = data.layers;
  }
  if (data.activeLayer) state.activeLayer = data.activeLayer;

  // Restore settings
  const s = data.settings || {};
  if (s.gridSize != null) state.gridSize = s.gridSize;
  if (s.gridVisible != null) state.gridVisible = s.gridVisible;
  if (s.snapEnabled != null) state.snapEnabled = s.snapEnabled;
  if (s.orthoEnabled != null) state.orthoEnabled = s.orthoEnabled;
  if (s.autoCoincidence != null) state.autoCoincidence = s.autoCoincidence;

  // Restore viewport
  let hasViewport = false;
  if (data.viewport && _viewport) {
    _viewport.zoom = data.viewport.zoom;
    _viewport.panX = data.viewport.panX;
    _viewport.panY = data.viewport.panY;
    hasViewport = true;
  }

  // Reset history
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
    metadata: data.metadata || null,
  };
}

/**
 * Open a file picker, read a .cmod file, and return the parsed result.
 * Intended for browser use via <input type="file">.
 * @returns {Promise<{ ok: boolean, error?: string, result?: Object, filename?: string }>}
 */
export function openCMODFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.cmod';
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return resolve({ ok: false, error: 'No file selected.' });
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          const result = projectFromCMOD(data);
          resolve({ ...result, filename: file.name });
        } catch (err) {
          resolve({ ok: false, error: `Failed to parse file: ${err.message}` });
        }
      };
      reader.onerror = () => resolve({ ok: false, error: 'Failed to read file.' });
      reader.readAsText(file);
    });
    input.click();
  });
}

// -----------------------------------------------------------------------
// Headless API (for tests — no DOM, no registered singletons)
// -----------------------------------------------------------------------

/**
 * Build a .cmod object from a Part instance directly (headless, no DOM).
 * @param {Object} part - A Part instance with serialize()/getFeatures()/getFinalGeometry().
 * @param {Object} [options] - Optional overrides.
 * @param {Object} [options.orbit] - Camera orbit state.
 * @param {Object} [options.settings] - App settings.
 * @returns {Object} The .cmod JSON object.
 */
export function buildCMOD(part, options = {}) {
  const cmod = {
    format: FORMAT_ID,
    version: FORMAT_VERSION,
    scene: null,
    layers: [{ name: '0', color: '#9CDCFE', visible: true, locked: false }],
    activeLayer: '0',
    settings: {
      gridSize: 10,
      gridVisible: true,
      snapEnabled: true,
      orthoEnabled: false,
      autoCoincidence: true,
      ...options.settings,
    },
    viewport: null,
    part: part ? part.serialize() : null,
    orbit: options.orbit || null,
    scenes: options.scenes || [],
    workspaceMode: 'part',
    sessionState: null,
    metadata: _computeMetadata(part),
  };
  return cmod;
}

/**
 * Parse and validate a .cmod JSON object (headless, no state mutation).
 * @param {Object|string} input - Parsed JSON object or JSON string.
 * @returns {{ ok: boolean, error?: string, data?: Object }}
 */
export function parseCMOD(input) {
  let data = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(input); }
    catch (err) { return { ok: false, error: `JSON parse error: ${err.message}` }; }
  }
  const check = _validateCMOD(data);
  if (!check.ok) return check;
  return { ok: true, data };
}

/**
 * Get the named scenes from a parsed .cmod object (headless).
 * Each scene is { name, orbit: { theta, phi, radius, target, fovDegrees, ortho3D } }.
 * @param {Object} cmodData - Parsed .cmod JSON (or the .data from parseCMOD).
 * @returns {Array<{ name: string, orbit: Object }>}
 */
export function getScenesFromCMOD(cmodData) {
  return Array.isArray(cmodData.scenes) ? cmodData.scenes : [];
}

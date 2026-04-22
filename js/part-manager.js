// part-manager.js - Manages 3D Part workflow and operations

import { Part } from './cad/Part.js';
import { Sketch } from './cad/Sketch.js';
import { Scene } from './cad/Scene.js';
import { tessellateBody } from './cad/Tessellation.js';
import { computeFeatureEdges } from './cad/EdgeAnalysis.js';
import { calculateMeshVolume, calculateBoundingBox } from './cad/toolkit/MeshAnalysis.js';
import { readCbrep } from '../packages/ir/reader.js';

// C1: dependency bundle for FeatureTree.tryFastRestoreFromCheckpoints. Built
// once at module load so .cmod loads can skip the full executeAll replay when
// every solid feature has a cached CBREP checkpoint.
const FAST_RESTORE_DEPS = {
  readCbrep,
  tessellateBody,
  computeFeatureEdges,
  calculateMeshVolume,
  calculateBoundingBox,
};

/**
 * PartManager - Handles 3D part creation and feature management
 */
export class PartManager {
  constructor() {
    this.part = null;
    this.activeFeature = null;
    this.listeners = [];
    this._handleRegistry = null;
    this._residencyManager = null;
  }

  /**
   * Create a new part
   * @param {string} name - Part name
   */
  createPart(name = 'Part1') {
    this._resetWasmSubsystemState();
    this.part = new Part(name);
    this._wirePart(this.part);
    this.activeFeature = null;
    this.notifyListeners();
    return this.part;
  }

  /**
   * Get the current part
   */
  getPart() {
    return this.part;
  }

  /**
   * Backward-compatible alias for callers that expect an active part getter.
   */
  getActivePart() {
    return this.part;
  }

  /**
   * Configure the WASM handle/residency subsystem for current and future parts.
   * If a part already exists, it is rewired and rebuilt once so current
   * feature results receive handle metadata under the new subsystem.
   *
   * @param {import('./cad/WasmBrepHandleRegistry.js').WasmBrepHandleRegistry|null} handleRegistry
   * @param {import('./cad/HandleResidencyManager.js').HandleResidencyManager|null} residencyManager
   */
  setWasmHandleSubsystem(handleRegistry, residencyManager = null) {
    this._handleRegistry = handleRegistry || null;
    this._residencyManager = residencyManager || null;

    if (!this.part) return;

    const hasSubsystem = !!(this._handleRegistry || this._residencyManager);
    if (hasSubsystem) {
      this._resetWasmSubsystemState();
    }

    this._wirePart(this.part);

    if (hasSubsystem && this.part.featureTree?.features?.length) {
      // H3/H4: Prefer hydrating cached CBREP payloads into fresh handles over
      // a full replay. Only fall back to executeAll() if at least one solid
      // result lacks a cached CBREP we can hydrate.
      const tree = this.part.featureTree;
      let restoredFromCache = false;
      if (typeof tree.hydrateExistingResultsFromCbrep === 'function') {
        restoredFromCache = tree.hydrateExistingResultsFromCbrep();
      }
      if (!restoredFromCache) {
        tree.executeAll();
      }
    }

    this.notifyListeners();
  }

  /**
   * Create a sketch from the current 2D scene
   * @param {Scene} scene - The 2D scene to convert
   * @param {string} name - Sketch name
   */
  addSketchFromScene(scene, name = 'Sketch', plane = null) {
    if (!this.part) {
      this.createPart();
    }

    const sketch = new Sketch();
    sketch.name = name;
    
    // Full-fidelity copy: serialize → deserialize preserves geometry, constraints, and dimensions
    sketch.scene = Scene.deserialize(scene.serialize());

    const sketchFeature = this.part.addSketch(sketch, plane);
    this.activeFeature = sketchFeature;
    this.notifyListeners();
    return sketchFeature;
  }

  /**
   * Extrude the active sketch feature
   * @param {string} sketchFeatureId - ID of sketch feature to extrude
   * @param {number} distance - Extrusion distance
   * @param {object} [options] - Extrude options (operation, direction, symmetric)
   */
  extrude(sketchFeatureId, distance = 10, options = {}) {
    if (!this.part) return null;

    const feature = this.part.extrude(sketchFeatureId, distance, options);
    this.activeFeature = feature;
    this.notifyListeners();
    return feature;
  }

  /**
   * Extrude-cut the active sketch feature (subtract by default)
   */
  extrudeCut(sketchFeatureId, distance = 10, options = {}) {
    if (!this.part) return null;

    const feature = this.part.extrudeCut(sketchFeatureId, distance, options);
    this.activeFeature = feature;
    this.notifyListeners();
    return feature;
  }

  /**
   * Revolve the active sketch feature
   * @param {string} sketchFeatureId - ID of sketch feature to revolve
   * @param {number} angle - Revolution angle in radians
   * @param {object} [options] - Revolve options (operation, axis, axisSegmentId)
   */
  revolve(sketchFeatureId, angle = Math.PI * 2, options = {}) {
    if (!this.part) return null;

    const feature = this.part.revolve(sketchFeatureId, angle, options);
    this.activeFeature = feature;
    this.notifyListeners();
    return feature;
  }

  chamfer(edgeKeys, distance) {
    if (!this.part) return null;
    const feature = this.part.chamfer(edgeKeys, distance);
    this.activeFeature = feature;
    this.notifyListeners();
    return feature;
  }

  fillet(edgeKeys, radius, options = {}) {
    if (!this.part) return null;
    const feature = this.part.fillet(edgeKeys, radius, options);
    this.activeFeature = feature;
    this.notifyListeners();
    return feature;
  }

  /**
   * Import a STEP file as a solid body feature.
   * @param {string} stepData - Raw STEP file contents
   * @param {Object} [options] - Import options (name, curveSegments)
   */
  importSTEP(stepData, options = {}) {
    if (!this.part) {
      this.createPart();
    }

    const feature = this.part.importSTEP(stepData, options);
    this.activeFeature = feature;
    this.notifyListeners();
    return feature;
  }

  /**
   * Modify a feature's parameters
   * @param {string} featureId - Feature ID
   * @param {Function} modifyFn - Function to modify the feature
   */
  modifyFeature(featureId, modifyFn) {
    if (!this.part) return;

    this.part.modifyFeature(featureId, modifyFn);
    this.notifyListeners();
  }

  /**
   * Suppress a feature
   * @param {string} featureId - Feature ID
   */
  suppressFeature(featureId) {
    if (!this.part) return;

    this.part.suppressFeature(featureId);
    this.notifyListeners();
  }

  /**
   * Unsuppress a feature
   * @param {string} featureId - Feature ID
   */
  unsuppressFeature(featureId) {
    if (!this.part) return;

    this.part.unsuppressFeature(featureId);
    this.notifyListeners();
  }

  /**
   * Remove a feature
   * @param {string} featureId - Feature ID
   */
  removeFeature(featureId) {
    if (!this.part) return;

    this.part.removeFeature(featureId);
    if (this.activeFeature && this.activeFeature.id === featureId) {
      this.activeFeature = null;
    }
    this.notifyListeners();
  }

  /**
   * Get all features
   */
  getFeatures() {
    return this.part ? this.part.getFeatures() : [];
  }

  /**
   * Get active feature
   */
  getActiveFeature() {
    return this.activeFeature;
  }

  /**
   * Set active feature
   * @param {string} featureId - Feature ID
   */
  setActiveFeature(featureId) {
    if (!this.part) return;

    const feature = this.part.getFeatures().find(f => f.id === featureId);
    if (feature) {
      this.activeFeature = feature;
      this.notifyListeners();
    }
  }

  /**
   * Get final geometry
   */
  getFinalGeometry() {
    return this.part ? this.part.getFinalGeometry() : null;
  }

  /**
   * Add a listener for part updates
   * @param {Function} listener - Callback function
   */
  addListener(listener) {
    this.listeners.push(listener);
  }

  /**
   * Remove a listener
   * @param {Function} listener - Callback function
   */
  removeListener(listener) {
    const index = this.listeners.indexOf(listener);
    if (index > -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * Notify all listeners of part updates
   */
  notifyListeners() {
    this.listeners.forEach(listener => listener(this.part));
  }

  /**
   * Serialize the part to JSON
   */
  serialize() {
    return this.part ? this.part.serialize() : null;
  }

  /**
   * Deserialize a part from JSON
   * @param {Object} data - Serialized part data
   * @param {Object} [options] - Restore options for cached exact data
   */
  deserialize(data, options = {}) {
    if (!data) return;

    this._resetWasmSubsystemState();
    this.part = Part.deserialize(data, {
      handleRegistry: this._handleRegistry,
      residencyManager: this._residencyManager,
      finalCbrepPayload: options.finalCbrepPayload ?? null,
      finalCbrepHash: options.finalCbrepHash ?? null,
      fastRestoreDeps: FAST_RESTORE_DEPS,
    });
    this._wirePart(this.part);
    this.activeFeature = null;
    this.notifyListeners();
  }

  _wirePart(part) {
    if (!part || typeof part.setWasmHandleSubsystem !== 'function') return;
    part.setWasmHandleSubsystem(this._handleRegistry, this._residencyManager);
  }

  _resetWasmSubsystemState() {
    if (this._residencyManager && typeof this._residencyManager.clear === 'function') {
      this._residencyManager.clear();
    }
    if (this._handleRegistry && typeof this._handleRegistry.resetTopology === 'function') {
      this._handleRegistry.resetTopology();
    }
  }
}

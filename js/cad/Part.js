// js/cad/Part.js — Parametric 3D part modeling
// This class supports 3D part design with parametric feature tree including:
// - Multiple sketches on different planes
// - Extrude, revolve, sweep, loft operations
// - Fillets, chamfers, shells, and other 3D features
// - Material properties and mass calculations
// - Recursive recalculation when features change

import { Sketch } from './Sketch.js';
import { FeatureTree } from './FeatureTree.js';
import { SketchFeature } from './SketchFeature.js';
import { ExtrudeFeature } from './ExtrudeFeature.js';
import { ExtrudeCutFeature } from './ExtrudeCutFeature.js';
import { MultiSketchExtrudeFeature } from './MultiSketchExtrudeFeature.js';
import { RevolveFeature } from './RevolveFeature.js';
import { ChamferFeature } from './ChamferFeature.js';
import { FilletFeature } from './FilletFeature.js';
import { StepImportFeature } from './StepImportFeature.js';
import { TessellationConfig, globalTessConfig } from './TessellationConfig.js';
import { arrayBufferToBase64, base64ToArrayBuffer } from './CbrepEncoding.js';
import { isLegacyEdgeKey, legacyEdgeKeyToStable } from './history/StableEntityKey.js';

function parseFeatureIdNumber(featureId) {
  if (typeof featureId !== 'string') return null;
  const match = /^feature_(\d+)$/.exec(featureId);
  return match ? parseInt(match[1], 10) : null;
}

function normalizeFeatureTreeData(featureTreeData) {
  if (!featureTreeData || !Array.isArray(featureTreeData.features)) {
    return featureTreeData;
  }

  const usedIds = new Set();
  const originalOccurrences = new Map();
  const numericIds = featureTreeData.features
    .map((feature) => parseFeatureIdNumber(feature && feature.id))
    .filter((value) => value != null);
  let nextGeneratedId = (numericIds.length > 0 ? Math.max(...numericIds) : 0) + 1;

  const takeNextId = () => {
    let candidate = `feature_${nextGeneratedId++}`;
    while (usedIds.has(candidate)) {
      candidate = `feature_${nextGeneratedId++}`;
    }
    return candidate;
  };

  const normalizedFeatures = featureTreeData.features.map((featureData, index) => {
    const originalId = featureData && featureData.id ? featureData.id : null;
    let resolvedId = originalId;
    if (!resolvedId || usedIds.has(resolvedId)) {
      resolvedId = takeNextId();
    }

    usedIds.add(resolvedId);

    if (originalId) {
      const occurrences = originalOccurrences.get(originalId) || [];
      occurrences.push({ index, resolvedId, type: featureData.type || null });
      originalOccurrences.set(originalId, occurrences);
    }

    return {
      ...featureData,
      id: resolvedId,
    };
  });

  const resolveReference = (referenceId, currentIndex, preferredType = null) => {
    if (!referenceId) return referenceId;
    const occurrences = originalOccurrences.get(referenceId);
    if (!occurrences || occurrences.length === 0) return referenceId;

    const priorOccurrences = occurrences.filter((entry) => entry.index < currentIndex);
    const searchPool = priorOccurrences.length > 0 ? priorOccurrences : occurrences;
    const typedPool = preferredType
      ? searchPool.filter((entry) => entry.type === preferredType)
      : searchPool;
    const chosenPool = typedPool.length > 0 ? typedPool : searchPool;
    return chosenPool[chosenPool.length - 1].resolvedId;
  };

  return {
    ...featureTreeData,
    features: normalizedFeatures.map((featureData, index) => ({
      ...featureData,
      dependencies: Array.isArray(featureData.dependencies)
        ? featureData.dependencies.map((dependencyId) => resolveReference(dependencyId, index))
        : [],
      children: Array.isArray(featureData.children)
        ? featureData.children.map((childId) => resolveReference(childId, index, 'sketch'))
        : [],
      sketchFeatureId: featureData.sketchFeatureId
        ? resolveReference(featureData.sketchFeatureId, index, 'sketch')
        : featureData.sketchFeatureId,
    })),
  };
}

function findFinalSolidFeature(featureTree) {
  if (!featureTree || !Array.isArray(featureTree.features)) return null;

  for (let index = featureTree.features.length - 1; index >= 0; index--) {
    const feature = featureTree.features[index];
    const result = feature && featureTree.results ? featureTree.results[feature.id] : null;
    if (!feature || feature.suppressed || !result || result.type !== 'solid') continue;
    return feature;
  }

  return null;
}

function restoreFinalCbrepPayload(part, payload, irHash) {
  if (!part?.featureTree || !payload) return false;

  let cbrepBuffer;
  try {
    cbrepBuffer = base64ToArrayBuffer(payload);
  } catch {
    return false;
  }

  const finalFeature = findFinalSolidFeature(part.featureTree);
  if (!finalFeature) return false;

  if (irHash && typeof finalFeature._applyIrCachePayload === 'function') {
    finalFeature._applyIrCachePayload(irHash, cbrepBuffer);
    return true;
  }

  return part.featureTree.attachCbrep(finalFeature.id, cbrepBuffer, irHash || null);
}

/**
 * Part represents a 3D solid part built from 2D sketches and 3D operations.
 * Uses a parametric feature tree where modifying a feature recalculates all dependent features.
 */
export class Part {
  constructor(name = 'Part1') {
    this.name = name;
    this.description = '';
    this.created = new Date();
    this.modified = new Date();
    
    // Parametric feature tree
    this.featureTree = new FeatureTree();
    
    // Custom reference planes
    this.customPlanes = [];
    
    // Default origin planes (XY, XZ, YZ)
    this.originPlanes = {
      XY: { visible: true, size: 5.0 },
      XZ: { visible: true, size: 5.0 },
      YZ: { visible: true, size: 5.0 },
    };

    // Flag: once the first feature is added, auto-hide origin planes.
    // After that the user controls visibility manually.
    this._originPlanesAutoHidden = false;
    
    // Currently active sketch feature ID (being edited)
    this.activeSketchId = null;
    
    // Material properties
    this.material = null;
    
    // Physical properties (calculated from features)
    this.mass = 0;
    this.volume = 0;
    this.centerOfMass = { x: 0, y: 0, z: 0 };

    // Global tessellation quality config — all features inherit from this
    this.tessellationConfig = new TessellationConfig();
  }

  /**
   * Attach the WASM handle/residency subsystem to this part's feature tree.
   * @param {import('./WasmBrepHandleRegistry.js').WasmBrepHandleRegistry|null} handleRegistry
   * @param {import('./HandleResidencyManager.js').HandleResidencyManager|null} residencyManager
   */
  setWasmHandleSubsystem(handleRegistry, residencyManager = null) {
    if (!this.featureTree) return;
    this.featureTree.setHandleRegistry(handleRegistry ?? null);
    this.featureTree.setResidencyManager(residencyManager ?? null);
  }
  
  // -----------------------------------------------------------------------
  // Custom plane management
  // -----------------------------------------------------------------------

  /**
   * Add a custom reference plane.
   * @param {Object} planeDef - Plane definition with name, offset, rotationU, rotationV, basePlane
   * @returns {Object} The added plane definition
   */
  addCustomPlane(planeDef) {
    this.modified = new Date();
    this.customPlanes.push(planeDef);
    return planeDef;
  }

  /**
   * Get all custom planes.
   * @returns {Array} Array of custom plane definitions
   */
  getCustomPlanes() {
    return this.customPlanes;
  }

  /**
   * Set visibility of an origin plane.
   * @param {'XY'|'XZ'|'YZ'} planeName - Name of the origin plane
   * @param {boolean} visible - Whether the plane is visible
   */
  setOriginPlaneVisible(planeName, visible) {
    if (this.originPlanes[planeName]) {
      this.originPlanes[planeName].visible = visible;
      this.modified = new Date();
    }
  }

  /**
   * Get the visibility state of origin planes.
   * @returns {Object} Origin plane visibility states
   */
  getOriginPlanes() {
    return this.originPlanes;
  }

  /**
   * Auto-hide origin planes on the first feature added to the part.
   * Once triggered, it is never called again (the user controls visibility).
   */
  _checkAutoHidePlanes() {
    if (this._originPlanesAutoHidden || this.featureTree.features.length === 0) return;
    this._originPlanesAutoHidden = true;
    this.setOriginPlaneVisible('XY', false);
    this.setOriginPlaneVisible('XZ', false);
    this.setOriginPlaneVisible('YZ', false);
  }

  /**
   * Set the active sketch being edited.
   * @param {string|null} sketchFeatureId - ID of the sketch feature being edited, or null
   */
  setActiveSketch(sketchFeatureId) {
    this.activeSketchId = sketchFeatureId;
  }

  /**
   * Get the currently active sketch feature ID.
   * @returns {string|null} Active sketch feature ID or null
   */
  getActiveSketchId() {
    return this.activeSketchId;
  }
  
  // -----------------------------------------------------------------------
  // Feature tree access
  // -----------------------------------------------------------------------
  
  /**
   * Get all features in the tree.
   * @returns {Feature[]} Array of features
   */
  getFeatures() {
    return this.featureTree.features;
  }
  
  /**
   * Get a feature by ID.
   * @param {string} featureId - The feature ID
   * @returns {Feature|null} The feature or null
   */
  getFeature(featureId) {
    return this.featureTree.getFeature(featureId);
  }

  /**
   * Generate the next name for a feature type (e.g. "Sketch 2", "Extrude 1").
   * Counts only features of the same type.
   */
  _nextTypeName(type, label) {
    const count = this.featureTree.features.filter(f => f.type === type).length;
    return `${label} ${count + 1}`;
  }
  
  /**
   * Get the final geometry result.
   * @returns {Object|null} The final result or null
   */
  getFinalGeometry() {
    return this.featureTree.getLastSolidResult() || this.featureTree.getFinalResult();
  }

  /**
   * Get the solid geometry result just before a specific feature.
   * Used for computing previews of chamfer/fillet edits.
   * @param {string} featureId - The feature ID to look before
   * @returns {Object|null} The solid result before the feature, or null
   */
  getGeometryBeforeFeature(featureId) {
    const idx = this.featureTree.getFeatureIndex(featureId);
    if (idx < 0) return null;
    for (let i = idx - 1; i >= 0; i--) {
      const f = this.featureTree.features[i];
      if (f.suppressed) continue;
      const r = this.featureTree.results[f.id];
      if (r && r.type === 'solid' && !r.error) return r;
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Sketch feature operations
  // -----------------------------------------------------------------------

  /**
   * Add a sketch feature to the part.
   * @param {Sketch} sketch - The sketch to add (optional, creates new if not provided)
   * @param {Object} plane - Sketch plane definition (optional)
   * @param {number} index - Position to insert feature (optional, default: append)
   * @returns {SketchFeature} The created sketch feature
   */
  addSketch(sketch = null, plane = null, index = -1) {
    this.modified = new Date();
    
    const sketchFeature = new SketchFeature(this._nextTypeName('sketch', 'Sketch'), sketch);
    
    if (plane) {
      sketchFeature.setPlane(plane);
    }
    
    this.featureTree.addFeature(sketchFeature, index);
    this._checkAutoHidePlanes();
    return sketchFeature;
  }

  /**
   * Remove a sketch feature from the part.
   * @param {string|SketchFeature} featureOrId - Feature or feature ID to remove
   * @returns {boolean} True if removed
   */
  removeSketch(featureOrId) {
    this.modified = new Date();
    return this.featureTree.removeFeature(featureOrId);
  }

  /**
   * Remove any feature from the part by ID.
   * @param {string} featureId - Feature ID to remove
   * @returns {boolean} True if removed
   */
  removeFeature(featureId) {
    this.modified = new Date();
    const feature = this.featureTree.getFeature(featureId);
    if (!feature) return false;

    const childSketchIds = (feature.children || []).filter((childId) => {
      const child = this.featureTree.getFeature(childId);
      return child && child.type === 'sketch';
    });

    const removed = this.featureTree.removeFeature(featureId);
    if (!removed) return false;

    // If a removed feature was hiding linked sketch(es), restore visibility
    // when no other remaining feature references those sketches.
    for (const sketchId of childSketchIds) {
      const stillReferenced = this.featureTree.features.some((f) =>
        Array.isArray(f.children) && f.children.includes(sketchId)
      );
      if (!stillReferenced) {
        const sketchFeature = this.featureTree.getFeature(sketchId);
        if (sketchFeature && sketchFeature.type === 'sketch') {
          sketchFeature.setVisible(true);
        }
      }
    }

    return true;
  }

  /**
   * Get all sketch features in the part.
   * @returns {SketchFeature[]} Array of sketch features
   */
  getSketches() {
    return this.featureTree.features.filter(f => f.type === 'sketch');
  }

  /**
   * Get a sketch feature by name.
   * @param {string} name - The name of the sketch feature
   * @returns {SketchFeature|null} The sketch feature or null if not found
   */
  getSketchByName(name) {
    return this.featureTree.features.find(f => f.type === 'sketch' && f.name === name) || null;
  }

  // -----------------------------------------------------------------------
  // 3D Feature operations
  // -----------------------------------------------------------------------

  /**
   * Extrude a sketch to create a 3D solid.
   * @param {string|SketchFeature} sketchOrId - Sketch feature or ID to extrude
   * @param {number} distance - The extrusion distance
   * @param {Object} options - Additional options (operation, direction, symmetric)
   * @returns {ExtrudeFeature} The created extrude feature
   */
  extrude(sketchOrId, distance, options = {}) {
    this.modified = new Date();
    
    const sketchId = typeof sketchOrId === 'string' ? sketchOrId : sketchOrId.id;
    const sketchFeature = this.featureTree.getFeature(sketchId);
    
    if (!sketchFeature || sketchFeature.type !== 'sketch') {
      throw new Error('Invalid sketch feature');
    }
    
    const extrudeFeature = new ExtrudeFeature(this._nextTypeName('extrude', 'Extrude'), sketchId, distance);
    
    // If there is already a solid body in the feature tree, default to 'add'
    // so subsequent features are combined (union) rather than replacing the body.
    if (!options.operation) {
      const existingSolid = this.featureTree.getLastSolidResult();
      if (existingSolid && existingSolid.type === 'solid') {
        extrudeFeature.operation = 'add';
      }
    } else {
      extrudeFeature.operation = options.operation;
    }
    if (options.direction) extrudeFeature.direction = options.direction;
    if (options.symmetric !== undefined) extrudeFeature.symmetric = options.symmetric;
    if (options.extrudeType) extrudeFeature.extrudeType = options.extrudeType;
    if (options.taper !== undefined) extrudeFeature.taper = options.taper;
    if (options.taperAngle != null) extrudeFeature.taperAngle = options.taperAngle;
    if (options.taperInward !== undefined) extrudeFeature.taperInward = options.taperInward;
    
    // Link the sketch as a child of the extrude feature and hide it
    extrudeFeature.addChild(sketchId);
    sketchFeature.setVisible(false);
    
    this.featureTree.addFeature(extrudeFeature);
    this._checkAutoHidePlanes();
    // Note: Physical properties are computed lazily when requested
    
    return extrudeFeature;
  }

  /**
   * Extrude-cut a sketch (subtract by default).
   * @param {string|SketchFeature} sketchOrId - Sketch feature or ID
   * @param {number} distance - The extrusion distance
   * @param {Object} options - Additional options
   * @returns {ExtrudeCutFeature} The created extrude-cut feature
   */
  extrudeCut(sketchOrId, distance, options = {}) {
    this.modified = new Date();

    const sketchId = typeof sketchOrId === 'string' ? sketchOrId : sketchOrId.id;
    const sketchFeature = this.featureTree.getFeature(sketchId);

    if (!sketchFeature || sketchFeature.type !== 'sketch') {
      throw new Error('Invalid sketch feature');
    }

    const feature = new ExtrudeCutFeature(this._nextTypeName('extrude-cut', 'Extrude Cut'), sketchId, distance);

    if (options.operation) feature.operation = options.operation;
    if (options.direction) feature.direction = options.direction;
    if (options.symmetric !== undefined) feature.symmetric = options.symmetric;
    if (options.extrudeType) feature.extrudeType = options.extrudeType;
    if (options.taper !== undefined) feature.taper = options.taper;
    if (options.taperAngle != null) feature.taperAngle = options.taperAngle;
    if (options.taperInward !== undefined) feature.taperInward = options.taperInward;

    feature.addChild(sketchId);
    sketchFeature.setVisible(false);

    this.featureTree.addFeature(feature);
    this._checkAutoHidePlanes();

    return feature;
  }

  /**
   * Revolve a sketch around an axis.
   * @param {string|SketchFeature} sketchOrId - Sketch feature or ID to revolve
   * @param {number} angle - The revolution angle in radians
    * @param {Object} options - Additional options (operation, axis, axisSegmentId)
   * @returns {RevolveFeature} The created revolve feature
   */
  revolve(sketchOrId, angle, options = {}) {
    this.modified = new Date();
    
    const sketchId = typeof sketchOrId === 'string' ? sketchOrId : sketchOrId.id;
    const sketchFeature = this.featureTree.getFeature(sketchId);
    
    if (!sketchFeature || sketchFeature.type !== 'sketch') {
      throw new Error('Invalid sketch feature');
    }
    
    const revolveFeature = new RevolveFeature(this._nextTypeName('revolve', 'Revolve'), sketchId, angle);
    
    if (!options.operation) {
      const existingSolid = this.featureTree.getLastSolidResult();
      if (existingSolid && existingSolid.type === 'solid') {
        revolveFeature.operation = 'add';
      }
    } else {
      revolveFeature.operation = options.operation;
    }

    if (options.axisSegmentId != null) {
      const axisResolution = sketchFeature.resolveRevolveAxis(options.axisSegmentId);
      revolveFeature.setAxisSegmentId(axisResolution.axisSegmentId);
      revolveFeature.setAxis(axisResolution.axis.origin, axisResolution.axis.direction, 'construction');
    } else if (options.axis) {
      revolveFeature.setAxis(options.axis.origin, options.axis.direction, 'manual');
    } else {
      const axisResolution = sketchFeature.resolveRevolveAxis();
      if (axisResolution.axis && axisResolution.axisSegmentId != null) {
        revolveFeature.setAxisSegmentId(axisResolution.axisSegmentId);
        revolveFeature.setAxis(axisResolution.axis.origin, axisResolution.axis.direction, 'construction');
      }
    }
    
    // Link the sketch as a child of the revolve feature and hide it
    revolveFeature.addChild(sketchId);
    sketchFeature.setVisible(false);
    
    this.featureTree.addFeature(revolveFeature);
    this._checkAutoHidePlanes();
    // Note: Physical properties are computed lazily when requested
    
    return revolveFeature;
  }

  /**
   * Add a fillet to selected edges.
   * @param {string[]} edgeKeys - Edge keys identifying the edges to fillet
   * @param {number} radius - The fillet radius
   * @param {Object} options - Additional options (segments)
   * @returns {FilletFeature} The created fillet feature
   */
  fillet(edgeKeys, radius, options = {}) {
    this.modified = new Date();

    const feature = new FilletFeature(this._nextTypeName('fillet', 'Fillet'), radius);
    feature.setEdgeKeys(edgeKeys);
    if (options.segments) {
      feature.setSegments(options.segments);
    } else {
      feature.setSegments(globalTessConfig.curveSegments);
    }

    // Auto-populate stable entity keys for new features
    feature.stableEdgeKeys = edgeKeys
      .filter(k => isLegacyEdgeKey(k))
      .map(k => legacyEdgeKeyToStable(k, feature.id))
      .filter(k => k !== null);

    this.featureTree.addFeature(feature);
    this._checkAutoHidePlanes();
    return feature;
  }

  /**
   * Add a chamfer to selected edges.
   * @param {string[]} edgeKeys - Edge keys identifying the edges to chamfer
   * @param {number} distance - The chamfer distance
   * @returns {ChamferFeature} The created chamfer feature
   */
  chamfer(edgeKeys, distance) {
    this.modified = new Date();

    const feature = new ChamferFeature(this._nextTypeName('chamfer', 'Chamfer'), distance);
    feature.setEdgeKeys(edgeKeys);

    // Auto-populate stable entity keys for new features
    feature.stableEdgeKeys = edgeKeys
      .filter(k => isLegacyEdgeKey(k))
      .map(k => legacyEdgeKeyToStable(k, feature.id))
      .filter(k => k !== null);

    this.featureTree.addFeature(feature);
    this._checkAutoHidePlanes();
    return feature;
  }

  /**
   * Import a STEP file as a solid body feature.
   * The imported geometry becomes a base body that subsequent parametric
   * operations (extrude-cut, chamfer, fillet, boolean) can act upon.
   *
   * @param {string} stepData - Raw STEP file contents
   * @param {Object} [options]
   * @param {string} [options.name] - Feature name (auto-generated if omitted)
   * @returns {StepImportFeature} The created STEP import feature
   */
  importSTEP(stepData, options = {}) {
    this.modified = new Date();

    const name = options.name || this._nextTypeName('step-import', 'STEP Import');
    const feature = new StepImportFeature(name, stepData, {
      curveSegments: globalTessConfig.curveSegments,
    });

    this.featureTree.addFeature(feature);
    this._checkAutoHidePlanes();
    return feature;
  }

  // -----------------------------------------------------------------------
  // Feature modification (triggers recalculation)
  // -----------------------------------------------------------------------

  /**
   * Modify a feature parameter and trigger recalculation.
   * @param {string|Feature} featureOrId - Feature or feature ID to modify
   * @param {Function} modifyFn - Function that modifies the feature
   */
  modifyFeature(featureOrId, modifyFn) {
    const featureId = typeof featureOrId === 'string' ? featureOrId : featureOrId.id;
    const feature = this.featureTree.getFeature(featureId);
    
    if (feature) {
      modifyFn(feature);
      this.featureTree.markModified(featureId);
      this.modified = new Date();
      this.updatePhysicalProperties();
    }
  }

  /**
   * Suppress a feature (disable it temporarily).
   * @param {string|Feature} featureOrId - Feature or feature ID to suppress
   */
  suppressFeature(featureOrId) {
    const featureId = typeof featureOrId === 'string' ? featureOrId : featureOrId.id;
    const feature = this.featureTree.getFeature(featureId);
    
    if (feature) {
      feature.suppress();
      this.featureTree.markModified(featureId);
      this.modified = new Date();
    }
  }

  /**
   * Unsuppress a feature (enable it).
   * @param {string|Feature} featureOrId - Feature or feature ID to unsuppress
   */
  unsuppressFeature(featureOrId) {
    const featureId = typeof featureOrId === 'string' ? featureOrId : featureOrId.id;
    const feature = this.featureTree.getFeature(featureId);
    
    if (feature) {
      feature.unsuppress();
      this.featureTree.markModified(featureId);
      this.modified = new Date();
    }
  }

  /**
   * Reorder a feature in the tree.
   * @param {string|Feature} featureOrId - Feature or feature ID to reorder
   * @param {number} newIndex - New position in the tree
   */
  reorderFeature(featureOrId, newIndex) {
    this.featureTree.reorderFeature(featureOrId, newIndex);
    this.modified = new Date();
    // Note: Physical properties will be recomputed when requested
  }

  // -----------------------------------------------------------------------
  // Physical properties
  // -----------------------------------------------------------------------

  /**
   * Update physical properties from the final geometry.
   */
  updatePhysicalProperties() {
    const finalResult = this.featureTree.getFinalResult();
    
    if (finalResult && finalResult.volume !== undefined) {
      this.volume = finalResult.volume;
      
      // Calculate mass if material is set
      if (this.material && this.material.density) {
        this.mass = this.volume * this.material.density;
      }
    }
  }

  /**
   * Set material properties.
   * @param {Object} material - Material with properties like density, color, etc.
   */
  setMaterial(material) {
    this.material = material;
    this.modified = new Date();
    this.updatePhysicalProperties();
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  serialize() {
    const serialized = {
      type: 'Part',
      name: this.name,
      description: this.description,
      created: this.created.toISOString(),
      modified: this.modified.toISOString(),
      featureTree: this.featureTree.serialize(),
      originPlanes: this.originPlanes,
      originPlanesAutoHidden: this._originPlanesAutoHidden,
      material: this.material,
      mass: this.mass,
      volume: this.volume,
      centerOfMass: this.centerOfMass,
      tessellationConfig: this.tessellationConfig.serialize(),
    };

    const finalResult = this.featureTree?.getFinalResult?.();
    if (finalResult?.type === 'solid' && finalResult.cbrepBuffer) {
      serialized._finalCbrepPayload = arrayBufferToBase64(finalResult.cbrepBuffer);
      if (finalResult.irHash) {
        serialized._finalCbrepHash = finalResult.irHash;
      }
    }

    return serialized;
  }

  static deserialize(data, options = {}) {
    const part = new Part();
    if (!data) return part;

    part.name = data.name || 'Part1';
    part.description = data.description || '';
    part.created = data.created ? new Date(data.created) : new Date();
    part.modified = data.modified ? new Date(data.modified) : new Date();
    
    // Deserialize feature tree
    if (data.featureTree) {
      const normalizedFeatureTree = normalizeFeatureTreeData(data.featureTree);
      part.featureTree = FeatureTree.deserialize(normalizedFeatureTree, (featureData) => {
        // Factory function to create features based on type
        switch (featureData.type) {
          case 'sketch':
            return SketchFeature.deserialize(featureData);
          case 'extrude':
            return ExtrudeFeature.deserialize(featureData);
          case 'extrude-cut':
            return ExtrudeCutFeature.deserialize(featureData);
          case 'multi-sketch-extrude':
            return MultiSketchExtrudeFeature.deserialize(featureData);
          case 'revolve':
            return RevolveFeature.deserialize(featureData);
          case 'chamfer':
            return ChamferFeature.deserialize(featureData);
          case 'fillet':
            return FilletFeature.deserialize(featureData);
          case 'step-import':
            return StepImportFeature.deserialize(featureData);
          default:
            console.warn(`Unknown feature type: ${featureData.type}`);
            return null;
        }
      }, {
        handleRegistry: options.handleRegistry ?? null,
        residencyManager: options.residencyManager ?? null,
      });
    }
    
    // Deserialize material and physical properties
    part.material = data.material || null;
    part.mass = data.mass || 0;
    part.volume = data.volume || 0;
    part.centerOfMass = data.centerOfMass || { x: 0, y: 0, z: 0 };

    // Deserialize origin planes
    if (data.originPlanes) {
      part.originPlanes = {
        XY: { ...part.originPlanes.XY, ...data.originPlanes.XY },
        XZ: { ...part.originPlanes.XZ, ...data.originPlanes.XZ },
        YZ: { ...part.originPlanes.YZ, ...data.originPlanes.YZ },
      };
    }

    // Restore auto-hide flag; for old data without the flag, infer from
    // whether the part already has features (auto-hide already fired).
    part._originPlanesAutoHidden = data.originPlanesAutoHidden !== undefined
      ? data.originPlanesAutoHidden
      : (part.featureTree.features.length > 0);

    // Restore global tessellation config (falls back to defaults for old files)
    part.tessellationConfig = TessellationConfig.deserialize(data.tessellationConfig);
    // Sync the global singleton so all callers see the deserialized values
    Object.assign(globalTessConfig, part.tessellationConfig);

    part.setWasmHandleSubsystem(options.handleRegistry ?? null, options.residencyManager ?? null);

    const finalCbrepPayload = options.finalCbrepPayload ?? data._finalCbrepPayload ?? null;
    const finalCbrepHash = options.finalCbrepHash ?? data._finalCbrepHash ?? null;
    restoreFinalCbrepPayload(part, finalCbrepPayload, finalCbrepHash);

    return part;
  }
}

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
import { RevolveFeature } from './RevolveFeature.js';

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
    
    // Material properties
    this.material = null;
    
    // Physical properties (calculated from features)
    this.mass = 0;
    this.volume = 0;
    this.centerOfMass = { x: 0, y: 0, z: 0 };
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
   * Get the final geometry result.
   * @returns {Object|null} The final result or null
   */
  getFinalGeometry() {
    return this.featureTree.getFinalResult();
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
    
    const sketchFeature = new SketchFeature(`Sketch${this.featureTree.features.length + 1}`, sketch);
    
    if (plane) {
      sketchFeature.setPlane(plane);
    }
    
    this.featureTree.addFeature(sketchFeature, index);
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
    
    const extrudeFeature = new ExtrudeFeature(`Extrude${this.featureTree.features.length + 1}`, sketchId, distance);
    
    if (options.operation) extrudeFeature.operation = options.operation;
    if (options.direction) extrudeFeature.direction = options.direction;
    if (options.symmetric !== undefined) extrudeFeature.symmetric = options.symmetric;
    
    this.featureTree.addFeature(extrudeFeature);
    this.updatePhysicalProperties();
    
    return extrudeFeature;
  }

  /**
   * Revolve a sketch around an axis.
   * @param {string|SketchFeature} sketchOrId - Sketch feature or ID to revolve
   * @param {number} angle - The revolution angle in radians
   * @param {Object} options - Additional options (operation, axis)
   * @returns {RevolveFeature} The created revolve feature
   */
  revolve(sketchOrId, angle, options = {}) {
    this.modified = new Date();
    
    const sketchId = typeof sketchOrId === 'string' ? sketchOrId : sketchOrId.id;
    const sketchFeature = this.featureTree.getFeature(sketchId);
    
    if (!sketchFeature || sketchFeature.type !== 'sketch') {
      throw new Error('Invalid sketch feature');
    }
    
    const revolveFeature = new RevolveFeature(`Revolve${this.featureTree.features.length + 1}`, sketchId, angle);
    
    if (options.operation) revolveFeature.operation = options.operation;
    if (options.axis) revolveFeature.setAxis(options.axis.origin, options.axis.direction);
    
    this.featureTree.addFeature(revolveFeature);
    this.updatePhysicalProperties();
    
    return revolveFeature;
  }

  /**
   * Add a fillet to an edge (placeholder for future implementation).
   * @param {Object} edge - The edge to fillet
   * @param {number} radius - The fillet radius
   * @returns {Object} Feature object (stub)
   */
  fillet(edge, radius) {
    this.modified = new Date();
    console.warn('Part.fillet() is not yet fully implemented');
    // Future: Create FilletFeature and add to tree
    return { type: 'fillet', edge, radius };
  }

  /**
   * Add a chamfer to an edge (placeholder for future implementation).
   * @param {Object} edge - The edge to chamfer
   * @param {number} distance - The chamfer distance
   * @returns {Object} Feature object (stub)
   */
  chamfer(edge, distance) {
    this.modified = new Date();
    console.warn('Part.chamfer() is not yet fully implemented');
    // Future: Create ChamferFeature and add to tree
    return { type: 'chamfer', edge, distance };
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
    this.updatePhysicalProperties();
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
    return {
      type: 'Part',
      name: this.name,
      description: this.description,
      created: this.created.toISOString(),
      modified: this.modified.toISOString(),
      featureTree: this.featureTree.serialize(),
      material: this.material,
      mass: this.mass,
      volume: this.volume,
      centerOfMass: this.centerOfMass,
    };
  }

  static deserialize(data) {
    const part = new Part();
    if (!data) return part;

    part.name = data.name || 'Part1';
    part.description = data.description || '';
    part.created = data.created ? new Date(data.created) : new Date();
    part.modified = data.modified ? new Date(data.modified) : new Date();
    
    // Deserialize feature tree
    if (data.featureTree) {
      part.featureTree = FeatureTree.deserialize(data.featureTree, (featureData) => {
        // Factory function to create features based on type
        switch (featureData.type) {
          case 'sketch':
            return SketchFeature.deserialize(featureData);
          case 'extrude':
            return ExtrudeFeature.deserialize(featureData);
          case 'revolve':
            return RevolveFeature.deserialize(featureData);
          default:
            console.warn(`Unknown feature type: ${featureData.type}`);
            return null;
        }
      });
    }
    
    // Deserialize material and physical properties
    part.material = data.material || null;
    part.mass = data.mass || 0;
    part.volume = data.volume || 0;
    part.centerOfMass = data.centerOfMass || { x: 0, y: 0, z: 0 };

    return part;
  }
}

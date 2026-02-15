// js/cad/Part.js — Part design stub for future 3D part modeling
// This class will eventually support 3D part design including:
// - Multiple sketches on different planes
// - Extrude, revolve, sweep, loft operations
// - Fillets, chamfers, shells, and other 3D features
// - Material properties and mass calculations

import { Sketch } from './Sketch.js';

/**
 * Part represents a 3D solid part built from 2D sketches and 3D operations.
 * Currently a stub for future implementation.
 */
export class Part {
  constructor(name = 'Part1') {
    this.name = name;
    this.description = '';
    this.created = new Date();
    this.modified = new Date();
    
    // Collection of sketches used to build this part
    this.sketches = [];
    
    // Future: Collection of 3D features (extrudes, revolves, etc.)
    this.features = [];
    
    // Future: Material properties
    this.material = null;
    
    // Future: Physical properties
    this.mass = 0;
    this.volume = 0;
    this.centerOfMass = { x: 0, y: 0, z: 0 };
  }

  // -----------------------------------------------------------------------
  // Sketch management
  // -----------------------------------------------------------------------

  /**
   * Add a new sketch to this part
   * @param {Sketch} sketch - The sketch to add
   * @returns {Sketch} The added sketch
   */
  addSketch(sketch) {
    this.modified = new Date();
    if (!sketch) {
      sketch = new Sketch();
      sketch.name = `Sketch${this.sketches.length + 1}`;
    }
    this.sketches.push(sketch);
    return sketch;
  }

  /**
   * Remove a sketch from this part
   * @param {Sketch} sketch - The sketch to remove
   */
  removeSketch(sketch) {
    this.modified = new Date();
    const idx = this.sketches.indexOf(sketch);
    if (idx >= 0) {
      this.sketches.splice(idx, 1);
    }
  }

  /**
   * Get a sketch by name
   * @param {string} name - The name of the sketch
   * @returns {Sketch|null} The sketch or null if not found
   */
  getSketchByName(name) {
    return this.sketches.find(s => s.name === name) || null;
  }

  // -----------------------------------------------------------------------
  // Future: 3D Feature operations (stubs)
  // -----------------------------------------------------------------------

  /**
   * Future: Extrude a sketch to create a 3D solid
   * @param {Sketch} sketch - The sketch to extrude
   * @param {number} distance - The extrusion distance
   * @returns {Object} Feature object (stub)
   */
  extrude(sketch, distance) {
    this.modified = new Date();
    console.warn('Part.extrude() is not yet implemented');
    // Future implementation
    return { type: 'extrude', sketch, distance };
  }

  /**
   * Future: Revolve a sketch around an axis
   * @param {Sketch} sketch - The sketch to revolve
   * @param {number} angle - The revolution angle in radians
   * @returns {Object} Feature object (stub)
   */
  revolve(sketch, angle) {
    this.modified = new Date();
    console.warn('Part.revolve() is not yet implemented');
    // Future implementation
    return { type: 'revolve', sketch, angle };
  }

  /**
   * Future: Add a fillet to an edge
   * @param {Object} edge - The edge to fillet
   * @param {number} radius - The fillet radius
   * @returns {Object} Feature object (stub)
   */
  fillet(edge, radius) {
    this.modified = new Date();
    console.warn('Part.fillet() is not yet implemented');
    // Future implementation
    return { type: 'fillet', edge, radius };
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  serialize() {
    return {
      name: this.name,
      description: this.description,
      created: this.created.toISOString(),
      modified: this.modified.toISOString(),
      sketches: this.sketches.map(s => s.serialize()),
      features: this.features,
    };
  }

  static deserialize(data) {
    const part = new Part();
    if (!data) return part;

    part.name = data.name || 'Part1';
    part.description = data.description || '';
    part.created = data.created ? new Date(data.created) : new Date();
    part.modified = data.modified ? new Date(data.modified) : new Date();
    
    // Deserialize sketches
    if (data.sketches) {
      part.sketches = data.sketches.map(s => Sketch.deserialize(s));
    }
    
    // Future: Deserialize features
    if (data.features) {
      part.features = data.features;
    }

    return part;
  }
}

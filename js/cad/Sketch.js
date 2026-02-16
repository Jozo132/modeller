// js/cad/Sketch.js — Drawing interface for 2D sketching
// This class provides the drawing interface for creating and editing 2D geometry
// It wraps the Scene class and provides sketch-specific functionality

import { Scene } from './Scene.js';

/**
 * Sketch represents a 2D drawing plane with geometric primitives and constraints.
 * It serves as the primary drawing interface for creating 2D geometry that can later
 * be used in Part and Assembly designs.
 */
export class Sketch {
  constructor() {
    // The underlying scene that manages all primitives and constraints
    this.scene = new Scene();
    
    // Sketch metadata
    this.name = 'Sketch1';
    this.description = '';
    this.created = new Date();
    this.modified = new Date();
  }

  // -----------------------------------------------------------------------
  // Scene delegation - Forward all Scene methods
  // -----------------------------------------------------------------------

  // Point helpers
  addPoint(x, y, fixed = false) {
    this.modified = new Date();
    return this.scene.addPoint(x, y, fixed);
  }

  getOrCreatePoint(x, y, tolerance) {
    const pointsBefore = this.scene.points.length;
    const point = this.scene.getOrCreatePoint(x, y, tolerance);
    // Only update timestamp if a new point was created
    if (this.scene.points.length > pointsBefore) {
      this.modified = new Date();
    }
    return point;
  }

  pointById(id) {
    return this.scene.pointById(id);
  }

  // Shape creation
  addSegment(x1, y1, x2, y2, options) {
    this.modified = new Date();
    return this.scene.addSegment(x1, y1, x2, y2, options);
  }

  addCircle(cx, cy, radius, options) {
    this.modified = new Date();
    return this.scene.addCircle(cx, cy, radius, options);
  }

  addArc(cx, cy, radius, startAngle, endAngle, options) {
    this.modified = new Date();
    return this.scene.addArc(cx, cy, radius, startAngle, endAngle, options);
  }

  // Constraint management
  addConstraint(c) {
    this.modified = new Date();
    return this.scene.addConstraint(c);
  }

  removeConstraint(c) {
    this.modified = new Date();
    return this.scene.removeConstraint(c);
  }

  solve(opts) {
    return this.scene.solve(opts);
  }

  // Removal
  removePoint(pt) {
    this.modified = new Date();
    return this.scene.removePoint(pt);
  }

  removeSegment(seg) {
    this.modified = new Date();
    return this.scene.removeSegment(seg);
  }

  removeCircle(circ) {
    this.modified = new Date();
    return this.scene.removeCircle(circ);
  }

  removeArc(arc) {
    this.modified = new Date();
    return this.scene.removeArc(arc);
  }

  removePrimitive(prim) {
    this.modified = new Date();
    return this.scene.removePrimitive(prim);
  }

  // Iteration
  shapes() {
    return this.scene.shapes();
  }

  allPrimitives() {
    return this.scene.allPrimitives();
  }

  // Lookup helpers
  findClosestShape(wx, wy, worldTolerance) {
    return this.scene.findClosestShape(wx, wy, worldTolerance);
  }

  findClosestPoint(wx, wy, worldTolerance) {
    return this.scene.findClosestPoint(wx, wy, worldTolerance);
  }

  shapesUsingPoint(pt) {
    return this.scene.shapesUsingPoint(pt);
  }

  constraintsOn(prim) {
    return this.scene.constraintsOn(prim);
  }

  // Bounds
  getBounds() {
    return this.scene.getBounds();
  }

  // Clear / reset
  clear() {
    this.modified = new Date();
    return this.scene.clear();
  }

  // -----------------------------------------------------------------------
  // Direct access to scene collections
  // -----------------------------------------------------------------------
  
  get points() { return this.scene.points; }
  get segments() { return this.scene.segments; }
  get arcs() { return this.scene.arcs; }
  get circles() { return this.scene.circles; }
  get constraints() { return this.scene.constraints; }
  get texts() { return this.scene.texts; }
  get dimensions() { return this.scene.dimensions; }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  serialize() {
    return {
      name: this.name,
      description: this.description,
      created: this.created.toISOString(),
      modified: this.modified.toISOString(),
      scene: this.scene.serialize(),
    };
  }

  static deserialize(data) {
    const sketch = new Sketch();
    if (!data) return sketch;

    sketch.name = data.name || 'Sketch1';
    sketch.description = data.description || '';
    sketch.created = data.created ? new Date(data.created) : new Date();
    sketch.modified = data.modified ? new Date(data.modified) : new Date();
    
    // Deserialize the scene
    if (data.scene) {
      sketch.scene = Scene.deserialize(data.scene);
    }

    return sketch;
  }
}

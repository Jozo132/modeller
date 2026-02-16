// part-manager.js - Manages 3D Part workflow and operations

import { Part } from './cad/Part.js';
import { Sketch } from './cad/Sketch.js';

/**
 * PartManager - Handles 3D part creation and feature management
 */
export class PartManager {
  constructor() {
    this.part = null;
    this.activeFeature = null;
    this.listeners = [];
  }

  /**
   * Create a new part
   * @param {string} name - Part name
   */
  createPart(name = 'Part1') {
    this.part = new Part(name);
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
    
    // Copy segments from the scene
    if (scene.segments && scene.segments.length > 0) {
      scene.segments.forEach(seg => {
        const s = seg.p1 || seg.start;
        const e = seg.p2 || seg.end;
        if (s && e) {
          sketch.addSegment(s.x, s.y, e.x, e.y);
        }
      });
    }

    // Copy circles
    if (scene.circles && scene.circles.length > 0) {
      scene.circles.forEach(circle => {
        sketch.addCircle(circle.center.x, circle.center.y, circle.radius);
      });
    }

    // Copy arcs
    if (scene.arcs && scene.arcs.length > 0) {
      scene.arcs.forEach(arc => {
        // Convert arc to segments (8-segment approximation)
        const numSegments = 8;
        const totalAngle = arc.endAngle - arc.startAngle;
        for (let i = 0; i < numSegments; i++) {
          const angle1 = arc.startAngle + (i / numSegments) * totalAngle;
          const angle2 = arc.startAngle + ((i + 1) / numSegments) * totalAngle;
          const x1 = arc.center.x + Math.cos(angle1) * arc.radius;
          const y1 = arc.center.y + Math.sin(angle1) * arc.radius;
          const x2 = arc.center.x + Math.cos(angle2) * arc.radius;
          const y2 = arc.center.y + Math.sin(angle2) * arc.radius;
          sketch.addSegment(x1, y1, x2, y2);
        }
      });
    }

    const sketchFeature = this.part.addSketch(sketch, plane);
    this.activeFeature = sketchFeature;
    this.notifyListeners();
    return sketchFeature;
  }

  /**
   * Extrude the active sketch feature
   * @param {string} sketchFeatureId - ID of sketch feature to extrude
   * @param {number} distance - Extrusion distance
   */
  extrude(sketchFeatureId, distance = 10) {
    if (!this.part) return null;

    const feature = this.part.extrude(sketchFeatureId, distance);
    this.activeFeature = feature;
    this.notifyListeners();
    return feature;
  }

  /**
   * Revolve the active sketch feature
   * @param {string} sketchFeatureId - ID of sketch feature to revolve
   * @param {number} angle - Revolution angle in radians
   */
  revolve(sketchFeatureId, angle = Math.PI * 2) {
    if (!this.part) return null;

    const feature = this.part.revolve(sketchFeatureId, angle);
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
   */
  deserialize(data) {
    if (!data) return;

    this.part = Part.deserialize(data);
    this.activeFeature = null;
    this.notifyListeners();
  }
}

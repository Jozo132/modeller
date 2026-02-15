// js/cad/SketchFeature.js — Sketch as a parametric feature
// Wraps a Sketch object as a feature in the parametric tree

import { Feature } from './Feature.js';
import { Sketch } from './Sketch.js';

/**
 * SketchFeature represents a 2D sketch in the parametric feature tree.
 * The sketch defines 2D geometry on a plane that can be used by 3D operations.
 */
export class SketchFeature extends Feature {
  constructor(name = 'Sketch', sketch = null) {
    super(name);
    this.type = 'sketch';
    
    // The underlying sketch object
    this.sketch = sketch || new Sketch();
    this.sketch.name = name;
    
    // Sketch plane definition (for 3D positioning)
    this.plane = {
      origin: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1 },  // Default: XY plane
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
    };
  }

  /**
   * Execute this sketch feature.
   * @param {Object} context - Execution context
   * @returns {Object} Result with sketch geometry
   */
  execute(context) {
    // Solve constraints in the sketch
    this.sketch.solve();
    
    // Return the sketch as the result
    return {
      type: 'sketch',
      sketch: this.sketch,
      plane: this.plane,
      profiles: this.extractProfiles(),
    };
  }

  /**
   * Extract closed profiles from the sketch for use in 3D operations.
   * A profile is a closed loop of connected segments, or a circle.
   * @returns {Array} Array of profile objects
   */
  extractProfiles() {
    const profiles = [];
    const visited = new Set();
    
    // Handle circles as closed profiles (a circle is inherently a closed loop)
    for (const circle of this.sketch.circles) {
      const numPoints = 32;
      const points = [];
      for (let i = 0; i < numPoints; i++) {
        const angle = (i / numPoints) * Math.PI * 2;
        points.push({
          x: circle.center.x + Math.cos(angle) * circle.radius,
          y: circle.center.y + Math.sin(angle) * circle.radius,
        });
      }
      profiles.push({ points, closed: true });
    }

    // Find all closed loops of segments in the sketch
    for (const seg of this.sketch.segments) {
      if (visited.has(seg.id)) continue;
      
      const profile = this.traceProfile(seg, visited);
      if (profile && profile.closed) {
        profiles.push(profile);
      }
    }
    
    return profiles;
  }

  /**
   * Trace a profile starting from a segment.
   * @param {Object} startSeg - Starting segment
   * @param {Set} visited - Set of visited segment IDs
   * @returns {Object|null} Profile object or null
   */
  traceProfile(startSeg, visited) {
    const segments = [];
    const points = [];
    
    let current = startSeg;
    let currentEnd = current.p2;
    let startPoint = current.p1;
    
    // Follow connected segments
    while (current) {
      if (visited.has(current.id)) break;
      
      visited.add(current.id);
      segments.push(current);
      points.push(currentEnd);
      
      // Find next connected segment
      const connected = this.sketch.segments.find(s => 
        !visited.has(s.id) && (s.p1 === currentEnd || s.p2 === currentEnd)
      );
      
      if (!connected) break;
      
      // Update for next iteration
      current = connected;
      currentEnd = (connected.p1 === currentEnd) ? connected.p2 : connected.p1;
      
      // Check if we closed the loop
      if (currentEnd === startPoint) {
        return {
          segments,
          points,
          closed: true,
        };
      }
    }
    
    // Not a closed loop
    return {
      segments,
      points,
      closed: false,
    };
  }

  /**
   * Set the sketch plane.
   * @param {Object} plane - Plane definition with origin, normal, xAxis, yAxis
   */
  setPlane(plane) {
    this.plane = { ...this.plane, ...plane };
    this.modified = new Date();
  }

  /**
   * Serialize this sketch feature.
   */
  serialize() {
    return {
      ...super.serialize(),
      sketch: this.sketch.serialize(),
      plane: this.plane,
    };
  }

  /**
   * Deserialize a sketch feature from JSON.
   */
  static deserialize(data) {
    const feature = new SketchFeature();
    if (!data) return feature;
    
    // Deserialize base feature properties
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'sketch';
    
    // Deserialize sketch
    if (data.sketch) {
      feature.sketch = Sketch.deserialize(data.sketch);
    }
    
    // Deserialize plane
    if (data.plane) {
      feature.plane = data.plane;
    }
    
    return feature;
  }
}

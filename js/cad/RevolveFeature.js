// js/cad/RevolveFeature.js — Revolve operation feature
// Revolves a 2D sketch profile around an axis to create 3D geometry

import { Feature } from './Feature.js';

/**
 * RevolveFeature revolves a 2D sketch profile around an axis to create 3D geometry.
 */
export class RevolveFeature extends Feature {
  constructor(name = 'Revolve', sketchFeatureId = null, angle = Math.PI * 2) {
    super(name);
    this.type = 'revolve';
    
    // Reference to the sketch feature to revolve
    this.sketchFeatureId = sketchFeatureId;
    if (sketchFeatureId) {
      this.addDependency(sketchFeatureId);
    }
    
    // Revolve parameters
    this.angle = angle; // Angle in radians (2π = 360°)
    this.segments = 32; // Number of segments for approximation
    
    // Axis of revolution (in sketch plane coordinates)
    this.axis = {
      origin: { x: 0, y: 0 }, // Point on axis
      direction: { x: 0, y: 1 }, // Axis direction (typically vertical in sketch)
    };
    
    // Operation mode
    this.operation = 'new'; // 'new', 'add', 'subtract', 'intersect'
  }

  /**
   * Execute the revolve operation.
   * @param {Object} context - Execution context with previous results
   * @returns {Object} Result with 3D geometry
   */
  execute(context) {
    // Get the sketch feature result
    const sketchResult = context.results[this.sketchFeatureId];
    if (!sketchResult || sketchResult.error) {
      throw new Error('Sketch feature not found or has errors');
    }
    
    if (sketchResult.type !== 'sketch') {
      throw new Error('Referenced feature is not a sketch');
    }
    
    const { sketch, plane, profiles } = sketchResult;
    
    if (profiles.length === 0) {
      throw new Error('No closed profiles found in sketch');
    }
    
    // Generate 3D geometry by revolving profiles
    const geometry = this.generateGeometry(profiles, plane);
    
    // Get the current solid (if any)
    let solid = this.getPreviousSolid(context);
    
    // Apply operation
    solid = this.applyOperation(solid, geometry);
    
    return {
      type: 'solid',
      geometry,
      solid,
      volume: this.calculateVolume(geometry),
      boundingBox: this.calculateBoundingBox(geometry),
    };
  }

  /**
   * Generate 3D geometry from sketch profiles by revolution.
   * @param {Array} profiles - Sketch profiles to revolve
   * @param {Object} plane - Sketch plane definition
   * @returns {Object} 3D geometry data
   */
  generateGeometry(profiles, plane) {
    const geometry = {
      vertices: [],
      faces: [],
      edges: [],
    };
    
    // For each profile, create revolution surface
    for (const profile of profiles) {
      const profileVertices = [];
      
      // Generate vertices for each angular segment
      for (let seg = 0; seg <= this.segments; seg++) {
        const theta = (seg / this.segments) * this.angle;
        const ringVertices = [];
        
        for (const point of profile.points) {
          // Calculate distance from revolution axis
          const axisPoint = this.projectPointOnAxis(point);
          const radius = Math.hypot(point.x - axisPoint.x, point.y - axisPoint.y);
          const height = this.getAxisCoordinate(point);
          
          // Revolve point around axis
          const vertex3D = this.revolvePoint(radius, height, theta, plane);
          ringVertices.push(vertex3D);
          geometry.vertices.push(vertex3D);
        }
        
        profileVertices.push(ringVertices);
      }
      
      // Create faces between consecutive rings
      for (let seg = 0; seg < this.segments; seg++) {
        const currentRing = profileVertices[seg];
        const nextRing = profileVertices[seg + 1];
        
        for (let i = 0; i < currentRing.length; i++) {
          const nextI = (i + 1) % currentRing.length;
          
          // Create quad face (or two triangles)
          const face = {
            vertices: [
              currentRing[i],
              nextRing[i],
              nextRing[nextI],
              currentRing[nextI],
            ],
          };
          
          // Calculate face normal
          face.normal = this.calculateFaceNormal(face.vertices);
          geometry.faces.push(face);
        }
      }
      
      // If not a full revolution, add end caps
      if (Math.abs(this.angle - Math.PI * 2) > 0.01) {
        // Start cap
        geometry.faces.push({
          vertices: profileVertices[0],
          normal: this.calculateFaceNormal(profileVertices[0]),
        });
        
        // End cap
        geometry.faces.push({
          vertices: profileVertices[this.segments].reverse(),
          normal: this.calculateFaceNormal(profileVertices[this.segments]),
        });
      }
    }
    
    return geometry;
  }

  /**
   * Project a point onto the revolution axis.
   * @param {Object} point - 2D point in sketch space
   * @returns {Object} Projected point on axis
   */
  projectPointOnAxis(point) {
    // Vector from axis origin to point
    const dx = point.x - this.axis.origin.x;
    const dy = point.y - this.axis.origin.y;
    
    // Project onto axis direction
    const axisLen = Math.hypot(this.axis.direction.x, this.axis.direction.y);
    const dot = (dx * this.axis.direction.x + dy * this.axis.direction.y) / (axisLen * axisLen);
    
    return {
      x: this.axis.origin.x + dot * this.axis.direction.x,
      y: this.axis.origin.y + dot * this.axis.direction.y,
    };
  }

  /**
   * Get the coordinate along the revolution axis.
   * @param {Object} point - 2D point in sketch space
   * @returns {number} Coordinate along axis
   */
  getAxisCoordinate(point) {
    const projected = this.projectPointOnAxis(point);
    const dx = projected.x - this.axis.origin.x;
    const dy = projected.y - this.axis.origin.y;
    return Math.hypot(dx, dy) * Math.sign(dx * this.axis.direction.x + dy * this.axis.direction.y);
  }

  /**
   * Revolve a point at given radius and height by angle theta.
   * @param {number} radius - Distance from axis
   * @param {number} height - Position along axis
   * @param {number} theta - Revolution angle
   * @param {Object} plane - Sketch plane definition
   * @returns {Object} 3D point
   */
  revolvePoint(radius, height, theta, plane) {
    // In sketch space, create the revolved point
    // Assuming revolution around Y-axis in sketch space
    const x = radius * Math.cos(theta);
    const z = radius * Math.sin(theta);
    const y = height;
    
    // Transform to world space using plane transformation
    return {
      x: plane.origin.x + x * plane.xAxis.x + y * plane.yAxis.x + z * plane.normal.x,
      y: plane.origin.y + x * plane.xAxis.y + y * plane.yAxis.y + z * plane.normal.y,
      z: plane.origin.z + x * plane.xAxis.z + y * plane.yAxis.z + z * plane.normal.z,
    };
  }

  /**
   * Calculate face normal from vertices.
   * @param {Array} vertices - Face vertices (at least 3)
   * @returns {Object} Normal vector
   */
  calculateFaceNormal(vertices) {
    if (vertices.length < 3) {
      return { x: 0, y: 0, z: 1 };
    }
    
    const v1 = {
      x: vertices[1].x - vertices[0].x,
      y: vertices[1].y - vertices[0].y,
      z: vertices[1].z - vertices[0].z,
    };
    
    const v2 = {
      x: vertices[2].x - vertices[0].x,
      y: vertices[2].y - vertices[0].y,
      z: vertices[2].z - vertices[0].z,
    };
    
    // Cross product
    const normal = {
      x: v1.y * v2.z - v1.z * v2.y,
      y: v1.z * v2.x - v1.x * v2.z,
      z: v1.x * v2.y - v1.y * v2.x,
    };
    
    // Normalize
    const length = Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
    if (length > 0) {
      normal.x /= length;
      normal.y /= length;
      normal.z /= length;
    }
    
    return normal;
  }

  /**
   * Get the previous solid from the context (for boolean operations).
   * @param {Object} context - Execution context
   * @returns {Object|null} Previous solid or null
   */
  getPreviousSolid(context) {
    if (this.operation === 'new') return null;
    
    // Find the most recent solid result before this feature
    const thisIndex = context.tree.getFeatureIndex(this.id);
    for (let i = thisIndex - 1; i >= 0; i--) {
      const feature = context.tree.features[i];
      const result = context.results[feature.id];
      if (result && result.type === 'solid' && !result.error) {
        return result.solid;
      }
    }
    
    return null;
  }

  /**
   * Apply boolean operation between existing solid and new geometry.
   * @param {Object|null} solid - Existing solid (or null)
   * @param {Object} geometry - New geometry to add
   * @returns {Object} Resulting solid
   */
  applyOperation(solid, geometry) {
    // For now, just return the geometry
    // In a full implementation, this would use a CSG library
    if (this.operation === 'new' || !solid) {
      return { geometry };
    }
    
    // Placeholder for boolean operations
    console.warn(`Boolean operation '${this.operation}' not yet implemented`);
    return { geometry };
  }

  /**
   * Calculate volume of the revolved geometry (approximate).
   * TODO: Implement accurate volume calculation using Pappus's centroid theorem
   * @param {Object} geometry - Geometry data
   * @returns {number} Volume
   */
  calculateVolume(geometry) {
    // Simplified calculation - proper implementation would use Pappus's theorem:
    // V = 2π * A * d, where A is profile area and d is distance from axis
    return 100; // Placeholder
  }

  /**
   * Calculate bounding box of the geometry.
   * @param {Object} geometry - Geometry data
   * @returns {Object} Bounding box with min and max points
   */
  calculateBoundingBox(geometry) {
    if (geometry.vertices.length === 0) {
      return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    }
    
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    
    for (const v of geometry.vertices) {
      minX = Math.min(minX, v.x);
      minY = Math.min(minY, v.y);
      minZ = Math.min(minZ, v.z);
      maxX = Math.max(maxX, v.x);
      maxY = Math.max(maxY, v.y);
      maxZ = Math.max(maxZ, v.z);
    }
    
    return {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    };
  }

  /**
   * Set the sketch feature to revolve.
   * @param {string} sketchFeatureId - ID of the sketch feature
   */
  setSketchFeature(sketchFeatureId) {
    // Remove old dependency
    if (this.sketchFeatureId) {
      this.removeDependency(this.sketchFeatureId);
    }
    
    // Add new dependency
    this.sketchFeatureId = sketchFeatureId;
    if (sketchFeatureId) {
      this.addDependency(sketchFeatureId);
    }
    
    this.modified = new Date();
  }

  /**
   * Set the revolution angle.
   * @param {number} angle - Angle in radians
   */
  setAngle(angle) {
    this.angle = angle;
    this.modified = new Date();
  }

  /**
   * Set the revolution axis.
   * @param {Object} origin - Point on axis
   * @param {Object} direction - Axis direction vector
   */
  setAxis(origin, direction) {
    this.axis.origin = { ...origin };
    this.axis.direction = { ...direction };
    this.modified = new Date();
  }

  /**
   * Serialize this revolve feature.
   */
  serialize() {
    return {
      ...super.serialize(),
      sketchFeatureId: this.sketchFeatureId,
      angle: this.angle,
      segments: this.segments,
      axis: this.axis,
      operation: this.operation,
    };
  }

  /**
   * Deserialize a revolve feature from JSON.
   */
  static deserialize(data) {
    const feature = new RevolveFeature();
    if (!data) return feature;
    
    // Deserialize base feature properties
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'revolve';
    
    // Deserialize revolve-specific properties
    feature.sketchFeatureId = data.sketchFeatureId || null;
    feature.angle = data.angle || Math.PI * 2;
    feature.segments = data.segments || 32;
    feature.axis = data.axis || { origin: { x: 0, y: 0 }, direction: { x: 0, y: 1 } };
    feature.operation = data.operation || 'new';
    
    return feature;
  }
}

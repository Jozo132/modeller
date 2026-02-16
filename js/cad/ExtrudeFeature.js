// js/cad/ExtrudeFeature.js — Extrude operation feature
// Extrudes a 2D sketch profile to create a 3D solid

import { Feature } from './Feature.js';
import { booleanOp, calculateMeshVolume, calculateBoundingBox } from './CSG.js';

/**
 * ExtrudeFeature extrudes a 2D sketch profile along its normal to create 3D geometry.
 */
export class ExtrudeFeature extends Feature {
  constructor(name = 'Extrude', sketchFeatureId = null, distance = 10) {
    super(name);
    this.type = 'extrude';
    
    // Reference to the sketch feature to extrude
    this.sketchFeatureId = sketchFeatureId;
    if (sketchFeatureId) {
      this.addDependency(sketchFeatureId);
    }
    
    // Extrusion parameters
    this.distance = distance;
    this.direction = 1; // 1 = normal direction, -1 = reverse
    this.symmetric = false; // If true, extrude in both directions
    
    // Operation mode
    this.operation = 'new'; // 'new', 'add', 'subtract', 'intersect'
  }

  /**
   * Execute the extrude operation.
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
    
    // Generate 3D geometry by extruding profiles
    const geometry = this.generateGeometry(profiles, plane);
    
    // Get the current solid (if any)
    let solid = this.getPreviousSolid(context);
    
    // Apply operation
    solid = this.applyOperation(solid, geometry);

    // Use the result geometry (may have been modified by boolean operation)
    const finalGeometry = solid.geometry || geometry;

    return {
      type: 'solid',
      geometry: finalGeometry,
      solid,
      volume: this.calculateVolume(finalGeometry),
      boundingBox: this.calculateBoundingBox(finalGeometry),
    };
  }

  /**
   * Generate 3D geometry from sketch profiles.
   * @param {Array} profiles - Sketch profiles to extrude
   * @param {Object} plane - Sketch plane definition
   * @returns {Object} 3D geometry data
   */
  generateGeometry(profiles, plane) {
    const geometry = {
      vertices: [],
      faces: [],
      edges: [],
    };
    
    // Calculate extrusion vector
    const extrusionVector = {
      x: plane.normal.x * this.distance * this.direction,
      y: plane.normal.y * this.distance * this.direction,
      z: plane.normal.z * this.distance * this.direction,
    };
    
    // For each profile, create top and bottom faces and side faces
    for (const profile of profiles) {
      // Ensure profile winding is CCW (positive signed area) so that
      // extrusion normals point outward.
      let pts = profile.points;
      let signedArea = 0;
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        signedArea += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
      }
      if (signedArea < 0) {
        pts = [...pts].reverse();
      }

      const bottomVertices = [];
      const topVertices = [];
      
      // Create vertices
      for (const point of pts) {
        // Transform 2D sketch point to 3D world coordinates
        const bottom3D = this.sketchToWorld(point, plane);
        bottomVertices.push(bottom3D);
        geometry.vertices.push(bottom3D);
        
        // Create top vertex
        const top3D = {
          x: bottom3D.x + extrusionVector.x,
          y: bottom3D.y + extrusionVector.y,
          z: bottom3D.z + extrusionVector.z,
        };
        topVertices.push(top3D);
        geometry.vertices.push(top3D);
      }
      
      // Create bottom face (reverse winding for outward-facing normal)
      geometry.faces.push({
        vertices: [...bottomVertices].reverse(),
        normal: { x: -plane.normal.x, y: -plane.normal.y, z: -plane.normal.z },
      });
      
      // Create top face
      geometry.faces.push({
        vertices: [...topVertices],
        normal: { x: plane.normal.x, y: plane.normal.y, z: plane.normal.z },
      });
      
      // Create side faces
      for (let i = 0; i < pts.length; i++) {
        const nextI = (i + 1) % pts.length;
        const face = {
          vertices: [
            bottomVertices[i],
            bottomVertices[nextI],
            topVertices[nextI],
            topVertices[i],
          ],
        };
        // Calculate face normal
        face.normal = this.calculateFaceNormal(face.vertices);
        geometry.faces.push(face);
      }
    }
    
    return geometry;
  }

  /**
   * Transform a 2D sketch point to 3D world coordinates.
   * @param {Object} point - 2D point in sketch space
   * @param {Object} plane - Sketch plane definition
   * @returns {Object} 3D point in world space
   */
  sketchToWorld(point, plane) {
    return {
      x: plane.origin.x + point.x * plane.xAxis.x + point.y * plane.yAxis.x,
      y: plane.origin.y + point.x * plane.xAxis.y + point.y * plane.yAxis.y,
      z: plane.origin.z + point.x * plane.xAxis.z + point.y * plane.yAxis.z,
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
    if (this.operation === 'new' || !solid) {
      return { geometry };
    }

    // Perform boolean operation using CSG
    const prevGeom = solid.geometry;
    if (!prevGeom || !prevGeom.faces || prevGeom.faces.length === 0) {
      return { geometry };
    }

    try {
      const resultGeom = booleanOp(prevGeom, geometry, this.operation);
      return { geometry: resultGeom };
    } catch (err) {
      console.warn(`Boolean operation '${this.operation}' failed:`, err.message);
      return { geometry };
    }
  }

  /**
   * Calculate volume of the extruded geometry (approximate).
   * TODO: Implement accurate volume calculation using profile area and extrusion distance
   * @param {Object} geometry - Geometry data
   * @returns {number} Volume
   */
  calculateVolume(geometry) {
    return calculateMeshVolume(geometry);
  }

  /**
   * Calculate bounding box of the geometry.
   * @param {Object} geometry - Geometry data
   * @returns {Object} Bounding box with min and max points
   */
  calculateBoundingBox(geometry) {
    return calculateBoundingBox(geometry);
  }

  /**
   * Set the sketch feature to extrude.
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
   * Set the extrusion distance.
   * @param {number} distance - Extrusion distance
   */
  setDistance(distance) {
    this.distance = distance;
    this.modified = new Date();
  }

  /**
   * Serialize this extrude feature.
   */
  serialize() {
    return {
      ...super.serialize(),
      sketchFeatureId: this.sketchFeatureId,
      distance: this.distance,
      direction: this.direction,
      symmetric: this.symmetric,
      operation: this.operation,
    };
  }

  /**
   * Deserialize an extrude feature from JSON.
   */
  static deserialize(data) {
    const feature = new ExtrudeFeature();
    if (!data) return feature;
    
    // Deserialize base feature properties
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'extrude';
    
    // Deserialize extrude-specific properties
    feature.sketchFeatureId = data.sketchFeatureId || null;
    feature.distance = data.distance || 10;
    feature.direction = data.direction || 1;
    feature.symmetric = data.symmetric || false;
    feature.operation = data.operation || 'new';
    
    return feature;
  }
}

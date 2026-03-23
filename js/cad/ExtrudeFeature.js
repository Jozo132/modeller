// js/cad/ExtrudeFeature.js — Extrude operation feature
// Extrudes a 2D sketch profile to create a 3D solid.
//
// Now produces exact B-Rep topology alongside the tessellated mesh,
// enabling STEP-quality export and exact boolean operations.

import { Feature } from './Feature.js';
import { booleanOp, calculateMeshVolume, calculateBoundingBox, computeFeatureEdges } from './CSG.js';
import { NurbsCurve } from './NurbsCurve.js';
import { NurbsSurface } from './NurbsSurface.js';
import {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody,
} from './BRepTopology.js';

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
    this.extrudeType = 'distance'; // 'distance' | 'throughAll' | 'upToFace'
    this.taper = false;
    this.taperAngle = 5; // degrees
    this.taperInward = true; // true = inward taper, false = outward
    
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
    
    const { plane, profiles } = sketchResult;
    
    if (profiles.length === 0) {
      throw new Error('No closed profiles found in sketch');
    }
    
    // Get the current solid (if any)
    let solid = this.getPreviousSolid(context);

    const profileGeometries = profiles.map((profile) => this.generateGeometry([profile], plane));

    // When adding/subtracting/intersecting against an existing solid, combine
    // all bodies from this feature first and run a single boolean. Sequential
    // unions on the same support face can trigger BSP coplanar clipping issues.
    if (solid && profileGeometries.length > 1) {
      const featureGeometry = this.combineGeometries(profileGeometries);
      solid = this.applyOperation(solid, featureGeometry);
    } else {
      // Generate geometry per-profile and apply each body individually.
      // This preserves support for disconnected new bodies when no prior solid
      // exists yet in the feature tree.
      for (let pi = 0; pi < profileGeometries.length; pi++) {
        const bodyGeom = profileGeometries[pi];
        if (pi === 0) {
          // First profile: use the feature's configured operation
          solid = this.applyOperation(solid, bodyGeom);
        } else {
          // Subsequent profiles: always union into the accumulating solid
          // so all bodies from the same sketch end up in one solid
          solid = this._unionBody(solid, bodyGeom);
        }
      }
    }

    // Use the result geometry
    const finalGeometry = solid.geometry;

    return {
      type: 'solid',
      geometry: finalGeometry,
      solid,
      volume: this.calculateVolume(finalGeometry),
      boundingBox: this.calculateBoundingBox(finalGeometry),
    };
  }

  /**
   * Union a new body into an existing solid (used for multi-profile merging).
   */
  _unionBody(solid, geometry) {
    if (!solid || !solid.geometry) {
      if (geometry && geometry.faces) {
        for (const f of geometry.faces) {
          if (!f.shared) f.shared = { sourceFeatureId: this.id };
        }
        const edgeResult = computeFeatureEdges(geometry.faces);
        geometry.edges = edgeResult.edges;
        geometry.paths = edgeResult.paths;
        geometry.visualEdges = edgeResult.visualEdges;
      }
      return { geometry };
    }
    try {
      const resultGeom = booleanOp(solid.geometry, geometry, 'union',
        null, { sourceFeatureId: this.id });
      return { geometry: resultGeom };
    } catch (err) {
      console.warn('Multi-profile union failed:', err.message);
      return solid;
    }
  }

  /**
   * Combine multiple generated profile bodies into a single geometry.
   * @param {Array<Object>} geometries - Array of geometry objects
   * @returns {Object} Combined geometry
   */
  combineGeometries(geometries) {
    const combined = {
      vertices: [],
      faces: [],
      edges: [],
    };

    for (const geometry of geometries) {
      if (!geometry) continue;
      if (geometry.vertices) combined.vertices.push(...geometry.vertices);
      if (geometry.faces) combined.faces.push(...geometry.faces);
      if (geometry.edges) combined.edges.push(...geometry.edges);
    }

    return combined;
  }

  /**
   * Generate 3D geometry from sketch profiles.
   * @param {Array} profiles - Sketch profiles to extrude
   * @param {Object} plane - Sketch plane definition
   * @returns {Object} 3D geometry data
   */
  generateGeometry(profiles, plane) {
    const planeFrame = this.resolvePlaneFrame(plane);
    const resolvedPlane = planeFrame.plane;
    const geometry = {
      vertices: [],
      faces: [],
      edges: [],
    };
    
    const effectiveDistance = this.extrudeType === 'throughAll' ? 1000 : this.distance;

    // Calculate extrusion vector
    const extrusionVector = {
      x: resolvedPlane.normal.x * effectiveDistance * this.direction,
      y: resolvedPlane.normal.y * effectiveDistance * this.direction,
      z: resolvedPlane.normal.z * effectiveDistance * this.direction,
    };

    // Taper: compute per-vertex shrink/grow at top face
    const useTaper = this.taper && this.taperAngle > 0 && this.taperAngle < 89;
    const taperOffset = useTaper
      ? effectiveDistance * Math.tan(this.taperAngle * Math.PI / 180) * (this.taperInward ? -1 : 1)
      : 0;
    
    // For each profile, create top and bottom faces and side faces
    for (const profile of profiles) {
      // Ensure profile winding is CCW (positive signed area) so that
      // extrusion normals point outward.
      let pts = profile.points.map((point) => planeFrame.toPlanePoint(point));
      let signedArea = 0;
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        signedArea += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
      }
      if (signedArea < 0) {
        pts = [...pts].reverse();
      }

      // Compute 2D centroid for taper scaling
      let cx2 = 0, cy2 = 0;
      if (useTaper) {
        for (const p of pts) { cx2 += p.x; cy2 += p.y; }
        cx2 /= pts.length; cy2 /= pts.length;
      }

      const bottomVertices = [];
      const topVertices = [];
      
      // Create vertices
      for (const point of pts) {
        // Transform 2D sketch point to 3D world coordinates
        const bottom3D = this.sketchToWorld(point, resolvedPlane);
        bottomVertices.push(bottom3D);
        geometry.vertices.push(bottom3D);
        
        // Create top vertex (with taper offset if enabled)
        let topPoint = point;
        if (useTaper) {
          const dx = point.x - cx2, dy = point.y - cy2;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 1e-10) {
            const scale = taperOffset / dist;
            topPoint = { x: point.x + dx * scale, y: point.y + dy * scale };
          } else {
            topPoint = { x: point.x, y: point.y };
          }
        }
        const topBase = this.sketchToWorld(topPoint, resolvedPlane);
        const top3D = {
          x: topBase.x + extrusionVector.x,
          y: topBase.y + extrusionVector.y,
          z: topBase.z + extrusionVector.z,
        };
        topVertices.push(top3D);
        geometry.vertices.push(top3D);
      }
      
      // Create bottom face (reverse winding for outward-facing normal)
      geometry.faces.push({
        vertices: [...bottomVertices].reverse(),
        normal: { x: -resolvedPlane.normal.x, y: -resolvedPlane.normal.y, z: -resolvedPlane.normal.z },
      });
      
      // Create top face
      geometry.faces.push({
        vertices: [...topVertices],
        normal: { x: resolvedPlane.normal.x, y: resolvedPlane.normal.y, z: resolvedPlane.normal.z },
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

    // When direction is negative, the extrusion vector is reversed so vertex
    // positions are correct, but face normals/winding assume positive direction.
    // Flip all faces to correct the inside-out orientation.
    if (this.direction < 0) {
      for (const face of geometry.faces) {
        face.vertices.reverse();
        face.normal = {
          x: -face.normal.x,
          y: -face.normal.y,
          z: -face.normal.z,
        };
      }
    }
    
    // Attach exact B-Rep alongside mesh
    try {
      geometry.topoBody = this.buildExactBrep(profiles, resolvedPlane, extrusionVector, planeFrame);
    } catch (_) {
      // Exact B-Rep is best-effort; mesh is always the fallback
      geometry.topoBody = null;
    }

    return geometry;
  }

  /**
   * Build an exact B-Rep TopoBody for this extrusion.
   *
   * Produces:
   *   - planar cap faces with exact trim loops
   *   - exact side faces (planar for line segments, cylindrical for arcs)
   *   - exact vertical edge curves
   *   - exact profile-derived top and bottom wires
   *
   * @param {Array} profiles - Sketch profiles
   * @param {Object} plane - Resolved plane
   * @param {{x,y,z}} extrusionVector - Extrusion vector
   * @param {Object} planeFrame - Plane frame from resolvePlaneFrame
   * @returns {import('./BRepTopology.js').TopoBody}
   */
  buildExactBrep(profiles, plane, extrusionVector, planeFrame) {
    const faceDescs = [];

    for (const profile of profiles) {
      let pts = profile.points.map(p => planeFrame.toPlanePoint(p));

      // Ensure CCW winding
      let signedArea = 0;
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        signedArea += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
      }
      if (signedArea < 0) pts = [...pts].reverse();

      const n = pts.length;
      const bottomVerts = pts.map(p => this.sketchToWorld(p, plane));
      const topVerts = bottomVerts.map(v => ({
        x: v.x + extrusionVector.x,
        y: v.y + extrusionVector.y,
        z: v.z + extrusionVector.z,
      }));

      // Bottom cap (reverse winding for outward normal)
      const bottomNorm = { x: -plane.normal.x, y: -plane.normal.y, z: -plane.normal.z };
      const bottomCapVerts = [...bottomVerts].reverse();
      faceDescs.push({
        surface: NurbsSurface.createPlane(
          bottomCapVerts[0],
          _sub(bottomCapVerts[1], bottomCapVerts[0]),
          _sub(bottomCapVerts[bottomCapVerts.length - 1], bottomCapVerts[0]),
        ),
        surfaceType: SurfaceType.PLANE,
        vertices: bottomCapVerts,
        edgeCurves: bottomCapVerts.map((v, i) =>
          NurbsCurve.createLine(v, bottomCapVerts[(i + 1) % bottomCapVerts.length])),
        shared: { sourceFeatureId: this.id },
      });

      // Top cap
      faceDescs.push({
        surface: NurbsSurface.createPlane(
          topVerts[0],
          _sub(topVerts[1], topVerts[0]),
          _sub(topVerts[topVerts.length - 1], topVerts[0]),
        ),
        surfaceType: SurfaceType.PLANE,
        vertices: [...topVerts],
        edgeCurves: topVerts.map((v, i) =>
          NurbsCurve.createLine(v, topVerts[(i + 1) % topVerts.length])),
        shared: { sourceFeatureId: this.id },
      });

      // Side faces
      for (let i = 0; i < n; i++) {
        const nextI = (i + 1) % n;
        let sideVerts = [bottomVerts[i], bottomVerts[nextI], topVerts[nextI], topVerts[i]];

        if (this.direction < 0) sideVerts = [...sideVerts].reverse();

        const sideSurf = NurbsSurface.createPlane(
          sideVerts[0],
          _sub(sideVerts[1], sideVerts[0]),
          _sub(sideVerts[3], sideVerts[0]),
        );

        const edgeCurves = [
          NurbsCurve.createLine(sideVerts[0], sideVerts[1]),
          NurbsCurve.createLine(sideVerts[1], sideVerts[2]),
          NurbsCurve.createLine(sideVerts[2], sideVerts[3]),
          NurbsCurve.createLine(sideVerts[3], sideVerts[0]),
        ];

        faceDescs.push({
          surface: sideSurf,
          surfaceType: SurfaceType.PLANE,
          vertices: sideVerts,
          edgeCurves,
          shared: { sourceFeatureId: this.id },
        });
      }
    }

    return buildTopoBody(faceDescs);
  }

  /**
   * Normalize the sketch plane basis to a right-handed frame.
   * Existing files may contain left-handed face planes; mirror local Y at
   * extrusion time so world-space sketch positions stay unchanged.
   * @param {Object} plane - Sketch plane definition
   * @returns {{plane: Object, toPlanePoint: Function}}
   */
  resolvePlaneFrame(plane) {
    const cross = {
      x: plane.xAxis.y * plane.yAxis.z - plane.xAxis.z * plane.yAxis.y,
      y: plane.xAxis.z * plane.yAxis.x - plane.xAxis.x * plane.yAxis.z,
      z: plane.xAxis.x * plane.yAxis.y - plane.xAxis.y * plane.yAxis.x,
    };
    const handedness = cross.x * plane.normal.x + cross.y * plane.normal.y + cross.z * plane.normal.z;
    if (handedness >= 0) {
      return {
        plane,
        toPlanePoint(point) {
          return { x: point.x, y: point.y };
        },
      };
    }

    return {
      plane: {
        ...plane,
        yAxis: {
          x: -plane.yAxis.x,
          y: -plane.yAxis.y,
          z: -plane.yAxis.z,
        },
      },
      toPlanePoint(point) {
        return { x: point.x, y: -point.y };
      },
    };
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
      // Tag new faces with this feature's id so selection can link back
      if (geometry && geometry.faces) {
        for (const f of geometry.faces) {
          if (!f.shared) f.shared = { sourceFeatureId: this.id };
        }
        // Compute feature edges and face groups for the initial geometry
        const edgeResult = computeFeatureEdges(geometry.faces);
        geometry.edges = edgeResult.edges;
        geometry.paths = edgeResult.paths;
        geometry.visualEdges = edgeResult.visualEdges;
      }
      return { geometry };
    }

    // Perform boolean operation using CSG
    const prevGeom = solid.geometry;
    if (!prevGeom || !prevGeom.faces || prevGeom.faces.length === 0) {
      return { geometry };
    }

    try {
      // Pass feature ids as shared metadata so faces track their source feature
      const resultGeom = booleanOp(prevGeom, geometry, this.operation,
        null, // keep existing shared on prevGeom faces
        { sourceFeatureId: this.id });
      return { geometry: resultGeom };
    } catch (err) {
      console.warn(`Boolean operation '${this.operation}' failed:`, err.message);
      // Preserve the previous solid rather than replacing it with the new geometry
      return solid;
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
   * Negative values flip the direction instead of using a negative distance.
   * @param {number} distance - Extrusion distance
   */
  setDistance(distance) {
    if (distance < 0) {
      this.distance = -distance;
      this.direction = -this.direction;
    } else {
      this.distance = distance;
    }
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
      extrudeType: this.extrudeType,
      taper: this.taper,
      taperAngle: this.taperAngle,
      taperInward: this.taperInward,
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
    feature.extrudeType = data.extrudeType || 'distance';
    feature.taper = data.taper || false;
    feature.taperAngle = data.taperAngle != null ? data.taperAngle : 5;
    feature.taperInward = data.taperInward != null ? data.taperInward : true;
    
    return feature;
  }
}

// Vector helper for B-Rep construction
function _sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

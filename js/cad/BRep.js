// js/cad/BRep.js — Boundary Representation (B-Rep) data structure
//
// Provides a professional-grade B-Rep kernel that associates NURBS curves and
// surfaces with the mesh topology. Each face can optionally carry a NURBS surface
// definition, and each edge can carry a NURBS curve definition, enabling
// mathematically exact geometry alongside the tessellated mesh used for rendering.
//
// This is the standard representation used by professional CAD systems (STEP, IGES,
// Parasolid, ACIS) where the exact geometry is stored separately from the
// tessellation used for display.

import { NurbsCurve } from './NurbsCurve.js';
import { NurbsSurface } from './NurbsSurface.js';

/**
 * BRepVertex — A vertex in the B-Rep topology.
 * Associates a 3D position with optional tolerance information.
 */
export class BRepVertex {
  /**
   * @param {{x:number, y:number, z:number}} point - 3D position
   * @param {number} [tolerance=0] - Vertex tolerance for gap healing
   */
  constructor(point, tolerance = 0) {
    this.point = { x: point.x, y: point.y, z: point.z };
    this.tolerance = tolerance;
  }

  clone() {
    return new BRepVertex({ ...this.point }, this.tolerance);
  }

  serialize() {
    return { point: { ...this.point }, tolerance: this.tolerance };
  }

  static deserialize(data) {
    return new BRepVertex(data.point, data.tolerance || 0);
  }
}

/**
 * BRepEdge — An edge in the B-Rep topology.
 * Associates a NURBS curve with start/end vertices.
 *
 * The NURBS curve provides the mathematically exact edge geometry.
 * The mesh edges (polyline) are obtained by tessellating the curve.
 */
export class BRepEdge {
  /**
   * @param {BRepVertex} startVertex
   * @param {BRepVertex} endVertex
   * @param {NurbsCurve} [curve] - Optional exact curve geometry
   */
  constructor(startVertex, endVertex, curve = null) {
    this.startVertex = startVertex;
    this.endVertex = endVertex;
    this.curve = curve;
  }

  /**
   * Tessellate this edge into a polyline.
   * If a NURBS curve is defined, evaluates it. Otherwise returns a straight line.
   * @param {number} [segments=64]
   * @returns {Array<{x,y,z}>}
   */
  tessellate(segments = 64) {
    if (this.curve) {
      return this.curve.tessellate(segments);
    }
    // Straight line fallback
    const s = this.startVertex.point;
    const e = this.endVertex.point;
    const points = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      points.push({
        x: s.x + t * (e.x - s.x),
        y: s.y + t * (e.y - s.y),
        z: s.z + t * (e.z - s.z),
      });
    }
    return points;
  }

  clone() {
    return new BRepEdge(
      this.startVertex.clone(),
      this.endVertex.clone(),
      this.curve ? this.curve.clone() : null
    );
  }

  serialize() {
    return {
      startVertex: this.startVertex.serialize(),
      endVertex: this.endVertex.serialize(),
      curve: this.curve ? this.curve.serialize() : null,
    };
  }

  static deserialize(data) {
    return new BRepEdge(
      BRepVertex.deserialize(data.startVertex),
      BRepVertex.deserialize(data.endVertex),
      data.curve ? NurbsCurve.deserialize(data.curve) : null
    );
  }
}

/**
 * BRepFace — A face in the B-Rep topology.
 * Associates a NURBS surface with a mesh tessellation and boundary edges.
 *
 * The NURBS surface provides the mathematically exact face geometry.
 * The mesh faces (triangles/quads) are obtained by tessellating the surface.
 */
export class BRepFace {
  /**
   * @param {NurbsSurface} [surface] - Optional exact surface geometry
   * @param {string} [surfaceType='unknown'] - Type hint: 'planar', 'cylindrical', 'conical', 'spherical', 'toroidal', 'fillet', 'chamfer', 'freeform'
   * @param {Object} [shared] - Shared metadata (sourceFeatureId, etc.)
   */
  constructor(surface = null, surfaceType = 'unknown', shared = null) {
    this.surface = surface;
    this.surfaceType = surfaceType;
    this.shared = shared;
    this.outerLoop = []; // Array of BRepEdge indices (or references)
    this.innerLoops = []; // Array of arrays of BRepEdge indices (holes)
  }

  /**
   * Tessellate this face into mesh quads/triangles.
   * If a NURBS surface is defined, evaluates it. Otherwise returns null
   * (the caller should use the existing mesh face data).
   *
   * @param {number} [segmentsU=8]
   * @param {number} [segmentsV=8]
   * @returns {{ vertices: Array<{x,y,z}>, faces: Array<{vertices, normal}> } | null}
   */
  tessellate(segmentsU = 8, segmentsV = 8) {
    if (!this.surface) return null;
    return this.surface.tessellate(segmentsU, segmentsV);
  }

  clone() {
    return new BRepFace(
      this.surface ? this.surface.clone() : null,
      this.surfaceType,
      this.shared ? { ...this.shared } : null
    );
  }

  serialize() {
    return {
      surface: this.surface ? this.surface.serialize() : null,
      surfaceType: this.surfaceType,
      shared: this.shared,
    };
  }

  static deserialize(data) {
    const face = new BRepFace(
      data.surface ? NurbsSurface.deserialize(data.surface) : null,
      data.surfaceType || 'unknown',
      data.shared || null
    );
    return face;
  }
}

/**
 * BRep — Complete Boundary Representation of a solid.
 *
 * Combines the exact NURBS geometry (curves/surfaces) with the tessellated
 * mesh representation in a single data structure. This is the standard
 * approach in professional CAD:
 *
 *   - NURBS data provides mathematical exactness (for export, measurement, etc.)
 *   - Mesh data provides renderable triangles/quads (for WebGL display)
 *
 * The BRep can be attached to a geometry object's `brep` property.
 */
export class BRep {
  constructor() {
    this.vertices = []; // BRepVertex[]
    this.edges = [];    // BRepEdge[]
    this.faces = [];    // BRepFace[]
  }

  /**
   * Add a vertex.
   * @param {BRepVertex} vertex
   * @returns {number} Index of the added vertex
   */
  addVertex(vertex) {
    this.vertices.push(vertex);
    return this.vertices.length - 1;
  }

  /**
   * Add an edge.
   * @param {BRepEdge} edge
   * @returns {number} Index of the added edge
   */
  addEdge(edge) {
    this.edges.push(edge);
    return this.edges.length - 1;
  }

  /**
   * Add a face.
   * @param {BRepFace} face
   * @returns {number} Index of the added face
   */
  addFace(face) {
    this.faces.push(face);
    return this.faces.length - 1;
  }

  /**
   * Check if this BRep has any NURBS surface definitions.
   * @returns {boolean}
   */
  hasExactGeometry() {
    return this.faces.some(f => f.surface !== null);
  }

  /**
   * Get all faces with NURBS surface definitions.
   * @returns {BRepFace[]}
   */
  getExactFaces() {
    return this.faces.filter(f => f.surface !== null);
  }

  /**
   * Tessellate all NURBS faces into mesh data.
   * Returns an array of tessellation results aligned with the face indices.
   *
   * @param {number} [segmentsU=8]
   * @param {number} [segmentsV=8]
   * @returns {Array<{vertices, faces}|null>}
   */
  tessellateAll(segmentsU = 8, segmentsV = 8) {
    return this.faces.map(f => f.tessellate(segmentsU, segmentsV));
  }

  clone() {
    const brep = new BRep();
    brep.vertices = this.vertices.map(v => v.clone());
    brep.edges = this.edges.map(e => e.clone());
    brep.faces = this.faces.map(f => f.clone());
    return brep;
  }

  serialize() {
    return {
      type: 'BRep',
      vertices: this.vertices.map(v => v.serialize()),
      edges: this.edges.map(e => e.serialize()),
      faces: this.faces.map(f => f.serialize()),
    };
  }

  static deserialize(data) {
    const brep = new BRep();
    if (data.vertices) {
      brep.vertices = data.vertices.map(v => BRepVertex.deserialize(v));
    }
    if (data.edges) {
      brep.edges = data.edges.map(e => BRepEdge.deserialize(e));
    }
    if (data.faces) {
      brep.faces = data.faces.map(f => BRepFace.deserialize(f));
    }
    return brep;
  }
}

/**
 * Convert a NURBS-annotated mesh geometry to a display-quality mesh.
 * Re-tessellates any face that has an attached BRep NURBS surface at the
 * requested resolution.
 *
 * This allows the rendering pipeline to work with display mesh data while
 * the exact NURBS definitions are preserved in the brep property.
 * The output mesh is for visualization only — feature operations must
 * use the exact B-Rep topology (see ARCHITECTURE.md, Rule 2).
 *
 * @param {Object} geometry - Geometry with .faces[], optional .brep
 * @param {number} [segments=8] - Tessellation segments for NURBS surfaces
 * @returns {Object} Geometry with display mesh faces (brep preserved as-is)
 */
export function tessellateNurbsFaces(geometry, segments = 8) {
  if (!geometry || !geometry.brep || !geometry.brep.faces) {
    return geometry;
  }

  const brep = geometry.brep;
  const meshFaces = [];

  for (let fi = 0; fi < geometry.faces.length; fi++) {
    const meshFace = geometry.faces[fi];

    // Check if this face has a corresponding BRep face with NURBS
    const brepFace = fi < brep.faces.length ? brep.faces[fi] : null;

    if (brepFace && brepFace.surface) {
      // Re-tessellate from NURBS surface
      const tess = brepFace.surface.tessellate(segments, segments);
      for (const tf of tess.faces) {
        meshFaces.push({
          vertices: tf.vertices,
          normal: tf.normal,
          shared: meshFace.shared || brepFace.shared,
          isFillet: brepFace.surfaceType === 'fillet',
          isCurved: brepFace.surfaceType !== 'planar' && brepFace.surfaceType !== 'chamfer',
        });
      }
    } else {
      // Keep original mesh face
      meshFaces.push(meshFace);
    }
  }

  return {
    ...geometry,
    faces: meshFaces,
  };
}

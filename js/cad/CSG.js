// js/cad/CSG.js — Constructive Solid Geometry (CSG) boolean operations
// Implements union, subtract, and intersect on polygon meshes using BSP trees.
// Based on the algorithm from "Constructive Solid Geometry Using BSP Tree"
// (Laidlaw, Trumbore, Hughes, 1986) with modifications for numerical robustness.
//
// Chamfer and fillet operations now produce NURBS surface definitions alongside
// tessellated mesh data, enabling mathematically exact B-Rep representation.
//
// === Compatibility façade ===
// When operands expose exact B-Rep topology (via .topoBody), this module
// dispatches to the exact boolean kernel in BooleanKernel.js. Otherwise
// it falls back to the legacy mesh BSP engine below.

import { NurbsSurface } from './NurbsSurface.js';
import { BRep, BRepVertex, BRepEdge, BRepFace } from './BRep.js';
import { NurbsCurve } from './NurbsCurve.js';
import { exactBooleanOp, hasExactTopology } from './BooleanKernel.js';
import { buildTopoBody, SurfaceType } from './BRepTopology.js';
import { tessellateBody } from './Tessellation.js';
import { constrainedTriangulate } from './Tessellator2/CDT.js';

const EPSILON = 1e-5;

// -----------------------------------------------------------------------
// Vector3 helper
// -----------------------------------------------------------------------

class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  neg() { return new Vec3(-this.x, -this.y, -this.z); }
  plus(b) { return new Vec3(this.x + b.x, this.y + b.y, this.z + b.z); }
  minus(b) { return new Vec3(this.x - b.x, this.y - b.y, this.z - b.z); }
  times(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }
  dot(b) { return this.x * b.x + this.y * b.y + this.z * b.z; }
  cross(b) {
    return new Vec3(
      this.y * b.z - this.z * b.y,
      this.z * b.x - this.x * b.z,
      this.x * b.y - this.y * b.x
    );
  }
  length() { return Math.sqrt(this.dot(this)); }
  unit() { const l = this.length(); return l > 0 ? this.times(1 / l) : this.clone(); }
  lerp(b, t) { return this.plus(b.minus(this).times(t)); }
  toObj() { return { x: this.x, y: this.y, z: this.z }; }
  static from(o) { return new Vec3(o.x, o.y, o.z); }
}

// -----------------------------------------------------------------------
// Vertex — position + normal
// -----------------------------------------------------------------------

class Vertex {
  constructor(pos, normal) {
    this.pos = pos instanceof Vec3 ? pos : Vec3.from(pos);
    this.normal = normal instanceof Vec3 ? normal : Vec3.from(normal);
  }
  clone() { return new Vertex(this.pos.clone(), this.normal.clone()); }
  flip() { this.normal = this.normal.neg(); }
  interpolate(other, t) {
    return new Vertex(
      this.pos.lerp(other.pos, t),
      this.normal.lerp(other.normal, t).unit()
    );
  }
}

// -----------------------------------------------------------------------
// Polygon — convex polygon with shared normal, optional metadata
// -----------------------------------------------------------------------

class Polygon {
  constructor(vertices, shared = null) {
    this.vertices = vertices;
    this.shared = shared;   // face metadata (type, source feature, etc.)
    this.plane = Plane.fromPoints(
      vertices[0].pos, vertices[1].pos, vertices[2].pos
    );
  }
  clone() {
    return new Polygon(
      this.vertices.map(v => v.clone()),
      this.shared
    );
  }
  flip() {
    this.vertices.reverse().forEach(v => v.flip());
    this.plane.flip();
  }
}

// -----------------------------------------------------------------------
// Plane — defined by normal and distance from origin (ax + by + cz - w = 0)
// -----------------------------------------------------------------------

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

class Plane {
  constructor(normal, w) {
    this.normal = normal;
    this.w = w;
  }
  clone() { return new Plane(this.normal.clone(), this.w); }
  flip() { this.normal = this.normal.neg(); this.w = -this.w; }

  static fromPoints(a, b, c) {
    const n = b.minus(a).cross(c.minus(a)).unit();
    return new Plane(n, n.dot(a));
  }

  /**
   * Split polygon by this plane. Resulting polygons are pushed into the
   * four output arrays: coplanarFront, coplanarBack, front, back.
   */
  splitPolygon(polygon, coplanarFront, coplanarBack, front, back) {
    let polygonType = 0;
    const types = [];

    for (const v of polygon.vertices) {
      const t = this.normal.dot(v.pos) - this.w;
      const type = (t < -EPSILON) ? BACK : (t > EPSILON) ? FRONT : COPLANAR;
      polygonType |= type;
      types.push(type);
    }

    switch (polygonType) {
      case COPLANAR:
        (this.normal.dot(polygon.plane.normal) > 0 ? coplanarFront : coplanarBack).push(polygon);
        break;
      case FRONT:
        front.push(polygon);
        break;
      case BACK:
        back.push(polygon);
        break;
      case SPANNING: {
        const f = [], b = [];
        for (let i = 0; i < polygon.vertices.length; i++) {
          const j = (i + 1) % polygon.vertices.length;
          const ti = types[i], tj = types[j];
          const vi = polygon.vertices[i], vj = polygon.vertices[j];

          if (ti !== BACK) f.push(vi);
          if (ti !== FRONT) b.push(ti !== BACK ? vi.clone() : vi);

          if ((ti | tj) === SPANNING) {
            const t = (this.w - this.normal.dot(vi.pos)) /
                      this.normal.dot(vj.pos.minus(vi.pos));
            const v = vi.interpolate(vj, t);
            f.push(v);
            b.push(v.clone());
          }
        }
        if (f.length >= 3) front.push(new Polygon(f, polygon.shared));
        if (b.length >= 3) back.push(new Polygon(b, polygon.shared));
        break;
      }
    }
  }
}

// -----------------------------------------------------------------------
// BSP Node
// -----------------------------------------------------------------------

class Node {
  constructor(polygons) {
    this.plane = null;
    this.front = null;
    this.back = null;
    this.polygons = [];
    if (polygons && polygons.length) this.build(polygons);
  }

  clone() {
    const node = new Node();
    node.plane = this.plane && this.plane.clone();
    node.front = this.front && this.front.clone();
    node.back = this.back && this.back.clone();
    node.polygons = this.polygons.map(p => p.clone());
    return node;
  }

  /** Convert solid space to empty space and vice versa. */
  invert() {
    for (const p of this.polygons) p.flip();
    if (this.plane) this.plane.flip();
    if (this.front) this.front.invert();
    if (this.back) this.back.invert();
    const tmp = this.front;
    this.front = this.back;
    this.back = tmp;
  }

  /** Recursively remove all polygons in `polygons` that are inside this BSP tree. */
  clipPolygons(polygons) {
    if (!this.plane) return polygons.slice();
    let front = [], back = [];
    for (const p of polygons) {
      this.plane.splitPolygon(p, front, back, front, back);
    }
    if (this.front) front = this.front.clipPolygons(front);
    if (this.back) back = this.back.clipPolygons(back);
    else back = [];
    return front.concat(back);
  }

  /** Remove all polygons in this BSP tree that are inside the other BSP tree. */
  clipTo(bsp) {
    this.polygons = bsp.clipPolygons(this.polygons);
    if (this.front) this.front.clipTo(bsp);
    if (this.back) this.back.clipTo(bsp);
  }

  /** Return a list of all polygons in this BSP tree. */
  allPolygons() {
    let polys = this.polygons.slice();
    if (this.front) polys = polys.concat(this.front.allPolygons());
    if (this.back) polys = polys.concat(this.back.allPolygons());
    return polys;
  }

  /** Build a BSP tree out of polygons. */
  build(polygons) {
    if (!polygons.length) return;
    if (!this.plane) this.plane = polygons[0].plane.clone();

    const front = [], back = [];
    for (const p of polygons) {
      this.plane.splitPolygon(p, this.polygons, this.polygons, front, back);
    }
    if (front.length) {
      if (!this.front) this.front = new Node();
      this.front.build(front);
    }
    if (back.length) {
      if (!this.back) this.back = new Node();
      this.back.build(back);
    }
  }
}

// -----------------------------------------------------------------------
// CSG solid — wraps an array of polygons
// -----------------------------------------------------------------------

class CSGSolid {
  constructor() { this.polygons = []; }

  clone() {
    const s = new CSGSolid();
    s.polygons = this.polygons.map(p => p.clone());
    return s;
  }

  /** Return a new CSG solid representing space in either this solid or `csg`. */
  union(csg) {
    const a = new Node(this.clone().polygons);
    const b = new Node(csg.clone().polygons);
    a.clipTo(b);
    b.clipTo(a);
    b.invert();
    b.clipTo(a);
    b.invert();
    a.build(b.allPolygons());
    const result = CSGSolid.fromPolygons(a.allPolygons());
    return result;
  }

  /** Return a new CSG solid representing space in this solid but not `csg`. */
  subtract(csg) {
    const a = new Node(this.clone().polygons);
    const b = new Node(csg.clone().polygons);
    a.invert();
    a.clipTo(b);
    b.clipTo(a);
    b.invert();
    b.clipTo(a);
    b.invert();
    a.build(b.allPolygons());
    a.invert();
    const result = CSGSolid.fromPolygons(a.allPolygons());
    return result;
  }

  /** Return a new CSG solid representing space in both this solid and `csg`. */
  intersect(csg) {
    const a = new Node(this.clone().polygons);
    const b = new Node(csg.clone().polygons);
    a.invert();
    b.clipTo(a);
    b.invert();
    a.clipTo(b);
    b.clipTo(a);
    a.build(b.allPolygons());
    a.invert();
    const result = CSGSolid.fromPolygons(a.allPolygons());
    return result;
  }

  static fromPolygons(polygons) {
    const s = new CSGSolid();
    s.polygons = polygons;
    return s;
  }

  /**
   * Build a CSGSolid from our internal geometry format:
   *   { vertices: [{x,y,z},...], faces: [{vertices:[{x,y,z},...], normal:{x,y,z}},...] }
   * All faces are pre-triangulated before BSP construction to avoid numerical
   * issues with large n-gons (e.g. 32-point circles) being split by the BSP tree.
   */
  static fromGeometry(geometry, shared = null) {
    const polygons = [];
    for (const face of (geometry.faces || [])) {
      if (face.vertices.length < 3) continue;
      const n = face.normal || { x: 0, y: 0, z: 1 };
      const faceShared = face.shared || shared || null;
      const nv = Vec3.from(n);

      // Pre-triangulate: fan from vertex 0 for convex polygons
      if (face.vertices.length === 3) {
        const verts = face.vertices.map(v => new Vertex(Vec3.from(v), nv.clone()));
        polygons.push(new Polygon(verts, faceShared));
      } else {
        const v0 = face.vertices[0];
        for (let i = 1; i < face.vertices.length - 1; i++) {
          const v1 = face.vertices[i];
          const v2 = face.vertices[i + 1];
          const verts = [
            new Vertex(Vec3.from(v0), nv.clone()),
            new Vertex(Vec3.from(v1), nv.clone()),
            new Vertex(Vec3.from(v2), nv.clone()),
          ];
          polygons.push(new Polygon(verts, faceShared));
        }
      }
    }
    return CSGSolid.fromPolygons(polygons);
  }

  /**
   * Convert back to our internal geometry format with face metadata.
   * Each polygon becomes a face with its vertices, normal, and shared metadata.
   * Faces also get a `faceType` classification.
   * Only feature edges (sharp edges between faces with different normals) are included.
   */
  toGeometry() {
    const vertices = [];
    const faces = [];

    for (const poly of this.polygons) {
      const faceVerts = _deduplicatePolygon(poly.vertices.map(v => v.pos.toObj()));
      if (faceVerts.length < 3) continue;
      const normal = _computePolygonNormal(faceVerts);
      if (!normal) continue;

      // Classify face type based on normal direction
      const faceType = classifyFaceType(normal, faceVerts);

      faces.push({
        vertices: faceVerts,
        normal,
        faceType,
        shared: poly.shared || null,
      });
    }

    // Fix T-junctions left by BSP splitting: insert missing vertices into
    // face edges so that adjacent faces share all boundary vertices.
    _fixTJunctions(faces);
    _healBoundaryLoops(faces);
    _weldVertices(faces);
    _recomputeFaceNormals(faces);
    _fixWindingConsistency(faces);

    for (const face of faces) {
      for (const v of face.vertices) {
        vertices.push(v);
      }
    }

    // Compute face groups and feature edges
    const { edges, paths, visualEdges } = computeFeatureEdges(faces);

    return { vertices, faces, edges, paths, visualEdges };
  }
}

// -----------------------------------------------------------------------
// Coplanar face grouping
// -----------------------------------------------------------------------

/**
 * Assign a faceGroup ID to coplanar adjacent faces so they can be selected
 * as a single logical face.  Unlike the old mergeCoplanarFaces(), this
 * preserves the original convex CSG polygons (so fan triangulation stays
 * correct) and only annotates each face with a shared group number.
 *
 * Non-planar faces (cylindrical, freeform) are grouped by smooth-edge
 * adjacency: adjacent faces whose normals differ by less than the feature
 * edge threshold (15°) are merged into a single curved group.
 * Each face also gets an `isCurved` boolean.
 *
 * @param {Array} faces - Array of face objects {vertices, normal, faceType, shared}
 *                        Modified in-place: each face gets `faceGroup` and `isCurved` properties.
 */
function assignCoplanarFaceGroups(faces) {
  // Build a plane key for grouping: quantized normal + plane distance
  function planeKey(normal, vertices) {
    const quantize = (value) => {
      return Math.abs(value) < 1e-10 ? 0 : Math.round(value * 1e4);
    };
    const n = Vec3.from(normal).unit();
    // Ensure consistent normal direction (flip so largest component is positive)
    let sign = 1;
    if (Math.abs(n.z) > Math.abs(n.x) && Math.abs(n.z) > Math.abs(n.y)) {
      sign = n.z < 0 ? -1 : 1;
    } else if (Math.abs(n.y) > Math.abs(n.x)) {
      sign = n.y < 0 ? -1 : 1;
    } else {
      sign = n.x < 0 ? -1 : 1;
    }
    const nx = quantize(n.x * sign);
    const ny = quantize(n.y * sign);
    const nz = quantize(n.z * sign);
    const d = quantize(Vec3.from(vertices[0]).dot(n) * sign);
    return `${nx},${ny},${nz}|${d}`;
  }

  const SMOOTH_COS = Math.cos(15 * Math.PI / 180); // same as feature edge threshold

  // Default: every face is its own group, not curved
  for (let fi = 0; fi < faces.length; fi++) {
    faces[fi].faceGroup = fi;
    faces[fi].isCurved = false;
  }

  // --- Planar face grouping (existing logic) ---
  const planeGroups = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (face.faceType && !face.faceType.startsWith('planar')) continue;
    if (face.vertices.length < 3) continue;

    const key = planeKey(face.normal, face.vertices);
    if (!planeGroups.has(key)) {
      planeGroups.set(key, []);
    }
    planeGroups.get(key).push(fi);
  }

  // Union-find helpers (shared for both planar and curved grouping)
  const parent = {};
  for (let fi = 0; fi < faces.length; fi++) parent[fi] = fi;
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function unite(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Fast path: pre-unite faces sharing the same STEP topoFaceId so that
  // the expensive O(n²) _coplanarFacesTouch analysis is skipped for them.
  const topoRep = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const tid = faces[fi].topoFaceId;
    if (tid !== undefined) {
      if (topoRep.has(tid)) unite(fi, topoRep.get(tid));
      else topoRep.set(tid, fi);
    }
  }

  for (const [, group] of planeGroups) {
    if (group.length <= 1) continue;

    const vertexFaces = new Map();
    for (const fi of group) {
      const verts = faces[fi].vertices;
      for (let i = 0; i < verts.length; i++) {
        const v = verts[i];
        const key = `${Math.round(v.x * 1e6)},${Math.round(v.y * 1e6)},${Math.round(v.z * 1e6)}`;
        if (!vertexFaces.has(key)) vertexFaces.set(key, []);
        vertexFaces.get(key).push(fi);
      }
    }

    for (const [, faceIds] of vertexFaces) {
      for (let i = 1; i < faceIds.length; i++) {
        unite(faceIds[0], faceIds[i]);
      }
    }

    // Post-boolean planar fragments often meet via split edges/T-junctions
    // without sharing all corner vertices. Merge same-plane faces when any
    // vertex lies on another face's edge or when collinear edges overlap.
    for (let gi = 0; gi < group.length - 1; gi++) {
      const fa = faces[group[gi]];
      for (let gj = gi + 1; gj < group.length; gj++) {
        if (find(group[gi]) === find(group[gj])) continue; // already merged
        const fb = faces[group[gj]];
        if (_coplanarFacesTouch(fa, fb)) unite(group[gi], group[gj]);
      }
    }
  }

  // --- Curved face grouping: merge non-planar faces connected by smooth edges ---
  function vKey(v) { return `${Math.round(v.x * 1e6)},${Math.round(v.y * 1e6)},${Math.round(v.z * 1e6)}`; }
  function eKey(a, b) {
    const ax = Math.round(a.x * 1e6), ay = Math.round(a.y * 1e6), az = Math.round(a.z * 1e6);
    const bx = Math.round(b.x * 1e6), by = Math.round(b.y * 1e6), bz = Math.round(b.z * 1e6);
    if (ax < bx || (ax === bx && (ay < by || (ay === by && az < bz)))) {
      return `${ax},${ay},${az}|${bx},${by},${bz}`;
    }
    return `${bx},${by},${bz}|${ax},${ay},${az}`;
  }

  // Build edge → face indices map
  const edgeFaces = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const key = eKey(verts[i], verts[(i + 1) % verts.length]);
      if (!edgeFaces.has(key)) edgeFaces.set(key, []);
      edgeFaces.get(key).push(fi);
    }
  }

  // For each shared edge, if adjacent face normals are smooth but NOT coplanar, unite them
  // This catches cone/cylinder quads that are individually planar but collectively curved
  for (const [, fis] of edgeFaces) {
    if (fis.length < 2) continue;
    for (let i = 0; i < fis.length - 1; i++) {
      for (let j = i + 1; j < fis.length; j++) {
        const fa = faces[fis[i]], fb = faces[fis[j]];
        const na = fa.normal, nb = fb.normal;
        const dot = na.x * nb.x + na.y * nb.y + na.z * nb.z;
        // Smooth but not coplanar: normals within 15° but not identical
        if (dot >= SMOOTH_COS && dot < 1 - 1e-6) {
          // Don't merge fillet strip faces with non-fillet faces
          if (!!fa.isFillet !== !!fb.isFillet) continue;
          // Don't merge corner faces with non-corner faces
          if (!!fa.isCorner !== !!fb.isCorner) continue;
          // Keep neighboring blends from different features independently selectable.
          const sourceA = fa.shared && fa.shared.sourceFeatureId ? fa.shared.sourceFeatureId : null;
          const sourceB = fb.shared && fb.shared.sourceFeatureId ? fb.shared.sourceFeatureId : null;
          if ((fa.isFillet || fa.isCorner || fb.isFillet || fb.isCorner) && sourceA !== sourceB) continue;
          // Don't merge faces from different STEP topology faces.
          // STEP import tags each mesh face with topoFaceId — these
          // represent distinct B-Rep surfaces that must remain
          // independently selectable (e.g. separate fillet cylinders).
          if (fa.topoFaceId !== undefined && fb.topoFaceId !== undefined && fa.topoFaceId !== fb.topoFaceId) continue;
          unite(fis[i], fis[j]);
        }
      }
    }
  }

  // Force-merge adjacent corner faces into a single group.
  // Spherical corner patches can span large angular ranges where adjacent
  // triangle normals exceed the smooth threshold, but they are a single
  // continuous surface that must stay in one group.
  // Merge by shared edges first, then by shared vertices (the base triangle
  // shares vertices but not edges with the spherical grid).
  for (const [, fis] of edgeFaces) {
    if (fis.length < 2) continue;
    for (let i = 0; i < fis.length - 1; i++) {
      for (let j = i + 1; j < fis.length; j++) {
        if (faces[fis[i]].isCorner && faces[fis[j]].isCorner) {
          unite(fis[i], fis[j]);
        }
      }
    }
  }
  // Vertex-based merge for corner faces (base triangle ↔ spherical grid)
  const cornerVertFaces = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    if (!faces[fi].isCorner) continue;
    for (const v of faces[fi].vertices) {
      const k = vKey(v);
      if (!cornerVertFaces.has(k)) cornerVertFaces.set(k, []);
      cornerVertFaces.get(k).push(fi);
    }
  }
  for (const [, fis] of cornerVertFaces) {
    for (let i = 1; i < fis.length; i++) unite(fis[0], fis[i]);
  }

  // Force-merge faces from the same STEP topological face.
  // A single B-Rep surface tessellated into many mesh triangles must
  // remain in one group — internal tessellation edges (e.g. on a
  // spherical corner) should never produce visible feature lines.
  // Use direct face-index grouping (not edge-based) to handle adaptive
  // subdivision that may create T-junctions between adjacent triangles.
  const topoFaceGroups = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const tid = faces[fi].topoFaceId;
    if (tid !== undefined) {
      if (!topoFaceGroups.has(tid)) topoFaceGroups.set(tid, []);
      topoFaceGroups.get(tid).push(fi);
    }
  }
  for (const [, fis] of topoFaceGroups) {
    for (let i = 1; i < fis.length; i++) unite(fis[0], fis[i]);
  }

  // Assign final faceGroup from union-find
  for (let fi = 0; fi < faces.length; fi++) {
    faces[fi].faceGroup = find(fi);
  }

  // Mark curved groups: a group is curved if it contains faces with different normals
  const groupNormals = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const g = faces[fi].faceGroup;
    const n = faces[fi].normal;
    if (!groupNormals.has(g)) {
      groupNormals.set(g, n);
    } else {
      const ref = groupNormals.get(g);
      // If any face in the group has a different normal, mark it as curved
      if (ref !== 'curved') {
        const dot = ref.x * n.x + ref.y * n.y + ref.z * n.z;
        if (dot < 1 - 1e-6) {
          groupNormals.set(g, 'curved');
        }
      }
    }
  }
  for (let fi = 0; fi < faces.length; fi++) {
    faces[fi].isCurved = groupNormals.get(faces[fi].faceGroup) === 'curved';
  }
}

// -----------------------------------------------------------------------
// Face type classification
// -----------------------------------------------------------------------

/**
 * Classify the type of a face based on its normal and vertex positions.
 * Returns: 'planar-horizontal', 'planar-vertical', 'planar', 'cylindrical', or 'freeform'
 */
function classifyFaceType(normal, vertices) {
  if (vertices.length < 3) return 'planar';

  // Check if all vertices are coplanar (within tolerance)
  const n = Vec3.from(normal);
  const p0 = Vec3.from(vertices[0]);
  const d = n.dot(p0);

  let allCoplanar = true;
  for (const v of vertices) {
    if (Math.abs(n.dot(Vec3.from(v)) - d) > EPSILON * 10) {
      allCoplanar = false;
      break;
    }
  }

  if (allCoplanar) {
    // Check if normal is axis-aligned
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    if (az > 0.99) return 'planar-horizontal';
    if (ax > 0.99 || ay > 0.99) return 'planar-vertical';
    return 'planar';
  }

  // For quads with non-coplanar verts, assume cylindrical (from extrusion of curves)
  if (vertices.length === 4) return 'cylindrical';

  return 'freeform';
}

/**
 * Create a unique edge key from two vertex positions (order-independent).
 */
function edgeKey(a, b) {
  const ax = Math.round(a.x * 1e6), ay = Math.round(a.y * 1e6), az = Math.round(a.z * 1e6);
  const bx = Math.round(b.x * 1e6), by = Math.round(b.y * 1e6), bz = Math.round(b.z * 1e6);
  if (ax < bx || (ax === bx && (ay < by || (ay === by && az < bz)))) {
    return `${ax},${ay},${az}|${bx},${by},${bz}`;
  }
  return `${bx},${by},${bz}|${ax},${ay},${az}`;
}

// -----------------------------------------------------------------------
// T-junction repair
// -----------------------------------------------------------------------

/**
 * Fix T-junctions left by BSP splitting.
 * When the BSP tree splits polygon A along a plane, new vertices are created
 * on A's edges.  Adjacent polygon B, which shares those edges, may NOT be
 * split by the same plane, leaving a vertex from A sitting on B's edge
 * without being part of B's vertex list (a T-junction).
 *
 * This function detects such vertices and inserts them into the affected
 * face edges so that adjacent faces properly share all boundary vertices,
 * producing a manifold mesh.
 */
function _fixTJunctions(faces) {
  function vKey(v) {
    return `${Math.round(v.x * 1e6)},${Math.round(v.y * 1e6)},${Math.round(v.z * 1e6)}`;
  }

  // Collect all unique vertex positions
  const uniqueVerts = [];
  const seen = new Set();
  for (const face of faces) {
    for (const v of face.vertices) {
      const k = vKey(v);
      if (!seen.has(k)) {
        seen.add(k);
        uniqueVerts.push(v);
      }
    }
  }

  // Iterate until no more T-junctions are found (usually 1 pass)
  for (let iter = 0; iter < 5; iter++) {
    let changed = false;

    for (let fi = 0; fi < faces.length; fi++) {
      const verts = faces[fi].vertices;
      const newVerts = [];

      for (let i = 0; i < verts.length; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        newVerts.push(a);

        const aKey = vKey(a);
        const bKey = vKey(b);

        // Find all vertices that lie strictly on edge [a, b]
        const onEdge = [];
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const lenSq = dx * dx + dy * dy + dz * dz;
        if (lenSq < EPSILON * EPSILON) continue; // degenerate edge

        for (const v of uniqueVerts) {
          const k = vKey(v);
          if (k === aKey || k === bKey) continue;
          const px = v.x - a.x, py = v.y - a.y, pz = v.z - a.z;
          const t = (px * dx + py * dy + pz * dz) / lenSq;
          if (t <= EPSILON || t >= 1 - EPSILON) continue;
          const projX = px - t * dx, projY = py - t * dy, projZ = pz - t * dz;
          if (projX * projX + projY * projY + projZ * projZ < EPSILON * EPSILON) {
            onEdge.push({ v, t });
          }
        }

        if (onEdge.length > 0) {
          changed = true;
          onEdge.sort((x, y) => x.t - y.t);
          for (const { v } of onEdge) {
            newVerts.push({ ...v });
          }
        }
      }

      if (newVerts.length > verts.length) {
        faces[fi].vertices = newVerts;
      }
    }

    // Remove consecutive duplicate vertices that may appear when a T-junction
    // vertex coincides with an existing endpoint at the joining precision.
    const dedupPrec = 1e5;
    function dvKey(v) {
      return `${Math.round((Math.abs(v.x) < 5e-6 ? 0 : v.x) * dedupPrec)},${Math.round((Math.abs(v.y) < 5e-6 ? 0 : v.y) * dedupPrec)},${Math.round((Math.abs(v.z) < 5e-6 ? 0 : v.z) * dedupPrec)}`;
    }
    for (let fi = 0; fi < faces.length; fi++) {
      const verts = faces[fi].vertices;
      if (verts.length <= 3) continue;
      const cleaned = [verts[0]];
      for (let i = 1; i < verts.length; i++) {
        if (dvKey(verts[i]) !== dvKey(cleaned[cleaned.length - 1])) {
          cleaned.push(verts[i]);
        }
      }
      // Also check wrap-around (last vs first)
      if (cleaned.length > 1 && dvKey(cleaned[cleaned.length - 1]) === dvKey(cleaned[0])) {
        cleaned.pop();
      }
      if (cleaned.length < verts.length) {
        faces[fi].vertices = cleaned;
      }
    }

    if (!changed) break;

    // Update unique vertices in case new positions appeared (shouldn't happen
    // since we only insert existing vertices, but be safe)
    for (const face of faces) {
      for (const v of face.vertices) {
        const k = vKey(v);
        if (!seen.has(k)) {
          seen.add(k);
          uniqueVerts.push(v);
        }
      }
    }
  }
}

// -----------------------------------------------------------------------
// Feature edge computation
// -----------------------------------------------------------------------

/**
 * Check if point p lies strictly on segment [a, b] (not at endpoints).
 */
function pointOnSegmentStrict(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const px = p.x - a.x, py = p.y - a.y, pz = p.z - a.z;
  const lenSq = dx * dx + dy * dy + dz * dz;
  if (lenSq < EPSILON * EPSILON) return false; // degenerate edge
  const t = (px * dx + py * dy + pz * dz) / lenSq;
  if (t <= EPSILON || t >= 1 - EPSILON) return false; // at or beyond endpoints
  const projX = px - t * dx, projY = py - t * dy, projZ = pz - t * dz;
  return (projX * projX + projY * projY + projZ * projZ) < EPSILON * EPSILON;
}

/**
 * Compute feature edges for a geometry's face list.
 * Assigns coplanar face groups and returns the array of feature edges.
 * Faces are modified in-place (faceGroup, faceType added).
 *
 * @param {Array} faces - Array of face objects {vertices, normal, ...}
 * @returns {Array} Array of {start, end} edge objects
 */
export function computeFeatureEdges(faces) {
  // Group coplanar adjacent faces so they can be selected as one logical face.
  assignCoplanarFaceGroups(faces);

  // Build edge → normal/face tracking
  const edgeNormals = new Map();
  // Cache edge keys per face: edgeKeysPerFace[fi][i] = key for edge i→(i+1)
  const edgeKeysPerFace = new Array(faces.length);
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    const faceVerts = face.vertices;
    const normal = face.normal;
    const keys = new Array(faceVerts.length);
    for (let i = 0; i < faceVerts.length; i++) {
      const a = faceVerts[i];
      const b = faceVerts[(i + 1) % faceVerts.length];
      const key = edgeKey(a, b);
      keys[i] = key;
      if (!edgeNormals.has(key)) {
        edgeNormals.set(key, { start: a, end: b, normals: [], faceIndices: [] });
      }
      const entry = edgeNormals.get(key);
      entry.normals.push(normal);
      entry.faceIndices.push(fi);
    }
    edgeKeysPerFace[fi] = keys;
  }

  // Collect faces per group (only groups with multiple faces need T-junction analysis)
  const facesPerGroup = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const g = faces[fi].faceGroup;
    if (!facesPerGroup.has(g)) facesPerGroup.set(g, []);
    facesPerGroup.get(g).push(fi);
  }

  // Pre-compute T-junction edge keys for each multi-face group.
  // A boundary edge is a T-junction internal edge if:
  //   (a) another face in the same group has a vertex that lies strictly on this edge, or
  //   (b) one of this edge's endpoints lies strictly on an edge of another group face.
  const tJunctionEdgeKeys = new Set();
  for (const [, groupFaceIndices] of facesPerGroup) {
    if (groupFaceIndices.length <= 1) continue;

    // Skip T-junction analysis for STEP topology faces — their boundary
    // edges are suppressed later via the topoFaceId check, so the expensive
    // O(n²) point-on-segment tests are unnecessary.
    if (faces[groupFaceIndices[0]].topoFaceId !== undefined) continue;

    // Collect all edges of the group with pre-computed keys
    const groupEdges = [];
    for (const fi of groupFaceIndices) {
      const verts = faces[fi].vertices;
      const keys = edgeKeysPerFace[fi];
      for (let i = 0; i < verts.length; i++) {
        groupEdges.push({ a: verts[i], b: verts[(i + 1) % verts.length], fi, key: keys[i] });
      }
    }

    // Check each edge against vertices/edges of other faces in the same group
    for (const edge of groupEdges) {
      const ek = edge.key;
      if (tJunctionEdgeKeys.has(ek)) continue; // already marked
      // Only process boundary edges (we only suppress boundary edges)
      const info = edgeNormals.get(ek);
      if (!info || info.normals.length !== 1) continue;

      let isTJunction = false;

      // (a) Does any vertex of another group face lie on this edge?
      for (const otherFi of groupFaceIndices) {
        if (otherFi === edge.fi) continue;
        for (const v of faces[otherFi].vertices) {
          if (pointOnSegmentStrict(v, edge.a, edge.b)) {
            isTJunction = true;
            break;
          }
        }
        if (isTJunction) break;
      }

      // (b) Does either endpoint lie on an edge of another group face?
      if (!isTJunction) {
        for (const other of groupEdges) {
          if (other.fi === edge.fi) continue;
          if (pointOnSegmentStrict(edge.a, other.a, other.b) ||
              pointOnSegmentStrict(edge.b, other.a, other.b)) {
            isTJunction = true;
            break;
          }
        }
      }

      if (isTJunction) tJunctionEdgeKeys.add(ek);
    }
  }

  // Build feature edges: boundary edges or sharp edges
  // Also build visual edges: tessellation edges on curved surfaces (non-selectable wireframe)
  const SHARP_THRESHOLD = Math.cos(15 * Math.PI / 180); // ~0.966
  // Relaxed threshold for edges within the same face group / topo face:
  // coarsely tessellated smooth surfaces (e.g. spherical corners) can have
  // adjacent triangle normals diverging beyond 15° but are still part of one
  // continuous surface.  Use 30° so only genuinely sharp creases register.
  const SAME_FACE_SHARP_THRESHOLD = Math.cos(30 * Math.PI / 180); // ~0.866
  const COPLANAR_THRESHOLD = 1 - 1e-6;
  let edges = [];
  const visualEdges = [];
  for (const [key, info] of edgeNormals) {
    if (info.normals.length === 1) {
      // Boundary edge — only suppress if it's a confirmed T-junction
      // Also suppress boundary edges from STEP topology faces: in a
      // properly closed B-Rep solid, every edge is shared by two faces,
      // so a boundary (1-face) edge within a STEP mesh is always an
      // internal tessellation artifact (e.g. from adaptive subdivision).
      if (!tJunctionEdgeKeys.has(key)) {
        const fi0 = info.faceIndices[0];
        if (faces[fi0].topoFaceId !== undefined) {
          // STEP artifact — suppress
        } else {
          edges.push({
            start: info.start, end: info.end,
            faceIndices: info.faceIndices,
            normals: info.normals,
          });
        }
      }
    } else if (info.normals.length >= 2) {
      // Determine if both faces belong to the same logical surface
      const sameGroup = info.faceIndices.length >= 2 &&
        new Set(info.faceIndices.map(fi => faces[fi].faceGroup)).size === 1;
      const threshold = sameGroup ? SAME_FACE_SHARP_THRESHOLD : SHARP_THRESHOLD;

      // Check if any pair of adjacent normals differs significantly
      const n0 = info.normals[0];
      let isFeature = false;
      let minDot = 1;
      for (let i = 1; i < info.normals.length; i++) {
        const n1 = info.normals[i];
        const dot = n0.x * n1.x + n0.y * n1.y + n0.z * n1.z;
        if (dot < minDot) minDot = dot;
        if (dot < threshold) {
          isFeature = true;
          break;
        }
      }
      // Force feature edge at fillet-to-flat face boundary
      if (!isFeature && info.faceIndices.length >= 2) {
        const hasF = info.faceIndices.some(fi => faces[fi].isFillet);
        const hasNF = info.faceIndices.some(fi => !faces[fi].isFillet);
        if (hasF && hasNF) isFeature = true;
      }
      // Force feature edge at STEP topology face boundaries: edges between
      // different topoFaceId values represent B-Rep surface seams that should
      // always be selectable, even when the normals are nearly continuous
      // (e.g. tangent-continuous fillet-to-corner transitions).
      if (!isFeature && info.faceIndices.length >= 2) {
        const groups = new Set(info.faceIndices.map(fi => faces[fi].faceGroup));
        const topoIds = new Set();
        for (const fi of info.faceIndices) {
          if (faces[fi].topoFaceId !== undefined) topoIds.add(faces[fi].topoFaceId);
        }
        if (topoIds.size > 1 && groups.size > 1) isFeature = true;
      }
      // Suppress feature edges at the corner base seam: the flat base triangle
      // connecting the spherical corner to the trimmed box faces is a geometric
      // necessity for manifold closure but should not produce visible feature lines.
      if (isFeature && info.faceIndices.length >= 2) {
        const hasCorner = info.faceIndices.some(fi => faces[fi].isCorner);
        const allNonFillet = info.faceIndices.every(fi => !faces[fi].isFillet);
        if (hasCorner && allNonFillet) isFeature = false;
      }
      // Suppress feature edges between faces from the same STEP topology
      // face — these are internal tessellation artifacts, never real B-Rep
      // seams.  This overrides angle thresholds so that coarse subdivision
      // on a spherical corner never shows internal lines.
      if (isFeature && info.faceIndices.length >= 2) {
        const fa = faces[info.faceIndices[0]], fb = faces[info.faceIndices[1]];
        if (fa.topoFaceId !== undefined && fa.topoFaceId === fb.topoFaceId) {
          isFeature = false;
        }
      }
      // Faces already merged into one logical coplanar face must never
      // expose their internal triangulation seam as a selectable feature edge.
      if (isFeature && sameGroup) {
        isFeature = false;
      }
      if (isFeature) {
        edges.push({
          start: info.start, end: info.end,
          faceIndices: info.faceIndices,
          normals: info.normals,
        });
      } else if (minDot < COPLANAR_THRESHOLD) {
        // Normals differ but not enough for a feature edge — curved surface tessellation edge
        // Only include if faces are in different coplanar groups
        const groups = new Set(info.faceIndices.map(fi => faces[fi].faceGroup));
        if (groups.size > 1) {
          // Suppress visual edges between faces from the same STEP topology
          // face — these are internal subdivision artifacts on curved surfaces
          // (e.g. sphere patches) that should never show wireframe lines.
          const topoIds = new Set(info.faceIndices.map(fi => faces[fi].topoFaceId).filter(id => id !== undefined));
          if (topoIds.size > 1 || topoIds.size === 0) {
            visualEdges.push({ start: info.start, end: info.end });
          }
        }
      }
    }
  }

  // Chain connected feature edges into paths.  A path is a maximal connected
  // sequence of edges where every *internal* vertex has exactly 2 incident
  // feature edges (i.e. the path continues through that vertex).  Vertices
  // with 1 or 3+ connections become path endpoints; if every vertex in a
  // connected component has valence 2 the path is closed (loop).
  const paths = _chainEdgePaths(edges);

  return { edges, paths, visualEdges };
}

/**
 * Chain connected feature edges into paths.
 * A path is a maximal connected sequence of edges where every internal vertex
 * connects exactly 2 feature edges.  Vertices with 1 or 3+ connections are
 * path endpoints.  If all vertices in a component have valence 2 the path is
 * a closed loop.
 *
 * @param {Array} edges - Feature edge array [{start, end, faceIndices, normals}, ...]
 * @returns {Array} Array of path objects:
 *   { edgeIndices: number[], isClosed: boolean }
 */
function _chainEdgePaths(edges) {
  if (edges.length === 0) return [];

  const vKey = (v) => `${Math.round(v.x * 1e5)},${Math.round(v.y * 1e5)},${Math.round(v.z * 1e5)}`;

  // Build vertex → [edge index] adjacency
  const vertexEdges = new Map();
  const addVE = (v, idx) => {
    const k = vKey(v);
    if (!vertexEdges.has(k)) vertexEdges.set(k, []);
    vertexEdges.get(k).push(idx);
  };
  for (let i = 0; i < edges.length; i++) {
    addVE(edges[i].start, i);
    addVE(edges[i].end, i);
  }

  const visited = new Set();
  const paths = [];

  for (let seed = 0; seed < edges.length; seed++) {
    if (visited.has(seed)) continue;

    // Walk backward from seed to find the start of the chain
    // (stop when we hit a branch vertex or a dead end or revisit the seed)
    let startEdge = seed;
    let startVert = vKey(edges[seed].start);
    {
      let cur = seed;
      let prevVert = vKey(edges[seed].end);
      let curVert = vKey(edges[seed].start);
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const neighbors = vertexEdges.get(curVert) || [];
        if (neighbors.length !== 2) break; // branch or dead-end → stop
        const next = neighbors[0] === cur ? neighbors[1] : neighbors[0];
        if (next === seed) break; // looped back → closed
        const ne = edges[next];
        const nextVert = vKey(ne.start) === curVert ? vKey(ne.end) : vKey(ne.start);
        if (nextVert === prevVert) break; // shouldn't happen but guard
        prevVert = curVert;
        curVert = nextVert;
        cur = next;
      }
      startEdge = cur;
      startVert = curVert;
    }

    // Walk forward from startEdge/startVert collecting the chain
    const chain = [startEdge];
    visited.add(startEdge);
    let curVert = vKey(edges[startEdge].start) === startVert
      ? vKey(edges[startEdge].end) : startVert;
    // Use the other vertex of startEdge as the forward direction
    const se = edges[startEdge];
    let walkVert = vKey(se.start) === startVert ? vKey(se.end) : vKey(se.start);

    let isClosed = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const neighbors = vertexEdges.get(walkVert) || [];
      if (neighbors.length !== 2) break; // branch/dead-end
      const next = neighbors[0] === chain[chain.length - 1] ? neighbors[1] : neighbors[0];
      if (visited.has(next)) {
        // We re-visited an edge → closed loop
        isClosed = true;
        break;
      }
      chain.push(next);
      visited.add(next);
      const ne = edges[next];
      walkVert = vKey(ne.start) === walkVert ? vKey(ne.end) : vKey(ne.start);
    }

    paths.push({ edgeIndices: chain, isClosed });
  }

  return paths;
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Perform a boolean operation between two geometries.
 * @param {Object} geomA - First geometry {vertices, faces, edges}
 * @param {Object} geomB - Second geometry {vertices, faces, edges}
 * @param {string} operation - 'union', 'subtract', or 'intersect'
 * @param {Object} sharedA - Optional shared metadata for geometry A faces
 * @param {Object} sharedB - Optional shared metadata for geometry B faces
 * @returns {Object} Resulting geometry {vertices, faces, edges}
 */
export function booleanOp(geomA, geomB, operation, sharedA = null, sharedB = null) {
  // --- Exact B-Rep dispatch ---
  // If both operands carry exact topology, use the exact boolean kernel.
  if (geomA && geomA.topoBody && geomB && geomB.topoBody &&
      hasExactTopology(geomA.topoBody) && hasExactTopology(geomB.topoBody)) {
    const opName = (operation === 'add') ? 'union' : operation;
    const { body, mesh } = exactBooleanOp(geomA.topoBody, geomB.topoBody, opName);
    const displayFaces = _compactExactPlanarDisplayFaces(mesh.faces || []);
    const displayMesh = {
      ...mesh,
      faces: displayFaces,
    };
    const edgeResult = computeFeatureEdges(displayFaces);
    return {
      ...displayMesh,
      edges: edgeResult.edges,
      paths: edgeResult.paths,
      visualEdges: edgeResult.visualEdges,
      topoBody: body,
    };
  }

  // --- Legacy mesh BSP path ---
  const normalizeBooleanOperand = (geometry) => {
    if (!geometry || !Array.isArray(geometry.faces)) return geometry;

    const faces = geometry.faces.map((face) => ({
      ...face,
      vertices: (face.vertices || []).map((vertex) => ({ ...vertex })),
      normal: face.normal ? { ...face.normal } : face.normal,
      shared: face.shared || null,
    }));

    _fixTJunctions(faces);

    return {
      ...geometry,
      faces,
    };
  };

  const a = CSGSolid.fromGeometry(normalizeBooleanOperand(geomA), sharedA);
  const b = CSGSolid.fromGeometry(normalizeBooleanOperand(geomB), sharedB);

  let result;
  switch (operation) {
    case 'union':
    case 'add':
      result = a.union(b);
      break;
    case 'subtract':
      result = a.subtract(b);
      break;
    case 'intersect':
      result = a.intersect(b);
      break;
    default:
      throw new Error(`Unknown boolean operation: ${operation}`);
  }

  return result.toGeometry();
}

function _coplanarFacesTouch(faceA, faceB) {
  const vertsA = faceA.vertices || [];
  const vertsB = faceB.vertices || [];
  for (const va of vertsA) {
    for (let i = 0; i < vertsB.length; i++) {
      if (pointOnSegmentStrict(va, vertsB[i], vertsB[(i + 1) % vertsB.length])) return true;
    }
  }
  for (const vb of vertsB) {
    for (let i = 0; i < vertsA.length; i++) {
      if (pointOnSegmentStrict(vb, vertsA[i], vertsA[(i + 1) % vertsA.length])) return true;
    }
  }
  for (let i = 0; i < vertsA.length; i++) {
    const a0 = vertsA[i], a1 = vertsA[(i + 1) % vertsA.length];
    for (let j = 0; j < vertsB.length; j++) {
      const b0 = vertsB[j], b1 = vertsB[(j + 1) % vertsB.length];
      if (_collinearSegmentsOverlap(a0, a1, b0, b1)) return true;
    }
  }
  return false;
}

function _collinearSegmentsOverlap(a0, a1, b0, b1) {
  const ab = { x: a1.x - a0.x, y: a1.y - a0.y, z: a1.z - a0.z };
  const ac = { x: b0.x - a0.x, y: b0.y - a0.y, z: b0.z - a0.z };
  const ad = { x: b1.x - a0.x, y: b1.y - a0.y, z: b1.z - a0.z };
  const crossC = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
  const crossD = {
    x: ab.y * ad.z - ab.z * ad.y,
    y: ab.z * ad.x - ab.x * ad.z,
    z: ab.x * ad.y - ab.y * ad.x,
  };
  const lenC = Math.sqrt(crossC.x * crossC.x + crossC.y * crossC.y + crossC.z * crossC.z);
  const lenD = Math.sqrt(crossD.x * crossD.x + crossD.y * crossD.y + crossD.z * crossD.z);
  if (lenC > 1e-5 || lenD > 1e-5) return false;

  const lenSq = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  if (lenSq < 1e-10) return false;
  const t0 = (ac.x * ab.x + ac.y * ab.y + ac.z * ab.z) / lenSq;
  const t1 = (ad.x * ab.x + ad.y * ab.y + ad.z * ab.z) / lenSq;
  const minT = Math.min(t0, t1);
  const maxT = Math.max(t0, t1);
  return maxT > 1e-5 && minT < 1 - 1e-5 && (Math.min(1, maxT) - Math.max(0, minT)) > 1e-5;
}
function _computePolygonNormal(vertices) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < vertices.length; i++) {
    const curr = vertices[i];
    const next = vertices[(i + 1) % vertices.length];
    nx += (curr.y - next.y) * (curr.z + next.z);
    ny += (curr.z - next.z) * (curr.x + next.x);
    nz += (curr.x - next.x) * (curr.y + next.y);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len <= 1e-10) return null;
  return { x: nx / len, y: ny / len, z: nz / len };
}

/**
 * Count faces whose polygon winding opposes their stored face normal.
 * Degenerate faces or faces without a stored normal are ignored.
 * @param {Object} geometry - {faces: [{vertices: [...], normal: {x,y,z}}]}
 * @returns {number}
 */
export function countInvertedFaces(geometry) {
  let inverted = 0;
  for (const face of (geometry.faces || [])) {
    const polygonNormal = _computePolygonNormal(face.vertices || []);
    const faceNormal = face.normal;
    if (!polygonNormal || !faceNormal) continue;
    const dot =
      polygonNormal.x * faceNormal.x +
      polygonNormal.y * faceNormal.y +
      polygonNormal.z * faceNormal.z;
    if (dot < -1e-5) inverted++;
  }
  return inverted;
}

/**
 * Calculate the volume of a geometry using the divergence theorem.
 * Assumes the mesh is closed and consistently wound.
 * @param {Object} geometry - {faces: [{vertices: [{x,y,z},...], ...}]}
 * @returns {number} Signed volume
 */
export function calculateMeshVolume(geometry) {
  let volume = 0;
  for (const face of (geometry.faces || [])) {
    const verts = face.vertices;
    if (verts.length < 3) continue;
    // Fan triangulate and sum signed tetrahedron volumes
    const v0 = verts[0];
    for (let i = 1; i < verts.length - 1; i++) {
      const v1 = verts[i], v2 = verts[i + 1];
      volume += (
        v0.x * (v1.y * v2.z - v2.y * v1.z) -
        v1.x * (v0.y * v2.z - v2.y * v0.z) +
        v2.x * (v0.y * v1.z - v1.y * v0.z)
      ) / 6.0;
    }
  }
  return Math.abs(volume);
}

/**
 * Calculate the bounding box of a geometry.
 * @param {Object} geometry - {faces: [{vertices: [{x,y,z},...], ...}]}
 * @returns {Object} {min: {x,y,z}, max: {x,y,z}}
 */
export function calculateBoundingBox(geometry) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const face of (geometry.faces || [])) {
    for (const v of face.vertices) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
      if (v.z > maxZ) maxZ = v.z;
    }
  }

  if (minX === Infinity) {
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

/**
 * Calculate the total surface area of a closed mesh.
 * Uses fan triangulation per face and sums triangle areas.
 * @param {Object} geometry - {faces: [{vertices: [{x,y,z},...], ...}]}
 * @returns {number} Total surface area
 */
export function calculateSurfaceArea(geometry) {
  let area = 0;
  for (const face of (geometry.faces || [])) {
    const verts = face.vertices;
    if (verts.length < 3) continue;
    const v0 = verts[0];
    for (let i = 1; i < verts.length - 1; i++) {
      const v1 = verts[i], v2 = verts[i + 1];
      // Cross product of (v1-v0) x (v2-v0)
      const ax = v1.x - v0.x, ay = v1.y - v0.y, az = v1.z - v0.z;
      const bx = v2.x - v0.x, by = v2.y - v0.y, bz = v2.z - v0.z;
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;
      area += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
    }
  }
  return area;
}

// -----------------------------------------------------------------------
// Geometry analysis utilities
// -----------------------------------------------------------------------

/**
 * Detect disconnected bodies (connected components) in a geometry mesh.
 * Builds a face adjacency graph from shared edge vertices and finds
 * connected components via BFS.
 * @param {Object} geometry - {faces: [{vertices: [{x,y,z},...], ...}]}
 * @returns {Object} { bodyCount: number, bodySizes: number[] }
 *   bodyCount = number of connected components (1 = single solid)
 *   bodySizes = array of face counts per component, sorted descending
 */
export function detectDisconnectedBodies(geometry) {
  const faces = geometry.faces || [];
  if (faces.length === 0) return { bodyCount: 0, bodySizes: [] };

  // Build edge → face indices map
  const edgeFaces = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const key = edgeKey(a, b);
      if (!edgeFaces.has(key)) edgeFaces.set(key, []);
      edgeFaces.get(key).push(fi);
    }
  }

  // Build face adjacency (face → set of neighbor face indices)
  const adj = Array.from({ length: faces.length }, () => new Set());
  for (const faceList of edgeFaces.values()) {
    for (let i = 0; i < faceList.length; i++) {
      for (let j = i + 1; j < faceList.length; j++) {
        adj[faceList[i]].add(faceList[j]);
        adj[faceList[j]].add(faceList[i]);
      }
    }
  }

  // BFS connected components
  const visited = new Uint8Array(faces.length);
  const bodySizes = [];
  for (let start = 0; start < faces.length; start++) {
    if (visited[start]) continue;
    let count = 0;
    const queue = [start];
    visited[start] = 1;
    while (queue.length > 0) {
      const fi = queue.pop();
      count++;
      for (const neighbor of adj[fi]) {
        if (!visited[neighbor]) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
    bodySizes.push(count);
  }

  bodySizes.sort((a, b) => b - a);
  return { bodyCount: bodySizes.length, bodySizes };
}

/**
 * Estimate wall thickness by ray-casting from each face centroid along its
 * inward normal and finding the nearest opposing face hit.
 * Returns min and max wall thickness across all faces.
 * @param {Object} geometry - {faces: [{vertices: [{x,y,z},...], normal: {x,y,z}, ...}]}
 * @returns {Object} { minThickness: number, maxThickness: number }
 */
export function calculateWallThickness(geometry) {
  const faces = geometry.faces || [];
  if (faces.length < 2) return { minThickness: 0, maxThickness: 0 };

  // Pre-compute face centroids
  const centroids = faces.map(f => {
    const vs = f.vertices;
    const n = vs.length;
    let cx = 0, cy = 0, cz = 0;
    for (const v of vs) { cx += v.x; cy += v.y; cz += v.z; }
    return { x: cx / n, y: cy / n, z: cz / n };
  });

  let minT = Infinity, maxT = 0;

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    const n = face.normal;
    if (!n) continue;
    // Ray origin: centroid, direction: inward normal (negated outward normal)
    const origin = centroids[fi];
    const dir = { x: -n.x, y: -n.y, z: -n.z };

    let closest = Infinity;
    for (let ti = 0; ti < faces.length; ti++) {
      if (ti === fi) continue;
      const target = faces[ti];
      const tn = target.normal;
      if (!tn) continue;
      // Only consider roughly opposing faces (normals pointing toward each other)
      const dotNormals = n.x * tn.x + n.y * tn.y + n.z * tn.z;
      if (dotNormals > -0.1) continue; // not opposing

      // Ray-triangle intersection for each triangle in the fan
      const tverts = target.vertices;
      if (tverts.length < 3) continue;
      const v0 = tverts[0];
      for (let k = 1; k < tverts.length - 1; k++) {
        const v1 = tverts[k], v2 = tverts[k + 1];
        const t = _rayTriangleIntersect(origin, dir, v0, v1, v2);
        if (t > 1e-6 && t < closest) closest = t;
      }
    }

    if (closest < Infinity) {
      if (closest < minT) minT = closest;
      if (closest > maxT) maxT = closest;
    }
  }

  if (minT === Infinity) minT = 0;
  return { minThickness: minT, maxThickness: maxT };
}

/**
 * Möller–Trumbore ray-triangle intersection.
 * @returns {number} Distance t along ray, or Infinity if no hit.
 */
function _rayTriangleIntersect(origin, dir, v0, v1, v2) {
  const e1x = v1.x - v0.x, e1y = v1.y - v0.y, e1z = v1.z - v0.z;
  const e2x = v2.x - v0.x, e2y = v2.y - v0.y, e2z = v2.z - v0.z;
  const px = dir.y * e2z - dir.z * e2y;
  const py = dir.z * e2x - dir.x * e2z;
  const pz = dir.x * e2y - dir.y * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-10) return Infinity;
  const invDet = 1.0 / det;
  const tx = origin.x - v0.x, ty = origin.y - v0.y, tz = origin.z - v0.z;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return Infinity;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dir.x * qx + dir.y * qy + dir.z * qz) * invDet;
  if (v < 0 || u + v > 1) return Infinity;
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return t;
}

// -----------------------------------------------------------------------
// Edge key helpers for chamfer/fillet
// -----------------------------------------------------------------------

const EDGE_PREC = 5;
function _fmtCoord(n) {
  return (Math.abs(n) < 5e-6 ? 0 : n).toFixed(EDGE_PREC);
}
function _canonicalCoord(n, eps = 1e-12) {
  return Math.abs(n) < eps ? 0 : n;
}
function _canonicalPoint(point, eps = 1e-12) {
  if (!point) return point;
  return {
    x: _canonicalCoord(point.x, eps),
    y: _canonicalCoord(point.y, eps),
    z: _canonicalCoord(point.z, eps),
  };
}
function _edgeVKey(v) {
  return `${_fmtCoord(v.x)},${_fmtCoord(v.y)},${_fmtCoord(v.z)}`;
}
function _edgeKeyFromVerts(a, b) {
  const ka = _edgeVKey(a), kb = _edgeVKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function _vec3Sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function _vec3Add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function _vec3Scale(v, s) { return { x: v.x * s, y: v.y * s, z: v.z * s }; }
function _vec3Dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function _vec3Cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function _vec3Len(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
function _vec3Normalize(v) {
  const len = _vec3Len(v);
  if (len < 1e-10) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
function _vec3Lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * Compute the circumsphere center of 4 non-coplanar points.
 * All 4 points are equidistant from the returned center.
 * Returns {x,y,z} or null if the points are (near-)coplanar.
 */
function _circumsphereCenter(p0, p1, p2, p3) {
  const d1 = _vec3Sub(p1, p0);
  const d2 = _vec3Sub(p2, p0);
  const d3 = _vec3Sub(p3, p0);
  const b1 = _vec3Dot(d1, d1) / 2;
  const b2 = _vec3Dot(d2, d2) / 2;
  const b3 = _vec3Dot(d3, d3) / 2;
  const det = d1.x * (d2.y * d3.z - d2.z * d3.y)
            - d1.y * (d2.x * d3.z - d2.z * d3.x)
            + d1.z * (d2.x * d3.y - d2.y * d3.x);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const cx = (b1 * (d2.y * d3.z - d2.z * d3.y)
            - d1.y * (b2 * d3.z - d2.z * b3)
            + d1.z * (b2 * d3.y - d2.y * b3)) * inv;
  const cy = (d1.x * (b2 * d3.z - d2.z * b3)
            - b1 * (d2.x * d3.z - d2.z * d3.x)
            + d1.z * (d2.x * b3 - b2 * d3.x)) * inv;
  const cz = (d1.x * (d2.y * b3 - b2 * d3.y)
            - d1.y * (d2.x * b3 - b2 * d3.x)
            + b1 * (d2.x * d3.y - d2.y * d3.x)) * inv;
  return { x: p0.x + cx, y: p0.y + cy, z: p0.z + cz };
}

/**
 * Check whether a point lies on the plane defined by a set of face vertices.
 * Returns true if the signed distance from point to the plane is within tolerance.
 */
function _pointOnFacePlane(point, faceVerts, tolerance) {
  if (tolerance === undefined) tolerance = 0.01;
  if (faceVerts.length < 3) return true;
  const n = _vec3Cross(_vec3Sub(faceVerts[1], faceVerts[0]), _vec3Sub(faceVerts[2], faceVerts[0]));
  const len = _vec3Len(n);
  if (len < 1e-10) return true;
  return Math.abs(_vec3Dot(n, _vec3Sub(point, faceVerts[0]))) / len < tolerance;
}

/**
 * Find the two face normals adjacent to an edge in a geometry.
 * Returns { n0, n1 } or null if edge not found.
 */
function _findEdgeNormals(faces, edgeKey) {
  const normals = [];
  for (const face of faces) {
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      if (_edgeKeyFromVerts(a, b) === edgeKey) {
        normals.push(face.normal);
        break;
      }
    }
    if (normals.length >= 2) break;
  }
  return normals.length >= 2 ? { n0: normals[0], n1: normals[1] } : null;
}

// -----------------------------------------------------------------------
// Chamfer / Fillet shared helpers
// -----------------------------------------------------------------------

function _faceCentroid(face) {
  if (Array.isArray(face?.vertices) && face.vertices.length > 0) {
    let cx = 0, cy = 0, cz = 0;
    for (const v of face.vertices) {
      cx += v.x;
      cy += v.y;
      cz += v.z;
    }
    const n = face.vertices.length;
    return { x: cx / n, y: cy / n, z: cz / n };
  }

  const coedges = face?.outerLoop?.coedges;
  if (Array.isArray(coedges) && coedges.length > 0) {
    let sx = 0, sy = 0, sz = 0;
    for (const ce of coedges) {
      const p = ce.edge.startVertex.point;
      sx += p.x;
      sy += p.y;
      sz += p.z;
    }
    const count = coedges.length;
    return { x: sx / count, y: sy / count, z: sz / count };
  }

  return { x: 0, y: 0, z: 0 };
}

function _trimFaceEdge(face, edgeA, edgeB, newA, newB) {
  const verts = face.vertices;
  const keyA = _edgeVKey(edgeA);
  const keyB = _edgeVKey(edgeB);
  const newVerts = [];
  for (let i = 0; i < verts.length; i++) {
    const vk = _edgeVKey(verts[i]);
    if (vk === keyA) {
      newVerts.push({ ...newA });
    } else if (vk === keyB) {
      newVerts.push({ ...newB });
    } else {
      newVerts.push(verts[i]);
    }
  }
  face.vertices = newVerts;
}

function _collectFaceEdgeKeys(face) {
  const keys = new Set();
  const verts = face.vertices;
  for (let i = 0; i < verts.length; i++) {
    keys.add(_edgeKeyFromVerts(verts[i], verts[(i + 1) % verts.length]));
  }
  return keys;
}

/**
 * At an edge endpoint, split the vertex in every face OTHER THAN face0/face1.
 *
 * Bridge faces (connecting face0-side to face1-side around the vertex ring) get
 * TWO replacement vertices so they span the bevel/arc gap.  Faces that live
 * entirely on one side get a SINGLE replacement vertex (p0 or p1) so the
 * fan topology stays intact.
 */
function _splitVertexAtEndpoint(faces, fi0, fi1, oldVertex, p0, p1, face0Keys, face1Keys) {
  const vk = _edgeVKey(oldVertex);

  for (let fi = 0; fi < faces.length; fi++) {
    if (fi === fi0 || fi === fi1) continue;
    const face = faces[fi];
    const verts = face.vertices;

    let vidx = -1;
    for (let i = 0; i < verts.length; i++) {
      if (_edgeVKey(verts[i]) === vk) { vidx = i; break; }
    }
    if (vidx < 0) continue;

    const prevIdx = (vidx - 1 + verts.length) % verts.length;
    const nextIdx = (vidx + 1) % verts.length;
    const prevEdge = _edgeKeyFromVerts(verts[prevIdx], verts[vidx]);
    const nextEdge = _edgeKeyFromVerts(verts[vidx], verts[nextIdx]);

    const prevInF0 = face0Keys.has(prevEdge);
    const prevInF1 = face1Keys.has(prevEdge);
    const nextInF0 = face0Keys.has(nextEdge);
    const nextInF1 = face1Keys.has(nextEdge);

    const touchesF0 = prevInF0 || nextInF0;
    const touchesF1 = prevInF1 || nextInF1;

    let newPts;
    if (touchesF0 && touchesF1) {
      // Bridge / cap face — shares edges with both sides → two vertices
      newPts = prevInF0 ? [{ ...p0 }, { ...p1 }] : [{ ...p1 }, { ...p0 }];
    } else if (touchesF0) {
      // Adjacent to face0 but not face1 — bridge into the chain → two vertices
      newPts = nextInF0 ? [{ ...p1 }, { ...p0 }] : [{ ...p0 }, { ...p1 }];
    } else if (touchesF1) {
      // Adjacent to face1 only — entirely on face1 side → single vertex
      newPts = [{ ...p1 }];
    } else {
      // No direct edge connection to either face — pick side by normal alignment
      const fn = _vec3Normalize(face.normal);
      const n0 = _vec3Normalize(faces[fi0].normal);
      const n1 = _vec3Normalize(faces[fi1].normal);
      const dot0 = Math.abs(_vec3Dot(fn, n0));
      const dot1 = Math.abs(_vec3Dot(fn, n1));
      newPts = [dot0 > dot1 ? { ...p0 } : { ...p1 }];
    }

    const newVerts = [];
    for (let i = 0; i < verts.length; i++) {
      if (i === vidx) {
        newVerts.push(...newPts);
      } else {
        newVerts.push(verts[i]);
      }
    }
    face.vertices = newVerts;
  }
}

/**
 * Extend edge keys through existing fillet boundaries.
 * When an edge endpoint sits on a fillet face boundary (not at a sharp corner),
 * extend the edge along its direction to pass through the fillet surface.
 * This enables sequential fillets to cut through existing fillet surfaces.
 */
function _extendEdgesThroughFilletBoundaries(faces, edgeKeys) {
  const result = [];
  
  // Build a lookup of which vertices belong to fillet faces
  const filletBoundaryVertices = new Map(); // vertex key → { filletFaceIndices, originalVertex }
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (!face.isFillet) continue;
    for (const v of face.vertices) {
      const vk = _edgeVKey(v);
      if (!filletBoundaryVertices.has(vk)) {
        filletBoundaryVertices.set(vk, { filletFaceIndices: [], pos: { ...v } });
      }
      filletBoundaryVertices.get(vk).filletFaceIndices.push(fi);
    }
  }

  // Build lookup of sharp edges (from non-fillet faces) that could be the
  // "original" edge before filleting
  const sharpEdgeLines = []; // Array of {start, end, dir}
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (face.isFillet || face.isCorner) continue;
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const delta = _vec3Sub(b, a);
      const len = _vec3Len(delta);
      if (len < 1e-10) continue;
      sharpEdgeLines.push({
        start: { ...a },
        end: { ...b },
        dir: _vec3Normalize(delta),
        len,
      });
    }
  }

  for (const ek of edgeKeys) {
    const sep = ek.indexOf('|');
    if (sep < 0) {
      result.push(ek);
      continue;
    }
    
    const parseV = (s) => {
      const c = s.split(',').map(Number);
      return { x: c[0], y: c[1], z: c[2] };
    };
    
    let ptA = parseV(ek.slice(0, sep));
    let ptB = parseV(ek.slice(sep + 1));
    const edgeDir = _vec3Normalize(_vec3Sub(ptB, ptA));
    const edgeLen = _vec3Len(_vec3Sub(ptB, ptA));
    
    // Check if endpoint A is on a fillet boundary
    const vkA = _edgeVKey(ptA);
    const filletInfoA = filletBoundaryVertices.get(vkA);
    if (filletInfoA) {
      // Endpoint A is on a fillet boundary - extend backward along edge direction
      // Look for sharp edges that are collinear and could be the original untrimmed edge
      for (const line of sharpEdgeLines) {
        // Check if this edge line is collinear with our edge direction
        const dotDir = Math.abs(_vec3Dot(line.dir, edgeDir));
        if (dotDir < 0.99) continue;
        
        // Check if extending our edge backward would reach this line
        // Project ptA onto the line
        const toLineStart = _vec3Sub(ptA, line.start);
        const projOnLine = _vec3Dot(toLineStart, line.dir);
        const closestOnLine = _vec3Add(line.start, _vec3Scale(line.dir, projOnLine));
        const lateralDist = _vec3Len(_vec3Sub(ptA, closestOnLine));
        
        // If ptA is close to this line, find the extension point
        if (lateralDist < edgeLen * 0.15 + 0.1) {
          // Compute intersection of our edge ray with the line's plane perpendicular to edge direction
          // The extension point is where backtracking along edgeDir reaches the line's endpoint
          const toStart = _vec3Sub(line.start, ptA);
          const toEnd = _vec3Sub(line.end, ptA);
          const projStart = _vec3Dot(toStart, edgeDir);
          const projEnd = _vec3Dot(toEnd, edgeDir);
          
          // Find the point that's in the backward direction
          if (projStart < -1e-6 && projStart < projEnd) {
            ptA = { ...line.start };
            break;
          } else if (projEnd < -1e-6) {
            ptA = { ...line.end };
            break;
          }
        }
      }
    }
    
    // Check if endpoint B is on a fillet boundary  
    const vkB = _edgeVKey(ptB);
    const filletInfoB = filletBoundaryVertices.get(vkB);
    if (filletInfoB) {
      // Endpoint B is on a fillet boundary - extend forward along edge direction
      for (const line of sharpEdgeLines) {
        const dotDir = Math.abs(_vec3Dot(line.dir, edgeDir));
        if (dotDir < 0.99) continue;
        
        const toLineStart = _vec3Sub(ptB, line.start);
        const projOnLine = _vec3Dot(toLineStart, line.dir);
        const closestOnLine = _vec3Add(line.start, _vec3Scale(line.dir, projOnLine));
        const lateralDist = _vec3Len(_vec3Sub(ptB, closestOnLine));
        
        if (lateralDist < edgeLen * 0.15 + 0.1) {
          const toStart = _vec3Sub(line.start, ptB);
          const toEnd = _vec3Sub(line.end, ptB);
          const projStart = _vec3Dot(toStart, edgeDir);
          const projEnd = _vec3Dot(toEnd, edgeDir);
          
          if (projStart > 1e-6 && projStart > projEnd) {
            ptB = { ...line.start };
            break;
          } else if (projEnd > 1e-6) {
            ptB = { ...line.end };
            break;
          }
        }
      }
    }
    
    // Rebuild the edge key with potentially extended endpoints
    const fmt = (n) => n.toFixed(5);
    const newKey = `${fmt(ptA.x)},${fmt(ptA.y)},${fmt(ptA.z)}|${fmt(ptB.x)},${fmt(ptB.y)},${fmt(ptB.z)}`;
    result.push(newKey);
  }
  
  return result;
}

/**
 * Compute intersection trim curves between new fillet cylinders and existing fillet cylinders.
 * When a new fillet edge passes through an existing fillet surface, compute the intersection
 * curve between the two rolling-ball cylinders. This curve becomes the shared trim boundary.
 */
function _computeFilletFilletIntersections(faces, edgeDataList, radius, segments) {
  // Find existing fillet faces with their cylinder geometry
  const existingFilletCylinders = [];
  let filletFaceCount = 0;
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (!face.isFillet) continue;
    filletFaceCount++;
    // Extract cylinder axis and radius from fillet face metadata if available
    if (face._exactAxisStart && face._exactAxisEnd && face._exactRadius) {
      existingFilletCylinders.push({
        fi,
        axisStart: face._exactAxisStart,
        axisEnd: face._exactAxisEnd,
        radius: face._exactRadius,
      });
    }
  }
  
  if (existingFilletCylinders.length === 0) return;
  
  // For each new fillet edge, check if it intersects any existing fillet cylinder
  for (const data of edgeDataList) {
    if (!data) continue;
    
    // The new fillet cylinder axis needs to be computed from the edge and adjacent face normals
    // First, get the adjacent faces to compute the bisector direction
    const face0 = faces[data.fi0];
    const face1 = faces[data.fi1];
    
    // Compute offset directions from edge toward each adjacent face's interior
    const { offsDir0, offsDir1 } = _computeOffsetDirs(face0, face1, data.edgeA, data.edgeB);
    
    // Bisector and centerDist computation
    const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));
    const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
    const centerDist = alpha > 1e-6 ? radius / Math.sin(alpha / 2) : radius;
    
    // The new fillet cylinder axis runs parallel to the edge, offset by centerDist along bisector
    const newAxisStart = _vec3Add(data.edgeA, _vec3Scale(bisector, centerDist));
    const newAxisEnd = _vec3Add(data.edgeB, _vec3Scale(bisector, centerDist));
    const newAxisDir = _vec3Normalize(_vec3Sub(newAxisEnd, newAxisStart));
    

    
    for (const oldCyl of existingFilletCylinders) {
      // Check if the new fillet edge passes near the old cylinder
      const oldAxisDir = _vec3Normalize(_vec3Sub(oldCyl.axisEnd, oldCyl.axisStart));
      
      // Skip if axes are nearly parallel (no intersection)
      const axisDot = Math.abs(_vec3Dot(newAxisDir, oldAxisDir));

      if (axisDot > 0.99) continue;
      
      // Compute closest approach between the two axis lines
      const d = _vec3Sub(data.edgeA, oldCyl.axisStart);
      const n = _vec3Cross(newAxisDir, oldAxisDir);
      const nLen = _vec3Len(n);
      if (nLen < 1e-10) continue;
      
      const dist = Math.abs(_vec3Dot(d, n)) / nLen;
      const sumRadii = radius + oldCyl.radius;
      

      
      // If axes are close enough, the cylinders might intersect
      if (dist < sumRadii * 1.5) {

        // Mark this edge data as having a fillet-fillet intersection
        data._intersectsOldFillet = true;
        data._oldFilletCylinder = oldCyl;
        
        // Check which edge endpoint (A or B) is near the old fillet cylinder axis
        // by testing distance from the edge endpoint to the old cylinder's axis line
        const distEdgeAToOldAxis = _distancePointToLineSegment(data.edgeA, oldCyl.axisStart, oldCyl.axisEnd);
        const distEdgeBToOldAxis = _distancePointToLineSegment(data.edgeB, oldCyl.axisStart, oldCyl.axisEnd);
        

        
        // If an edge endpoint is within the interaction zone of the old fillet, compute the trim curve
        // The trim curve is the 3D cylinder-cylinder intersection: each arc point is translated
        // along the edge direction until it lies on the old cylinder surface.
        const edgeDir = _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA));
        if (distEdgeAToOldAxis < sumRadii && distEdgeAToOldAxis < distEdgeBToOldAxis) {
          // Compute intersection of arcA with old cylinder
          const intersectionCurve = _computeArcCylinderIntersection(
            data.arcA, edgeDir, oldCyl.axisStart, oldCyl.axisEnd, oldCyl.radius
          );
          if (intersectionCurve && intersectionCurve.length > 0) {
            data.sharedTrimA = intersectionCurve;
            // Don't set plane origin/normal — the intersection is a 3D space curve, not planar
            data._sharedTrimPlaneAOrigin = null;
            data._sharedTrimPlaneANormal = null;
            data._filletJunctionSideA = true;
          }
        } else if (distEdgeBToOldAxis < sumRadii) {
          // Compute intersection of arcB with old cylinder
          const negEdgeDir = _vec3Scale(edgeDir, -1);
          const intersectionCurve = _computeArcCylinderIntersection(
            data.arcB, negEdgeDir, oldCyl.axisStart, oldCyl.axisEnd, oldCyl.radius
          );
          if (intersectionCurve && intersectionCurve.length > 0) {
            data.sharedTrimB = intersectionCurve;
            data._sharedTrimPlaneBOrigin = null;
            data._sharedTrimPlaneBNormal = null;
            data._filletJunctionSideB = true;
          }
        }
      }
    }
  }
}

/**
 * Compute distance from a point to a line segment.
 */
function _distancePointToLineSegment(p, a, b) {
  const ab = _vec3Sub(b, a);
  const ap = _vec3Sub(p, a);
  const abLen = _vec3Len(ab);
  if (abLen < 1e-10) return _vec3Len(ap);
  
  const t = Math.max(0, Math.min(1, _vec3Dot(ap, ab) / (abLen * abLen)));
  const closest = _vec3Add(a, _vec3Scale(ab, t));
  return _vec3Len(_vec3Sub(p, closest));
}

/**
 * Compute the 3D intersection curve between a new fillet arc and an old fillet cylinder.
 * For each arc point P, translates it along edgeDir by t so the point lies on the old
 * cylinder surface.  Solves:  |P + t·edgeDir − oldAxis|_perp = oldRadius  (quadratic in t).
 * Returns the intersection curve as an array of 3D points, or null.
 */
function _computeArcCylinderIntersection(arc, edgeDir, oldCylAxisStart, oldCylAxisEnd, oldCylRadius) {
  if (!arc || arc.length < 2) return null;

  const D_old = _vec3Normalize(_vec3Sub(oldCylAxisEnd, oldCylAxisStart));
  // B = edgeDir × D_old  (shared across all points)
  const B = _vec3Cross(edgeDir, D_old);
  const a_coeff = _vec3Dot(B, B);          // |edgeDir × D_old|²
  if (a_coeff < 1e-12) return null;        // edge ∥ old axis → no intersection

  const result = [];
  for (const p of arc) {
    const Q0 = _vec3Sub(p, oldCylAxisStart);
    const A  = _vec3Cross(Q0, D_old);       // Q0 × D_old

    const b_half = _vec3Dot(A, B);          // (Q0×D_old)·(edgeDir×D_old)
    const c_coeff = _vec3Dot(A, A) - oldCylRadius * oldCylRadius;

    const disc = b_half * b_half - a_coeff * c_coeff;
    if (disc < 0) {
      // Arc point can't reach old cylinder – keep original position
      result.push({ ...p });
      continue;
    }

    const sqrtDisc = Math.sqrt(disc);
    const t1 = (-b_half - sqrtDisc) / a_coeff;   // more-negative root
    const t2 = (-b_half + sqrtDisc) / a_coeff;

    // We want the root that moves the point toward the old fillet surface
    // (typically backward from edgeA, i.e. t ≤ 0).  Among the two roots pick
    // the one with t ≤ 0 that is closest to 0; fall back to smaller |t|.
    let t;
    if (Math.abs(c_coeff) < 1e-8) {
      // Already on the cylinder surface
      t = 0;
    } else if (t1 <= 0 && t2 <= 0) {
      t = t2;                               // less negative (closer to 0)
    } else if (t1 <= 0) {
      t = t1;                               // only negative root
    } else if (t2 <= 0) {
      t = t2;                               // only negative root
    } else {
      t = Math.abs(t1) < Math.abs(t2) ? t1 : t2;  // both positive – pick smaller
    }

    result.push(_vec3Add(p, _vec3Scale(edgeDir, t)));
  }

  return result.length > 0 ? result : null;
}

/**
 * Compute the intersection curve between two cylinders.
 * Returns an array of points approximating the intersection curve.
 */
function _computeCylinderCylinderIntersection(
  axis1Start, axis1End, radius1,
  axis2Start, axis2End, radius2,
  segments
) {
  const axis1Dir = _vec3Normalize(_vec3Sub(axis1End, axis1Start));
  const axis2Dir = _vec3Normalize(_vec3Sub(axis2End, axis2Start));
  
  // Find the intersection plane (perpendicular to the line joining closest points)
  const cross = _vec3Cross(axis1Dir, axis2Dir);
  const crossLen = _vec3Len(cross);
  if (crossLen < 1e-10) return null; // Parallel axes
  
  const planeNormal = _vec3Normalize(cross);
  
  // Find closest points on the two axis lines
  const d = _vec3Sub(axis2Start, axis1Start);
  const a = _vec3Dot(axis1Dir, axis1Dir);
  const b = _vec3Dot(axis1Dir, axis2Dir);
  const c = _vec3Dot(axis2Dir, axis2Dir);
  const e = _vec3Dot(axis1Dir, d);
  const f = _vec3Dot(axis2Dir, d);
  
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-10) return null;
  
  const t1 = (b * f - c * e) / denom;
  const t2 = (a * f - b * e) / denom;
  
  const closest1 = _vec3Add(axis1Start, _vec3Scale(axis1Dir, t1));
  const closest2 = _vec3Add(axis2Start, _vec3Scale(axis2Dir, t2));
  
  // The intersection curve lies on a plane through the midpoint
  const midpoint = _vec3Lerp(closest1, closest2, 0.5);
  
  // Create a local coordinate system on the intersection plane
  const localX = _vec3Normalize(_vec3Sub(closest1, midpoint));
  const localY = _vec3Normalize(_vec3Cross(planeNormal, localX));
  
  // Sample points on both cylinder surfaces in this plane
  const points = [];
  const sumRadii = radius1 + radius2;
  const arcRadius = Math.min(radius1, radius2);
  
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI;
    const x = arcRadius * Math.cos(theta);
    const y = arcRadius * Math.sin(theta);
    const pt = _vec3Add(midpoint, _vec3Add(
      _vec3Scale(localX, x),
      _vec3Scale(localY, y)
    ));
    points.push(pt);
  }
  
  return points;
}

/**
 * Clip old fillet faces that overlap with new fillet regions.
 * When a new fillet passes through an existing fillet surface, the old fillet
 * strip quads in the overlap zone need to be removed or trimmed to avoid
 * creating non-manifold geometry.
 */
function _clipOldFilletFacesInOverlapZone(faces, edgeDataList, radius) {
  if (edgeDataList.length === 0) return;
  
  // Collect new fillet endpoints with tolerance-based proximity checking
  const newFilletEndpoints = [];
  const newFilletEdgeRays = [];
  
  for (const data of edgeDataList) {
    if (!data) continue;
    newFilletEndpoints.push({ ...data.edgeA });
    newFilletEndpoints.push({ ...data.edgeB });
    
    // Store the edge ray for proximity testing
    const dir = _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA));
    const len = _vec3Len(_vec3Sub(data.edgeB, data.edgeA));
    newFilletEdgeRays.push({
      start: data.edgeA,
      end: data.edgeB,
      dir,
      len,
      radius,
    });
  }
  
  const proximityTol = radius * 1.5; // Tolerance for vertex proximity
  
  // Helper to check if a point is near any new fillet endpoint
  const isNearNewFilletEndpoint = (pt) => {
    for (const ep of newFilletEndpoints) {
      if (_vec3Len(_vec3Sub(pt, ep)) < proximityTol) return true;
    }
    return false;
  };
  
  // For each existing fillet face, check if it overlaps with any new fillet edge's
  // cylindrical extent. If so, mark for removal.
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (!face || !face.isFillet) continue;
    
    // Check if any vertex of this face is near a new fillet endpoint
    let hasVertexNearEndpoint = false;
    for (const v of face.vertices) {
      if (isNearNewFilletEndpoint(v)) {
        hasVertexNearEndpoint = true;
        break;
      }
    }
    
    if (!hasVertexNearEndpoint) continue;
    
    // This face has a vertex near a new fillet endpoint
    // Check if the face's centroid is within the new fillet's cylindrical extent
    const centroid = _faceCentroid(face);
    
    for (const ray of newFilletEdgeRays) {
      // Project centroid onto the new fillet edge line
      const toCenter = _vec3Sub(centroid, ray.start);
      const projDist = _vec3Dot(toCenter, ray.dir);
      
      // Clamp to edge bounds
      const clampedProj = Math.max(0, Math.min(ray.len, projDist));
      
      // Compute lateral distance from the edge line
      const projPoint = _vec3Add(ray.start, _vec3Scale(ray.dir, clampedProj));
      const lateral = _vec3Len(_vec3Sub(centroid, projPoint));
      
      // If within the new fillet's cylindrical extent, mark for removal
      if (lateral < ray.radius * 3) {
        face._markedForRemoval = true;
        break;
      }
    }
  }
  
  // Remove marked faces
  for (let fi = faces.length - 1; fi >= 0; fi--) {
    if (faces[fi] && faces[fi]._markedForRemoval) {
      faces.splice(fi, 1);
    }
  }
}

/**
 * Compute offset directions perpendicular to edge, lying on each face plane,
 * pointing into the face interior.
 */
function _computeOffsetDirs(face0, face1, edgeA, edgeB) {
  const n0 = _vec3Normalize(face0.normal);
  const n1 = _vec3Normalize(face1.normal);
  const edgeDir = _vec3Normalize(_vec3Sub(edgeB, edgeA));

  const offsDir0 = _vec3Normalize(_vec3Cross(n0, edgeDir));
  const offsDir1 = _vec3Normalize(_vec3Cross(edgeDir, n1));

  const cen0 = _faceCentroid(face0);
  if (_vec3Dot(offsDir0, _vec3Sub(cen0, edgeA)) < 0) {
    offsDir0.x = -offsDir0.x; offsDir0.y = -offsDir0.y; offsDir0.z = -offsDir0.z;
  }
  const cen1 = _faceCentroid(face1);
  if (_vec3Dot(offsDir1, _vec3Sub(cen1, edgeA)) < 0) {
    offsDir1.x = -offsDir1.x; offsDir1.y = -offsDir1.y; offsDir1.z = -offsDir1.z;
  }
  // Detect concave (reflex) edge: offset into face0 aligns with face1 outward normal
  const isConcave = _vec3Dot(offsDir0, n1) > 1e-6;
  return { offsDir0, offsDir1, edgeDir, isConcave };
}

/**
 * Find the two faces sharing a given edge key. Returns array of {fi, a, b}.
 * Falls back to fuzzy direction+proximity matching when a previous chamfer/fillet
 * has displaced shared vertices so the stored key no longer exactly matches.
 */
function _findAdjacentFaces(faces, edgeKey) {
  // --- exact match ---
  const adj = [];
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      if (_edgeKeyFromVerts(a, b) === edgeKey) {
        adj.push({ fi, a, b });
        break;
      }
    }
    if (adj.length >= 2) break;
  }
  if (adj.length >= 2) return adj;

  const edgeOwnerMap = null; // Added edgeOwnerMap parameter
  // --- fuzzy fallback ---
  const sep = edgeKey.indexOf('|');
  if (sep < 0) return adj;
  const parseV = (s) => { const c = s.split(',').map(Number); return { x: c[0], y: c[1], z: c[2] }; };
  const origA = parseV(edgeKey.slice(0, sep));
  const origB = parseV(edgeKey.slice(sep + 1));
  const origDelta = _vec3Sub(origB, origA);
  const origLen = _vec3Len(origDelta);
  if (origLen < 1e-10) return adj;
  const origDir = _vec3Normalize(origDelta);
  const origMid = { x: (origA.x + origB.x) / 2, y: (origA.y + origB.y) / 2, z: (origA.z + origB.z) / 2 };
  const maxMidDist = origLen * 0.4;

  const candidates = [];
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const d = _vec3Sub(b, a);
      const len = _vec3Len(d);
      if (len < 1e-10) continue;
      if (Math.abs(_vec3Dot(_vec3Normalize(d), origDir)) < 0.95) continue;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
      const midDist = _vec3Len(_vec3Sub(mid, origMid));
      if (midDist > maxMidDist) continue;
      const lenRatio = len / origLen;
      if (lenRatio < 0.3 || lenRatio > 1.5) continue;
      candidates.push({ fi, a, b, score: midDist });
    }
  }

  candidates.sort((x, y) => x.score - y.score);
  const fuzzy = [];
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.fi)) continue;
    fuzzy.push({ fi: c.fi, a: c.a, b: c.b });
    seen.add(c.fi);
    if (fuzzy.length >= 2) break;
  }
  return fuzzy.length >= 2 ? fuzzy : adj;
}

// -----------------------------------------------------------------------
// Chamfer geometry operation
// -----------------------------------------------------------------------

/**
 * Close small boundary-edge loops left by sequential fillet interactions.
 * Detects edges shared by only one face, traces them into closed loops,
 * and triangulates each loop to heal the hole.
 */
function _healBoundaryLoops(faces) {
  // Step 1: Collect all boundary edges with the face that owns them.
  const edgeCounts = new Map(); // edgeKey → count
  const edgeInfo = new Map();   // edgeKey → {fi, a, b}
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const ek = _edgeKeyFromVerts(a, b);
      edgeCounts.set(ek, (edgeCounts.get(ek) || 0) + 1);
      edgeInfo.set(ek + ':' + fi, { fi, a: { ...a }, b: { ...b } });
    }
  }

  const boundaryEdges = [];
  for (const [ek, count] of edgeCounts) {
    if (count !== 1) continue;
    let info = null;
    for (const [key, val] of edgeInfo) {
      if (key.startsWith(ek + ':')) {
        const testEk = _edgeKeyFromVerts(val.a, val.b);
        if (testEk === ek) { info = val; break; }
      }
    }
    if (!info) continue;
    boundaryEdges.push({
      fi: info.fi,
      a: { ...info.a },
      b: { ...info.b },
      vkA: _edgeVKey(info.a),
      vkB: _edgeVKey(info.b),
    });
  }

  if (boundaryEdges.length === 0) return;

  // Step 2: Build an undirected boundary graph so loops still trace when
  // multiple boundary edges leave the same vertex after local rewinding.
  const vertexEdges = new Map();
  for (let ei = 0; ei < boundaryEdges.length; ei++) {
    const edge = boundaryEdges[ei];
    if (!vertexEdges.has(edge.vkA)) vertexEdges.set(edge.vkA, []);
    if (!vertexEdges.has(edge.vkB)) vertexEdges.set(edge.vkB, []);
    vertexEdges.get(edge.vkA).push(ei);
    vertexEdges.get(edge.vkB).push(ei);
  }

  const usedEdges = new Uint8Array(boundaryEdges.length);

  function faceArea(face) {
    const verts = face.vertices || [];
    let area = 0;
    for (let i = 1; i < verts.length - 1; i++) {
      const ab = _vec3Sub(verts[i], verts[0]);
      const ac = _vec3Sub(verts[i + 1], verts[0]);
      area += 0.5 * _vec3Len(_vec3Cross(ab, ac));
    }
    return area;
  }

  function chooseNextEdge(currentVk, previousVk, candidateIndices, localUsed, startVk) {
    let best = -1;
    for (const ei of candidateIndices) {
      if (localUsed.has(ei)) continue;
      const edge = boundaryEdges[ei];
      const otherVk = edge.vkA === currentVk ? edge.vkB : edge.vkA;
      if (otherVk === previousVk && candidateIndices.length > 1) continue;
      if (otherVk === startVk) return ei;
      if (best < 0) best = ei;
    }
    return best;
  }

  // Step 3: Trace closed loops
  for (let startEi = 0; startEi < boundaryEdges.length; startEi++) {
    if (usedEdges[startEi]) continue;

    const startEdge = boundaryEdges[startEi];
    const startVk = startEdge.vkA;
    const loopVerts = [{ ...startEdge.a }];
    const loopEdgeIndices = [startEi];
    const localUsed = new Set([startEi]);
    let previousVk = startEdge.vkA;
    let currentVk = startEdge.vkB;
    let currentPos = { ...startEdge.b };
    let closed = false;

    while (true) {
      loopVerts.push({ ...currentPos });
      if (currentVk === startVk) {
        closed = true;
        break;
      }

      const candidates = vertexEdges.get(currentVk) || [];
      const nextEi = chooseNextEdge(currentVk, previousVk, candidates, localUsed, startVk);
      if (nextEi < 0) break;
      localUsed.add(nextEi);
      loopEdgeIndices.push(nextEi);
      const nextEdge = boundaryEdges[nextEi];
      const nextVk = nextEdge.vkA === currentVk ? nextEdge.vkB : nextEdge.vkA;
      const nextPos = nextEdge.vkA === currentVk ? nextEdge.b : nextEdge.a;
      previousVk = currentVk;
      currentVk = nextVk;
      currentPos = { ...nextPos };
    }

    if (!closed || loopVerts.length < 4) continue;

    loopVerts.pop(); // duplicated start vertex
    for (const ei of loopEdgeIndices) usedEdges[ei] = 1;

    let sameDirCount = 0;
    for (let i = 0; i < loopVerts.length; i++) {
      const edge = boundaryEdges[loopEdgeIndices[i]];
      const fromVk = _edgeVKey(loopVerts[i]);
      const toVk = _edgeVKey(loopVerts[(i + 1) % loopVerts.length]);
      if (edge.vkA === fromVk && edge.vkB === toVk) sameDirCount++;
    }

    let loopNormal = _computePolygonNormal(loopVerts);
    if (!loopNormal) continue;

    // The healing face must run each shared boundary edge in the opposite
    // direction from the existing face that owns it.
    if (sameDirCount > loopVerts.length / 2) {
      loopVerts.reverse();
      loopNormal = _computePolygonNormal(loopVerts);
      if (!loopNormal) continue;
    }

    // Fallback: if the loop walk was ambiguous, align with the dominant
    // coplanar neighboring faces.
    if (sameDirCount * 2 === loopVerts.length) {
      let avgNormal = { x: 0, y: 0, z: 0 };
      for (const ei of loopEdgeIndices) {
        const face = faces[boundaryEdges[ei].fi];
        if (!face || !face.normal) continue;
        const fn = _vec3Normalize(face.normal);
        if (Math.abs(_vec3Dot(fn, loopNormal)) < 0.5) continue;
        const weight = Math.max(1e-6, faceArea(face));
        avgNormal.x += fn.x * weight;
        avgNormal.y += fn.y * weight;
        avgNormal.z += fn.z * weight;
      }
      if (_vec3Len(avgNormal) > 1e-10 && _vec3Dot(loopNormal, avgNormal) < 0) {
        loopVerts.reverse();
        loopNormal = _computePolygonNormal(loopVerts);
        if (!loopNormal) continue;
      }
    }

    // Step 4: Triangulate the loop as a fan from vertex 0
    for (let i = 1; i < loopVerts.length - 1; i++) {
      const triVerts = [{ ...loopVerts[0] }, { ...loopVerts[i] }, { ...loopVerts[i + 1] }];
      const triNormal = _computePolygonNormal(triVerts);
      if (triNormal) {
        faces.push({
          vertices: triVerts,
          normal: triNormal,
          shared: null,
        });
      }
    }
  }
}

function _polygonArea(face) {
  const verts = face.vertices || [];
  let area = 0;
  for (let i = 1; i < verts.length - 1; i++) {
    const ab = _vec3Sub(verts[i], verts[0]);
    const ac = _vec3Sub(verts[i + 1], verts[0]);
    area += 0.5 * _vec3Len(_vec3Cross(ab, ac));
  }
  return area;
}

function _coplanarFaceClusterKey(face, fallbackIndex = 0) {
  if (!face || !face.normal || !Array.isArray(face.vertices) || face.vertices.length < 3) return null;
  const point = face.vertices[0];
  if (!point) return null;
  const normal = _vec3Normalize(face.normal);
  if (_vec3Len(normal) < 1e-10) return null;

  let sign = 1;
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  if (az >= ax && az >= ay) sign = normal.z < 0 ? -1 : 1;
  else if (ay >= ax) sign = normal.y < 0 ? -1 : 1;
  else sign = normal.x < 0 ? -1 : 1;

  const canonicalNormal = {
    x: normal.x * sign,
    y: normal.y * sign,
    z: normal.z * sign,
  };
  const planeDistance = _vec3Dot(canonicalNormal, point);
  const clusterOwner = face.faceGroup ?? fallbackIndex;
  return [
    clusterOwner,
    Math.round(canonicalNormal.x * 1e6),
    Math.round(canonicalNormal.y * 1e6),
    Math.round(canonicalNormal.z * 1e6),
    Math.round(planeDistance * 1e6),
  ].join('|');
}

function _fixOpposedCoplanarFacesInGroups(faces) {
  if (!Array.isArray(faces) || faces.length === 0) return;

  const clusters = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const key = _coplanarFaceClusterKey(faces[fi], fi);
    if (!key) continue;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(fi);
  }

  for (const faceIndices of clusters.values()) {
    if (faceIndices.length < 2) continue;

    let referenceFace = null;
    let referenceArea = -Infinity;
    for (const fi of faceIndices) {
      const area = _polygonArea(faces[fi]);
      if (area > referenceArea) {
        referenceArea = area;
        referenceFace = faces[fi];
      }
    }
    if (!referenceFace || !referenceFace.normal) continue;

    const referenceNormal = _vec3Normalize(referenceFace.normal);
    if (_vec3Len(referenceNormal) < 1e-10) continue;

    for (const fi of faceIndices) {
      const face = faces[fi];
      if (!face || !face.normal) continue;
      if (_vec3Dot(referenceNormal, face.normal) >= 0) continue;
      face.vertices.reverse();
      face.normal = {
        x: -face.normal.x,
        y: -face.normal.y,
        z: -face.normal.z,
      };
    }
  }
}

function _isConvexPlanarPolygon(verts, normal) {
  if (!verts || verts.length < 3 || !normal) return false;
  let sign = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const c = verts[(i + 2) % verts.length];
    const cross = _vec3Cross(_vec3Sub(b, a), _vec3Sub(c, b));
    const turn = _vec3Dot(cross, normal);
    if (Math.abs(turn) < 1e-8) continue;
    const nextSign = turn > 0 ? 1 : -1;
    if (sign === 0) sign = nextSign;
    else if (sign !== nextSign) return false;
  }
  return true;
}

function _projectPolygon2D(verts, normal) {
  const an = {
    x: Math.abs(normal.x),
    y: Math.abs(normal.y),
    z: Math.abs(normal.z),
  };
  if (an.z >= an.x && an.z >= an.y) {
    return verts.map((v) => ({ x: v.x, y: v.y }));
  }
  if (an.y >= an.x) {
    return verts.map((v) => ({ x: v.x, y: v.z }));
  }
  return verts.map((v) => ({ x: v.y, y: v.z }));
}

function _triangulatePlanarPolygon(verts, normal) {
  if (!verts || verts.length < 3) return [];
  if (verts.length === 3) return [verts.map((v) => ({ ...v }))];

  const pts2d = _projectPolygon2D(verts, normal);
  const signedArea = (() => {
    let area = 0;
    for (let i = 0; i < pts2d.length; i++) {
      const a = pts2d[i];
      const b = pts2d[(i + 1) % pts2d.length];
      area += a.x * b.y - b.x * a.y;
    }
    return area * 0.5;
  })();
  const winding = signedArea >= 0 ? 1 : -1;

  function cross2(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function pointInTri(p, a, b, c) {
    const c1 = cross2(a, b, p) * winding;
    const c2 = cross2(b, c, p) * winding;
    const c3 = cross2(c, a, p) * winding;
    return c1 >= -1e-8 && c2 >= -1e-8 && c3 >= -1e-8;
  }

  const remaining = verts.map((_, i) => i);
  const triangles = [];
  let guard = 0;

  while (remaining.length > 3 && guard < verts.length * verts.length) {
    let earFound = false;
    for (let ri = 0; ri < remaining.length; ri++) {
      const prev = remaining[(ri - 1 + remaining.length) % remaining.length];
      const curr = remaining[ri];
      const next = remaining[(ri + 1) % remaining.length];
      const a = pts2d[prev];
      const b = pts2d[curr];
      const c = pts2d[next];
      if (cross2(a, b, c) * winding <= 1e-8) continue;

      let containsPoint = false;
      for (const other of remaining) {
        if (other === prev || other === curr || other === next) continue;
        if (pointInTri(pts2d[other], a, b, c)) {
          containsPoint = true;
          break;
        }
      }
      if (containsPoint) continue;

      triangles.push([
        { ...verts[prev] },
        { ...verts[curr] },
        { ...verts[next] },
      ]);
      remaining.splice(ri, 1);
      earFound = true;
      break;
    }

    if (!earFound) return null;
    guard++;
  }

  if (remaining.length === 3) {
    triangles.push(remaining.map((idx) => ({ ...verts[idx] })));
  }
  return triangles;
}

function _mergeMixedSharedPlanarComponents(faces, includeUniformShared = false) {
  const quantize = (value, digits = 5) => {
    const clamped = Math.abs(value) < 1e-10 ? 0 : value;
    const text = clamped.toFixed(digits);
    return text === '-0.00000' ? '0.00000' : text;
  };

  function planeKey(face) {
    const n = _vec3Normalize(face.normal || { x: 0, y: 0, z: 0 });
    if (_vec3Len(n) < 1e-10 || !face.vertices || face.vertices.length < 3) return null;
    let sign = 1;
    if (Math.abs(n.z) > Math.abs(n.x) && Math.abs(n.z) > Math.abs(n.y)) {
      sign = n.z < 0 ? -1 : 1;
    } else if (Math.abs(n.y) > Math.abs(n.x)) {
      sign = n.y < 0 ? -1 : 1;
    } else {
      sign = n.x < 0 ? -1 : 1;
    }
    const d = _vec3Dot(face.vertices[0], n) * sign;
    return `${quantize(n.x * sign)},${quantize(n.y * sign)},${quantize(n.z * sign)}|${quantize(d)}`;
  }

  const buckets = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (!face || !face.vertices || face.vertices.length < 3) continue;
    if (face.isFillet || face.isCorner) continue;
    const key = planeKey(face);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(fi);
  }

  const replacements = [];
  const removeIndices = new Set();

  for (const indices of buckets.values()) {
    if (indices.length < 2) continue;

    const edgeToFaces = new Map();
    for (const fi of indices) {
      const verts = faces[fi].vertices;
      for (let i = 0; i < verts.length; i++) {
        const ek = _edgeKeyFromVerts(verts[i], verts[(i + 1) % verts.length]);
        if (!edgeToFaces.has(ek)) edgeToFaces.set(ek, []);
        edgeToFaces.get(ek).push(fi);
      }
    }

    const adjacency = new Map();
    for (const fi of indices) adjacency.set(fi, new Set());
    for (const fis of edgeToFaces.values()) {
      if (fis.length < 2) continue;
      for (let i = 0; i < fis.length - 1; i++) {
        for (let j = i + 1; j < fis.length; j++) {
          adjacency.get(fis[i]).add(fis[j]);
          adjacency.get(fis[j]).add(fis[i]);
        }
      }
    }

    const seen = new Set();
    for (const startFi of indices) {
      if (seen.has(startFi)) continue;
      const stack = [startFi];
      const component = [];
      while (stack.length > 0) {
        const fi = stack.pop();
        if (seen.has(fi)) continue;
        seen.add(fi);
        component.push(fi);
        for (const other of adjacency.get(fi) || []) {
          if (!seen.has(other)) stack.push(other);
        }
      }

      if (component.length < 2) continue;

      const sharedValues = new Set(component.map((fi) => faces[fi].shared || null));
      const refFace = faces[component[0]];
      const refNormal = _vec3Normalize(refFace.normal || { x: 0, y: 0, z: 0 });
      const mixedNormals = component.some((fi) => {
        const fn = _vec3Normalize(faces[fi].normal || { x: 0, y: 0, z: 0 });
        return _vec3Len(fn) < 1e-10 || _vec3Dot(fn, refNormal) < 0.999;
      });
      if (!includeUniformShared && sharedValues.size < 2 && !mixedNormals) continue;

      const boundaryEdges = [];
      const componentSet = new Set(component);
      for (const fi of component) {
        const verts = faces[fi].vertices;
        for (let i = 0; i < verts.length; i++) {
          const a = verts[i];
          const b = verts[(i + 1) % verts.length];
          const ek = _edgeKeyFromVerts(a, b);
          const owners = edgeToFaces.get(ek) || [];
          const insideCount = owners.filter((owner) => componentSet.has(owner)).length;
          if (insideCount === 1) {
            boundaryEdges.push({
              fi,
              a: { ...a },
              b: { ...b },
              startKey: _edgeVKey(a),
              endKey: _edgeVKey(b),
            });
          }
        }
      }

      if (boundaryEdges.length < 3) continue;

      const outgoing = new Map();
      const incoming = new Map();
      for (const edge of boundaryEdges) {
        if (outgoing.has(edge.startKey) || incoming.has(edge.endKey)) {
          outgoing.set('__invalid__', true);
          break;
        }
        outgoing.set(edge.startKey, edge);
        incoming.set(edge.endKey, edge);
      }
      if (outgoing.has('__invalid__')) continue;

      let startEdge = boundaryEdges[0];
      for (const edge of boundaryEdges) {
        if (!incoming.has(edge.startKey)) {
          startEdge = edge;
          break;
        }
      }

      const loop = [{ ...startEdge.a }];
      const used = new Set();
      let current = startEdge;
      while (current && !used.has(current.startKey + '|' + current.endKey)) {
        used.add(current.startKey + '|' + current.endKey);
        loop.push({ ...current.b });
        const next = outgoing.get(current.endKey);
        current = next;
        if (current && current.startKey === startEdge.startKey) break;
      }

      if (_edgeVKey(loop[0]) !== _edgeVKey(loop[loop.length - 1])) continue;
      loop.pop();
      if (used.size !== boundaryEdges.length) continue;

      const mergedVerts = _deduplicatePolygon(loop);
      if (mergedVerts.length < 3) continue;

      let mergedNormal = _computePolygonNormal(mergedVerts);
      if (!mergedNormal) continue;
      const template = [...component]
        .map((fi) => faces[fi])
        .sort((a, b) => _polygonArea(b) - _polygonArea(a))[0];
      if (!mixedNormals && _vec3Dot(mergedNormal, refNormal) < 0) {
        mergedVerts.reverse();
        mergedNormal = _computePolygonNormal(mergedVerts);
        if (!mergedNormal) continue;
      }
      if (!_isConvexPlanarPolygon(mergedVerts, mergedNormal)) continue;

      replacements.push({
        component,
        face: {
          ...template,
          vertices: mergedVerts.map((v) => ({ ...v })),
          normal: mergedNormal,
          shared: null,
        },
      });
      for (const fi of component) removeIndices.add(fi);
    }
  }

  if (replacements.length === 0) return;

  const kept = [];
  for (let fi = 0; fi < faces.length; fi++) {
    if (!removeIndices.has(fi)) kept.push(faces[fi]);
  }
  for (const replacement of replacements) kept.push(replacement.face);
  faces.length = 0;
  faces.push(...kept);
}

function _facesSharePlane(faceA, faceB) {
  const na = _vec3Normalize(faceA?.normal || { x: 0, y: 0, z: 0 });
  const nb = _vec3Normalize(faceB?.normal || { x: 0, y: 0, z: 0 });
  if (_vec3Len(na) < 1e-10 || _vec3Len(nb) < 1e-10) return false;
  if (Math.abs(_vec3Dot(na, nb)) < 0.999) return false;
  const planeD = _vec3Dot(faceA.vertices[0], na);
  for (const v of faceB.vertices || []) {
    if (Math.abs(_vec3Dot(v, na) - planeD) > 1e-5) return false;
  }
  return true;
}

function _traceMergedPairLoop(faceA, faceB) {
  const directedEdges = [];
  for (const face of [faceA, faceB]) {
    const verts = face.vertices || [];
    for (let i = 0; i < verts.length; i++) {
      directedEdges.push({
        a: { ...verts[i] },
        b: { ...verts[(i + 1) % verts.length] },
      });
    }
  }

  const counts = new Map();
  for (const edge of directedEdges) {
    const ek = _edgeKeyFromVerts(edge.a, edge.b);
    counts.set(ek, (counts.get(ek) || 0) + 1);
  }

  const boundary = directedEdges
    .filter((edge) => counts.get(_edgeKeyFromVerts(edge.a, edge.b)) === 1)
    .map((edge) => ({
      ...edge,
      startKey: _edgeVKey(edge.a),
      endKey: _edgeVKey(edge.b),
    }));

  if (boundary.length < 3) return null;

  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of boundary) {
    if (outgoing.has(edge.startKey) || incoming.has(edge.endKey)) return null;
    outgoing.set(edge.startKey, edge);
    incoming.set(edge.endKey, edge);
  }

  let start = boundary[0];
  for (const edge of boundary) {
    if (!incoming.has(edge.startKey)) {
      start = edge;
      break;
    }
  }

  const loop = [{ ...start.a }];
  const used = new Set();
  let current = start;
  while (current && !used.has(current.startKey + '|' + current.endKey)) {
    used.add(current.startKey + '|' + current.endKey);
    loop.push({ ...current.b });
    current = outgoing.get(current.endKey);
    if (current && current.startKey === start.startKey) break;
  }

  if (_edgeVKey(loop[0]) !== _edgeVKey(loop[loop.length - 1])) return null;
  loop.pop();
  if (used.size !== boundary.length) return null;

  return _deduplicatePolygon(loop);
}

function _mergeAdjacentCoplanarFacePairs(faces) {
  let changed = true;
  let iterations = 0;
  const maxIterations = Math.max(32, faces.length * 4);
  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;

    const edgeFaces = new Map();
    for (let fi = 0; fi < faces.length; fi++) {
      const face = faces[fi];
      if (!face || !face.vertices || face.vertices.length < 3) continue;
      if (face.isFillet || face.isCorner) continue;
      const verts = face.vertices;
      for (let i = 0; i < verts.length; i++) {
        const ek = _edgeKeyFromVerts(verts[i], verts[(i + 1) % verts.length]);
        if (!edgeFaces.has(ek)) edgeFaces.set(ek, []);
        edgeFaces.get(ek).push(fi);
      }
    }

    outer:
    for (const fis of edgeFaces.values()) {
      if (fis.length !== 2) continue;
      const [fi, fj] = fis;
      const faceA = faces[fi];
      const faceB = faces[fj];
      if (!faceA || !faceB) continue;
      if (!_facesSharePlane(faceA, faceB)) continue;

      const mergedVerts = _traceMergedPairLoop(faceA, faceB);
      if (!mergedVerts || mergedVerts.length < 3) continue;

      let mergedNormal = _computePolygonNormal(mergedVerts);
      if (!mergedNormal) continue;

      const na = _vec3Normalize(faceA.normal || { x: 0, y: 0, z: 0 });
      const nb = _vec3Normalize(faceB.normal || { x: 0, y: 0, z: 0 });
      const sameSense = _vec3Dot(na, nb) > 0.999;
      if (sameSense && _vec3Dot(mergedNormal, na) < 0) {
        mergedVerts.reverse();
        mergedNormal = _computePolygonNormal(mergedVerts);
        if (!mergedNormal) continue;
      }

      const template = _polygonArea(faceA) >= _polygonArea(faceB) ? faceA : faceB;
      const shared = faceA.shared === faceB.shared ? faceA.shared : null;
      let replacementFaces = null;
      if (_isConvexPlanarPolygon(mergedVerts, mergedNormal)) {
        replacementFaces = [{
          ...template,
          vertices: mergedVerts.map((v) => ({ ...v })),
          normal: mergedNormal,
          shared,
        }];
      } else {
        // Only resolve opposite-facing leftovers here. Re-triangulating
        // same-sense concave regions can cause the pass to merge/split forever.
        if (sameSense) continue;
        const tris = _triangulatePlanarPolygon(mergedVerts, mergedNormal);
        if (!tris || tris.length === 0) continue;
        replacementFaces = tris.map((tri) => ({
          ...template,
          vertices: tri,
          normal: mergedNormal,
          shared,
        }));
      }

      faces.splice(Math.max(fi, fj), 1);
      faces.splice(Math.min(fi, fj), 1);
      faces.push(...replacementFaces);
      changed = true;
      break outer;
    }
  }
}

function _collectFaceTopoFaceIds(face) {
  const ids = [];
  if (!face) return ids;
  if (face.topoFaceId !== undefined) ids.push(face.topoFaceId);
  if (Array.isArray(face.topoFaceIds)) {
    for (const topoFaceId of face.topoFaceIds) {
      if (topoFaceId !== undefined) ids.push(topoFaceId);
    }
  }
  return [...new Set(ids)];
}

function _buildRepFaceIndexByTopoFaceId(faces) {
  const repFaceIndexByTopoFaceId = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const topoFaceIds = _collectFaceTopoFaceIds(faces[fi]);
    for (const topoFaceId of topoFaceIds) {
      if (!repFaceIndexByTopoFaceId.has(topoFaceId)) {
        repFaceIndexByTopoFaceId.set(topoFaceId, fi);
      }
    }
  }
  return repFaceIndexByTopoFaceId;
}

function _tracePlanarFaceGroupLoop(faces, faceIndices) {
  const componentVertices = [];
  const seenVertices = new Set();
  for (const fi of faceIndices) {
    const face = faces[fi];
    const verts = face && Array.isArray(face.vertices) ? face.vertices : [];
    for (const vertex of verts) {
      const key = _edgeVKey(vertex);
      if (seenVertices.has(key)) continue;
      seenVertices.add(key);
      componentVertices.push({ ...vertex });
    }
  }

  const directedEdges = [];
  const edgeCounts = new Map();

  for (const fi of faceIndices) {
    const face = faces[fi];
    const verts = face && Array.isArray(face.vertices) ? face.vertices : [];
    if (verts.length < 3) continue;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const splitPoints = [{ ...a }, { ...b }];
      for (const vertex of componentVertices) {
        const key = _edgeVKey(vertex);
        if (key === _edgeVKey(a) || key === _edgeVKey(b)) continue;
        if (pointOnSegmentStrict(vertex, a, b)) splitPoints.push({ ...vertex });
      }

      const edgeDir = _vec3Sub(b, a);
      const edgeLenSq = _vec3Dot(edgeDir, edgeDir);
      if (edgeLenSq < 1e-12) continue;
      splitPoints.sort((p0, p1) => {
        const t0 = _vec3Dot(_vec3Sub(p0, a), edgeDir) / edgeLenSq;
        const t1 = _vec3Dot(_vec3Sub(p1, a), edgeDir) / edgeLenSq;
        return t0 - t1;
      });

      const uniquePoints = [];
      for (const point of splitPoints) {
        if (uniquePoints.length === 0 || _edgeVKey(uniquePoints[uniquePoints.length - 1]) !== _edgeVKey(point)) {
          uniquePoints.push(point);
        }
      }

      for (let pi = 1; pi < uniquePoints.length; pi++) {
        const start = uniquePoints[pi - 1];
        const end = uniquePoints[pi];
        if (_edgeVKey(start) === _edgeVKey(end)) continue;
        const key = _edgeKeyFromVerts(start, end);
        edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
        directedEdges.push({
          a: { ...start },
          b: { ...end },
          key,
          startKey: _edgeVKey(start),
          endKey: _edgeVKey(end),
        });
      }
    }
  }

  const boundaryEdges = directedEdges.filter((edge) => edgeCounts.get(edge.key) === 1);
  if (boundaryEdges.length < 3) return null;

  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of boundaryEdges) {
    if (outgoing.has(edge.startKey) || incoming.has(edge.endKey)) return null;
    outgoing.set(edge.startKey, edge);
    incoming.set(edge.endKey, edge);
  }

  let startEdge = boundaryEdges[0];
  for (const edge of boundaryEdges) {
    if (!incoming.has(edge.startKey)) {
      startEdge = edge;
      break;
    }
  }

  const loop = [{ ...startEdge.a }];
  const used = new Set();
  let current = startEdge;
  while (current && !used.has(`${current.startKey}|${current.endKey}`)) {
    used.add(`${current.startKey}|${current.endKey}`);
    loop.push({ ...current.b });
    current = outgoing.get(current.endKey);
    if (current && current.startKey === startEdge.startKey) break;
  }

  if (_edgeVKey(loop[0]) !== _edgeVKey(loop[loop.length - 1])) return null;
  loop.pop();
  if (used.size !== boundaryEdges.length) return null;

  const mergedVerts = _deduplicatePolygon(loop);
  return mergedVerts.length >= 3 ? mergedVerts : null;
}

function _mergeCoplanarNonManifoldComponents(faces) {
  if (!Array.isArray(faces) || faces.length === 0) return;

  assignCoplanarFaceGroups(faces);

  const edgeToFaces = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    const verts = face && Array.isArray(face.vertices) ? face.vertices : [];
    if (verts.length < 3) continue;
    for (let vi = 0; vi < verts.length; vi++) {
      const key = _edgeKeyFromVerts(verts[vi], verts[(vi + 1) % verts.length]);
      if (!edgeToFaces.has(key)) edgeToFaces.set(key, []);
      edgeToFaces.get(key).push(fi);
    }
  }

  const candidateGroups = new Map();
  for (const faceIndices of edgeToFaces.values()) {
    if (faceIndices.length <= 2) continue;
    for (const fi of faceIndices) {
      const face = faces[fi];
      if (!face || face.isFillet || face.isCorner) continue;
      if (face.surfaceType !== SurfaceType.PLANE) continue;
      const groupKey = face.faceGroup != null ? face.faceGroup : fi;
      if (!candidateGroups.has(groupKey)) candidateGroups.set(groupKey, new Set());
      candidateGroups.get(groupKey).add(fi);
    }
  }

  if (candidateGroups.size === 0) return;

  const removeIndices = new Set();
  const replacements = [];
  for (const groupFaceSet of candidateGroups.values()) {
    const faceIndices = [...groupFaceSet].sort((a, b) => a - b);
    if (faceIndices.length < 2) continue;

    const mergedVerts = _tracePlanarFaceGroupLoop(faces, faceIndices);
    if (!mergedVerts || mergedVerts.length < 3) continue;

    let mergedNormal = _computePolygonNormal(mergedVerts);
    if (!mergedNormal) continue;

    const componentFaces = faceIndices.map((fi) => faces[fi]).filter(Boolean);
    const template = [...componentFaces].sort((a, b) => _polygonArea(b) - _polygonArea(a))[0];
    if (!template) continue;

    const templateNormal = _vec3Normalize(template.normal || { x: 0, y: 0, z: 0 });
    if (_vec3Len(templateNormal) >= 1e-10 && _vec3Dot(mergedNormal, templateNormal) < 0) {
      mergedVerts.reverse();
      mergedNormal = _computePolygonNormal(mergedVerts);
      if (!mergedNormal) continue;
    }

    const topoFaceIds = [...new Set(faceIndices.flatMap((fi) => _collectFaceTopoFaceIds(faces[fi])))];
    const sharedSignatures = new Set(faceIndices.map((fi) => _sharedMetadataSignature(faces[fi].shared)));
    const buildReplacement = (vertices) => {
      const replacement = {
        ...template,
        vertices: vertices.map((vertex) => ({ ...vertex })),
        normal: mergedNormal,
        shared: sharedSignatures.size === 1 && template.shared ? { ...template.shared } : null,
        topoFaceId: topoFaceIds.length === 1 ? topoFaceIds[0] : undefined,
      };
      if (topoFaceIds.length > 1) replacement.topoFaceIds = topoFaceIds;
      else if (topoFaceIds.length === 1) replacement.topoFaceIds = [topoFaceIds[0]];
      return replacement;
    };

    const replacementFaces = _isConvexPlanarPolygon(mergedVerts, mergedNormal)
      ? [buildReplacement(mergedVerts)]
      : (_triangulatePlanarPolygon(mergedVerts, mergedNormal) || []).map((tri) => buildReplacement(tri));
    if (replacementFaces.length === 0) continue;

    for (const fi of faceIndices) removeIndices.add(fi);
    replacements.push(...replacementFaces);
  }

  if (replacements.length === 0) return;

  const keptFaces = [];
  for (let fi = 0; fi < faces.length; fi++) {
    if (!removeIndices.has(fi)) keptFaces.push(faces[fi]);
  }
  keptFaces.push(...replacements);
  faces.length = 0;
  faces.push(...keptFaces);
}

function _sharedMetadataSignature(shared) {
  if (!shared) return '__null__';
  const keys = Object.keys(shared).sort();
  return JSON.stringify(shared, keys);
}

function _compactExactPlanarDisplayFaces(inputFaces) {
  if (!Array.isArray(inputFaces) || inputFaces.length < 2) {
    return Array.isArray(inputFaces) ? inputFaces : [];
  }

  const faces = inputFaces.map((face) => ({
    ...face,
    vertices: Array.isArray(face.vertices) ? face.vertices.map((vertex) => ({ ...vertex })) : [],
    normal: face.normal ? { ...face.normal } : face.normal,
    shared: face.shared ? { ...face.shared } : null,
    topoFaceIds: Array.isArray(face.topoFaceIds) ? [...face.topoFaceIds] : face.topoFaceIds,
    vertexNormals: Array.isArray(face.vertexNormals)
      ? face.vertexNormals.map((normal) => (normal ? { ...normal } : normal))
      : face.vertexNormals,
  }));

  _fixTJunctions(faces);
  _weldVertices(faces);
  _removeDegenerateFaces(faces);
  _mergeAdjacentCoplanarFacePairs(faces);
  computeFeatureEdges(faces);

  const groups = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (!face || !Array.isArray(face.vertices) || face.vertices.length < 3) continue;
    if (face.isCurved || face.isFillet || face.isCorner) continue;
    if (face.faceType && !face.faceType.startsWith('planar')) continue;
    const groupKey = face.faceGroup != null ? face.faceGroup : fi;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(fi);
  }

  const removeIndices = new Set();
  const replacements = [];
  for (const faceIndices of groups.values()) {
    if (faceIndices.length < 2) continue;

    const mergedVerts = _tracePlanarFaceGroupLoop(faces, faceIndices);
    if (!mergedVerts) continue;

    let mergedNormal = _computePolygonNormal(mergedVerts);
    if (!mergedNormal) continue;

    const componentFaces = faceIndices.map((fi) => faces[fi]).filter(Boolean);
    const template = [...componentFaces].sort((a, b) => _polygonArea(b) - _polygonArea(a))[0];
    if (!template) continue;

    const templateNormal = _vec3Normalize(template.normal || { x: 0, y: 0, z: 0 });
    if (_vec3Len(templateNormal) >= 1e-10 && _vec3Dot(mergedNormal, templateNormal) < 0) {
      mergedVerts.reverse();
      mergedNormal = _computePolygonNormal(mergedVerts);
      if (!mergedNormal) continue;
    }

    const topoFaceIds = [...new Set(faceIndices.flatMap((fi) => _collectFaceTopoFaceIds(faces[fi])))];
    const sharedSignatures = new Set(faceIndices.map((fi) => _sharedMetadataSignature(faces[fi].shared)));
    const replacement = {
      ...template,
      vertices: mergedVerts.map((vertex) => ({ ...vertex })),
      normal: mergedNormal,
      shared: sharedSignatures.size === 1 && template.shared ? { ...template.shared } : null,
      topoFaceId: topoFaceIds.length === 1 ? topoFaceIds[0] : undefined,
    };
    if (topoFaceIds.length > 1) replacement.topoFaceIds = topoFaceIds;
    else if (topoFaceIds.length === 1) replacement.topoFaceIds = [topoFaceIds[0]];

    replacements.push(replacement);
    for (const fi of faceIndices) removeIndices.add(fi);
  }

  if (replacements.length === 0) {
    return faces;
  }

  const compactedFaces = [];
  for (let fi = 0; fi < faces.length; fi++) {
    if (!removeIndices.has(fi)) compactedFaces.push(faces[fi]);
  }
  compactedFaces.push(...replacements);

  _weldVertices(compactedFaces);
  _removeDegenerateFaces(compactedFaces);
  _recomputeFaceNormals(compactedFaces);
  return compactedFaces;
}

// Weld vertices that map to the same rounded key so seam duplicates are eliminated
function _weldVertices(faces) {
  const canon = new Map();
  for (const f of faces) {
    for (let i = 0; i < f.vertices.length; i++) {
      const v = f.vertices[i];
      const key = _edgeVKey(v);
      if (canon.has(key)) {
        const c = canon.get(key);
        f.vertices[i] = { x: c.x, y: c.y, z: c.z };
      } else {
        canon.set(key, { x: v.x, y: v.y, z: v.z });
      }
    }
  }
}

function _removeDegenerateFaces(faces) {
  for (let i = faces.length - 1; i >= 0; i--) {
    const face = faces[i];
    const cleaned = _deduplicatePolygon(face.vertices || []);
    if (cleaned.length < 3) {
      faces.splice(i, 1);
      continue;
    }
    const normal = _computePolygonNormal(cleaned);
    if (!normal) {
      faces.splice(i, 1);
      continue;
    }
    face.vertices = cleaned;
  }
}

/**
 * Recompute face normals using the Newell method for correctness after
 * vertex modifications (trimming, splitting). The Newell method sums
 * cross products of consecutive edge pairs and works correctly for both
 * convex and concave polygons.
 */
function _recomputeFaceNormals(faces) {
  for (const face of faces) {
    const verts = face.vertices;
    if (verts.length < 3) continue;
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < verts.length; i++) {
      const curr = verts[i];
      const next = verts[(i + 1) % verts.length];
      nx += (curr.y - next.y) * (curr.z + next.z);
      ny += (curr.z - next.z) * (curr.x + next.x);
      nz += (curr.x - next.x) * (curr.y + next.y);
    }
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-10) {
      face.normal = { x: nx / len, y: ny / len, z: nz / len };
    }
  }
}

/**
 * Triangulate concave polygon faces (>4 vertices) using CDT so that
 * renderers don't produce self-intersecting fan triangulations.
 * Operates in-place on the faces array by splicing N-gons into triangles.
 */
function _triangulateConcaveFaces(faces) {
  for (let fi = faces.length - 1; fi >= 0; fi--) {
    const face = faces[fi];
    if (face.vertices.length <= 4) continue;
    const norm = face.normal;
    if (!norm || _vec3Len(norm) < 1e-10) continue;
    // Build 2D projection frame
    let ax;
    if (Math.abs(norm.x) < 0.9) ax = { x: 1, y: 0, z: 0 };
    else ax = { x: 0, y: 1, z: 0 };
    const uAxis = _vec3Normalize(_vec3Cross(norm, ax));
    const vAxis = _vec3Cross(norm, uAxis);
    const origin = face.vertices[0];
    const pts2D = face.vertices.map(v => ({
      x: _vec3Dot(_vec3Sub(v, origin), uAxis),
      y: _vec3Dot(_vec3Sub(v, origin), vAxis),
    }));
    // Ensure CCW winding for CDT
    let area2 = 0;
    for (let i = 0; i < pts2D.length; i++) {
      const j = (i + 1) % pts2D.length;
      area2 += pts2D[i].x * pts2D[j].y - pts2D[j].x * pts2D[i].y;
    }
    if (area2 < 0) { pts2D.reverse(); face.vertices.reverse(); }
    try {
      const tris = constrainedTriangulate(pts2D);
      if (tris.length === 0) continue;
      const newFaces = tris.map(([a, b, c]) => ({
        vertices: [{ ...face.vertices[a] }, { ...face.vertices[b] }, { ...face.vertices[c] }],
        normal: { ...face.normal },
        shared: face.shared ? { ...face.shared } : null,
        isFillet: face.isFillet || false,
        isCorner: face.isCorner || false,
        faceGroup: face.faceGroup,
        topoFaceId: face.topoFaceId,
      }));
      faces.splice(fi, 1, ...newFaces);
    } catch (_e) {
      // CDT failed — keep original face
    }
  }
}

/**
 * Fix winding consistency across all faces using BFS propagation from a seed
 * face, then verify outward orientation via signed volume.  When 3+ chamfer/
 * fillet edges meet at a vertex, the independently-generated bevel faces may
 * have winding that conflicts with the trimmed original faces.  This function
 * detects and corrects such conflicts.
 */
function _fixWindingConsistency(faces) {
  if (faces.length === 0) return;

  // Build edge → face adjacency (directed edge → face index + direction)
  const edgeToFaces = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const ka = _edgeVKey(a), kb = _edgeVKey(b);
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const fwd = ka < kb;
      if (!edgeToFaces.has(ek)) edgeToFaces.set(ek, []);
      edgeToFaces.get(ek).push({ fi, fwd });
    }
  }

  // Check if any winding errors exist
  let hasErrors = false;
  for (const [, entries] of edgeToFaces) {
    if (entries.length === 2 && entries[0].fwd === entries[1].fwd) {
      hasErrors = true;
      break;
    }
  }
  if (!hasErrors) return;

  // BFS from face 0 to propagate consistent winding.
  // flipped[fi] tracks whether face fi needs to be reversed.
  // When checking a neighbor, we must account for the current face's flip
  // state: if the current face is flipped, its effective edge direction is
  // the opposite of the original stored direction.
  const flipped = new Uint8Array(faces.length);
  const visited = new Uint8Array(faces.length);
  const queue = [0];
  visited[0] = 1;

  while (queue.length > 0) {
    const fi = queue.shift();
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const ka = _edgeVKey(a), kb = _edgeVKey(b);
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const myOrigFwd = ka < kb;
      const neighbors = edgeToFaces.get(ek);
      if (!neighbors) continue;
      // Effective direction of this edge for the current face
      const myEffectiveFwd = flipped[fi] ? !myOrigFwd : myOrigFwd;
      for (const nb of neighbors) {
        if (nb.fi === fi || visited[nb.fi]) continue;
        visited[nb.fi] = 1;
        // Consistent winding: neighbor's effective direction must be OPPOSITE
        // If neighbor's original fwd matches our effective fwd, it needs flipping
        if (nb.fwd === myEffectiveFwd) {
          flipped[nb.fi] = 1;
        }
        queue.push(nb.fi);
      }
    }
  }

  // Apply flips
  for (let fi = 0; fi < faces.length; fi++) {
    if (flipped[fi]) {
      faces[fi].vertices.reverse();
      const n = faces[fi].normal;
      faces[fi].normal = { x: -n.x, y: -n.y, z: -n.z };
    }
  }

  // Verify outward orientation via signed volume
  let signedVol = 0;
  for (const face of faces) {
    const verts = face.vertices;
    if (verts.length < 3) continue;
    const v0 = verts[0];
    for (let i = 1; i < verts.length - 1; i++) {
      const v1 = verts[i], v2 = verts[i + 1];
      signedVol += (
        v0.x * (v1.y * v2.z - v2.y * v1.z) -
        v1.x * (v0.y * v2.z - v2.y * v0.z) +
        v2.x * (v0.y * v1.z - v1.y * v0.z)
      );
    }
  }
  if (signedVol < 0) {
    // All normals point inward — flip everything
    for (const face of faces) {
      face.vertices.reverse();
      const n = face.normal;
      face.normal = { x: -n.x, y: -n.y, z: -n.z };
    }
  }
}

export function applyChamfer(geometry, edgeKeys, distance) {
  if (!geometry || !geometry.faces || edgeKeys.length === 0 || distance <= 0) {
    return geometry;
  }

  const baseFaces = _extractFeatureFacesFromTopoBody(geometry);
  const exactAdjacencyByKey = _buildExactEdgeAdjacencyLookupFromTopoBody(
    geometry.topoBody,
    baseFaces,
  );
  let faces = baseFaces.map(f => ({
    vertices: f.vertices.map(v => ({ ...v })),
    normal: { ...f.normal },
    shared: f.shared ? { ...f.shared } : null,
    isFillet: f.isFillet || false,
    faceGroup: f.faceGroup,
    topoFaceId: f.topoFaceId,
  }));

  // Save original face vertices for corner-face generation
  const origFaces = faces.map(f => ({
    vertices: f.vertices.map(v => ({ ...v })),
    normal: { ...f.normal },
  }));

  // --- Phase 1: Pre-compute all edge data on the ORIGINAL geometry ---
  const uniqueKeys = [...new Set(edgeKeys)];
  const edgeDataList = [];
  for (const ek of uniqueKeys) {
    const data = _precomputeChamferEdge(faces, ek, distance, exactAdjacencyByKey);
    if (data) edgeDataList.push(data);
  }

  if (edgeDataList.length === 0) return geometry;

  // --- Phase 2: Build vertex-sharing map ---
  const vertexEdgeMap = _buildVertexEdgeMap(edgeDataList);

  // --- Phase 2.5: Merge shared-vertex positions on common faces ---
  // When 2+ chamfer edges meet at a vertex and share a common face, combine
  // their independent offsets into a single merged position that lies at the
  // intersection of the bevel planes on the face, eliminating the gap that
  // would otherwise require a corner face.
  _mergeSharedVertexPositions(edgeDataList, vertexEdgeMap);

  // --- Phase 3: Apply batch face trimming ---
  _batchTrimFaces(faces, edgeDataList);

  // --- Phase 4: Batch split vertices at endpoints ---
  _batchSplitVertices(faces, edgeDataList, vertexEdgeMap);

  // --- Phase 5: Generate all bevel faces + NURBS definitions ---
  const brep = new BRep();

  // Add BRep faces for existing trimmed faces (no NURBS — they are planar)
  for (const face of faces) {
    const brepFace = new BRepFace(null, 'planar', face.shared);
    brep.addFace(brepFace);
  }

  for (const data of edgeDataList) {
    const chamferNormal = _vec3Normalize(_vec3Cross(
      _vec3Sub(data.p1a, data.p0a), _vec3Sub(data.p1b, data.p0a)
    ));

    const meshFace = {
      vertices: [{ ...data.p0a }, { ...data.p1a }, { ...data.p1b }, { ...data.p0b }],
      normal: chamferNormal,
      shared: data.shared,
      _isChamferBevel: true,
    };
    faces.push(meshFace);

    // Create NURBS surface for the chamfer bevel (bilinear planar patch)
    const nurbsSurface = NurbsSurface.createChamferSurface(
      data.p0a, data.p0b, data.p1a, data.p1b
    );
    const brepFace = new BRepFace(nurbsSurface, 'chamfer', data.shared);

    // Add BRep edge curves (straight lines for chamfer trim edges)
    const edge0 = new BRepEdge(
      new BRepVertex(data.p0a), new BRepVertex(data.p0b),
      NurbsCurve.createLine(data.p0a, data.p0b)
    );
    const edge1 = new BRepEdge(
      new BRepVertex(data.p1a), new BRepVertex(data.p1b),
      NurbsCurve.createLine(data.p1a, data.p1b)
    );
    brep.addEdge(edge0);
    brep.addEdge(edge1);
    brep.addFace(brepFace);
  }

  // --- Phase 6: Generate corner faces at shared vertices ---
  _generateCornerFaces(faces, origFaces, edgeDataList, vertexEdgeMap);

  _fixTJunctions(faces);
  _healBoundaryLoops(faces);
  _weldVertices(faces);
  _removeDegenerateFaces(faces);
  _mergeMixedSharedPlanarComponents(faces);
  _mergeAdjacentCoplanarFacePairs(faces);
  _fixTJunctions(faces);
  _healBoundaryLoops(faces);
  _weldVertices(faces);
  _removeDegenerateFaces(faces);
  _recomputeFaceNormals(faces);
  _triangulateConcaveFaces(faces);

  // --- Phase 7: Attempt exact topology promotion ---
  try {
    const topoBody = _buildExactChamferTopoBody(faces, edgeDataList);
    if (topoBody) {
      const exactGeometry = tessellateBody(topoBody);
      exactGeometry.topoBody = topoBody;
      exactGeometry.brep = brep;
      const edgeResult = computeFeatureEdges(exactGeometry.faces || []);
      exactGeometry.edges = edgeResult.edges;
      exactGeometry.paths = edgeResult.paths;
      exactGeometry.visualEdges = edgeResult.visualEdges;
      const meshUsage = _countMeshEdgeUsage(exactGeometry.faces || []);
      if (meshUsage.boundaryCount === 0 && meshUsage.nonManifoldCount === 0) {
        return exactGeometry;
      }
    }
  } catch (exactErr) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('Exact chamfer topology promotion skipped:', exactErr.message);
    }
  }

  const newGeom = { vertices: [], faces, brep };
  const edgeResult = computeFeatureEdges(faces);
  newGeom.edges = edgeResult.edges;
  newGeom.paths = edgeResult.paths;
  newGeom.visualEdges = edgeResult.visualEdges;
  return newGeom;
}

/**
 * Build a TopoBody from mesh-level chamfer results.
 * Collects planar face descriptors from trimmed faces, chamfer bevel
 * face descriptors from edgeDataList, and corner face descriptors.
 */
function _buildExactChamferTopoBody(faces, edgeDataList) {
  if (!faces || !Array.isArray(faces) || !edgeDataList || edgeDataList.length === 0) return null;

  const faceDescs = [];

  // Planar trimmed faces (original faces after trimming)
  // Bevel and corner faces are appended at the tail of the faces array —
  // the first (faces.length - bevelCount - cornerCount) faces are the originals.
  // To distinguish, skip faces that are chamfer bevel quads or corner faces.
  for (const face of faces) {
    if (!face || !face.vertices || face.vertices.length < 3) continue;
    // Skip bevel faces (they are added below from edgeDataList)
    if (face._isChamferBevel) continue;
    // Skip corner faces (handled separately)
    if (face.isCorner) continue;
    const desc = _buildPlanarFaceDesc(face);
    if (!desc) return null;
    faceDescs.push(desc);
  }

  // Chamfer bevel faces
  for (const data of edgeDataList) {
    let surface = null;
    try {
      surface = NurbsSurface.createChamferSurface(data.p0a, data.p0b, data.p1a, data.p1b);
    } catch (_) {
      surface = null;
    }

    const vertices = [
      { ...data.p0a }, { ...data.p1a }, { ...data.p1b }, { ...data.p0b },
    ];
    const edgeCurves = [
      NurbsCurve.createLine(data.p0a, data.p1a),
      NurbsCurve.createLine(data.p1a, data.p1b),
      NurbsCurve.createLine(data.p1b, data.p0b),
      NurbsCurve.createLine(data.p0b, data.p0a),
    ];

    const polyNormal = _computePolygonNormal(vertices);
    let sameSense = true;
    if (surface && polyNormal) {
      const surfNormal = surface.normal(0.5, 0.5);
      if (surfNormal) sameSense = _vec3Dot(polyNormal, surfNormal) >= 0;
    }

    faceDescs.push({
      surface,
      surfaceType: surface ? SurfaceType.PLANE : SurfaceType.PLANE,
      vertices,
      edgeCurves,
      sameSense,
      shared: data.shared ? { ...data.shared, isChamfer: true } : { isChamfer: true },
    });
  }

  // Corner face descriptors
  for (const face of faces) {
    if (!face || !face.isCorner) continue;
    if (!face.vertices || face.vertices.length < 3) continue;
    const desc = _buildPlanarFaceDesc(face);
    if (desc) faceDescs.push(desc);
  }

  if (faceDescs.length === 0) return null;
  return buildTopoBody(faceDescs);
}

// -----------------------------------------------------------------------
// BRep-level chamfer — operates directly on TopoBody topology
// -----------------------------------------------------------------------

/**
 * Map mesh-level edge keys (from tessellated segments) to their parent TopoEdges.
 * Returns Map<meshEdgeKey, TopoEdge>.
 */
function _mapSegmentKeysToTopoEdges(topoBody, edgeSegments = 16) {
  const map = new Map();
  const allEdgeSamples = [];
  for (const shell of topoBody.shells) {
    for (const topoEdge of shell.edges()) {
      const samples = _sampleExactEdgePoints(topoEdge, edgeSegments);
      if (samples.length < 2) continue;
      allEdgeSamples.push({ topoEdge, samples });
      // Register the full-endpoint key
      const fullKey = _edgeKeyFromVerts(
        topoEdge.startVertex.point, topoEdge.endVertex.point
      );
      map.set(fullKey, topoEdge);
      // Register each tessellated segment key
      for (let i = 0; i < samples.length - 1; i++) {
        map.set(_edgeKeyFromVerts(samples[i], samples[i + 1]), topoEdge);
      }
    }
  }
  map._allEdgeSamples = allEdgeSamples;
  return map;
}

/**
 * Proximity-based fallback: for each unmatched edge key, parse the two
 * endpoints and find the TopoEdge whose polyline tessellation is closest
 * to the midpoint of the key segment.
 */
function _proximityMatchEdgeKeys(unmatchedKeys, allEdgeSamples, chamferTopoEdges) {
  if (!allEdgeSamples || allEdgeSamples.length === 0) return;
  // Proximity tolerance: the stored edge keys are at approximately arc-length
  // uniform positions, while BRep tessellation uses NURBS parametric sampling.
  // The resulting position differences are typically ~0.005-0.015 units for a
  // radius-10 arc at 16 segments.  0.05 gives ample headroom without risking
  // false positives between edges that are at least one arc-radius apart.
  const tol = 0.05;
  for (const key of unmatchedKeys) {
    const sep = key.indexOf('|');
    if (sep < 0) continue;
    const aCoords = key.slice(0, sep).split(',').map(Number);
    const bCoords = key.slice(sep + 1).split(',').map(Number);
    if (aCoords.length !== 3 || bCoords.length !== 3) continue;
    const mid = {
      x: (aCoords[0] + bCoords[0]) * 0.5,
      y: (aCoords[1] + bCoords[1]) * 0.5,
      z: (aCoords[2] + bCoords[2]) * 0.5,
    };
    let bestEdge = null, bestDist = Infinity;
    for (const { topoEdge, samples } of allEdgeSamples) {
      for (let i = 0; i < samples.length - 1; i++) {
        const s0 = samples[i], s1 = samples[i + 1];
        // point-to-segment distance (project mid onto segment s0→s1)
        const dx = s1.x - s0.x, dy = s1.y - s0.y, dz = s1.z - s0.z;
        const lenSq = dx * dx + dy * dy + dz * dz;
        let t = 0;
        if (lenSq > 1e-20) {
          t = ((mid.x - s0.x) * dx + (mid.y - s0.y) * dy + (mid.z - s0.z) * dz) / lenSq;
          if (t < 0) t = 0; else if (t > 1) t = 1;
        }
        const px = s0.x + t * dx, py = s0.y + t * dy, pz = s0.z + t * dz;
        const d = Math.sqrt((mid.x - px) ** 2 + (mid.y - py) ** 2 + (mid.z - pz) ** 2);
        if (d < bestDist) { bestDist = d; bestEdge = topoEdge; }
      }
    }
    if (bestEdge && bestDist < tol) {
      chamferTopoEdges.set(bestEdge.id, bestEdge);
    }
  }
}

function _countTopoBodyBoundaryEdges(topoBody) {
  if (!topoBody?.shells) return Infinity;
  const edgeRefs = new Map();
  for (const shell of topoBody.shells) {
    for (const face of shell.faces) {
      for (const loop of face.allLoops()) {
        for (const coedge of loop.coedges) {
          edgeRefs.set(coedge.edge.id, (edgeRefs.get(coedge.edge.id) || 0) + 1);
        }
      }
    }
  }
  let boundaryEdges = 0;
  for (const count of edgeRefs.values()) {
    if (count < 2) boundaryEdges++;
  }
  return boundaryEdges;
}

function _getCoedgeEdgePoints(coedge) {
  const sameSense = coedge?.sameSense !== false;
  return {
    start: sameSense ? coedge.edge.startVertex.point : coedge.edge.endVertex.point,
    end: sameSense ? coedge.edge.endVertex.point : coedge.edge.startVertex.point,
  };
}

function _intersectPlanarOffsetWithNeighbor(coedge, origin, uAxis, vAxis, targetV, nearPoint) {
  if (!coedge?.edge) return null;

  const { start, end } = _getCoedgeEdgePoints(coedge);
  const toUV = (point) => {
    const delta = _vec3Sub(point, origin);
    return {
      x: _vec3Dot(delta, uAxis),
      y: _vec3Dot(delta, vAxis),
    };
  };
  const fromUV = (x, y) => _vec3Add(origin, _vec3Add(_vec3Scale(uAxis, x), _vec3Scale(vAxis, y)));

  const curve = coedge.edge.curve;
  if (curve && curve.degree === 2 && curve.controlPoints.length >= 3) {
    const center = _recoverArcCenter(curve, start, end);
    if (center) {
      const centerUV = toUV(center);
      const radius = _vec3Len(_vec3Sub(start, center));
      const dy = targetV - centerUV.y;
      const inside = radius * radius - dy * dy;
      if (inside >= -1e-8) {
        const dx = Math.sqrt(Math.max(0, inside));
        const candidates = [
          fromUV(centerUV.x - dx, targetV),
          fromUV(centerUV.x + dx, targetV),
        ];
        candidates.sort((a, b) => _vec3Len(_vec3Sub(a, nearPoint)) - _vec3Len(_vec3Sub(b, nearPoint)));
        return candidates[0];
      }
    }
  }

  const startUV = toUV(start);
  const endUV = toUV(end);
  const dy = endUV.y - startUV.y;
  if (Math.abs(dy) < 1e-10) return null;
  const t = (targetV - startUV.y) / dy;
  const x = startUV.x + t * (endUV.x - startUV.x);
  return fromUV(x, targetV);
}

/**
 * Compute the offset curve of a TopoEdge on a given adjacent face.
 *
 * Returns { curve: NurbsCurve, startPt: {x,y,z}, endPt: {x,y,z} }
 * where curve runs from startPt to endPt at distance `dist` from the edge
 * into the face surface.
 */
function _offsetEdgeOnSurface(topoEdge, face, coedge, dist) {
  const sType = face.surfaceType;
  const oriented = coedge ? _getCoedgeEdgePoints(coedge) : {
    start: topoEdge.startVertex.point,
    end: topoEdge.endVertex.point,
  };
  const sp = oriented.start;
  const ep = oriented.end;
  const edgeVec = _vec3Sub(ep, sp);
  const edgeLen = _vec3Len(edgeVec);
  const edgeDir = edgeLen > 1e-14 ? _vec3Scale(edgeVec, 1 / edgeLen) : { x: 1, y: 0, z: 0 };

  if (sType === SurfaceType.PLANE) {
    // Get face normal from evaluation or from surface
    let faceNormal;
    if (face.surface && typeof face.surface.normal === 'function') {
      faceNormal = face.surface.normal(0.5, 0.5);
      if (face.sameSense === false) faceNormal = _vec3Scale(faceNormal, -1);
    } else {
      // Approximate from boundary vertices
      const verts = [];
      for (const ce of face.outerLoop.coedges) {
        verts.push(ce.edge.startVertex.point);
      }
      faceNormal = _computePolygonNormal(verts) || { x: 0, y: 0, z: 1 };
    }
    faceNormal = _vec3Normalize(faceNormal);

    // Offset direction: cross(faceNormal, edgeDir) pointing into the face
    let offDir = _vec3Normalize(_vec3Cross(faceNormal, edgeDir));
    // Ensure offDir points into the face (toward face centroid)
    const centroid = _faceCentroid(face);
    const edgeMid = _vec3Lerp(sp, ep, 0.5);
    if (_vec3Dot(_vec3Sub(centroid, edgeMid), offDir) < 0) {
      offDir = _vec3Scale(offDir, -1);
    }

    const curve = topoEdge.curve;
    if (curve && curve.degree === 2 && curve.controlPoints.length >= 3) {
      // Arc edge on a plane → offset = concentric arc
      // Recover arc center: the middle control point of a degree-2 rational arc
      // The center is equidistant from the start and end points
      // We can also compute it from the offset direction at each endpoint
      const r0 = _vec3Sub(sp, _vec3Scale(offDir, 0));
      // For a circular arc, the offset direction at each point is radial (toward center)
      // offDir at sp should point from sp toward center (or away from center)
      // Use the arc geometry: center = sp + R * radialDir
      // The offset of a circular arc with radius R at distance d is another arc with radius R ∓ d

      // Reconstruct arc center from the curve
      const arcCenter = _recoverArcCenter(curve, sp, ep);
      if (arcCenter) {
        const r = _vec3Len(_vec3Sub(sp, arcCenter));
        // Check if offset goes toward center or away
        const radialAtSp = _vec3Normalize(_vec3Sub(sp, arcCenter));
        const inward = _vec3Dot(radialAtSp, offDir) < 0; // offDir points toward center
        const newR = inward ? r - dist : r + dist;
        if (newR < 1e-10) return null; // degenerate

        const newSp = _vec3Add(arcCenter, _vec3Scale(_vec3Normalize(_vec3Sub(sp, arcCenter)), newR));
        const newEp = _vec3Add(arcCenter, _vec3Scale(_vec3Normalize(_vec3Sub(ep, arcCenter)), newR));

        // Build the offset arc in the same local frame
        const xAx = _vec3Normalize(_vec3Sub(newSp, arcCenter));
        const yAx = _vec3Normalize(_vec3Cross(faceNormal, xAx));
        const r1 = _vec3Sub(newEp, arcCenter);
        const cosA = Math.max(-1, Math.min(1, _vec3Dot(r1, _vec3Scale(xAx, newR)) / (newR * newR)));
        const sinA = _vec3Dot(r1, _vec3Scale(yAx, newR)) / (newR * newR);
        let sweep = Math.atan2(sinA, cosA);
        if (sweep <= 1e-10) sweep += 2 * Math.PI;

        const offCurve = NurbsCurve.createArc(arcCenter, newR, xAx, yAx, 0, sweep);
        return {
          curve: offCurve,
          startPt: newSp,
          endPt: newEp,
          arcCenter,
          radius: newR,
          startVertexPoint: sp,
          endVertexPoint: ep,
        };
      }
    }

    // Straight edge on a plane → parallel line
    let newSp = _vec3Add(sp, _vec3Scale(offDir, dist));
    let newEp = _vec3Add(ep, _vec3Scale(offDir, dist));

    const loop = coedge?.loop;
    if (loop && Array.isArray(loop.coedges) && loop.coedges.length >= 3) {
      const idx = loop.coedges.indexOf(coedge);
      if (idx >= 0) {
        const prev = loop.coedges[(idx - 1 + loop.coedges.length) % loop.coedges.length];
        const next = loop.coedges[(idx + 1) % loop.coedges.length];
        newSp = _intersectPlanarOffsetWithNeighbor(prev, sp, edgeDir, offDir, dist, newSp) || newSp;
        newEp = _intersectPlanarOffsetWithNeighbor(next, sp, edgeDir, offDir, dist, newEp) || newEp;
      }
    }

    return {
      curve: NurbsCurve.createLine(newSp, newEp),
      startPt: newSp,
      endPt: newEp,
      startVertexPoint: sp,
      endVertexPoint: ep,
    };

  } else if (sType === SurfaceType.CYLINDER) {
    // Cylindrical face — determine edge orientation relative to axis
    const surfInfo = face.surfaceInfo || _extractCylinderInfo(face);
    if (!surfInfo) {
      // Fallback to linear offset
      return _offsetEdgeLinearFallback(topoEdge, face, dist);
    }

    const { axis, center: cylCenter, radius: cylR } = surfInfo;
    const axisDir = _vec3Normalize(axis);

    // Check if edge is circumferential (perpendicular to axis) or axial (along axis)
    const edgeDotAxis = Math.abs(_vec3Dot(edgeDir, axisDir));

    if (edgeDotAxis < 0.1) {
      // Circumferential edge (arc along the bottom/top of cylinder)
      // Offset = shift along axis direction
      // Determine which direction to offset (into the face)
      const centroid = _faceCentroid(face);
      const edgeMid = _vec3Lerp(sp, ep, 0.5);
      const towardFace = _vec3Sub(centroid, edgeMid);
      const axisDist = _vec3Dot(towardFace, axisDir);
      const offDir = axisDist > 0 ? axisDir : _vec3Scale(axisDir, -1);

      const newSp = _vec3Add(sp, _vec3Scale(offDir, dist));
      const newEp = _vec3Add(ep, _vec3Scale(offDir, dist));

      if (topoEdge.curve && topoEdge.curve.degree === 2) {
        const arcCenter = _recoverArcCenter(topoEdge.curve, sp, ep);
        if (arcCenter) {
          const newCenter = _vec3Add(arcCenter, _vec3Scale(offDir, dist));
          const xAx = _vec3Normalize(_vec3Sub(newSp, newCenter));
          const yAx = _vec3Normalize(_vec3Cross(axisDir, xAx));
          const r1 = _vec3Sub(newEp, newCenter);
          const cosA = Math.max(-1, Math.min(1, _vec3Dot(r1, _vec3Scale(xAx, cylR)) / (cylR * cylR)));
          const sinA = _vec3Dot(r1, _vec3Scale(yAx, cylR)) / (cylR * cylR);
          let sweep = Math.atan2(sinA, cosA);
          if (sweep <= 1e-10) sweep += 2 * Math.PI;

          const offCurve = NurbsCurve.createArc(newCenter, cylR, xAx, yAx, 0, sweep);
          return {
            curve: offCurve,
            startPt: newSp,
            endPt: newEp,
            arcCenter: newCenter,
            radius: cylR,
            startVertexPoint: sp,
            endVertexPoint: ep,
          };
        }
      }
      return {
        curve: NurbsCurve.createLine(newSp, newEp),
        startPt: newSp,
        endPt: newEp,
        startVertexPoint: sp,
        endVertexPoint: ep,
      };

    } else {
      // Axial edge (along cylinder axis)
      // Offset = angular shift: d/R radians around the axis
      const radialSp = _vec3Normalize(_vec3Sub(sp, _projectOntoAxis(sp, cylCenter, axisDir)));
      const tangentSp = _vec3Cross(axisDir, radialSp);
      const centroid = _faceCentroid(face);
      const edgeMid = _vec3Lerp(sp, ep, 0.5);
      const towardFace = _vec3Sub(centroid, edgeMid);
      const intoFace = _vec3Dot(towardFace, tangentSp) > 0 ? tangentSp : _vec3Scale(tangentSp, -1);

      // Rotate by angle = dist / cylR
      const angle = dist / cylR;
      const cosA = Math.cos(angle);
      const sinA = _vec3Dot(intoFace, tangentSp) > 0 ? Math.sin(angle) : -Math.sin(angle);

      const rotatePoint = (p) => {
        const proj = _projectOntoAxis(p, cylCenter, axisDir);
        const radial = _vec3Sub(p, proj);
        const rLen = _vec3Len(radial);
        if (rLen < 1e-14) return p;
        const rDir = _vec3Scale(radial, 1 / rLen);
        const tDir = _vec3Cross(axisDir, rDir);
        const newRadial = _vec3Add(
          _vec3Scale(rDir, rLen * cosA),
          _vec3Scale(tDir, rLen * sinA)
        );
        return _vec3Add(proj, newRadial);
      };

      const newSp = rotatePoint(sp);
      const newEp = rotatePoint(ep);
      return {
        curve: NurbsCurve.createLine(newSp, newEp),
        startPt: newSp,
        endPt: newEp,
        startVertexPoint: sp,
        endVertexPoint: ep,
      };
    }
  }

  // Fallback: linear offset (approximate for unsupported surface types)
  return _offsetEdgeLinearFallback(topoEdge, face, dist);
}

/** Recover the center of a degree-2 rational arc NurbsCurve */
function _recoverArcCenter(curve, sp, ep) {
  // For a degree-2 NURBS arc, the control point layout is:
  //   [start, weighted_shoulder, end] for a single span
  // or multi-span for larger arcs.
  // The center can be found geometrically:
  // All points on the arc are equidistant from the center.
  // For a single-span (3-cp) arc: center = shoulder−projected offset
  // Simpler: evaluate the midpoint and use 3-point circle construction.
  const mid = curve.evaluate(0.5);
  if (!mid) return null;
  // Three points on arc: sp, mid, ep
  return _circumCenter3D(sp, mid, ep);
}

/** Compute circumcenter of three 3D points (center of circle through them) */
function _circumCenter3D(a, b, c) {
  const ab = _vec3Sub(b, a);
  const ac = _vec3Sub(c, a);
  const n = _vec3Cross(ab, ac);
  const n2 = _vec3Dot(n, n);
  if (n2 < 1e-20) return null; // collinear
  const abDot = _vec3Dot(ab, ab);
  const acDot = _vec3Dot(ac, ac);
  const d = _vec3Add(
    _vec3Scale(_vec3Cross(n, _vec3Cross(ab, n)), acDot),
    _vec3Scale(_vec3Cross(_vec3Cross(ac, n), n), abDot)
  );
  // Hmm this formula is wrong, let me use the standard one
  // center = a + (|ac|^2 (ab×n) + |ab|^2 (n×ac)) / (2|n|^2)
  const t1 = _vec3Cross(ab, n);
  const t2 = _vec3Cross(n, ac);
  const num = _vec3Add(_vec3Scale(t2, abDot), _vec3Scale(t1, acDot));
  return _vec3Add(a, _vec3Scale(num, 0.5 / n2));
}

/** Project a point onto an axis line */
function _projectOntoAxis(point, axisOrigin, axisDir) {
  const v = _vec3Sub(point, axisOrigin);
  const t = _vec3Dot(v, axisDir);
  return _vec3Add(axisOrigin, _vec3Scale(axisDir, t));
}

/** Extract cylinder axis/center/radius from a cylindrical TopoFace */
function _extractCylinderInfo(face) {
  if (!face.surface) return null;
  // Try to extract from surface info metadata
  if (face.surfaceInfo) return face.surfaceInfo;
  // Try to recover from the cylinder surface control points
  const surf = face.surface;
  if (surf.degreeU === 1 && surf.degreeV === 2 && surf.numRowsU === 2) {
    // Cylinder: 2 rows of arc CPs, linear in u-direction
    const nCols = surf.numColsV;
    const row0 = [];
    const row1 = [];
    for (let j = 0; j < nCols; j++) {
      row0.push(surf.controlPoints[j]);
      row1.push(surf.controlPoints[nCols + j]);
    }
    // Axis = row1[0] - row0[0]
    const axis = _vec3Sub(row1[0], row0[0]);
    // Center of the arc: evaluate bottom row at midpoint
    const p0 = row0[0];
    const pMid = surf.evaluate(0, 0.5);
    const pEnd = row0[nCols - 1];
    const center = _circumCenter3D(p0, pMid, pEnd);
    const radius = center ? _vec3Len(_vec3Sub(p0, center)) : null;
    if (center && radius) {
      return { axis, center, radius };
    }
  }
  return null;
}

function _offsetEdgeLinearFallback(topoEdge, face, dist) {
  const sp = topoEdge.startVertex.point;
  const ep = topoEdge.endVertex.point;
  const edgeDir = _vec3Normalize(_vec3Sub(ep, sp));
  const centroid = _faceCentroid(face);
  const edgeMid = _vec3Lerp(sp, ep, 0.5);
  const towardFace = _vec3Normalize(_vec3Sub(centroid, edgeMid));
  // Remove component along edge direction
  const perp = _vec3Normalize(_vec3Sub(towardFace, _vec3Scale(edgeDir, _vec3Dot(towardFace, edgeDir))));
  const newSp = _vec3Add(sp, _vec3Scale(perp, dist));
  const newEp = _vec3Add(ep, _vec3Scale(perp, dist));
  return {
    curve: NurbsCurve.createLine(newSp, newEp),
    startPt: newSp,
    endPt: newEp,
    startVertexPoint: sp,
    endVertexPoint: ep,
  };
}

/**
 * Build a ruled NURBS surface between two arc curves (for arc-edge chamfers).
 * When both offsets produce arcs, this creates a conical or cylindrical ruled surface.
 */
function _buildChamferRuledSurface(offset0, offset1) {
  const c0 = offset0.curve;
  const c1 = offset1.curve;

  // If both curves are NURBS arcs with compatible parametrization, build a ruled surface
  if (c0.degree === 2 && c1.degree === 2 &&
      c0.controlPoints.length === c1.controlPoints.length &&
      c0.knots.length === c1.knots.length) {
    const nCols = c0.controlPoints.length;
    const nRows = 2;
    const controlPoints = [];
    const weights = [];
    for (let j = 0; j < nCols; j++) {
      controlPoints.push({ ...c0.controlPoints[j] });
      weights.push(c0.weights[j]);
    }
    for (let j = 0; j < nCols; j++) {
      controlPoints.push({ ...c1.controlPoints[j] });
      weights.push(c1.weights[j]);
    }
    return new NurbsSurface(
      1, c0.degree,       // linear in u, quadratic in v
      nRows, nCols,
      controlPoints,
      [0, 0, 1, 1],       // linear u-knots
      [...c0.knots],       // arc v-knots
      weights
    );
  }

  // Fallback: bilinear patch (flat chamfer)
  return NurbsSurface.createChamferSurface(
    offset0.startPt, offset0.endPt, offset1.startPt, offset1.endPt
  );
}

function _extractLoopDesc(loop) {
  if (!loop || !Array.isArray(loop.coedges) || loop.coedges.length === 0) {
    return { vertices: [], edgeCurves: [] };
  }

  const vertices = [];
  const edgeCurves = [];
  for (const coedge of loop.coedges) {
    const edge = coedge.edge;
    const sameSense = coedge.sameSense !== false;
    const start = sameSense ? edge.startVertex.point : edge.endVertex.point;
    const end = sameSense ? edge.endVertex.point : edge.startVertex.point;
    const curve = edge.curve
      ? (sameSense ? edge.curve : edge.curve.reversed())
      : NurbsCurve.createLine(start, end);
    vertices.push({ ...start });
    edgeCurves.push(curve);
  }

  return { vertices, edgeCurves };
}

function _pointsCoincident3D(a, b, tol = 1e-8) {
  return _vec3Len(_vec3Sub(a, b)) < tol;
}

function _getOrientedCoedgeCurve(coedge) {
  if (!coedge?.edge) return null;

  const edge = coedge.edge;
  if (!edge.curve) {
    const { start, end } = _getCoedgeEdgePoints(coedge);
    return NurbsCurve.createLine(start, end);
  }

  return coedge.sameSense !== false ? edge.curve : edge.curve.reversed();
}

function _orientOffsetAlongTopoEdge(offset, topoEdge) {
  const topoStart = topoEdge.startVertex.point;
  const sameDirection = _pointsCoincident3D(offset.startVertexPoint || topoStart, topoStart);
  return sameDirection ? {
    startPt: offset.startPt,
    endPt: offset.endPt,
    curve: offset.curve,
  } : {
    startPt: offset.endPt,
    endPt: offset.startPt,
    curve: offset.curve.reversed ? offset.curve.reversed() : offset.curve,
  };
}

function _measureMeshTopology(faces) {
  const edgeMap = new Map();
  for (const face of faces || []) {
    const verts = face.vertices || [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const ka = _edgeVKey(a);
      const kb = _edgeVKey(b);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const fwd = ka < kb;
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push({ fwd });
    }
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let windingErrors = 0;
  for (const entries of edgeMap.values()) {
    if (entries.length === 1) {
      boundaryEdges++;
    } else if (entries.length === 2) {
      if (entries[0].fwd === entries[1].fwd) windingErrors++;
    } else {
      nonManifoldEdges++;
    }
  }

  return { boundaryEdges, nonManifoldEdges, windingErrors };
}

function _debugBRepChamfer(...args) {
  if (typeof process === 'undefined' || !process?.env?.DEBUG_BREP_CHAMFER) return;
  console.log('[applyBRepChamfer]', ...args);
}

/**
 * Apply B-Rep chamfer to a TopoBody.
 *
 * Operates directly on the TopoBody topology, producing exact offset
 * curves on planar and cylindrical surfaces. Creates proper chamfer
 * faces (ruled surfaces) and rebuilds adjacent face boundaries.
 *
 * @param {Object} geometry - Input geometry with .topoBody
 * @param {string[]} edgeKeys - Edge keys to chamfer (position-based)
 * @param {number} distance - Chamfer offset distance
 * @returns {Object|null} New geometry or null if BRep chamfer not applicable
 */
export function applyBRepChamfer(geometry, edgeKeys, distance) {
  const topoBody = geometry && geometry.topoBody;
  if (!topoBody || !topoBody.shells) {
    _debugBRepChamfer('missing-topobody');
    return null;
  }

  // Pre-compute baseline mesh topology from the input body so we can
  // distinguish pre-existing tessellation artifacts (curved surface boundary
  // mismatches) from genuine errors introduced by the chamfer.
  let baselineMeshTopo = null;
  try {
    const baseMesh = tessellateBody(topoBody, { validate: false });
    if (baseMesh && baseMesh.faces && baseMesh.faces.length > 0) {
      baselineMeshTopo = _measureMeshTopology(baseMesh.faces);
    }
  } catch (_) {
    // Baseline tessellation failure is non-fatal: if we cannot establish a
    // baseline we proceed without one, using 0 as the reference count.  The
    // B-Rep topology check (_countTopoBodyBoundaryEdges) already validated
    // the input body's structural integrity.
  }

  // Step 1: Map mesh edge keys to TopoEdges
  const segMap = _mapSegmentKeysToTopoEdges(topoBody);
  const uniqueMeshKeys = [...new Set(edgeKeys)];
  const chamferTopoEdges = new Map(); // topoEdge.id → topoEdge
  const unmatchedKeys = [];
  for (const key of uniqueMeshKeys) {
    const te = segMap.get(key);
    if (te) chamferTopoEdges.set(te.id, te);
    else unmatchedKeys.push(key);
  }
  // Proximity fallback for keys that didn't match exact segments
  if (unmatchedKeys.length > 0) {
    _proximityMatchEdgeKeys(unmatchedKeys, segMap._allEdgeSamples, chamferTopoEdges);
  }
  if (chamferTopoEdges.size === 0) {
    _debugBRepChamfer('no-matched-topo-edges', { edgeKeys: uniqueMeshKeys.length });
    return null;
  }

  // Step 2: For each TopoEdge, compute offset info on both adjacent faces
  const chamferInfos = [];
  for (const [, topoEdge] of chamferTopoEdges) {
    const adjFaces = [];
    for (const coedge of topoEdge.coedges) {
      if (coedge.loop && coedge.loop.face) {
        adjFaces.push({ face: coedge.loop.face, coedge, sameSense: coedge.sameSense !== false });
      }
    }
    if (adjFaces.length < 2) continue;

    const off0 = _offsetEdgeOnSurface(topoEdge, adjFaces[0].face, adjFaces[0].coedge, distance);
    const off1 = _offsetEdgeOnSurface(topoEdge, adjFaces[1].face, adjFaces[1].coedge, distance);
    if (!off0 || !off1) continue;

    chamferInfos.push({
      topoEdge,
      face0: adjFaces[0].face,
      face1: adjFaces[1].face,
      off0, off1,
    });
  }
  if (chamferInfos.length === 0) {
    _debugBRepChamfer('no-chamfer-infos', { topoEdges: chamferTopoEdges.size });
    return null;
  }

  // Build lookup: topoEdge.id → chamferInfo
  const chamferByEdgeId = new Map();
  for (const ci of chamferInfos) {
    chamferByEdgeId.set(ci.topoEdge.id, ci);
  }

  // Build lookup: vertex key → chamfer infos that touch it
  const _vkey = (p) => `${_fmtCoord(p.x)},${_fmtCoord(p.y)},${_fmtCoord(p.z)}`;
  const vertexChamfers = new Map();
  for (const ci of chamferInfos) {
    const sp = ci.topoEdge.startVertex.point;
    const ep = ci.topoEdge.endVertex.point;
    for (const p of [sp, ep]) {
      const k = _vkey(p);
      if (!vertexChamfers.has(k)) vertexChamfers.set(k, []);
      vertexChamfers.get(k).push(ci);
    }
  }

  // Step 3: Build face descriptors for new TopoBody
  const faceDescs = [];

  for (const shell of topoBody.shells) {
    for (const face of shell.faces) {
      // Walk the boundary and rebuild with offsets
      const coedges = face.outerLoop.coedges;
      const rebuiltEdges = [];

      for (let ci = 0; ci < coedges.length; ci++) {
        const coedge = coedges[ci];
        const edge = coedge.edge;
        const sameSense = coedge.sameSense !== false;
        const edgeSp = sameSense ? edge.startVertex.point : edge.endVertex.point;
        const edgeEp = sameSense ? edge.endVertex.point : edge.startVertex.point;

        const chamInfo = chamferByEdgeId.get(edge.id);

        if (!chamInfo) {
          // Non-chamfered edge: keep but may need to adjust endpoint positions
          // if adjacent vertices are chamfered
          const edgeFaces = edge.coedges
            .map((edgeCoedge) => edgeCoedge?.loop?.face)
            .filter((edgeFace) => !!edgeFace);
          let sp = edgeSp;
          let ep = edgeEp;

          const resolveEndpoint = (vertexPoint) => {
            const chamfersAtVertex = vertexChamfers.get(_vkey(vertexPoint));
            if (!chamfersAtVertex) return vertexPoint;

            for (const sci of chamfersAtVertex) {
              const matchedFace = edgeFaces.includes(sci.face0)
                ? sci.face0
                : edgeFaces.includes(sci.face1)
                  ? sci.face1
                  : null;
              if (!matchedFace) continue;

              const off = matchedFace === sci.face0 ? sci.off0 : sci.off1;
              const isStart = _vec3Len(_vec3Sub(off.startVertexPoint || sci.topoEdge.startVertex.point, vertexPoint)) < 1e-8;
              return isStart ? off.startPt : off.endPt;
            }

            return vertexPoint;
          };

          sp = resolveEndpoint(edgeSp);
          ep = resolveEndpoint(edgeEp);
          const endpointsUnchanged = _pointsCoincident3D(sp, edgeSp) && _pointsCoincident3D(ep, edgeEp);

          rebuiltEdges.push({
            start: sp,
            end: ep,
            curve: endpointsUnchanged
              ? (_getOrientedCoedgeCurve(coedge) || NurbsCurve.createLine(sp, ep))
              : NurbsCurve.createLine(sp, ep),
          });
        } else {
          // Chamfered edge: replace with offset curve on this face
          const off = chamInfo.face0 === face ? chamInfo.off0 : chamInfo.off1;
          rebuiltEdges.push({
            start: off.startPt,
            end: off.endPt,
            curve: off.curve,
          });
        }
      }

      // Handle vertices at chamfered corners that need connecting edges
      // between the offset endpoints on different faces
      const finalVerts = [];
      const finalCurves = [];
      for (let i = 0; i < rebuiltEdges.length; i++) {
        const current = rebuiltEdges[i];
        const next = rebuiltEdges[(i + 1) % rebuiltEdges.length];
        finalVerts.push(current.start);
        finalCurves.push(current.curve);

        // Check if there's a gap between this edge's endpoint and next edge's start
        if (_vec3Len(_vec3Sub(current.end, next.start)) > 1e-8) {
          finalVerts.push(current.end);
          finalCurves.push(NurbsCurve.createLine(current.end, next.start));
        }
      }

      if (finalVerts.length < 3) continue;

      faceDescs.push({
        surface: face.surface,
        surfaceType: face.surfaceType,
        vertices: finalVerts,
        edgeCurves: finalCurves,
        innerLoops: face.innerLoops.map((loop) => _extractLoopDesc(loop)),
        sameSense: face.sameSense,
        shared: face.shared ? { ...face.shared } : null,
      });
    }
  }

  // Step 4: Add chamfer faces
  for (const ci of chamferInfos) {
    const off0 = _orientOffsetAlongTopoEdge(ci.off0, ci.topoEdge);
    const off1 = _orientOffsetAlongTopoEdge(ci.off1, ci.topoEdge);
    const surface = _buildChamferRuledSurface(off0, off1);
    const surfType = (off0.curve.degree === 2 && off1.curve.degree === 2)
      ? SurfaceType.CONE
      : SurfaceType.PLANE;

    faceDescs.push({
      surface,
      surfaceType: surfType,
      vertices: [off0.startPt, off0.endPt, off1.endPt, off1.startPt],
      edgeCurves: [
        off0.curve,
        NurbsCurve.createLine(off0.endPt, off1.endPt),
        off1.curve.reversed(),
        NurbsCurve.createLine(off1.startPt, off0.startPt),
      ],
      shared: ci.face0.shared ? { ...ci.face0.shared, isChamfer: true } : { isChamfer: true },
    });
  }

  // Step 5: Add corner faces where chamfers meet at a vertex
  for (const [vk, cInfos] of vertexChamfers) {
    if (cInfos.length < 2) continue;
    // Find the offset points at this vertex from all chamfer infos
    // and create a corner face connecting them
    const pts = [];
    for (const ci of cInfos) {
      const off0StartKey = _vkey(ci.off0.startVertexPoint || ci.topoEdge.startVertex.point);
      const off1StartKey = _vkey(ci.off1.startVertexPoint || ci.topoEdge.startVertex.point);
      pts.push(vk === off0StartKey ? ci.off0.startPt : ci.off0.endPt);
      pts.push(vk === off1StartKey ? ci.off1.startPt : ci.off1.endPt);
    }
    // Deduplicate nearby points
    const uniquePts = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      let dup = false;
      for (const up of uniquePts) {
        if (_vec3Len(_vec3Sub(pts[i], up)) < 1e-8) { dup = true; break; }
      }
      if (!dup) uniquePts.push(pts[i]);
    }
    if (uniquePts.length >= 3) {
      const n = _computePolygonNormal(uniquePts);
      faceDescs.push({
        surface: NurbsSurface.createPlane(
          uniquePts[0],
          _vec3Sub(uniquePts[1], uniquePts[0]),
          _vec3Sub(uniquePts[uniquePts.length - 1], uniquePts[0])
        ),
        surfaceType: SurfaceType.PLANE,
        vertices: uniquePts,
        edgeCurves: uniquePts.map((v, i) =>
          NurbsCurve.createLine(v, uniquePts[(i + 1) % uniquePts.length])
        ),
        shared: cInfos[0].face0.shared ? { ...cInfos[0].face0.shared, isCorner: true } : { isCorner: true },
      });
    }
  }

  // Step 6: Build new TopoBody and tessellate
  let newTopoBody;
  try {
    newTopoBody = buildTopoBody(faceDescs);
  } catch (error) {
    _debugBRepChamfer('build-topobody-failed', error?.message || String(error));
    return null; // fallback to mesh chamfer
  }

  const topoBoundaryEdges = _countTopoBodyBoundaryEdges(newTopoBody);
  if (topoBoundaryEdges !== 0) {
    _debugBRepChamfer('topo-boundary-edges', { topoBoundaryEdges, faceCount: faceDescs.length });
    return null;
  }

  let mesh;
  try {
    mesh = tessellateBody(newTopoBody, { validate: true });
  } catch (error) {
    _debugBRepChamfer('tessellate-failed', error?.message || String(error));
    return null;
  }

  if (!mesh || !mesh.faces || mesh.faces.length === 0) {
    _debugBRepChamfer('empty-mesh');
    return null;
  }

  _fixWindingConsistency(mesh.faces);
  _recomputeFaceNormals(mesh.faces);
  const meshTopology = _measureMeshTopology(mesh.faces);

  // Accept the chamfer if its mesh topology errors are no worse than the
  // input body's baseline (pre-existing tessellation artifacts from curved
  // surface approximation).  Only reject if the chamfer genuinely introduces
  // NEW boundary or non-manifold edges beyond what already existed, or if
  // winding errors appear that weren't present before.
  const baselineBE = baselineMeshTopo ? baselineMeshTopo.boundaryEdges : 0;
  const baselineNME = baselineMeshTopo ? baselineMeshTopo.nonManifoldEdges : 0;
  const baselineWE = baselineMeshTopo ? baselineMeshTopo.windingErrors : 0;
  if (
    meshTopology.boundaryEdges > baselineBE ||
    meshTopology.nonManifoldEdges > baselineNME ||
    meshTopology.windingErrors > baselineWE
  ) {
    _debugBRepChamfer('mesh-topology-failed', { ...meshTopology, baselineBE, baselineNME, baselineWE });
    return null;
  }

  const edgeResult = computeFeatureEdges(mesh.faces);

  return {
    vertices: mesh.vertices || [],
    faces: mesh.faces,
    edges: edgeResult.edges,
    paths: edgeResult.paths,
    visualEdges: edgeResult.visualEdges,
    topoBody: newTopoBody,
  };
}

/**
 * Pre-compute chamfer data for one edge on the original (unmodified) geometry.
 */
function _precomputeChamferEdge(faces, edgeKey, dist, exactAdjacencyByKey = null) {
  const adj = (exactAdjacencyByKey && exactAdjacencyByKey.get(edgeKey)) || _findAdjacentFaces(faces, edgeKey);
  if (adj.length < 2) return null;

  const fi0 = adj[0].fi, fi1 = adj[1].fi;
  const face0 = faces[fi0];
  const face1 = faces[fi1];
  const edgeA = adj[0].a;
  const edgeB = adj[0].b;

  const face0Keys = _collectFaceEdgeKeys(face0);
  const face1Keys = _collectFaceEdgeKeys(face1);

  const { offsDir0, offsDir1, isConcave } = _computeOffsetDirs(face0, face1, edgeA, edgeB);

  const p0a = _vec3Add(edgeA, _vec3Scale(offsDir0, dist));
  const p0b = _vec3Add(edgeB, _vec3Scale(offsDir0, dist));
  const p1a = _vec3Add(edgeA, _vec3Scale(offsDir1, dist));
  const p1b = _vec3Add(edgeB, _vec3Scale(offsDir1, dist));

  return {
    edgeKey, fi0, fi1, edgeA, edgeB,
    face0Keys, face1Keys,
    p0a, p0b, p1a, p1b,
    isConcave,
    shared: face0.shared ? { ...face0.shared } : null,
  };
}

// -----------------------------------------------------------------------
// Fillet geometry operation
// -----------------------------------------------------------------------

export function applyFillet(geometry, edgeKeys, radius, segments = 8, edgeOwnerMap = null) {
  if (!geometry || !geometry.faces || edgeKeys.length === 0 || radius <= 0) {
    return geometry;
  }

  const baseFaces = _extractFeatureFacesFromTopoBody(geometry);
  const exactAdjacencyByKey = _buildExactEdgeAdjacencyLookupFromTopoBody(
    geometry.topoBody,
    baseFaces,
  );
  let faces = baseFaces.map(f => ({
    vertices: f.vertices.map(v => ({ ...v })),
    normal: { ...f.normal },
    shared: f.shared ? { ...f.shared } : null,
    isFillet: f.isFillet || false,
    isCorner: f.isCorner || false,
    faceGroup: f.faceGroup,
    topoFaceId: f.topoFaceId,
    // Preserve cylinder metadata for fillet-fillet intersection detection
    _exactAxisStart: f._exactAxisStart ? { ...f._exactAxisStart } : null,
    _exactAxisEnd: f._exactAxisEnd ? { ...f._exactAxisEnd } : null,
    _exactRadius: f._exactRadius || null,
  }));

  // Save original face vertices for corner-face generation
  const origFaces = faces.map(f => ({
    vertices: f.vertices.map(v => ({ ...v })),
    normal: { ...f.normal },
  }));

  // --- Phase 0: Extend edge keys through fillet boundaries ---
  // When an edge endpoint sits on an existing fillet boundary (not a sharp corner),
  // extend the edge along its direction to pass through the fillet surface.
  // This enables fillet-through-fillet operations where the new fillet cuts through old fillets.
  const extendedEdgeKeys = _extendEdgesThroughFilletBoundaries(faces, edgeKeys);

  // --- Phase 1: Pre-compute all edge data on the ORIGINAL geometry ---
  const uniqueKeys = [...new Set(extendedEdgeKeys)];
  const edgeDataList = [];
  for (const ek of uniqueKeys) {
    const data = _precomputeFilletEdge(faces, ek, radius, segments, exactAdjacencyByKey);
    if (!data) continue;
    const ownerId = edgeOwnerMap && edgeOwnerMap[ek];
    if (ownerId) {
      data.shared = { ...(data.shared || {}), sourceFeatureId: ownerId };
    }
    edgeDataList.push(data);
  }

  if (edgeDataList.length === 0) return geometry;

  // --- Phase 1b: Compute fillet-fillet intersection trims ---
  // For edges that pass through existing fillet surfaces, compute the intersection
  // curve between the new fillet cylinder and the old fillet cylinder.
  _computeFilletFilletIntersections(faces, edgeDataList, radius, segments);

  // --- Phase 1c: Clip old fillet faces in the overlap zone ---
  // When a new fillet passes through an existing fillet surface, remove or trim
  // the old fillet strip quads that would overlap with the new fillet.
  _clipOldFilletFacesInOverlapZone(faces, edgeDataList, radius);

  // --- Phase 2: Build vertex-sharing map ---
  const vertexEdgeMap = _buildVertexEdgeMap(edgeDataList);

  // Merge common-face trim vertices before face trimming so the shared planar
  // face uses the real fillet/fillet breakpoint instead of a legacy diagonal.
  _mergeSharedVertexPositions(edgeDataList, vertexEdgeMap);

  // --- Phase 3: Apply batch face trimming ---
  _batchTrimFaces(faces, edgeDataList);

  _batchSplitVertices(faces, edgeDataList, vertexEdgeMap);
  _applyTwoEdgeFilletSharedTrims(edgeDataList, origFaces, vertexEdgeMap);

  // --- Phase 4: Generate all fillet strip quads, endpoint fans, + NURBS ---
  const brep = new BRep();

  // Add BRep faces for existing trimmed faces (planar or previously defined)
  for (const face of faces) {
    const brepFace = new BRepFace(null, face.isFillet ? 'fillet' : 'planar', face.shared);
    brep.addFace(brepFace);
  }

  const sharedEndpoints = new Set();
  for (const [vk, edgeIndices] of vertexEdgeMap) {
    if (edgeIndices.length >= 2) sharedEndpoints.add(vk);
  }

  function trySpliceEndpointArcIntoFace(arc, desiredNormal) {
    if (!desiredNormal || _vec3Len(desiredNormal) < 1e-10 || arc.length < 3) return false;

    // Check if arc is actually curved or nearly collinear.
    // If the arc points deviate from the straight line between endpoints,
    // we should NOT splice them into a planar face - use fan triangles instead.
    const startPt = arc[0];
    const endPt = arc[arc.length - 1];
    const chordDir = _vec3Sub(endPt, startPt);
    const chordLen = _vec3Len(chordDir);
    if (chordLen > 1e-10) {
      const chordNorm = _vec3Normalize(chordDir);
      // Check deviation of interior points from the chord line
      for (let i = 1; i < arc.length - 1; i++) {
        const pt = arc[i];
        const toPoint = _vec3Sub(pt, startPt);
        const projLen = _vec3Dot(toPoint, chordNorm);
        const projected = _vec3Add(startPt, _vec3Scale(chordNorm, projLen));
        const deviation = _vec3Len(_vec3Sub(pt, projected));
        // If any interior point deviates from the chord line by more than 1% of chord length,
        // this is a curved arc - don't splice it into planar faces
        if (deviation > chordLen * 0.01) {
          return false;
        }
      }
    }

    const startKey = _edgeVKey(arc[0]);
    const endKey = _edgeVKey(arc[arc.length - 1]);
    const arcKeys = new Set(arc.map((v) => _edgeVKey(v)));
    const arcInterior = arc.slice(1, -1);

    for (const face of faces) {
      if (!face || !face.vertices || face.vertices.length < 3 || face.isFillet) continue;
      if (face.vertices.every((v) => arcKeys.has(_edgeVKey(v)))) continue;
      const fn = _vec3Normalize(face.normal || { x: 0, y: 0, z: 0 });
      if (_vec3Len(fn) < 1e-10) continue;
      if (Math.abs(_vec3Dot(fn, desiredNormal)) < 0.999) continue;
      if (!arc.every((p) => _pointOnFacePlane(p, face.vertices))) continue;

      const verts = face.vertices;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        const aKey = _edgeVKey(a);
        const bKey = _edgeVKey(b);
        if ((aKey !== startKey || bKey !== endKey) && (aKey !== endKey || bKey !== startKey)) continue;

        const insert = aKey === startKey ? arcInterior : [...arcInterior].reverse();
        const newVerts = [];
        for (let vi = 0; vi < verts.length; vi++) {
          newVerts.push({ ...verts[vi] });
          if (vi === i) {
            for (const p of insert) newVerts.push({ ...p });
          }
        }

        face.vertices = _deduplicatePolygon(newVerts);
        let newNormal = _computePolygonNormal(face.vertices);
        if (newNormal && _vec3Dot(newNormal, desiredNormal) < 0) {
          face.vertices.reverse();
          newNormal = _computePolygonNormal(face.vertices);
        }
        if (newNormal) face.normal = newNormal;
        return true;
      }
    }

    return false;
  }

  function pushFallbackEndpointFan(arc, atStart, shared) {
    for (let s = 1; s < arc.length - 1; s++) {
      const triVerts = atStart
        ? [{ ...arc[0] }, { ...arc[s + 1] }, { ...arc[s] }]
        : [{ ...arc[0] }, { ...arc[s] }, { ...arc[s + 1] }];
      const triNormal = _computePolygonNormal(triVerts);
      if (!triNormal || _vec3Len(triNormal) < 1e-10) continue;
      faces.push({
        vertices: triVerts,
        normal: triNormal,
        shared,
      });
    }
  }

  for (let dataIndex = 0; dataIndex < edgeDataList.length; dataIndex++) {
    const data = edgeDataList[dataIndex];
    const shared = data.shared;
    const arcA = data.arcA;
    const arcB = data.arcB;
    const edgeDir = _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA));

    // Create NURBS fillet surface for this edge
    // The fillet is a rolling-ball blend: circular arc cross-section swept along the edge.
    // Rail curves are the tangent lines on each adjacent face.
    const rail0 = [{ ...arcA[0] }, { ...arcB[0] }];
    const rail1 = [{ ...arcA[segments] }, { ...arcB[segments] }];

    // Compute arc centers at each endpoint for the NURBS definition
    const { offsDir0, offsDir1, isConcave: _nc } = _computeOffsetDirs(
      faces[data.fi0], faces[data.fi1], data.edgeA, data.edgeB
    );
    const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));
    const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
    const centerDist = alpha > 1e-6 ? radius / Math.sin(alpha / 2) : radius;
    const centerA = _vec3Add(data.edgeA, _vec3Scale(bisector, centerDist));
    const centerB = _vec3Add(data.edgeB, _vec3Scale(bisector, centerDist));
    data._exactAxisStart = { ...centerA };
    data._exactAxisEnd = { ...centerB };
    data._exactRadius = radius;
    data._exactArcCurveA = null;
    data._exactArcCurveB = null;
    data._exactSharedTrimCurveA = null;
    data._exactSharedTrimCurveB = null;

    const rebuildSharedTrim = (side) => {
      const points = side === 'A' ? data.sharedTrimA : data.sharedTrimB;
      const planeOrigin = side === 'A'
        ? data._sharedTrimPlaneAOrigin
        : data._sharedTrimPlaneBOrigin;
      const planeNormal = side === 'A'
        ? data._sharedTrimPlaneANormal
        : data._sharedTrimPlaneBNormal;
      if (!points || !planeOrigin || !planeNormal) return;
      const curve = _createExactCylinderPlaneTrimCurve(
        points,
        data._exactAxisStart,
        data._exactAxisEnd,
        radius,
        planeOrigin,
        planeNormal,
      );
      if (!curve) return;
      const rebuiltPoints = curve.tessellate(segments).map((point) => ({ x: point.x, y: point.y, z: point.z }));
      rebuiltPoints[0] = { ...points[0] };
      rebuiltPoints[rebuiltPoints.length - 1] = { ...points[points.length - 1] };
      if (side === 'A') {
        data._exactSharedTrimCurveA = curve.clone();
        data.sharedTrimA = rebuiltPoints;
      } else {
        data._exactSharedTrimCurveB = curve.clone();
        data.sharedTrimB = rebuiltPoints;
      }
    };
    rebuildSharedTrim('A');
    rebuildSharedTrim('B');
    const trimA = data.sharedTrimA || arcA;
    const trimB = data.sharedTrimB || arcB;

    // Create NURBS fillet surface using the rolling-ball factory
    try {
      const nurbsSurface = NurbsSurface.createFilletSurface(
        rail0, rail1, [centerA, centerB], radius, _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA))
      );
      data._exactSurface = nurbsSurface;
      const brepFace = new BRepFace(nurbsSurface, 'fillet', shared);

      // Add BRep edge curves for the trim lines
      const trimCurve0 = NurbsCurve.createLine(arcA[0], arcB[0]);
      const trimCurve1 = NurbsCurve.createLine(arcA[segments], arcB[segments]);
      brep.addEdge(new BRepEdge(new BRepVertex(arcA[0]), new BRepVertex(arcB[0]), trimCurve0));
      brep.addEdge(new BRepEdge(new BRepVertex(arcA[segments]), new BRepVertex(arcB[segments]), trimCurve1));

      // Add NURBS arc curves at each cross-section
      // These represent the exact circular profile of the fillet
      const xAxisA = _vec3Normalize(_vec3Sub(arcA[0], centerA));
      const crossA = _vec3Cross(edgeDir, xAxisA);
      const yAxisA = _vec3Normalize(crossA);
      const sweep = Math.PI - alpha;

      if (sweep > 1e-6) {
        const arcCurveA = NurbsCurve.createArc(centerA, radius, xAxisA, yAxisA, 0, sweep);
        const arcCurveB = NurbsCurve.createArc(centerB, radius,
          _vec3Normalize(_vec3Sub(arcB[0], centerB)),
          _vec3Normalize(_vec3Cross(edgeDir, _vec3Normalize(_vec3Sub(arcB[0], centerB)))),
          0, sweep
        );
        data._exactArcCurveA = arcCurveA.clone();
        data._exactArcCurveB = arcCurveB.clone();
        brep.addEdge(new BRepEdge(new BRepVertex(arcA[0]), new BRepVertex(arcA[segments]), arcCurveA));
        brep.addEdge(new BRepEdge(new BRepVertex(arcB[0]), new BRepVertex(arcB[segments]), arcCurveB));
      }

      brep.addFace(brepFace);
    } catch (nurbsErr) {
      // NURBS construction may fail for degenerate edge geometries (e.g.
      // near-zero sweep angle or coincident rails); mesh data still valid.
      // Log for debugging but don't block the operation.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('NURBS fillet surface construction skipped:', nurbsErr.message);
      }
    }

    // Create fillet strip quads (mesh tessellation)
    for (let s = 0; s < segments; s++) {
      const faceNormal = _vec3Normalize(_vec3Cross(
        _vec3Sub(trimA[s + 1], trimA[s]),
        _vec3Sub(trimB[s + 1], trimA[s])
      ));
      faces.push({
        vertices: [{ ...trimA[s] }, { ...trimA[s + 1] }, { ...trimB[s + 1] }, { ...trimB[s] }],
        normal: faceNormal,
        shared,
        isFillet: true,
        _exactFilletFaceOrdinal: dataIndex,
        // Store cylinder metadata for fillet-fillet intersection detection in sequential operations
        _exactAxisStart: data._exactAxisStart ? { ...data._exactAxisStart } : null,
        _exactAxisEnd: data._exactAxisEnd ? { ...data._exactAxisEnd } : null,
        _exactRadius: data._exactRadius || null,
      });
    }

    // Fan triangles at endpoint A — only if NOT a shared internal vertex
    // and NOT a fillet-fillet junction (where the strip extends to the old cylinder surface)
    // For concave edges, skip splice (arc bows inward, would create ear) and use fan
    const vkA = _edgeVKey(data.edgeA);
    if (!sharedEndpoints.has(vkA) && !data._filletJunctionSideA) {
      let merged = false;
      if (!data.isConcave) {
        merged = trySpliceEndpointArcIntoFace(arcA, _vec3Scale(edgeDir, -1));
      }
      if (!merged) pushFallbackEndpointFan(arcA, true, shared);
    }

    // Fan triangles at endpoint B — only if NOT a shared internal vertex
    // and NOT a fillet-fillet junction
    const vkB = _edgeVKey(data.edgeB);
    if (!sharedEndpoints.has(vkB) && !data._filletJunctionSideB) {
      let merged = false;
      if (!data.isConcave) {
        merged = trySpliceEndpointArcIntoFace(arcB, edgeDir);
      }
      if (!merged) pushFallbackEndpointFan(arcB, false, shared);
    }
  }

  // --- Phase 5: Generate corner/blending faces at shared vertices ---
  _generateCornerFaces(faces, origFaces, edgeDataList, vertexEdgeMap);
  _fixTJunctions(faces);

  // Add BRep faces for spherical corner patches (from _generateTrihedronCorner).
  // Build a NURBS surface using the Cobb octant construction so that the
  // spherical face has an exact rational representation for CAM/machining.
  {
    const seen = new Set();
    for (const face of faces) {
      if (!face.isCorner || !face._sphereCenter || !face._triVerts) continue;
      const cKey = _edgeVKey(face._sphereCenter);
      if (seen.has(cKey)) continue;
      seen.add(cKey);
      let nurbsSurf = null;
      try {
        nurbsSurf = NurbsSurface.createSphericalPatch(
          face._sphereCenter, face._sphereRadius,
          face._triVerts[0], face._triVerts[1], face._triVerts[2]
        );
      } catch (e) {
        // Degenerate geometry — fall back to metadata-only.
      }
      const brepFace = new BRepFace(nurbsSurf, 'spherical', face.shared);
      brepFace.sphereCenter = { ...face._sphereCenter };
      brepFace.sphereRadius = face._sphereRadius;
      brep.addFace(brepFace);
    }
  }

  {
    const seen = new Set();
    for (const face of faces) {
      if (!face.isCorner || !face._cornerPatch || !face._cornerPatchKey) continue;
      if (seen.has(face._cornerPatchKey)) continue;
      seen.add(face._cornerPatchKey);
      let nurbsSurf = null;
      try {
        nurbsSurf = NurbsSurface.createCornerBlendPatch(
          face._cornerPatch.top0,
          face._cornerPatch.top1,
          face._cornerPatch.side0Mid,
          face._cornerPatch.side1Mid,
          face._cornerPatch.apex,
          face._cornerPatch.centerPoint,
          face._cornerPatch.topMid,
        );
      } catch (e) {
        // Keep the exact corner grouped in BRep history even if patch fitting fails.
      }
      const brepFace = new BRepFace(nurbsSurf, 'fillet', face.shared);
      brepFace.isCornerPatch = true;
      brep.addFace(brepFace);
    }
  }

  // --- Phase 6: Heal boundary edges left by sequential fillet interactions ---
  _healBoundaryLoops(faces);

  _weldVertices(faces);
  _removeDegenerateFaces(faces);
  _mergeMixedSharedPlanarComponents(faces);
  _mergeAdjacentCoplanarFacePairs(faces);
  _fixTJunctions(faces);
  _healBoundaryLoops(faces);
  _removeDegenerateFaces(faces);
  _recomputeFaceNormals(faces);

  try {
    const topoBody = _buildExactFilletTopoBody(faces, edgeDataList);
    if (topoBody) {
      const exactGeometry = tessellateBody(topoBody);
      exactGeometry.topoBody = topoBody;
      exactGeometry.brep = brep;
      const edgeResult = computeFeatureEdges(exactGeometry.faces || []);
      const exactEdgeResult = _buildExactFeatureEdgesFromTopoBody(topoBody, exactGeometry.faces || []);
      exactGeometry.edges = exactEdgeResult.edges.length > 0 ? exactEdgeResult.edges : edgeResult.edges;
      exactGeometry.paths = exactEdgeResult.paths.length > 0 ? exactEdgeResult.paths : edgeResult.paths;
      exactGeometry.visualEdges = edgeResult.visualEdges;
      const exactMeshUsage = _countMeshEdgeUsage(exactGeometry.faces || []);
      if (exactMeshUsage.boundaryCount === 0 && exactMeshUsage.nonManifoldCount === 0) {
        return exactGeometry;
      }

      const fallbackFaces = _applyTopoFaceIdsToFallbackMesh(faces, topoBody, edgeDataList);
      _mergeMixedSharedPlanarComponents(fallbackFaces, true);
      _mergeAdjacentCoplanarFacePairs(fallbackFaces);
      _fixTJunctions(fallbackFaces);
      _healBoundaryLoops(fallbackFaces);
      _removeDegenerateFaces(fallbackFaces);
      _recomputeFaceNormals(fallbackFaces);
      _fixWindingConsistency(fallbackFaces);
      _fixOpposedCoplanarFacesInGroups(fallbackFaces);
      const hybridFallbackFaces = _replaceFallbackPlanarFacesWithExactTopoFaces(fallbackFaces, topoBody);
      _removeDegenerateFaces(hybridFallbackFaces);
      _recomputeFaceNormals(hybridFallbackFaces);
      _fixWindingConsistency(hybridFallbackFaces);
      _fixOpposedCoplanarFacesInGroups(hybridFallbackFaces);
      _mergeCoplanarNonManifoldComponents(hybridFallbackFaces);
      _removeDegenerateFaces(hybridFallbackFaces);
      _recomputeFaceNormals(hybridFallbackFaces);
      _fixWindingConsistency(hybridFallbackFaces);
      _fixOpposedCoplanarFacesInGroups(hybridFallbackFaces);
      const hybridMeshUsage = _countMeshEdgeUsage(hybridFallbackFaces);
      if (hybridMeshUsage.boundaryCount > 0 || hybridMeshUsage.nonManifoldCount > 0) {
        _fixTJunctions(hybridFallbackFaces);
        _healBoundaryLoops(hybridFallbackFaces);
        _removeDegenerateFaces(hybridFallbackFaces);
        _recomputeFaceNormals(hybridFallbackFaces);
        _fixWindingConsistency(hybridFallbackFaces);
        _fixOpposedCoplanarFacesInGroups(hybridFallbackFaces);
        _mergeCoplanarNonManifoldComponents(hybridFallbackFaces);
        _removeDegenerateFaces(hybridFallbackFaces);
        _recomputeFaceNormals(hybridFallbackFaces);
        _fixWindingConsistency(hybridFallbackFaces);
        _fixOpposedCoplanarFacesInGroups(hybridFallbackFaces);
      }
      const fallbackGeometry = { vertices: [], faces: hybridFallbackFaces, brep, topoBody };
      const fallbackEdgeResult = computeFeatureEdges(hybridFallbackFaces);
      const fallbackExactEdgeResult = _buildExactFeatureEdgesFromTopoBody(topoBody, hybridFallbackFaces);
      const supportedExactEdgeResult = _mergeExactAndFallbackFeatureEdges(
        hybridFallbackFaces,
        fallbackExactEdgeResult,
        fallbackEdgeResult,
      );
      fallbackGeometry.edges = supportedExactEdgeResult.edges.length > 0 ? supportedExactEdgeResult.edges : fallbackEdgeResult.edges;
      fallbackGeometry.paths = supportedExactEdgeResult.paths.length > 0 ? supportedExactEdgeResult.paths : fallbackEdgeResult.paths;
      fallbackGeometry.visualEdges = fallbackEdgeResult.visualEdges;
      return fallbackGeometry;
    }
  } catch (exactErr) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('Exact fillet topology promotion skipped:', exactErr.message);
    }
  }

  const newGeom = { vertices: [], faces, brep };
  _triangulateConcaveFaces(newGeom.faces);
  const edgeResult = computeFeatureEdges(newGeom.faces);
  newGeom.edges = edgeResult.edges;
  newGeom.paths = edgeResult.paths;
  newGeom.visualEdges = edgeResult.visualEdges;
  return newGeom;
}

/**
 * Pre-compute fillet data for one edge on the original (unmodified) geometry.
 */
function _precomputeFilletEdge(faces, edgeKey, radius, segments, exactAdjacencyByKey = null) {
  const adj = (exactAdjacencyByKey && exactAdjacencyByKey.get(edgeKey)) || _findAdjacentFaces(faces, edgeKey);
  if (adj.length < 2) return null;

  const fi0 = adj[0].fi, fi1 = adj[1].fi;
  const face0 = faces[fi0];
  const face1 = faces[fi1];
  const edgeA = adj[0].a;
  const edgeB = adj[0].b;

  const face0Keys = _collectFaceEdgeKeys(face0);
  const face1Keys = _collectFaceEdgeKeys(face1);

  const { offsDir0, offsDir1, isConcave } = _computeOffsetDirs(face0, face1, edgeA, edgeB);

  const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
  if (alpha < 1e-6) return null;

  const tangentDist = radius / Math.tan(alpha / 2);
  const centerDist = radius / Math.sin(alpha / 2);
  const sweep = Math.PI - alpha;
  const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));
  const edgeDir = _vec3Normalize(_vec3Sub(edgeB, edgeA));

  const t0a = _vec3Add(edgeA, _vec3Scale(offsDir0, tangentDist));
  const t0b = _vec3Add(edgeB, _vec3Scale(offsDir0, tangentDist));
  const t1a = _vec3Add(edgeA, _vec3Scale(offsDir1, tangentDist));
  const t1b = _vec3Add(edgeB, _vec3Scale(offsDir1, tangentDist));

  function computeArc(vertex) {
    const center = _vec3Add(vertex, _vec3Scale(bisector, centerDist));
    const t0 = _vec3Add(vertex, _vec3Scale(offsDir0, tangentDist));
    const e0 = _vec3Normalize(_vec3Sub(t0, center));
    const t1 = _vec3Add(vertex, _vec3Scale(offsDir1, tangentDist));
    // Use NURBS arc tessellation to match EdgeSampler's parameterization.
    // This ensures polygon arc boundaries align exactly with NURBS edge samples.
    try {
      const nurbsArc = NurbsCurve.createArc(center, radius, e0, _vec3Cross(edgeDir, e0), 0, sweep);
      const tessPoints = nurbsArc.tessellate(segments);
      return tessPoints.map(p => ({ x: p.x, y: p.y, z: p.z }));
    } catch (e) {
      // Fallback to simple theta-based sampling if NURBS fails
      const e1 = _vec3Normalize(_vec3Sub(t1, center));
      const cosSweep = Math.cos(sweep);
      const sinSweep = Math.sin(sweep);
      const perp = sinSweep > 1e-10
        ? _vec3Scale(_vec3Sub(e1, _vec3Scale(e0, cosSweep)), 1 / sinSweep)
        : e1;
      const points = [];
      for (let s = 0; s <= segments; s++) {
        const theta = (s / segments) * sweep;
        points.push(_vec3Add(center, _vec3Add(
          _vec3Scale(e0, radius * Math.cos(theta)),
          _vec3Scale(perp, radius * Math.sin(theta))
        )));
      }
      return points;
    }
  }

  const arcA = computeArc(edgeA);
  const arcB = computeArc(edgeB);

  // p0a/p0b/p1a/p1b for trim compatibility with batch helpers
  return {
    edgeKey, fi0, fi1, edgeA, edgeB,
    face0Keys, face1Keys,
    p0a: t0a, p0b: t0b, p1a: t1a, p1b: t1b,
    arcA, arcB,
    isConcave,
    shared: face0.shared ? { ...face0.shared } : null,
  };
}

// -----------------------------------------------------------------------
// Batch chamfer/fillet helpers
// -----------------------------------------------------------------------

/**
 * Build a map of vertex key → list of edge data indices that share that vertex.
 */
function _buildVertexEdgeMap(edgeDataList) {
  const map = new Map();
  for (let i = 0; i < edgeDataList.length; i++) {
    const d = edgeDataList[i];
    const vkA = _edgeVKey(d.edgeA);
    const vkB = _edgeVKey(d.edgeB);
    if (!map.has(vkA)) map.set(vkA, []);
    if (!map.has(vkB)) map.set(vkB, []);
    map.get(vkA).push(i);
    map.get(vkB).push(i);
  }
  return map;
}

/**
 * Merge trimmed-vertex positions at shared vertices on common faces.
 *
 * When 2+ chamfer edges meet at a vertex and share a common face, each edge
 * independently offsets the vertex inward along the face.  Instead of producing
 * two separate trimmed positions (which creates a gap needing a corner face),
 * compute a single merged position that combines both offsets:
 *   mergedPos = originalVertex + sum(offset_i)
 * This places the vertex at the intersection of the bevel planes on the face.
 * If the p1 positions also converge (as on axis-aligned boxes), the corner
 * polygon degenerates and is automatically skipped.
 */
function _mergeSharedVertexPositions(edgeDataList, vertexEdgeMap) {
  for (const [vk, edgeIndices] of vertexEdgeMap) {
    if (edgeIndices.length < 2) continue;

    // Linear merged trim vertices are correct for chamfers and can help the
    // 2-edge fillet case, but they are wrong for a 3-edge rolling-ball
    // corner: they create fake planar points like (9,9,10) that leave a
    // residual loop later healed into sliver faces. Let the trihedron be
    // bounded only by the strip arcs in that case.
    const hasFillet = edgeIndices.some((di) => !!edgeDataList[di].arcA);
    if (hasFillet && edgeIndices.length >= 3) continue;

    // Get original vertex position
    const d0 = edgeDataList[edgeIndices[0]];
    const origV = _edgeVKey(d0.edgeA) === vk ? d0.edgeA : d0.edgeB;

    // Build face → contributions map
    const faceContribs = new Map();
    for (const di of edgeIndices) {
      const d = edgeDataList[di];
      const isA = _edgeVKey(d.edgeA) === vk;

      // fi0 contribution
      if (!faceContribs.has(d.fi0)) faceContribs.set(d.fi0, []);
      faceContribs.get(d.fi0).push({ di, side: 0, isA });

      // fi1 contribution
      if (!faceContribs.has(d.fi1)) faceContribs.set(d.fi1, []);
      faceContribs.get(d.fi1).push({ di, side: 1, isA });
    }

    // For each face shared by 2+ edges, compute the merged position
    for (const [, contribs] of faceContribs) {
      if (contribs.length < 2) continue;

      // Merged position = original vertex + sum of all (offset - V) contributions
      let mx = origV.x, my = origV.y, mz = origV.z;
      for (const c of contribs) {
        const d = edgeDataList[c.di];
        const pos = c.side === 0
          ? (c.isA ? d.p0a : d.p0b)
          : (c.isA ? d.p1a : d.p1b);
        mx += pos.x - origV.x;
        my += pos.y - origV.y;
        mz += pos.z - origV.z;
      }

      // Update each contributing edge's position to the merged value
      for (const c of contribs) {
        const d = edgeDataList[c.di];
        if (c.side === 0) {
          if (c.isA) d.p0a = { x: mx, y: my, z: mz };
          else d.p0b = { x: mx, y: my, z: mz };
        } else {
          if (c.isA) d.p1a = { x: mx, y: my, z: mz };
          else d.p1b = { x: mx, y: my, z: mz };
        }
      }
    }
  }
}

function _solvePlanarCoefficients(axis0, axis1, rel) {
  const g00 = _vec3Dot(axis0, axis0);
  const g01 = _vec3Dot(axis0, axis1);
  const g11 = _vec3Dot(axis1, axis1);
  const rhs0 = _vec3Dot(rel, axis0);
  const rhs1 = _vec3Dot(rel, axis1);
  const det = g00 * g11 - g01 * g01;
  if (Math.abs(det) < 1e-10) return null;
  return {
    u: (rhs0 * g11 - rhs1 * g01) / det,
    v: (rhs1 * g00 - rhs0 * g01) / det,
  };
}

function _samplePolyline(points, samples) {
  if (!points || points.length === 0) return [];
  if (points.length === 1 || samples <= 0) return [{ ...points[0] }];

  const lengths = [0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += _vec3Len(_vec3Sub(points[i], points[i - 1]));
    lengths.push(total);
  }
  if (total < 1e-10) {
    return Array.from({ length: samples + 1 }, () => ({ ...points[0] }));
  }

  const result = [];
  for (let i = 0; i <= samples; i++) {
    const target = (i / samples) * total;
    let seg = 1;
    while (seg < lengths.length && lengths[seg] < target) seg++;
    const lo = Math.max(0, seg - 1);
    const hi = Math.min(points.length - 1, seg);
    const segLen = lengths[hi] - lengths[lo];
    const t = segLen > 1e-10 ? (target - lengths[lo]) / segLen : 0;
    result.push(_vec3Lerp(points[lo], points[hi], t));
  }
  return result;
}

function _buildTwoEdgeFilletTrim(edgeInfo0, edgeInfo1, origFaces) {
  const data0 = edgeInfo0.data;
  const data1 = edgeInfo1.data;
  const commonFaces = [];
  for (const fi of [data0.fi0, data0.fi1]) {
    if (fi === data1.fi0 || fi === data1.fi1) commonFaces.push(fi);
  }
  if (commonFaces.length !== 1) return null;

  const commonFaceIndex = commonFaces[0];
  const commonFace = origFaces[commonFaceIndex];
  const faceNormal = _vec3Normalize(commonFace && commonFace.normal ? commonFace.normal : { x: 0, y: 0, z: 0 });
  if (_vec3Len(faceNormal) < 1e-10) return null;

  const orientedArc0 = commonFaceIndex === data0.fi0 ? edgeInfo0.arc : [...edgeInfo0.arc].reverse();
  const orientedArc1 = commonFaceIndex === data1.fi0 ? edgeInfo1.arc : [...edgeInfo1.arc].reverse();
  if (!orientedArc0 || !orientedArc1 || orientedArc0.length !== orientedArc1.length || orientedArc0.length < 2) {
    return null;
  }

  const sharedVertex = edgeInfo0.isA ? data0.edgeA : data0.edgeB;
  const other0 = edgeInfo0.isA ? data0.edgeB : data0.edgeA;
  const other1 = edgeInfo1.isA ? data1.edgeB : data1.edgeA;

  const axis0Raw = _vec3Sub(other0, sharedVertex);
  const axis1Raw = _vec3Sub(other1, sharedVertex);
  const axis0Plane = _vec3Sub(axis0Raw, _vec3Scale(faceNormal, _vec3Dot(axis0Raw, faceNormal)));
  const axis1Plane = _vec3Sub(axis1Raw, _vec3Scale(faceNormal, _vec3Dot(axis1Raw, faceNormal)));
  const axis0 = _vec3Normalize(axis0Plane);
  const axis1 = _vec3Normalize(axis1Plane);
  if (_vec3Len(axis0) < 1e-10 || _vec3Len(axis1) < 1e-10) return null;
  if (_vec3Len(_vec3Cross(axis0, axis1)) < 1e-6) return null;
  const planeNormal = _vec3Normalize(_vec3Sub(axis0, axis1));
  if (_vec3Len(planeNormal) < 1e-10) return null;

  const trim = [];
  for (let i = 0; i < orientedArc0.length; i++) {
    const rel0 = _vec3Sub(orientedArc0[i], sharedVertex);
    const rel1 = _vec3Sub(orientedArc1[i], sharedVertex);
    const w0 = _vec3Dot(rel0, faceNormal);
    const w1 = _vec3Dot(rel1, faceNormal);
    const plane0 = _vec3Sub(rel0, _vec3Scale(faceNormal, w0));
    const plane1 = _vec3Sub(rel1, _vec3Scale(faceNormal, w1));
    const coeff0 = _solvePlanarCoefficients(axis0, axis1, plane0);
    const coeff1 = _solvePlanarCoefficients(axis0, axis1, plane1);
    if (!coeff0 || !coeff1) return null;
    trim.push(_vec3Add(sharedVertex, _vec3Add(
      _vec3Add(_vec3Scale(axis0, coeff1.u), _vec3Scale(axis1, coeff0.v)),
      _vec3Scale(faceNormal, (w0 + w1) * 0.5)
    )));
  }

  const trimFor0 = commonFaceIndex === data0.fi0 ? trim : [...trim].reverse();
  const trimFor1 = commonFaceIndex === data1.fi0 ? trim : [...trim].reverse();
  return {
    trimFor0,
    trimFor1,
    planeOrigin: { ...sharedVertex },
    planeNormal,
  };
}

function _applyTwoEdgeFilletSharedTrims(edgeDataList, origFaces, vertexEdgeMap) {
  for (const [vk, edgeIndices] of vertexEdgeMap) {
    if (edgeIndices.length !== 2) continue;

    const data0 = edgeDataList[edgeIndices[0]];
    const data1 = edgeDataList[edgeIndices[1]];
    const edgeInfo0 = {
      data: data0,
      isA: _edgeVKey(data0.edgeA) === vk,
      arc: _edgeVKey(data0.edgeA) === vk ? data0.arcA : data0.arcB,
    };
    const edgeInfo1 = {
      data: data1,
      isA: _edgeVKey(data1.edgeA) === vk,
      arc: _edgeVKey(data1.edgeA) === vk ? data1.arcA : data1.arcB,
    };
    if (!edgeInfo0.arc || !edgeInfo1.arc) continue;

    const trimInfo = _buildTwoEdgeFilletTrim(edgeInfo0, edgeInfo1, origFaces);
    if (!trimInfo) continue;

    if (edgeInfo0.isA) edgeInfo0.data.sharedTrimA = trimInfo.trimFor0;
    else edgeInfo0.data.sharedTrimB = trimInfo.trimFor0;
    if (edgeInfo1.isA) edgeInfo1.data.sharedTrimA = trimInfo.trimFor1;
    else edgeInfo1.data.sharedTrimB = trimInfo.trimFor1;

    if (edgeInfo0.isA) {
      edgeInfo0.data._sharedTrimPlaneAOrigin = { ...trimInfo.planeOrigin };
      edgeInfo0.data._sharedTrimPlaneANormal = { ...trimInfo.planeNormal };
    } else {
      edgeInfo0.data._sharedTrimPlaneBOrigin = { ...trimInfo.planeOrigin };
      edgeInfo0.data._sharedTrimPlaneBNormal = { ...trimInfo.planeNormal };
    }
    if (edgeInfo1.isA) {
      edgeInfo1.data._sharedTrimPlaneAOrigin = { ...trimInfo.planeOrigin };
      edgeInfo1.data._sharedTrimPlaneANormal = { ...trimInfo.planeNormal };
    } else {
      edgeInfo1.data._sharedTrimPlaneBOrigin = { ...trimInfo.planeOrigin };
      edgeInfo1.data._sharedTrimPlaneBNormal = { ...trimInfo.planeNormal };
    }
  }
}

function _curveFromSampledPoints(points) {
  if (!points || points.length < 2) return null;
  if (points.length === 2) return NurbsCurve.createLine(points[0], points[1]);
  return NurbsCurve.createPolyline(points);
}

function _openPolylineNormal(points) {
  if (!points || points.length < 3) return null;
  const origin = points[0];
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = _vec3Sub(points[i], origin);
    const b = _vec3Sub(points[i + 1], origin);
    const c = _vec3Cross(a, b);
    nx += c.x;
    ny += c.y;
    nz += c.z;
  }
  const normal = { x: nx, y: ny, z: nz };
  return _vec3Len(normal) > 1e-10 ? _vec3Normalize(normal) : null;
}

function _createExactCylinderPlaneTrimCurve(
  points,
  axisStart,
  axisEnd,
  radius,
  planeOriginOverride = null,
  planeNormalOverride = null,
) {
  if (!points || points.length < 2 || !axisStart || !axisEnd || !Number.isFinite(radius) || radius <= 0) {
    return null;
  }
  if (points.length === 2) return NurbsCurve.createLine(points[0], points[1]);

  const planeOrigin = planeOriginOverride || points[0];
  const planeNormal = planeNormalOverride ? _vec3Normalize(planeNormalOverride) : _openPolylineNormal(points);
  if (!planeNormal) return null;

  let maxPlaneResidual = 0;
  for (const point of points) {
    const planeDist = Math.abs(_vec3Dot(planeNormal, _vec3Sub(point, planeOrigin)));
    if (planeDist > maxPlaneResidual) maxPlaneResidual = planeDist;
  }
  if (maxPlaneResidual > 1e-4) return null;

  const axisDir = _vec3Normalize(_vec3Sub(axisEnd, axisStart));
  if (_vec3Len(axisDir) < 1e-10) return null;

  const axisDot = _vec3Dot(planeNormal, axisDir);
  if (Math.abs(axisDot) < 1e-6) return null;

  const t = _vec3Dot(planeNormal, _vec3Sub(planeOrigin, axisStart)) / axisDot;
  const center = _vec3Add(axisStart, _vec3Scale(axisDir, t));
  const majorVector = _vec3Sub(axisDir, _vec3Scale(planeNormal, axisDot));
  const majorDir = _vec3Normalize(majorVector);
  if (_vec3Len(majorDir) < 1e-10) return null;

  const semiMajor = radius / Math.abs(axisDot);
  const semiMinor = radius;
  const baseMinorDir = _vec3Normalize(_vec3Cross(planeNormal, majorDir));
  if (_vec3Len(baseMinorDir) < 1e-10) return null;

  const evaluatePoint = (minorDir, angle) => _vec3Add(center, _vec3Add(
    _vec3Scale(majorDir, semiMajor * Math.cos(angle)),
    _vec3Scale(minorDir, semiMinor * Math.sin(angle)),
  ));

  const buildCandidate = (minorDir) => {
    const angles = [];
    let prevAngle = null;
    let maxEllipseResidual = 0;
    let maxPointResidual = 0;
    let monotonicSign = 0;
    let monotonic = true;

    for (const point of points) {
      const rel = _vec3Sub(point, center);
      const u = _vec3Dot(rel, majorDir) / semiMajor;
      const v = _vec3Dot(rel, minorDir) / semiMinor;
      maxEllipseResidual = Math.max(maxEllipseResidual, Math.abs(u * u + v * v - 1));

      let angle = Math.atan2(v, u);
      if (prevAngle != null) {
        while (angle - prevAngle > Math.PI) angle -= 2 * Math.PI;
        while (angle - prevAngle < -Math.PI) angle += 2 * Math.PI;
        const diff = angle - prevAngle;
        if (Math.abs(diff) > 1e-8) {
          const sign = diff > 0 ? 1 : -1;
          if (monotonicSign === 0) monotonicSign = sign;
          else if (sign !== monotonicSign) monotonic = false;
        }
      }
      angles.push(angle);
      prevAngle = angle;

      const fitPoint = evaluatePoint(minorDir, angle);
      maxPointResidual = Math.max(maxPointResidual, _vec3Len(_vec3Sub(fitPoint, point)));
    }

    return {
      minorDir,
      startAngle: angles[0],
      sweepAngle: angles[angles.length - 1] - angles[0],
      maxEllipseResidual,
      maxPointResidual,
      monotonic,
    };
  };

  const candidates = [
    buildCandidate(baseMinorDir),
    buildCandidate(_vec3Scale(baseMinorDir, -1)),
  ].filter((candidate) => candidate.monotonic && Math.abs(candidate.sweepAngle) > 1e-6);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) =>
    (a.maxPointResidual + a.maxEllipseResidual) - (b.maxPointResidual + b.maxEllipseResidual));
  const best = candidates[0];
  if (best.maxPointResidual > 1e-4 || best.maxEllipseResidual > 1e-4) return null;

  return NurbsCurve.createEllipseArc(
    center,
    semiMajor,
    semiMinor,
    majorDir,
    best.minorDir,
    best.startAngle,
    best.sweepAngle,
  );
}

function _buildExactFilletBoundaryCurve(data, points, side, isSharedTrim) {
  if (!points || points.length < 2) return null;
  if (isSharedTrim) {
    const exactSharedCurve = side === 'A'
      ? data && data._exactSharedTrimCurveA
      : data && data._exactSharedTrimCurveB;
    if (exactSharedCurve) return exactSharedCurve.clone();
    return _createExactCylinderPlaneTrimCurve(
      points,
      data && data._exactAxisStart,
      data && data._exactAxisEnd,
      data && data._exactRadius,
      side === 'A'
        ? data && data._sharedTrimPlaneAOrigin
        : data && data._sharedTrimPlaneBOrigin,
      side === 'A'
        ? data && data._sharedTrimPlaneANormal
        : data && data._sharedTrimPlaneBNormal,
    ) || _curveFromSampledPoints(points);
  }

  const exactArc = side === 'A' ? data && data._exactArcCurveA : data && data._exactArcCurveB;
  if (exactArc) return exactArc.clone();
  return _curveFromSampledPoints(points);
}

function _sampleExactEdgePoints(edge, segments = 8) {
  if (!edge || typeof edge.tessellate !== 'function') return [];
  const curve = edge.curve || null;
  const isLinearCurve = !curve || (
    curve.degree === 1 &&
    Array.isArray(curve.controlPoints) &&
    curve.controlPoints.length === 2
  );
  const sampleCount = isLinearCurve ? 1 : segments;
  return edge.tessellate(sampleCount).map((point) => _canonicalPoint(point));
}

function _buildExactFeatureEdgesFromTopoBody(topoBody, faces, edgeSegments = 16) {
  if (!topoBody || !topoBody.shells || !Array.isArray(faces) || faces.length === 0) {
    return { edges: [], paths: [] };
  }

  const repFaceIndexByTopoFaceId = _buildRepFaceIndexByTopoFaceId(faces);

  const edges = [];
  for (const shell of topoBody.shells) {
    for (const edge of shell.edges()) {
      const points = _sampleExactEdgePoints(edge, edgeSegments);
      if (points.length < 2) continue;

      const topoFaceIds = edge.coedges
        .map((coedge) => coedge && coedge.face ? coedge.face.id : undefined)
        .filter((id) => id !== undefined);
      const faceIndices = topoFaceIds
        .map((topoFaceId) => repFaceIndexByTopoFaceId.get(topoFaceId))
        .filter((index) => index !== undefined);
      if (faceIndices.length === 0) continue;

      const hasFillet = faceIndices.some((fi) => !!faces[fi]?.isFillet);
      const hasNonFillet = faceIndices.some((fi) => !faces[fi]?.isFillet);

      edges.push({
        start: { ...points[0] },
        end: { ...points[points.length - 1] },
        points,
        faceIndices,
        normals: faceIndices.map((fi) => faces[fi].normal),
        type: hasFillet && hasNonFillet ? 'fillet-boundary' : 'sharp',
      });
    }
  }

  return { edges, paths: _chainEdgePaths(edges) };
}

function _buildExactEdgeAdjacencyLookupFromTopoBody(topoBody, faces, edgeSegments = 8) {
  if (!topoBody || !topoBody.shells || !Array.isArray(faces) || faces.length === 0) {
    return null;
  }

  const repFaceIndexByTopoFaceId = _buildRepFaceIndexByTopoFaceId(faces);
  if (repFaceIndexByTopoFaceId.size === 0) return null;

  const adjacencyByKey = new Map();
  for (const shell of topoBody.shells) {
    for (const edge of shell.edges()) {
      const samples = _sampleExactEdgePoints(edge, edgeSegments);
      if (samples.length < 2) continue;

      const vertexStart = edge.startVertex && edge.startVertex.point
        ? _canonicalPoint(edge.startVertex.point)
        : null;
      const vertexEnd = edge.endVertex && edge.endVertex.point
        ? _canonicalPoint(edge.endVertex.point)
        : null;
      const startPoint = vertexStart || samples[0];
      const endPoint = vertexEnd || samples[samples.length - 1];
      if (!startPoint || !endPoint) continue;

      const entries = [];
      for (const coedge of edge.coedges || []) {
        const topoFaceId = coedge && coedge.face ? coedge.face.id : undefined;
        const fi = repFaceIndexByTopoFaceId.get(topoFaceId);
        if (fi === undefined) continue;
        const sameSense = !coedge || coedge.sameSense !== false;
        entries.push({
          fi,
          a: sameSense ? { ...startPoint } : { ...endPoint },
          b: sameSense ? { ...endPoint } : { ...startPoint },
        });
      }
      if (entries.length < 2) continue;

      const addAdjacency = (key) => {
        if (!key || adjacencyByKey.has(key)) return;
        adjacencyByKey.set(key, entries.map((entry) => ({
          fi: entry.fi,
          a: { ...entry.a },
          b: { ...entry.b },
        })));
      };

      addAdjacency(_edgeKeyFromVerts(startPoint, endPoint));
      addAdjacency(_edgeKeyFromVerts(samples[0], samples[samples.length - 1]));
    }
  }

  return adjacencyByKey;
}

function _countMeshEdgeUsage(faces) {
  if (!Array.isArray(faces) || faces.length === 0) {
    return { boundaryCount: 0, nonManifoldCount: 0 };
  }
  const edgeCounts = new Map();
  for (const face of faces) {
    const vertices = face && Array.isArray(face.vertices) ? face.vertices : [];
    for (let i = 0; i < vertices.length; i++) {
      const edgeKey = _edgeKeyFromVerts(vertices[i], vertices[(i + 1) % vertices.length]);
      edgeCounts.set(edgeKey, (edgeCounts.get(edgeKey) || 0) + 1);
    }
  }
  let boundaryCount = 0;
  let nonManifoldCount = 0;
  for (const count of edgeCounts.values()) {
    if (count === 1) boundaryCount += 1;
    else if (count > 2) nonManifoldCount += 1;
  }
  return { boundaryCount, nonManifoldCount };
}

function _countMeshBoundaryEdges(faces) {
  return _countMeshEdgeUsage(faces).boundaryCount;
}

function _pathEndpointPoints(edges, path) {
  if (!path || path.isClosed || !Array.isArray(path.edgeIndices) || path.edgeIndices.length === 0) {
    return null;
  }

  const counts = new Map();
  const points = new Map();
  for (const edgeIndex of path.edgeIndices) {
    const edge = edges[edgeIndex];
    if (!edge) continue;
    for (const point of [edge.start, edge.end]) {
      const key = _edgeVKey(point);
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!points.has(key)) points.set(key, point);
    }
  }

  const endpoints = [];
  for (const [key, count] of counts) {
    if (count === 1 && points.has(key)) endpoints.push(points.get(key));
  }
  return endpoints.length === 2 ? endpoints : null;
}

function _pathFaceGroupKey(edges, path, faces) {
  const groups = new Set();
  if (!path || !Array.isArray(path.edgeIndices)) return '';

  for (const edgeIndex of path.edgeIndices) {
    const edge = edges[edgeIndex];
    if (!edge || !Array.isArray(edge.faceIndices)) continue;
    for (const fi of edge.faceIndices) {
      const group = faces[fi] && faces[fi].faceGroup;
      if (group !== undefined && group !== null) groups.add(group);
    }
  }

  return [...groups].sort((a, b) => a - b).join('|');
}

function _pathFeatureKind(edges, path, faces) {
  let hasFillet = false;
  let hasNonFillet = false;
  let hasBoundary = false;
  if (!path || !Array.isArray(path.edgeIndices)) return 'sharp';

  for (const edgeIndex of path.edgeIndices) {
    const edge = edges[edgeIndex];
    if (!edge) continue;
    if (edge.type === 'fillet-boundary') return 'fillet-boundary';
    if (Array.isArray(edge.faceIndices) && edge.faceIndices.length === 1) hasBoundary = true;
    for (const fi of edge.faceIndices || []) {
      const face = faces[fi];
      if (!face) continue;
      if (face.isFillet) hasFillet = true;
      else hasNonFillet = true;
    }
  }

  if (hasFillet && hasNonFillet) return 'fillet-boundary';
  if (hasBoundary) return 'boundary';
  return 'sharp';
}

function _mergeExactAndFallbackFeatureEdges(faces, exactEdgeResult, fallbackEdgeResult, endpointTolerance = 1e-4) {
  if (!fallbackEdgeResult || !Array.isArray(fallbackEdgeResult.edges) || fallbackEdgeResult.edges.length === 0) {
    return exactEdgeResult && Array.isArray(exactEdgeResult.edges) ? exactEdgeResult : { edges: [], paths: [] };
  }
  if (!exactEdgeResult || !Array.isArray(exactEdgeResult.edges) || exactEdgeResult.edges.length === 0) {
    return fallbackEdgeResult;
  }

  const maxEndpointDistSq = endpointTolerance * endpointTolerance * 2;
  const exactPaths = Array.isArray(exactEdgeResult.paths) ? exactEdgeResult.paths : _chainEdgePaths(exactEdgeResult.edges);
  const fallbackPaths = Array.isArray(fallbackEdgeResult.paths) ? fallbackEdgeResult.paths : _chainEdgePaths(fallbackEdgeResult.edges);

  const exactPathDescriptors = exactPaths.map((path, index) => ({
    index,
    path,
    faceGroupKey: _pathFaceGroupKey(exactEdgeResult.edges, path, faces),
    endpoints: _pathEndpointPoints(exactEdgeResult.edges, path),
    kind: _pathFeatureKind(exactEdgeResult.edges, path, faces),
  }));

  const usedExactPathIndices = new Set();
  const mergedEdges = [];

  for (const fallbackPath of fallbackPaths) {
    const fallbackFaceGroupKey = _pathFaceGroupKey(fallbackEdgeResult.edges, fallbackPath, faces);
    const fallbackEndpoints = _pathEndpointPoints(fallbackEdgeResult.edges, fallbackPath);
    const fallbackKind = _pathFeatureKind(fallbackEdgeResult.edges, fallbackPath, faces);

    let matchedExactDescriptor = null;
    let bestEndpointScore = Infinity;
    if (fallbackEndpoints && fallbackFaceGroupKey) {
      for (const descriptor of exactPathDescriptors) {
        if (usedExactPathIndices.has(descriptor.index)) continue;
        if (!descriptor.endpoints) continue;
        if (descriptor.faceGroupKey !== fallbackFaceGroupKey) continue;

        const forwardA = _vec3Sub(fallbackEndpoints[0], descriptor.endpoints[0]);
        const forwardB = _vec3Sub(fallbackEndpoints[1], descriptor.endpoints[1]);
        const reverseA = _vec3Sub(fallbackEndpoints[0], descriptor.endpoints[1]);
        const reverseB = _vec3Sub(fallbackEndpoints[1], descriptor.endpoints[0]);
        const forwardScore = _vec3Dot(forwardA, forwardA) + _vec3Dot(forwardB, forwardB);
        const reverseScore = _vec3Dot(reverseA, reverseA) + _vec3Dot(reverseB, reverseB);
        const endpointScore = Math.min(forwardScore, reverseScore);
        if (endpointScore <= maxEndpointDistSq && endpointScore < bestEndpointScore) {
          bestEndpointScore = endpointScore;
          matchedExactDescriptor = descriptor;
        }
      }
    }

    if (!matchedExactDescriptor && fallbackEndpoints && fallbackKind === 'fillet-boundary') {
      for (const descriptor of exactPathDescriptors) {
        if (usedExactPathIndices.has(descriptor.index)) continue;
        if (!descriptor.endpoints) continue;
        if (descriptor.kind !== fallbackKind) continue;

        const forwardA = _vec3Sub(fallbackEndpoints[0], descriptor.endpoints[0]);
        const forwardB = _vec3Sub(fallbackEndpoints[1], descriptor.endpoints[1]);
        const reverseA = _vec3Sub(fallbackEndpoints[0], descriptor.endpoints[1]);
        const reverseB = _vec3Sub(fallbackEndpoints[1], descriptor.endpoints[0]);
        const forwardScore = _vec3Dot(forwardA, forwardA) + _vec3Dot(forwardB, forwardB);
        const reverseScore = _vec3Dot(reverseA, reverseA) + _vec3Dot(reverseB, reverseB);
        const endpointScore = Math.min(forwardScore, reverseScore);
        if (endpointScore <= maxEndpointDistSq && endpointScore < bestEndpointScore) {
          bestEndpointScore = endpointScore;
          matchedExactDescriptor = descriptor;
        }
      }
    }

    if (matchedExactDescriptor) {
      usedExactPathIndices.add(matchedExactDescriptor.index);
      for (const edgeIndex of matchedExactDescriptor.path.edgeIndices || []) {
        const edge = exactEdgeResult.edges[edgeIndex];
        if (edge) mergedEdges.push(edge);
      }
      continue;
    }

    for (const edgeIndex of fallbackPath.edgeIndices || []) {
      const edge = fallbackEdgeResult.edges[edgeIndex];
      if (edge) mergedEdges.push(edge);
    }
  }

  return {
    edges: mergedEdges,
    paths: _chainEdgePaths(mergedEdges),
  };
}

function _extractFeatureFacesFromTopoBody(geometry) {
  if (!geometry || !geometry.topoBody || !Array.isArray(geometry.topoBody.shells)) {
    return Array.isArray(geometry && geometry.faces) ? geometry.faces : [];
  }

  const extracted = [];
  for (const shell of geometry.topoBody.shells) {
    for (const topoFace of shell.faces || []) {
      if (!topoFace || !topoFace.outerLoop || !Array.isArray(topoFace.outerLoop.coedges)) continue;
      const vertices = [];
      for (const coedge of topoFace.outerLoop.coedges) {
        let samples = coedge && coedge.edge
          ? _sampleExactEdgePoints(coedge.edge, 8)
          : [];
        if (coedge && coedge.sameSense === false) samples = samples.reverse();
        if (vertices.length > 0 && samples.length > 0) samples = samples.slice(1);
        vertices.push(...samples);
      }
      if (vertices.length > 1) {
        const first = vertices[0];
        const last = vertices[vertices.length - 1];
        if (_vec3Len(_vec3Sub(first, last)) < 1e-8) vertices.pop();
      }
      if (!Array.isArray(vertices) || vertices.length < 3) continue;
      let normal = _computePolygonNormal(vertices);
      if ((!normal || _vec3Len(normal) < 1e-10) && topoFace.surface && typeof topoFace.surface.normal === 'function') {
        const u = (topoFace.surface.uMin + topoFace.surface.uMax) * 0.5;
        const v = (topoFace.surface.vMin + topoFace.surface.vMax) * 0.5;
        try {
          normal = topoFace.surface.normal(u, v);
          if (topoFace.sameSense === false) {
            normal = { x: -normal.x, y: -normal.y, z: -normal.z };
          }
        } catch (_e) {
          normal = null;
        }
      }
      const faceData = {
        vertices: vertices.map((vertex) => ({ x: vertex.x, y: vertex.y, z: vertex.z })),
        normal: normal && _vec3Len(normal) > 1e-10 ? _vec3Normalize(normal) : { x: 0, y: 0, z: 1 },
        shared: topoFace.shared ? { ...topoFace.shared } : null,
        isFillet: !!(topoFace.shared && topoFace.shared.isFillet),
        isCorner: !!(topoFace.shared && topoFace.shared.isCorner),
        surfaceType: topoFace.surfaceType,
        faceGroup: topoFace.id,
        topoFaceId: topoFace.id,
      };
      // Extract cylinder metadata from shared for fillet-fillet intersection detection
      if (topoFace.shared && topoFace.shared._exactAxisStart) {
        faceData._exactAxisStart = { ...topoFace.shared._exactAxisStart };

      }
      if (topoFace.shared && topoFace.shared._exactAxisEnd) {
        faceData._exactAxisEnd = { ...topoFace.shared._exactAxisEnd };
      }
      if (topoFace.shared && topoFace.shared._exactRadius) {
        faceData._exactRadius = topoFace.shared._exactRadius;
      }
      extracted.push(faceData);
    }
  }

  return extracted.length > 0
    ? extracted
    : (Array.isArray(geometry.faces) ? geometry.faces : []);
}

function _cloneMeshFace(face) {
  if (!face) return face;
  return {
    ...face,
    vertices: Array.isArray(face.vertices)
      ? face.vertices.map((vertex) => _canonicalPoint(vertex))
      : [],
    normal: face.normal ? _vec3Normalize(face.normal) : face.normal,
    shared: face.shared ? { ...face.shared } : face.shared,
    topoFaceIds: Array.isArray(face.topoFaceIds) ? [...face.topoFaceIds] : face.topoFaceIds,
  };
}

function _replaceFallbackPlanarFacesWithExactTopoFaces(fallbackFaces, topoBody) {
  if (!Array.isArray(fallbackFaces) || !topoBody) return fallbackFaces;

  const exactFaces = _extractFeatureFacesFromTopoBody({ topoBody, faces: [] });
  if (!Array.isArray(exactFaces) || exactFaces.length === 0) return fallbackFaces;

  const exactPlanarFaces = exactFaces
    .filter((face) =>
      face &&
      !face.isFillet &&
      !face.isCorner &&
      face.surfaceType === SurfaceType.PLANE &&
      Array.isArray(face.vertices) &&
      face.vertices.length >= 3 &&
      face.topoFaceId !== undefined)
    .map((face) => _cloneMeshFace(face));

  if (exactPlanarFaces.length === 0) return fallbackFaces;

  const replacedTopoFaceIds = new Set(
    exactPlanarFaces
      .map((face) => face.topoFaceId)
      .filter((topoFaceId) => topoFaceId !== undefined)
  );

  const preservedFaces = [];
  for (const face of fallbackFaces) {
    if (!face) continue;
    const topoFaceIds = _collectFaceTopoFaceIds(face);
    const replacesFace = topoFaceIds.some((topoFaceId) => replacedTopoFaceIds.has(topoFaceId));
    if (replacesFace) continue;
    preservedFaces.push(_cloneMeshFace(face));
  }

  return [...preservedFaces, ...exactPlanarFaces];
}

function _applyTopoFaceIdsToFallbackMesh(faces, topoBody, edgeDataList = []) {
  if (!Array.isArray(faces) || !topoBody || !Array.isArray(topoBody.shells) || topoBody.shells.length === 0) {
    return faces;
  }

  const shellFaces = topoBody.shells[0].faces || [];
  if (shellFaces.length === 0) return faces;

  const annotated = faces.map((face) => ({
    ...face,
    vertices: Array.isArray(face.vertices) ? face.vertices.map((vertex) => _canonicalPoint(vertex)) : [],
  }));

  let topoOrdinal = 0;
  for (let i = 0; i < annotated.length; i++) {
    const face = annotated[i];
    if (!face || face.isFillet) continue;
    const topoFace = shellFaces[topoOrdinal++];
    if (!topoFace) break;
    face.topoFaceId = topoFace.id;
    face.faceGroup = topoFace.id;
    face.surfaceType = topoFace.surfaceType;
  }

  const filletFaceOffset = topoOrdinal;
  const filletTopoFaceIds = new Map();
  for (let dataIndex = 0; dataIndex < edgeDataList.length; dataIndex++) {
    const topoFace = shellFaces[filletFaceOffset + dataIndex];
    if (!topoFace) continue;
    filletTopoFaceIds.set(dataIndex, topoFace.id);
  }

  for (const face of annotated) {
    if (!face || !face.isFillet) continue;
    const topoFaceId = filletTopoFaceIds.get(face._exactFilletFaceOrdinal);
    if (topoFaceId === undefined) continue;
    face.topoFaceId = topoFaceId;
    face.faceGroup = topoFaceId;
    face.surfaceType = SurfaceType.BSPLINE;
  }

  return annotated;
}

function _buildPlanarBoundarySegments(vertices, edgeDataList) {
  if (!Array.isArray(vertices) || vertices.length < 3) return null;
  const loopKeys = vertices.map((vertex) => _edgeVKey(vertex));
  const candidates = [];

  const registerCandidate = (points, curve) => {
    if (!points || points.length <= 2 || !curve) return;
    candidates.push({
      keys: points.map((point) => _edgeVKey(point)),
      curve,
    });
  };

  for (const data of edgeDataList || []) {
    if (!data) continue;
    if (!data.sharedTrimA) registerCandidate(data.arcA, data._exactArcCurveA);
    if (!data.sharedTrimB) registerCandidate(data.arcB, data._exactArcCurveB);
  }

  const matchesCandidate = (startIndex, candidateKeys) => {
    for (let i = 0; i < candidateKeys.length; i++) {
      if (loopKeys[(startIndex + i) % loopKeys.length] !== candidateKeys[i]) return false;
    }
    return true;
  };

  const segments = [];
  let edgeCount = 0;
  let index = 0;
  while (edgeCount < vertices.length) {
    let best = null;

    for (const candidate of candidates) {
      const len = candidate.keys.length;
      if (len <= 2 || len > vertices.length) continue;

      if (matchesCandidate(index, candidate.keys)) {
        if (!best || len > best.len) {
          best = { len, curve: candidate.curve.clone() };
        }
      }

      const reversedKeys = [...candidate.keys].reverse();
      if (matchesCandidate(index, reversedKeys)) {
        if (!best || len > best.len) {
          best = { len, curve: candidate.curve.reversed() };
        }
      }
    }

    if (best) {
      segments.push({
        start: { ...vertices[index] },
        curve: best.curve,
      });
      edgeCount += best.len - 1;
      index = (index + best.len - 1) % vertices.length;
      continue;
    }

    const nextIndex = (index + 1) % vertices.length;
    segments.push({
      start: { ...vertices[index] },
      curve: NurbsCurve.createLine(vertices[index], vertices[nextIndex]),
    });
    edgeCount += 1;
    index = nextIndex;
  }

  return segments.length > 0 ? segments : null;
}

function _buildPlanarFaceDesc(face, edgeDataList = null) {
  if (!face || !face.vertices || face.vertices.length < 3) return null;

  let surface = null;
  try {
    surface = NurbsSurface.createPlane(
      face.vertices[0],
      _vec3Sub(face.vertices[1], face.vertices[0]),
      _vec3Sub(face.vertices[face.vertices.length - 1], face.vertices[0]),
    );
  } catch (_) {
    surface = null;
  }

  const boundarySegments = _buildPlanarBoundarySegments(face.vertices, edgeDataList);
  const boundaryVertices = boundarySegments
    ? boundarySegments.map((segment) => ({ ...segment.start }))
    : face.vertices.map((vertex) => ({ ...vertex }));

  return {
    surface,
    surfaceType: SurfaceType.PLANE,
    vertices: boundaryVertices,
    edgeCurves: boundarySegments
      ? boundarySegments.map((segment) => segment.curve)
      : face.vertices.map((vertex, index) =>
        NurbsCurve.createLine(vertex, face.vertices[(index + 1) % face.vertices.length])),
    shared: face.shared ? { ...face.shared } : null,
  };
}

function _buildExactFilletFaceDesc(data) {
  const surface = data && data._exactSurface ? data._exactSurface : null;
  const trimA = data && (data.sharedTrimA || data.arcA);
  const trimB = data && (data.sharedTrimB || data.arcB);
  if (!surface || !trimA || !trimB || trimA.length < 2 || trimB.length < 2) return null;

  const denseBoundary = [
    ...trimA.map((point) => ({ ...point })),
    ...[...trimB].reverse().map((point) => ({ ...point })),
  ];

  let vertices = [
    { ...trimA[0] },
    { ...trimA[trimA.length - 1] },
    { ...trimB[trimB.length - 1] },
    { ...trimB[0] },
  ];
  let edgeCurves = [
    _buildExactFilletBoundaryCurve(data, trimA, 'A', !!(data && data.sharedTrimA)),
    NurbsCurve.createLine(trimA[trimA.length - 1], trimB[trimB.length - 1]),
    _buildExactFilletBoundaryCurve(data, trimB, 'B', !!(data && data.sharedTrimB)),
    NurbsCurve.createLine(trimB[0], trimA[0]),
  ];
  if (!edgeCurves[0] || !edgeCurves[2]) return null;
  edgeCurves[2] = edgeCurves[2].reversed();

  let outwardNormal = null;
  if (trimA.length >= 2 && trimB.length >= 2) {
    outwardNormal = _computePolygonNormal([
      { ...trimA[0] },
      { ...trimA[1] },
      { ...trimB[1] },
      { ...trimB[0] },
    ]);
  }
  const surfaceNormal = surface.normal(
    (surface.uMin + surface.uMax) * 0.5,
    (surface.vMin + surface.vMax) * 0.5,
  );
  const loopNormal = _computePolygonNormal(denseBoundary);
  if (outwardNormal && loopNormal && _vec3Dot(loopNormal, outwardNormal) < 0) {
    vertices = [...vertices].reverse();
    edgeCurves = [...edgeCurves].reverse().map((curve) => curve.reversed());
  }
  const sameSense = !(surfaceNormal && outwardNormal)
    ? true
    : _vec3Dot(outwardNormal, surfaceNormal) >= 0;

  // Build shared metadata including cylinder axis/radius for fillet-fillet intersection detection
  const sharedData = {
    ...(data.shared || {}),
    isFillet: true,
  };
  // Preserve cylinder metadata for sequential fillet operations
  if (data._exactAxisStart) sharedData._exactAxisStart = { ...data._exactAxisStart };
  if (data._exactAxisEnd) sharedData._exactAxisEnd = { ...data._exactAxisEnd };
  if (data._exactRadius) sharedData._exactRadius = data._exactRadius;

  return {
    surface,
    surfaceType: SurfaceType.BSPLINE,
    vertices,
    edgeCurves,
    sameSense,
    shared: sharedData,
  };
}

function _buildExactCornerPatchFaceDesc(cornerGroup) {
  if (!cornerGroup || cornerGroup.length === 0) return null;
  const patch = cornerGroup[0]._cornerPatch;
  if (!patch) return null;

  let surface = null;
  try {
    surface = NurbsSurface.createCornerBlendPatch(
      patch.top0, patch.top1,
      patch.side0Mid, patch.side1Mid,
      patch.apex, patch.centerPoint,
      patch.topMid,
    );
  } catch (_) {
    surface = null;
  }

  const hasTopMid = patch.topMid &&
    _edgeVKey(patch.topMid) !== _edgeVKey(patch.top0) &&
    _edgeVKey(patch.topMid) !== _edgeVKey(patch.top1);

  let vertices, edgeCurves;
  if (hasTopMid) {
    vertices = [
      { ...patch.top0 }, { ...patch.topMid },
      { ...patch.top1 }, { ...patch.apex },
    ];
    edgeCurves = [
      NurbsCurve.createLine(patch.top0, patch.topMid),
      NurbsCurve.createLine(patch.topMid, patch.top1),
      NurbsCurve.createLine(patch.top1, patch.apex),
      NurbsCurve.createLine(patch.apex, patch.top0),
    ];
  } else {
    vertices = [
      { ...patch.top0 }, { ...patch.top1 }, { ...patch.apex },
    ];
    edgeCurves = [
      NurbsCurve.createLine(patch.top0, patch.top1),
      NurbsCurve.createLine(patch.top1, patch.apex),
      NurbsCurve.createLine(patch.apex, patch.top0),
    ];
  }

  const polyNormal = _computePolygonNormal(vertices);
  let sameSense = true;
  if (surface && polyNormal) {
    const surfNormal = surface.normal(
      (surface.uMin + surface.uMax) * 0.5,
      (surface.vMin + surface.vMax) * 0.5,
    );
    if (surfNormal) sameSense = _vec3Dot(polyNormal, surfNormal) >= 0;
  }

  return {
    surface,
    surfaceType: surface ? SurfaceType.BSPLINE : SurfaceType.PLANE,
    vertices,
    edgeCurves,
    sameSense,
    shared: cornerGroup[0].shared ? { ...cornerGroup[0].shared, isCorner: true } : { isCorner: true },
  };
}

function _buildExactTrihedronFaceDesc(cornerGroup) {
  if (!cornerGroup || cornerGroup.length === 0) return null;
  const triVerts = cornerGroup[0]._triVerts;
  if (!triVerts || triVerts.length !== 3) return null;

  const sphereCenter = cornerGroup.find(f => f._sphereCenter)?._sphereCenter;
  const sphereRadius = cornerGroup.find(f => f._sphereRadius > 0)?._sphereRadius || 0;

  let surface = null;
  if (sphereCenter && sphereRadius > 1e-10) {
    try {
      surface = NurbsSurface.createSphericalPatch(
        sphereCenter, sphereRadius, triVerts[0], triVerts[1], triVerts[2],
      );
    } catch (_) {
      surface = null;
    }
  }

  const vertices = triVerts.map(v => ({ ...v }));
  const edgeCurves = [
    NurbsCurve.createLine(triVerts[0], triVerts[1]),
    NurbsCurve.createLine(triVerts[1], triVerts[2]),
    NurbsCurve.createLine(triVerts[2], triVerts[0]),
  ];

  const polyNormal = _computePolygonNormal(vertices);
  let sameSense = true;
  if (surface && polyNormal) {
    const surfNormal = surface.normal(
      (surface.uMin + surface.uMax) * 0.5,
      (surface.vMin + surface.vMax) * 0.5,
    );
    if (surfNormal) sameSense = _vec3Dot(polyNormal, surfNormal) >= 0;
  }

  return {
    surface,
    surfaceType: surface ? SurfaceType.SPHERE : SurfaceType.PLANE,
    vertices,
    edgeCurves,
    sameSense,
    shared: cornerGroup[0].shared ? { ...cornerGroup[0].shared, isCorner: true } : { isCorner: true },
  };
}

function _buildExactCornerFaceDescs(faces) {
  const descs = [];

  // Group two-edge corner patches by _cornerPatchKey
  const patchGroups = new Map();
  // Group trihedron corners by sorted _triVerts key
  const trihedronGroups = new Map();
  // Collect standalone corner faces with neither metadata
  const standaloneFaces = [];

  for (const face of faces) {
    if (!face || !face.isCorner) continue;

    if (face._cornerPatchKey) {
      if (!patchGroups.has(face._cornerPatchKey)) {
        patchGroups.set(face._cornerPatchKey, []);
      }
      patchGroups.get(face._cornerPatchKey).push(face);
    } else if (face._triVerts && face._triVerts.length === 3) {
      const key = face._triVerts.map(v => _edgeVKey(v)).sort().join('|');
      if (!trihedronGroups.has(key)) trihedronGroups.set(key, []);
      trihedronGroups.get(key).push(face);
    } else {
      standaloneFaces.push(face);
    }
  }

  // Build face descs for two-edge corner patches
  for (const [, group] of patchGroups) {
    const desc = _buildExactCornerPatchFaceDesc(group);
    if (desc) descs.push(desc);
  }

  // Build face descs for trihedron corners
  for (const [, group] of trihedronGroups) {
    const desc = _buildExactTrihedronFaceDesc(group);
    if (desc) descs.push(desc);
  }

  // Build planar face descs for standalone corners
  for (const face of standaloneFaces) {
    if (!face.vertices || face.vertices.length < 3) continue;
    const desc = _buildPlanarFaceDesc(face);
    if (desc) descs.push(desc);
  }

  return descs;
}

function _buildExactFilletTopoBody(faces, edgeDataList) {
  if (!faces || !Array.isArray(faces) || !edgeDataList || edgeDataList.length === 0) return null;

  const faceDescs = [];

  for (const face of faces) {
    if (!face || face.isFillet || face.isCorner) continue;
    const desc = _buildPlanarFaceDesc(face, edgeDataList);
    if (!desc) return null;
    faceDescs.push(desc);
  }

  for (const data of edgeDataList) {
    const desc = _buildExactFilletFaceDesc(data);
    if (!desc) return null;
    faceDescs.push(desc);
  }

  // Include corner face descriptors (two-edge patches, trihedron patches, standalone)
  const cornerDescs = _buildExactCornerFaceDescs(faces);
  faceDescs.push(...cornerDescs);

  if (faceDescs.length === 0) return null;
  return buildTopoBody(faceDescs);
}

/**
 * Batch trim faces for all edge data at once.
 * Handles the case where a face has multiple edges being chamfered/filleted
 * (e.g., the circular top face of a cylinder). At shared vertices between two
 * edges on the same face, both replacement vertices are inserted.
 */
function _batchTrimFaces(faces, edgeDataList) {
  // Build per-face maps:
  // For each (face, original_vertex_key) → list of {edgeDataIndex, replacement position, role}
  // role: 'a' means vertex is edgeA of this edge data, 'b' means it's edgeB
  const faceTrimInfo = new Map(); // fi → Map(vk → [{di, pos, role}])

  for (let di = 0; di < edgeDataList.length; di++) {
    const d = edgeDataList[di];
    const vkA = _edgeVKey(d.edgeA);
    const vkB = _edgeVKey(d.edgeB);

    // Face 0
    if (!faceTrimInfo.has(d.fi0)) faceTrimInfo.set(d.fi0, new Map());
    const m0 = faceTrimInfo.get(d.fi0);
    if (!m0.has(vkA)) m0.set(vkA, []);
    m0.get(vkA).push({ di, pos: d.p0a, role: 'a' });
    if (!m0.has(vkB)) m0.set(vkB, []);
    m0.get(vkB).push({ di, pos: d.p0b, role: 'b' });

    // Face 1
    if (!faceTrimInfo.has(d.fi1)) faceTrimInfo.set(d.fi1, new Map());
    const m1 = faceTrimInfo.get(d.fi1);
    if (!m1.has(vkA)) m1.set(vkA, []);
    m1.get(vkA).push({ di, pos: d.p1a, role: 'a' });
    if (!m1.has(vkB)) m1.set(vkB, []);
    m1.get(vkB).push({ di, pos: d.p1b, role: 'b' });
  }

  // Now apply trims per face
  for (const [fi, vertMap] of faceTrimInfo) {
    const face = faces[fi];
    const verts = face.vertices;
    const newVerts = [];

    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const vk = _edgeVKey(v);
      const entries = vertMap.get(vk);

      if (!entries || entries.length === 0) {
        // Vertex not involved in any edge — keep as-is
        newVerts.push(v);
      } else if (entries.length === 1) {
        // Vertex involved in exactly one edge — simple replacement
        newVerts.push({ ...entries[0].pos });
      } else {
        // Vertex shared by multiple edges on this face.
        // Insert replacement positions in face-winding order.
        // The vertex is endpoint B of the previous edge and endpoint A of the next.
        // We need: [p_b_of_prev_edge, p_a_of_next_edge]
        const prevIdx = (i - 1 + verts.length) % verts.length;
        const nextIdx = (i + 1) % verts.length;
        const prevVk = _edgeVKey(verts[prevIdx]);
        const nextVk = _edgeVKey(verts[nextIdx]);

        // Determine which entry connects to the previous vertex (role 'b' of that edge,
        // where edgeA matches prevVk) and which connects to the next (role 'a', edgeB matches nextVk)
        let firstPos = null, secondPos = null;

        for (const entry of entries) {
          const d = edgeDataList[entry.di];
          const otherA = _edgeVKey(d.edgeA);
          const otherB = _edgeVKey(d.edgeB);

          if (entry.role === 'b' && otherA === prevVk) {
            // This edge goes from prev vertex to current vertex — it should come first
            firstPos = entry.pos;
          } else if (entry.role === 'a' && otherB === nextVk) {
            // This edge goes from current vertex to next vertex — it should come second
            secondPos = entry.pos;
          } else if (entry.role === 'a' && otherB === prevVk) {
            firstPos = entry.pos;
          } else if (entry.role === 'b' && otherA === nextVk) {
            secondPos = entry.pos;
          }
        }

        if (firstPos && secondPos) {
          // Check if positions are essentially the same (avoid duplicate vertices)
          if (_edgeVKey(firstPos) === _edgeVKey(secondPos)) {
            newVerts.push({ ...firstPos });
          } else {
            newVerts.push({ ...firstPos });
            newVerts.push({ ...secondPos });
          }
        } else if (firstPos) {
          newVerts.push({ ...firstPos });
        } else if (secondPos) {
          newVerts.push({ ...secondPos });
        } else {
          // Fallback: use first entry's position
          newVerts.push({ ...entries[0].pos });
        }
      }
    }

    face.vertices = newVerts;
  }
}

/**
 * Batch-split vertices at all endpoints across all edges.
 * For vertices shared by multiple edges (internal path vertices), we use
 * the pre-computed replacement positions from the edge data rather than
 * the original single-edge _splitVertexAtEndpoint approach.
 */
function _batchSplitVertices(faces, edgeDataList, vertexEdgeMap) {
  // Collect all face indices that are directly involved in edges
  const edgeFaceIndices = new Set();
  for (const d of edgeDataList) {
    edgeFaceIndices.add(d.fi0);
    edgeFaceIndices.add(d.fi1);
  }

  // For each edge data, collect the endpoints that need splitting
  // in "other" faces (not face0 or face1 of that edge or any other edge)
  // Build a map: vertex key → { p0positions, p1positions } from all edges
  const vertexReplacements = new Map();
  for (const d of edgeDataList) {
    for (const [origVert, p0, p1] of [
      [d.edgeA, d.p0a, d.p1a],
      [d.edgeB, d.p0b, d.p1b],
    ]) {
      const vk = _edgeVKey(origVert);
      if (!vertexReplacements.has(vk)) {
        vertexReplacements.set(vk, { edges: [], fi0Set: new Set(), fi1Set: new Set() });
      }
      const entry = vertexReplacements.get(vk);
      entry.edges.push({ d, p0, p1 });
      entry.fi0Set.add(d.fi0);
      entry.fi1Set.add(d.fi1);
    }
  }

  // Extra faces generated when splitting creates non-planar polygons
  const extraFaces = [];

  // For each "other" face (not in any edge's face0/face1), determine
  // the correct replacement vertex at shared endpoints
  for (const [vk, entry] of vertexReplacements) {
    // Use the first edge's data for the actual split logic
    // (all edges meeting at this vertex should produce compatible offsets)
    const primary = entry.edges[0];

    for (let fi = 0; fi < faces.length; fi++) {
      if (entry.fi0Set.has(fi) || entry.fi1Set.has(fi)) continue;
      const face = faces[fi];
      // Skip existing fillet/corner faces from prior features - we'll clip them separately
      // in the fillet-fillet intersection handling instead of trying to split their vertices
      if (face.isFillet || face.isCorner) continue;
      const verts = face.vertices;

      let vidx = -1;
      for (let i = 0; i < verts.length; i++) {
        if (_edgeVKey(verts[i]) === vk) { vidx = i; break; }
      }
      if (vidx < 0) continue;

      const prevIdx = (vidx - 1 + verts.length) % verts.length;
      const nextIdx = (vidx + 1) % verts.length;
      const prevEdge = _edgeKeyFromVerts(verts[prevIdx], verts[vidx]);
      const nextEdge = _edgeKeyFromVerts(verts[vidx], verts[nextIdx]);

      // Check adjacency to ALL edges' face0Keys/face1Keys
      let touchesAnyF0 = false, touchesAnyF1 = false;
      let prevInAnyF0 = false, nextInAnyF0 = false;
      let firstP0 = primary.p0, firstP1 = primary.p1;

      for (const { d, p0, p1 } of entry.edges) {
        const prevInF0 = d.face0Keys.has(prevEdge);
        const prevInF1 = d.face1Keys.has(prevEdge);
        const nextInF0 = d.face0Keys.has(nextEdge);
        const nextInF1 = d.face1Keys.has(nextEdge);
        if (prevInF0 || nextInF0) { touchesAnyF0 = true; firstP0 = p0; }
        if (prevInF0) prevInAnyF0 = true;
        if (nextInF0) nextInAnyF0 = true;
        if (prevInF1 || nextInF1) { touchesAnyF1 = true; firstP1 = p1; }
      }

      let newPts;
      if (touchesAnyF0 && touchesAnyF1) {
        // Both face0 and face1 share edges with this face at the split vertex.
        // Inserting both offset positions can create a non-planar polygon when
        // the face (e.g. a bevel from a previous chamfer) isn't coplanar with
        // either face0 or face1.  Detect this and split into the original
        // planar face + a corner triangle to fill the gap.
        const ordered = prevInAnyF0
          ? [{ ...firstP0 }, { ...firstP1 }]
          : [{ ...firstP1 }, { ...firstP0 }];

        // Check planarity of both inserted points against the face's plane.
        const otherVerts = verts.filter((_, idx) => idx !== vidx);
        const firstOnPlane = _pointOnFacePlane(ordered[0], otherVerts);
        const secondOnPlane = _pointOnFacePlane(ordered[1], otherVerts);

        if (firstOnPlane && secondOnPlane) {
          newPts = ordered;
        } else if (firstOnPlane && !secondOnPlane) {
          // Second point off-plane: keep first, corner triangle toward next vertex.
          newPts = [ordered[0]];
          const triVerts = [{ ...ordered[0] }, { ...ordered[1] }, { ...verts[nextIdx] }];
          const triNormal = _vec3Normalize(_vec3Cross(
            _vec3Sub(triVerts[1], triVerts[0]),
            _vec3Sub(triVerts[2], triVerts[0])
          ));
          extraFaces.push({
            vertices: triVerts, normal: triNormal,
            shared: face.shared ? { ...face.shared } : null,
          });
        } else if (!firstOnPlane && secondOnPlane) {
          // First point off-plane: keep second, corner triangle toward prev vertex.
          newPts = [ordered[1]];
          const triVerts = [{ ...verts[prevIdx] }, { ...ordered[0] }, { ...ordered[1] }];
          const triNormal = _vec3Normalize(_vec3Cross(
            _vec3Sub(triVerts[1], triVerts[0]),
            _vec3Sub(triVerts[2], triVerts[0])
          ));
          extraFaces.push({
            vertices: triVerts, normal: triNormal,
            shared: face.shared ? { ...face.shared } : null,
          });
        } else {
          // Both off-plane — keep neither; generate two corner triangles.
          newPts = [];
          const tri1 = [{ ...verts[prevIdx] }, { ...ordered[0] }, { ...ordered[1] }];
          const tri2 = [{ ...ordered[0] }, { ...ordered[1] }, { ...verts[nextIdx] }];
          for (const triVerts of [tri1, tri2]) {
            const triNormal = _vec3Normalize(_vec3Cross(
              _vec3Sub(triVerts[1], triVerts[0]),
              _vec3Sub(triVerts[2], triVerts[0])
            ));
            extraFaces.push({
              vertices: triVerts, normal: triNormal,
              shared: face.shared ? { ...face.shared } : null,
            });
          }
        }
      } else if (touchesAnyF0) {
        // Faces that stay on the face0 side should receive a single trim point.
        // This is critical for segmented exact-boolean walls where a chamfered
        // path runs through multiple coplanar triangles: inserting both p0 and
        // p1 opens the wall and creates overlapping seam triangles.
        const fn = _vec3Normalize(face.normal);
        const n0 = _vec3Normalize(faces[primary.d.fi0].normal);
        const sameAsF0 = Math.abs(_vec3Dot(fn, n0)) > 0.999;
        if (face.isFillet || sameAsF0) {
          newPts = [{ ...firstP0 }];
        } else {
          newPts = nextInAnyF0
            ? [{ ...firstP1 }, { ...firstP0 }]
            : [{ ...firstP0 }, { ...firstP1 }];
        }
      } else if (touchesAnyF1) {
        newPts = [face.isFillet ? { ...firstP1 } : { ...firstP1 }];
      } else {
        // No direct edge connection — pick side by normal alignment
        const fn = _vec3Normalize(face.normal);
        const n0 = _vec3Normalize(faces[primary.d.fi0].normal);
        const n1 = _vec3Normalize(faces[primary.d.fi1].normal);
        const dot0 = Math.abs(_vec3Dot(fn, n0));
        const dot1 = Math.abs(_vec3Dot(fn, n1));
        newPts = [dot0 > dot1 ? { ...firstP0 } : { ...firstP1 }];
      }

      const newVerts = [];
      for (let i = 0; i < verts.length; i++) {
        if (i === vidx) {
          newVerts.push(...newPts);
        } else {
          newVerts.push(verts[i]);
        }
      }
      face.vertices = newVerts;
    }
  }

  // Append any corner triangles generated by non-planar splits
  if (extraFaces.length > 0) faces.push(...extraFaces);
}

/**
 * Generate corner (gap-filling) faces at shared vertices where 2+ edges meet.
 *
 * At each shared vertex, adjacent bevel/arc faces don't connect directly because
 * the offset directions differ between edges. This creates a single gap around the
 * vertex that needs one polygon to fill it.
 *
 * The corner polygon is constructed by walking around the vertex in two passes:
 * 1. p0 positions (face0 side) in reverse sorted order
 * 2. p1 positions (face1 side) in forward order, with "other vertices" between them
 */
function _generateCornerFaces(faces, origFaces, edgeDataList, vertexEdgeMap) {
  for (const [vk, edgeIndices] of vertexEdgeMap) {
    if (edgeIndices.length < 2) continue;

    // Collect edge info at this shared vertex
    const edgeInfos = [];
    for (const ei of edgeIndices) {
      const d = edgeDataList[ei];
      const isA = _edgeVKey(d.edgeA) === vk;
      edgeInfos.push({
        di: ei,
        data: d,
        isA,
        p0: isA ? d.p0a : d.p0b,
        p1: isA ? d.p1a : d.p1b,
        arc: d.arcA ? (isA ? d.arcA : d.arcB) : null,
      });
    }

    if (_isLinearEdgeContinuation(edgeInfos, origFaces)) continue;

    // Find "other vertex" for each edge (the vertex adjacent to vk in face1
    // that is NOT the other endpoint of the chamfered edge)
    for (const info of edgeInfos) {
      const d = info.data;
      const origFace1 = origFaces[d.fi1];
      const origVerts = origFace1.vertices;
      const otherEndVk = info.isA ? _edgeVKey(d.edgeB) : _edgeVKey(d.edgeA);
      info.otherVertex = null;
      for (let i = 0; i < origVerts.length; i++) {
        if (_edgeVKey(origVerts[i]) === vk) {
          const prevIdx = (i - 1 + origVerts.length) % origVerts.length;
          const nextIdx = (i + 1) % origVerts.length;
          const prevVk = _edgeVKey(origVerts[prevIdx]);
          const nextVk = _edgeVKey(origVerts[nextIdx]);
          if (nextVk !== otherEndVk && nextVk !== vk) {
            info.otherVertex = origVerts[nextIdx];
          } else if (prevVk !== otherEndVk && prevVk !== vk) {
            info.otherVertex = origVerts[prevIdx];
          }
          break;
        }
      }
    }

    // Sort edges around the vertex using face0 vertex ordering.
    // Use the shared vertex's position in the top face to determine the
    // correct angular order (handles wrap-around for circular faces).
    const fi0 = edgeInfos[0].data.fi0;
    const topFace = origFaces[fi0];
    const topVerts = topFace.vertices;

    // Find the shared vertex's index in the top face
    let sharedIdx = -1;
    for (let i = 0; i < topVerts.length; i++) {
      if (_edgeVKey(topVerts[i]) === vk) {
        sharedIdx = i;
        break;
      }
    }

    let allTopIndicesFound = true;
    for (const info of edgeInfos) {
      const d = info.data;
      const otherVk = info.isA ? _edgeVKey(d.edgeB) : _edgeVKey(d.edgeA);
      info.topIndex = -1;
      for (let i = 0; i < topVerts.length; i++) {
        if (_edgeVKey(topVerts[i]) === otherVk) {
          info.topIndex = i;
          break;
        }
      }
      // Compute relative position: distance going BACKWARD from sharedIdx
      // in the top face vertex list (matching the winding direction).
      // Edge connecting to the PREVIOUS vertex should sort first.
      if (sharedIdx >= 0 && info.topIndex >= 0) {
        info.sortKey = (sharedIdx - info.topIndex + topVerts.length) % topVerts.length;
      } else {
        allTopIndicesFound = false;
        info.sortKey = 0;
      }
    }

    // Fallback: when edges at this shared vertex have DIFFERENT face0s
    // (common after CSG boolean operations where large faces are triangulated),
    // the other endpoint may not be found in the first edge's face0.
    // Recompute sort keys using each edge's OWN face0 to determine whether
    // the shared vertex is the "incoming" end (endpoint B, isA=false) or
    // "outgoing" end (endpoint A, isA=true) of the edge in face0 winding.
    if (!allTopIndicesFound) {
      for (const info of edgeInfos) {
        if (info.topIndex >= 0) continue;

        const d = info.data;
        const otherVk = info.isA ? _edgeVKey(d.edgeB) : _edgeVKey(d.edgeA);
        const ownVerts = origFaces[d.fi0].vertices;

        let ownSharedIdx = -1;
        for (let i = 0; i < ownVerts.length; i++) {
          if (_edgeVKey(ownVerts[i]) === vk) { ownSharedIdx = i; break; }
        }

        if (ownSharedIdx >= 0) {
          const prevInOwn = (ownSharedIdx - 1 + ownVerts.length) % ownVerts.length;
          if (_edgeVKey(ownVerts[prevInOwn]) === otherVk) {
            // Other endpoint is the PREVIOUS vertex in face0 → incoming edge → sort first
            info.sortKey = 1;
          } else {
            // Other endpoint is the NEXT (or further) vertex → outgoing edge → sort last
            info.sortKey = Math.max(topVerts.length, edgeInfos.length + 1) - 1;
          }
        }
      }
    }

    edgeInfos.sort((a, b) => a.sortKey - b.sortKey);

    const shared = edgeInfos[0].data.shared;
    const hasFillet = edgeInfos.some(e => e.arc !== null);

    if (hasFillet) {
      // Fillet corner: generate triangle fan connecting arc arrays
      _generateFilletCorner(faces, edgeInfos, shared);
    } else {
      // Chamfer corner: build one polygon
      // Pass 1: p0 positions in reverse order (going backward around face0)
      const cornerVerts = [];
      for (let i = edgeInfos.length - 1; i >= 0; i--) {
        cornerVerts.push({ ...edgeInfos[i].p0 });
      }
      // Pass 2: p1 positions in forward order with other vertices between them
      for (let i = 0; i < edgeInfos.length; i++) {
        cornerVerts.push({ ...edgeInfos[i].p1 });
        if (i < edgeInfos.length - 1) {
          const curr = edgeInfos[i];
          const next = edgeInfos[i + 1];
          if (curr.otherVertex && next.otherVertex &&
              _edgeVKey(curr.otherVertex) === _edgeVKey(next.otherVertex)) {
            cornerVerts.push({ ...curr.otherVertex });
          }
        }
      }

      // Remove duplicate vertices (both consecutive and non-consecutive).
      // On curved surfaces, p1_curr and p1_next may be identical after rounding,
      // creating degenerate edges. Collapse such duplicates.
      const cleaned = _deduplicatePolygon(cornerVerts);
      if (cleaned.length < 3) continue;

      // Check if the corner polygon is redundant: when 3+ edges meet at a
      // vertex and their bevel faces already close the gap, all edges of the
      // corner polygon will already exist in exactly 2 faces.  Adding the
      // polygon would create non-manifold edges, so skip it.
      if (_isCornerRedundant(faces, cleaned)) continue;

      const cornerNormal = _vec3Normalize(_vec3Cross(
        _vec3Sub(cleaned[1], cleaned[0]),
        _vec3Sub(cleaned[cleaned.length - 1], cleaned[0])
      ));
      faces.push({ vertices: cleaned, normal: cornerNormal, shared });
    }
  }
}

function _sameNormalPair(a0, a1, b0, b1) {
  const same = (u, v) => Math.abs(_vec3Dot(_vec3Normalize(u), _vec3Normalize(v)) - 1) < 1e-5;
  return (same(a0, b0) && same(a1, b1)) || (same(a0, b1) && same(a1, b0));
}

function _isLinearEdgeContinuation(edgeInfos, origFaces) {
  if (edgeInfos.length !== 2) return false;

  const d0 = edgeInfos[0].data;
  const d1 = edgeInfos[1].data;
  const n00 = origFaces[d0.fi0]?.normal;
  const n01 = origFaces[d0.fi1]?.normal;
  const n10 = origFaces[d1.fi0]?.normal;
  const n11 = origFaces[d1.fi1]?.normal;
  if (!n00 || !n01 || !n10 || !n11) return false;
  if (!_sameNormalPair(n00, n01, n10, n11)) return false;

  const other0 = edgeInfos[0].isA ? d0.edgeB : d0.edgeA;
  const other1 = edgeInfos[1].isA ? d1.edgeB : d1.edgeA;
  const shared = edgeInfos[0].isA ? d0.edgeA : d0.edgeB;
  const dir0 = _vec3Normalize(_vec3Sub(other0, shared));
  const dir1 = _vec3Normalize(_vec3Sub(other1, shared));
  return _vec3Dot(dir0, dir1) < -0.999;
}

function _isLinearFilletContinuation(edgeInfos, origFaces) {
  if (!edgeInfos[0].arc || !edgeInfos[1].arc) return false;
  return _isLinearEdgeContinuation(edgeInfos, origFaces);
}

/**
 * Check whether a corner polygon is redundant — all its edges already exist
 * in exactly 2 faces (meaning the gap is already closed by bevel/trimmed faces).
 * This happens when 3+ chamfered edges meet at a single vertex and their bevel
 * faces perfectly tile the corner without needing an extra polygon.
 */
function _isCornerRedundant(faces, cleanedVerts) {
  // Build edge count map for existing faces
  const edgeCounts = new Map();
  for (const face of faces) {
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const ek = _edgeKeyFromVerts(verts[i], verts[(i + 1) % verts.length]);
      edgeCounts.set(ek, (edgeCounts.get(ek) || 0) + 1);
    }
  }
  // Check if every edge of the corner polygon already has 2 faces
  for (let i = 0; i < cleanedVerts.length; i++) {
    const ek = _edgeKeyFromVerts(cleanedVerts[i], cleanedVerts[(i + 1) % cleanedVerts.length]);
    if ((edgeCounts.get(ek) || 0) < 2) return false;
  }
  return true;
}

/**
 * Remove duplicate vertices from a polygon (both consecutive and non-consecutive).
 * On curved surfaces like cylinders, offset positions at shared vertices may
 * coincide after rounding, creating degenerate edges. This function collapses
 * such duplicates by keeping only the first occurrence of each unique vertex key
 * and removing the "loop" between duplicates.
 */
function _deduplicatePolygon(verts) {
  if (!verts || verts.length === 0) return [];
  // First pass: remove consecutive duplicates
  const step1 = [verts[0]];
  for (let i = 1; i < verts.length; i++) {
    if (_edgeVKey(verts[i]) !== _edgeVKey(step1[step1.length - 1])) {
      step1.push(verts[i]);
    }
  }
  if (step1.length > 1 && _edgeVKey(step1[0]) === _edgeVKey(step1[step1.length - 1])) {
    step1.pop();
  }

  // Second pass: remove non-consecutive duplicates by keeping the SHORTEST path
  // between duplicate vertices (collapse the loop)
  const seen = new Map();
  const result = [];
  for (let i = 0; i < step1.length; i++) {
    const key = _edgeVKey(step1[i]);
    if (seen.has(key)) {
      // Found a duplicate — remove the vertices between the first occurrence
      // and this one (the loop), keeping the first occurrence
      const firstIdx = seen.get(key);
      // Remove everything from firstIdx+1 to result.length (the loop)
      result.length = firstIdx + 1;
      // Update seen map
      seen.clear();
      for (let j = 0; j < result.length; j++) {
        seen.set(_edgeVKey(result[j]), j);
      }
    } else {
      result.push(step1[i]);
      seen.set(key, result.length - 1);
    }
  }
  return result;
}

function _splicePolylineIntoFaceEdge(faces, polyline) {
  if (!polyline || polyline.length < 3) return false;

  const startKey = _edgeVKey(polyline[0]);
  const endKey = _edgeVKey(polyline[polyline.length - 1]);
  const interior = polyline.slice(1, -1);

  for (const face of faces) {
    if (!face || !face.vertices || face.vertices.length < 3) continue;
    if (face.isFillet || face.isCorner) continue;

    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const aKey = _edgeVKey(verts[i]);
      const bKey = _edgeVKey(verts[(i + 1) % verts.length]);
      if ((aKey !== startKey || bKey !== endKey) && (aKey !== endKey || bKey !== startKey)) {
        continue;
      }

      const insert = aKey === startKey ? interior : [...interior].reverse();
      const newVerts = [];
      for (let vi = 0; vi < verts.length; vi++) {
        newVerts.push({ ...verts[vi] });
        if (vi === i) {
          for (const pt of insert) newVerts.push({ ...pt });
        }
      }

      face.vertices = _deduplicatePolygon(newVerts);
      const newNormal = _computePolygonNormal(face.vertices);
      if (newNormal && _vec3Dot(newNormal, face.normal || newNormal) < 0) {
        face.vertices.reverse();
      }
      face.normal = _computePolygonNormal(face.vertices) || face.normal;
      return true;
    }
  }

  return false;
}

/**
 * Generate a spherical triangle patch for a trihedron corner where 3+ fillet
 * edges meet at a single vertex.  The 3 fillet arcs at the vertex form the
 * boundary of a spherical triangle on a common sphere.  This function fills
 * that triangle with a properly tessellated mesh, replacing the pairwise
 * approach which produces overlapping/incorrect faces at 3-edge corners.
 *
 * @returns {boolean} true if the corner was handled, false to fall back
 */
function _generateTrihedronCorner(faces, edgeInfos, shared) {
  if (edgeInfos.length < 3) return false;
  const segs = edgeInfos[0].arc ? edgeInfos[0].arc.length - 1 : 0;
  if (segs < 1) return false;

  // Step 1: Find the 3 unique arc endpoints (vertices of the spherical triangle).
  // Each fillet arc at the shared vertex has 2 endpoints (arc[0] on face0,
  // arc[segs] on face1).  At a trihedron corner each endpoint is shared by
  // exactly 2 arcs.
  const endpointMap = new Map();
  for (let i = 0; i < edgeInfos.length; i++) {
    const arc = edgeInfos[i].arc;
    if (!arc) continue;
    for (const idx of [0, segs]) {
      const vk = _edgeVKey(arc[idx]);
      if (!endpointMap.has(vk)) endpointMap.set(vk, []);
      endpointMap.get(vk).push({ ei: i, idx });
    }
  }

  const triVerts = [];
  for (const [vk, entries] of endpointMap) {
    if (entries.length >= 2) {
      triVerts.push({
        vk,
        pos: { ...edgeInfos[entries[0].ei].arc[entries[0].idx] },
        entries,
      });
    }
  }

  // Must have exactly 3 triangle vertices for a trihedron
  if (triVerts.length !== 3) return false;

  // Step 2: Find which arc connects each pair of vertices, oriented V[i]→V[j].
  function findArc(vi, vj) {
    for (const info of edgeInfos) {
      const arc = info.arc;
      if (!arc) continue;
      if (_edgeVKey(arc[0]) === vi.vk && _edgeVKey(arc[segs]) === vj.vk) return arc;
      if (_edgeVKey(arc[0]) === vj.vk && _edgeVKey(arc[segs]) === vi.vk) return [...arc].reverse();
    }
    return null;
  }

  // Compute the sphere center early so both the fill triangle and the grid
  // can use it to determine outward-facing winding.
  const midIdx = Math.max(1, Math.floor(segs / 2));
  const p3Arc = edgeInfos[0].arc[midIdx];
  const sphereCenter = _circumsphereCenter(triVerts[0].pos, triVerts[1].pos, triVerts[2].pos, p3Arc);
  const sphereRadius = sphereCenter ? _vec3Len(_vec3Sub(triVerts[0].pos, sphereCenter)) : 0;
  const useSphere = sphereCenter !== null && sphereRadius > 1e-10;

  // Ensure outward-facing normals: swap triVerts[0] and triVerts[1] if
  // the default grid winding produces inward normals.  For a visualization
  // mesh the correct face orientation (outward normals) takes priority over
  // strict manifold edge consistency at the fillet–trihedron boundary,
  // because the NURBS/BRep representation is the mathematically correct
  // one and the mesh is only for rendering.
  {
    const testArc = findArc(triVerts[0], triVerts[1]);
    const testLeft = findArc(triVerts[0], triVerts[2]);
    if (useSphere && testArc && testLeft && testArc.length >= 2 && testLeft.length >= 2) {
      const ga = testArc[0], gb = testArc[1], gc = testLeft[1];
      const testNormal = _vec3Cross(_vec3Sub(gb, ga), _vec3Sub(gc, ga));
      const outDir = _vec3Sub(ga, sphereCenter);
      if (_vec3Dot(testNormal, outDir) < 0) {
        const tmp = triVerts[0];
        triVerts[0] = triVerts[1];
        triVerts[1] = tmp;
      }
    }
  }

  // Bottom arc: V[0] → V[1] ;  Left arc: V[0] → V[2] ;  Right arc: V[1] → V[2]
  const arcBottom = findArc(triVerts[0], triVerts[1]);
  const arcLeft   = findArc(triVerts[0], triVerts[2]);
  const arcRight  = findArc(triVerts[1], triVerts[2]);
  if (!arcBottom || !arcLeft || !arcRight) return false;

  // The planar faces keep their straight chord trims from _batchTrimFaces.
  // The fillet strip + trihedron grid share the curved arc boundary.
  // A fill triangle bridges the gap between the straight chord and the arcs.

  // Step 3: Build the triangular grid.
  //   Row 0 (bottom):  segs+1 points from arcBottom (V[0] → V[1])
  //   Row r:           segs-r+1 points; left = arcLeft[r], right = arcRight[r]
  //   Row segs (top):  1 point = V[2]
  const grid = [];

  // Row 0: exact bottom boundary arc
  grid[0] = arcBottom.map(p => ({ ...p }));

  // Row segs: top vertex
  grid[segs] = [{ ...triVerts[2].pos }];

  // Intermediate rows
  for (let r = 1; r < segs; r++) {
    const left = arcLeft[r];
    const right = arcRight[r];
    const count = segs - r + 1;
    grid[r] = [];
    for (let j = 0; j < count; j++) {
      if (j === 0) {
        grid[r][j] = { ...left };
      } else if (j === count - 1) {
        grid[r][j] = { ...right };
      } else {
        const t = j / (count - 1);
        grid[r][j] = _vec3Lerp(left, right, t);
      }
    }
  }

  // Fair the interior toward a smooth ball-like blend and then project the
  // interior back onto the common sphere defined by the trim boundaries.
  // This preserves the round trihedron corner while the spliced boundary
  // arcs and later T-junction repair keep the topology closed.
  for (let iter = 0; iter < 4; iter++) {
    for (let r = 1; r < segs; r++) {
      const row = grid[r];
      for (let j = 1; j < row.length - 1; j++) {
        const neighbors = [row[j - 1], row[j + 1]];
        if (j < grid[r - 1].length) neighbors.push(grid[r - 1][j]);
        if (j + 1 < grid[r - 1].length) neighbors.push(grid[r - 1][j + 1]);
        if (j < grid[r + 1].length) neighbors.push(grid[r + 1][j]);
        if (j - 1 >= 0 && j - 1 < grid[r + 1].length) neighbors.push(grid[r + 1][j - 1]);
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (const pt of neighbors) {
          sx += pt.x;
          sy += pt.y;
          sz += pt.z;
        }
        let nextPt = { x: sx / neighbors.length, y: sy / neighbors.length, z: sz / neighbors.length };
        if (useSphere) {
          const dir = _vec3Sub(nextPt, sphereCenter);
          const len = _vec3Len(dir);
          if (len > 1e-10) {
            nextPt = _vec3Add(sphereCenter, _vec3Scale(dir, sphereRadius / len));
          }
        }
        row[j] = nextPt;
      }
    }
  }

  // Pre-compute shared metadata for emitted corner faces.
  const triVertPositions = [{ ...triVerts[0].pos }, { ...triVerts[1].pos }, { ...triVerts[2].pos }];

  // Determine correct winding by checking manifold consistency with adjacent
  // fillet strip faces.  The grid boundary edge grid[0][0]→grid[0][1] must
  // traverse in the OPPOSITE direction from the adjacent fillet quad's edge.
  const needFlip = _shouldFlipTrihedronWinding(faces, grid);

  // Emit the fill triangle that bridges the straight trim chords on the
  // planar faces to the curved trihedron boundary arcs.
  {
    const p0 = triVerts[0].pos, p1 = triVerts[1].pos, p2 = triVerts[2].pos;
    const fillVerts = needFlip
      ? [{ x: p0.x, y: p0.y, z: p0.z }, { x: p2.x, y: p2.y, z: p2.z }, { x: p1.x, y: p1.y, z: p1.z }]
      : [{ x: p0.x, y: p0.y, z: p0.z }, { x: p1.x, y: p1.y, z: p1.z }, { x: p2.x, y: p2.y, z: p2.z }];
    const n = _computePolygonNormal(fillVerts);
    if (n && _vec3Len(n) > 1e-10) {
      faces.push({
        vertices: fillVerts,
        normal: n,
        shared,
        isCorner: true,
        _sphereCenter: null,
        _sphereRadius: 0,
        _triVerts: triVertPositions,
      });
    }
  }

  // Step 4: Emit triangles from the grid.
  // Use needFlip to swap vertex order so boundary edges are manifold-
  // consistent with the adjacent fillet strip quads.
  for (let r = 0; r < segs; r++) {
    const currRow = grid[r];
    const nextRow = grid[r + 1];
    const currLen = currRow.length;
    const nextLen = nextRow.length;

    for (let j = 0; j < currLen - 1; j++) {
      // "Down" triangle: currRow[j], currRow[j+1], nextRow[j]
      const a = currRow[j], b = currRow[j + 1], c = nextRow[j];
      const tri1 = needFlip
        ? [{ ...a }, { ...c }, { ...b }]
        : [{ ...a }, { ...b }, { ...c }];
      const n1 = _vec3Normalize(_vec3Cross(
        _vec3Sub(tri1[1], tri1[0]), _vec3Sub(tri1[2], tri1[0])
      ));
      if (_vec3Len(n1) > 1e-10) {
        faces.push({ vertices: tri1, normal: n1, shared, isCorner: true,
          _sphereCenter: useSphere ? sphereCenter : null, _sphereRadius: sphereRadius,
          _triVerts: triVertPositions });
      }

      // "Up" triangle: currRow[j+1], nextRow[j+1], nextRow[j]
      if (j < nextLen - 1) {
        const d = currRow[j + 1], e = nextRow[j + 1], f = nextRow[j];
        const tri2 = needFlip
          ? [{ ...d }, { ...f }, { ...e }]
          : [{ ...d }, { ...e }, { ...f }];
        const n2 = _vec3Normalize(_vec3Cross(
          _vec3Sub(tri2[1], tri2[0]), _vec3Sub(tri2[2], tri2[0])
        ));
        if (_vec3Len(n2) > 1e-10) {
          faces.push({ vertices: tri2, normal: n2, shared, isCorner: true,
            _sphereCenter: useSphere ? sphereCenter : null, _sphereRadius: sphereRadius,
            _triVerts: triVertPositions });
        }
      }
    }
  }

  return true;
}

/**
 * Determine whether the trihedron corner grid needs its winding flipped.
 * Checks if the first boundary edge of the grid (row 0, columns 0→1)
 * is traversed in the same direction by an adjacent fillet strip face.
 * If so, the trihedron must flip to maintain manifold consistency.
 */
function _shouldFlipTrihedronWinding(faces, grid) {
  if (!grid[0] || grid[0].length < 2) return false;
  const k0 = _edgeVKey(grid[0][0]);
  const k1 = _edgeVKey(grid[0][1]);

  for (let fi = 0; fi < faces.length; fi++) {
    if (!faces[fi].isFillet) continue;
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const va = verts[i], vb = verts[(i + 1) % verts.length];
      const ka = _edgeVKey(va), kb = _edgeVKey(vb);
      if (ka === k0 && kb === k1) return true;   // same direction → flip
      if (ka === k1 && kb === k0) return false;  // opposite → no flip
    }
  }

  // Fallback: try any face (not just fillet) sharing this edge
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const va = verts[i], vb = verts[(i + 1) % verts.length];
      const ka = _edgeVKey(va), kb = _edgeVKey(vb);
      if (ka === k0 && kb === k1) return true;
      if (ka === k1 && kb === k0) return false;
    }
  }
  return false;
}

function _emitTwoEdgeFilletCornerPatch(faces, arcLeft, arcRight, shared, trimCurve = null) {
  if (!arcLeft || !arcRight || arcLeft.length !== arcRight.length || arcLeft.length < 2) {
    return;
  }

  const segs = arcLeft.length - 1;
  const top0 = arcLeft[0];
  const top1 = arcRight[0];
  const apex = arcLeft[segs];
  const topMid = trimCurve && trimCurve.length > 0 ? trimCurve[0] : _vec3Lerp(top0, top1, 0.5);
  const topBoundary = _edgeVKey(topMid) === _edgeVKey(top0) || _edgeVKey(topMid) === _edgeVKey(top1)
    ? [{ ...top0 }, { ...top1 }]
    : [{ ...top0 }, { ...topMid }, { ...top1 }];
  const topRow = _samplePolyline(topBoundary, segs);
  _splicePolylineIntoFaceEdge(faces, topBoundary);

  const grid = [topRow];
  for (let r = 1; r < segs; r++) {
    const left = arcLeft[r];
    const right = arcRight[r];
    const count = segs - r + 1;
    const row = [];
    for (let j = 0; j < count; j++) {
      row.push(_vec3Lerp(left, right, j / (count - 1 || 1)));
    }
    grid.push(row);
  }
  grid.push([{ ...apex }]);

  for (let iter = 0; iter < 3; iter++) {
    for (let r = 1; r < grid.length - 1; r++) {
      for (let j = 1; j < grid[r].length - 1; j++) {
        const neighbors = [];
        neighbors.push(grid[r][j - 1], grid[r][j + 1]);
        if (j < grid[r - 1].length) neighbors.push(grid[r - 1][j]);
        if (j + 1 < grid[r - 1].length) neighbors.push(grid[r - 1][j + 1]);
        if (j < grid[r + 1].length) neighbors.push(grid[r + 1][j]);
        if (j - 1 >= 0 && j - 1 < grid[r + 1].length) neighbors.push(grid[r + 1][j - 1]);
        if (neighbors.length === 0) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (const pt of neighbors) {
          sx += pt.x;
          sy += pt.y;
          sz += pt.z;
        }
        grid[r][j] = { x: sx / neighbors.length, y: sy / neighbors.length, z: sz / neighbors.length };
      }
    }
  }

  const flip = _shouldFlipTrihedronWinding(faces, [topRow]);
  const midRow = grid[Math.floor(segs / 2)] || grid[0];
  const midPoint = midRow[Math.floor((midRow.length - 1) / 2)] || _vec3Lerp(top0, apex, 0.5);
  const cornerPatch = {
    top0: { ...top0 },
    top1: { ...top1 },
    topMid: { ...topMid },
    side0Mid: { ...arcLeft[Math.floor(segs / 2)] },
    side1Mid: { ...arcRight[Math.floor(segs / 2)] },
    apex: { ...apex },
    centerPoint: { ...midPoint },
  };
  const patchKey = [
    _edgeVKey(cornerPatch.top0),
    _edgeVKey(cornerPatch.top1),
    _edgeVKey(cornerPatch.apex),
  ].join('|');

  for (let r = 0; r < segs; r++) {
    const currRow = grid[r];
    const nextRow = grid[r + 1];
    const currLen = currRow.length;
    const nextLen = nextRow.length;

    for (let j = 0; j < currLen - 1; j++) {
      const down = flip
        ? [{ ...currRow[j] }, { ...nextRow[j] }, { ...currRow[j + 1] }]
        : [{ ...currRow[j] }, { ...currRow[j + 1] }, { ...nextRow[j] }];
      const downNormal = _vec3Normalize(_vec3Cross(
        _vec3Sub(down[1], down[0]), _vec3Sub(down[2], down[0])
      ));
      if (_vec3Len(downNormal) > 1e-10) {
        faces.push({
          vertices: down,
          normal: downNormal,
          shared,
          isFillet: true,
          isCorner: true,
          _cornerPatch: cornerPatch,
          _cornerPatchKey: patchKey,
        });
      }

      if (j < nextLen - 1) {
        const up = flip
          ? [{ ...currRow[j + 1] }, { ...nextRow[j] }, { ...nextRow[j + 1] }]
          : [{ ...currRow[j + 1] }, { ...nextRow[j + 1] }, { ...nextRow[j] }];
        const upNormal = _vec3Normalize(_vec3Cross(
          _vec3Sub(up[1], up[0]), _vec3Sub(up[2], up[0])
        ));
        if (_vec3Len(upNormal) > 1e-10) {
          faces.push({
            vertices: up,
            normal: upNormal,
            shared,
            isFillet: true,
            isCorner: true,
            _cornerPatch: cornerPatch,
            _cornerPatchKey: patchKey,
          });
        }
      }
    }
  }
}

/**
 * Generate fillet corner faces at a shared vertex using triangle fans.
 * The boundary of the gap consists of:
 * 1. Top face edge: arcB_(i-1)[0] → arcA_i[0]
 * 2. Arc from edge i going backward: arcA_i[0] → arcA_i[seg] (face1 side)
 * 3. Gap through other vertex: arcA_i[seg] → vi_bot → arcB_(i-1)[seg]
 * 4. Arc from edge (i-1) going forward: arcB_(i-1)[seg] → arcB_(i-1)[0] (face0 side)
 *
 * The polygon must traverse these in opposite direction to adjacent faces.
 */
function _generateFilletCorner(faces, edgeInfos, shared) {
  // For 3+ edges forming a closed trihedron, use a proper spherical triangle
  // patch instead of the pairwise approach which creates overlapping faces.
  if (edgeInfos.length >= 3 && _generateTrihedronCorner(faces, edgeInfos, shared)) {
    return;
  }

  // Handle pairs of adjacent edges around the vertex.
  // For M edges, process each consecutive pair (i, i+1).
  // For M=2 this produces a single corner patch; for M>=3 it produces one
  // patch per pair (some may be redundant and will be skipped).
  for (let ei = 0; ei < edgeInfos.length; ei++) {
    const curr = edgeInfos[ei];
    const next = edgeInfos[(ei + 1) % edgeInfos.length];
    const arcCurr = curr.arc;
    const arcNext = next.arc;

    if (!arcCurr || !arcNext) continue;

    const segs = arcCurr.length - 1;

    const lastCurr = arcCurr[segs];
    const lastNext = arcNext[segs];
    const arcsMeet = _edgeVKey(lastCurr) === _edgeVKey(lastNext);

    if (arcsMeet && segs > 1) {
      const trimNext = next.isA ? next.data.sharedTrimA : next.data.sharedTrimB;
      const trimCurr = curr.isA ? curr.data.sharedTrimA : curr.data.sharedTrimB;
      if (edgeInfos.length === 2 && trimNext && trimCurr && trimNext.length === trimCurr.length) {
        break;
      }
      const trimCurve = trimNext && trimCurr && trimNext.length === trimCurr.length ? trimNext : null;
      _emitTwoEdgeFilletCornerPatch(faces, arcNext, arcCurr, shared, trimCurve);
    } else {
      // Fallback: polygon fan approach for non-meeting arcs
      const cornerVerts = [];
      cornerVerts.push({ ...arcNext[0] });
      cornerVerts.push({ ...arcCurr[0] });
      for (let s = 1; s <= segs; s++) {
        cornerVerts.push({ ...arcCurr[s] });
      }
      if (!arcsMeet && curr.otherVertex) {
        cornerVerts.push({ ...curr.otherVertex });
      }
      const startS = arcsMeet ? segs - 1 : segs;
      for (let s = startS; s >= 1; s--) {
        cornerVerts.push({ ...arcNext[s] });
      }
      const cleaned = [cornerVerts[0]];
      for (let i = 1; i < cornerVerts.length; i++) {
        if (_edgeVKey(cornerVerts[i]) !== _edgeVKey(cleaned[cleaned.length - 1])) {
          cleaned.push(cornerVerts[i]);
        }
      }
      if (cleaned.length > 1 && _edgeVKey(cleaned[0]) === _edgeVKey(cleaned[cleaned.length - 1])) {
        cleaned.pop();
      }
      if (cleaned.length < 3) { if (edgeInfos.length === 2) break; continue; }
      if (_isCornerRedundant(faces, cleaned)) { if (edgeInfos.length === 2) break; continue; }
      for (let i = 1; i < cleaned.length - 1; i++) {
        const triNormal = _vec3Normalize(_vec3Cross(
          _vec3Sub(cleaned[i], cleaned[0]),
          _vec3Sub(cleaned[i + 1], cleaned[0])
        ));
        if (_vec3Len(triNormal) > 1e-10) {
          faces.push({
            vertices: [{ ...cleaned[0] }, { ...cleaned[i] }, { ...cleaned[i + 1] }],
            normal: triNormal, shared,
          });
        }
      }
    }

    // For M=2 edges, only one patch needed (don't wrap around)
    if (edgeInfos.length === 2) break;
  }
}

/**
 * Make an edge key from two vertex positions (for persistent edge identity).
 */
export function makeEdgeKey(a, b) {
  return _edgeKeyFromVerts(a, b);
}

/**
 * Given a geometry (with .edges and .paths) and a set of edge keys from the
 * user's selection, expand each key to include ALL edges that belong to the
 * same path AND any tangent-connected paths (paths sharing an endpoint with
 * similar edge direction).  This allows selecting one segment of a circular
 * edge to automatically select the whole circle and any tangent continuations.
 *
 * @param {Object} geometry - Geometry with .edges[] and .paths[]
 * @param {string[]} edgeKeys - Edge keys selected by the user
 * @returns {string[]} Expanded edge keys covering full paths (deduplicated)
 */
export function expandPathEdgeKeys(geometry, edgeKeys) {
  if (!geometry || !geometry.edges || !geometry.paths || edgeKeys.length === 0) {
    return edgeKeys;
  }

  // Build edge-index → path-index lookup
  const edgeToPath = new Map();
  for (let pi = 0; pi < geometry.paths.length; pi++) {
    for (const ei of geometry.paths[pi].edgeIndices) {
      edgeToPath.set(ei, pi);
    }
  }

  // Build edge-key → edge-index lookup
  const keyToIndex = new Map();
  for (let i = 0; i < geometry.edges.length; i++) {
    const e = geometry.edges[i];
    keyToIndex.set(_edgeKeyFromVerts(e.start, e.end), i);
  }

  const parseEdgeKey = (key) => {
    if (typeof key !== 'string') return null;
    const sep = key.indexOf('|');
    if (sep < 0) return null;
    const parsePoint = (text) => {
      const coords = text.split(',').map(Number);
      if (coords.length !== 3 || coords.some((value) => Number.isNaN(value))) return null;
      return { x: coords[0], y: coords[1], z: coords[2] };
    };
    const start = parsePoint(key.slice(0, sep));
    const end = parsePoint(key.slice(sep + 1));
    return start && end ? { start, end } : null;
  };

  const pointToSegmentDistance = (point, start, end) => {
    const seg = _vec3Sub(end, start);
    const lenSq = _vec3Dot(seg, seg);
    if (lenSq < 1e-10) return _vec3Len(_vec3Sub(point, start));
    const t = Math.max(0, Math.min(1, _vec3Dot(_vec3Sub(point, start), seg) / lenSq));
    const closest = _vec3Add(start, _vec3Scale(seg, t));
    return _vec3Len(_vec3Sub(point, closest));
  };

  const fuzzyMatchEdgeIndex = (edgeKey) => {
    const parsed = parseEdgeKey(edgeKey);
    if (!parsed) return undefined;
    const origDelta = _vec3Sub(parsed.end, parsed.start);
    const origLen = _vec3Len(origDelta);
    if (origLen < 1e-10) return undefined;
    const origDir = _vec3Normalize(origDelta);
    const origMid = _vec3Lerp(parsed.start, parsed.end, 0.5);

    let bestIndex = undefined;
    let bestScore = Infinity;
    for (let i = 0; i < geometry.edges.length; i++) {
      const edge = geometry.edges[i];
      if (!edge || !edge.start || !edge.end) continue;
      const edgeDelta = _vec3Sub(edge.end, edge.start);
      const edgeLen = _vec3Len(edgeDelta);
      if (edgeLen < 1e-10) continue;
      const edgeDir = _vec3Normalize(edgeDelta);
      if (Math.abs(_vec3Dot(edgeDir, origDir)) < 0.95) continue;

      const distA = pointToSegmentDistance(parsed.start, edge.start, edge.end);
      const distB = pointToSegmentDistance(parsed.end, edge.start, edge.end);
      const tol = Math.max(origLen, edgeLen) * 0.1 + 1e-4;
      if (distA > tol || distB > tol) continue;

      const edgeMid = _vec3Lerp(edge.start, edge.end, 0.5);
      const midDist = _vec3Len(_vec3Sub(edgeMid, origMid));
      const lenRatio = edgeLen / origLen;
      if (lenRatio < 0.1 || lenRatio > 10) continue;

      const score = distA + distB + midDist + Math.abs(Math.log(lenRatio)) * 0.01;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  };

  // Collect all path indices touched by the input keys
  const touchedPaths = new Set();
  const matchedKeys = new Set();
  for (const ek of edgeKeys) {
    const ei = keyToIndex.get(ek) ?? fuzzyMatchEdgeIndex(ek);
    if (ei !== undefined) {
      matchedKeys.add(ek);
      const pi = edgeToPath.get(ei);
      if (pi !== undefined) touchedPaths.add(pi);
    }
  }

  function pathExpansionSignature(pi) {
    const path = geometry.paths[pi];
    let hasFillet = false;
    let hasNonFillet = false;
    const featureIds = new Set();

    for (const ei of path.edgeIndices) {
      const edge = geometry.edges[ei];
      for (const fi of edge.faceIndices || []) {
        const face = geometry.faces && geometry.faces[fi];
        if (!face) continue;
        if (face.isFillet) hasFillet = true;
        else hasNonFillet = true;
        const featureId = face.shared && face.shared.sourceFeatureId;
        if (featureId) featureIds.add(featureId);
      }
    }

    const kind = hasFillet
      ? (hasNonFillet ? 'blend-boundary' : 'blend-only')
      : 'sharp-only';
    return `${kind}|${[...featureIds].sort().join(',')}`;
  }

  const pathSignatures = geometry.paths.map((_, pi) => pathExpansionSignature(pi));

  // --- Tangent path expansion ---
  // Build path endpoint → path index map and endpoint edge directions
  const vKey = (v) => _edgeVKey(v);
  const pathEndpoints = new Map(); // vertexKey → [{pi, dir}]

  for (let pi = 0; pi < geometry.paths.length; pi++) {
    const path = geometry.paths[pi];
    if (path.isClosed || path.edgeIndices.length === 0) continue;

    // First edge start vertex
    const firstEi = path.edgeIndices[0];
    const firstEdge = geometry.edges[firstEi];
    const startVk = vKey(firstEdge.start);
    const startDir = _vec3Normalize(_vec3Sub(firstEdge.end, firstEdge.start));

    // Last edge end vertex
    const lastEi = path.edgeIndices[path.edgeIndices.length - 1];
    const lastEdge = geometry.edges[lastEi];
    const endVk = vKey(lastEdge.end);
    const endDir = _vec3Normalize(_vec3Sub(lastEdge.end, lastEdge.start));

    if (!pathEndpoints.has(startVk)) pathEndpoints.set(startVk, []);
    pathEndpoints.get(startVk).push({ pi, dir: { x: -startDir.x, y: -startDir.y, z: -startDir.z } });

    if (!pathEndpoints.has(endVk)) pathEndpoints.set(endVk, []);
    pathEndpoints.get(endVk).push({ pi, dir: endDir });
  }

  // Expand tangent-connected paths: if a touched path endpoint meets
  // another path's endpoint at the same vertex with similar direction,
  // include that path too (and recurse)
  // Cosine threshold for tangent detection (~26° tolerance).
  // Two path endpoints are considered tangent when the cosine of the angle
  // between their edge directions exceeds this value.
  const TANGENT_THRESHOLD = 0.9;
  let changed = true;
  while (changed) {
    changed = false;
    for (const pi of touchedPaths) {
      const path = geometry.paths[pi];
      if (path.isClosed || path.edgeIndices.length === 0) continue;

      const firstEi = path.edgeIndices[0];
      const lastEi = path.edgeIndices[path.edgeIndices.length - 1];
      const firstEdge = geometry.edges[firstEi];
      const lastEdge = geometry.edges[lastEi];

      for (const endpointVk of [vKey(firstEdge.start), vKey(lastEdge.end)]) {
        const neighbors = pathEndpoints.get(endpointVk);
        if (!neighbors) continue;
        for (const neighbor of neighbors) {
          if (neighbor.pi === pi || touchedPaths.has(neighbor.pi)) continue;
          if (pathSignatures[neighbor.pi] !== pathSignatures[pi]) continue;

          // Check tangency: find the direction at this endpoint for the current path
          let curDir;
          if (endpointVk === vKey(firstEdge.start)) {
            curDir = _vec3Normalize(_vec3Sub(firstEdge.start, firstEdge.end)); // pointing outward
          } else {
            curDir = _vec3Normalize(_vec3Sub(lastEdge.end, lastEdge.start));
          }

          const dot = Math.abs(_vec3Dot(curDir, neighbor.dir));
          if (dot >= TANGENT_THRESHOLD) {
            touchedPaths.add(neighbor.pi);
            changed = true;
          }
        }
      }
    }
  }

  // Expand: emit every edge key in every touched path
  const result = new Set();
  for (const pi of touchedPaths) {
    for (const ei of geometry.paths[pi].edgeIndices) {
      const e = geometry.edges[ei];
      result.add(_edgeKeyFromVerts(e.start, e.end));
    }
  }

  // Also keep any input keys that didn't match a path (fuzzy fallback)
  for (const ek of edgeKeys) {
    if (!matchedKeys.has(ek)) result.add(ek);
  }

  return [...result];
}

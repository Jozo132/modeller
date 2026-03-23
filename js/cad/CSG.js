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
    const quantize = (value, digits = 4) => {
      const clamped = Math.abs(value) < 1e-10 ? 0 : value;
      const text = clamped.toFixed(digits);
      return text === '-0.0000' ? '0.0000' : text;
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

  for (const [, group] of planeGroups) {
    if (group.length <= 1) continue;

    const vertexFaces = new Map();
    for (const fi of group) {
      const verts = faces[fi].vertices;
      for (let i = 0; i < verts.length; i++) {
        const v = verts[i];
        const key = `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;
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
        const fb = faces[group[gj]];
        if (_coplanarFacesTouch(fa, fb)) unite(group[gi], group[gj]);
      }
    }
  }

  // --- Curved face grouping: merge non-planar faces connected by smooth edges ---
  const precision = 6;
  function vKey(v) { return `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`; }
  function eKey(a, b) { const ka = vKey(a), kb = vKey(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; }

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
  const precision = 6;
  const ax = a.x.toFixed(precision), ay = a.y.toFixed(precision), az = a.z.toFixed(precision);
  const bx = b.x.toFixed(precision), by = b.y.toFixed(precision), bz = b.z.toFixed(precision);
  const ka = `${ax},${ay},${az}`;
  const kb = `${bx},${by},${bz}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
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
  const precision = 6;
  function vKey(v) {
    return `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`;
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
    const dedupPrec = 5;
    function dvKey(v) {
      return `${(Math.abs(v.x) < 5e-6 ? 0 : v.x).toFixed(dedupPrec)},${(Math.abs(v.y) < 5e-6 ? 0 : v.y).toFixed(dedupPrec)},${(Math.abs(v.z) < 5e-6 ? 0 : v.z).toFixed(dedupPrec)}`;
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
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    const faceVerts = face.vertices;
    const normal = face.normal;
    for (let i = 0; i < faceVerts.length; i++) {
      const a = faceVerts[i];
      const b = faceVerts[(i + 1) % faceVerts.length];
      const key = edgeKey(a, b);
      if (!edgeNormals.has(key)) {
        edgeNormals.set(key, { start: a, end: b, normals: [], faceIndices: [] });
      }
      edgeNormals.get(key).normals.push(normal);
      edgeNormals.get(key).faceIndices.push(fi);
    }
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

    // Collect all edges of the group
    const groupEdges = [];
    for (const fi of groupFaceIndices) {
      const verts = faces[fi].vertices;
      for (let i = 0; i < verts.length; i++) {
        groupEdges.push({ a: verts[i], b: verts[(i + 1) % verts.length], fi });
      }
    }

    // Check each edge against vertices/edges of other faces in the same group
    for (const edge of groupEdges) {
      const ek = edgeKey(edge.a, edge.b);
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
  const COPLANAR_THRESHOLD = 1 - 1e-6;
  let edges = [];
  const visualEdges = [];
  for (const [key, info] of edgeNormals) {
    if (info.normals.length === 1) {
      // Boundary edge — only suppress if it's a confirmed T-junction
      if (!tJunctionEdgeKeys.has(key)) {
        edges.push({
          start: info.start, end: info.end,
          faceIndices: info.faceIndices,
          normals: info.normals,
        });
      }
    } else if (info.normals.length >= 2) {
      // Check if any pair of adjacent normals differs significantly
      const n0 = info.normals[0];
      let isFeature = false;
      let minDot = 1;
      for (let i = 1; i < info.normals.length; i++) {
        const n1 = info.normals[i];
        const dot = n0.x * n1.x + n0.y * n1.y + n0.z * n1.z;
        if (dot < minDot) minDot = dot;
        if (dot < SHARP_THRESHOLD) {
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
      // Suppress feature edges at the corner base seam: the flat base triangle
      // connecting the spherical corner to the trimmed box faces is a geometric
      // necessity for manifold closure but should not produce visible feature lines.
      if (isFeature && info.faceIndices.length >= 2) {
        const hasCorner = info.faceIndices.some(fi => faces[fi].isCorner);
        const allNonFillet = info.faceIndices.every(fi => !faces[fi].isFillet);
        if (hasCorner && allNonFillet) isFeature = false;
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
          visualEdges.push({ start: info.start, end: info.end });
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

  const vKey = (v) => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;

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
    const edgeResult = computeFeatureEdges(mesh.faces || []);
    return {
      ...mesh,
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
  let cx = 0, cy = 0, cz = 0;
  for (const v of face.vertices) { cx += v.x; cy += v.y; cz += v.z; }
  const n = face.vertices.length;
  return { x: cx / n, y: cy / n, z: cz / n };
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
  return { offsDir0, offsDir1, edgeDir };
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
  // Step 1: Build directed boundary-edge map.
  // For each boundary edge A→B (that exists in exactly one face),
  // the healing face should go B→A (reversed winding).
  const edgeCounts = new Map(); // edgeKey → count
  const edgeInfo = new Map();   // edgeKey → {fi, a, b, vkA, vkB}
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const ek = _edgeKeyFromVerts(a, b);
      edgeCounts.set(ek, (edgeCounts.get(ek) || 0) + 1);
      // Store directed info (last writer wins — only used for boundary edges)
      edgeInfo.set(ek + ':' + fi, { fi, a: { ...a }, b: { ...b } });
    }
  }

  // Step 2: Collect boundary edges and build outgoing map (reversed direction)
  const outgoing = new Map(); // vkFrom → {to: vkTo, posFrom, posTo}
  for (const [ek, count] of edgeCounts) {
    if (count !== 1) continue;
    // Find the directed info for this boundary edge
    let info = null;
    for (const [key, val] of edgeInfo) {
      if (key.startsWith(ek + ':')) {
        const testEk = _edgeKeyFromVerts(val.a, val.b);
        if (testEk === ek) { info = val; break; }
      }
    }
    if (!info) continue;
    const vkA = _edgeVKey(info.a), vkB = _edgeVKey(info.b);
    // Reverse: healing edge goes B→A
    outgoing.set(vkB, { to: vkA, posFrom: { ...info.b }, posTo: { ...info.a } });
  }

  if (outgoing.size === 0) return;

  // Step 3: Trace closed loops
  const visited = new Set();
  for (const [startVk] of outgoing) {
    if (visited.has(startVk)) continue;
    const loop = [];
    let current = startVk;
    while (!visited.has(current) && outgoing.has(current)) {
      visited.add(current);
      const entry = outgoing.get(current);
      loop.push(entry.posFrom);
      current = entry.to;
    }
    if (current !== startVk || loop.length < 3) continue;

    // Step 4: Triangulate the loop as a fan from vertex 0
    for (let i = 1; i < loop.length - 1; i++) {
      const triNormal = _vec3Normalize(_vec3Cross(
        _vec3Sub(loop[i], loop[0]),
        _vec3Sub(loop[i + 1], loop[0])
      ));
      if (_vec3Len(triNormal) > 1e-10) {
        faces.push({
          vertices: [{ ...loop[0] }, { ...loop[i] }, { ...loop[i + 1] }],
          normal: triNormal,
          shared: null,
        });
      }
    }
  }
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

  let faces = geometry.faces.map(f => ({
    vertices: f.vertices.map(v => ({ ...v })),
    normal: { ...f.normal },
    shared: f.shared ? { ...f.shared } : null,
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
    const data = _precomputeChamferEdge(faces, ek, distance);
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

  _weldVertices(faces);
  _removeDegenerateFaces(faces);
  _recomputeFaceNormals(faces);

  const newGeom = { vertices: [], faces, brep };
  const edgeResult = computeFeatureEdges(faces);
  newGeom.edges = edgeResult.edges;
  newGeom.paths = edgeResult.paths;
  newGeom.visualEdges = edgeResult.visualEdges;
  return newGeom;
}

/**
 * Pre-compute chamfer data for one edge on the original (unmodified) geometry.
 */
function _precomputeChamferEdge(faces, edgeKey, dist) {
  const adj = _findAdjacentFaces(faces, edgeKey);
  if (adj.length < 2) return null;

  const fi0 = adj[0].fi, fi1 = adj[1].fi;
  const face0 = faces[fi0];
  const face1 = faces[fi1];
  const edgeA = adj[0].a;
  const edgeB = adj[0].b;

  const face0Keys = _collectFaceEdgeKeys(face0);
  const face1Keys = _collectFaceEdgeKeys(face1);

  const { offsDir0, offsDir1 } = _computeOffsetDirs(face0, face1, edgeA, edgeB);

  const p0a = _vec3Add(edgeA, _vec3Scale(offsDir0, dist));
  const p0b = _vec3Add(edgeB, _vec3Scale(offsDir0, dist));
  const p1a = _vec3Add(edgeA, _vec3Scale(offsDir1, dist));
  const p1b = _vec3Add(edgeB, _vec3Scale(offsDir1, dist));

  return {
    edgeKey, fi0, fi1, edgeA, edgeB,
    face0Keys, face1Keys,
    p0a, p0b, p1a, p1b,
    shared: face0.shared ? { ...face0.shared } : null,
  };
}

// -----------------------------------------------------------------------
// Fillet geometry operation
// -----------------------------------------------------------------------

export function applyFillet(geometry, edgeKeys, radius, segments = 8) {
  if (!geometry || !geometry.faces || edgeKeys.length === 0 || radius <= 0) {
    return geometry;
  }

  let faces = geometry.faces.map(f => ({
    vertices: f.vertices.map(v => ({ ...v })),
    normal: { ...f.normal },
    shared: f.shared ? { ...f.shared } : null,
    isFillet: f.isFillet || false,
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
    const data = _precomputeFilletEdge(faces, ek, radius, segments);
    if (data) edgeDataList.push(data);
  }

  if (edgeDataList.length === 0) return geometry;

  // --- Phase 2: Build vertex-sharing map ---
  const vertexEdgeMap = _buildVertexEdgeMap(edgeDataList);

  // --- Phase 3: Apply batch face trimming ---
  _batchTrimFaces(faces, edgeDataList);

  _batchSplitVertices(faces, edgeDataList, vertexEdgeMap);

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

  for (const data of edgeDataList) {
    const shared = data.shared;
    const arcA = data.arcA;
    const arcB = data.arcB;

    // Create NURBS fillet surface for this edge
    // The fillet is a rolling-ball blend: circular arc cross-section swept along the edge.
    // Rail curves are the tangent lines on each adjacent face.
    const rail0 = [{ ...arcA[0] }, { ...arcB[0] }];
    const rail1 = [{ ...arcA[segments] }, { ...arcB[segments] }];

    // Compute arc centers at each endpoint for the NURBS definition
    const { offsDir0, offsDir1 } = _computeOffsetDirs(
      faces[data.fi0], faces[data.fi1], data.edgeA, data.edgeB
    );
    const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));
    const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
    const centerDist = alpha > 1e-6 ? radius / Math.sin(alpha / 2) : radius;
    const centerA = _vec3Add(data.edgeA, _vec3Scale(bisector, centerDist));
    const centerB = _vec3Add(data.edgeB, _vec3Scale(bisector, centerDist));

    // Create NURBS fillet surface using the rolling-ball factory
    try {
      const nurbsSurface = NurbsSurface.createFilletSurface(
        rail0, rail1, [centerA, centerB], radius, _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA))
      );
      const brepFace = new BRepFace(nurbsSurface, 'fillet', shared);

      // Add BRep edge curves for the trim lines
      const trimCurve0 = NurbsCurve.createLine(arcA[0], arcB[0]);
      const trimCurve1 = NurbsCurve.createLine(arcA[segments], arcB[segments]);
      brep.addEdge(new BRepEdge(new BRepVertex(arcA[0]), new BRepVertex(arcB[0]), trimCurve0));
      brep.addEdge(new BRepEdge(new BRepVertex(arcA[segments]), new BRepVertex(arcB[segments]), trimCurve1));

      // Add NURBS arc curves at each cross-section
      // These represent the exact circular profile of the fillet
      const edgeDir = _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA));
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

    // Create fillet strip quads (mesh tessellation — same as before)
    for (let s = 0; s < segments; s++) {
      const faceNormal = _vec3Normalize(_vec3Cross(
        _vec3Sub(arcA[s + 1], arcA[s]),
        _vec3Sub(arcB[s + 1], arcA[s])
      ));
      faces.push({
        vertices: [{ ...arcA[s] }, { ...arcA[s + 1] }, { ...arcB[s + 1] }, { ...arcB[s] }],
        normal: faceNormal,
        shared,
        isFillet: true,
      });
    }

    // Fan triangles at endpoint A — only if NOT a shared internal vertex
    const vkA = _edgeVKey(data.edgeA);
    if (!sharedEndpoints.has(vkA)) {
      for (let s = 1; s < segments; s++) {
        const triNormal = _vec3Normalize(_vec3Cross(
          _vec3Sub(arcA[s + 1], arcA[0]),
          _vec3Sub(arcA[s], arcA[0])
        ));
        faces.push({
          vertices: [{ ...arcA[0] }, { ...arcA[s + 1] }, { ...arcA[s] }],
          normal: triNormal,
          shared,
        });
      }
    }

    // Fan triangles at endpoint B — only if NOT a shared internal vertex
    const vkB = _edgeVKey(data.edgeB);
    if (!sharedEndpoints.has(vkB)) {
      for (let s = 1; s < segments; s++) {
        const triNormal = _vec3Normalize(_vec3Cross(
          _vec3Sub(arcB[s], arcB[0]),
          _vec3Sub(arcB[s + 1], arcB[0])
        ));
        faces.push({
          vertices: [{ ...arcB[0] }, { ...arcB[s] }, { ...arcB[s + 1] }],
          normal: triNormal,
          shared,
        });
      }
    }
  }

  // --- Phase 5: Generate corner/blending faces at shared vertices ---
  _generateCornerFaces(faces, origFaces, edgeDataList, vertexEdgeMap);

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

  // --- Phase 6: Heal boundary edges left by sequential fillet interactions ---
  _healBoundaryLoops(faces);

  _weldVertices(faces);
  _removeDegenerateFaces(faces);
  _recomputeFaceNormals(faces);

  const newGeom = { vertices: [], faces, brep };
  const edgeResult = computeFeatureEdges(faces);
  newGeom.edges = edgeResult.edges;
  newGeom.paths = edgeResult.paths;
  newGeom.visualEdges = edgeResult.visualEdges;
  return newGeom;
}

/**
 * Pre-compute fillet data for one edge on the original (unmodified) geometry.
 */
function _precomputeFilletEdge(faces, edgeKey, radius, segments) {
  const adj = _findAdjacentFaces(faces, edgeKey);
  if (adj.length < 2) return null;

  const fi0 = adj[0].fi, fi1 = adj[1].fi;
  const face0 = faces[fi0];
  const face1 = faces[fi1];
  const edgeA = adj[0].a;
  const edgeB = adj[0].b;

  const face0Keys = _collectFaceEdgeKeys(face0);
  const face1Keys = _collectFaceEdgeKeys(face1);

  const { offsDir0, offsDir1 } = _computeOffsetDirs(face0, face1, edgeA, edgeB);

  const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
  if (alpha < 1e-6) return null;

  const tangentDist = radius / Math.tan(alpha / 2);
  const centerDist = radius / Math.sin(alpha / 2);
  const sweep = Math.PI - alpha;
  const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));

  const t0a = _vec3Add(edgeA, _vec3Scale(offsDir0, tangentDist));
  const t0b = _vec3Add(edgeB, _vec3Scale(offsDir0, tangentDist));
  const t1a = _vec3Add(edgeA, _vec3Scale(offsDir1, tangentDist));
  const t1b = _vec3Add(edgeB, _vec3Scale(offsDir1, tangentDist));

  function computeArc(vertex) {
    const center = _vec3Add(vertex, _vec3Scale(bisector, centerDist));
    const t0 = _vec3Add(vertex, _vec3Scale(offsDir0, tangentDist));
    const e0 = _vec3Normalize(_vec3Sub(t0, center));
    const t1 = _vec3Add(vertex, _vec3Scale(offsDir1, tangentDist));
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

  const arcA = computeArc(edgeA);
  const arcB = computeArc(edgeB);

  // p0a/p0b/p1a/p1b for trim compatibility with batch helpers
  return {
    edgeKey, fi0, fi1, edgeA, edgeB,
    face0Keys, face1Keys,
    p0a: t0a, p0b: t0b, p1a: t1a, p1b: t1b,
    arcA, arcB,
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

  // Bottom arc: V[0] → V[1] ;  Left arc: V[0] → V[2] ;  Right arc: V[1] → V[2]
  const arcBottom = findArc(triVerts[0], triVerts[1]);
  const arcLeft   = findArc(triVerts[0], triVerts[2]);
  const arcRight  = findArc(triVerts[1], triVerts[2]);
  if (!arcBottom || !arcLeft || !arcRight) return false;

  // Step 3: Compute the common sphere so interior points bulge correctly.
  // All fillet arc points lie on a common sphere; find its center via circumsphere
  // of 4 non-coplanar points (3 triangle vertices + 1 interior arc point).
  const midIdx = Math.max(1, Math.floor(segs / 2));
  const p3Arc = edgeInfos[0].arc[midIdx];
  const sphereCenter = _circumsphereCenter(triVerts[0].pos, triVerts[1].pos, triVerts[2].pos, p3Arc);
  const sphereRadius = sphereCenter ? _vec3Len(_vec3Sub(triVerts[0].pos, sphereCenter)) : 0;
  const useSphere = sphereCenter !== null && sphereRadius > 1e-10;

  // Step 4: Build the triangular grid.
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
        let pt = _vec3Lerp(left, right, t);
        // Project onto the common sphere for a rounder surface
        if (useSphere) {
          const dir = _vec3Sub(pt, sphereCenter);
          const len = _vec3Len(dir);
          if (len > 1e-10) {
            pt = _vec3Add(sphereCenter, _vec3Scale(dir, sphereRadius / len));
          }
        }
        grid[r][j] = pt;
      }
    }
  }

  // Step 5: Determine correct winding by checking a boundary edge against the
  // adjacent fillet strip face.  The fillet strip quads already have consistent
  // winding; the trihedron must match by traversing shared boundary edges in
  // the opposite direction.
  const flip = _shouldFlipTrihedronWinding(faces, grid);

  // Pre-compute shared metadata for emitted corner faces.
  const triVertPositions = [{ ...triVerts[0].pos }, { ...triVerts[1].pos }, { ...triVerts[2].pos }];

  // Step 6: Emit triangles from the grid.
  for (let r = 0; r < segs; r++) {
    const currRow = grid[r];
    const nextRow = grid[r + 1];
    const currLen = currRow.length;
    const nextLen = nextRow.length;

    for (let j = 0; j < currLen - 1; j++) {
      // "Down" triangle: currRow[j], currRow[j+1], nextRow[j]
      const a = currRow[j], b = currRow[j + 1], c = nextRow[j];
      const tri1 = flip
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
        const tri2 = flip
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

  // Add the flat base triangle connecting the 3 trihedron vertices.
  // This seals the small triangular boundary loop between the 3 trimmed box
  // faces at the corner, preventing _healBoundaryLoops from creating an
  // untagged face later.
  const bk0 = _edgeVKey(triVerts[0].pos);
  const bk1 = _edgeVKey(triVerts[1].pos);
  let baseFlip = false;
  for (let fi = 0; fi < faces.length && !baseFlip; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      if (_edgeVKey(verts[i]) === bk0 &&
          _edgeVKey(verts[(i + 1) % verts.length]) === bk1) {
        baseFlip = true;
        break;
      }
    }
  }
  const baseTri = baseFlip
    ? [{ ...triVerts[0].pos }, { ...triVerts[2].pos }, { ...triVerts[1].pos }]
    : [{ ...triVerts[0].pos }, { ...triVerts[1].pos }, { ...triVerts[2].pos }];
  const baseN = _vec3Normalize(_vec3Cross(
    _vec3Sub(baseTri[1], baseTri[0]), _vec3Sub(baseTri[2], baseTri[0])
  ));
  if (_vec3Len(baseN) > 1e-10) {
    faces.push({ vertices: baseTri, normal: baseN, shared, isCorner: true });
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
      // Ruled surface between the two fillet cross-section arcs, split into
      // triangles along the diagonal so each half can merge with the adjacent
      // fillet strip group.  The diagonal becomes the feature line where the
      // two fillets meet — no separate corner patch is needed.
      //
      // Winding: check a representative triangle against existing fillet
      // faces to ensure consistent orientation.
      const flip = _shouldFlipTrihedronWinding(faces, [
        [arcCurr[0], arcCurr[1]],  // just need first 2 points in row 0
      ]);

      for (let s = 0; s < segs; s++) {
        if (s < segs - 1) {
          const v0 = arcCurr[s], v1 = arcCurr[s + 1];
          const v2 = arcNext[s + 1], v3 = arcNext[s];

          // Triangle along arcCurr side → merges with fillet strip 1
          const tri1 = flip
            ? [{ ...v0 }, { ...v2 }, { ...v1 }]
            : [{ ...v0 }, { ...v1 }, { ...v2 }];
          const n1 = _vec3Normalize(_vec3Cross(
            _vec3Sub(tri1[1], tri1[0]), _vec3Sub(tri1[2], tri1[0])
          ));
          if (_vec3Len(n1) > 1e-10) {
            faces.push({ vertices: tri1, normal: n1, shared, isFillet: true });
          }

          // Triangle along arcNext side → merges with fillet strip 2
          const tri2 = flip
            ? [{ ...v0 }, { ...v3 }, { ...v2 }]
            : [{ ...v0 }, { ...v2 }, { ...v3 }];
          const n2 = _vec3Normalize(_vec3Cross(
            _vec3Sub(tri2[1], tri2[0]), _vec3Sub(tri2[2], tri2[0])
          ));
          if (_vec3Len(n2) > 1e-10) {
            faces.push({ vertices: tri2, normal: n2, shared, isFillet: true });
          }
        } else {
          // Last row: single triangle (both arcs converge to same endpoint)
          const v0 = arcCurr[s], v1 = arcCurr[s + 1], v2 = arcNext[s];
          const tri = flip
            ? [{ ...v0 }, { ...v2 }, { ...v1 }]
            : [{ ...v0 }, { ...v1 }, { ...v2 }];
          const triNormal = _vec3Normalize(_vec3Cross(
            _vec3Sub(tri[1], tri[0]), _vec3Sub(tri[2], tri[0])
          ));
          if (_vec3Len(triNormal) > 1e-10) {
            faces.push({ vertices: tri, normal: triNormal, shared, isFillet: true });
          }
        }
      }
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

  // Collect all path indices touched by the input keys
  const touchedPaths = new Set();
  for (const ek of edgeKeys) {
    const ei = keyToIndex.get(ek);
    if (ei !== undefined) {
      const pi = edgeToPath.get(ei);
      if (pi !== undefined) touchedPaths.add(pi);
    }
  }

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
    result.add(ek);
  }

  return [...result];
}

// js/cad/CSGLegacy.js — Legacy BSP/mesh CSG classes and functions extracted
// from CSG.js.  Contains the mesh-based boolean engine (BSP tree approach)
// and the compatibility façade that dispatches to the exact boolean kernel
// when operands carry exact B-Rep topology.

import { exactBooleanOp, hasExactTopology } from './BooleanKernel.js';
import { tessellateBody } from './Tessellation.js';
import { computeFeatureEdges } from './EdgeAnalysis.js';

import {
  vec3Sub as _vec3Sub,
  vec3Dot as _vec3Dot,
  vec3Cross as _vec3Cross,
  vec3Len as _vec3Len,
  vec3Normalize as _vec3Normalize,
  edgeVKey as _edgeVKey,
  edgeKeyFromVerts as _edgeKeyFromVerts,
} from './toolkit/Vec3Utils.js';

import {
  computePolygonNormal as _computePolygonNormal,
  pointOnSegmentStrict,
} from './toolkit/GeometryUtils.js';

import {
  weldVertices as _weldVertices,
  removeDegenerateFaces as _removeDegenerateFaces,
  recomputeFaceNormals as _recomputeFaceNormals,
  fixWindingConsistency as _fixWindingConsistency,
} from './toolkit/MeshRepair.js';

import {
  classifyFaceType,
  isConvexPlanarPolygon as _isConvexPlanarPolygon,
  triangulatePlanarPolygon as _triangulatePlanarPolygon,
} from './toolkit/PlanarMath.js';

import {
  polygonArea as _polygonArea,
  facesSharePlane as _facesSharePlane,
  sharedMetadataSignature as _sharedMetadataSignature,
} from './toolkit/CoplanarUtils.js';

import { measureMeshTopology } from './toolkit/TopologyUtils.js';

// -----------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------

export const EPSILON = 1e-5;

export const COPLANAR = 0;
export const FRONT = 1;
export const BACK = 2;
export const SPANNING = 3;

// -----------------------------------------------------------------------
// Vector3 helper
// -----------------------------------------------------------------------

export class Vec3 {
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

export class Vertex {
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

export class Polygon {
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

export class Plane {
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

export class Node {
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

export class CSGSolid {
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
export function _fixTJunctions(faces) {
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
// Internal helpers (not exported)
// -----------------------------------------------------------------------

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

  // --- BRep-only pipeline: legacy mesh BSP fallback is DISABLED ---
  // Both operands MUST carry exact B-Rep topology. If they don't, the
  // upstream feature (extrude, revolve, …) must be fixed to produce a
  // TopoBody. Falling back to mesh BSP would corrupt the topology chain.
  const missingA = !geomA?.topoBody ? 'operand A' : null;
  const missingB = !geomB?.topoBody ? 'operand B' : null;
  const missing = [missingA, missingB].filter(Boolean).join(' and ');
  throw new Error(
    `[BRep-only] booleanOp('${operation}') requires exact topology on both operands, ` +
    `but ${missing} lack(s) a TopoBody. Legacy CSG/BSP mesh boolean is no longer supported.`
  );
}

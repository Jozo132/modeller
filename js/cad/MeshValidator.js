// js/cad/MeshValidator.js — Triangle mesh validation utilities
//
// Checks for:
//   1. Self-intersecting triangles (pairs of triangles that cross each other)
//   2. Boundary edges (non-manifold mesh)
//   3. Degenerate triangles (zero-area)

/**
 * Detect self-intersecting or mutually intersecting triangle pairs.
 *
 * Two triangles "intersect" when an edge of one passes through the interior
 * of the other, excluding shared edges/vertices (which are topologically
 * expected in any triangle mesh).
 *
 * @param {{ vertices: {x,y,z}[], normal?: {x,y,z} }[]} faces - Array of triangle faces
 * @param {Object} [opts]
 * @param {boolean} [opts.sameGroupOnly=false] - Only test within the same faceGroup
 * @returns {{ count: number, pairs: [number,number][] }}
 */
export function detectSelfIntersections(faces, opts = {}) {
  const pairs = [];
  const n = faces.length;
  const sameGroupOnly = opts.sameGroupOnly || false;
  const sameTopoFaceOnly = opts.sameTopoFaceOnly || false;

  for (let i = 0; i < n; i++) {
    const fa = faces[i];
    if (fa.vertices.length !== 3) continue;
    for (let j = i + 1; j < n; j++) {
      const fb = faces[j];
      if (fb.vertices.length !== 3) continue;
      if (sameGroupOnly && fa.faceGroup !== fb.faceGroup) continue;
      if (sameTopoFaceOnly && fa.topoFaceId !== undefined && fb.topoFaceId !== undefined && fa.topoFaceId !== fb.topoFaceId) continue;

      // Skip triangles that share an edge or vertex (neighbours)
      if (_sharesVertexOrEdge(fa.vertices, fb.vertices)) continue;

      if (_trianglesIntersect(fa.vertices, fb.vertices)) {
        pairs.push([i, j]);
      }
    }
  }

  return { count: pairs.length, pairs };
}

/**
 * Detect boundary (non-manifold) edges in a triangle mesh.
 *
 * For a closed solid mesh, every edge should be shared by exactly 2 triangles.
 * Any edge shared by only 1 triangle is a "boundary" (mesh gap).
 *
 * @param {{ vertices: {x,y,z}[] }[]} faces
 * @returns {{ count: number, edges: { a: {x,y,z}, b: {x,y,z}, faceIndex: number }[] }}
 */
export function detectBoundaryEdges(faces) {
  const edgeMap = new Map();
  const PREC = 6;

  function vk(v) {
    const fmt = c => (+c.toFixed(PREC) || 0).toFixed(PREC);
    return `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`;
  }
  function ek(a, b) {
    const ka = vk(a), kb = vk(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  }

  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const key = ek(a, b);
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push(fi);
    }
  }

  const boundary = [];
  for (const [, fis] of edgeMap) {
    if (fis.length === 1) {
      const fi = fis[0];
      const verts = faces[fi].vertices;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i], b = verts[(i + 1) % verts.length];
        if (edgeMap.get(ek(a, b)).length === 1) {
          boundary.push({ a, b, faceIndex: fi });
          break;
        }
      }
    }
  }

  return { count: boundary.length, edges: boundary };
}

/**
 * Detect degenerate (zero-area) triangles.
 *
 * @param {{ vertices: {x,y,z}[] }[]} faces
 * @param {number} [areaThreshold=1e-12]
 * @returns {{ count: number, indices: number[] }}
 */
export function detectDegenerateFaces(faces, areaThreshold = 1e-12) {
  const indices = [];
  for (let i = 0; i < faces.length; i++) {
    const v = faces[i].vertices;
    if (v.length < 3) { indices.push(i); continue; }
    const area = _triangleArea(v[0], v[1], v[2]);
    if (area < areaThreshold) indices.push(i);
  }
  return { count: indices.length, indices };
}

/**
 * Check whether a triangle mesh is watertight (closed manifold).
 *
 * A mesh is watertight when every edge is shared by exactly two triangles
 * and there are no boundary (open) edges.
 *
 * @param {{ vertices: {x,y,z}[] }[]} faces
 * @returns {{ watertight: boolean, boundaryCount: number, edges: Array }}
 */
export function checkWatertight(faces) {
  const be = detectBoundaryEdges(faces);
  return {
    watertight: be.count === 0,
    boundaryCount: be.count,
    edges: be.edges,
  };
}

/**
 * Run all mesh validations and return a summary.
 *
 * @param {{ vertices: {x,y,z}[], normal?: {x,y,z} }[]} faces
 * @returns {{ selfIntersections: number, boundaryEdges: number, degenerateFaces: number, isClean: boolean, details: Object }}
 */
export function validateMesh(faces) {
  const si = detectSelfIntersections(faces);
  const be = detectBoundaryEdges(faces);
  const df = detectDegenerateFaces(faces);

  return {
    selfIntersections: si.count,
    boundaryEdges: be.count,
    degenerateFaces: df.count,
    isClean: si.count === 0 && be.count === 0 && df.count === 0,
    details: {
      selfIntersectionPairs: si.pairs,
      boundaryEdgeList: be.edges,
      degenerateFaceIndices: df.indices,
    },
  };
}

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

const _EPS = 1e-10;

function _cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function _dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

function _sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }

function _triangleArea(a, b, c) {
  const ab = _sub(b, a);
  const ac = _sub(c, a);
  const cr = _cross(ab, ac);
  return 0.5 * Math.sqrt(cr.x * cr.x + cr.y * cr.y + cr.z * cr.z);
}

/** Check if two triangles share at least one vertex position. */
function _sharesVertexOrEdge(va, vb) {
  for (const a of va) {
    for (const b of vb) {
      if (Math.abs(a.x - b.x) < _EPS && Math.abs(a.y - b.y) < _EPS && Math.abs(a.z - b.z) < _EPS) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Moller–Trumbore segment-triangle intersection.
 * Returns true if segment [p0,p1] passes through the interior of triangle [v0,v1,v2].
 */
function _segmentTriangleIntersect(p0, p1, v0, v1, v2) {
  const dir = _sub(p1, p0);
  const e1 = _sub(v1, v0);
  const e2 = _sub(v2, v0);
  const h = _cross(dir, e2);
  const a = _dot(e1, h);
  if (Math.abs(a) < _EPS) return false; // parallel

  const f = 1 / a;
  const s = _sub(p0, v0);
  const u = f * _dot(s, h);
  if (u < _EPS || u > 1 - _EPS) return false;

  const q = _cross(s, e1);
  const v = f * _dot(dir, q);
  if (v < _EPS || u + v > 1 - _EPS) return false;

  const t = f * _dot(e2, q);
  return t > _EPS && t < 1 - _EPS;
}

/** Check if two triangles intersect (edge of one passes through the other). */
function _trianglesIntersect(t1, t2) {
  for (const [a, b] of [[t1, t2], [t2, t1]]) {
    for (let i = 0; i < 3; i++) {
      if (_segmentTriangleIntersect(a[i], a[(i + 1) % 3], b[0], b[1], b[2])) {
        return true;
      }
    }
  }
  return false;
}

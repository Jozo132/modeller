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

  // Build a uniform spatial grid over triangle AABBs so we only pair-test
  // triangles whose bounding boxes overlap. Without this, a 10 k-triangle
  // fillet mesh would do ~5 × 10⁷ pairwise tests (the dominant cost on
  // multi-edge fillet/chamfer); with the grid it drops to near-linear.
  // For tiny meshes the grid overhead isn't worth it.
  if (n < 256) {
    for (let i = 0; i < n; i++) {
      const fa = faces[i];
      if (fa.vertices.length !== 3) continue;
      for (let j = i + 1; j < n; j++) {
        const fb = faces[j];
        if (fb.vertices.length !== 3) continue;
        if (sameGroupOnly && fa.faceGroup !== fb.faceGroup) continue;
        if (sameTopoFaceOnly && fa.topoFaceId !== undefined && fb.topoFaceId !== undefined && fa.topoFaceId !== fb.topoFaceId) continue;
        if (_sharesVertexOrEdge(fa.vertices, fb.vertices)) continue;
        if (_trianglesIntersect(fa.vertices, fb.vertices)) pairs.push([i, j]);
      }
    }
    return { count: pairs.length, pairs };
  }

  // Precompute per-triangle AABBs and a global bounding box.
  const aabbs = new Array(n);
  let gxmin = Infinity, gymin = Infinity, gzmin = Infinity;
  let gxmax = -Infinity, gymax = -Infinity, gzmax = -Infinity;
  let triCount = 0;
  for (let i = 0; i < n; i++) {
    const f = faces[i];
    if (f.vertices.length !== 3) { aabbs[i] = null; continue; }
    const [a, b, c] = f.vertices;
    const xmin = Math.min(a.x, b.x, c.x), xmax = Math.max(a.x, b.x, c.x);
    const ymin = Math.min(a.y, b.y, c.y), ymax = Math.max(a.y, b.y, c.y);
    const zmin = Math.min(a.z, b.z, c.z), zmax = Math.max(a.z, b.z, c.z);
    aabbs[i] = [xmin, ymin, zmin, xmax, ymax, zmax];
    if (xmin < gxmin) gxmin = xmin; if (ymin < gymin) gymin = ymin; if (zmin < gzmin) gzmin = zmin;
    if (xmax > gxmax) gxmax = xmax; if (ymax > gymax) gymax = ymax; if (zmax > gzmax) gzmax = zmax;
    triCount++;
  }
  if (triCount === 0) return { count: 0, pairs: [] };

  // Choose grid resolution so each cell holds ~1 triangle on average. Use
  // the cube root of the triangle count per axis.
  const res = Math.max(1, Math.ceil(Math.cbrt(triCount)));
  const sx = (gxmax - gxmin) / res || 1;
  const sy = (gymax - gymin) / res || 1;
  const sz = (gzmax - gzmin) / res || 1;

  function cellKey(ix, iy, iz) { return ix * 131071 + iy * 257 + iz; }

  /** @type {Map<number, number[]>} */
  const grid = new Map();
  const triCells = new Array(n);
  for (let i = 0; i < n; i++) {
    const aa = aabbs[i];
    if (!aa) { triCells[i] = null; continue; }
    const ix0 = Math.max(0, Math.min(res - 1, Math.floor((aa[0] - gxmin) / sx)));
    const iy0 = Math.max(0, Math.min(res - 1, Math.floor((aa[1] - gymin) / sy)));
    const iz0 = Math.max(0, Math.min(res - 1, Math.floor((aa[2] - gzmin) / sz)));
    const ix1 = Math.max(0, Math.min(res - 1, Math.floor((aa[3] - gxmin) / sx)));
    const iy1 = Math.max(0, Math.min(res - 1, Math.floor((aa[4] - gymin) / sy)));
    const iz1 = Math.max(0, Math.min(res - 1, Math.floor((aa[5] - gzmin) / sz)));
    const cells = [];
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = cellKey(ix, iy, iz);
          cells.push(k);
          let bucket = grid.get(k);
          if (!bucket) { bucket = []; grid.set(k, bucket); }
          bucket.push(i);
        }
      }
    }
    triCells[i] = cells;
  }

  // Dedupe: triangles spanning multiple cells would produce duplicate
  // (i, j) pairs. Using a Set<number> showed up as ~43% of profile time
  // (FindOrderedHashSetEntry + SetPrototypeAdd) on 26k-triangle meshes.
  // Replace with a per-iteration mark array: for the outer triangle `i`,
  // `lastPair[j] === i` means we've already handled this pair.
  const lastPair = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const cells = triCells[i];
    if (!cells) continue;
    const fa = faces[i];
    const aai = aabbs[i];
    for (let c = 0; c < cells.length; c++) {
      const bucket = grid.get(cells[c]);
      if (!bucket) continue;
      for (let b = 0; b < bucket.length; b++) {
        const j = bucket[b];
        if (j <= i) continue;
        if (lastPair[j] === i) continue;
        lastPair[j] = i;
        const fb = faces[j];
        if (fb.vertices.length !== 3) continue;
        if (sameGroupOnly && fa.faceGroup !== fb.faceGroup) continue;
        if (sameTopoFaceOnly && fa.topoFaceId !== undefined && fb.topoFaceId !== undefined && fa.topoFaceId !== fb.topoFaceId) continue;
        // AABB reject
        const aaj = aabbs[j];
        if (aai[3] < aaj[0] || aaj[3] < aai[0]) continue;
        if (aai[4] < aaj[1] || aaj[4] < aai[1]) continue;
        if (aai[5] < aaj[2] || aaj[5] < aai[2]) continue;
        if (_sharesVertexOrEdge(fa.vertices, fb.vertices)) continue;
        if (_trianglesIntersect(fa.vertices, fb.vertices)) pairs.push([i, j]);
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

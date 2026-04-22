// js/cad/toolkit/MeshAnalysis.js — Mesh analysis utilities extracted from CSG.js.
// Provides functions for inspecting geometry meshes: volume, surface area,
// bounding box, inverted-face detection, disconnected-body detection, and
// wall-thickness estimation.

import { vec3Cross, vec3Sub, vec3Len, vec3Dot, rayTriangleIntersect } from './Vec3Utils.js';
import { computePolygonNormal, edgeKey } from './GeometryUtils.js';

// ---------------------------------------------------------------------------
// Exported analysis functions
// ---------------------------------------------------------------------------

/**
 * Count faces whose polygon winding opposes their stored face normal.
 * Degenerate faces or faces without a stored normal are ignored.
 * @param {Object} geometry - {faces: [{vertices: [...], normal: {x,y,z}}]}
 * @returns {number}
 */
export function countInvertedFaces(geometry) {
  let inverted = 0;
  for (const face of (geometry.faces || [])) {
    const polygonNormal = computePolygonNormal(face.vertices || []);
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

// Memoization table for calculateWallThickness. The function is a pure
// function of its geometry argument, but callers frequently ask for both
// min and max thickness (plus a positive-thickness assertion) on the same
// mesh, which triggers redundant O(n^2) ray casts. A WeakMap keyed on the
// geometry object lets us return the cached result in O(1) without leaking
// memory when the geometry is GC'd.
const _wallThicknessCache = new WeakMap();

/**
 * Estimate wall thickness by ray-casting from each face centroid along its
 * inward normal and finding the nearest opposing face hit.
 * Returns min and max wall thickness across all faces.
 *
 * Acceleration: for meshes with more than a few hundred faces the naive
 * O(n^2) scan becomes the dominant cost in several tests (Unnamed-Body
 * with 6152 triangles used to take ~2s per call). We build a uniform 3D
 * grid over triangle AABBs and walk only the cells pierced by the ray,
 * which prunes nearly all of the pairs while preserving exact results.
 *
 * @param {Object} geometry - {faces: [{vertices: [{x,y,z},...], normal: {x,y,z}, ...}]}
 * @returns {Object} { minThickness: number, maxThickness: number }
 */
export function calculateWallThickness(geometry) {
  if (geometry && typeof geometry === 'object') {
    const cached = _wallThicknessCache.get(geometry);
    if (cached) return cached;
  }

  const faces = geometry.faces || [];
  if (faces.length < 2) {
    const empty = { minThickness: 0, maxThickness: 0 };
    if (geometry && typeof geometry === 'object') _wallThicknessCache.set(geometry, empty);
    return empty;
  }

  // Flatten each polygon face into a list of triangles once. We also
  // compute per-face centroid and cache each triangle's AABB for the
  // grid broad-phase.
  const tris = []; // {fi, v0, v1, v2, min:[3], max:[3]}
  const centroids = new Array(faces.length);
  let gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity;
  let gMaxX = -Infinity, gMaxY = -Infinity, gMaxZ = -Infinity;

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    const vs = face.vertices;
    if (!vs || vs.length < 3) { centroids[fi] = null; continue; }
    let cx = 0, cy = 0, cz = 0;
    for (const v of vs) { cx += v.x; cy += v.y; cz += v.z; }
    centroids[fi] = { x: cx / vs.length, y: cy / vs.length, z: cz / vs.length };

    const v0 = vs[0];
    for (let k = 1; k < vs.length - 1; k++) {
      const v1 = vs[k], v2 = vs[k + 1];
      const minX = Math.min(v0.x, v1.x, v2.x);
      const minY = Math.min(v0.y, v1.y, v2.y);
      const minZ = Math.min(v0.z, v1.z, v2.z);
      const maxX = Math.max(v0.x, v1.x, v2.x);
      const maxY = Math.max(v0.y, v1.y, v2.y);
      const maxZ = Math.max(v0.z, v1.z, v2.z);
      tris.push({ fi, v0, v1, v2, minX, minY, minZ, maxX, maxY, maxZ });
      if (minX < gMinX) gMinX = minX; if (maxX > gMaxX) gMaxX = maxX;
      if (minY < gMinY) gMinY = minY; if (maxY > gMaxY) gMaxY = maxY;
      if (minZ < gMinZ) gMinZ = minZ; if (maxZ > gMaxZ) gMaxZ = maxZ;
    }
  }

  // Build uniform grid for ray broad-phase. Skip grid for tiny meshes
  // (the bookkeeping would dominate).
  let grid = null;
  let res = 1, cellX = 1, cellY = 1, cellZ = 1;
  if (tris.length >= 256 && Number.isFinite(gMinX)) {
    res = Math.max(1, Math.ceil(Math.cbrt(tris.length)));
    // Avoid zero-extent cells on axis-aligned meshes.
    const ex = Math.max(gMaxX - gMinX, 1e-9);
    const ey = Math.max(gMaxY - gMinY, 1e-9);
    const ez = Math.max(gMaxZ - gMinZ, 1e-9);
    cellX = ex / res; cellY = ey / res; cellZ = ez / res;
    grid = new Array(res * res * res);
    for (let i = 0; i < grid.length; i++) grid[i] = null;
    const cellIdx = (ix, iy, iz) => ix + res * (iy + res * iz);
    for (let t = 0; t < tris.length; t++) {
      const tr = tris[t];
      const ix0 = Math.min(res - 1, Math.max(0, Math.floor((tr.minX - gMinX) / cellX)));
      const iy0 = Math.min(res - 1, Math.max(0, Math.floor((tr.minY - gMinY) / cellY)));
      const iz0 = Math.min(res - 1, Math.max(0, Math.floor((tr.minZ - gMinZ) / cellZ)));
      const ix1 = Math.min(res - 1, Math.max(0, Math.floor((tr.maxX - gMinX) / cellX)));
      const iy1 = Math.min(res - 1, Math.max(0, Math.floor((tr.maxY - gMinY) / cellY)));
      const iz1 = Math.min(res - 1, Math.max(0, Math.floor((tr.maxZ - gMinZ) / cellZ)));
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          for (let ix = ix0; ix <= ix1; ix++) {
            const k = cellIdx(ix, iy, iz);
            const bucket = grid[k] || (grid[k] = []);
            bucket.push(t);
          }
        }
      }
    }
  }

  const EPS = 1e-6;
  let minT = Infinity, maxT = 0;

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    const n = face.normal;
    const origin = centroids[fi];
    if (!n || !origin) continue;
    const dx = -n.x, dy = -n.y, dz = -n.z;

    let closest = Infinity;
    const visited = grid ? new Set() : null;

    const considerTri = (t) => {
      const tr = tris[t];
      if (tr.fi === fi) return;
      const targetNormal = faces[tr.fi].normal;
      if (!targetNormal) return;
      const dotNormals = n.x * targetNormal.x + n.y * targetNormal.y + n.z * targetNormal.z;
      if (dotNormals > -0.1) return;
      const tHit = rayTriangleIntersect(origin, { x: dx, y: dy, z: dz }, tr.v0, tr.v1, tr.v2);
      if (tHit > EPS && tHit < closest) closest = tHit;
    };

    if (grid) {
      // Walk the ray through the grid (3D DDA) up to a max distance of
      // the global diagonal. Accumulate unique triangle ids via "visited".
      const invDx = dx !== 0 ? 1 / dx : Infinity;
      const invDy = dy !== 0 ? 1 / dy : Infinity;
      const invDz = dz !== 0 ? 1 / dz : Infinity;
      let ix = Math.min(res - 1, Math.max(0, Math.floor((origin.x - gMinX) / cellX)));
      let iy = Math.min(res - 1, Math.max(0, Math.floor((origin.y - gMinY) / cellY)));
      let iz = Math.min(res - 1, Math.max(0, Math.floor((origin.z - gMinZ) / cellZ)));
      const stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
      const stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
      const stepZ = dz > 0 ? 1 : (dz < 0 ? -1 : 0);
      const nextBoundary = (i, step, minW, cell) =>
        step > 0 ? minW + (i + 1) * cell : (step < 0 ? minW + i * cell : Infinity);
      let tMaxX = stepX !== 0 ? (nextBoundary(ix, stepX, gMinX, cellX) - origin.x) * invDx : Infinity;
      let tMaxY = stepY !== 0 ? (nextBoundary(iy, stepY, gMinY, cellY) - origin.y) * invDy : Infinity;
      let tMaxZ = stepZ !== 0 ? (nextBoundary(iz, stepZ, gMinZ, cellZ) - origin.z) * invDz : Infinity;
      const tDeltaX = stepX !== 0 ? Math.abs(cellX * invDx) : Infinity;
      const tDeltaY = stepY !== 0 ? Math.abs(cellY * invDy) : Infinity;
      const tDeltaZ = stepZ !== 0 ? Math.abs(cellZ * invDz) : Infinity;

      // Cap the walk at the grid diagonal's ray-parameter length.
      const maxRayT = Math.sqrt(
        (gMaxX - gMinX) * (gMaxX - gMinX) +
        (gMaxY - gMinY) * (gMaxY - gMinY) +
        (gMaxZ - gMinZ) * (gMaxZ - gMinZ)
      );

      while (
        ix >= 0 && ix < res && iy >= 0 && iy < res && iz >= 0 && iz < res
      ) {
        const cell = grid[ix + res * (iy + res * iz)];
        if (cell) {
          for (const t of cell) {
            if (visited.has(t)) continue;
            visited.add(t);
            considerTri(t);
          }
          // Early termination: if we've already found a hit closer than the
          // parameter at which we'd leave this cell, we cannot improve it.
          const cellTExit = Math.min(tMaxX, tMaxY, tMaxZ);
          if (closest < cellTExit) break;
        }
        if (tMaxX < tMaxY && tMaxX < tMaxZ) {
          ix += stepX; if (tMaxX > maxRayT) break; tMaxX += tDeltaX;
        } else if (tMaxY < tMaxZ) {
          iy += stepY; if (tMaxY > maxRayT) break; tMaxY += tDeltaY;
        } else {
          iz += stepZ; if (tMaxZ > maxRayT) break; tMaxZ += tDeltaZ;
        }
      }
    } else {
      for (let t = 0; t < tris.length; t++) considerTri(t);
    }

    if (closest < Infinity) {
      if (closest < minT) minT = closest;
      if (closest > maxT) maxT = closest;
    }
  }

  if (minT === Infinity) minT = 0;
  const result = { minThickness: minT, maxThickness: maxT };
  if (geometry && typeof geometry === 'object') _wallThicknessCache.set(geometry, result);
  return result;
}

// rayTriangleIntersect is imported from Vec3Utils.js and re-exported here
// for convenience — it is the Möller–Trumbore ray-triangle intersection.
export { rayTriangleIntersect };

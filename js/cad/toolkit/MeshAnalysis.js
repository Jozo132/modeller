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
        const t = rayTriangleIntersect(origin, dir, v0, v1, v2);
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

// rayTriangleIntersect is imported from Vec3Utils.js and re-exported here
// for convenience — it is the Möller–Trumbore ray-triangle intersection.
export { rayTriangleIntersect };

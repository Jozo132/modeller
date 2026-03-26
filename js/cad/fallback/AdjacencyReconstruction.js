// js/cad/fallback/AdjacencyReconstruction.js — Minimal adjacency/topology reconstruction
//
// Rebuilds edge adjacency information from a triangle mesh so that
// downstream tessellation, rendering, and mesh-level validation can work.
// Does NOT attempt exact B-Rep refitting.

/**
 * Reconstruct edge adjacency from a triangle mesh.
 *
 * Builds a half-edge–style adjacency structure from vertex positions using
 * a spatial hash. Each edge records which faces share it, enabling manifold
 * checks, boundary detection, and basic topology queries.
 *
 * @param {{ vertices: {x,y,z}[], normal?: {x,y,z}, faceGroup?: number }[]} faces
 * @param {Object} [opts]
 * @param {number} [opts.snapTolerance=1e-8]
 * @returns {{
 *   edges: Map<string, { a: {x,y,z}, b: {x,y,z}, faceIndices: number[] }>,
 *   boundaryEdgeCount: number,
 *   nonManifoldEdgeCount: number,
 *   eulerCharacteristic: number,
 *   isManifold: boolean,
 *   isClosed: boolean,
 * }}
 */
export function reconstructAdjacency(faces, opts = {}) {
  const snapTol = opts.snapTolerance ?? 1e-8;
  const PREC = Math.max(1, Math.min(12, Math.round(-Math.log10(snapTol))));
  const edges = new Map();

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
    if (!verts) continue;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const key = ek(a, b);
      if (!edges.has(key)) {
        edges.set(key, { a, b, faceIndices: [] });
      }
      edges.get(key).faceIndices.push(fi);
    }
  }

  // Compute statistics
  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;

  for (const edge of edges.values()) {
    if (edge.faceIndices.length === 1) boundaryEdgeCount++;
    else if (edge.faceIndices.length > 2) nonManifoldEdgeCount++;
  }

  // Euler characteristic: V - E + F (for orientable closed surface, should be 2)
  const uniqueVerts = new Set();
  for (const face of faces) {
    if (!face.vertices) continue;
    for (const v of face.vertices) uniqueVerts.add(vk(v));
  }

  const V = uniqueVerts.size;
  const E = edges.size;
  const F = faces.length;
  const eulerCharacteristic = V - E + F;

  return {
    edges,
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    eulerCharacteristic,
    isManifold: nonManifoldEdgeCount === 0,
    isClosed: boundaryEdgeCount === 0,
  };
}

/**
 * Extract visual edges (feature lines) from adjacency data.
 * An edge is a feature line if the angle between its two adjacent face
 * normals exceeds a threshold.
 *
 * @param {Map} edges - Edge map from reconstructAdjacency
 * @param {{ vertices: {x,y,z}[], normal?: {x,y,z} }[]} faces
 * @param {Object} [opts]
 * @param {number} [opts.angleThreshold=0.5] - Angle threshold in radians
 * @returns {{ a: {x,y,z}, b: {x,y,z} }[]}
 */
export function extractFeatureEdges(edges, faces, opts = {}) {
  const threshold = opts.angleThreshold ?? 0.5;
  const cosThreshold = Math.cos(threshold);
  const result = [];

  for (const edge of edges.values()) {
    // Boundary edges are always feature edges
    if (edge.faceIndices.length === 1) {
      result.push({ a: edge.a, b: edge.b });
      continue;
    }
    if (edge.faceIndices.length !== 2) continue;

    const nA = faces[edge.faceIndices[0]]?.normal;
    const nB = faces[edge.faceIndices[1]]?.normal;
    if (!nA || !nB) continue;

    const dot = nA.x * nB.x + nA.y * nB.y + nA.z * nB.z;
    if (dot < cosThreshold) {
      result.push({ a: edge.a, b: edge.b });
    }
  }

  return result;
}

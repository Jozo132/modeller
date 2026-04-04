// js/cad/toolkit/TopologyUtils.js — Mesh and B-Rep topology analysis utilities.
// Extracted from CSG.js for reuse across CAD modules.

import {
  vec3Sub, vec3Len, vec3Normalize, vec3Dot,
  edgeVKey, edgeKeyFromVerts,
} from './Vec3Utils.js';

// -----------------------------------------------------------------------
// Mesh topology analysis
// -----------------------------------------------------------------------

/**
 * Analyse edge-usage topology of a triangulated mesh.
 *
 * Walks every face edge and counts usage per oriented edge.  Returns:
 * - boundaryEdges:    edges used by exactly 1 face (open mesh)
 * - nonManifoldEdges: edges used by 3+ faces
 * - windingErrors:    edges used by 2 faces with the same winding direction
 *                     (both traversed in the same order → winding inconsistency)
 *
 * @param {Array<{vertices:Array<{x:number,y:number,z:number}>}>} faces
 * @returns {{boundaryEdges:number, nonManifoldEdges:number, windingErrors:number}}
 */
export function measureMeshTopology(faces) {
  const edgeMap = new Map();
  for (const face of faces || []) {
    const verts = face.vertices || [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const ka = edgeVKey(a);
      const kb = edgeVKey(b);
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

/**
 * Count boundary edges in a TopoBody (B-Rep structure).
 *
 * A boundary edge is one referenced by fewer than 2 coedges across all
 * shells / faces / loops.  Returns Infinity when the body has no shells.
 *
 * @param {Object} topoBody  TopoBody with `.shells[].faces[].allLoops().coedges`
 * @returns {number}
 */
export function countTopoBodyBoundaryEdges(topoBody) {
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

// -----------------------------------------------------------------------
// Adjacency / vertex-edge lookup
// -----------------------------------------------------------------------

/**
 * Find the two faces that share a mesh edge (identified by its key string).
 *
 * First tries an exact edge-key match.  If that finds fewer than 2 faces,
 * falls back to a fuzzy search using direction, midpoint proximity, and
 * length ratio.
 *
 * @param {Array<{vertices:Array<{x:number,y:number,z:number}>}>} faces
 * @param {string} edgeKeyStr  Canonical edge key, e.g. "x0,y0,z0|x1,y1,z1"
 * @returns {Array<{fi:number, a:{x:number,y:number,z:number}, b:{x:number,y:number,z:number}}>}
 */
export function findAdjacentFaces(faces, edgeKeyStr) {
  // --- exact match ---
  const adj = [];
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      if (edgeKeyFromVerts(a, b) === edgeKeyStr) {
        adj.push({ fi, a, b });
        break;
      }
    }
    if (adj.length >= 2) break;
  }
  if (adj.length >= 2) return adj;

  // --- fuzzy fallback ---
  const sep = edgeKeyStr.indexOf('|');
  if (sep < 0) return adj;
  const parseV = (s) => { const c = s.split(',').map(Number); return { x: c[0], y: c[1], z: c[2] }; };
  const origA = parseV(edgeKeyStr.slice(0, sep));
  const origB = parseV(edgeKeyStr.slice(sep + 1));
  const origDelta = vec3Sub(origB, origA);
  const origLen = vec3Len(origDelta);
  if (origLen < 1e-10) return adj;
  const origDir = vec3Normalize(origDelta);
  const origMid = { x: (origA.x + origB.x) / 2, y: (origA.y + origB.y) / 2, z: (origA.z + origB.z) / 2 };
  const maxMidDist = origLen * 0.4;

  const candidates = [];
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const d = vec3Sub(b, a);
      const len = vec3Len(d);
      if (len < 1e-10) continue;
      if (Math.abs(vec3Dot(vec3Normalize(d), origDir)) < 0.95) continue;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
      const midDist = vec3Len(vec3Sub(mid, origMid));
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

/**
 * Build a map from vertex key → list of edge-data indices that share
 * that vertex.  Used for batch chamfer/fillet vertex merging.
 *
 * @param {Array<{edgeA:{x:number,y:number,z:number}, edgeB:{x:number,y:number,z:number}}>} edgeDataList
 * @returns {Map<string, number[]>}
 */
export function buildVertexEdgeMap(edgeDataList) {
  const map = new Map();
  for (let i = 0; i < edgeDataList.length; i++) {
    const d = edgeDataList[i];
    const vkA = edgeVKey(d.edgeA);
    const vkB = edgeVKey(d.edgeB);
    if (!map.has(vkA)) map.set(vkA, []);
    if (!map.has(vkB)) map.set(vkB, []);
    map.get(vkA).push(i);
    map.get(vkB).push(i);
  }
  return map;
}

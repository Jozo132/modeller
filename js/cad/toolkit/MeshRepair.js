// js/cad/toolkit/MeshRepair.js — Mesh repair and cleanup utilities.
// Extracted from CSG.js: vertex welding, degenerate removal, normal
// recomputation, winding consistency, concave triangulation.

import { edgeVKey } from './Vec3Utils.js';
import { computePolygonNormal } from './GeometryUtils.js';

/**
 * Weld (deduplicate) vertices across faces by snapping to a canonical
 * grid based on edgeVKey precision.  Modifies faces in place.
 * @param {Array<{vertices:Array}>} faces
 */
export function weldVertices(faces) {
  const canon = new Map();
  for (const f of faces) {
    for (let i = 0; i < f.vertices.length; i++) {
      const v = f.vertices[i];
      const key = edgeVKey(v);
      if (canon.has(key)) {
        const c = canon.get(key);
        f.vertices[i] = { x: c.x, y: c.y, z: c.z };
      } else {
        canon.set(key, { x: v.x, y: v.y, z: v.z });
      }
    }
  }
}

/**
 * Remove consecutive duplicate vertices from a polygon loop.
 * Returns a cleaned copy of the vertex array.
 * @param {Array<{x,y,z}>} verts
 * @returns {Array<{x,y,z}>}
 */
export function deduplicatePolygon(verts) {
  if (!verts || verts.length === 0) return [];
  const out = [verts[0]];
  for (let i = 1; i < verts.length; i++) {
    const prev = out[out.length - 1];
    const v = verts[i];
    const dx = v.x - prev.x, dy = v.y - prev.y, dz = v.z - prev.z;
    if (dx * dx + dy * dy + dz * dz > 1e-16) {
      out.push(v);
    }
  }
  // Check last vs first
  if (out.length > 1) {
    const last = out[out.length - 1];
    const first = out[0];
    const dx = last.x - first.x, dy = last.y - first.y, dz = last.z - first.z;
    if (dx * dx + dy * dy + dz * dz <= 1e-16) {
      out.pop();
    }
  }
  return out;
}

/**
 * Remove degenerate faces (< 3 unique vertices or zero area) from the
 * face array.  Operates in-place via splice.
 * @param {Array} faces
 */
export function removeDegenerateFaces(faces) {
  for (let i = faces.length - 1; i >= 0; i--) {
    const face = faces[i];
    const cleaned = deduplicatePolygon(face.vertices || []);
    if (cleaned.length < 3) {
      faces.splice(i, 1);
      continue;
    }
    const normal = computePolygonNormal(cleaned);
    if (!normal) {
      faces.splice(i, 1);
      continue;
    }
    face.vertices = cleaned;
  }
}

/**
 * Recompute face normals using the Newell method for correctness after
 * vertex modifications (trimming, splitting).  Operates in-place.
 * @param {Array} faces
 */
export function recomputeFaceNormals(faces) {
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
 * Fix winding consistency across all faces using BFS propagation from a
 * seed face, then verify outward orientation via signed volume.
 *
 * WARNING: Must NOT be called on non-manifold meshes (e.g. from curved-
 * surface tessellation). Check for boundary/non-manifold edges first.
 *
 * @param {Array} faces
 */
export function fixWindingConsistency(faces) {
  if (faces.length === 0) return;

  // Build edge → face adjacency (directed edge → face index + direction)
  const edgeToFaces = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const ka = edgeVKey(a), kb = edgeVKey(b);
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
  const flipped = new Uint8Array(faces.length);
  const visited = new Uint8Array(faces.length);
  const queue = [0];
  visited[0] = 1;

  while (queue.length > 0) {
    const fi = queue.shift();
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const ka = edgeVKey(a), kb = edgeVKey(b);
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const myOrigFwd = ka < kb;
      const neighbors = edgeToFaces.get(ek);
      if (!neighbors) continue;
      const myEffectiveFwd = flipped[fi] ? !myOrigFwd : myOrigFwd;
      for (const nb of neighbors) {
        if (nb.fi === fi || visited[nb.fi]) continue;
        visited[nb.fi] = 1;
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
    for (const face of faces) {
      face.vertices.reverse();
      const n = face.normal;
      face.normal = { x: -n.x, y: -n.y, z: -n.z };
    }
  }
}

/**
 * Count mesh edge usage to find boundary/non-manifold edges.
 * @param {Array} faces
 * @returns {{boundaryCount: number, nonManifoldCount: number, edgeCounts: Map<string, number>}}
 */
export function countMeshEdgeUsage(faces) {
  const edgeCounts = new Map();
  for (const face of faces) {
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const ka = edgeVKey(a), kb = edgeVKey(b);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
    }
  }
  let boundaryCount = 0, nonManifoldCount = 0;
  for (const count of edgeCounts.values()) {
    if (count === 1) boundaryCount++;
    else if (count > 2) nonManifoldCount++;
  }
  return { boundaryCount, nonManifoldCount, edgeCounts };
}

// js/cad/toolkit/GeometryUtils.js — Common geometry utility functions.
// Extracted from CSG.js for reuse across CAD modules.

import { edgeVKey, edgeKeyFromVerts } from './Vec3Utils.js';

// -----------------------------------------------------------------------
// Polygon / face helpers
// -----------------------------------------------------------------------

/**
 * Compute the geometric normal of a polygon from its vertex loop using the
 * Newell method.  Returns null for degenerate (zero-area) polygons.
 * @param {{x:number,y:number,z:number}[]} vertices
 * @returns {{x:number,y:number,z:number}|null}
 */
export function computePolygonNormal(vertices) {
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
 * Compute the centroid of a mesh face (vertex list or TopoFace with outerLoop).
 * @param {Object} face
 * @returns {{x:number,y:number,z:number}}
 */
export function faceCentroid(face) {
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

/**
 * Create a unique edge key from two vertex positions (order-independent).
 * Uses integer rounding at 1e-6 precision for deduplication.
 * @param {{x:number,y:number,z:number}} a
 * @param {{x:number,y:number,z:number}} b
 * @returns {string}
 */
export function edgeKey(a, b) {
  const ax = Math.round(a.x * 1e6), ay = Math.round(a.y * 1e6), az = Math.round(a.z * 1e6);
  const bx = Math.round(b.x * 1e6), by = Math.round(b.y * 1e6), bz = Math.round(b.z * 1e6);
  if (ax < bx || (ax === bx && (ay < by || (ay === by && az < bz)))) {
    return `${ax},${ay},${az}|${bx},${by},${bz}`;
  }
  return `${bx},${by},${bz}|${ax},${ay},${az}`;
}

/**
 * Collect all edge keys from a face's vertex loop.
 * @param {Object} face - Must have .vertices array
 * @returns {Set<string>}
 */
export function collectFaceEdgeKeys(face) {
  const keys = new Set();
  const verts = face.vertices;
  for (let i = 0; i < verts.length; i++) {
    keys.add(edgeKeyFromVerts(verts[i], verts[(i + 1) % verts.length]));
  }
  return keys;
}

/**
 * Find the two face normals adjacent to an edge in a face list.
 * @param {Array} faces
 * @param {string} edgeKey
 * @returns {{n0: Object, n1: Object}|null}
 */
export function findEdgeNormals(faces, targetEdgeKey) {
  const normals = [];
  for (const face of faces) {
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      if (edgeKeyFromVerts(a, b) === targetEdgeKey) {
        normals.push(face.normal);
        break;
      }
    }
    if (normals.length >= 2) break;
  }
  return normals.length >= 2 ? { n0: normals[0], n1: normals[1] } : null;
}

/**
 * Trim (replace) two vertices in a face by edge key match.
 * @param {Object} face
 * @param {{x,y,z}} edgeA - old vertex A
 * @param {{x,y,z}} edgeB - old vertex B
 * @param {{x,y,z}} newA - replacement for A
 * @param {{x,y,z}} newB - replacement for B
 */
export function trimFaceEdge(face, edgeA, edgeB, newA, newB) {
  const verts = face.vertices;
  const keyA = edgeVKey(edgeA);
  const keyB = edgeVKey(edgeB);
  const newVerts = [];
  for (let i = 0; i < verts.length; i++) {
    const vk = edgeVKey(verts[i]);
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

/**
 * Check if a point lies strictly on a line segment (excluding endpoints).
 * @param {{x,y,z}} p
 * @param {{x,y,z}} a - segment start
 * @param {{x,y,z}} b - segment end
 * @returns {boolean}
 */
export function pointOnSegmentStrict(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;

  const abLen2 = abx * abx + aby * aby + abz * abz;
  if (abLen2 < 1e-14) return false;

  const t = (apx * abx + apy * aby + apz * abz) / abLen2;
  if (t < 1e-4 || t > 1 - 1e-4) return false;

  const projX = a.x + t * abx - p.x;
  const projY = a.y + t * aby - p.y;
  const projZ = a.z + t * abz - p.z;
  return (projX * projX + projY * projY + projZ * projZ) < 1e-8;
}

// js/cad/toolkit/CoplanarUtils.js — Coplanar face analysis and clustering.
// Extracted from CSG.js for reuse across CAD modules.

import {
  vec3Sub, vec3Dot, vec3Cross, vec3Len, vec3Normalize,
} from './Vec3Utils.js';
import { pointOnSegmentStrict } from './GeometryUtils.js';

// -----------------------------------------------------------------------
// Coplanar face detection / clustering
// -----------------------------------------------------------------------

/**
 * Compute the 3-D area of a mesh face polygon via triangle fan.
 *
 * @param {{vertices:Array<{x:number,y:number,z:number}>}} face
 * @returns {number}
 */
export function polygonArea(face) {
  const verts = face.vertices || [];
  let area = 0;
  for (let i = 1; i < verts.length - 1; i++) {
    const ab = vec3Sub(verts[i], verts[0]);
    const ac = vec3Sub(verts[i + 1], verts[0]);
    area += 0.5 * vec3Len(vec3Cross(ab, ac));
  }
  return area;
}

/**
 * Test whether two collinear segments [a0,a1] and [b0,b1] overlap
 * (share an interior portion, not just an endpoint).
 *
 * @param {{x:number,y:number,z:number}} a0
 * @param {{x:number,y:number,z:number}} a1
 * @param {{x:number,y:number,z:number}} b0
 * @param {{x:number,y:number,z:number}} b1
 * @returns {boolean}
 */
export function collinearSegmentsOverlap(a0, a1, b0, b1) {
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

/**
 * Test whether two coplanar face polygons share a vertex or have
 * overlapping edges.
 *
 * @param {{vertices:Array<{x:number,y:number,z:number}>}} faceA
 * @param {{vertices:Array<{x:number,y:number,z:number}>}} faceB
 * @returns {boolean}
 */
export function coplanarFacesTouch(faceA, faceB) {
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
      if (collinearSegmentsOverlap(a0, a1, b0, b1)) return true;
    }
  }
  return false;
}

/**
 * Test whether two mesh faces lie on the same geometric plane
 * (same normal direction, all vertices satisfy the plane equation).
 *
 * @param {{normal:{x:number,y:number,z:number}, vertices:Array<{x:number,y:number,z:number}>}} faceA
 * @param {{normal:{x:number,y:number,z:number}, vertices:Array<{x:number,y:number,z:number}>}} faceB
 * @returns {boolean}
 */
export function facesSharePlane(faceA, faceB) {
  const na = vec3Normalize(faceA?.normal || { x: 0, y: 0, z: 0 });
  const nb = vec3Normalize(faceB?.normal || { x: 0, y: 0, z: 0 });
  if (vec3Len(na) < 1e-10 || vec3Len(nb) < 1e-10) return false;
  if (Math.abs(vec3Dot(na, nb)) < 0.999) return false;
  const planeD = vec3Dot(faceA.vertices[0], na);
  for (const v of faceB.vertices || []) {
    if (Math.abs(vec3Dot(v, na) - planeD) > 1e-5) return false;
  }
  return true;
}

/**
 * Test whether two pairs of normals represent the same unordered pair
 * (both pointing in the same direction, possibly swapped).
 *
 * @param {{x:number,y:number,z:number}} a0
 * @param {{x:number,y:number,z:number}} a1
 * @param {{x:number,y:number,z:number}} b0
 * @param {{x:number,y:number,z:number}} b1
 * @returns {boolean}
 */
export function sameNormalPair(a0, a1, b0, b1) {
  const same = (u, v) => Math.abs(vec3Dot(vec3Normalize(u), vec3Normalize(v)) - 1) < 1e-5;
  return (same(a0, b0) && same(a1, b1)) || (same(a0, b1) && same(a1, b0));
}

/**
 * Compute a stable cluster key for a coplanar face.
 *
 * The key encodes faceGroup + canonical normal + quantised plane distance
 * so that faces on the same infinite plane produce the same key.
 *
 * @param {{normal:{x:number,y:number,z:number}, vertices:Array<{x:number,y:number,z:number}>, faceGroup?:number}} face
 * @param {number} [fallbackIndex=0]
 * @returns {string|null}
 */
export function coplanarFaceClusterKey(face, fallbackIndex = 0) {
  if (!face || !face.normal || !Array.isArray(face.vertices) || face.vertices.length < 3) return null;
  const point = face.vertices[0];
  if (!point) return null;
  const normal = vec3Normalize(face.normal);
  if (vec3Len(normal) < 1e-10) return null;

  let sign = 1;
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  if (az >= ax && az >= ay) sign = normal.z < 0 ? -1 : 1;
  else if (ay >= ax) sign = normal.y < 0 ? -1 : 1;
  else sign = normal.x < 0 ? -1 : 1;

  const canonicalNormal = {
    x: normal.x * sign,
    y: normal.y * sign,
    z: normal.z * sign,
  };
  const planeDistance = vec3Dot(canonicalNormal, point);
  const clusterOwner = face.faceGroup ?? fallbackIndex;
  return [
    clusterOwner,
    Math.round(canonicalNormal.x * 1e6),
    Math.round(canonicalNormal.y * 1e6),
    Math.round(canonicalNormal.z * 1e6),
    Math.round(planeDistance * 1e6),
  ].join('|');
}

/**
 * Produce a deterministic JSON signature for a face's shared metadata.
 *
 * @param {Object|null} shared
 * @returns {string}
 */
export function sharedMetadataSignature(shared) {
  if (!shared) return '__null__';
  const keys = Object.keys(shared).sort();
  return JSON.stringify(shared, keys);
}

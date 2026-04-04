// @ts-check
/**
 * @module toolkit/PlanarMath
 *
 * Planar polygon utilities: convexity testing, 2D projection, and
 * ear-clipping triangulation. Extracted from CSG.js for reuse.
 */

import { vec3Sub, vec3Cross, vec3Dot } from './Vec3Utils.js';

/**
 * Test whether a polygon is convex and planar.
 *
 * Walks every consecutive triple of vertices and checks that every
 * cross-product turn has the same sign relative to the face normal.
 *
 * @param {Array<{x:number,y:number,z:number}>} verts
 * @param {{x:number,y:number,z:number}} normal
 * @returns {boolean}
 */
export function isConvexPlanarPolygon(verts, normal) {
  if (!verts || verts.length < 3 || !normal) return false;
  let sign = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const c = verts[(i + 2) % verts.length];
    const cross = vec3Cross(vec3Sub(b, a), vec3Sub(c, b));
    const turn = vec3Dot(cross, normal);
    if (Math.abs(turn) < 1e-8) continue;
    const nextSign = turn > 0 ? 1 : -1;
    if (sign === 0) sign = nextSign;
    else if (sign !== nextSign) return false;
  }
  return true;
}

/**
 * Project a 3D polygon onto its dominant 2D plane.
 *
 * Chooses the projection axis based on the largest absolute component
 * of the normal vector to minimise distortion.
 *
 * @param {Array<{x:number,y:number,z:number}>} verts
 * @param {{x:number,y:number,z:number}} normal
 * @returns {Array<{x:number,y:number}>}
 */
export function projectPolygon2D(verts, normal) {
  const an = {
    x: Math.abs(normal.x),
    y: Math.abs(normal.y),
    z: Math.abs(normal.z),
  };
  if (an.z >= an.x && an.z >= an.y) {
    return verts.map((v) => ({ x: v.x, y: v.y }));
  }
  if (an.y >= an.x) {
    return verts.map((v) => ({ x: v.x, y: v.z }));
  }
  return verts.map((v) => ({ x: v.y, y: v.z }));
}

/**
 * Ear-clip a planar polygon into triangles.
 *
 * @param {Array<{x:number,y:number,z:number}>} verts — 3D vertices (must be coplanar)
 * @param {{x:number,y:number,z:number}} normal
 * @returns {Array<Array<{x:number,y:number,z:number}>>|null} Array of triangle vertex triples, or null on failure.
 */
export function triangulatePlanarPolygon(verts, normal) {
  if (!verts || verts.length < 3) return [];
  if (verts.length === 3) return [verts.map((v) => ({ ...v }))];

  const pts2d = projectPolygon2D(verts, normal);
  const signedArea = (() => {
    let area = 0;
    for (let i = 0; i < pts2d.length; i++) {
      const a = pts2d[i];
      const b = pts2d[(i + 1) % pts2d.length];
      area += a.x * b.y - b.x * a.y;
    }
    return area * 0.5;
  })();
  const winding = signedArea >= 0 ? 1 : -1;

  function cross2(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function pointInTri(p, a, b, c) {
    const c1 = cross2(a, b, p) * winding;
    const c2 = cross2(b, c, p) * winding;
    const c3 = cross2(c, a, p) * winding;
    return c1 >= -1e-8 && c2 >= -1e-8 && c3 >= -1e-8;
  }

  const remaining = verts.map((_, i) => i);
  const triangles = [];
  let guard = 0;

  while (remaining.length > 3 && guard < verts.length * verts.length) {
    let earFound = false;
    for (let ri = 0; ri < remaining.length; ri++) {
      const prev = remaining[(ri - 1 + remaining.length) % remaining.length];
      const curr = remaining[ri];
      const next = remaining[(ri + 1) % remaining.length];
      const a = pts2d[prev];
      const b = pts2d[curr];
      const c = pts2d[next];
      if (cross2(a, b, c) * winding <= 1e-8) continue;

      let containsPoint = false;
      for (const other of remaining) {
        if (other === prev || other === curr || other === next) continue;
        if (pointInTri(pts2d[other], a, b, c)) {
          containsPoint = true;
          break;
        }
      }
      if (containsPoint) continue;

      triangles.push([
        { ...verts[prev] },
        { ...verts[curr] },
        { ...verts[next] },
      ]);
      remaining.splice(ri, 1);
      earFound = true;
      break;
    }

    if (!earFound) return null;
    guard++;
  }

  if (remaining.length === 3) {
    triangles.push(remaining.map((idx) => ({ ...verts[idx] })));
  }
  return triangles;
}

/**
 * Classify a mesh face by its geometry.
 *
 * @param {{x:number,y:number,z:number}} normal
 * @param {Array<{x:number,y:number,z:number}>} vertices
 * @returns {'planar'|'planar-horizontal'|'planar-vertical'|'cylindrical'|'freeform'}
 */
export function classifyFaceType(normal, vertices) {
  if (vertices.length < 3) return 'planar';

  const EPSILON = 1e-5;
  const nx = normal.x, ny = normal.y, nz = normal.z;
  const d = nx * vertices[0].x + ny * vertices[0].y + nz * vertices[0].z;

  let allCoplanar = true;
  for (const v of vertices) {
    if (Math.abs(nx * v.x + ny * v.y + nz * v.z - d) > EPSILON * 10) {
      allCoplanar = false;
      break;
    }
  }

  if (allCoplanar) {
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    if (az > 0.99) return 'planar-horizontal';
    if (ax > 0.99 || ay > 0.99) return 'planar-vertical';
    return 'planar';
  }

  if (vertices.length === 4) return 'cylindrical';

  return 'freeform';
}

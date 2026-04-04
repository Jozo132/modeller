// js/cad/toolkit/Vec3Utils.js — Low-level 3D vector math for plain {x,y,z} objects.
// Extracted from CSG.js to enable reuse across CAD modules.

export function vec3Sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
export function vec3Add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
export function vec3Scale(v, s) { return { x: v.x * s, y: v.y * s, z: v.z * s }; }
export function vec3Dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function vec3Cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
export function vec3Len(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
export function vec3Normalize(v) {
  const len = vec3Len(v);
  if (len < 1e-10) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
export function vec3Lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * Compute the circumsphere center of 4 non-coplanar points.
 * Returns {x,y,z} or null if the points are (near-)coplanar.
 */
export function circumsphereCenter(p0, p1, p2, p3) {
  const d1 = vec3Sub(p1, p0);
  const d2 = vec3Sub(p2, p0);
  const d3 = vec3Sub(p3, p0);
  const b1 = vec3Dot(d1, d1) / 2;
  const b2 = vec3Dot(d2, d2) / 2;
  const b3 = vec3Dot(d3, d3) / 2;
  const det = d1.x * (d2.y * d3.z - d2.z * d3.y)
            - d1.y * (d2.x * d3.z - d2.z * d3.x)
            + d1.z * (d2.x * d3.y - d2.y * d3.x);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const cx = (b1 * (d2.y * d3.z - d2.z * d3.y)
            - d1.y * (b2 * d3.z - d2.z * b3)
            + d1.z * (b2 * d3.y - d2.y * b3)) * inv;
  const cy = (d1.x * (b2 * d3.z - d2.z * b3)
            - b1 * (d2.x * d3.z - d2.z * d3.x)
            + d1.z * (d2.x * b3 - b2 * d3.x)) * inv;
  const cz = (d1.x * (d2.y * b3 - b2 * d3.y)
            - d1.y * (d2.x * b3 - b2 * d3.x)
            + b1 * (d2.x * d3.y - d2.y * d3.x)) * inv;
  return { x: p0.x + cx, y: p0.y + cy, z: p0.z + cz };
}

/**
 * Compute circumcenter of three 3D points (center of circle through them).
 * Returns {x,y,z} or null if collinear.
 */
export function circumCenter3D(a, b, c) {
  const ab = vec3Sub(b, a);
  const ac = vec3Sub(c, a);
  const n = vec3Cross(ab, ac);
  const n2 = vec3Dot(n, n);
  if (n2 < 1e-20) return null; // collinear
  const abDot = vec3Dot(ab, ab);
  const acDot = vec3Dot(ac, ac);
  // center = a + (|ac|² (n × ab) − |ab|² (n × ac)) / (2|n|²)
  const nxab = vec3Cross(n, ab);
  const nxac = vec3Cross(n, ac);
  const num = vec3Sub(vec3Scale(nxab, acDot), vec3Scale(nxac, abDot));
  return vec3Add(a, vec3Scale(num, 0.5 / n2));
}

/** Project a point onto an axis line */
export function projectOntoAxis(point, axisOrigin, axisDir) {
  const v = vec3Sub(point, axisOrigin);
  const t = vec3Dot(v, axisDir);
  return vec3Add(axisOrigin, vec3Scale(axisDir, t));
}

/** Check if two points are coincident within tolerance */
export function pointsCoincident3D(a, b, tol = 1e-8) {
  return vec3Len(vec3Sub(a, b)) < tol;
}

/** Check whether a point lies on the plane defined by face vertices. */
export function pointOnFacePlane(point, faceVerts, tolerance) {
  if (tolerance === undefined) tolerance = 0.01;
  if (faceVerts.length < 3) return true;
  const n = vec3Cross(vec3Sub(faceVerts[1], faceVerts[0]), vec3Sub(faceVerts[2], faceVerts[0]));
  const len = vec3Len(n);
  if (len < 1e-10) return true;
  return Math.abs(vec3Dot(n, vec3Sub(point, faceVerts[0]))) / len < tolerance;
}

/**
 * Möller–Trumbore ray-triangle intersection.
 * @returns {number} Distance t along ray, or Infinity if no hit.
 */
export function rayTriangleIntersect(origin, dir, v0, v1, v2) {
  const e1x = v1.x - v0.x, e1y = v1.y - v0.y, e1z = v1.z - v0.z;
  const e2x = v2.x - v0.x, e2y = v2.y - v0.y, e2z = v2.z - v0.z;
  const px = dir.y * e2z - dir.z * e2y;
  const py = dir.z * e2x - dir.x * e2z;
  const pz = dir.x * e2y - dir.y * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-10) return Infinity;
  const invDet = 1.0 / det;
  const tx = origin.x - v0.x, ty = origin.y - v0.y, tz = origin.z - v0.z;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return Infinity;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dir.x * qx + dir.y * qy + dir.z * qz) * invDet;
  if (v < 0 || u + v > 1) return Infinity;
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return t;
}

/**
 * Compute the canonical coordinate (snap near-zero to 0).
 */
export function canonicalCoord(n, eps = 1e-12) {
  return Math.abs(n) < eps ? 0 : n;
}

export function canonicalPoint(point, eps = 1e-12) {
  if (!point) return point;
  return {
    x: canonicalCoord(point.x, eps),
    y: canonicalCoord(point.y, eps),
    z: canonicalCoord(point.z, eps),
  };
}

// Edge key helpers
const EDGE_PREC = 5;
export function fmtCoord(n) {
  return (Math.abs(n) < 5e-6 ? 0 : n).toFixed(EDGE_PREC);
}
export function edgeVKey(v) {
  return `${fmtCoord(v.x)},${fmtCoord(v.y)},${fmtCoord(v.z)}`;
}
export function edgeKeyFromVerts(a, b) {
  const ka = edgeVKey(a), kb = edgeVKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

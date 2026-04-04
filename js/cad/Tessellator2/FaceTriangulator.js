// js/cad/Tessellator2/FaceTriangulator.js — Parameter-space face triangulation
//
// Triangulates a face in parameter space using boundary points from coedge loops.
// Supports outer loops and holes. Uses Constrained Delaunay Triangulation (CDT)
// for robust handling of complex polygon shapes.
// For NURBS surface faces, maps UV domain triangulation to 3D via GeometryEvaluator.

import { GeometryEvaluator } from '../GeometryEvaluator.js';
import { constrainedTriangulate } from './CDT.js';

/**
 * Compute 2D signed area of a polygon.
 * @param {Array<{x:number,y:number}>} pts
 * @returns {number}
 */
function signedArea2D(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area * 0.5;
}

/**
 * Project 3D polygon to 2D by dropping the coordinate with the largest normal component.
 * @param {Array<{x:number,y:number,z:number}>} verts
 * @param {{x:number,y:number,z:number}} normal
 * @returns {Array<{x:number,y:number}>}
 */
function projectTo2D(verts, normal) {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  if (az >= ax && az >= ay) {
    return verts.map(v => ({ x: v.x, y: v.y }));
  }
  if (ay >= ax) {
    return verts.map(v => ({ x: v.x, y: v.z }));
  }
  return verts.map(v => ({ x: v.y, y: v.z }));
}

/**
 * Ear-clipping triangulation of a 2D polygon (indices into original array).
 * Returns array of [a, b, c] index triples.
 *
 * @param {Array<{x:number,y:number}>} pts2d
 * @returns {Array<[number,number,number]>}
 */
function earClipIndices(pts2d) {
  const n = pts2d.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  const area = signedArea2D(pts2d);
  const winding = area >= 0 ? 1 : -1;

  function cross2(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function pointInTri(p, a, b, c) {
    const c1 = cross2(a, b, p) * winding;
    const c2 = cross2(b, c, p) * winding;
    const c3 = cross2(c, a, p) * winding;
    return c1 >= -1e-8 && c2 >= -1e-8 && c3 >= -1e-8;
  }

  const remaining = [];
  for (let i = 0; i < n; i++) remaining.push(i);
  const triangles = [];
  let guard = 0;
  const maxGuard = n * n;

  while (remaining.length > 3 && guard < maxGuard) {
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

      triangles.push([prev, curr, next]);
      remaining.splice(ri, 1);
      earFound = true;
      break;
    }
    if (!earFound) break;
    guard++;
  }

  if (remaining.length === 3) {
    triangles.push([remaining[0], remaining[1], remaining[2]]);
  }

  // Fall back to fan if ear-clipping produced wrong count
  if (triangles.length !== Math.max(0, n - 2)) {
    const fan = [];
    for (let i = 1; i < n - 1; i++) fan.push([0, i, i + 1]);
    return fan;
  }
  return triangles;
}

/**
 * Calculate normal from three 3D points.
 * @param {{x:number,y:number,z:number}} p0
 * @param {{x:number,y:number,z:number}} p1
 * @param {{x:number,y:number,z:number}} p2
 * @returns {{x:number,y:number,z:number}}
 */
function calculateNormal(p0, p1, p2) {
  const v1x = p1.x - p0.x, v1y = p1.y - p0.y, v1z = p1.z - p0.z;
  const v2x = p2.x - p0.x, v2y = p2.y - p0.y, v2z = p2.z - p0.z;
  const nx = v1y * v2z - v1z * v2y;
  const ny = v1z * v2x - v1x * v2z;
  const nz = v1x * v2y - v1y * v2x;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-14) return { x: 0, y: 0, z: 1 };
  return { x: nx / len, y: ny / len, z: nz / len };
}

/**
 * Compute the area of a triangle from three 3D points.
 * @param {{x:number,y:number,z:number}} a
 * @param {{x:number,y:number,z:number}} b
 * @param {{x:number,y:number,z:number}} c
 * @returns {number}
 */
function _triangleArea3D(a, b, c) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

/**
 * Check if segment [p0,p1] intersects the interior of triangle [v0,v1,v2].
 * Uses Moller–Trumbore algorithm. Returns true for proper interior crossings.
 */
function _segTriIntersect(p0, p1, v0, v1, v2) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const e1x = v1.x - v0.x, e1y = v1.y - v0.y, e1z = v1.z - v0.z;
  const e2x = v2.x - v0.x, e2y = v2.y - v0.y, e2z = v2.z - v0.z;
  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const a = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(a) < 1e-10) return false;
  const f = 1 / a;
  const sx = p0.x - v0.x, sy = p0.y - v0.y, sz = p0.z - v0.z;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < 1e-8 || u > 1 - 1e-8) return false;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v < 1e-8 || u + v > 1 - 1e-8) return false;
  const t = f * (e2x * qx + e2y * qy + e2z * qz);
  return t > 1e-8 && t < 1 - 1e-8;
}

/**
 * Check if two 3D triangles properly intersect (edge of one passes through interior of other).
 * Triangles sharing a vertex (within eps) are skipped.
 */
function _trisOverlap(t1, t2) {
  // Skip adjacent triangles (shared vertex)
  const EPS = 1e-10;
  for (const a of t1) {
    for (const b of t2) {
      if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.z - b.z) < EPS) {
        return false;
      }
    }
  }
  for (const [ta, tb] of [[t1, t2], [t2, t1]]) {
    for (let i = 0; i < 3; i++) {
      if (_segTriIntersect(ta[i], ta[(i + 1) % 3], tb[0], tb[1], tb[2])) return true;
    }
  }
  return false;
}

/**
 * Post-CDT cleanup: detect and remove overlapping triangles.
 *
 * On complex curved surfaces, the CDT (valid in 2D projected space) can
 * produce triangles that overlap when back-projected to 3D.  This function
 * detects such pairs and removes the smaller triangle from each pair.
 *
 * @param {Array<[{x,y,z},{x,y,z},{x,y,z}]>} triangles
 * @returns {Array<[{x,y,z},{x,y,z},{x,y,z}]>}
 */
function _removeOverlappingTriangles(triangles) {
  const n = triangles.length;
  if (n < 2) return triangles;

  // Precompute areas to avoid redundant calculations in the nested loop
  const areas = new Array(n);
  for (let i = 0; i < n; i++) {
    areas[i] = _triangleArea3D(triangles[i][0], triangles[i][1], triangles[i][2]);
  }

  const removed = new Set();
  for (let i = 0; i < n; i++) {
    if (removed.has(i)) continue;
    for (let j = i + 1; j < n; j++) {
      if (removed.has(j)) continue;
      if (_trisOverlap(triangles[i], triangles[j])) {
        // Remove the smaller triangle
        removed.add(areas[i] <= areas[j] ? i : j);
      }
    }
  }

  if (removed.size === 0) return triangles;
  return triangles.filter((_, i) => !removed.has(i));
}

/**
 * Remove consecutive collinear points from a closed polygon.
 * This prevents degenerate triangles from ear-clipping when
 * intermediate edge samples lie on straight segments.
 *
 * @param {Array<{x:number,y:number,z:number}>} pts
 * @returns {Array<{x:number,y:number,z:number}>}
 */
function removeCollinearPoints(pts) {
  if (pts.length <= 3) return pts;
  const result = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const curr = pts[i];
    // Always preserve B-Rep topology vertices.  A vertex shared by two
    // topological edges may be collinear with its loop neighbours on one
    // face but not on the adjacent face (which has different surrounding
    // edges).  Removing it from only one side creates unmatched boundary
    // edges and leaves holes in the stitched mesh.
    if (curr._isVertex || curr._preserveBoundarySample) { result.push(curr); continue; }
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    // Check if curr is collinear with prev and next
    const area = _triangleArea3D(prev, curr, next);
    if (area > 1e-12) {
      result.push(curr);
    }
  }
  return result.length >= 3 ? result : pts;
}

function removeCollinearPoints2D(pts) {
  if (pts.length <= 3) return pts;
  const result = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const cross = (curr.x - prev.x) * (next.y - curr.y) - (curr.y - prev.y) * (next.x - curr.x);
    if (Math.abs(cross) > 1e-12) result.push(curr);
  }
  return result.length >= 3 ? result : pts;
}

function _normalize(v) {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  return len > 1e-14 ? { x: v.x / len, y: v.y / len, z: v.z / len } : { x: 0, y: 0, z: 1 };
}

function _orientNormal(normal, reference) {
  if (!normal) return { x: 0, y: 0, z: 1 };
  const out = _normalize(normal);
  if (!reference) return out;
  return _dot(out, reference) >= 0
    ? out
    : { x: -out.x, y: -out.y, z: -out.z };
}

function _dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function _add3(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function _scale3(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function _wrapNear(value, reference, period) {
  if (!Number.isFinite(value) || !Number.isFinite(reference) || !Number.isFinite(period) || period <= 0) {
    return value;
  }
  return value + Math.round((reference - value) / period) * period;
}

function _rotateLoop(loop, startIndex) {
  if (!Array.isArray(loop) || loop.length === 0) return loop;
  const idx = ((startIndex % loop.length) + loop.length) % loop.length;
  if (idx === 0) return loop.map(p => ({ ...p }));
  return [...loop.slice(idx), ...loop.slice(0, idx)].map(p => ({ ...p }));
}

function _normalizePeriodicLoop(loop, surface) {
  if (!Array.isArray(loop) || loop.length < 2 || !surface) return loop;

  const periodicDims = [];
  if (surface.periodicU && Number.isFinite(surface.periodU) && surface.periodU > 0) {
    periodicDims.push({ key: 'u', period: surface.periodU });
  }
  if (surface.periodicV && Number.isFinite(surface.periodV) && surface.periodV > 0) {
    periodicDims.push({ key: 'v', period: surface.periodV });
  }
  if (periodicDims.length === 0) return loop;

  let cutAfter = -1;
  let maxJumpScore = 0;
  for (let i = 0; i < loop.length; i++) {
    const curr = loop[i];
    const next = loop[(i + 1) % loop.length];
    let score = 0;
    for (const dim of periodicDims) {
      score += Math.abs(next[dim.key] - curr[dim.key]) / dim.period;
    }
    if (score > maxJumpScore) {
      maxJumpScore = score;
      cutAfter = i;
    }
  }

  const reordered = (cutAfter >= 0 && maxJumpScore > 0.3)
    ? _rotateLoop(loop, cutAfter + 1)
    : loop.map(p => ({ ...p }));

  for (const dim of periodicDims) {
    for (let i = 1; i < reordered.length; i++) {
      reordered[i][dim.key] = _wrapNear(reordered[i][dim.key], reordered[i - 1][dim.key], dim.period);
    }

    let avg = 0;
    for (const p of reordered) avg += p[dim.key];
    avg /= reordered.length;
    const shift = Math.round(avg / dim.period) * dim.period;
    if (shift !== 0) {
      for (const p of reordered) p[dim.key] -= shift;
    }
  }

  for (const p of reordered) {
    p.x = p.u;
    p.y = p.v;
  }
  return reordered;
}

function _makeAnalyticSurface(surfaceInfo) {
  if (!surfaceInfo) return null;

  const origin = surfaceInfo.origin;
  const axis = surfaceInfo.axis ? _normalize(surfaceInfo.axis) : { x: 0, y: 0, z: 1 };
  const xDir = surfaceInfo.xDir ? _normalize(surfaceInfo.xDir) : { x: 1, y: 0, z: 0 };
  const yDir = surfaceInfo.yDir ? _normalize(surfaceInfo.yDir) : { x: 0, y: 1, z: 0 };

  function unwrapAngle(value, hint, period = 2 * Math.PI) {
    if (!Number.isFinite(hint)) return value;
    return value + Math.round((hint - value) / period) * period;
  }

  switch (surfaceInfo.type) {
    case 'sphere': {
      const radius = surfaceInfo.radius;
      return {
        type: 'sphere',
        periodicU: true,
        periodU: 2 * Math.PI,
        evaluate(u, v) {
          const cu = Math.cos(u), su = Math.sin(u);
          const cv = Math.cos(v), sv = Math.sin(v);
          const radial = _add3(_scale3(xDir, cv * cu), _scale3(yDir, cv * su));
          const dir = _add3(radial, _scale3(axis, sv));
          return _add3(origin, _scale3(dir, radius));
        },
        normal(u, v) {
          const p = this.evaluate(u, v);
          return _normalize({ x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z });
        },
        closestPointUV(point, _gridRes = 16, uvHint = null) {
          const dx = point.x - origin.x;
          const dy = point.y - origin.y;
          const dz = point.z - origin.z;
          const dir = _normalize({ x: dx, y: dy, z: dz });
          const px = _dot(dir, xDir);
          const py = _dot(dir, yDir);
          const pz = _dot(dir, axis);
          let u = Math.atan2(py, px);
          let v = Math.atan2(pz, Math.sqrt(px * px + py * py));
          if (uvHint) {
            u = unwrapAngle(u, uvHint.u);
          }
          return { u, v };
        },
      };
    }
    case 'cylinder': {
      const radius = surfaceInfo.radius;
      return {
        type: 'cylinder',
        periodicU: true,
        periodU: 2 * Math.PI,
        evaluate(u, v) {
          const radial = _add3(_scale3(xDir, Math.cos(u)), _scale3(yDir, Math.sin(u)));
          return _add3(origin, _add3(_scale3(radial, radius), _scale3(axis, v)));
        },
        normal(u, _v) {
          return _normalize(_add3(_scale3(xDir, Math.cos(u)), _scale3(yDir, Math.sin(u))));
        },
        closestPointUV(point, _gridRes = 16, uvHint = null) {
          const dx = point.x - origin.x;
          const dy = point.y - origin.y;
          const dz = point.z - origin.z;
          const v = dx * axis.x + dy * axis.y + dz * axis.z;
          const radial = { x: dx - v * axis.x, y: dy - v * axis.y, z: dz - v * axis.z };
          const px = _dot(radial, xDir);
          const py = _dot(radial, yDir);
          let u = Math.atan2(py, px);
          if (uvHint) u = unwrapAngle(u, uvHint.u);
          return { u, v };
        },
      };
    }
    case 'cone': {
      const radius = surfaceInfo.radius;
      const tanA = Math.tan(surfaceInfo.semiAngle || 0);
      const cosA = Math.cos(surfaceInfo.semiAngle || 0);
      const sinA = Math.sin(surfaceInfo.semiAngle || 0);
      return {
        type: 'cone',
        periodicU: true,
        periodU: 2 * Math.PI,
        evaluate(u, v) {
          const radialDir = _add3(_scale3(xDir, Math.cos(u)), _scale3(yDir, Math.sin(u)));
          const currentR = radius + v * tanA;
          return _add3(origin, _add3(_scale3(radialDir, currentR), _scale3(axis, v)));
        },
        normal(u, _v) {
          const radialDir = _add3(_scale3(xDir, Math.cos(u)), _scale3(yDir, Math.sin(u)));
          return _normalize({
            x: radialDir.x * cosA - axis.x * sinA,
            y: radialDir.y * cosA - axis.y * sinA,
            z: radialDir.z * cosA - axis.z * sinA,
          });
        },
        closestPointUV(point, _gridRes = 16, uvHint = null) {
          const dx = point.x - origin.x;
          const dy = point.y - origin.y;
          const dz = point.z - origin.z;
          const v = dx * axis.x + dy * axis.y + dz * axis.z;
          const radial = { x: dx - v * axis.x, y: dy - v * axis.y, z: dz - v * axis.z };
          const px = _dot(radial, xDir);
          const py = _dot(radial, yDir);
          let u = Math.atan2(py, px);
          if (uvHint) u = unwrapAngle(u, uvHint.u);
          return { u, v };
        },
      };
    }
    case 'torus': {
      const majorR = surfaceInfo.majorR;
      const minorR = surfaceInfo.minorR;
      return {
        type: 'torus',
        periodicU: true,
        periodU: 2 * Math.PI,
        periodicV: true,
        periodV: 2 * Math.PI,
        evaluate(u, v) {
          const ringDir = _add3(_scale3(xDir, Math.cos(u)), _scale3(yDir, Math.sin(u)));
          const minorCenter = _add3(origin, _scale3(ringDir, majorR));
          const normalDir = _add3(_scale3(ringDir, Math.cos(v)), _scale3(axis, Math.sin(v)));
          return _add3(minorCenter, _scale3(normalDir, minorR));
        },
        normal(u, v) {
          const ringDir = _add3(_scale3(xDir, Math.cos(u)), _scale3(yDir, Math.sin(u)));
          return _normalize(_add3(_scale3(ringDir, Math.cos(v)), _scale3(axis, Math.sin(v))));
        },
        closestPointUV(point, _gridRes = 16, uvHint = null) {
          const dx = point.x - origin.x;
          const dy = point.y - origin.y;
          const dz = point.z - origin.z;
          const axial = dx * axis.x + dy * axis.y + dz * axis.z;
          const radial = { x: dx - axial * axis.x, y: dy - axial * axis.y, z: dz - axial * axis.z };
          const px = _dot(radial, xDir);
          const py = _dot(radial, yDir);
          const ringLen = Math.sqrt(px * px + py * py);
          let u = Math.atan2(py, px);
          let v = Math.atan2(axial, ringLen - majorR);
          if (uvHint) {
            u = unwrapAngle(u, uvHint.u);
            v = unwrapAngle(v, uvHint.v);
          }
          return { u, v };
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Point-in-polygon test for 2D (ray-casting).
 */
function _pointInPoly2D(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * FaceTriangulator — triangulates a face from boundary samples.
 *
 * For planar faces: ear-clip triangulates from boundary points.
 * For NURBS surface faces: tessellates the surface UV domain and maps to 3D
 * using boundary constraints from coedge samples.
 */
export class FaceTriangulator {
  /**
   * Triangulate a planar face from boundary points.
   *
   * @param {Array<{x:number,y:number,z:number}>} boundaryPts - Ordered boundary points (outer loop)
   * @param {Array<Array<{x:number,y:number,z:number}>>} [holePts=[]] - Inner loop point arrays
   * @param {{x:number,y:number,z:number}} [faceNormal] - Optional known face normal
   * @param {boolean} [sameSense=true] - Face orientation
   * @returns {{ vertices: Array<{x:number,y:number,z:number}>, faces: Array<{vertices: Array<{x:number,y:number,z:number}>, normal: {x:number,y:number,z:number}}> }}
   */
  triangulatePlanar(boundaryPts, holePts = [], faceNormal, sameSense = true) {
    if (!boundaryPts || boundaryPts.length < 3) return { vertices: [], faces: [] };

    // Remove collinear consecutive points first, then compute normal
    let outerClean = removeCollinearPoints([...boundaryPts]);
    if (outerClean.length < 3) return { vertices: [], faces: [] };

    let normal = faceNormal;
    if (!normal) {
      // Use Newell's method on the cleaned boundary for a robust normal.
      // calculateNormal from the first 3 points fails when they are collinear
      // (common for rectangular faces with many edge samples along straight edges).
      let nnx = 0, nny = 0, nnz = 0;
      for (let i = 0; i < outerClean.length; i++) {
        const curr = outerClean[i];
        const next = outerClean[(i + 1) % outerClean.length];
        nnx += (curr.y - next.y) * (curr.z + next.z);
        nny += (curr.z - next.z) * (curr.x + next.x);
        nnz += (curr.x - next.x) * (curr.y + next.y);
      }
      const nnLen = Math.sqrt(nnx * nnx + nny * nny + nnz * nnz);
      normal = nnLen > 1e-14
        ? { x: nnx / nnLen, y: nny / nnLen, z: nnz / nnLen }
        : calculateNormal(outerClean[0], outerClean[1], outerClean[2]);
    }

    const holesClean = holePts
      .map(h => removeCollinearPoints([...h]))
      .filter(h => h.length >= 3);

    // Build combined point array: outer first, then each hole
    const allPts = [...outerClean];
    for (const h of holesClean) allPts.push(...h);

    // Project to 2D for CDT
    const pts2d = projectTo2D(allPts, normal);

    // Ensure the outer loop is CCW in the projected 2D space
    const outerPts2d = pts2d.slice(0, outerClean.length);
    const outerArea = signedArea2D(outerPts2d);
    if (outerArea < 0) {
      // Reverse outer loop in both 2D and 3D arrays
      outerClean.reverse();
      outerPts2d.reverse();
      for (let i = 0; i < outerClean.length; i++) {
        allPts[i] = outerClean[i];
        pts2d[i] = outerPts2d[i];
      }
    }

    // Build hole 2D arrays and ensure CW orientation
    let offset = outerClean.length;
    const holes2d = [];
    for (let hi = 0; hi < holesClean.length; hi++) {
      const hLen = holesClean[hi].length;
      const holePts2d = pts2d.slice(offset, offset + hLen);
      const hArea = signedArea2D(holePts2d);
      if (hArea > 0) {
        // Reverse to CW
        holesClean[hi].reverse();
        holePts2d.reverse();
        for (let i = 0; i < hLen; i++) {
          allPts[offset + i] = holesClean[hi][i];
          pts2d[offset + i] = holePts2d[i];
        }
      }
      holes2d.push(holePts2d);
      offset += hLen;
    }

    // CDT triangulation
    const triIndices = constrainedTriangulate(outerPts2d, holes2d);

    // Orient normal
    let outNormal = { ...normal };
    if (!sameSense) {
      outNormal = { x: -normal.x, y: -normal.y, z: -normal.z };
    }

    const meshFaces = [];
    for (const [a, b, c] of triIndices) {
      const pa = allPts[a], pb = allPts[b], pc = allPts[c];
      const area = _triangleArea3D(pa, pb, pc);
      if (area < 1e-12) continue;

      meshFaces.push({
        vertices: [pa, pb, pc].map(v => ({ ...v })),
        normal: { ...outNormal },
      });
    }

    // Global winding check: CDT always produces winding aligned with the
    // positive direction of the dropped axis, which may not match outNormal.
    // Check one representative triangle and flip ALL if needed.
    if (meshFaces.length > 0) {
      const [va, vb, vc] = meshFaces[0].vertices;
      const triN = calculateNormal(va, vb, vc);
      const dot = triN.x * outNormal.x + triN.y * outNormal.y + triN.z * outNormal.z;
      if (dot < 0) {
        for (const face of meshFaces) {
          const tmp = face.vertices[1];
          face.vertices[1] = face.vertices[2];
          face.vertices[2] = tmp;
        }
      }
    }

    return {
      vertices: allPts.map(p => ({ ...p })),
      faces: meshFaces,
    };
  }

  /**
   * Triangulate an analytic curved face directly in its exact parameter space.
   * This is used for STEP analytic surfaces that do not carry a NurbsSurface.
   */
  triangulateAnalyticSurface(face, boundaryPts3D, holePts3D = [], surfaceSegments = 8) {
    const surface = _makeAnalyticSurface(face.surfaceInfo);
    if (!surface) {
      return this.triangulatePlanar(boundaryPts3D, holePts3D, null, true);
    }
    const sameSense = face.sameSense !== false;
    const periodicSurface = surface.periodicU || surface.periodicV;

    const outer3D = removeCollinearPoints([...boundaryPts3D]);
    if (outer3D.length < 3) return { vertices: [], faces: [] };

    const holeLoops3D = holePts3D
      .map(loop => removeCollinearPoints([...loop]))
      .filter(loop => loop.length >= 3);

    const mapLoopToUV = (loop3D) => {
      const loop = [];
      let prevUv = null;
      for (const p of loop3D) {
        const uv = periodicSurface
          ? surface.closestPointUV(p, 16)
          : surface.closestPointUV(p, 16, prevUv);
        // Attach original 3D position so evalPoint can preserve the exact
        // EdgeSampler coordinates.  Re-evaluating from UV introduces tiny
        // floating-point drift that prevents MeshStitcher from deduplicating
        // shared boundary vertices, creating holes in the stitched mesh.
        const curr = { x: uv.u, y: uv.v, u: uv.u, v: uv.v, _orig3D: p };
        const prev = loop[loop.length - 1];
        if (!prev || Math.abs(prev.u - curr.u) > 1e-10 || Math.abs(prev.v - curr.v) > 1e-10) {
          loop.push(curr);
        }
        prevUv = uv;
      }
      if (loop.length > 1) {
        const first = loop[0];
        const last = loop[loop.length - 1];
        if (Math.abs(first.u - last.u) < 1e-10 && Math.abs(first.v - last.v) < 1e-10) {
          loop.pop();
        }
      }
      return loop;
    };

    let outerUv = _normalizePeriodicLoop(mapLoopToUV(outer3D), surface);
    if (outerUv.length < 3) return { vertices: [], faces: [] };
    let holeUvs = holeLoops3D
      .map(loop => _normalizePeriodicLoop(mapLoopToUV(loop), surface))
      .filter(loop => loop.length >= 3);

    if (signedArea2D(outerUv) < 0) {
      outerUv = _normalizePeriodicLoop([...outerUv].reverse(), surface);
    }
    holeUvs = holeUvs.map(loop => {
      if (signedArea2D(loop) > 0) {
        return _normalizePeriodicLoop([...loop].reverse(), surface);
      }
      return loop;
    });

    let nnx = 0, nny = 0, nnz = 0;
    for (let i = 0; i < outer3D.length; i++) {
      const curr = outer3D[i];
      const next = outer3D[(i + 1) % outer3D.length];
      nnx += (curr.y - next.y) * (curr.z + next.z);
      nny += (curr.z - next.z) * (curr.x + next.x);
      nnz += (curr.x - next.x) * (curr.y + next.y);
    }
    const boundaryNormal = _normalize(
      Math.sqrt(nnx * nnx + nny * nny + nnz * nnz) > 1e-14
        ? { x: nnx, y: nny, z: nnz }
        : calculateNormal(outer3D[0], outer3D[1], outer3D[2])
    );

    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const p of outerUv) {
      if (p.u < uMin) uMin = p.u;
      if (p.u > uMax) uMax = p.u;
      if (p.v < vMin) vMin = p.v;
      if (p.v > vMax) vMax = p.v;
    }
    for (const loop of holeUvs) {
      for (const p of loop) {
        if (p.u < uMin) uMin = p.u;
        if (p.u > uMax) uMax = p.u;
        if (p.v < vMin) vMin = p.v;
        if (p.v > vMax) vMax = p.v;
      }
    }

    const steiner2D = [];
    const gridRes = surface.type === 'torus'
      ? Math.max(8, surfaceSegments)
      : periodicSurface
        ? Math.max(4, Math.ceil(surfaceSegments / 2))
        : Math.max(2, Math.ceil(surfaceSegments / 4));
    const uStep = (uMax - uMin) / (gridRes + 1 || 1);
    const vStep = (vMax - vMin) / (gridRes + 1 || 1);
    for (let i = 1; i <= gridRes; i++) {
      for (let j = 1; j <= gridRes; j++) {
        const u = uMin + i * uStep;
        const v = vMin + j * vStep;
        if (!_pointInPoly2D(u, v, outerUv)) continue;
        let inHole = false;
        for (const hole of holeUvs) {
          if (_pointInPoly2D(u, v, hole)) { inHole = true; break; }
        }
        if (!inHole) steiner2D.push({ x: u, y: v, u, v });
      }
    }

    const allUv = [...outerUv];
    for (const hole of holeUvs) allUv.push(...hole);
    allUv.push(...steiner2D);

    const triIndices = constrainedTriangulate(
      outerUv.map(p => ({ x: p.u, y: p.v })),
      holeUvs.map(loop => loop.map(p => ({ x: p.u, y: p.v }))),
      steiner2D.map(p => ({ x: p.u, y: p.v }))
    );

    const uvKey = (p) => `${Math.round(p.u * 1e8)},${Math.round(p.v * 1e8)}`;
    const edgeKey = (a, b) => {
      const ka = uvKey(a), kb = uvKey(b);
      return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    };
    const boundaryEdgeSet = new Set();
    const registerBoundary = (loop) => {
      for (let i = 0; i < loop.length; i++) {
        boundaryEdgeSet.add(edgeKey(loop[i], loop[(i + 1) % loop.length]));
      }
    };
    registerBoundary(outerUv);
    for (const hole of holeUvs) registerBoundary(hole);

    const pointCache = new Map();
    const evalPoint = (uv) => {
      const key = uvKey(uv);
      if (pointCache.has(key)) return pointCache.get(key);
      let out;
      if (uv._orig3D) {
        // Boundary vertex — use the exact EdgeSampler position to ensure
        // MeshStitcher can deduplicate shared vertices across adjacent faces.
        const o = uv._orig3D;
        out = { x: o.x, y: o.y, z: o.z, _u: uv.u, _v: uv.v };
      } else {
        const p = surface.evaluate(uv.u, uv.v);
        out = { x: p.x, y: p.y, z: p.z, _u: uv.u, _v: uv.v };
      }
      pointCache.set(key, out);
      return out;
    };

    const triangleSurfaceNormal = (a, b, c) => {
      let n = surface.normal((a.u + b.u + c.u) / 3, (a.v + b.v + c.v) / 3);
      if (!sameSense) n = { x: -n.x, y: -n.y, z: -n.z };
      return _normalize(n);
    };

    let triangles = [];
    for (const [a, b, c] of triIndices) {
      const ua = allUv[a], ub = allUv[b], uc = allUv[c];
      if (!ua || !ub || !uc) continue;
      const pa = evalPoint(ua), pb = evalPoint(ub), pc = evalPoint(uc);
      if (_triangleArea3D(pa, pb, pc) < 1e-12) continue;
      triangles.push([ua, ub, uc]);
    }

    if (!periodicSurface && triangles.length > 0) {
      const [ua, ub, uc] = triangles[0];
      const triN = calculateNormal(evalPoint(ua), evalPoint(ub), evalPoint(uc));
      if (_dot(triN, boundaryNormal) < 0) {
        triangles = triangles.map(([a, b, c]) => [a, c, b]);
      }
    }

    if (!periodicSurface) {
      triangles = triangles.filter(([a, b, c]) => {
        const n = calculateNormal(evalPoint(a), evalPoint(b), evalPoint(c));
        return _dot(n, boundaryNormal) > 0;
      });
    }

    let bbMinX = Infinity, bbMinY = Infinity, bbMinZ = Infinity;
    let bbMaxX = -Infinity, bbMaxY = -Infinity, bbMaxZ = -Infinity;
    for (const p of outer3D) {
      if (p.x < bbMinX) bbMinX = p.x; if (p.x > bbMaxX) bbMaxX = p.x;
      if (p.y < bbMinY) bbMinY = p.y; if (p.y > bbMaxY) bbMaxY = p.y;
      if (p.z < bbMinZ) bbMinZ = p.z; if (p.z > bbMaxZ) bbMaxZ = p.z;
    }
    const faceDiag = Math.sqrt(
      (bbMaxX - bbMinX) ** 2 + (bbMaxY - bbMinY) ** 2 + (bbMaxZ - bbMinZ) ** 2
    );
    const deviationScale = surface.type === 'torus'
      ? 0.00035
      : periodicSurface
        ? 0.0006
        : 0.002;
    const deviationTol = Math.max(faceDiag * deviationScale, 1e-8);

    const midpointCache = new Map();
    const midpointUv = (a, b) => {
      const key = edgeKey(a, b);
      if (midpointCache.has(key)) return midpointCache.get(key);
      const bu = surface.periodicU && Number.isFinite(surface.periodU)
        ? _wrapNear(b.u, a.u, surface.periodU)
        : b.u;
      const bv = surface.periodicV && Number.isFinite(surface.periodV)
        ? _wrapNear(b.v, a.v, surface.periodV)
        : b.v;
      const uv = { u: (a.u + bu) / 2, v: (a.v + bv) / 2 };
      uv.x = uv.u;
      uv.y = uv.v;
      midpointCache.set(key, uv);
      return uv;
    };
    const edgeDeviation = (a, b) => {
      const p0 = evalPoint(a);
      const p1 = evalPoint(b);
      const midUv = midpointUv(a, b);
      const mid = evalPoint(midUv);
      const lx = (p0.x + p1.x) / 2, ly = (p0.y + p1.y) / 2, lz = (p0.z + p1.z) / 2;
      const dx = mid.x - lx, dy = mid.y - ly, dz = mid.z - lz;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };
    const maxPasses = surface.type === 'torus'
      ? Math.min(surfaceSegments, 5)
      : surface.type === 'cylinder'
        ? Math.min(surfaceSegments, 1)
      : periodicSurface
        ? Math.min(surfaceSegments, 4)
        : Math.min(surfaceSegments, 4);
    for (let pass = 0; pass < maxPasses; pass++) {
      const edgeSplitSet = new Set();
      for (const [a, b, c] of triangles) {
        for (const [p, q] of [[a, b], [b, c], [c, a]]) {
          const key = edgeKey(p, q);
          if (boundaryEdgeSet.has(key)) continue;
          if (edgeDeviation(p, q) > deviationTol) edgeSplitSet.add(key);
        }
      }
      if (edgeSplitSet.size === 0) break;

      let anySplit = false;
      const next = [];
      for (const [a, b, c] of triangles) {
        const splitAB = edgeSplitSet.has(edgeKey(a, b));
        const splitBC = edgeSplitSet.has(edgeKey(b, c));
        const splitCA = edgeSplitSet.has(edgeKey(c, a));
        const splitCount = (splitAB ? 1 : 0) + (splitBC ? 1 : 0) + (splitCA ? 1 : 0);
        if (splitCount === 0) { next.push([a, b, c]); continue; }

        let subs;
        if (splitCount === 3) {
          const mAB = midpointUv(a, b);
          const mBC = midpointUv(b, c);
          const mCA = midpointUv(c, a);
          subs = [[a, mAB, mCA], [mAB, b, mBC], [mCA, mBC, c], [mAB, mBC, mCA]];
        } else if (splitCount === 2) {
          if (!splitAB) {
            const mBC = midpointUv(b, c), mCA = midpointUv(c, a);
            subs = [[a, b, mBC], [a, mBC, mCA], [mCA, mBC, c]];
          } else if (!splitBC) {
            const mAB = midpointUv(a, b), mCA = midpointUv(c, a);
            subs = [[mAB, b, c], [mAB, c, mCA], [a, mAB, mCA]];
          } else {
            const mAB = midpointUv(a, b), mBC = midpointUv(b, c);
            subs = [[a, mAB, mBC], [a, mBC, c], [mAB, b, mBC]];
          }
        } else {
          if (splitAB) {
            const m = midpointUv(a, b); subs = [[a, m, c], [m, b, c]];
          } else if (splitBC) {
            const m = midpointUv(b, c); subs = [[a, b, m], [a, m, c]];
          } else {
            const m = midpointUv(c, a); subs = [[a, b, m], [m, b, c]];
          }
        }

        anySplit = true;
        next.push(...subs);
      }
      triangles = next;
      if (!anySplit) break;
    }

    const meshFaces = [];
    const meshVertices = [];
    for (const [a, b, c] of triangles) {
      let ua = a, ub = b, uc = c;
      let pa = evalPoint(ua), pb = evalPoint(ub), pc = evalPoint(uc);
      const areaThreshold = faceDiag > 0 ? faceDiag * faceDiag * 1e-8 : 1e-14;
      if (_triangleArea3D(pa, pb, pc) < areaThreshold) continue;

      const refNormal = periodicSurface
        ? triangleSurfaceNormal(ua, ub, uc)
        : boundaryNormal;
      if (_dot(calculateNormal(pa, pb, pc), refNormal) < 0) {
        [ub, uc] = [uc, ub];
        [pb, pc] = [pc, pb];
      }

      const na = surface.normal(ua.u, ua.v);
      const nb = surface.normal(ub.u, ub.v);
      const nc = surface.normal(uc.u, uc.v);
      const triGeoN = calculateNormal(pa, pb, pc);
      const vna = _orientNormal(sameSense ? na : { x: -na.x, y: -na.y, z: -na.z }, triGeoN);
      const vnb = _orientNormal(sameSense ? nb : { x: -nb.x, y: -nb.y, z: -nb.z }, triGeoN);
      const vnc = _orientNormal(sameSense ? nc : { x: -nc.x, y: -nc.y, z: -nc.z }, triGeoN);
      let faceN = _normalize({
        x: (vna.x + vnb.x + vnc.x) / 3,
        y: (vna.y + vnb.y + vnc.y) / 3,
        z: (vna.z + vnb.z + vnc.z) / 3,
      });
      // Orient shading normal to agree with the triangle's geometric winding.
      // On cylinders/spheres the surface normal is nearly perpendicular to
      // boundaryNormal, so dot(faceN, boundaryNormal) ≈ 0 → unreliable sign.
      if (_dot(faceN, triGeoN) < 0) {
        faceN = { x: -faceN.x, y: -faceN.y, z: -faceN.z };
      }

      meshFaces.push({
        vertices: [{ ...pa }, { ...pb }, { ...pc }],
        normal: faceN,
        vertexNormals: [{ ...vna }, { ...vnb }, { ...vnc }],
      });
      meshVertices.push({ ...pa }, { ...pb }, { ...pc });
    }

    return { vertices: meshVertices, faces: meshFaces };
  }

  /**
   * Triangulate a NURBS surface face using its boundary and support surface.
   *
   * Ear-clips the boundary polygon (respecting trim curves), then adaptively
   * subdivides triangles whose midpoints deviate from the curved surface.
   * Per-vertex normals are computed analytically from the NURBS surface.
   *
   * @param {import('../BRepTopology.js').TopoFace} face
   * @param {Array<{x:number,y:number,z:number}>} boundaryPts3D - Ordered outer boundary in 3D
   * @param {number} surfaceSegments - Controls subdivision depth
   * @param {boolean} [sameSense=true]
   * @returns {{ vertices: Array<{x:number,y:number,z:number}>, faces: Array }}
   */
  triangulateSurface(face, boundaryPts3D, surfaceSegments, sameSense = true) {
    const surface = face.surface;
    if (!surface || boundaryPts3D.length < 3) {
      return this.triangulatePlanar(boundaryPts3D, [], null, sameSense);
    }

    // --- Step 1: Compute UVs for all boundary points ---
    let allPts = removeCollinearPoints([...boundaryPts3D]);
    if (allPts.length < 3) return { vertices: [], faces: [] };

    // Detect periodic surfaces: if eval(u,vMin) ≡ eval(u,vMax) (or same
    // for u), the surface wraps and closestPointUV cannot reliably track
    // around the full period — UVs will clamp and collapse.
    let periodic = surface._periodicHint === true;
    const periodicHintLocked = surface._periodicHint === true || surface._periodicHint === false;
    if (!periodicHintLocked && typeof surface.evaluate === 'function') {
      const uMid = (surface.uMin + surface.uMax) / 2;
      const vMid = (surface.vMin + surface.vMax) / 2;
      try {
        const pv0 = surface.evaluate(uMid, surface.vMin);
        const pv1 = surface.evaluate(uMid, surface.vMax);
        const dvClose = Math.sqrt((pv0.x - pv1.x) ** 2 + (pv0.y - pv1.y) ** 2 + (pv0.z - pv1.z) ** 2);
        const pu0 = surface.evaluate(surface.uMin, vMid);
        const pu1 = surface.evaluate(surface.uMax, vMid);
        const duClose = Math.sqrt((pu0.x - pu1.x) ** 2 + (pu0.y - pu1.y) ** 2 + (pu0.z - pu1.z) ** 2);
        if (dvClose < 1e-6 || duClose < 1e-6) periodic = true;
      } catch (_e) { /* not periodic */ }
    }

    // First boundary point: full grid search
    const uv0 = surface.closestPointUV(allPts[0]);
    allPts[0] = { ...allPts[0], _u: uv0.u, _v: uv0.v };

    // Remaining boundary points: use previous point's UV as hint
    for (let i = 1; i < allPts.length; i++) {
      const prev = allPts[i - 1];
      const uv = surface.closestPointUV(allPts[i], 4, { u: prev._u, v: prev._v });
      allPts[i] = { ...allPts[i], _u: uv.u, _v: uv.v };
    }

    // Check UV validity. Hint-chaining can collapse UVs for periodic
    // surfaces (cylinders).  When either parametric range is degenerate,
    // recompute every UV independently with full grid search.
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const p of allPts) {
      if (p._u < uMin) uMin = p._u;
      if (p._u > uMax) uMax = p._u;
      if (p._v < vMin) vMin = p._v;
      if (p._v > vMax) vMax = p._v;
    }
    const uvRangeU = uMax - uMin;
    const uvRangeV = vMax - vMin;
    let uvValid = uvRangeU > 1e-8 && uvRangeV > 1e-8;

    if (periodic) {
      // For periodic surfaces, hint-chaining often fails because
      // closestPointUV snaps to the base domain and can't track across
      // the seam.  Always recompute independently, then unwrap.
      for (let i = 0; i < allPts.length; i++) {
        const uv = surface.closestPointUV(allPts[i]);
        allPts[i]._u = uv.u;
        allPts[i]._v = uv.v;
      }

      const periodU = (surface.uMax - surface.uMin);
      const periodV = (surface.vMax - surface.vMin);
      const hasPerU = periodU > 1e-8;
      const hasPerV = periodV > 1e-8;

      if (hasPerU || hasPerV) {
        // Find the largest angular jump — that's the seam crossing.
        let maxJump = 0, jumpIdx = -1;
        for (let i = 0; i < allPts.length; i++) {
          const curr = allPts[i];
          const next = allPts[(i + 1) % allPts.length];
          let score = 0;
          if (hasPerU) score += Math.abs(next._u - curr._u) / periodU;
          if (hasPerV) score += Math.abs(next._v - curr._v) / periodV;
          if (score > maxJump) { maxJump = score; jumpIdx = i; }
        }

        if (maxJump > 0.3 && jumpIdx >= 0) {
          const rotStart = (jumpIdx + 1) % allPts.length;
          if (rotStart !== 0) {
            const rotated = [...allPts.slice(rotStart), ...allPts.slice(0, rotStart)];
            allPts.length = 0;
            allPts.push(...rotated);
          }
        }

        // Chain-unwrap: ensure consecutive points are within half-period
        for (let i = 1; i < allPts.length; i++) {
          if (hasPerU) {
            const diff = allPts[i]._u - allPts[i - 1]._u;
            if (Math.abs(diff) > periodU * 0.5) {
              allPts[i]._u -= Math.round(diff / periodU) * periodU;
            }
          }
          if (hasPerV) {
            const diff = allPts[i]._v - allPts[i - 1]._v;
            if (Math.abs(diff) > periodV * 0.5) {
              allPts[i]._v -= Math.round(diff / periodV) * periodV;
            }
          }
        }
      }

      // Recompute UV range after unwrapping
      uMin = Infinity; uMax = -Infinity; vMin = Infinity; vMax = -Infinity;
      for (const p of allPts) {
        if (p._u < uMin) uMin = p._u;
        if (p._u > uMax) uMax = p._u;
        if (p._v < vMin) vMin = p._v;
        if (p._v > vMax) vMax = p._v;
      }
      uvValid = (uMax - uMin) > 1e-8 && (vMax - vMin) > 1e-8;
    } else if (!uvValid) {
      // Recompute each UV independently (no hint-chaining)
      for (let i = 0; i < allPts.length; i++) {
        const uv = surface.closestPointUV(allPts[i]);
        allPts[i]._u = uv.u;
        allPts[i]._v = uv.v;
      }
      uMin = Infinity; uMax = -Infinity; vMin = Infinity; vMax = -Infinity;
      for (const p of allPts) {
        if (p._u < uMin) uMin = p._u;
        if (p._u > uMax) uMax = p._u;
        if (p._v < vMin) vMin = p._v;
        if (p._v > vMax) vMax = p._v;
      }
      uvValid = (uMax - uMin) > 1e-8 && (vMax - vMin) > 1e-8;
    }

    // Compute face normal from boundary geometry using Newell's method.
    // This is the best projection direction for CDT: it sees the boundary
    // polygon "face-on" regardless of surface curvature.
    let nnx = 0, nny = 0, nnz = 0;
    for (let i = 0; i < allPts.length; i++) {
      const curr = allPts[i];
      const next = allPts[(i + 1) % allPts.length];
      nnx += (curr.y - next.y) * (curr.z + next.z);
      nny += (curr.z - next.z) * (curr.x + next.x);
      nnz += (curr.x - next.x) * (curr.y + next.y);
    }
    let nnLen = Math.sqrt(nnx * nnx + nny * nny + nnz * nnz);
    const projNormal = nnLen > 1e-14
      ? { x: nnx / nnLen, y: nny / nnLen, z: nnz / nnLen }
      : calculateNormal(allPts[0], allPts[1], allPts[2]);

    // For winding verification, get the actual surface outward normal at
    // the UV centroid. This correctly handles curved surfaces where the
    // Newell polygon normal differs from the surface normal.
    let surfNormal = projNormal;
    if (uvValid) {
      const n = allPts.length;
      let cu = 0, cv = 0;
      for (const p of allPts) { cu += p._u; cv += p._v; }
      cu /= n; cv /= n;
      try {
        const centroidEval = GeometryEvaluator.evalSurface(surface, cu, cv);
        if (centroidEval.n) surfNormal = centroidEval.n;
      } catch (_e) { /* keep geometry-derived normal */ }
    } else {
      // For periodic/invalid-UV surfaces, the UV centroid is unreliable.
      // Use the first boundary point's UV (computed via full grid search,
      // not hint-chaining) to get the actual surface normal direction.
      try {
        const eval0 = GeometryEvaluator.evalSurface(surface, allPts[0]._u, allPts[0]._v);
        if (eval0.n) surfNormal = eval0.n;
      } catch (_e) { /* keep Newell normal */ }
    }

    // Detect self-intersecting UV boundary: when the UV polygon actually
    // crosses itself (e.g. folded B-splines), the UV-domain CDT produces
    // garbage.  Fall back to projected 3D CDT for such faces.
    // Use actual segment-segment intersection test rather than step-size
    // heuristics, which false-positive on rectangular patches (e.g. ruled
    // surfaces where coedge boundaries jump across the full u or v range).
    let uvSelfIntersecting = false;
    if (uvValid) {
      const uvPoly = allPts.map((p) => [p._u, p._v]);
      const n = uvPoly.length;
      // Check all non-adjacent edge pairs for proper crossing
      outer: for (let i = 0; i < n; i++) {
        const [ax, ay] = uvPoly[i];
        const [bx, by] = uvPoly[(i + 1) % n];
        for (let j = i + 2; j < n; j++) {
          if (j === (i + n - 1) % n) continue; // skip adjacent wrap-around
          const [cx, cy] = uvPoly[j];
          const [dx, dy] = uvPoly[(j + 1) % n];
          // Segment-segment proper crossing test
          const d1x = bx - ax, d1y = by - ay;
          const d2x = dx - cx, d2y = dy - cy;
          const denom = d1x * d2y - d1y * d2x;
          if (Math.abs(denom) < 1e-14) continue; // parallel
          const t = ((cx - ax) * d2y - (cy - ay) * d2x) / denom;
          const u = ((cx - ax) * d1y - (cy - ay) * d1x) / denom;
          if (t > 1e-8 && t < 1 - 1e-8 && u > 1e-8 && u < 1 - 1e-8) {
            uvSelfIntersecting = true;
            break outer;
          }
        }
      }
    }

    const useUvDomain = uvValid && !uvSelfIntersecting;

    // --- Step 2: CDT in parameter space when UVs are valid; otherwise fall
    // back to 3D projected space for periodic / collapsed-UV surfaces.
    // Trimmed B-spline faces need UV-domain CDT to avoid projected-space
    // overlaps that leave floating islands and missing regions.
    let pts2d = useUvDomain
      ? allPts.map((p) => ({ x: p._u, y: p._v }))
      : projectTo2D(allPts, projNormal);

    // Ensure CCW winding for CDT
    const projArea = signedArea2D(pts2d);
    if (projArea < 0) {
      allPts.reverse();
      pts2d = useUvDomain
        ? allPts.map((p) => ({ x: p._u, y: p._v }))
        : [...pts2d].reverse();
    }

    // Generate interior Steiner points for better triangle quality on large faces.
    // Steiner points require valid UV to evaluate the surface.
    const steiner2D = [];
    const steiner3D = [];
    if (uvValid) {
      const gridRes = Math.max(2, Math.ceil(surfaceSegments / 4));
      const uStep = (uMax - uMin) / (gridRes + 1);
      const vStep = (vMax - vMin) / (gridRes + 1);
      for (let gi = 1; gi <= gridRes; gi++) {
        for (let gj = 1; gj <= gridRes; gj++) {
          const gu = uMin + gi * uStep;
          const gv = vMin + gj * vStep;
          try {
            const sp3d = surface.evaluate(gu, gv);
            const pt3d = { x: sp3d.x, y: sp3d.y, z: sp3d.z, _u: gu, _v: gv };
            // Check candidate against the same triangulation domain used by CDT.
            const sp2d = useUvDomain
              ? { x: gu, y: gv }
              : projectTo2D([pt3d], projNormal)[0];
            if (_pointInPoly2D(sp2d.x, sp2d.y, pts2d)) {
              steiner2D.push(sp2d);
              steiner3D.push(pt3d);
            }
          } catch (_e) { /* skip this grid point */ }
        }
      }
    }

    // Combined point array: boundary + Steiner
    const combinedPts = [...allPts, ...steiner3D];
    const triIndices = constrainedTriangulate(pts2d, [], steiner2D);

    // Track original boundary edges so adaptive subdivision skips them.
    // Boundary edges are shared with adjacent B-Rep faces and must not be
    // split to avoid T-junctions at face boundaries.
    const boundaryEdgeSet = new Set();
    for (let i = 0; i < allPts.length; i++) {
      boundaryEdgeSet.add(_edgeKey(allPts[i], allPts[(i + 1) % allPts.length]));
    }

    let triangles = [];
    for (const [a, b, c] of triIndices) {
      const pa = combinedPts[a], pb = combinedPts[b], pc = combinedPts[c];
      if (!pa || !pb || !pc) continue;
      if (_triangleArea3D(pa, pb, pc) < 1e-12) continue;
      triangles.push([pa, pb, pc]);
    }

    // Global winding check: CDT produces consistent winding, but the
    // projection direction may not agree with the face outward normal.
    const outX = sameSense ? surfNormal.x : -surfNormal.x;
    const outY = sameSense ? surfNormal.y : -surfNormal.y;
    const outZ = sameSense ? surfNormal.z : -surfNormal.z;

    const orientTriangleToLocalSurface = (tri) => {
      const [a, b, c] = tri;
      const triN = calculateNormal(a, b, c);
      const cu = (a._u + b._u + c._u) / 3;
      const cv = (a._v + b._v + c._v) / 3;
      let refN = surfNormal;
      try {
        const evalResult = GeometryEvaluator.evalSurface(surface, cu, cv);
        if (evalResult.n) refN = evalResult.n;
      } catch (_e) {
        // Keep the face-level normal when a local UV centroid eval fails.
      }
      const out = sameSense
        ? refN
        : { x: -refN.x, y: -refN.y, z: -refN.z };
      return (triN.x * out.x + triN.y * out.y + triN.z * out.z) >= 0
        ? tri
        : [a, c, b];
    };

    if (periodic) {
      // UV-domain CDT on periodic surfaces produces consistent winding.
      // Evaluate the surface normal at the first triangle's actual location
      // (not the UV centroid, which may be far from this triangle) to
      // determine the correct winding direction.
      if (triangles.length > 0) {
        const [ta, tb, tc] = triangles[0];
        const triN = calculateNormal(ta, tb, tc);
        const cu = (ta._u + tb._u + tc._u) / 3;
        const cv = (ta._v + tb._v + tc._v) / 3;
        let refN = surfNormal;
        try {
          const e0 = GeometryEvaluator.evalSurface(surface, cu, cv);
          if (e0.n) refN = e0.n;
        } catch (_e) { /* keep centroid surfNormal */ }
        const oX = sameSense ? refN.x : -refN.x;
        const oY = sameSense ? refN.y : -refN.y;
        const oZ = sameSense ? refN.z : -refN.z;
        const dot = triN.x * oX + triN.y * oY + triN.z * oZ;
        if (dot < 0) {
          for (let i = 0; i < triangles.length; i++) {
            const [a, b, c] = triangles[i];
            triangles[i] = [a, c, b];
          }
        }
      }
    } else {
      // Non-periodic: single reference direction works fine.
      if (triangles.length > 0) {
        const [ta, tb, tc] = triangles[0];
        const triN = calculateNormal(ta, tb, tc);
        const dot = triN.x * outX + triN.y * outY + triN.z * outZ;
        if (dot < 0) {
          for (let i = 0; i < triangles.length; i++) {
            const [a, b, c] = triangles[i];
            triangles[i] = [a, c, b];
          }
        }
      }

      // Keep UV-domain trims watertight by reorienting locally misaligned
      // triangles instead of deleting them. The projected fallback still
      // drops folded artifacts later because it has no trustworthy UV trim.
      if (useUvDomain) {
        triangles = triangles.map((tri) => orientTriangleToLocalSurface(tri));
      } else {
        triangles = triangles.filter(([a, b, c]) => {
          const n = calculateNormal(a, b, c);
          return (n.x * outX + n.y * outY + n.z * outZ) > 0;
        });
      }
    }

    if (periodic && useUvDomain) {
      triangles = triangles.map((tri) => orientTriangleToLocalSurface(tri));
    }

    // Projected-space CDT can create overlapping 3D triangles on strongly
    // curved faces. UV-domain CDT already triangulates in the native trim
    // domain, so overlap cleanup is only needed for the projected fallback.
    if (!useUvDomain) {
      triangles = _removeOverlappingTriangles(triangles);
    }

    // --- Step 3: Adaptive subdivision using UV interpolation ---
    // When UV coordinates are valid, use full adaptive subdivision.
    // For periodic surfaces, allow limited subdivision on interior edges
    // only (boundary edges are protected above to prevent T-junctions).
    // The surfaceMidpoint() handles seam-crossing via closestPointUV.
    const maxPasses = uvValid
      ? Math.min(surfaceSegments, 4)
      : 0;

    // Scale deviation tolerance relative to face bounding box diagonal.
    // An absolute tolerance (e.g. 1e-3) causes explosive subdivision on
    // large models where even small arcs exceed the threshold.
    let bbMinX = Infinity, bbMinY = Infinity, bbMinZ = Infinity;
    let bbMaxX = -Infinity, bbMaxY = -Infinity, bbMaxZ = -Infinity;
    for (const p of allPts) {
      if (p.x < bbMinX) bbMinX = p.x; if (p.x > bbMaxX) bbMaxX = p.x;
      if (p.y < bbMinY) bbMinY = p.y; if (p.y > bbMaxY) bbMaxY = p.y;
      if (p.z < bbMinZ) bbMinZ = p.z; if (p.z > bbMaxZ) bbMaxZ = p.z;
    }
    const faceDiag = Math.sqrt(
      (bbMaxX - bbMinX) ** 2 + (bbMaxY - bbMinY) ** 2 + (bbMaxZ - bbMinZ) ** 2
    );
    const deviationTol = Math.max(faceDiag * 0.002, 1e-8);

    const midCache = new Map();
    function _ptKey(v) {
      return `${Math.round(v.x * 1e8)},${Math.round(v.y * 1e8)},${Math.round(v.z * 1e8)}`;
    }
    function _edgeKey(a, b) {
      const ka = _ptKey(a), kb = _ptKey(b);
      return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    }

    // Compute midpoint on the surface between two boundary/subdivision points.
    // Averages UVs to find the parametric midpoint, then evaluates the surface.
    // When the UV midpoint is far from the 3D midpoint (seam crossing on
    // periodic surfaces), falls back to closestPointUV for correct placement.
    function surfaceMidpoint(a, b) {
      const key = _edgeKey(a, b);
      if (midCache.has(key)) return midCache.get(key);

      let mu = (a._u + b._u) / 2;
      let mv = (a._v + b._v) / 2;
      let sp = surface.evaluate(mu, mv);

      // Check: is the UV-midpoint surface point close to the 3D linear midpoint?
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2;
      const dx = sp.x - mx, dy = sp.y - my, dz = sp.z - mz;
      const uvDist2 = dx * dx + dy * dy + dz * dz;
      const edX = a.x - b.x, edY = a.y - b.y, edZ = a.z - b.z;
      const edgeLen2 = edX * edX + edY * edY + edZ * edZ;

      if (uvDist2 > edgeLen2 * 0.25) {
        // UV midpoint produced a surface point far from the actual 3D midpoint.
        // This happens when UV averaging crosses a periodic seam (e.g. cylinder u=0/2π).
        // Use closestPointUV from the 3D midpoint with an endpoint UV as hint.
        try {
          const uv = surface.closestPointUV({ x: mx, y: my, z: mz }, 4, { u: a._u, v: mv });
          mu = uv.u; mv = uv.v;
          sp = surface.evaluate(mu, mv);
        } catch (_e) { /* keep UV-based midpoint */ }
      }

      const pt = { x: sp.x, y: sp.y, z: sp.z, _u: mu, _v: mv };
      midCache.set(key, pt);
      return pt;
    }

    // Check deviation: compare 3D linear midpoint to the actual surface midpoint.
    // Uses surfaceMidpoint() so seam-crossing edges get the corrected UV,
    // not a naive average that lands on the opposite side of the cylinder.
    function edgeDeviation(a, b) {
      const mid = surfaceMidpoint(a, b);
      const lx = (a.x + b.x) / 2, ly = (a.y + b.y) / 2, lz = (a.z + b.z) / 2;
      const dx = mid.x - lx, dy = mid.y - ly, dz = mid.z - lz;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    // Reference outward direction for fold detection.
    // Sub-triangles whose normal opposes this direction are "folded".
    const refNX = sameSense ? surfNormal.x : -surfNormal.x;
    const refNY = sameSense ? surfNormal.y : -surfNormal.y;
    const refNZ = sameSense ? surfNormal.z : -surfNormal.z;

    /** Return true if the triangle [a,b,c] faces the same way as the reference normal. */
    function _triAligned(a, b, c) {
      const v1x = b.x - a.x, v1y = b.y - a.y, v1z = b.z - a.z;
      const v2x = c.x - a.x, v2y = c.y - a.y, v2z = c.z - a.z;
      const nx = v1y * v2z - v1z * v2y;
      const ny = v1z * v2x - v1x * v2z;
      const nz = v1x * v2y - v1y * v2x;
      return (nx * refNX + ny * refNY + nz * refNZ) >= 0;
    }

    for (let pass = 0; pass < maxPasses; pass++) {
      const edgeSplitSet = new Set();
      for (const [a, b, c] of triangles) {
        for (const [p, q] of [[a, b], [b, c], [c, a]]) {
          const ek = _edgeKey(p, q);
          // Never split original boundary edges — they are shared with
          // adjacent B-Rep faces and splitting would create T-junctions.
          if (boundaryEdgeSet.has(ek)) continue;
          if (edgeDeviation(p, q) > deviationTol) {
            edgeSplitSet.add(ek);
          }
        }
      }
      if (edgeSplitSet.size === 0) break;

      const next = [];
      let anySplit = false;
      for (const [a, b, c] of triangles) {
        const splitAB = edgeSplitSet.has(_edgeKey(a, b));
        const splitBC = edgeSplitSet.has(_edgeKey(b, c));
        const splitCA = edgeSplitSet.has(_edgeKey(c, a));
        const splitCount = (splitAB ? 1 : 0) + (splitBC ? 1 : 0) + (splitCA ? 1 : 0);

        if (splitCount === 0) { next.push([a, b, c]); continue; }

        // Compute candidate sub-triangles
        let subs;
        if (splitCount === 3) {
          const mAB = surfaceMidpoint(a, b);
          const mBC = surfaceMidpoint(b, c);
          const mCA = surfaceMidpoint(c, a);
          subs = [[a, mAB, mCA], [mAB, b, mBC], [mCA, mBC, c], [mAB, mBC, mCA]];
        } else if (splitCount === 2) {
          if (!splitAB) {
            const mBC = surfaceMidpoint(b, c), mCA = surfaceMidpoint(c, a);
            subs = [[a, b, mBC], [a, mBC, mCA], [mCA, mBC, c]];
          } else if (!splitBC) {
            const mAB = surfaceMidpoint(a, b), mCA = surfaceMidpoint(c, a);
            subs = [[mAB, b, c], [mAB, c, mCA], [a, mAB, mCA]];
          } else {
            const mAB = surfaceMidpoint(a, b), mBC = surfaceMidpoint(b, c);
            subs = [[a, mAB, mBC], [a, mBC, c], [mAB, b, mBC]];
          }
        } else {
          if (splitAB) {
            const m = surfaceMidpoint(a, b); subs = [[a, m, c], [m, b, c]];
          } else if (splitBC) {
            const m = surfaceMidpoint(b, c); subs = [[a, b, m], [a, m, c]];
          } else {
            const m = surfaceMidpoint(c, a); subs = [[a, b, m], [m, b, c]];
          }
        }

        // UV-domain refinement must stay conforming across shared edges.
        // A per-triangle fold veto desynchronizes neighboring splits and leaves
        // T-junctions / holes on trimmed NURBS faces.
        const folded = !useUvDomain && subs.some(([sa, sb, sc]) => !_triAligned(sa, sb, sc));
        if (folded) {
          next.push([a, b, c]);
          continue;
        }

        anySplit = true;
        for (const s of subs) next.push(s);
      }
      triangles = next;
      if (!anySplit) break;
    }

    // --- Step 4: Build output with per-vertex normals ---
    // Winding has already been globally corrected in the post-CDT check above.
    const meshFaces = [];
    const meshVertices = [];
    for (const [a, b, c] of triangles) {
      // Skip truly degenerate triangles (collapsed to a line or point).
      // Use a small absolute threshold — the CDT + subdivision produces
      // valid thin triangles that must not be removed or gaps appear.
      if (_triangleArea3D(a, b, c) < 1e-12) continue;

      // Per-vertex surface normals for shading
      let nx = 0, ny = 0, nz = 0;
      const triGeoN = calculateNormal(a, b, c);
      const vertexNormals = [];
      for (const v of [a, b, c]) {
        let vn;
        try {
          const r = GeometryEvaluator.evalSurface(surface, v._u, v._v);
          vn = r.n || surfNormal;
        } catch (_e) {
          vn = surfNormal;
        }
        vn = _orientNormal(sameSense ? vn : { x: -vn.x, y: -vn.y, z: -vn.z }, triGeoN);
        vertexNormals.push(vn);
        nx += vn.x; ny += vn.y; nz += vn.z;
      }
      nx /= 3; ny /= 3; nz /= 3;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const faceN = len > 1e-14
        ? { x: nx / len, y: ny / len, z: nz / len }
        : surfNormal;

      // Orient the shading normal to agree with the triangle's geometric
      // winding (which was already corrected globally above).  On strongly
      // curved faces (cylinders, spheres) the surface normal is nearly
      // perpendicular to projNormal, so dotting against projNormal gives
      // unreliable ≈0 values.  Instead, dot the surface normal against the
      // triangle's geometric normal — they should agree in sign.
      const faceDot = faceN.x * triGeoN.x + faceN.y * triGeoN.y + faceN.z * triGeoN.z;
      const outNormal = faceDot >= 0
        ? faceN
        : { x: -faceN.x, y: -faceN.y, z: -faceN.z };

      meshFaces.push({
        vertices: [{ ...a }, { ...b }, { ...c }],
        normal: outNormal,
        vertexNormals: vertexNormals.map((vn) => ({ ...vn })),
      });
      meshVertices.push({ ...a }, { ...b }, { ...c });
    }

    console.log(`[FaceTriangulator] surface: ${allPts.length} boundary, ${steiner3D.length} steiner, ${triangles.length} tris (${maxPasses} subdiv passes, ${midCache.size} midpt cache, sameSense=${sameSense}, uvValid=${uvValid}, periodic=${periodic}, deviationTol=${deviationTol.toFixed(6)}, faceDiag=${faceDiag.toFixed(3)})`);

    return { vertices: meshVertices, faces: meshFaces };
  }
}

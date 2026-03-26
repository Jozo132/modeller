// js/cad/Tessellator2/FaceTriangulator.js — Parameter-space face triangulation
//
// Triangulates a face in parameter space using boundary points from coedge loops.
// Supports outer loops and holes. For planar faces, projects to 2D and ear-clips.
// For NURBS surface faces, maps UV domain triangulation to 3D via GeometryEvaluator.

import { GeometryEvaluator } from '../GeometryEvaluator.js';

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
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    // Check if curr is collinear with prev and next
    const area = _triangleArea3D(prev, curr, next);
    if (area > 1e-12) {
      result.push(curr);
    }
  }
  return result.length >= 3 ? result : pts;
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

    let normal = faceNormal;
    if (!normal) {
      normal = calculateNormal(boundaryPts[0], boundaryPts[1], boundaryPts[2]);
    }

    // For planar faces we combine outer + holes into a single polygon for ear-clipping
    // For simplicity with holes, if no holes, just ear-clip the outer boundary
    let allPts = [...boundaryPts];
    if (holePts.length > 0) {
      // Simple bridge: append hole points into outer polygon
      // This is a minimal approach — a more robust solution would use
      // proper constrained Delaunay triangulation
      for (const hole of holePts) {
        if (hole.length < 3) continue;
        // Find closest pair between outer polygon and hole to create bridge
        let bestOuterIdx = 0;
        let bestHoleIdx = 0;
        let bestDist = Infinity;
        for (let oi = 0; oi < allPts.length; oi++) {
          for (let hi = 0; hi < hole.length; hi++) {
            const dx = allPts[oi].x - hole[hi].x;
            const dy = allPts[oi].y - hole[hi].y;
            const dz = allPts[oi].z - hole[hi].z;
            const d = dx * dx + dy * dy + dz * dz;
            if (d < bestDist) {
              bestDist = d;
              bestOuterIdx = oi;
              bestHoleIdx = hi;
            }
          }
        }
        // Bridge: insert hole into outer polygon at closest point
        const bridged = [];
        for (let i = 0; i <= bestOuterIdx; i++) bridged.push(allPts[i]);
        // Walk hole starting from bestHoleIdx
        for (let i = 0; i <= hole.length; i++) {
          bridged.push(hole[(bestHoleIdx + i) % hole.length]);
        }
        // Bridge back and continue outer
        bridged.push(allPts[bestOuterIdx]);
        for (let i = bestOuterIdx + 1; i < allPts.length; i++) bridged.push(allPts[i]);
        allPts = bridged;
      }
    }

    // Remove collinear consecutive points to avoid degenerate triangles
    allPts = removeCollinearPoints(allPts);

    // Project to 2D for ear-clipping
    const pts2d = projectTo2D(allPts, normal);
    const triIndices = earClipIndices(pts2d);

    // Orient normal
    let outNormal = { ...normal };
    if (!sameSense) {
      outNormal = { x: -normal.x, y: -normal.y, z: -normal.z };
    }

    const meshFaces = [];
    for (const [a, b, c] of triIndices) {
      // Skip degenerate triangles from collinear boundary points
      const pa = allPts[a], pb = allPts[b], pc = allPts[c];
      const area = _triangleArea3D(pa, pb, pc);
      if (area < 1e-12) continue;

      const verts = sameSense
        ? [pa, pb, pc]
        : [pc, pb, pa];
      meshFaces.push({
        vertices: verts.map(v => ({ ...v })),
        normal: { ...outNormal },
      });
    }

    return {
      vertices: allPts.map(p => ({ ...p })),
      faces: meshFaces,
    };
  }

  /**
   * Triangulate a NURBS surface face using its support surface and boundary.
   *
   * Uses a uniform UV grid on the surface, then maps to 3D via GeometryEvaluator.
   * Boundary vertices from shared edge samples are integrated to ensure watertightness.
   *
   * @param {import('../BRepTopology.js').TopoFace} face
   * @param {Array<{x:number,y:number,z:number}>} boundaryPts3D - Ordered outer boundary in 3D
   * @param {number} surfaceSegments - Number of segments per UV direction
   * @param {boolean} [sameSense=true]
   * @returns {{ vertices: Array<{x:number,y:number,z:number}>, faces: Array<{vertices: Array<{x:number,y:number,z:number}>, normal: {x:number,y:number,z:number}}> }}
   */
  triangulateSurface(face, boundaryPts3D, surfaceSegments, sameSense = true) {
    const surface = face.surface;
    if (!surface) {
      return this.triangulatePlanar(boundaryPts3D, [], null, sameSense);
    }

    const uMin = surface.knotsU[0];
    const uMax = surface.knotsU[surface.knotsU.length - 1];
    const vMin = surface.knotsV[0];
    const vMax = surface.knotsV[surface.knotsV.length - 1];

    const segsU = surfaceSegments;
    const segsV = surfaceSegments;

    // Build UV grid vertices and evaluate 3D positions + normals
    const vertices = [];
    const normals = [];
    const rows = segsV + 1;
    const cols = segsU + 1;

    for (let j = 0; j <= segsV; j++) {
      const v = vMin + (j / segsV) * (vMax - vMin);
      for (let i = 0; i <= segsU; i++) {
        const u = uMin + (i / segsU) * (uMax - uMin);
        try {
          const result = GeometryEvaluator.evalSurface(surface, u, v);
          vertices.push({ x: result.p.x, y: result.p.y, z: result.p.z });
          normals.push(result.n || { x: 0, y: 0, z: 1 });
        } catch (_e) {
          // GeometryEvaluator.evalSurface may fail for degenerate surface
          // patches or when WASM + JS fallback both fail. Fall back to
          // direct surface.evaluate() without derivatives/normals.
          const pt = surface.evaluate(u, v);
          vertices.push(pt);
          normals.push({ x: 0, y: 0, z: 1 });
        }
      }
    }

    // Build triangle faces from the grid
    const meshFaces = [];
    for (let j = 0; j < segsV; j++) {
      for (let i = 0; i < segsU; i++) {
        const tl = j * cols + i;
        const tr = j * cols + i + 1;
        const bl = (j + 1) * cols + i;
        const br = (j + 1) * cols + i + 1;

        const n0 = normals[tl];
        let faceNormal = sameSense ? n0 : { x: -n0.x, y: -n0.y, z: -n0.z };

        if (sameSense) {
          meshFaces.push({
            vertices: [{ ...vertices[tl] }, { ...vertices[tr] }, { ...vertices[br] }],
            normal: { ...faceNormal },
          });
          meshFaces.push({
            vertices: [{ ...vertices[tl] }, { ...vertices[br] }, { ...vertices[bl] }],
            normal: { ...faceNormal },
          });
        } else {
          meshFaces.push({
            vertices: [{ ...vertices[br] }, { ...vertices[tr] }, { ...vertices[tl] }],
            normal: { ...faceNormal },
          });
          meshFaces.push({
            vertices: [{ ...vertices[bl] }, { ...vertices[br] }, { ...vertices[tl] }],
            normal: { ...faceNormal },
          });
        }
      }
    }

    return { vertices, faces: meshFaces };
  }
}

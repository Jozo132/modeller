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
    let periodic = false;
    if (typeof surface.evaluate === 'function') {
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

    if (!uvValid) {
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

    // On periodic surfaces, UVs from closestPointUV are unreliable even
    // when they span a non-degenerate range — the solver clamps to [min,max]
    // and can't track around the wrap.  Disable UV-based features (Steiner
    // points, adaptive subdivision) to avoid garbage from bad UVs.
    if (periodic) uvValid = false;

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

    // --- Step 2: CDT in 3D projected space ---
    // Project using Newell polygon normal (NOT the surface normal).
    // For curved surfaces (cylinders, spheres), the surface normal varies
    // across the face and would give a degenerate projection.
    const pts2d = projectTo2D(allPts, projNormal);

    // Ensure CCW winding for CDT
    const projArea = signedArea2D(pts2d);
    if (projArea < 0) {
      allPts.reverse();
      pts2d.reverse();
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
            // Project to same 2D space and check if inside boundary polygon
            const sp2d = projectTo2D([pt3d], projNormal)[0];
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
    // Check one representative triangle and flip ALL if needed.
    const outX = sameSense ? surfNormal.x : -surfNormal.x;
    const outY = sameSense ? surfNormal.y : -surfNormal.y;
    const outZ = sameSense ? surfNormal.z : -surfNormal.z;
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

    // Remove any CDT artifact triangles that face the wrong direction.
    // On complex curved surfaces, the 2D projection can create triangles
    // whose 3D geometry is inverted relative to the face outward normal.
    triangles = triangles.filter(([a, b, c]) => {
      const n = calculateNormal(a, b, c);
      return (n.x * outX + n.y * outY + n.z * outZ) > 0;
    });

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

        // Fold guard: if any sub-triangle has a flipped normal, keep original
        const folded = subs.some(([sa, sb, sc]) => !_triAligned(sa, sb, sc));
        if (folded) {
          next.push([a, b, c]);
        } else {
          anySplit = true;
          for (const s of subs) next.push(s);
        }
      }
      triangles = next;
      if (!anySplit) break;
    }

    // --- Step 4: Build output with per-vertex normals ---
    // Winding has already been globally corrected in the post-CDT check above.
    const meshFaces = [];
    const meshVertices = [];
    for (const [a, b, c] of triangles) {
      // Skip near-degenerate triangles: use a relative threshold based on
      // face diagonal to catch CDT micro-artifacts on complex curved faces.
      const areaThreshold = faceDiag > 0 ? faceDiag * faceDiag * 1e-8 : 1e-14;
      if (_triangleArea3D(a, b, c) < areaThreshold) continue;

      // Per-vertex surface normals for shading
      let nx = 0, ny = 0, nz = 0;
      for (const v of [a, b, c]) {
        try {
          const r = GeometryEvaluator.evalSurface(surface, v._u, v._v);
          const vn = r.n || surfNormal;
          nx += vn.x; ny += vn.y; nz += vn.z;
        } catch (_e) {
          nx += surfNormal.x; ny += surfNormal.y; nz += surfNormal.z;
        }
      }
      nx /= 3; ny /= 3; nz /= 3;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const faceN = len > 1e-14
        ? { x: nx / len, y: ny / len, z: nz / len }
        : surfNormal;

      const outNormal = sameSense
        ? faceN
        : { x: -faceN.x, y: -faceN.y, z: -faceN.z };

      meshFaces.push({
        vertices: [{ ...a }, { ...b }, { ...c }],
        normal: outNormal,
      });
      meshVertices.push({ ...a }, { ...b }, { ...c });
    }

    console.log(`[FaceTriangulator] surface: ${allPts.length} boundary, ${steiner3D.length} steiner, ${triangles.length} tris (${maxPasses} subdiv passes, ${midCache.size} midpt cache, sameSense=${sameSense}, uvValid=${uvValid}, periodic=${periodic}, deviationTol=${deviationTol.toFixed(6)}, faceDiag=${faceDiag.toFixed(3)})`);

    return { vertices: meshVertices, faces: meshFaces };
  }
}

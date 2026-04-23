// js/cad/Intersections.js — High-level intersection dispatch
//
// Provides a unified entry point for all intersection operations.
// Dispatches to specialized routines based on geometry types.
// Uses WASM octree broadphase when available to reduce candidate
// pairs from O(N×M) to O(N log N).

import { curveCurveIntersect } from './CurveCurveIntersect.js';
import { curveSurfaceIntersect } from './CurveSurfaceIntersect.js';
import { surfaceSurfaceIntersect } from './SurfaceSurfaceIntersect.js';
import { NurbsCurve } from './NurbsCurve.js';
import { DEFAULT_TOLERANCE } from './Tolerance.js';
import { SurfaceType } from './BRepTopology.js';
import { GeometryEvaluator } from './GeometryEvaluator.js';

// Lazy WASM module reference (same singleton as StepImportWasm.js)
let _wasm = null;
let _wasmMem = null;
// H9: a single in-flight load promise. Intersections.js used to define
// `_ensureWasm()` but never await it anywhere, so `_wasmReady()` was
// always false and the octree broadphase below was pure dead code — every
// boolean fell through to the O(N×M) JS `_aabbBroadphase`. Keeping the
// load lazy means consumers in hot paths stay synchronous; the first
// `intersectBodies` call starts the load fire-and-forget so subsequent
// calls benefit from the WASM octree, and callers that can afford to
// await (main.js bootstrap, tests) can explicitly `preloadIntersectionsWasm()`.
let _wasmLoadPromise = null;
const _debugSurfaceBackend = {
  last: 'js',
  wasmPlanePlaneCalls: 0,
  wasmPlaneSphereCalls: 0,
  wasmPlaneCylinderCalls: 0,
};
async function _ensureWasm() {
  if (_wasm) return true;
  if (!_wasmLoadPromise) {
    _wasmLoadPromise = (async () => {
      try {
        const mod = await import('../../build/release.js');
        _wasm = mod;
        _wasmMem = mod.memory;
        return true;
      } catch {
        _wasm = null;
        return false;
      }
    })();
  }
  return _wasmLoadPromise;
}
// Synchronous check only
function _wasmReady() { return _wasm != null; }

/**
 * Preload the WASM kernel so subsequent `intersectBodies` calls can use the
 * O(N log N) octree broadphase instead of the O(N×M) JS fallback. Safe to
 * call more than once; subsequent calls share the same in-flight promise.
 *
 * @returns {Promise<boolean>} true if WASM is available after the call.
 */
export async function preloadIntersectionsWasm() {
  return _ensureWasm();
}

// Test-only backend probe for the H8 narrowphase migration.
export function _getIntersectionsDebugStateForTests() {
  return { ..._debugSurfaceBackend };
}

export function _resetIntersectionsDebugStateForTests() {
  _debugSurfaceBackend.last = 'js';
  _debugSurfaceBackend.wasmPlanePlaneCalls = 0;
  _debugSurfaceBackend.wasmPlaneSphereCalls = 0;
  _debugSurfaceBackend.wasmPlaneCylinderCalls = 0;
}

/**
 * Compute an axis-aligned bounding box for a TopoFace from its boundary
 * vertices and a surface sample grid for curved faces.
 *
 * @param {import('./BRepTopology.js').TopoFace} face
 * @returns {{ minX:number, minY:number, minZ:number, maxX:number, maxY:number, maxZ:number }}
 */
function _faceAABB(face) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  // Walk boundary vertices
  const verts = face.vertices();
  for (const v of verts) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.z < minZ) minZ = v.z;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
    if (v.z > maxZ) maxZ = v.z;
  }

  // For curved surfaces, also sample a few interior points
  if (face.surface && face.surfaceType !== SurfaceType.PLANE) {
    const s = face.surface;
    const N = 4;
    for (let i = 0; i <= N; i++) {
      const u = s.uMin + (i / N) * (s.uMax - s.uMin);
      for (let j = 0; j <= N; j++) {
        const v = s.vMin + (j / N) * (s.vMax - s.vMin);
        try {
          const p = GeometryEvaluator.evalSurface(s, u, v).p;
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.z < minZ) minZ = p.z;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
          if (p.z > maxZ) maxZ = p.z;
        } catch { /* skip bad samples */ }
      }
    }
  }

  // Inflate slightly for numerical safety
  const eps = 1e-8;
  return {
    minX: minX - eps, minY: minY - eps, minZ: minZ - eps,
    maxX: maxX + eps, maxY: maxY + eps, maxZ: maxZ + eps,
  };
}

/**
 * Intersect two curves.
 *
 * @param {import('./NurbsCurve.js').NurbsCurve} curveA
 * @param {import('./NurbsCurve.js').NurbsCurve} curveB
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {Array<{paramA: number, paramB: number, point: {x,y,z}}>}
 */
export function intersectCurves(curveA, curveB, tol = DEFAULT_TOLERANCE) {
  return curveCurveIntersect(curveA, curveB, tol);
}

/**
 * Intersect a curve with a surface.
 *
 * @param {import('./NurbsCurve.js').NurbsCurve} curve
 * @param {import('./NurbsSurface.js').NurbsSurface} surface
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {Array<{paramT: number, paramU: number, paramV: number, point: {x,y,z}}>}
 */
export function intersectCurveSurface(curve, surface, tol = DEFAULT_TOLERANCE) {
  return curveSurfaceIntersect(curve, surface, tol);
}

/**
 * Intersect two surfaces.
 *
 * @param {import('./NurbsSurface.js').NurbsSurface} surfA
 * @param {string} typeA - Surface type
 * @param {import('./NurbsSurface.js').NurbsSurface} surfB
 * @param {string} typeB - Surface type
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {Array<{curve: import('./NurbsCurve.js').NurbsCurve, paramsA: Array<{u,v}>, paramsB: Array<{u,v}>}>}
 */
export function intersectSurfaces(surfA, typeA, surfB, typeB, tol = DEFAULT_TOLERANCE) {
  const wasmResult = _intersectSurfacesWasm(surfA, typeA, surfB, typeB, tol);
  if (wasmResult) return wasmResult;
  _debugSurfaceBackend.last = 'js';
  return surfaceSurfaceIntersect(surfA, typeA, surfB, typeB, tol);
}

function _intersectSurfacesWasm(surfA, typeA, surfB, typeB, tol) {
  if (!_wasmReady() || !_wasmMem) return null;

  // Plane × Plane ────────────────────────────────────────────────────
  if (typeA === SurfaceType.PLANE && typeB === SurfaceType.PLANE) {
    if (typeof _wasm.planePlaneIntersect !== 'function' || typeof _wasm.getPlanePlaneIntersectPtr !== 'function') {
      return null;
    }
    const evalA = GeometryEvaluator.evalSurface(surfA, 0.5, 0.5);
    const evalB = GeometryEvaluator.evalSurface(surfB, 0.5, 0.5);
    const hit = _wasm.planePlaneIntersect(
      evalA.p.x, evalA.p.y, evalA.p.z,
      evalA.n.x, evalA.n.y, evalA.n.z,
      evalB.p.x, evalB.p.y, evalB.p.z,
      evalB.n.x, evalB.n.y, evalB.n.z,
      tol.angularParallelism,
    );

    _debugSurfaceBackend.last = 'wasm-plane-plane';
    _debugSurfaceBackend.wasmPlanePlaneCalls++;
    if (!hit) return [];

    const out = new Float64Array(_wasmMem.buffer, _wasm.getPlanePlaneIntersectPtr(), 6);
    const pt = { x: out[0], y: out[1], z: out[2] };
    const dir = { x: out[3], y: out[4], z: out[5] };
    const extent = 1000;
    const p0 = { x: pt.x - dir.x * extent, y: pt.y - dir.y * extent, z: pt.z - dir.z * extent };
    const p1 = { x: pt.x + dir.x * extent, y: pt.y + dir.y * extent, z: pt.z + dir.z * extent };
    return [{
      curve: NurbsCurve.createLine(p0, p1),
      paramsA: [_computePlaneUV(surfA, p0), _computePlaneUV(surfA, p1)],
      paramsB: [_computePlaneUV(surfB, p0), _computePlaneUV(surfB, p1)],
    }];
  }

  // Plane × Sphere / Sphere × Plane ──────────────────────────────────
  if ((typeA === SurfaceType.PLANE && typeB === SurfaceType.SPHERE)
    || (typeA === SurfaceType.SPHERE && typeB === SurfaceType.PLANE)) {
    if (typeof _wasm.planeSphereIntersect !== 'function' || typeof _wasm.getPlaneSphereIntersectPtr !== 'function') {
      return null;
    }
    const planeSurf = typeA === SurfaceType.PLANE ? surfA : surfB;
    const sphereSurf = typeA === SurfaceType.SPHERE ? surfA : surfB;
    const sphInfo = _extractSphereInfoCompat(sphereSurf);
    if (!sphInfo) return null; // let JS fallback handle degenerate sphere

    const evalP = GeometryEvaluator.evalSurface(planeSurf, 0.5, 0.5);
    const hit = _wasm.planeSphereIntersect(
      evalP.p.x, evalP.p.y, evalP.p.z,
      evalP.n.x, evalP.n.y, evalP.n.z,
      sphInfo.center.x, sphInfo.center.y, sphInfo.center.z,
      sphInfo.radius,
      _distTol(tol),
    );

    _debugSurfaceBackend.last = 'wasm-plane-sphere';
    _debugSurfaceBackend.wasmPlaneSphereCalls++;
    if (!hit) return [];

    const out = new Float64Array(_wasmMem.buffer, _wasm.getPlaneSphereIntersectPtr(), 7);
    const center = { x: out[0], y: out[1], z: out[2] };
    const normal = { x: out[3], y: out[4], z: out[5] };
    const radius = out[6];
    const curve = _buildCircleCurve9Pt(center, normal, radius);
    return [{ curve, paramsA: [], paramsB: [] }];
  }

  // Plane × Cylinder / Cylinder × Plane ──────────────────────────────
  if ((typeA === SurfaceType.PLANE && typeB === SurfaceType.CYLINDER)
    || (typeA === SurfaceType.CYLINDER && typeB === SurfaceType.PLANE)) {
    if (typeof _wasm.planeCylinderIntersect !== 'function' || typeof _wasm.getPlaneCylinderIntersectPtr !== 'function') {
      return null;
    }
    const planeSurf = typeA === SurfaceType.PLANE ? surfA : surfB;
    const cylSurf = typeA === SurfaceType.CYLINDER ? surfA : surfB;
    const cylInfo = _extractCylinderInfoCompat(cylSurf);
    if (!cylInfo) return null; // let JS fallback handle degenerate/unknown cylinder

    const evalP = GeometryEvaluator.evalSurface(planeSurf, 0.5, 0.5);
    const tag = _wasm.planeCylinderIntersect(
      evalP.p.x, evalP.p.y, evalP.p.z,
      evalP.n.x, evalP.n.y, evalP.n.z,
      cylInfo.origin.x, cylInfo.origin.y, cylInfo.origin.z,
      cylInfo.axis.x, cylInfo.axis.y, cylInfo.axis.z,
      cylInfo.radius,
      tol.angularParallelism,
      _distTol(tol),
    );

    // Oblique ellipse: tag=255. Fall back to the JS numeric marcher.
    if (tag === 255) return null;

    _debugSurfaceBackend.last = 'wasm-plane-cylinder';
    _debugSurfaceBackend.wasmPlaneCylinderCalls++;
    if (tag === 0) return [];

    const out = new Float64Array(_wasmMem.buffer, _wasm.getPlaneCylinderIntersectPtr(), 12);

    if (tag === 1) {
      const center = { x: out[0], y: out[1], z: out[2] };
      const normal = { x: out[3], y: out[4], z: out[5] };
      const radius = out[6];
      return [{ curve: _buildCircleCurve9Pt(center, normal, radius), paramsA: [], paramsB: [] }];
    }

    if (tag === 2) {
      const pt = { x: out[0], y: out[1], z: out[2] };
      const dir = { x: out[3], y: out[4], z: out[5] };
      return [_buildLineResultAlongDir(pt, dir)];
    }

    if (tag === 3) {
      const pt0 = { x: out[0], y: out[1], z: out[2] };
      const dir0 = { x: out[3], y: out[4], z: out[5] };
      const pt1 = { x: out[6], y: out[7], z: out[8] };
      const dir1 = { x: out[9], y: out[10], z: out[11] };
      return [
        _buildLineResultAlongDir(pt0, dir0),
        _buildLineResultAlongDir(pt1, dir1),
      ];
    }

    return null;
  }

  return null;
}

function _buildLineResultAlongDir(pt, dir) {
  const extent = 1000;
  const p0 = { x: pt.x - dir.x * extent, y: pt.y - dir.y * extent, z: pt.z - dir.z * extent };
  const p1 = { x: pt.x + dir.x * extent, y: pt.y + dir.y * extent, z: pt.z + dir.z * extent };
  return { curve: NurbsCurve.createLine(p0, p1), paramsA: [], paramsB: [] };
}

// Linear tolerance for narrowphase guards. `Tolerance.distance(a,b)` is a
// method, not a field — coerce to a safe numeric by picking one of the
// linear-distance epsilons that actually exist on the Tolerance object.
function _distTol(tol) {
  if (tol && typeof tol.modelingEpsilon === 'number') return tol.modelingEpsilon;
  if (tol && typeof tol.pointCoincidence === 'number') return tol.pointCoincidence;
  return 1e-8;
}

function _extractCylinderInfoCompat(surface) {
  if (!surface) return null;
  const src = (surface._analyticParams && surface._analyticParams.type === 'cylinder')
    ? surface._analyticParams
    : (surface.surfaceInfo && surface.surfaceInfo.type === 'cylinder')
      ? surface.surfaceInfo
      : null;
  if (!src) return null;
  const origin = src.origin || src.center;
  const axis = src.axis;
  if (!origin || !axis || src.radius == null) return null;
  const aLen = Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z) || 1;
  return {
    origin,
    axis: { x: axis.x / aLen, y: axis.y / aLen, z: axis.z / aLen },
    radius: src.radius,
  };
}

function _extractSphereInfoCompat(surface) {
  if (!surface) return null;
  const src = (surface._analyticParams && surface._analyticParams.type === 'sphere')
    ? surface._analyticParams
    : (surface.surfaceInfo && surface.surfaceInfo.type === 'sphere')
      ? surface.surfaceInfo
      : null;
  if (!src) return null;
  const center = src.center || src.origin;
  if (!center || src.radius == null) return null;
  return { center, radius: src.radius };
}

function _buildCircleCurve9Pt(center, normal, radius) {
  let uDir;
  if (Math.abs(normal.y) < 0.9) uDir = { x: -normal.z, y: 0, z: normal.x };
  else uDir = { x: 0, y: normal.z, z: -normal.y };
  const uLen = Math.sqrt(uDir.x * uDir.x + uDir.y * uDir.y + uDir.z * uDir.z) || 1;
  uDir = { x: uDir.x / uLen, y: uDir.y / uLen, z: uDir.z / uLen };
  const vDir = {
    x: normal.y * uDir.z - normal.z * uDir.y,
    y: normal.z * uDir.x - normal.x * uDir.z,
    z: normal.x * uDir.y - normal.y * uDir.x,
  };
  // Standard 9-point rational NURBS circle. Axis CPs sit on the circle
  // (weight 1); corner CPs sit at the intersection of the two
  // neighboring tangents (weight √2/2). For a unit quarter-arc from
  // angle α to α+π/2, the corner CP direction is (cos α + cos(α+π/2),
  // sin α + sin(α+π/2)) in the local (u,v) frame.
  const w = Math.SQRT1_2;
  const cp = [];
  const weights = [];
  for (let i = 0; i < 9; i++) {
    const isCorner = (i % 2) === 1;
    let a, b;
    if (isCorner) {
      const k = (i - 1) / 2;
      a = Math.cos(k * Math.PI / 2) + Math.cos((k + 1) * Math.PI / 2);
      b = Math.sin(k * Math.PI / 2) + Math.sin((k + 1) * Math.PI / 2);
    } else {
      const k = i / 2;
      a = Math.cos(k * Math.PI / 2);
      b = Math.sin(k * Math.PI / 2);
    }
    cp.push({
      x: center.x + radius * (a * uDir.x + b * vDir.x),
      y: center.y + radius * (a * uDir.y + b * vDir.y),
      z: center.z + radius * (a * uDir.z + b * vDir.z),
    });
    weights.push(isCorner ? w : 1.0);
  }
  return new NurbsCurve(2, cp, [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1], weights);
}

function _computePlaneUV(planeSurface, point3D) {
  const cp = planeSurface.controlPoints;
  if (!cp || cp.length < 4) return { u: 0, v: 0 };

  const orig = cp[0];
  const uDir = { x: cp[2].x - cp[0].x, y: cp[2].y - cp[0].y, z: cp[2].z - cp[0].z };
  const vDir = { x: cp[1].x - cp[0].x, y: cp[1].y - cp[0].y, z: cp[1].z - cp[0].z };
  const dp = { x: point3D.x - orig.x, y: point3D.y - orig.y, z: point3D.z - orig.z };

  const uu = uDir.x * uDir.x + uDir.y * uDir.y + uDir.z * uDir.z;
  const uv = uDir.x * vDir.x + uDir.y * vDir.y + uDir.z * vDir.z;
  const vv = vDir.x * vDir.x + vDir.y * vDir.y + vDir.z * vDir.z;
  const up = uDir.x * dp.x + uDir.y * dp.y + uDir.z * dp.z;
  const vp = vDir.x * dp.x + vDir.y * dp.y + vDir.z * dp.z;
  const det = uu * vv - uv * uv;
  if (Math.abs(det) < 1e-20) return { u: 0, v: 0 };

  return {
    u: (vv * up - uv * vp) / det,
    v: (uu * vp - uv * up) / det,
  };
}

/**
 * Intersect all candidate face pairs from two bodies.
 * Uses WASM octree broadphase when available, falling back to AABB
 * pre-filter or brute-force N×M loop.
 *
 * @param {import('./BRepTopology.js').TopoBody} bodyA
 * @param {import('./BRepTopology.js').TopoBody} bodyB
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {Array<{faceA: import('./BRepTopology.js').TopoFace, faceB: import('./BRepTopology.js').TopoFace, curves: Array}>}
 */
export function intersectBodies(bodyA, bodyB, tol = DEFAULT_TOLERANCE) {
  const facesA = bodyA.faces();
  const facesB = bodyB.faces();

  // Compute face AABBs for both bodies
  const aabbsA = facesA.map(f => _faceAABB(f));
  const aabbsB = facesB.map(f => _faceAABB(f));

  // Determine candidate pairs via broadphase
  let candidatePairs;
  if (_wasmReady() && facesA.length + facesB.length > 8) {
    candidatePairs = _wasmOctreeBroadphase(facesA, facesB, aabbsA, aabbsB);
  } else {
    // H9: kick off a fire-and-forget load so the next call can use the
    // octree broadphase. `_ensureWasm` de-dupes concurrent loads.
    if (!_wasm) _ensureWasm();
    candidatePairs = _aabbBroadphase(facesA, facesB, aabbsA, aabbsB);
  }

  // Narrow phase: compute intersection curves for each candidate pair
  const results = [];
  for (const [iA, iB] of candidatePairs) {
    const fA = facesA[iA];
    const fB = facesB[iB];
    if (!fA.surface || !fB.surface) continue;

    const curves = intersectSurfaces(
      fA.surface, fA.surfaceType,
      fB.surface, fB.surfaceType,
      tol,
    );

    if (curves.length > 0) {
      results.push({ faceA: fA, faceB: fB, curves });
    }
  }

  return results;
}

/**
 * AABB-only broadphase — JS fallback when WASM is not loaded.
 * O(N×M) but with early AABB rejection.
 */
function _aabbBroadphase(facesA, facesB, aabbsA, aabbsB) {
  const pairs = [];
  for (let iA = 0; iA < facesA.length; iA++) {
    const a = aabbsA[iA];
    for (let iB = 0; iB < facesB.length; iB++) {
      const b = aabbsB[iB];
      if (a.minX <= b.maxX && a.maxX >= b.minX &&
          a.minY <= b.maxY && a.maxY >= b.minY &&
          a.minZ <= b.maxZ && a.maxZ >= b.minZ) {
        pairs.push([iA, iB]);
      }
    }
  }
  return pairs;
}

/**
 * WASM octree broadphase — O(N log N) candidate pair detection.
 * Loads face AABBs into the WASM octree, builds, queries, and reads
 * back candidate pairs.
 */
function _wasmOctreeBroadphase(facesA, facesB, aabbsA, aabbsB) {
  const w = _wasm;
  w.octreeReset();

  // Register body A faces as ids [0..nA)
  const nA = facesA.length;
  for (let i = 0; i < nA; i++) {
    const a = aabbsA[i];
    w.octreeAddFaceAABB(i, a.minX, a.minY, a.minZ, a.maxX, a.maxY, a.maxZ);
  }

  // Register body B faces as ids [nA..nA+nB)
  const nB = facesB.length;
  for (let i = 0; i < nB; i++) {
    const b = aabbsB[i];
    w.octreeAddFaceAABB(nA + i, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
  }

  w.octreeBuild();
  const numPairs = w.octreeQueryPairs(0, nA, nA, nA + nB);

  // Read pairs from WASM memory
  const pairsPtr = w.getOctreePairsPtr();
  const mem = new Uint32Array(_wasmMem.buffer, pairsPtr, numPairs * 2);
  const pairs = [];
  for (let i = 0; i < numPairs; i++) {
    const fA = mem[i * 2];
    const fB = mem[i * 2 + 1] - nA; // convert back to body B index
    if (fA < nA && fB >= 0 && fB < nB) {
      pairs.push([fA, fB]);
    }
  }

  return pairs;
}

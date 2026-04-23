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
  if (typeA !== SurfaceType.PLANE || typeB !== SurfaceType.PLANE) return null;
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

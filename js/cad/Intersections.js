// js/cad/Intersections.js — High-level intersection dispatch
//
// Provides a unified entry point for all intersection operations.
// Dispatches to specialized routines based on geometry types.
// Uses WASM octree broadphase when available to reduce candidate
// pairs from O(N×M) to O(N log N).

import { curveCurveIntersect } from './CurveCurveIntersect.js';
import { curveSurfaceIntersect } from './CurveSurfaceIntersect.js';
import { surfaceSurfaceIntersect } from './SurfaceSurfaceIntersect.js';
import { DEFAULT_TOLERANCE } from './Tolerance.js';
import { SurfaceType } from './BRepTopology.js';
import { GeometryEvaluator } from './GeometryEvaluator.js';

// Lazy WASM module reference (same singleton as StepImportWasm.js)
let _wasm = null;
let _wasmMem = null;
async function _ensureWasm() {
  if (_wasm) return true;
  try {
    const mod = await import('../../build/release.js');
    _wasm = mod;
    _wasmMem = mod.memory;
    return true;
  } catch { return false; }
}
// Synchronous check only
function _wasmReady() { return _wasm != null; }

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
  return surfaceSurfaceIntersect(surfA, typeA, surfB, typeB, tol);
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

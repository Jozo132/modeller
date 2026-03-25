// js/cad/WasmTessellation.js — JS↔WASM bridge for NURBS tessellation
//
// Provides WASM-accelerated versions of NURBS curve/surface evaluation
// and tessellation. Falls back to pure JS when WASM is not available.
//
// Data flow for tessellation:
//   1. JS passes input arrays (ctrl pts, knots, weights) via __lowerTypedArray
//   2. WASM writes results to internal output buffers
//   3. JS reads results from WASM memory via exported buffer pointers
//
// Usage:
//   import { wasmTessellation } from './WasmTessellation.js';
//   await wasmTessellation.init();  // Load WASM module (once)
//   const mesh = wasmTessellation.tessellateSurface(surface, segsU, segsV);

let wasmModule = null;
let wasmMemory = null;

/**
 * Load the WASM module. Safe to call multiple times (no-op after first load).
 * @returns {Promise<boolean>} true if WASM loaded successfully
 */
async function initWasm() {
  if (wasmModule) return true;
  try {
    // Dynamic import of the WASM module — works in both browser and Node.js
    const wasm = await import('../../build/release.js');
    wasmModule = wasm;
    wasmMemory = wasm.memory;
    return true;
  } catch (_e) {
    // WASM not available — fall back to JS
    return false;
  }
}

/**
 * Check if WASM is loaded and available.
 */
function isAvailable() {
  return wasmModule !== null;
}

// ─── Typed array helpers ─────────────────────────────────────────────

/**
 * Flatten a NurbsCurve's control points into a Float64Array [x,y,z, x,y,z, ...].
 */
function flattenControlPoints3D(controlPoints) {
  const n = controlPoints.length;
  const arr = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const cp = controlPoints[i];
    arr[i * 3] = cp.x;
    arr[i * 3 + 1] = cp.y;
    arr[i * 3 + 2] = cp.z;
  }
  return arr;
}

// ─── NURBS Curve Tessellation ────────────────────────────────────────

/**
 * Tessellate a NurbsCurve into a polyline using WASM.
 *
 * @param {import('./NurbsCurve.js').NurbsCurve} curve
 * @param {number} segments
 * @returns {Array<{x:number, y:number, z:number}>} Array of points
 */
function tessellateCurve(curve, segments = 32) {
  if (!wasmModule) return null;

  const ctrlFlat = flattenControlPoints3D(curve.controlPoints);
  const knotsArr = new Float64Array(curve.knots);
  const weightsArr = new Float64Array(curve.weights);

  const nPts = wasmModule.nurbsCurveTessellate(
    curve.degree,
    curve.controlPoints.length,
    ctrlFlat, knotsArr, weightsArr,
    segments
  );

  // Read results from WASM memory
  const ptr = wasmModule.getCurvePtsPtr();
  const outPts = new Float64Array(wasmMemory.buffer, ptr, nPts * 3);

  const points = [];
  for (let i = 0; i < nPts; i++) {
    const oi = i * 3;
    points.push({ x: outPts[oi], y: outPts[oi + 1], z: outPts[oi + 2] });
  }
  return points;
}

/**
 * Evaluate a single point on a NurbsCurve using WASM.
 *
 * @param {import('./NurbsCurve.js').NurbsCurve} curve
 * @param {number} t - Parameter value
 * @returns {{x:number, y:number, z:number}}
 */
function evaluateCurve(curve, t) {
  if (!wasmModule) return null;

  const ctrlFlat = flattenControlPoints3D(curve.controlPoints);
  const knotsArr = new Float64Array(curve.knots);
  const weightsArr = new Float64Array(curve.weights);

  wasmModule.nurbsCurveEvaluate(
    curve.degree,
    curve.controlPoints.length,
    ctrlFlat, knotsArr, weightsArr,
    t
  );

  // Read result from WASM memory via result pointer
  const ptr = wasmModule.getResultPtr();
  const resultView = new Float64Array(wasmMemory.buffer, ptr, 3);
  return { x: resultView[0], y: resultView[1], z: resultView[2] };
}

// ─── NURBS Surface Tessellation ──────────────────────────────────────

/**
 * Tessellate a NurbsSurface into a triangle mesh using WASM.
 *
 * @param {import('./NurbsSurface.js').NurbsSurface} surface
 * @param {number} segsU - Subdivisions in u-direction
 * @param {number} segsV - Subdivisions in v-direction
 * @returns {{ vertices: Array<{x,y,z}>, faces: Array<{vertices: Array<{x,y,z}>, normal: {x,y,z}}> }}
 */
function tessellateSurface(surface, segsU = 8, segsV = 8) {
  if (!wasmModule) return null;

  const ctrlFlat = flattenControlPoints3D(surface.controlPoints);
  const knotsU = new Float64Array(surface.knotsU);
  const knotsV = new Float64Array(surface.knotsV);
  const weights = new Float64Array(surface.weights);

  const nVertsTotal = (segsU + 1) * (segsV + 1);

  const triCount = wasmModule.nurbsSurfaceTessellate(
    surface.degreeU, surface.degreeV,
    surface.numRowsU, surface.numColsV,
    ctrlFlat, knotsU, knotsV, weights,
    segsU, segsV
  );

  // Read results from WASM memory via buffer pointers
  const vertsPtr = wasmModule.getTessVertsPtr();
  const normalsPtr = wasmModule.getTessNormalsPtr();
  const facesPtr = wasmModule.getTessFacesPtr();

  const outVerts = new Float64Array(wasmMemory.buffer, vertsPtr, nVertsTotal * 3);
  const outNormals = new Float64Array(wasmMemory.buffer, normalsPtr, nVertsTotal * 3);
  const outFaces = new Uint32Array(wasmMemory.buffer, facesPtr, triCount * 3);

  // Convert to the mesh format expected by the rendering pipeline
  const vertices = [];
  for (let i = 0; i < nVertsTotal; i++) {
    const vi = i * 3;
    vertices.push({ x: outVerts[vi], y: outVerts[vi + 1], z: outVerts[vi + 2] });
  }

  const faces = [];
  for (let t = 0; t < triCount; t++) {
    const fi = t * 3;
    const i0 = outFaces[fi], i1 = outFaces[fi + 1], i2 = outFaces[fi + 2];

    // Vertices for this triangle
    const v0 = { x: outVerts[i0 * 3], y: outVerts[i0 * 3 + 1], z: outVerts[i0 * 3 + 2] };
    const v1 = { x: outVerts[i1 * 3], y: outVerts[i1 * 3 + 1], z: outVerts[i1 * 3 + 2] };
    const v2 = { x: outVerts[i2 * 3], y: outVerts[i2 * 3 + 1], z: outVerts[i2 * 3 + 2] };

    // Average normal from per-vertex normals
    const n0x = outNormals[i0 * 3], n0y = outNormals[i0 * 3 + 1], n0z = outNormals[i0 * 3 + 2];
    const n1x = outNormals[i1 * 3], n1y = outNormals[i1 * 3 + 1], n1z = outNormals[i1 * 3 + 2];
    const n2x = outNormals[i2 * 3], n2y = outNormals[i2 * 3 + 1], n2z = outNormals[i2 * 3 + 2];
    const nx = n0x + n1x + n2x;
    const ny = n0y + n1y + n2y;
    const nz = n0z + n1z + n2z;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const normal = len < 1e-14
      ? { x: 0, y: 0, z: 1 }
      : { x: nx / len, y: ny / len, z: nz / len };

    faces.push({ vertices: [v0, v1, v2], normal });
  }

  return { vertices, faces };
}

/**
 * Evaluate a surface point + normal at (u, v) using WASM.
 *
 * @param {import('./NurbsSurface.js').NurbsSurface} surface
 * @param {number} u
 * @param {number} v
 * @returns {{ point: {x,y,z}, normal: {x,y,z} }}
 */
function evaluateSurfaceNormal(surface, u, v) {
  if (!wasmModule) return null;

  const ctrlFlat = flattenControlPoints3D(surface.controlPoints);
  const knotsU = new Float64Array(surface.knotsU);
  const knotsV = new Float64Array(surface.knotsV);
  const weights = new Float64Array(surface.weights);

  wasmModule.nurbsSurfaceNormal(
    surface.degreeU, surface.degreeV,
    surface.numRowsU, surface.numColsV,
    ctrlFlat, knotsU, knotsV, weights,
    u, v
  );

  const ptr = wasmModule.getResultPtr();
  const resultView = new Float64Array(wasmMemory.buffer, ptr, 6);
  return {
    point: { x: resultView[0], y: resultView[1], z: resultView[2] },
    normal: { x: resultView[3], y: resultView[4], z: resultView[5] },
  };
}

// ─── Public API ──────────────────────────────────────────────────────

export const wasmTessellation = {
  init: initWasm,
  isAvailable,
  tessellateCurve,
  evaluateCurve,
  tessellateSurface,
  evaluateSurfaceNormal,
};

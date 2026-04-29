// js/cad/StepTopologyWasm.js — native STEP→WASM topology builder bridge.
//
// Phase 1 of Stage F of the WASM STEP migration.  Runs the full native
// pipeline end-to-end:
//
//   1. Load STEP text into the WASM lexer input buffer.
//   2. stepLexRun() → token stream in WASM memory.
//   3. stepParseRun() → entity + arg tables in WASM memory.
//   4. stepBuildRun() → topology + geometry pools populated in WASM.
//
// After a successful call the WASM kernel state (vertexCount, edgeCount,
// faceCount, geomPoolUsed, …) contains a ready-to-tessellate body.  No
// JS TopoBody is allocated along the way.
//
// Feature coverage (Phase 1): PLANE, CYLINDRICAL_SURFACE, SPHERICAL_SURFACE,
// CONICAL_SURFACE, TOROIDAL_SURFACE + LINE edges (CIRCLE/ELLIPSE
// treated as GEOM_LINE — the kernel tessellator samples curves from the
// face's analytic surface anyway).  B-spline curves / surfaces return
// STEP_BUILD_ERR_UNSUPPORTED_SURFACE → caller should fall back to the
// JS pipeline.
//
// Any face that uses an unsupported surface/curve type is *silently
// skipped* (not a hard error), incrementing stepBuildGetSkippedFaceCount.
// A non-zero skipped count is a reliable signal to fall back for that
// file; currently the bridge also returns `{ ok: false }` when the
// skipped ratio exceeds a threshold.

import { globalTessConfig } from './TessellationConfig.js';

let _wasm = null;
let _wasmLoadPromise = null;
let _wasmInitialised = false;

async function _loadWasm() {
  if (_wasm) return _wasm;
  if (_wasmLoadPromise) return _wasmLoadPromise;
  _wasmLoadPromise = (async () => {
    const mod = await import('../../build/release.js');
    _wasm = mod;
    // One-time init: clears the 4M-entry idLookup / vertexCache / edgeCache
    // arrays to ID_NONE (0xFFFFFFFF).  Subsequent calls only reset the
    // step-ids present in the current parse output.
    if (!_wasmInitialised && typeof mod.stepBuildInit === 'function') {
      mod.stepBuildInit();
      _wasmInitialised = true;
    }
    return mod;
  })();
  return _wasmLoadPromise;
}

export async function ensureStepTopologyReady() { return _loadWasm(); }
export function stepTopologyReadySync() { return _wasm != null && _wasmInitialised; }

/**
 * Build WASM topology + geometry pools from a STEP source string.
 *
 * @param {string} stepText
 * @param {{ maxSkippedFaces?: number }} [opts]
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   errorCode?: number,
 *   skippedFaceCount?: number,
 *   vertexCount?: number,
 *   edgeCount?: number,
 *   coedgeCount?: number,
 *   loopCount?: number,
 *   faceCount?: number,
 *   shellCount?: number,
 *   geomPoolUsed?: number,
 * }}
 */
export function buildStepTopologySync(stepText, opts = {}) {
  if (!_wasm || !_wasmInitialised) {
    return { ok: false, reason: 'wasm-not-ready' };
  }
  const w = _wasm;
  const mem = w.memory;

  // 1. Write STEP text into the lexer input buffer.
  const bytes = new TextEncoder().encode(stepText);
  const inputPtr = w.stepLexGetInputPtr();
  const inputCap = w.stepLexGetInputCapacity();
  if (bytes.length > inputCap) {
    return { ok: false, reason: 'input-too-large', inputSize: bytes.length, inputCap };
  }
  new Uint8Array(mem.buffer, inputPtr, bytes.length).set(bytes);

  // 2. Lex.
  const lexRc = w.stepLexRun(bytes.length);
  if (lexRc !== 0) {
    return { ok: false, reason: 'lex-error', errorCode: lexRc, errorOffset: w.stepLexGetErrorOffset() };
  }

  // 3. Parse.
  const parseRc = w.stepParseRun();
  if (parseRc !== 0) {
    return { ok: false, reason: 'parse-error', errorCode: parseRc, errorTokenIdx: w.stepParseGetErrorTokenIdx() };
  }

  // 4. Build topology.
  const buildRc = w.stepBuildRun();
  const skipped = w.stepBuildGetSkippedFaceCount() >>> 0;

  if (buildRc !== 0) {
    return {
      ok: false,
      reason: 'build-error',
      errorCode: buildRc,
      errorStepId: w.stepBuildGetLastErrorStepId() >>> 0,
      skippedFaceCount: skipped,
    };
  }

  const vertexCount = w.vertexGetCount() >>> 0;
  const edgeCount = w.edgeGetCount() >>> 0;
  const coedgeCount = w.coedgeGetCount() >>> 0;
  const loopCount = w.loopGetCount() >>> 0;
  const faceCount = w.faceGetCount() >>> 0;
  const shellCount = w.shellGetCount() >>> 0;
  const geomPoolUsed = w.geomPoolUsed() >>> 0;

  // Fallback policy: if more than maxSkippedFaces (default: half of face
  // count, minimum 1) were skipped, the build is partial — signal failure
  // so the caller retries via the JS pipeline.
  const maxSkipped = opts.maxSkippedFaces != null
    ? opts.maxSkippedFaces
    : Math.max(1, Math.floor(faceCount / 2));
  if (skipped > maxSkipped) {
    return {
      ok: false,
      reason: 'too-many-skipped-faces',
      skippedFaceCount: skipped,
      faceCount,
    };
  }

  return {
    ok: true,
    skippedFaceCount: skipped,
    vertexCount, edgeCount, coedgeCount, loopCount,
    faceCount, shellCount, geomPoolUsed,
  };
}

/**
 * End-to-end native STEP → tessellated mesh pipeline.  Builds topology
 * in WASM (no JS TopoBody allocation) and then runs the kernel's native
 * tessellator, returning a {vertices, faces} mesh in the exact shape
 * produced by `tessellateBodyWasm` — so callers can substitute this for
 * the legacy path without any downstream adjustments.
 *
 * @param {string} stepText
 * @param {{
 *   edgeSegments?: number,
 *   surfaceSegments?: number,
 *   maxSkippedFaces?: number,
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   errorCode?: number,
 *   skippedFaceCount?: number,
 *   faceCount?: number,
 *   vertices?: {x:number, y:number, z:number}[],
 *   faces?: {vertices:{x:number,y:number,z:number}[], normal:{x:number,y:number,z:number}, faceGroup:number}[],
 *   timings?: { buildMs:number, tessMs:number },
 * }}
 */
export function importStepNativeSync(stepText, opts = {}) {
  const _now = typeof performance !== 'undefined' && performance.now
    ? () => performance.now() : () => Date.now();
  const tBuild = _now();
  const built = buildStepTopologySync(stepText, opts);
  const buildMs = _now() - tBuild;
  if (!built.ok) return { ...built, timings: { buildMs, tessMs: 0 } };

  const w = _wasm;
  const edgeSegs = opts.edgeSegments ?? globalTessConfig.edgeSegments;
  const surfSegs = opts.surfaceSegments ?? globalTessConfig.surfaceSegments;
  const tTess = _now();
  const triCount = w.tessBuildAllFaces(edgeSegs, surfSegs);
  const tessMs = _now() - tTess;
  if (triCount < 0) {
    return {
      ok: false,
      reason: 'tess-overflow',
      skippedFaceCount: built.skippedFaceCount,
      faceCount: built.faceCount,
      timings: { buildMs, tessMs },
    };
  }

  // Decode the kernel's tessellation output (shared layout used by
  // tessellateBodyWasm's mesh assembler).
  const mem = w.memory;
  const vertCount = w.getTessOutVertCount() >>> 0;
  const vertPtr = w.getTessOutVertsPtr();
  const normPtr = w.getTessOutNormalsPtr();
  const idxPtr = w.getTessOutIndicesPtr();
  const faceMapPtr = w.getTessOutFaceMapPtr();

  const vertsF64 = new Float64Array(mem.buffer, vertPtr, vertCount * 3);
  const normsF64 = new Float64Array(mem.buffer, normPtr, vertCount * 3);
  const idxU32 = new Uint32Array(mem.buffer, idxPtr, triCount * 3);
  const faceMapU32 = new Uint32Array(mem.buffer, faceMapPtr, triCount);

  // Snapshot per-face geom type so isCurved can be emitted (matches the
  // tessellateBodyWasm() shape expected by importSTEP consumers).
  const faceGeomTypes = new Uint8Array(built.faceCount);
  const GEOM_PLANE = w.GEOM_PLANE | 0;
  for (let i = 0; i < built.faceCount; i++) {
    faceGeomTypes[i] = w.faceGetGeomType(i >>> 0) & 0xff;
  }

  const snapCoord = (value) => Math.abs(value) < 5e-12 ? 0 : value;
  const triangleNormal = (a, b, c) => {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len; ny /= len; nz /= len;
    return { x: nx, y: ny, z: nz };
  };

  const vertices = new Array(vertCount);
  for (let i = 0; i < vertCount; i++) {
    const b = i * 3;
    vertices[i] = {
      x: snapCoord(vertsF64[b]),
      y: snapCoord(vertsF64[b + 1]),
      z: snapCoord(vertsF64[b + 2]),
    };
  }

  const faces = new Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const b = t * 3;
    const a = idxU32[b], bb = idxU32[b + 1], c = idxU32[b + 2];
    // Averaged per-vertex normal (parity with tessellateBodyWasm).
    let nx = normsF64[a * 3]     + normsF64[bb * 3]     + normsF64[c * 3];
    let ny = normsF64[a * 3 + 1] + normsF64[bb * 3 + 1] + normsF64[c * 3 + 1];
    let nz = normsF64[a * 3 + 2] + normsF64[bb * 3 + 2] + normsF64[c * 3 + 2];
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    let v0 = vertices[a], v1 = vertices[bb], v2 = vertices[c];
    const gn = triangleNormal(v0, v1, v2);
    if (gn.x * nx + gn.y * ny + gn.z * nz < 0) {
      const tmp = v1;
      v1 = v2;
      v2 = tmp;
    }
    const fg = faceMapU32[t] | 0;
    faces[t] = {
      vertices: [v0, v1, v2],
      normal: { x: nx, y: ny, z: nz },
      faceGroup: fg,
      isCurved: fg < faceGeomTypes.length ? (faceGeomTypes[fg] !== GEOM_PLANE) : false,
      surfaceInfo: null,
      shared: null,
    };
  }

  // Edge diagnostic totals (optional).
  const edgeSampleCount = typeof w.getEdgeSampleCount === 'function'
    ? (w.getEdgeSampleCount() >>> 0) : 0;

  return {
    ok: true,
    skippedFaceCount: built.skippedFaceCount,
    faceCount: built.faceCount,
    vertexCount: built.vertexCount,
    edgeCount: built.edgeCount,
    vertices,
    faces,
    edgeSampleCount,
    timings: { buildMs, tessMs, edgeSegments: edgeSegs, surfaceSegments: surfSegs },
  };
}

/**
 * Convenience helper: await ensureStepTopologyReady() then call
 * importStepNativeSync().  Use from async call sites (UI handlers, tests).
 */
export async function importStepNative(stepText, opts = {}) {
  await ensureStepTopologyReady();
  return importStepNativeSync(stepText, opts);
}

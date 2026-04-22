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

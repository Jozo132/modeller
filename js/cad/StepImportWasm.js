// js/cad/StepImportWasm.js — WASM-accelerated STEP tessellation bridge
//
// Loads a parsed TopoBody (JS B-Rep) into the WASM kernel topology and
// geometry buffers, tessellates natively, and converts the output back to
// the {vertices, faces} mesh format expected by the rest of the app.
//
// The JS STEP parser (parseSTEPTopology) is kept — string parsing is fast.
// Only the tessellation step is replaced with the WASM kernel path which
// is 10-50× faster than the JS Tessellator2 for large models.
//
// Self-contained: lazy-loads the WASM module directly — no registry needed.

import { loadBodyIntoWasm } from './wasm/TopoSerializer.js';
import { globalTessConfig } from './TessellationConfig.js';

// ── Lazy WASM module singleton ──────────────────────────────────────
let _wasm = null;
let _wasmMem = null;
let _initPromise = null;

/**
 * Ensure the WASM module is loaded. Safe to call multiple times.
 * @returns {Promise<boolean>} true if WASM is available
 */
async function _ensureWasm() {
    if (_wasm) return true;
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        try {
            const mod = await import('../../build/release.js');
            _wasm = mod;
            _wasmMem = mod.memory;
            return true;
        } catch {
            return false;
        }
    })();
    return _initPromise;
}

/**
 * Synchronous check — only works after ensureWasmReady() resolved.
 */
function _wasmReady() { return _wasm != null; }

/**
 * Pre-load the WASM module. Call this early (e.g. at app startup) so that
 * tessellateBodyWasm() can work synchronously when called later.
 */
export async function ensureWasmReady() { return _ensureWasm(); }

/**
 * Load a JS TopoBody into WASM kernel topology+geometry buffers and
 * tessellate it using the native WASM tessellator.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @param {number} [opts.edgeSegments=64]
 * @param {number} [opts.surfaceSegments=16]
 * @returns {{ vertices: {x:number,y:number,z:number}[], faces: {vertices:{x:number,y:number,z:number}[], normal:{x:number,y:number,z:number}, faceGroup:number, isCurved:boolean, surfaceInfo:Object|null, shared:Object|null}[] } | null}
 */
export function tessellateBodyWasm(body, opts = {}) {
    const w = _wasm;
    if (!w) return null;

    const wasmMem = _wasmMem;

    const edgeSegments = opts.edgeSegments ?? globalTessConfig.edgeSegments;
    const surfaceSegments = opts.surfaceSegments ?? globalTessConfig.surfaceSegments;

    // ── 1. Reset WASM kernel state ──────────────────────────────────
    w.bodyBegin();
    w.geomPoolReset();

    // ── 2-4. Serialize vertices / edges / coedges / loops / faces / shell
    //        via the shared JS→WASM serializer (H11 scaffold). The
    //        serializer auto-detects the kernel's NURBS staging exports
    //        and handles both analytic surfaces and B-spline curves+surfaces.
    const { faceCount: wasmFaceCount, faceInfos: serializerFaceInfos } = loadBodyIntoWasm(body, w, {
      memory: wasmMem,
      nurbs: true,
    });

    if (wasmFaceCount === 0) return null;

    // ── 5. Finalise body ────────────────────────────────────────────
    w.bodyEnd();

    const faceInfos = serializerFaceInfos.map((fi) => ({
        topoFace: fi.face,
        surfaceInfo: fi.surfaceInfo,
        isCurved: fi.isCurved,
    }));
    const wasmFaceId = wasmFaceCount;

    // ── 6. Tessellate ───────────────────────────────────────────────
    const nTris = w.tessBuildAllFaces(edgeSegments, surfaceSegments);
    if (nTris < 0) return null;
    if (nTris === 0) return { vertices: [], faces: [] };

    const nVerts = w.getTessOutVertCount() >>> 0;
    const buf = wasmMem.buffer;
    const vertsPtr = w.getTessOutVertsPtr() >>> 0;
    const normsPtr = w.getTessOutNormalsPtr() >>> 0;
    const idxPtr = w.getTessOutIndicesPtr() >>> 0;
    const fmapPtr = w.getTessOutFaceMapPtr() >>> 0;

    // Read output buffers (copy — WASM memory may be detached on next call)
    const verts = new Float64Array(buf, vertsPtr, nVerts * 3).slice();
    const norms = new Float64Array(buf, normsPtr, nVerts * 3).slice();
    const indices = new Uint32Array(buf, idxPtr, nTris * 3).slice();
    const faceMap = new Uint32Array(buf, fmapPtr, nTris).slice();

    // ── 7. Convert to {vertices, faces} format ──────────────────────
    const outVertices = [];
    for (let i = 0; i < nVerts; i++) {
        outVertices.push({
            x: verts[i * 3],
            y: verts[i * 3 + 1],
            z: verts[i * 3 + 2],
        });
    }

    // Group triangles by source face
    const faceTriGroups = new Map();
    for (let t = 0; t < nTris; t++) {
        const fi = faceMap[t];
        if (!faceTriGroups.has(fi)) faceTriGroups.set(fi, []);
        faceTriGroups.get(fi).push(t);
    }

    const outFaces = [];
    for (const [fi, tris] of faceTriGroups) {
        const info = faceInfos[fi] || {};
        for (const t of tris) {
            const i0 = indices[t * 3];
            const i1 = indices[t * 3 + 1];
            const i2 = indices[t * 3 + 2];

            // Use per-vertex normals averaged for the triangle face normal
            const nx = (norms[i0 * 3] + norms[i1 * 3] + norms[i2 * 3]) / 3;
            const ny = (norms[i0 * 3 + 1] + norms[i1 * 3 + 1] + norms[i2 * 3 + 1]) / 3;
            const nz = (norms[i0 * 3 + 2] + norms[i1 * 3 + 2] + norms[i2 * 3 + 2]) / 3;
            const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

            outFaces.push({
                vertices: [
                    { x: verts[i0 * 3], y: verts[i0 * 3 + 1], z: verts[i0 * 3 + 2] },
                    { x: verts[i1 * 3], y: verts[i1 * 3 + 1], z: verts[i1 * 3 + 2] },
                    { x: verts[i2 * 3], y: verts[i2 * 3 + 1], z: verts[i2 * 3 + 2] },
                ],
                normal: { x: nx / nl, y: ny / nl, z: nz / nl },
                faceGroup: fi,
                topoFaceId: info.topoFace?.id ?? fi,
                isCurved: info.isCurved || false,
                surfaceInfo: info.surfaceInfo,
                shared: null,
            });
        }
    }

    return { vertices: outVertices, faces: outFaces };
}

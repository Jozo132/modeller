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

function cleanComponent(value) {
    return Math.abs(value) < 1e-12 ? 0 : value;
}

function readVector(buffer, index) {
    const offset = index * 3;
    return {
        x: cleanComponent(buffer[offset]),
        y: cleanComponent(buffer[offset + 1]),
        z: cleanComponent(buffer[offset + 2]),
    };
}

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

    let wasmValidation = null;
    if (typeof w.tessValidateOutput === 'function') {
        w.tessValidateOutput();
        wasmValidation = {
            boundaryEdges: typeof w.getTessValidationBoundaryEdges === 'function' ? w.getTessValidationBoundaryEdges() >>> 0 : 0,
            nonManifoldEdges: typeof w.getTessValidationNonManifoldEdges === 'function' ? w.getTessValidationNonManifoldEdges() >>> 0 : 0,
            degenerateTris: typeof w.getTessValidationDegenerateTris === 'function' ? w.getTessValidationDegenerateTris() >>> 0 : 0,
            missingFaces: typeof w.getTessValidationMissingFaces === 'function' ? w.getTessValidationMissingFaces() >>> 0 : 0,
            faceCount: typeof w.getTessValidationFaceCount === 'function' ? w.getTessValidationFaceCount() >>> 0 : wasmFaceCount,
            coordinateHash: true,
        };
    }

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
        outVertices.push(readVector(verts, i));
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
                    readVector(verts, i0),
                    readVector(verts, i1),
                    readVector(verts, i2),
                ],
                normal: { x: cleanComponent(nx / nl), y: cleanComponent(ny / nl), z: cleanComponent(nz / nl) },
                vertexNormals: [
                    readVector(norms, i0),
                    readVector(norms, i1),
                    readVector(norms, i2),
                ],
                faceGroup: fi,
                topoFaceId: info.topoFace?.id ?? fi,
                faceType: info.isCurved ? `curved-${info.topoFace?.surfaceType || 'surface'}` : 'planar',
                isCurved: info.isCurved || false,
                surfaceInfo: info.surfaceInfo,
                shared: info.topoFace?.shared ? { ...info.topoFace.shared } : null,
            });
        }
    }

    _repairTriangleWinding(outFaces);

    const result = { vertices: outVertices, faces: outFaces };
    if (wasmValidation) result._wasmValidation = wasmValidation;
    return result;
}

function _repairTriangleWinding(faces) {
    const edgeMap = new Map();
    faces.forEach((face, faceIndex) => {
        const verts = face.vertices || [];
        for (let i = 0; i < verts.length; i++) {
            const a = verts[i];
            const b = verts[(i + 1) % verts.length];
            const ka = _windingVertexKey(a);
            const kb = _windingVertexKey(b);
            const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
            const fwd = ka < kb;
            const entry = { faceIndex, fwd };
            if (!edgeMap.has(key)) edgeMap.set(key, []);
            edgeMap.get(key).push(entry);
        }
    });

    const adjacency = Array.from({ length: faces.length }, () => []);
    for (const entries of edgeMap.values()) {
        if (entries.length !== 2) continue;
        const a = entries[0];
        const b = entries[1];
        adjacency[a.faceIndex].push({ to: b.faceIndex, fromFwd: a.fwd, toFwd: b.fwd });
        adjacency[b.faceIndex].push({ to: a.faceIndex, fromFwd: b.fwd, toFwd: a.fwd });
    }

    const assigned = new Array(faces.length).fill(false);
    const flip = new Array(faces.length).fill(false);
    for (let start = 0; start < faces.length; start++) {
        if (assigned[start]) continue;
        assigned[start] = true;
        const queue = [start];
        for (let qi = 0; qi < queue.length; qi++) {
            const current = queue[qi];
            for (const edge of adjacency[current]) {
                const wanted = (!(edge.fromFwd !== flip[current])) !== edge.toFwd;
                if (!assigned[edge.to]) {
                    assigned[edge.to] = true;
                    flip[edge.to] = wanted;
                    queue.push(edge.to);
                }
            }
        }
    }

    for (let i = 0; i < faces.length; i++) {
        if (!flip[i]) continue;
        const face = faces[i];
        if (face.vertices?.length === 3) {
            [face.vertices[1], face.vertices[2]] = [face.vertices[2], face.vertices[1]];
        }
        if (face.vertexNormals?.length === 3) {
            [face.vertexNormals[1], face.vertexNormals[2]] = [face.vertexNormals[2], face.vertexNormals[1]];
        }
        if (face.normal) {
            face.normal = { x: -face.normal.x, y: -face.normal.y, z: -face.normal.z };
        }
    }
}

function _windingVertexKey(v) {
    const fmt = (value) => (+value.toFixed(6) || 0).toFixed(6);
    return `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`;
}

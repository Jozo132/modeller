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

import { SurfaceType } from './BRepTopology.js';
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

    // ── 2. Load vertices ────────────────────────────────────────────
    // Build a map: TopoVertex → WASM vertex id
    const allFaces = body.faces();
    const vertexMap = new Map();  // TopoVertex instance → wasm vertex id

    // Collect all unique vertices first
    for (const face of allFaces) {
        for (const loop of [face.outerLoop, ...(face.innerLoops || [])]) {
            if (!loop) continue;
            for (const ce of loop.coedges || []) {
                const edge = ce.edge;
                if (edge) {
                    if (edge.startVertex && !vertexMap.has(edge.startVertex)) {
                        const v = edge.startVertex.point || edge.startVertex;
                        const id = w.vertexAdd(v.x, v.y, v.z);
                        vertexMap.set(edge.startVertex, id);
                    }
                    if (edge.endVertex && !vertexMap.has(edge.endVertex)) {
                        const v = edge.endVertex.point || edge.endVertex;
                        const id = w.vertexAdd(v.x, v.y, v.z);
                        vertexMap.set(edge.endVertex, id);
                    }
                }
            }
        }
    }

    // ── 3. Load edges ───────────────────────────────────────────────
    const edgeMap = new Map();  // TopoEdge instance → wasm edge id

    for (const face of allFaces) {
        for (const loop of [face.outerLoop, ...(face.innerLoops || [])]) {
            if (!loop) continue;
            for (const ce of loop.coedges || []) {
                const edge = ce.edge;
                if (!edge || edgeMap.has(edge)) continue;

                const sv = vertexMap.get(edge.startVertex) ?? 0;
                const ev = vertexMap.get(edge.endVertex) ?? 0;

                // Store edge curve geometry if available
                let geomType = w.GEOM_LINE;
                let geomOffset = 0;

                if (edge.curve) {
                    const curve = edge.curve;
                    if (curve.degree !== undefined && curve.controlPoints && curve.knots) {
                        // NURBS curve → store via staging buffer
                        const nCtrl = curve.controlPoints.length;
                        const nKnots = curve.knots.length;
                        const stagingPtr = w.geomStagingPtr() >>> 0;
                        const stagingView = new Float64Array(wasmMem.buffer, stagingPtr,
                            nKnots + nCtrl * 3 + nCtrl);
                        let si = 0;
                        for (let i = 0; i < nKnots; i++) stagingView[si++] = curve.knots[i];
                        for (let i = 0; i < nCtrl; i++) {
                            const cp = curve.controlPoints[i];
                            stagingView[si++] = cp.x;
                            stagingView[si++] = cp.y;
                            stagingView[si++] = cp.z;
                        }
                        for (let i = 0; i < nCtrl; i++) {
                            stagingView[si++] = curve.weights ? curve.weights[i] : 1.0;
                        }
                        geomOffset = w.nurbsCurveStoreFromStaging(curve.degree, nCtrl, nKnots);
                        geomType = w.GEOM_NURBS_CURVE;
                    }
                }

                const eid = w.edgeAdd(sv, ev, geomType, geomOffset);
                edgeMap.set(edge, eid);
            }
        }
    }

    // ── 4. Load faces with geometry ─────────────────────────────────
    let wasmFaceId = 0;
    const faceInfos = [];  // parallel to wasm face ids: { topoFace, surfaceInfo }

    for (const face of allFaces) {
        const loops = [face.outerLoop, ...(face.innerLoops || [])].filter(Boolean);
        if (loops.length === 0) continue;

        // Determine geometry type and store surface definition
        const geom = _storeGeometry(w, wasmMem, face);
        const orient = face.sameSense ? w.ORIENT_FORWARD : w.ORIENT_REVERSED;

        // Build coedge loops
        let firstLoopId = -1;
        let numLoops = 0;

        for (let li = 0; li < loops.length; li++) {
            const loop = loops[li];
            const coedges = loop.coedges || [];
            if (coedges.length === 0) continue;

            const isOuter = li === 0 ? 1 : 0;
            const ceIds = [];

            for (const ce of coedges) {
                const eid = edgeMap.get(ce.edge) ?? 0;
                const ceOrient = ce.sameSense ? w.ORIENT_FORWARD : w.ORIENT_REVERSED;
                const ceId = w.coedgeAdd(eid, ceOrient, 0, wasmFaceId);
                ceIds.push(ceId);
            }

            // Link coedges in a cycle
            for (let i = 0; i < ceIds.length; i++) {
                w.coedgeSetNext(ceIds[i], ceIds[(i + 1) % ceIds.length]);
            }

            const loopId = w.loopAdd(ceIds[0], wasmFaceId, isOuter);
            if (firstLoopId < 0) firstLoopId = loopId;
            numLoops++;
        }

        if (firstLoopId < 0) continue;

        w.faceAdd(firstLoopId, 0, geom.type, geom.offset, orient, numLoops);
        faceInfos.push({
            topoFace: face,
            surfaceInfo: face.surfaceInfo || null,
            isCurved: geom.type !== w.GEOM_PLANE,
        });
        wasmFaceId++;
    }

    if (wasmFaceId === 0) return null;

    // ── 5. Finalise body and add shell ──────────────────────────────
    w.shellAdd(0, wasmFaceId, 1);
    w.bodyEnd();

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
                isCurved: info.isCurved || false,
                surfaceInfo: info.surfaceInfo,
                shared: null,
            });
        }
    }

    return { vertices: outVertices, faces: outFaces };
}

// ─── Geometry storage helpers ────────────────────────────────────────

/**
 * Store the face surface geometry into the WASM geometry pool.
 * Returns { type: GEOM_*, offset: u32 }.
 */
function _storeGeometry(w, wasmMem, face) {
    const st = face.surfaceType;
    const si = face.surfaceInfo;

    if (st === SurfaceType.PLANE && si) {
        const o = si.origin || { x: 0, y: 0, z: 0 };
        const n = si.normal || { x: 0, y: 0, z: 1 };
        // Compute a reference direction perpendicular to the normal
        const rx = Math.abs(n.x) < 0.9 ? 1 : 0;
        const ry = Math.abs(n.x) < 0.9 ? 0 : 1;
        const rz = 0;
        // Cross product: n × arbitrary → refDir
        const cx = n.y * rz - n.z * ry;
        const cy = n.z * rx - n.x * rz;
        const cz = n.x * ry - n.y * rx;
        const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
        const offset = w.planeStore(
            o.x, o.y, o.z,
            n.x, n.y, n.z,
            cx / cl, cy / cl, cz / cl,
        );
        return { type: w.GEOM_PLANE, offset };
    }

    if (st === SurfaceType.CYLINDER && si) {
        const o = si.origin || { x: 0, y: 0, z: 0 };
        const a = si.axis || { x: 0, y: 0, z: 1 };
        const x = si.xDir || _perpendicular(a);
        const offset = w.cylinderStore(
            o.x, o.y, o.z,
            a.x, a.y, a.z,
            x.x, x.y, x.z,
            si.radius || 1,
        );
        return { type: w.GEOM_CYLINDER, offset };
    }

    if (st === SurfaceType.SPHERE && si) {
        const o = si.origin || { x: 0, y: 0, z: 0 };
        const a = si.axis || { x: 0, y: 0, z: 1 };
        const x = si.xDir || _perpendicular(a);
        const offset = w.sphereStore(
            o.x, o.y, o.z,
            a.x, a.y, a.z,
            x.x, x.y, x.z,
            si.radius || 1,
        );
        return { type: w.GEOM_SPHERE, offset };
    }

    if (st === SurfaceType.CONE && si) {
        const o = si.origin || { x: 0, y: 0, z: 0 };
        const a = si.axis || { x: 0, y: 0, z: 1 };
        const x = si.xDir || _perpendicular(a);
        const offset = w.coneStore(
            o.x, o.y, o.z,
            a.x, a.y, a.z,
            x.x, x.y, x.z,
            si.radius || 0, si.semiAngle || 0,
        );
        return { type: w.GEOM_CONE, offset };
    }

    if (st === SurfaceType.TORUS && si) {
        const o = si.origin || { x: 0, y: 0, z: 0 };
        const a = si.axis || { x: 0, y: 0, z: 1 };
        const x = si.xDir || _perpendicular(a);
        const offset = w.torusStore(
            o.x, o.y, o.z,
            a.x, a.y, a.z,
            x.x, x.y, x.z,
            si.majorR || 1, si.minorR || 0.25,
        );
        return { type: w.GEOM_TORUS, offset };
    }

    // NURBS B-spline surface
    if ((st === SurfaceType.BSPLINE || st === SurfaceType.EXTRUSION ||
         st === SurfaceType.REVOLUTION || st === SurfaceType.UNKNOWN) && face.surface) {
        const s = face.surface;
        if (s.degreeU !== undefined && s.controlPoints && s.knotsU && s.knotsV) {
            const numU = s.numRowsU;
            const numV = s.numColsV;
            const nCtrl = numU * numV;
            const nKnotsU = s.knotsU.length;
            const nKnotsV = s.knotsV.length;
            const stagingPtr = w.geomStagingPtr() >>> 0;
            const stagingView = new Float64Array(wasmMem.buffer, stagingPtr,
                nKnotsU + nKnotsV + nCtrl * 3 + nCtrl);
            let si = 0;
            for (let i = 0; i < nKnotsU; i++) stagingView[si++] = s.knotsU[i];
            for (let i = 0; i < nKnotsV; i++) stagingView[si++] = s.knotsV[i];
            for (let i = 0; i < nCtrl; i++) {
                const cp = s.controlPoints[i];
                stagingView[si++] = cp.x;
                stagingView[si++] = cp.y;
                stagingView[si++] = cp.z;
            }
            for (let i = 0; i < nCtrl; i++) {
                stagingView[si++] = s.weights ? s.weights[i] : 1.0;
            }
            const offset = w.nurbsSurfaceStoreFromStaging(
                s.degreeU, s.degreeV, numU, numV, nKnotsU, nKnotsV,
            );
            return { type: w.GEOM_NURBS_SURFACE, offset };
        }
    }

    // Fallback: plane from face boundary centroid
    // Compute centroid and normal from the first loop's vertices
    const loop = face.outerLoop;
    if (loop && loop.coedges && loop.coedges.length >= 3) {
        const pts = [];
        for (const ce of loop.coedges) {
            const v = ce.edge?.startVertex?.point || ce.edge?.startVertex;
            if (v) pts.push(v);
        }
        if (pts.length >= 3) {
            const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
            const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
            const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
            // Normal from first triangle
            const a = pts[0], b = pts[1], c = pts[2];
            const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
            const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
            let nx = e1y * e2z - e1z * e2y;
            let ny = e1z * e2x - e1x * e2z;
            let nz = e1x * e2y - e1y * e2x;
            const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            nx /= nl; ny /= nl; nz /= nl;
            const rx = Math.abs(nx) < 0.9 ? 1 : 0;
            const ry = Math.abs(nx) < 0.9 ? 0 : 1;
            const dx = ny * 0 - nz * ry;
            const dy = nz * rx - nx * 0;
            const dz = nx * ry - ny * rx;
            const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            const offset = w.planeStore(cx, cy, cz, nx, ny, nz, dx / dl, dy / dl, dz / dl);
            return { type: w.GEOM_PLANE, offset };
        }
    }

    // Last resort: degenerate plane at origin
    const offset = w.planeStore(0, 0, 0, 0, 0, 1, 1, 0, 0);
    return { type: w.GEOM_PLANE, offset };
}

/** Compute a vector perpendicular to the given direction. */
function _perpendicular(d) {
    const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
    let rx, ry, rz;
    if (ax <= ay && ax <= az) {
        rx = 0; ry = -d.z; rz = d.y;
    } else if (ay <= az) {
        rx = -d.z; ry = 0; rz = d.x;
    } else {
        rx = -d.y; ry = d.x; rz = 0;
    }
    const len = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    return { x: rx / len, y: ry / len, z: rz / len };
}

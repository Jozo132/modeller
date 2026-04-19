// @ts-nocheck
/**
 * WasmBrepHandleRegistry — JS-side bridge for the WASM B-Rep kernel handle system.
 *
 * Wraps the WASM handle registry (assembly/kernel/core.ts) and provides:
 *  - Handle allocation / release with ref counting
 *  - Residency state tracking (unmaterialized → hydrating → resident → stale → disposed)
 *  - Revision tracking for incremental rebuild
 *  - CBREP dehydration / hydration via the interop module
 *  - Zero-copy pointer access to topology and geometry buffers
 *
 * Usage:
 *   const registry = new WasmBrepHandleRegistry();
 *   await registry.init();
 *   const h = registry.alloc();
 *   registry.setResidency(h, registry.RESIDENT);
 *   registry.bumpRevision(h);
 *   ...
 *   registry.release(h);
 */

/** @type {any} */
let _wasm = null;
/** @type {WebAssembly.Memory} */
let _wasmMem = null;

// Residency state constants (mirrored from assembly/kernel/core.ts)
const RESIDENCY = Object.freeze({
    UNMATERIALIZED: 0,
    HYDRATING: 1,
    RESIDENT: 2,
    STALE: 3,
    DISPOSED: 4,
});

export class WasmBrepHandleRegistry {

    /** Residency state enum */
    static RESIDENCY = RESIDENCY;
    UNMATERIALIZED = RESIDENCY.UNMATERIALIZED;
    HYDRATING = RESIDENCY.HYDRATING;
    RESIDENT = RESIDENCY.RESIDENT;
    STALE = RESIDENCY.STALE;
    DISPOSED = RESIDENCY.DISPOSED;

    /** Whether init() has been called successfully */
    #ready = false;

    // ────────────────────── init ──────────────────────

    /**
     * Lazy-load the WASM module.
     * Safe to call multiple times — subsequent calls are no-ops.
     */
    async init() {
        if (this.#ready) return;
        try {
            const mod = await import('../../build/release.js');
            _wasm = mod;
            _wasmMem = mod.memory;
            this.#ready = true;
        } catch (e) {
            console.error('[WasmBrepHandleRegistry] WASM init failed:', e);
            throw e;
        }
    }

    /** @returns {boolean} */
    get ready() { return this.#ready; }

    // ────────────────────── handle lifecycle ──────────────────────

    /**
     * Allocate a new handle. Returns 0 (HANDLE_NONE) if the pool is exhausted.
     * @returns {number}
     */
    alloc() {
        return _wasm.handleAlloc();
    }

    /**
     * Release a handle (decrement ref count; dispose when it reaches 0).
     * @param {number} handle
     */
    release(handle) {
        _wasm.handleRelease(handle);
    }

    /**
     * Add a reference to an existing handle.
     * @param {number} handle
     */
    addRef(handle) {
        _wasm.handleAddRef(handle);
    }

    /**
     * @param {number} handle
     * @returns {boolean}
     */
    isValid(handle) {
        return _wasm.handleIsValid(handle) !== 0;
    }

    /**
     * @param {number} handle
     * @returns {number} current ref count
     */
    getRefCount(handle) {
        return _wasm.handleGetRefCount(handle);
    }

    /**
     * Release all handles at once (hard reset).
     */
    releaseAll() {
        _wasm.handleReleaseAll();
    }

    /** @returns {number} */
    liveCount() {
        return _wasm.handleLiveCount();
    }

    // ────────────────────── residency ──────────────────────

    /**
     * @param {number} handle
     * @returns {number} residency state (0-4)
     */
    getResidency(handle) {
        return _wasm.handleGetResidency(handle);
    }

    /**
     * @param {number} handle
     * @param {number} state  one of RESIDENCY.*
     */
    setResidency(handle, state) {
        _wasm.handleSetResidency(handle, state);
    }

    // ────────────────────── revision tracking ──────────────────────

    /**
     * @param {number} handle
     * @returns {number} revision id
     */
    getRevision(handle) {
        return _wasm.handleGetRevision(handle);
    }

    /**
     * Bump revision for a handle (also bumps the global revision).
     * @param {number} handle
     */
    bumpRevision(handle) {
        _wasm.handleBumpRevision(handle);
    }

    /** @returns {number} global monotonic revision counter */
    globalRevision() {
        return _wasm.handleGlobalRevision();
    }

    // ────────────────────── feature & IR hash ──────────────────────

    /**
     * @param {number} handle
     * @param {number} featureId
     */
    setFeatureId(handle, featureId) {
        _wasm.handleSetFeatureId(handle, featureId);
    }

    /**
     * @param {number} handle
     * @returns {number}
     */
    getFeatureId(handle) {
        return _wasm.handleGetFeatureId(handle);
    }

    /**
     * @param {number} handle
     * @param {number} hash
     */
    setIrHash(handle, hash) {
        _wasm.handleSetIrHash(handle, hash);
    }

    /**
     * @param {number} handle
     * @returns {number}
     */
    getIrHash(handle) {
        return _wasm.handleGetIrHash(handle);
    }

    // ────────────────────── topology access (zero-copy) ──────────────────────

    /**
     * Begin a new body definition (resets topology counters).
     */
    bodyBegin() {
        _wasm.bodyBegin();
    }

    /**
     * End body definition.
     * @returns {number} shell count
     */
    bodyEnd() {
        return _wasm.bodyEnd();
    }

    /**
     * Add a vertex. Returns its index.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {number}
     */
    vertexAdd(x, y, z) {
        return _wasm.vertexAdd(x, y, z);
    }

    /**
     * Get all vertex coordinates as a Float64Array view into WASM memory.
     * The view is invalidated if memory grows — copy if needed long-term.
     * @returns {{ data: Float64Array, count: number }}
     */
    getVertexCoords() {
        const ptr = _wasm.getVertexCoordsPtr();
        const count = _wasm.vertexGetCount();
        return {
            data: new Float64Array(_wasmMem.buffer, ptr, count * 3),
            count,
        };
    }

    /** @returns {{ verts: number, edges: number, coedges: number, loops: number, faces: number, shells: number }} */
    getTopologySummary() {
        const packed = _wasm.topoGetSummary();
        // topoGetSummary returns a StaticArray<u32>(6) — but through the glue
        // it's returned as a lifted array. Let's use individual count getters.
        return {
            verts: _wasm.vertexGetCount(),
            edges: _wasm.edgeGetCount(),
            coedges: _wasm.coedgeGetCount(),
            loops: _wasm.loopGetCount(),
            faces: _wasm.faceGetCount(),
            shells: _wasm.shellGetCount(),
        };
    }

    // ────────────────────── CBREP serialization ──────────────────────

    /**
     * Dehydrate the current WASM topology+geometry to a Uint8Array (CBREP format).
     * @returns {Uint8Array|null} a copy of the CBREP bytes, or null on overflow
     */
    dehydrate() {
        const len = _wasm.cbrepDehydrate();
        if (len === 0) return null;
        const ptr = _wasm.getCbrepOutPtr();
        const view = new Uint8Array(_wasmMem.buffer, ptr, len);
        // Return a copy so it survives memory growth
        return new Uint8Array(view);
    }

    /**
     * Hydrate topology+geometry from a CBREP Uint8Array.
     * @param {Uint8Array} cbrep
     * @returns {boolean} true on success
     */
    hydrate(cbrep) {
        // We need to write the input bytes into WASM memory.
        // Use a StaticArray<u8> via the glue layer.
        const ok = _wasm.cbrepHydrate(cbrep, cbrep.byteLength);
        return ok === 1;
    }

    // ────────────────────── octree broadphase ──────────────────────

    /**
     * Reset the octree for a new spatial query.
     */
    octreeReset() {
        _wasm.octreeReset();
    }

    /**
     * Register a face AABB in the octree.
     * @param {number} faceId
     * @param {number} minX
     * @param {number} minY
     * @param {number} minZ
     * @param {number} maxX
     * @param {number} maxY
     * @param {number} maxZ
     */
    octreeAddFaceAABB(faceId, minX, minY, minZ, maxX, maxY, maxZ) {
        _wasm.octreeAddFaceAABB(faceId, minX, minY, minZ, maxX, maxY, maxZ);
    }

    /**
     * Build the octree from registered face AABBs.
     */
    octreeBuild() {
        _wasm.octreeBuild();
    }

    /**
     * Query face-face candidate pairs between two body face ranges.
     * @param {number} aStart
     * @param {number} aEnd
     * @param {number} bStart
     * @param {number} bEnd
     * @returns {{ pairs: Uint32Array, count: number }}
     */
    octreeQueryPairs(aStart, aEnd, bStart, bEnd) {
        _wasm.octreeQueryPairs(aStart, aEnd, bStart, bEnd);
        const count = _wasm.octreeGetPairCount();
        const ptr = _wasm.getOctreePairsPtr();
        return {
            pairs: new Uint32Array(_wasmMem.buffer, ptr, count * 2),
            count,
        };
    }

    // ────────────────────── GPU batch ──────────────────────

    gpuBatchReset() {
        _wasm.gpuBatchReset();
    }

    /**
     * Get GPU header buffer for WebGPU upload.
     * @returns {{ ptr: number, length: number, view: Uint32Array }}
     */
    getGpuHeaderBuffer() {
        const ptr = _wasm.getGpuHeaderBufPtr();
        const len = _wasm.getGpuHeaderBufLen();
        return {
            ptr,
            length: len,
            view: new Uint32Array(_wasmMem.buffer, ptr, len),
        };
    }

    /**
     * Get GPU control point buffer for WebGPU upload.
     * @returns {{ ptr: number, length: number, view: Float32Array }}
     */
    getGpuCtrlBuffer() {
        const ptr = _wasm.getGpuCtrlBufPtr();
        const len = _wasm.getGpuCtrlBufLen();
        return {
            ptr,
            length: len,
            view: new Float32Array(_wasmMem.buffer, ptr, len),
        };
    }

    /**
     * Get GPU knot buffer for WebGPU upload.
     * @returns {{ ptr: number, length: number, view: Float32Array }}
     */
    getGpuKnotBuffer() {
        const ptr = _wasm.getGpuKnotBufPtr();
        const len = _wasm.getGpuKnotBufLen();
        return {
            ptr,
            length: len,
            view: new Float32Array(_wasmMem.buffer, ptr, len),
        };
    }

    /** @returns {number} */
    getGpuSurfaceCount() {
        return _wasm.getGpuSurfaceCount();
    }

    // ────────────────────── native transforms ──────────────────────

    /**
     * Load a 4×4 column-major matrix into the kernel's outMat buffer.
     * @param {Float64Array|number[]} mat16 — 16-element column-major matrix
     */
    loadTransformMatrix(mat16) {
        // Write to the outMat buffer via individual element setters.
        // The kernel's outMat is at a fixed pointer — we write directly.
        const ptr = _wasm.getTransformOutMatPtr();
        const view = new Float64Array(_wasmMem.buffer, ptr, 16);
        for (let i = 0; i < 16; i++) view[i] = mat16[i];
    }

    /**
     * Build a translation matrix in the kernel's outMat buffer.
     * @param {number} tx
     * @param {number} ty
     * @param {number} tz
     */
    setTranslation(tx, ty, tz) {
        _wasm.transformTranslation(tx, ty, tz);
    }

    /**
     * Build a scale matrix in the kernel's outMat buffer.
     * @param {number} sx
     * @param {number} sy
     * @param {number} sz
     */
    setScale(sx, sy, sz) {
        _wasm.transformScale(sx, sy, sz);
    }

    /**
     * Build a rotation matrix in the kernel's outMat buffer (Rodrigues).
     * @param {number} ax — axis X component
     * @param {number} ay — axis Y component
     * @param {number} az — axis Z component
     * @param {number} angle — angle in radians
     */
    setRotation(ax, ay, az, angle) {
        _wasm.transformRotation(ax, ay, az, angle);
    }

    /**
     * Set outMat to identity.
     */
    setIdentity() {
        _wasm.transformIdentity();
    }

    /**
     * Transform a point using the current outMat.
     * @param {number} px
     * @param {number} py
     * @param {number} pz
     * @returns {{ x: number, y: number, z: number }}
     */
    transformPoint(px, py, pz) {
        _wasm.transformPointByOutMat(px, py, pz);
        const ptr = _wasm.getTransformOutPtPtr();
        const view = new Float64Array(_wasmMem.buffer, ptr, 3);
        return { x: view[0], y: view[1], z: view[2] };
    }

    /**
     * Transform a direction using the current outMat (ignores translation).
     * @param {number} dx
     * @param {number} dy
     * @param {number} dz
     * @returns {{ x: number, y: number, z: number }}
     */
    transformDirection(dx, dy, dz) {
        _wasm.transformDirectionByOutMat(dx, dy, dz);
        const ptr = _wasm.getTransformOutPtPtr();
        const view = new Float64Array(_wasmMem.buffer, ptr, 3);
        return { x: view[0], y: view[1], z: view[2] };
    }

    /**
     * Transform all vertex coordinates in the current body by the outMat.
     * Operates in-place on WASM-side vertex data. Call after bodyBegin/bodyEnd.
     */
    transformAllVertices() {
        const count = _wasm.vertexGetCount();
        const ptr = _wasm.getVertexCoordsPtr();
        const coords = new Float64Array(_wasmMem.buffer, ptr, count * 3);
        for (let i = 0; i < count; i++) {
            _wasm.transformPointByOutMat(coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]);
            const outPtr = _wasm.getTransformOutPtPtr();
            const out = new Float64Array(_wasmMem.buffer, outPtr, 3);
            coords[i * 3]     = out[0];
            coords[i * 3 + 1] = out[1];
            coords[i * 3 + 2] = out[2];
        }
    }

    // ────────────────────── STEP export from handle ──────────────────────

    /**
     * Export the current WASM kernel topology as a STEP AP214 string.
     *
     * Flow: dehydrate → CBREP → readCbrep (IR reader) → TopoBody → exportSTEP.
     * This allows bodies modified in WASM (e.g. transformed) to be exported
     * without requiring the original JS TopoBody.
     *
     * @param {Object} [options]
     * @param {string} [options.filename]
     * @param {string} [options.author]
     * @returns {Promise<string|null>} STEP string, or null if dehydration failed
     */
    async exportStep(options = {}) {
        const cbrep = this.dehydrate();
        if (!cbrep) return null;

        const { readCbrep } = await import('../../packages/ir/reader.js');
        const { exportSTEP } = await import('./StepExport.js');

        const body = readCbrep(cbrep.buffer);
        return exportSTEP(body, options);
    }

    // ────────────────────── tessellation ──────────────────────

    /**
     * Tessellate all faces in the current body stored in topology+geometry.
     * Returns {vertices: Float64Array, normals: Float64Array, indices: Uint32Array, faceMap: Uint32Array}
     * or null on overflow.
     *
     * @param {number} [segsU=16] — segments in U direction
     * @param {number} [segsV=16] — segments in V direction
     */
    tessellateBody(segsU = 16, segsV = 16) {
        const nTris = _wasm.tessBuildAllFaces(segsU, segsV);
        if (nTris < 0) return null;
        if (nTris === 0) return { vertices: new Float64Array(0), normals: new Float64Array(0), indices: new Uint32Array(0), faceMap: new Uint32Array(0) };

        const nVerts = _wasm.getTessOutVertCount() >>> 0;
        const buf = _wasmMem.buffer;

        const vertsPtr = _wasm.getTessOutVertsPtr() >>> 0;
        const normsPtr = _wasm.getTessOutNormalsPtr() >>> 0;
        const idxPtr = _wasm.getTessOutIndicesPtr() >>> 0;
        const fmapPtr = _wasm.getTessOutFaceMapPtr() >>> 0;

        return {
            vertices: new Float64Array(buf, vertsPtr, nVerts * 3),
            normals: new Float64Array(buf, normsPtr, nVerts * 3),
            indices: new Uint32Array(buf, idxPtr, nTris * 3),
            faceMap: new Uint32Array(buf, fmapPtr, nTris),
        };
    }

    /**
     * Tessellate a single face.
     * @param {number} faceId
     * @param {number} [segsU=16]
     * @param {number} [segsV=16]
     * @returns {number} triangles added, or -1 on overflow
     */
    tessellateFace(faceId, segsU = 16, segsV = 16) {
        return _wasm.tessBuildFace(faceId, segsU, segsV);
    }

    /** Reset tessellation output buffers. */
    tessReset() {
        _wasm.tessReset();
    }

    /**
     * Get edge sample points for cross-parametric mapping.
     * @param {number} edgeId
     * @returns {Float64Array|null} — sample points [x,y,z,...] or null if not cached
     */
    getEdgeSamples(edgeId) {
        const count = _wasm.getEdgeSampleCount(edgeId) >>> 0;
        if (count === 0) return null;
        const start = _wasm.getEdgeSampleStart(edgeId) >>> 0;
        const ptr = _wasm.getEdgeSamplePtsPtr() >>> 0;
        return new Float64Array(_wasmMem.buffer, ptr + start * 3 * 8, count * 3);
    }

    // ────────────────────── boolean classification ──────────────────────

    /** Classification result constants */
    static CLASSIFY = Object.freeze({
        OUTSIDE: 0,
        INSIDE: 1,
        ON_BOUNDARY: 2,
        UNKNOWN: 3,
    });

    /**
     * Classify a point against a shell (face range).
     * @param {number} px
     * @param {number} py
     * @param {number} pz
     * @param {number} faceStart — first face index of the shell
     * @param {number} faceEnd — one-past-last face index
     * @returns {number} — CLASSIFY_OUTSIDE/INSIDE/ON_BOUNDARY/UNKNOWN
     */
    classifyPoint(px, py, pz, faceStart, faceEnd) {
        return _wasm.classifyPointVsShell(px, py, pz, faceStart, faceEnd);
    }

    /**
     * Use octree-accelerated broadphase to classify face overlaps
     * between two bodies' face ranges.
     * @param {number} faceStartA
     * @param {number} faceEndA
     * @param {number} faceStartB
     * @param {number} faceEndB
     * @returns {number} — number of classified faces
     */
    classifyFaces(faceStartA, faceEndA, faceStartB, faceEndB) {
        return _wasm.classifyFacesViaOctree(faceStartA, faceEndA, faceStartB, faceEndB) >>> 0;
    }

    /**
     * Get the classification of a specific face.
     * @param {number} faceId
     * @returns {number}
     */
    getFaceClassification(faceId) {
        return _wasm.getFaceClassification(faceId);
    }

    /**
     * Set the classification of a specific face from JS.
     * @param {number} faceId
     * @param {number} cls
     */
    setFaceClassification(faceId, cls) {
        _wasm.setFaceClassification(faceId, cls);
    }

    /**
     * Signed distance from point to plane surface.
     * @param {number} px
     * @param {number} py
     * @param {number} pz
     * @param {number} geomOffset
     * @param {boolean} reversed
     * @returns {number}
     */
    pointToPlaneDistance(px, py, pz, geomOffset, reversed = false) {
        return _wasm.pointToPlaneDistance(px, py, pz, geomOffset, reversed);
    }

    /**
     * Distance from point to sphere surface.
     * @param {number} px
     * @param {number} py
     * @param {number} pz
     * @param {number} geomOffset
     * @returns {number}
     */
    pointToSphereDistance(px, py, pz, geomOffset) {
        return _wasm.pointToSphereDistance(px, py, pz, geomOffset);
    }

    /**
     * Distance from point to cylinder surface.
     * @param {number} px
     * @param {number} py
     * @param {number} pz
     * @param {number} geomOffset
     * @returns {number}
     */
    pointToCylinderDistance(px, py, pz, geomOffset) {
        return _wasm.pointToCylinderDistance(px, py, pz, geomOffset);
    }
}

export default WasmBrepHandleRegistry;

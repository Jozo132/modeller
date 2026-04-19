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
}

export default WasmBrepHandleRegistry;

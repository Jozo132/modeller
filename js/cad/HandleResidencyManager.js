// @ts-nocheck
/**
 * HandleResidencyManager — Lazy CBREP restore and handle eviction.
 *
 * Manages the lifecycle of WASM B-Rep handles across .cmod load, undo/redo,
 * and long-running sessions. Handles are lazily hydrated from CBREP on first
 * access and evicted when memory pressure or inactivity rules trigger.
 *
 * Usage:
 *   const mgr = new HandleResidencyManager(registry);
 *   mgr.storeCbrep(featureId, cbrepBytes, irHash);
 *   const handle = await mgr.ensureResident(featureId);
 *   mgr.markAccessed(featureId);
 *   mgr.evictInactive(maxAgeSec);
 */

/**
 * @typedef {Object} ResidencyEntry
 * @property {number}     handle    — WASM handle (0 if not yet hydrated)
 * @property {Uint8Array} cbrep     — serialized CBREP bytes
 * @property {number}     irHash    — IR hash for dedup
 * @property {number}     lastAccess — timestamp of last access (ms)
 * @property {boolean}    hydrating — true while async hydration is in progress
 */

export class HandleResidencyManager {
    /** @type {import('./WasmBrepHandleRegistry').WasmBrepHandleRegistry} */
    #registry;

    /** @type {Map<string, ResidencyEntry>} featureId → entry */
    #entries = new Map();

    /** @type {number} max entries before eviction kicks in */
    #maxEntries;

    /** @type {number} max age in ms before idle eviction */
    #maxIdleMs;

    /** @type {{ hydrations: number, evictions: number, hits: number, misses: number }} */
    #stats = { hydrations: 0, evictions: 0, hits: 0, misses: 0 };

    /**
     * @param {import('./WasmBrepHandleRegistry').WasmBrepHandleRegistry} registry
     * @param {object} [opts]
     * @param {number} [opts.maxEntries=256] — eviction trigger threshold
     * @param {number} [opts.maxIdleMs=300000] — 5 minutes default idle timeout
     */
    constructor(registry, opts = {}) {
        this.#registry = registry;
        this.#maxEntries = opts.maxEntries ?? 256;
        this.#maxIdleMs = opts.maxIdleMs ?? 300_000;
    }

    /**
     * Store a CBREP payload for lazy hydration. Does NOT hydrate immediately.
     * If an entry already exists for this featureId, the old handle is released.
     *
     * @param {string} featureId
     * @param {Uint8Array} cbrep
     * @param {number} [irHash=0]
     */
    storeCbrep(featureId, cbrep, irHash = 0) {
        const existing = this.#entries.get(featureId);
        if (existing && existing.handle) {
            this.#registry.release(existing.handle);
        }
        this.#entries.set(featureId, {
            handle: 0,
            cbrep: new Uint8Array(cbrep), // defensive copy
            irHash,
            lastAccess: Date.now(),
            hydrating: false,
        });
    }

    /**
     * Store a CBREP from a base64-encoded string (as found in .cmod files).
     * @param {number} featureId
     * @param {string} base64
     * @param {number} [irHash=0]
     */
    storeCbrepBase64(featureId, base64, irHash = 0) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        this.storeCbrep(featureId, bytes, irHash);
    }

    /**
     * Check if a CBREP is stored (hydrated or not) for a feature.
     * @param {number} featureId
     * @returns {boolean}
     */
    hasCbrep(featureId) {
        return this.#entries.has(featureId);
    }

    /**
     * Ensure the WASM handle for a feature is resident (hydrated).
     * If not yet hydrated, performs hydration from stored CBREP using
     * append-only mode (hydrateForHandle) so other handles are not evicted.
     *
     * @param {string} featureId
     * @returns {number} WASM handle, or 0 if no CBREP stored or hydration failed
     */
    ensureResident(featureId) {
        const entry = this.#entries.get(featureId);
        if (!entry) {
            this.#stats.misses++;
            return 0;
        }

        entry.lastAccess = Date.now();

        if (entry.handle && this.#registry.isValid(entry.handle)) {
            this.#stats.hits++;
            return entry.handle;
        }

        // Hydrate from CBREP in append-only handle-scoped mode
        const handle = this.#registry.alloc();
        if (!handle) return 0;

        const ok = this.#registry.hydrateForHandle(handle, entry.cbrep);
        if (!ok) {
            this.#registry.release(handle);
            return 0;
        }

        entry.handle = handle;
        if (entry.irHash) {
            this.#registry.setIrHash(handle, entry.irHash);
        }
        this.#registry.setResidency(handle, this.#registry.RESIDENT);

        this.#stats.hydrations++;
        return handle;
    }

    /**
     * Mark a feature as recently accessed (for eviction ordering).
     * @param {number} featureId
     */
    markAccessed(featureId) {
        const entry = this.#entries.get(featureId);
        if (entry) entry.lastAccess = Date.now();
    }

    /**
     * Get the handle for a feature without hydrating.
     * @param {number} featureId
     * @returns {number} handle or 0
     */
    getHandle(featureId) {
        const entry = this.#entries.get(featureId);
        return entry ? entry.handle : 0;
    }

    /**
     * Evict handles that haven't been accessed within maxIdleMs.
     * Releases WASM handles but keeps the CBREP for lazy re-hydration.
     *
     * @param {number} [maxIdleMs] — override idle timeout
     * @returns {number} — number of handles evicted
     */
    evictInactive(maxIdleMs) {
        const cutoff = Date.now() - (maxIdleMs ?? this.#maxIdleMs);
        let evicted = 0;

        for (const [featureId, entry] of this.#entries) {
            if (entry.handle && entry.lastAccess < cutoff) {
                this.#registry.release(entry.handle);
                entry.handle = 0;
                evicted++;
            }
        }

        this.#stats.evictions += evicted;
        return evicted;
    }

    /**
     * Evict least-recently-used handles until the entry count is
     * at or below the max threshold.
     *
     * @returns {number} — number of handles evicted
     */
    evictLRU() {
        const active = [];
        for (const [featureId, entry] of this.#entries) {
            if (entry.handle) active.push({ featureId, lastAccess: entry.lastAccess });
        }

        if (active.length <= this.#maxEntries) return 0;

        // Sort oldest first
        active.sort((a, b) => a.lastAccess - b.lastAccess);
        const toEvict = active.length - this.#maxEntries;
        let evicted = 0;

        for (let i = 0; i < toEvict; i++) {
            const entry = this.#entries.get(active[i].featureId);
            if (entry && entry.handle) {
                this.#registry.release(entry.handle);
                entry.handle = 0;
                evicted++;
            }
        }

        this.#stats.evictions += evicted;
        return evicted;
    }

    /**
     * Remove a feature entirely (release handle + discard CBREP).
     * @param {number} featureId
     */
    remove(featureId) {
        const entry = this.#entries.get(featureId);
        if (entry) {
            if (entry.handle) this.#registry.release(entry.handle);
            this.#entries.delete(featureId);
        }
    }

    /**
     * Release all handles and clear all entries.
     */
    clear() {
        for (const entry of this.#entries.values()) {
            if (entry.handle) this.#registry.release(entry.handle);
        }
        this.#entries.clear();
    }

    /**
     * Get diagnostics for telemetry.
     * @returns {{ entryCount: number, residentCount: number, hydrations: number, evictions: number, hitRate: number }}
     */
    diagnostics() {
        let resident = 0;
        for (const entry of this.#entries.values()) {
            if (entry.handle) resident++;
        }
        const total = this.#stats.hits + this.#stats.misses;
        return {
            entryCount: this.#entries.size,
            residentCount: resident,
            hydrations: this.#stats.hydrations,
            evictions: this.#stats.evictions,
            hitRate: total > 0 ? this.#stats.hits / total : 0,
        };
    }

    /** Reset stats counters. */
    resetStats() {
        this.#stats = { hydrations: 0, evictions: 0, hits: 0, misses: 0 };
    }
}

export default HandleResidencyManager;

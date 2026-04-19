// @ts-nocheck
/**
 * LodManager — Dynamic Level-of-Detail tessellation dispatch.
 *
 * Watches camera distance and triggers re-tessellation when the tessellation
 * density should change. Maps orbit radius to tessellation segment counts
 * and notifies listeners when a re-tessellation pass is needed.
 *
 * Usage:
 *   const lod = new LodManager();
 *   lod.onRetessellate = (segsU, segsV) => { ... };
 *   // In render loop:
 *   lod.update(orbitRadius);
 */

/**
 * @typedef {Object} LodBand
 * @property {number} maxDistance — camera distances below this use this band
 * @property {number} segsU      — tessellation segments in U
 * @property {number} segsV      — tessellation segments in V
 */

/** Default LoD bands: tighter distance → more segments */
const DEFAULT_BANDS = Object.freeze([
    { maxDistance: 20,   segsU: 32, segsV: 32 },
    { maxDistance: 50,   segsU: 16, segsV: 16 },
    { maxDistance: 150,  segsU: 8,  segsV: 8  },
    { maxDistance: 500,  segsU: 4,  segsV: 4  },
    { maxDistance: Infinity, segsU: 2,  segsV: 2  },
]);

export class LodManager {
    /** @type {LodBand[]} */
    #bands;

    /** Current LoD band index */
    #currentBand = -1;

    /** Current segment counts */
    #segsU = 16;
    #segsV = 16;

    /** Hysteresis factor: band must change by this much before switching */
    #hysteresis = 0.1;

    /** Callback invoked when tessellation density changes */
    onRetessellate = null;

    /**
     * @param {object} [opts]
     * @param {LodBand[]} [opts.bands] — custom LoD bands
     * @param {number} [opts.hysteresis=0.1] — proportional hysteresis (0..1)
     */
    constructor(opts = {}) {
        this.#bands = opts.bands || DEFAULT_BANDS;
        this.#hysteresis = opts.hysteresis ?? 0.1;
    }

    /**
     * Current tessellation segment counts.
     * @returns {{ segsU: number, segsV: number }}
     */
    get segments() {
        return { segsU: this.#segsU, segsV: this.#segsV };
    }

    /** @returns {number} */
    get currentBandIndex() {
        return this.#currentBand;
    }

    /**
     * Update with the current camera distance. If the LoD band changes,
     * fires onRetessellate with the new segment counts.
     *
     * @param {number} distance — orbit radius or camera-to-target distance
     * @returns {boolean} — true if a re-tessellation was triggered
     */
    update(distance) {
        const bandIdx = this._findBand(distance);
        if (bandIdx === this.#currentBand) return false;

        // Apply hysteresis: if we're near a band boundary, don't switch
        // unless we've moved past the hysteresis margin
        if (this.#currentBand >= 0) {
            if (bandIdx > this.#currentBand) {
                // Zooming out: need to pass current band's upper boundary + margin
                const threshold = this.#bands[this.#currentBand].maxDistance;
                if (threshold !== Infinity) {
                    const margin = threshold * this.#hysteresis;
                    if (distance < threshold + margin) return false;
                }
            } else if (bandIdx < this.#currentBand) {
                // Zooming in: need to drop below the target band's upper boundary - margin
                const threshold = this.#bands[bandIdx].maxDistance;
                if (threshold !== Infinity) {
                    const margin = threshold * this.#hysteresis;
                    if (distance > threshold - margin) return false;
                }
            }
        }

        this.#currentBand = bandIdx;
        const band = this.#bands[bandIdx];
        this.#segsU = band.segsU;
        this.#segsV = band.segsV;

        if (typeof this.onRetessellate === 'function') {
            this.onRetessellate(this.#segsU, this.#segsV);
        }

        return true;
    }

    /**
     * Force a specific tessellation density (bypasses bands).
     * @param {number} segsU
     * @param {number} segsV
     */
    forceSegments(segsU, segsV) {
        this.#segsU = segsU;
        this.#segsV = segsV;
        this.#currentBand = -1; // mark as custom
        if (typeof this.onRetessellate === 'function') {
            this.onRetessellate(segsU, segsV);
        }
    }

    /**
     * Reset to uninitialized state. Next update() will trigger a retessellation.
     */
    reset() {
        this.#currentBand = -1;
    }

    /**
     * Find which band a given distance falls into.
     * @param {number} distance
     * @returns {number}
     */
    _findBand(distance) {
        for (let i = 0; i < this.#bands.length; i++) {
            if (distance <= this.#bands[i].maxDistance) return i;
        }
        return this.#bands.length - 1;
    }

    /**
     * Compute tessellation segment counts for a given distance
     * without changing internal state.
     * @param {number} distance
     * @returns {{ segsU: number, segsV: number }}
     */
    segmentsForDistance(distance) {
        const idx = this._findBand(distance);
        const band = this.#bands[idx];
        return { segsU: band.segsU, segsV: band.segsV };
    }
}

export default LodManager;

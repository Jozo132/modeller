// ui/featureEditSession.js — Preview vs. commit workflow for feature edits
//
// A FeatureEditSession captures the state of a feature before the user
// starts editing.  While active it exposes a "preview" that executes
// tentative parameter changes through the feature tree (using cached
// intermediates when possible) without committing them.
//
// The caller can then either commit() (accept the preview) or cancel()
// (revert to the saved snapshot).  This gives a clean preview/commit UX
// and makes undo trivial: the caller simply stores the pre-edit snapshot.

import { buildCacheKey, HistoryCache } from '../cad/history/HistoryCache.js';
import { replayFeatureTree, ReplayStatus } from '../cad/history/FeatureReplay.js';

// -----------------------------------------------------------------------
// EditSessionState
// -----------------------------------------------------------------------

/**
 * Possible states for a feature edit session.
 */
export const EditSessionState = Object.freeze({
  IDLE: 'idle',
  PREVIEWING: 'previewing',
  COMMITTED: 'committed',
  CANCELLED: 'cancelled',
});

// -----------------------------------------------------------------------
// FeatureEditSession
// -----------------------------------------------------------------------

/**
 * Manages the lifecycle of a single feature parameter edit.
 *
 * Usage:
 *   const session = new FeatureEditSession(partManager, featureId, cache);
 *   session.begin();
 *   session.preview({ distance: 42 });   // tentative parameter change
 *   session.commit();                     // accept, or:
 *   session.cancel();                     // revert
 */
export class FeatureEditSession {
  /**
   * @param {Object} partManager - Application PartManager instance.
   * @param {string} featureId   - ID of the feature being edited.
   * @param {HistoryCache} [cache] - Optional history cache for preview.
   */
  constructor(partManager, featureId, cache = null) {
    this.partManager = partManager;
    this.featureId = featureId;
    this.cache = cache || new HistoryCache();

    /** Current session state */
    this.state = EditSessionState.IDLE;

    /** Snapshot of feature params before editing began */
    this._snapshot = null;

    /** Last preview replay result */
    this.lastReplayResult = null;

    /** Number of cache hits during the most recent preview */
    this.previewCacheHits = 0;

    // Callbacks
    this.onPreview = null;
    this.onCommit = null;
    this.onCancel = null;
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /**
   * Begin the edit session – snapshots current feature parameters.
   * @returns {boolean} true if session started successfully.
   */
  begin() {
    if (this.state !== EditSessionState.IDLE) return false;

    const feature = this._getFeature();
    if (!feature) return false;

    // Deep-copy the feature's serialised form as the revert point
    this._snapshot = JSON.parse(JSON.stringify(feature.serialize()));
    this.state = EditSessionState.PREVIEWING;
    return true;
  }

  /**
   * Apply tentative parameter changes and replay the tree to produce a
   * preview.  Does NOT commit — calling cancel() after preview() will
   * still revert.
   *
   * @param {Object} params - Key/value pairs to apply (e.g. { distance: 20 }).
   * @returns {{ ok:boolean, replayResult:Object|null, cacheHits:number }}
   */
  preview(params) {
    if (this.state !== EditSessionState.PREVIEWING) {
      return { ok: false, replayResult: null, cacheHits: 0 };
    }

    const feature = this._getFeature();
    if (!feature) return { ok: false, replayResult: null, cacheHits: 0 };

    // Apply tentative parameters
    for (const [key, value] of Object.entries(params)) {
      if (key in feature) feature[key] = value;
    }

    // Re-execute the tree from this feature onward
    const part = this.partManager.getPart();
    if (part && part.featureTree) {
      part.featureTree.recalculateFrom(this.featureId);

      // Run replay diagnostics with cache
      const replayResult = replayFeatureTree(part.featureTree, { cache: this.cache });
      this.lastReplayResult = replayResult;
      this.previewCacheHits = replayResult.cacheHits;

      if (this.onPreview) this.onPreview(replayResult);

      return { ok: true, replayResult, cacheHits: replayResult.cacheHits };
    }

    return { ok: true, replayResult: null, cacheHits: 0 };
  }

  /**
   * Commit the current preview — the edit is finalized.
   * Stores the result in the history cache for future reuse.
   * @returns {boolean}
   */
  commit() {
    if (this.state !== EditSessionState.PREVIEWING) return false;

    // Store final result in cache for future replays
    const part = this.partManager.getPart();
    if (part && part.featureTree) {
      const feature = this._getFeature();
      if (feature) {
        const result = part.featureTree.results[this.featureId];
        if (result && !result.error) {
          const cacheKey = this._buildCacheKeyForFeature(feature, part);
          this.cache.set(cacheKey, result);
        }
      }
    }

    this.state = EditSessionState.COMMITTED;
    this._snapshot = null;

    if (this.onCommit) this.onCommit();
    return true;
  }

  /**
   * Cancel the edit — revert to snapshot.
   * @returns {boolean}
   */
  cancel() {
    if (this.state !== EditSessionState.PREVIEWING) return false;

    const feature = this._getFeature();
    if (feature && this._snapshot) {
      // Restore snapshotted parameters
      for (const [key, value] of Object.entries(this._snapshot)) {
        if (key === 'id' || key === 'type') continue; // immutable
        if (key in feature) feature[key] = value;
      }

      // Re-execute from this feature to undo tentative changes
      const part = this.partManager.getPart();
      if (part && part.featureTree) {
        part.featureTree.recalculateFrom(this.featureId);
      }
    }

    this.state = EditSessionState.CANCELLED;
    this._snapshot = null;

    if (this.onCancel) this.onCancel();
    return true;
  }

  /**
   * Whether a preview/commit/cancel cycle is currently active.
   * @returns {boolean}
   */
  get isActive() {
    return this.state === EditSessionState.PREVIEWING;
  }

  // -------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------

  _getFeature() {
    const features = this.partManager.getFeatures();
    return features.find(f => f.id === this.featureId) || null;
  }

  _buildCacheKeyForFeature(feature, part) {
    // Find previous solid hash
    let inputHash = '';
    const idx = part.featureTree.features.indexOf(feature);
    if (idx > 0) {
      for (let i = idx - 1; i >= 0; i--) {
        const prev = part.featureTree.features[i];
        if (prev.suppressed) continue;
        const r = part.featureTree.results[prev.id];
        if (r && r.type === 'solid' && !r.error) {
          const geo = r.geometry || {};
          const faceCount = geo.faces ? geo.faces.length : 0;
          const vol = typeof r.volume === 'number' ? r.volume.toFixed(6) : '0';
          inputHash = `${faceCount}:${vol}`;
          break;
        }
      }
    }

    const params = {};
    if (feature.distance !== undefined) params.distance = feature.distance;
    if (feature.radius !== undefined) params.radius = feature.radius;
    if (feature.segments !== undefined) params.segments = feature.segments;
    if (feature.direction !== undefined) params.direction = feature.direction;
    if (feature.symmetric !== undefined) params.symmetric = feature.symmetric;
    if (feature.operation !== undefined) params.operation = feature.operation;

    return buildCacheKey({
      inputHash,
      featureType: feature.type,
      params,
      selectionKeys: feature.stableEdgeKeys || feature.edgeKeys || [],
    });
  }
}

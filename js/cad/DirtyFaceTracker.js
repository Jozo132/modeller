// js/cad/DirtyFaceTracker.js — C3 dirty-face/edge tracking
//
// Precondition for incremental tessellation (H21) and downstream selectors.
// The audit (CAD-KERNEL-AUDIT.md) flagged that `dirtyFaces | invalidatedFaceIds`
// produced zero grep hits — every feature edit invalidated the entire body.
//
// This module introduces a per-FeatureTree bookkeeping object that records,
// per feature result, either:
//   - `allDirty: true` — a full retessellation is required (default after any
//     feature execution, matching today's behavior), or
//   - a discrete `Set<string|number>` of face IDs that were actually mutated.
//
// Consumers (incremental tessellation cache, render dirty-rect propagation,
// selector remap) can query the tracker, consume the dirty set, and clear
// it once they've processed the invalidation.
//
// The tracker is append-only from the producer side — features can only
// widen the dirty set, never shrink it — and clearing is the exclusive
// responsibility of the consumer.

/**
 * Tracks which faces on each feature's solid result are dirty (need reprocess).
 */
export class DirtyFaceTracker {
  constructor() {
    /** @type {Map<string, { allDirty: boolean, faceIds: Set<string|number> }>} */
    this._state = new Map();
  }

  /** Ensure a per-feature record exists. */
  _ensure(featureId) {
    let entry = this._state.get(featureId);
    if (!entry) {
      entry = { allDirty: false, faceIds: new Set() };
      this._state.set(featureId, entry);
    }
    return entry;
  }

  /**
   * Mark every face on a feature result as dirty. This is the default after
   * any feature executes since today's pipeline produces whole-body output.
   */
  markAllDirty(featureId) {
    const entry = this._ensure(featureId);
    entry.allDirty = true;
    // Discrete set no longer carries signal once allDirty is set; clear it
    // to free memory and make getDirtyFaceIds() semantics unambiguous.
    entry.faceIds.clear();
  }

  /**
   * Mark a specific face ID dirty. No-op if the feature is already allDirty
   * (a superset covers any discrete ID).
   */
  markFaceDirty(featureId, faceId) {
    const entry = this._ensure(featureId);
    if (entry.allDirty) return;
    entry.faceIds.add(faceId);
  }

  /** Bulk variant of markFaceDirty. */
  markFacesDirty(featureId, faceIds) {
    const entry = this._ensure(featureId);
    if (entry.allDirty) return;
    for (const id of faceIds) entry.faceIds.add(id);
  }

  /** True when the feature's entire body needs reprocessing. */
  isAllDirty(featureId) {
    const entry = this._state.get(featureId);
    return !!(entry && entry.allDirty);
  }

  /** True when the feature has no outstanding dirty signal. */
  isClean(featureId) {
    const entry = this._state.get(featureId);
    return !entry || (!entry.allDirty && entry.faceIds.size === 0);
  }

  /**
   * Return the set of discrete dirty face IDs. Returns an empty set when the
   * feature is allDirty — use isAllDirty() to distinguish "everything dirty"
   * from "nothing dirty".
   */
  getDirtyFaceIds(featureId) {
    const entry = this._state.get(featureId);
    if (!entry || entry.allDirty) return new Set();
    return new Set(entry.faceIds);
  }

  /** Called by a consumer once it has processed the invalidation. */
  clear(featureId) {
    this._state.delete(featureId);
  }

  /** Drop all tracked state (used by FeatureTree.clear / recalculation). */
  clearAll() {
    this._state.clear();
  }

  /**
   * Snapshot for diagnostics/serialization. Returns a plain object keyed by
   * feature ID. Not included in .cmod persistence — dirty tracking is
   * runtime-only state.
   */
  snapshot() {
    const out = {};
    for (const [fid, entry] of this._state) {
      out[fid] = {
        allDirty: entry.allDirty,
        faceIds: entry.allDirty ? null : Array.from(entry.faceIds),
      };
    }
    return out;
  }
}

/**
 * Stamp a solid result object with the tracker's current view. Lets the
 * consumer read either the coarse `allFacesDirty` flag or the discrete
 * `invalidatedFaceIds` list without needing a handle to the tracker itself.
 *
 * Called by FeatureTree._stampSolidResult after the tracker is updated.
 */
export function stampDirtyFieldsOnResult(result, featureId, tracker) {
  if (!result || typeof result !== 'object') return;
  if (tracker.isAllDirty(featureId)) {
    result.allFacesDirty = true;
    result.invalidatedFaceIds = null;
  } else {
    result.allFacesDirty = false;
    const ids = tracker.getDirtyFaceIds(featureId);
    result.invalidatedFaceIds = ids.size === 0 ? [] : Array.from(ids);
  }
}

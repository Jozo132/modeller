// js/cad/history/FeatureReplay.js — Selection-stable feature replay
//
// Evaluates features in order, resolving stored entity keys against
// the current topology. Emits structured diagnostics when selections
// cannot be resolved or must be remapped.
//
// Replay result grades:
//   - exact:     all selections resolved to identical entities
//   - remapped:  some selections resolved via geometry remap
//   - failed:    one or more selections could not be resolved

import {
  isStableKey, isLegacyEdgeKey, legacyEdgeKeyToStable,
  keyBody, resolveKey, RemapStatus,
} from './StableEntityKey.js';

import { buildCacheKey, HistoryCache } from './HistoryCache.js';

// -----------------------------------------------------------------------
// Diagnostic status constants
// -----------------------------------------------------------------------

/**
 * Feature replay result status.
 */
export const ReplayStatus = Object.freeze({
  EXACT: 'exact',
  NON_EXACT: 'non-exact',
  FAILED: 'failed',
});

/**
 * Diagnostic reason codes.
 */
export const DiagnosticReason = Object.freeze({
  MISSING_ENTITY: 'missing entity',
  AMBIGUOUS_MATCH: 'ambiguous match',
  TOPOLOGY_CHANGED: 'topology changed',
  CACHE_INVALIDATED: 'cache invalidated',
  UNSUPPORTED_LEGACY: 'unsupported legacy feature payload',
});

// -----------------------------------------------------------------------
// FeatureReplayDiagnostic
// -----------------------------------------------------------------------

/**
 * A single diagnostic entry for one feature in a replay.
 */
export class FeatureReplayDiagnostic {
  /**
   * @param {Object} opts
   * @param {number} opts.featureIndex
   * @param {string} opts.featureId
   * @param {string} opts.featureType
   * @param {string} opts.status - ReplayStatus value
   * @param {string[]} [opts.selectionKeys=[]]
   * @param {string} [opts.remapOutcome='']
   * @param {string} [opts.reason='']
   */
  constructor(opts) {
    this.featureIndex = opts.featureIndex;
    this.featureId = opts.featureId;
    this.featureType = opts.featureType ?? '';
    this.status = opts.status;
    this.selectionKeys = opts.selectionKeys || [];
    this.remapOutcome = opts.remapOutcome || '';
    this.reason = opts.reason || '';
  }

  toJSON() {
    return {
      featureIndex: this.featureIndex,
      featureId: this.featureId,
      featureType: this.featureType,
      status: this.status,
      selectionKeys: this.selectionKeys,
      remapOutcome: this.remapOutcome,
      reason: this.reason,
    };
  }
}

// -----------------------------------------------------------------------
// FeatureReplayResult
// -----------------------------------------------------------------------

/**
 * Overall result of a feature tree replay.
 */
export class FeatureReplayResult {
  constructor() {
    /** @type {FeatureReplayDiagnostic[]} */
    this.diagnostics = [];
    /** Overall status: 'exact' | 'non-exact' | 'failed' */
    this.overallStatus = ReplayStatus.EXACT;
    /** Number of cache hits during replay */
    this.cacheHits = 0;
    /** Number of cache misses during replay */
    this.cacheMisses = 0;
  }

  addDiagnostic(diag) {
    this.diagnostics.push(diag);
    // Escalate overall status
    if (diag.status === ReplayStatus.FAILED) {
      this.overallStatus = ReplayStatus.FAILED;
    } else if (diag.status === ReplayStatus.NON_EXACT && this.overallStatus !== ReplayStatus.FAILED) {
      this.overallStatus = ReplayStatus.NON_EXACT;
    }
  }

  toJSON() {
    return {
      overallStatus: this.overallStatus,
      diagnostics: this.diagnostics.map(d => d.toJSON()),
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
    };
  }
}

// -----------------------------------------------------------------------
// Selection resolution for chamfer/fillet features
// -----------------------------------------------------------------------

/**
 * Resolve edge keys stored in a chamfer/fillet feature against a current
 * TopoBody. Returns resolved keys and per-key diagnostics.
 *
 * Accepts both legacy position keys and stable entity keys.
 *
 * @param {string[]} storedKeys - Edge keys from the feature
 * @param {Object|null} topoBody - Current TopoBody to match against
 * @param {string} featureId - Feature ID for provenance
 * @returns {{ resolvedKeys:string[], diagnostics:Object[], overallStatus:string }}
 */
export function resolveEdgeSelections(storedKeys, topoBody, featureId) {
  if (!storedKeys || storedKeys.length === 0) {
    return { resolvedKeys: [], diagnostics: [], overallStatus: ReplayStatus.EXACT };
  }

  // If no topoBody available, fall through to legacy path
  if (!topoBody) {
    return {
      resolvedKeys: [...storedKeys],
      diagnostics: [],
      overallStatus: ReplayStatus.NON_EXACT,
    };
  }

  const bodyKeys = keyBody(topoBody, featureId);
  const resolvedKeys = [];
  const diagnostics = [];
  let status = ReplayStatus.EXACT;

  for (const key of storedKeys) {
    // Convert legacy keys on-the-fly
    const stableKey = isLegacyEdgeKey(key)
      ? legacyEdgeKeyToStable(key, featureId)
      : key;

    if (!isStableKey(stableKey)) {
      // Not convertible — pass through as legacy (non-exact)
      resolvedKeys.push(key);
      diagnostics.push({
        key, status: ReplayStatus.NON_EXACT,
        reason: DiagnosticReason.UNSUPPORTED_LEGACY,
      });
      status = ReplayStatus.NON_EXACT;
      continue;
    }

    const result = resolveKey(stableKey, bodyKeys);

    switch (result.status) {
      case RemapStatus.EXACT:
        resolvedKeys.push(key); // keep original key for downstream
        diagnostics.push({ key, status: ReplayStatus.EXACT, reason: '' });
        break;

      case RemapStatus.REMAPPED:
        resolvedKeys.push(key);
        diagnostics.push({
          key, status: ReplayStatus.NON_EXACT,
          reason: `remapped: ${result.reason}`,
        });
        if (status === ReplayStatus.EXACT) status = ReplayStatus.NON_EXACT;
        break;

      case RemapStatus.AMBIGUOUS:
        diagnostics.push({
          key, status: ReplayStatus.FAILED,
          reason: `${DiagnosticReason.AMBIGUOUS_MATCH}: ${result.reason}`,
        });
        status = ReplayStatus.FAILED;
        break;

      case RemapStatus.MISSING:
        diagnostics.push({
          key, status: ReplayStatus.FAILED,
          reason: `${DiagnosticReason.MISSING_ENTITY}: ${result.reason}`,
        });
        status = ReplayStatus.FAILED;
        break;
    }
  }

  return { resolvedKeys, diagnostics, overallStatus: status };
}

// -----------------------------------------------------------------------
// Feature replay engine
// -----------------------------------------------------------------------

/**
 * Replay a feature tree with cache awareness and selection resolution.
 *
 * This is a diagnostic overlay: it evaluates features using the existing
 * FeatureTree.executeAll() / recalculateFrom() mechanism, but also:
 *  - resolves stored entity keys against current topology
 *  - checks the cache before executing
 *  - emits structured diagnostics
 *
 * @param {Object} featureTree - A FeatureTree instance
 * @param {Object} [options]
 * @param {HistoryCache} [options.cache] - Optional history cache
 * @param {boolean} [options.dryRun=false] - If true, only diagnose without executing
 * @returns {FeatureReplayResult}
 */
export function replayFeatureTree(featureTree, options = {}) {
  const cache = options.cache || null;
  const dryRun = options.dryRun || false;
  const result = new FeatureReplayResult();

  if (!featureTree || !featureTree.features) return result;

  // For cache-aware evaluation, track the last solid result's structural hash
  let lastSolidHash = '';

  for (let i = 0; i < featureTree.features.length; i++) {
    const feature = featureTree.features[i];

    if (feature.suppressed) {
      result.addDiagnostic(new FeatureReplayDiagnostic({
        featureIndex: i,
        featureId: feature.id,
        featureType: feature.type,
        status: ReplayStatus.EXACT,
        reason: 'suppressed',
      }));
      continue;
    }

    // Check if this feature uses edge selections (chamfer/fillet)
    const hasSelections = Array.isArray(feature.edgeKeys) && feature.edgeKeys.length > 0;
    let selectionStatus = ReplayStatus.EXACT;
    let selectionDiagnostics = [];

    if (hasSelections && !dryRun) {
      // Get the current topoBody from the previous solid result
      const prevResult = _getPreviousSolidResult(featureTree, i);
      const topoBody = _extractTopoBodyFromResult(prevResult);
      const resolved = resolveEdgeSelections(feature.edgeKeys, topoBody, feature.id);
      selectionStatus = resolved.overallStatus;
      selectionDiagnostics = resolved.diagnostics;
    }

    // Build cache key if cache is available
    let cacheHit = false;
    if (cache && !dryRun) {
      const params = _extractFeatureParams(feature);
      const cacheKey = buildCacheKey({
        inputHash: lastSolidHash,
        featureType: feature.type,
        params,
        selectionKeys: hasSelections ? feature.edgeKeys : [],
      });

      const cached = cache.get(cacheKey);
      if (cached && selectionStatus !== ReplayStatus.FAILED) {
        cacheHit = true;
        result.cacheHits++;
      } else {
        result.cacheMisses++;
      }
    }

    // Determine feature result status
    let featureStatus;
    if (selectionStatus === ReplayStatus.FAILED) {
      featureStatus = ReplayStatus.FAILED;
    } else if (cacheHit) {
      featureStatus = selectionStatus; // preserve non-exact from remap
    } else if (hasSelections) {
      featureStatus = selectionStatus;
    } else {
      featureStatus = ReplayStatus.EXACT;
    }

    // Compute reason string
    let reason = '';
    if (selectionDiagnostics.length > 0) {
      const failures = selectionDiagnostics.filter(d => d.status === ReplayStatus.FAILED);
      if (failures.length > 0) {
        reason = failures.map(d => d.reason).join('; ');
      } else {
        const nonExact = selectionDiagnostics.filter(d => d.status === ReplayStatus.NON_EXACT);
        if (nonExact.length > 0) {
          reason = nonExact.map(d => d.reason).join('; ');
        }
      }
    }
    if (cacheHit && !reason) {
      reason = 'cache hit';
    }

    result.addDiagnostic(new FeatureReplayDiagnostic({
      featureIndex: i,
      featureId: feature.id,
      featureType: feature.type,
      status: featureStatus,
      selectionKeys: hasSelections ? [...feature.edgeKeys] : [],
      remapOutcome: cacheHit ? 'cache' : (selectionStatus !== ReplayStatus.EXACT ? 'remap' : ''),
      reason,
    }));

    // Update structural hash for next feature (simple proxy)
    if (!dryRun) {
      const currentResult = featureTree.results[feature.id];
      if (currentResult && currentResult.type === 'solid' && !currentResult.error) {
        lastSolidHash = _structuralHash(currentResult);
      }
    }
  }

  return result;
}

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

function _getPreviousSolidResult(tree, featureIndex) {
  for (let i = featureIndex - 1; i >= 0; i--) {
    const f = tree.features[i];
    if (f.suppressed) continue;
    const r = tree.results[f.id];
    if (r && r.type === 'solid' && !r.error) return r;
  }
  return null;
}

function _extractTopoBodyFromResult(result) {
  if (!result) return null;
  if (result.body) return result.body;
  if (result.solid && result.solid.body) return result.solid.body;
  if (result.brep && result.brep.shells) return result.brep;
  return null;
}

function _extractFeatureParams(feature) {
  const params = {};
  if (feature.distance !== undefined) params.distance = feature.distance;
  if (feature.radius !== undefined) params.radius = feature.radius;
  if (feature.segments !== undefined) params.segments = feature.segments;
  if (feature.direction !== undefined) params.direction = feature.direction;
  if (feature.symmetric !== undefined) params.symmetric = feature.symmetric;
  if (feature.operation !== undefined) params.operation = feature.operation;
  if (feature.taper !== undefined) params.taper = feature.taper;
  if (feature.taperAngle !== undefined) params.taperAngle = feature.taperAngle;
  return params;
}

/**
 * Simple structural hash for a solid result, used as cache input hash.
 * Uses face count + volume as a quick proxy.
 * @param {Object} result
 * @returns {string}
 */
function _structuralHash(result) {
  const geo = result.geometry || (result.solid && result.solid.geometry);
  if (!geo) return '';
  const faceCount = geo.faces ? geo.faces.length : 0;
  const vol = typeof result.volume === 'number' ? result.volume.toFixed(6) : '0';
  return `${faceCount}:${vol}`;
}

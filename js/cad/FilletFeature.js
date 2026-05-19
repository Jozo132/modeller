// js/cad/FilletFeature.js — Fillet operation feature
// Applies a rounded edge to selected edges of a 3D solid.
//
// Topology-first: consumes the previous solid (TopoBody when available),
// outputs geometry that preserves the topology chain for downstream
// features. Selection uses stable entity keys when present.

import { getFlag } from '../featureFlags.js';
import { Feature } from './Feature.js';
import { applyBRepFillet } from './BRepFillet.js';
import { expandPathEdgeKeys, makeEdgeKey } from './EdgeAnalysis.js';
import { calculateMeshVolume, calculateBoundingBox } from './toolkit/MeshAnalysis.js';
import {
  disposeOcctSketchModelingShape,
  restoreOcctSketchModelingCheckpoint,
  tryBuildOcctFilletMetadataSync,
} from './occt/OcctSketchModeling.js';
import {
  buildSelectionKeyMap,
  edgeEntityToLegacyKey,
  EntityType,
  isLegacyEdgeKey,
  isStableKey,
  legacyEdgeKeyToStable,
  parseKey,
  RemapStatus,
  resolveKey,
  selectionKeyToLegacyEdgeKey,
} from './history/StableEntityKey.js';

const OCCT_SKETCH_SOLID_FLAG = 'CAD_USE_OCCT_SKETCH_SOLIDS';

function resolveFeatureEdgeKeys(feature, selectionContext, options = {}) {
  const updateFeature = options.updateFeature !== false;
  const stableKeys = Array.isArray(feature.stableEdgeKeys) ? feature.stableEdgeKeys : [];
  const fallbackEdgeKeys = Array.isArray(feature.edgeKeys) ? [...feature.edgeKeys] : [];
  if (stableKeys.length === 0) {
    return fallbackEdgeKeys;
  }

  const bodyKeys = buildSelectionKeyMap(selectionContext, feature.id);
  if (!bodyKeys) {
    const fallbackKeys = stableKeys
      .map((key) => selectionKeyToLegacyEdgeKey(key))
      .filter((key) => key !== null);
    if (fallbackKeys.length > 0) {
      const uniqueFallbackKeys = [...new Set(fallbackKeys)];
      if (updateFeature) feature.edgeKeys = uniqueFallbackKeys;
      return uniqueFallbackKeys;
    }
    return fallbackEdgeKeys;
  }

  const resolvedEdgeKeys = [];
  for (const storedKey of stableKeys) {
    const stableKey = isLegacyEdgeKey(storedKey)
      ? legacyEdgeKeyToStable(storedKey, feature.id || '')
      : storedKey;
    if (!isStableKey(stableKey)) {
      throw new Error(`Unsupported stable edge selection for ${feature.name || feature.id}`);
    }
    const result = resolveKey(stableKey, bodyKeys);
    if (result.status === RemapStatus.AMBIGUOUS || result.status === RemapStatus.MISSING) {
      if (fallbackEdgeKeys.length > 0) {
        if (updateFeature) feature._legacySelectionFallback = result.reason || result.status;
        return fallbackEdgeKeys;
      }
      throw new Error(
        `Stable edge selection could not be resolved for ${feature.name || feature.id}: ${result.reason || result.status}`
      );
    }
    const edgeKey = edgeEntityToLegacyKey(result.entity)
      || selectionKeyToLegacyEdgeKey(result.key || stableKey);
    if (!edgeKey) {
      throw new Error(`Resolved edge selection for ${feature.name || feature.id} is not executable`);
    }
    resolvedEdgeKeys.push(edgeKey);
  }

  const uniqueResolvedEdgeKeys = [...new Set(resolvedEdgeKeys)];
  if (updateFeature) feature.edgeKeys = uniqueResolvedEdgeKeys;
  return uniqueResolvedEdgeKeys;
}

function selectionKeysResolveAgainstContext(feature, selectionContext, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return false;

  const bodyKeys = buildSelectionKeyMap(selectionContext, feature?.id);
  if (!bodyKeys) return false;

  for (const storedKey of keys) {
    const stableKey = isLegacyEdgeKey(storedKey)
      ? legacyEdgeKeyToStable(storedKey, feature?.id || '')
      : storedKey;
    if (!isStableKey(stableKey)) return false;
    const result = resolveKey(stableKey, bodyKeys);
    if (result.status === RemapStatus.AMBIGUOUS || result.status === RemapStatus.MISSING) {
      return false;
    }
  }

  return true;
}

function canResolveFeatureSelectionAgainstContext(feature, selectionContext) {
  const storedSelectionKeys = Array.isArray(feature?.stableEdgeKeys) && feature.stableEdgeKeys.length > 0
    ? feature.stableEdgeKeys
    : [];
  if (selectionKeysResolveAgainstContext(feature, selectionContext, storedSelectionKeys)) {
    return true;
  }

  const legacyKeys = Array.isArray(feature?.edgeKeys) ? feature.edgeKeys : [];
  return selectionKeysResolveAgainstContext(feature, selectionContext, legacyKeys);
}

function uniqueOcctEdgeRefs(refs) {
  return [...new Map(refs.map((ref) => [ref.stableHash || `id:${ref.topoId}`, ref])).values()];
}

function parseLegacyEdgeKey(key) {
  if (typeof key !== 'string') return null;
  const sep = key.indexOf('|');
  if (sep < 0) return null;
  const parsePoint = (text) => {
    const coords = text.split(',').map(Number);
    if (coords.length !== 3 || coords.some((value) => Number.isNaN(value))) return null;
    return { x: coords[0], y: coords[1], z: coords[2] };
  };
  const start = parsePoint(key.slice(0, sep));
  const end = parsePoint(key.slice(sep + 1));
  return start && end ? { start, end } : null;
}

function pointDistanceSquared(left, right) {
  const dx = Number(left?.x || 0) - Number(right?.x || 0);
  const dy = Number(left?.y || 0) - Number(right?.y || 0);
  const dz = Number(left?.z || 0) - Number(right?.z || 0);
  return dx * dx + dy * dy + dz * dz;
}

function legacyKeyMatchesEdge(key, edge, tolerance = 1e-3) {
  const parsed = parseLegacyEdgeKey(key);
  if (!parsed || !edge?.start || !edge?.end) return false;
  const tolSq = tolerance * tolerance;
  const direct = pointDistanceSquared(parsed.start, edge.start) <= tolSq
    && pointDistanceSquared(parsed.end, edge.end) <= tolSq;
  if (direct) return true;
  return pointDistanceSquared(parsed.start, edge.end) <= tolSq
    && pointDistanceSquared(parsed.end, edge.start) <= tolSq;
}

function toOcctEdgeRef(entity) {
  if (!entity || typeof entity !== 'object') return null;
  const stableHash = typeof entity.stableHash === 'string' && entity.stableHash.length > 0
    ? entity.stableHash
    : (typeof entity.hash === 'string' && entity.hash.length > 0 ? entity.hash : null);
  const topoId = Number.isInteger(entity.topoId)
    ? entity.topoId
    : (Number.isInteger(entity.id) ? entity.id : null);
  if (!stableHash && topoId == null) return null;
  return {
    ...(stableHash ? { stableHash } : {}),
    ...(topoId != null ? { topoId } : {}),
  };
}

function hasOcctEdgeRef(entities) {
  return Array.isArray(entities) && entities.some((entity) => !!toOcctEdgeRef(entity));
}

function collectOcctPathLegacyKeys(path, nativeEdges) {
  if (!Array.isArray(path?.edgeIndices) || path.edgeIndices.length === 0) return [];

  const legacyKeys = [];
  for (const edgeIndex of path.edgeIndices) {
    const edge = nativeEdges[edgeIndex];
    const legacyKey = edgeEntityToLegacyKey(edge);
    if (legacyKey) legacyKeys.push(legacyKey);
  }

  if (path.isClosed === true) return legacyKeys;

  const firstEdge = nativeEdges[path.edgeIndices[0]];
  const lastEdge = nativeEdges[path.edgeIndices[path.edgeIndices.length - 1]];
  if (firstEdge?.start && lastEdge?.end) {
    legacyKeys.push(makeEdgeKey(firstEdge.start, lastEdge.end));
  }

  return legacyKeys;
}

function resolveOcctFeatureChainRefs(selectionContext, fallbackEdgeKeys) {
  if (!Array.isArray(fallbackEdgeKeys) || fallbackEdgeKeys.length === 0) return [];

  const geometry = selectionContext?.geometry;
  const nativeEdges = Array.isArray(geometry?._occtFeatureEdges) && geometry._occtFeatureEdges.length > 0
    ? geometry._occtFeatureEdges
    : (Array.isArray(geometry?.edges) ? geometry.edges : []);
  const nativePaths = hasOcctEdgeRef(geometry?._occtFeaturePaths)
    ? geometry._occtFeaturePaths
    : (hasOcctEdgeRef(geometry?.paths) ? geometry.paths : []);
  if (nativeEdges.length === 0) return [];

  const nativeGeometry = nativePaths.length > 0
    ? { edges: nativeEdges, paths: nativePaths }
    : null;
  const expandedKeys = nativeGeometry
    ? expandPathEdgeKeys(nativeGeometry, fallbackEdgeKeys)
    : fallbackEdgeKeys;
  const wanted = new Set(expandedKeys.length > 0 ? expandedKeys : fallbackEdgeKeys);
  const refs = [];

  for (const path of nativePaths) {
    if (!Array.isArray(path?.edgeIndices) || path.edgeIndices.length === 0) continue;
    const matched = collectOcctPathLegacyKeys(path, nativeEdges)
      .some((legacyKey) => wanted.has(legacyKey));
    if (!matched) continue;
    const ref = toOcctEdgeRef(path);
    if (ref) refs.push(ref);
  }
  if (refs.length > 0) return uniqueOcctEdgeRefs(refs);

  for (const edge of nativeEdges) {
    const legacyKey = edgeEntityToLegacyKey(edge);
    const ref = toOcctEdgeRef(edge);
    if (!ref || !legacyKey || !wanted.has(legacyKey)) continue;
    refs.push(ref);
  }

  return uniqueOcctEdgeRefs(refs);
}

export class FilletFeature extends Feature {
  constructor(name = 'Fillet', radius = 1) {
    super(name);
    this.type = 'fillet';
    this.radius = radius;
    this.segments = 8; // Arc tessellation segments
    // Edge keys are vertex-position-based strings identifying the edges to fillet
    this.edgeKeys = [];
    // Stable entity keys (populated on new workflows, empty on legacy projects)
    this.stableEdgeKeys = [];
    this.occtSpec = null;
    // Whether this feature result was produced by the exact topology path
    this._resultExact = false;
  }

  getCbrepCacheVersion() {
    return 'fillet-exact-brep-v3-rolling-curved-chains';
  }

  execute(context) {
    const requireOcct = getFlag(OCCT_SKETCH_SOLID_FLAG) === true;
    const { solid, sourceResult, edgeKeys } = this._resolveFilletExecutionInput(context);
    if (!solid || !solid.geometry || !solid.geometry.faces) {
      throw new Error('No solid body found to fillet');
    }

    if (edgeKeys.length === 0) {
      throw new Error('No edges selected for fillet');
    }

    const inputTopoBody = solid.body || (solid.geometry && solid.geometry.topoBody) || null;
    let selectionContext = solid;
    let occtInputGeometry = solid.geometry;
    let restoredOcctGeometry = null;
    let occtRestoreError = null;

    if (!(occtInputGeometry?.occtShapeHandle > 0) && sourceResult?.occtCheckpoint) {
      try {
        const restored = restoreOcctSketchModelingCheckpoint(sourceResult.occtCheckpoint);
        if (restored?.geometry?.occtShapeHandle > 0) {
          restoredOcctGeometry = restored.geometry;
          occtInputGeometry = restored.geometry;
          selectionContext = {
            ...solid,
            geometry: restored.geometry,
            body: solid.body || restored.geometry.topoBody || null,
          };
        }
      } catch (error) {
        occtRestoreError = error;
      }
    }

    const hadOcctInput = occtInputGeometry?.occtShapeHandle > 0;
    let occtGeometry = null;
    try {
      occtGeometry = hadOcctInput
        ? tryBuildOcctFilletMetadataSync({
          handle: occtInputGeometry.occtShapeHandle,
          edgeRefs: this._resolveSelectedOcctEdgeRefs(selectionContext, edgeKeys),
          radius: this.radius,
          spec: this.occtSpec,
          topoBody: inputTopoBody,
        })
        : null;
    } finally {
      if (restoredOcctGeometry) {
        this._disposeTemporaryOcctGeometry(restoredOcctGeometry, occtGeometry?.occtShapeHandle || 0);
      }
    }

    if (occtGeometry) {
      this._resultExact = !!(occtGeometry.topoBody || occtGeometry.occtShapeHandle);
      return {
        type: 'solid',
        geometry: occtGeometry,
        solid: { geometry: occtGeometry, body: occtGeometry.topoBody || null },
        volume: calculateMeshVolume(occtGeometry),
        boundingBox: calculateBoundingBox(occtGeometry),
        brep: occtGeometry.brep || null,
        occtShapeHandle: occtGeometry.occtShapeHandle || 0,
        occtShapeResident: occtGeometry.occtShapeResident === true,
        _exactTopology: this._resultExact,
      };
    }

    if (requireOcct) {
      const restoreMessage = occtRestoreError
        ? `Failed to restore the upstream OCCT checkpoint: ${occtRestoreError?.message || String(occtRestoreError)}`
        : (hadOcctInput
          ? 'The OCCT fillet operation did not produce a replacement shape for the selected edges.'
          : 'No resident or restorable OCCT handle was available on the input solid.');
      throw new Error(
        `[OCCT-only] FilletFeature requires resident or restorable OCCT geometry. ${restoreMessage}`
      );
    }

    if (!inputTopoBody) {
      throw new Error(
        '[BRep-only] FilletFeature requires exact topology (TopoBody) on the input solid or a resident OCCT handle. ' +
        'Legacy mesh-based fillet is no longer supported.'
      );
    }

    const exactInputGeometry = { ...solid.geometry, topoBody: inputTopoBody };
    const geometry = applyBRepFillet(exactInputGeometry, edgeKeys, this.radius, this.segments);
    if (!geometry) {
      throw new Error(
        '[BRep-only] applyBRepFillet returned null — the BRep fillet path failed. ' +
        'This must be fixed in the BRep kernel, not by falling back to mesh fillet.'
      );
    }

    // Tag faces with source feature
    for (const f of geometry.faces) {
      if (!f.shared) f.shared = {};
    }

    const resultTopoBody = geometry.topoBody || null;
    this._resultExact = !!resultTopoBody;

    return {
      type: 'solid',
      geometry,
      solid: { geometry, body: resultTopoBody },
      volume: calculateMeshVolume(geometry),
      boundingBox: calculateBoundingBox(geometry),
      brep: geometry.brep || null,
      _exactTopology: this._resultExact,
    };
  }

  _getPreviousSolid(context) {
    const thisIndex = context.tree.getFeatureIndex(this.id);
    return this._getPreviousSolidBeforeIndex(context, thisIndex);
  }

  _getPreviousSolidResult(context) {
    const thisIndex = context.tree.getFeatureIndex(this.id);
    return this._getPreviousSolidResultBeforeIndex(context, thisIndex);
  }

  _getPreviousSolidBeforeIndex(context, featureIndex) {
    const result = this._getPreviousSolidResultBeforeIndex(context, featureIndex);
    return result?.solid || null;
  }

  _getPreviousSolidResultBeforeIndex(context, featureIndex) {
    for (let i = featureIndex - 1; i >= 0; i--) {
      const feature = context.tree.features[i];
      if (feature.suppressed) continue;
      const result = context.results[feature.id];
      if (result && result.type === 'solid' && !result.error) {
        return result;
      }
    }
    return null;
  }

  _resolveFilletExecutionInput(context) {
    const thisIndex = context.tree.getFeatureIndex(this.id);
    const mergedFeatures = [this];
    const mergedSelectionKeys = [...this._getStoredSelectionKeys(this)];
    const mergedLegacyKeys = Array.isArray(this.edgeKeys) ? [...this.edgeKeys] : [];
    const edgeOwnerMap = {};
    let earliestMergeIndex = thisIndex;
    let mergedAny = false;

    for (let i = thisIndex - 1; i >= 0; i--) {
      const feature = context.tree.features[i];
      if (!feature || feature.suppressed) continue;
      if (feature.type !== 'fillet') break;
      if (Math.abs((feature.radius || 0) - this.radius) > 1e-6) break;
      if ((feature.segments || 8) !== this.segments) break;
      const featureSelectionKeys = this._getStoredSelectionKeys(feature);
      const featureLegacyKeys = Array.isArray(feature.edgeKeys) ? feature.edgeKeys : [];
      const candidateSolid = this._getPreviousSolidBeforeIndex(context, i);
      let stableNearby = false;
      if (candidateSolid) {
        const currentCanResolve = canResolveFeatureSelectionAgainstContext(this, candidateSolid);
        const featureCanResolve = canResolveFeatureSelectionAgainstContext(feature, candidateSolid);
        if (!currentCanResolve || !featureCanResolve) {
          break;
        }
        try {
          const currentCandidateKeys = resolveFeatureEdgeKeys(this, candidateSolid, { updateFeature: false });
          const featureCandidateKeys = resolveFeatureEdgeKeys(feature, candidateSolid, { updateFeature: false });
          stableNearby = this._edgeSetsNearby(currentCandidateKeys, featureCandidateKeys, this.radius * 1.5 + 1e-6);
        } catch (_) {
          stableNearby = this._edgeSetsNearby(mergedSelectionKeys, featureSelectionKeys, this.radius * 1.5 + 1e-6);
        }
      }
      const legacyNearby = this._edgeSetsNearby(mergedLegacyKeys, featureLegacyKeys, this.radius * 1.5 + 1e-6);
      if (!stableNearby && !legacyNearby) break;
      mergedSelectionKeys.push(...featureSelectionKeys);
      mergedLegacyKeys.push(...featureLegacyKeys);
      mergedFeatures.push(feature);
      earliestMergeIndex = i;
      mergedAny = true;
    }

    const sourceResult = mergedAny
      ? this._getPreviousSolidResultBeforeIndex(context, earliestMergeIndex)
      : this._getPreviousSolidResult(context);
    const solid = sourceResult?.solid || null;

    const mergedKeys = [];
    for (const feature of mergedFeatures) {
      const featureKeys = this._resolveSelectedEdgeKeys(solid, feature);
      for (const key of featureKeys) {
        mergedKeys.push(key);
        if (!edgeOwnerMap[key]) edgeOwnerMap[key] = feature.id;
      }
    }

    return {
      solid,
      sourceResult,
      edgeKeys: [...new Set(mergedKeys)],
      edgeOwnerMap,
    };
  }

  _disposeTemporaryOcctGeometry(geometry, keepHandle = 0) {
    const handle = geometry?.occtShapeHandle || 0;
    if (!handle || handle === keepHandle) return;
    disposeOcctSketchModelingShape(handle);
    geometry.occtShapeHandle = 0;
    geometry.occtShapeResident = false;
  }

  _getStoredSelectionKeys(feature = this) {
    if (Array.isArray(feature?.stableEdgeKeys) && feature.stableEdgeKeys.length > 0) {
      return [...feature.stableEdgeKeys];
    }
    return Array.isArray(feature?.edgeKeys) ? [...feature.edgeKeys] : [];
  }

  _resolveSelectedEdgeKeys(selectionContext, feature = this) {
    return resolveFeatureEdgeKeys(feature, selectionContext);
  }

  _resolveSelectedOcctEdgeRefs(selectionContext, legacyKeys = null, feature = this) {
    const fallbackEdgeKeys = Array.isArray(legacyKeys) && legacyKeys.length > 0
      ? [...new Set(legacyKeys)]
      : (Array.isArray(feature.edgeKeys) ? [...feature.edgeKeys] : []);
    const nativeChainRefs = resolveOcctFeatureChainRefs(selectionContext, fallbackEdgeKeys);
    if (nativeChainRefs.length > 0) return nativeChainRefs;

    const geometryEdges = Array.isArray(selectionContext?.geometry?.edges)
      ? selectionContext.geometry.edges
      : [];
    const geometryRefs = [];
    for (const edge of geometryEdges) {
      const legacyKey = edgeEntityToLegacyKey(edge);
      const ref = toOcctEdgeRef(edge);
      const matched = !!legacyKey && fallbackEdgeKeys.some((key) => (
        key === legacyKey || legacyKeyMatchesEdge(key, edge)
      ));
      if (!ref || !matched) continue;
      geometryRefs.push(ref);
    }
    if (geometryRefs.length > 0) {
      return uniqueOcctEdgeRefs(geometryRefs);
    }

    const bodyKeys = buildSelectionKeyMap(selectionContext, feature.id);
    const stableKeys = this._getStoredSelectionKeys(feature);
    if (!bodyKeys) return [];

    const refs = [];
    for (const storedKey of stableKeys) {
      const stableKey = isLegacyEdgeKey(storedKey)
        ? legacyEdgeKeyToStable(storedKey, feature.id || '')
        : storedKey;
      const result = resolveKey(stableKey, bodyKeys);
      if (result.status === RemapStatus.AMBIGUOUS || result.status === RemapStatus.MISSING) continue;
      const entity = result.entity;
      const ref = toOcctEdgeRef(entity);
      if (ref) {
        refs.push(ref);
        continue;
      }
    }

    return uniqueOcctEdgeRefs(refs);
  }

  _edgeSetsNearby(edgeKeysA, edgeKeysB, tol) {
    const pointsA = this._collectEdgeKeyPoints(edgeKeysA);
    const pointsB = this._collectEdgeKeyPoints(edgeKeysB);
    for (const a of pointsA) {
      for (const b of pointsB) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        if ((dx * dx + dy * dy + dz * dz) <= tol * tol) return true;
      }
    }
    return false;
  }

  _collectEdgeKeyPoints(edgeKeys) {
    const points = [];
    for (const key of edgeKeys || []) {
      let edgeKey = key;
      if (isStableKey(edgeKey)) {
        const parsed = parseKey(edgeKey);
        edgeKey = parsed && parsed.entityType === EntityType.EDGE ? parsed.geomSig : null;
      }
      if (typeof edgeKey !== 'string') continue;
      const sep = edgeKey.indexOf('|');
      if (sep < 0) continue;
      const parsePoint = (text) => {
        const coords = text.split(',').map(Number);
        if (coords.length !== 3 || coords.some((value) => Number.isNaN(value))) return null;
        return { x: coords[0], y: coords[1], z: coords[2] };
      };
      const pointA = parsePoint(edgeKey.slice(0, sep));
      const pointB = parsePoint(edgeKey.slice(sep + 1));
      if (pointA) points.push(pointA);
      if (pointB) points.push(pointB);
    }
    return points;
  }

  setRadius(radius) {
    this.radius = Math.max(0.01, radius);
    this.modified = new Date();
  }

  setSegments(segments) {
    this.segments = Math.max(2, Math.min(32, Math.round(segments)));
    this.modified = new Date();
  }

  setEdgeKeys(keys) {
    this.edgeKeys = [...keys];
    this.modified = new Date();
  }

  serialize() {
    return {
      ...super.serialize(),
      radius: this.radius,
      segments: this.segments,
      edgeKeys: [...this.edgeKeys],
      stableEdgeKeys: [...this.stableEdgeKeys],
      occtSpec: this.occtSpec && typeof this.occtSpec === 'object' ? { ...this.occtSpec } : this.occtSpec,
    };
  }

  static deserialize(data) {
    const feature = new FilletFeature();
    if (!data) return feature;
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'fillet';
    feature.radius = data.radius || 1;
    feature.segments = data.segments || 8;
    feature.edgeKeys = Array.isArray(data.edgeKeys) ? [...data.edgeKeys] : [];
    feature.stableEdgeKeys = Array.isArray(data.stableEdgeKeys) ? [...data.stableEdgeKeys] : [];
    feature.occtSpec = data.occtSpec && typeof data.occtSpec === 'object' ? { ...data.occtSpec } : null;
    // Mark legacy projects (no stable keys) so downstream can detect non-exact provenance
    if (feature.stableEdgeKeys.length === 0 && feature.edgeKeys.length > 0) {
      feature._legacySelection = true;
      // Migration: convert legacy edge keys to stable keys on load
      feature.stableEdgeKeys = feature.edgeKeys
        .filter(k => isLegacyEdgeKey(k))
        .map(k => legacyEdgeKeyToStable(k, feature.id || ''))
        .filter(k => k !== null);
    }
    return feature;
  }
}

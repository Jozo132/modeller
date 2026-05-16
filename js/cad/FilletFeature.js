// js/cad/FilletFeature.js — Fillet operation feature
// Applies a rounded edge to selected edges of a 3D solid.
//
// Topology-first: consumes the previous solid (TopoBody when available),
// outputs geometry that preserves the topology chain for downstream
// features. Selection uses stable entity keys when present.

import { Feature } from './Feature.js';
import { applyBRepFillet } from './BRepFillet.js';
import { expandPathEdgeKeys } from './EdgeAnalysis.js';
import { calculateMeshVolume, calculateBoundingBox } from './toolkit/MeshAnalysis.js';
import { tryBuildOcctFilletMetadataSync } from './occt/OcctSketchModeling.js';
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
    const { solid, edgeKeys, edgeOwnerMap } = this._resolveFilletExecutionInput(context);
    if (!solid || !solid.geometry || !solid.geometry.faces) {
      throw new Error('No solid body found to fillet');
    }

    if (edgeKeys.length === 0) {
      throw new Error('No edges selected for fillet');
    }

    const inputTopoBody = solid.body || (solid.geometry && solid.geometry.topoBody) || null;
    const occtGeometry = solid.geometry?.occtShapeHandle > 0
      ? tryBuildOcctFilletMetadataSync({
        handle: solid.geometry.occtShapeHandle,
        edgeRefs: this._resolveSelectedOcctEdgeRefs(solid, edgeKeys),
        radius: this.radius,
        spec: this.occtSpec,
        topoBody: inputTopoBody,
      })
      : null;
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

  _getPreviousSolidBeforeIndex(context, featureIndex) {
    for (let i = featureIndex - 1; i >= 0; i--) {
      const feature = context.tree.features[i];
      if (feature.suppressed) continue;
      const result = context.results[feature.id];
      if (result && result.type === 'solid' && !result.error) {
        return result.solid;
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

    const solid = mergedAny
      ? this._getPreviousSolidBeforeIndex(context, earliestMergeIndex)
      : this._getPreviousSolid(context);

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
      edgeKeys: [...new Set(mergedKeys)],
      edgeOwnerMap,
    };
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
    const geometryEdges = Array.isArray(selectionContext?.geometry?.edges)
      ? selectionContext.geometry.edges
      : [];
    const geometryRefs = [];
    for (const edge of geometryEdges) {
      const legacyKey = edgeEntityToLegacyKey(edge);
      if (!edge?.stableHash || !legacyKey || !fallbackEdgeKeys.includes(legacyKey)) continue;
      geometryRefs.push({ stableHash: edge.stableHash });
    }
    if (geometryRefs.length > 0) {
      return [...new Map(geometryRefs.map((ref) => [ref.stableHash, ref])).values()];
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
      if (entity?.stableHash) {
        refs.push({ stableHash: entity.stableHash });
        continue;
      }
      const topoId = Number.isInteger(entity?.topoId) ? entity.topoId : (Number.isInteger(entity?.id) ? entity.id : null);
      if (topoId != null) {
        refs.push({ topoId });
      }
    }

    return [...new Map(refs.map((ref) => [ref.stableHash || `id:${ref.topoId}`, ref])).values()];
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

// js/cad/ChamferFeature.js — Chamfer operation feature
// Applies a flat bevel to selected edges of a 3D solid.
//
// Topology-first: consumes the previous solid (TopoBody when available),
// outputs geometry that preserves the topology chain for downstream
// features. Selection uses stable entity keys when present.

import { Feature } from './Feature.js';
import { applyBRepChamfer } from './BRepChamfer.js';
import { expandPathEdgeKeys, makeEdgeKey } from './EdgeAnalysis.js';
import { calculateMeshVolume, calculateBoundingBox } from './toolkit/MeshAnalysis.js';
import { tryBuildOcctChamferMetadataSync } from './occt/OcctSketchModeling.js';
import {
  buildSelectionKeyMap,
  edgeEntityToLegacyKey,
  isLegacyEdgeKey,
  isStableKey,
  legacyEdgeKeyToStable,
  RemapStatus,
  resolveKey,
  selectionKeyToLegacyEdgeKey,
} from './history/StableEntityKey.js';

function resolveFeatureEdgeKeys(feature, selectionContext) {
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
      feature.edgeKeys = uniqueFallbackKeys;
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
        feature._legacySelectionFallback = result.reason || result.status;
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
  feature.edgeKeys = uniqueResolvedEdgeKeys;
  return uniqueResolvedEdgeKeys;
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

export class ChamferFeature extends Feature {
  constructor(name = 'Chamfer', distance = 1) {
    super(name);
    this.type = 'chamfer';
    this.distance = distance;
    // Edge keys are vertex-position-based strings identifying the edges to chamfer
    this.edgeKeys = [];
    // Stable entity keys (populated on new workflows, empty on legacy projects)
    this.stableEdgeKeys = [];
    this.occtSpec = null;
    // Whether this feature result was produced by the exact topology path
    this._resultExact = false;
  }

  getCbrepCacheVersion() {
    return 'chamfer-exact-brep-v2-projected-caps';
  }

  execute(context) {
    const solid = this._getPreviousSolid(context);
    if (!solid || !solid.geometry || !solid.geometry.faces) {
      throw new Error('No solid body found to chamfer');
    }

    const selectedEdgeKeys = this._resolveSelectedEdgeKeys(solid);

    if (selectedEdgeKeys.length === 0) {
      throw new Error('No edges selected for chamfer');
    }

    const inputTopoBody = solid.body || (solid.geometry && solid.geometry.topoBody) || null;
    const occtGeometry = solid.geometry?.occtShapeHandle > 0
      ? tryBuildOcctChamferMetadataSync({
        handle: solid.geometry.occtShapeHandle,
        edgeRefs: this._resolveSelectedOcctEdgeRefs(solid, selectedEdgeKeys),
        distance: this.distance,
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

    // Expand path-level keys to individual face-edge keys.
    // Skip expansion for the BRep path since applyBRepChamfer already maps
    // mesh-level segment keys to whole TopoEdges internally, and tangent-path
    // expansion can erroneously include neighboring arc segments.
    const resolvedKeys = inputTopoBody
      ? selectedEdgeKeys
      : expandPathEdgeKeys(solid.geometry, selectedEdgeKeys);
    if (!inputTopoBody) {
      throw new Error(
        '[BRep-only] ChamferFeature requires exact topology (TopoBody) on the input solid or a resident OCCT handle. ' +
        'Legacy mesh-based chamfer is no longer supported.'
      );
    }
    const exactInputGeometry = { ...solid.geometry, topoBody: inputTopoBody };
    const geometry = applyBRepChamfer(exactInputGeometry, resolvedKeys, this.distance);
    if (!geometry) {
      throw new Error(
        '[BRep-only] applyBRepChamfer returned null — the BRep chamfer path failed. ' +
        'This must be fixed in the BRep kernel, not by falling back to mesh chamfer.'
      );
    }

    // Tag faces with source feature
    for (const f of geometry.faces) {
      if (!f.shared) f.shared = {};
    }

    const resultTopoBody = geometry.topoBody || geometry.brep || null;

    // Mark exactness: true when result has valid TopoBody (either from
    // exact BRep path or from successful mesh-level promotion)
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
    for (let i = thisIndex - 1; i >= 0; i--) {
      const feature = context.tree.features[i];
      if (feature.suppressed) continue;
      const result = context.results[feature.id];
      if (result && result.type === 'solid' && !result.error) {
        return result.solid;
      }
    }
    return null;
  }

  _resolveSelectedEdgeKeys(selectionContext) {
    return resolveFeatureEdgeKeys(this, selectionContext);
  }

  _resolveSelectedOcctEdgeRefs(selectionContext, legacyKeys = null) {
    const fallbackEdgeKeys = Array.isArray(legacyKeys) && legacyKeys.length > 0
      ? [...new Set(legacyKeys)]
      : (Array.isArray(this.edgeKeys) ? [...this.edgeKeys] : []);
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

    const bodyKeys = buildSelectionKeyMap(selectionContext, this.id);
    const stableKeys = Array.isArray(this.stableEdgeKeys) ? this.stableEdgeKeys : [];
    if (!bodyKeys) return [];

    const refs = [];
    for (const storedKey of stableKeys) {
      const stableKey = isLegacyEdgeKey(storedKey)
        ? legacyEdgeKeyToStable(storedKey, this.id || '')
        : storedKey;
      const result = resolveKey(stableKey, bodyKeys);
      if (result.status === RemapStatus.AMBIGUOUS || result.status === RemapStatus.MISSING) continue;
      const entity = result.entity;
      const ref = toOcctEdgeRef(entity);
      if (ref) refs.push(ref);
    }

    return uniqueOcctEdgeRefs(refs);
  }

  setDistance(distance) {
    this.distance = Math.max(0.01, distance);
    this.modified = new Date();
  }

  setEdgeKeys(keys) {
    this.edgeKeys = [...keys];
    this.modified = new Date();
  }

  serialize() {
    return {
      ...super.serialize(),
      distance: this.distance,
      edgeKeys: [...this.edgeKeys],
      stableEdgeKeys: [...this.stableEdgeKeys],
      occtSpec: this.occtSpec && typeof this.occtSpec === 'object' ? { ...this.occtSpec } : this.occtSpec,
    };
  }

  static deserialize(data) {
    const feature = new ChamferFeature();
    if (!data) return feature;
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'chamfer';
    feature.distance = data.distance || 1;
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

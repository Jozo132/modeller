// js/cad/FilletFeature.js — Fillet operation feature
// Applies a rounded edge to selected edges of a 3D solid.
//
// Topology-first: consumes the previous solid (TopoBody when available),
// outputs geometry that preserves the topology chain for downstream
// features. Selection uses stable entity keys when present.

import { Feature } from './Feature.js';
import { expandPathEdgeKeys, makeEdgeKey } from './EdgeAnalysis.js';
import { calculateMeshVolume, calculateBoundingBox } from './toolkit/MeshAnalysis.js';
import { EdgeSampler } from './Tessellator2/EdgeSampler.js';
import {
  cloneOcctCheckpointMeshSnapshot,
  disposeOcctSketchModelingShape,
  ensureOcctGeometryResidentFromCheckpoint,
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

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const _legacyTopoEdgeSampler = new EdgeSampler();

function cloneJsonLike(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneJsonLike(entry));
  if (!isPlainObject(value)) return value;
  const cloned = {};
  for (const [key, entry] of Object.entries(value)) {
    cloned[key] = cloneJsonLike(entry);
  }
  return cloned;
}

function mergeJsonLike(baseValue, overrideValue, key = '') {
  if (overrideValue === undefined) return cloneJsonLike(baseValue);
  if (baseValue === undefined) return cloneJsonLike(overrideValue);

  if (key === 'edges' && Array.isArray(baseValue) && Array.isArray(overrideValue)) {
    const merged = [];
    const length = Math.max(baseValue.length, overrideValue.length);
    for (let index = 0; index < length; index += 1) {
      merged.push(mergeJsonLike(baseValue[index], overrideValue[index]));
    }
    return merged;
  }

  if (Array.isArray(overrideValue)) return cloneJsonLike(overrideValue);
  if (Array.isArray(baseValue)) return cloneJsonLike(baseValue);

  if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
    const merged = {};
    const keys = new Set([...Object.keys(baseValue), ...Object.keys(overrideValue)]);
    for (const childKey of keys) {
      merged[childKey] = mergeJsonLike(baseValue[childKey], overrideValue[childKey], childKey);
    }
    return merged;
  }

  return cloneJsonLike(overrideValue);
}

function buildDefaultFilletOcctSpec(edgeRefs, radius) {
  return {
    schemaVersion: 1,
    unit: { length: 'model', angle: 'radians' },
    edges: edgeRefs.map((edgeRef) => ({
      edge: cloneJsonLike(edgeRef),
      radiusMode: 'constant',
      radius: Number(radius) || 0,
    })),
  };
}

function cleanFilletRadiusLaw(law) {
  if (!isPlainObject(law)) return null;
  const type = law.type === 'linear' ? 'linear' : 'constant';
  if (type === 'linear') {
    const startRadius = Number(law.startRadius);
    const endRadius = Number(law.endRadius);
    if (!Number.isFinite(startRadius) || !Number.isFinite(endRadius)) return null;
    return { type, startRadius, endRadius };
  }
  const radius = Number(law.radius);
  return Number.isFinite(radius) ? { type, radius } : null;
}

function cleanFilletStations(stations) {
  if (!Array.isArray(stations)) return null;
  const cleaned = stations
    .map((station) => {
      if (!isPlainObject(station)) return null;
      const t = Number(station.t);
      const radius = Number(station.radius);
      if (!Number.isFinite(t) || !Number.isFinite(radius)) return null;
      return { t, radius };
    })
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : null;
}

function cleanFilletLimits(limits) {
  if (!isPlainObject(limits)) return null;
  const start = Number(limits.start);
  const end = Number(limits.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return {
    start,
    end,
    normalized: limits.normalized !== false,
  };
}

function cleanEffectiveFilletSpec(spec) {
  const cleaned = mergeJsonLike({}, spec);
  const mode = cleaned.radiusMode || 'constant';

  if (mode !== 'constant') delete cleaned.radius;
  if (mode !== 'startEnd') {
    delete cleaned.startRadius;
    delete cleaned.endRadius;
  }
  if (mode !== 'variable') {
    delete cleaned.stations;
  } else {
    cleaned.stations = cleanFilletStations(cleaned.stations);
  }
  if (mode !== 'law') {
    delete cleaned.law;
  } else {
    cleaned.law = cleanFilletRadiusLaw(cleaned.law);
  }

  cleaned.limits = cleanFilletLimits(cleaned.limits);
  if (!cleaned.limits) delete cleaned.limits;
  if (!cleaned.stations) delete cleaned.stations;
  if (!cleaned.law) delete cleaned.law;

  if (Array.isArray(cleaned.edges)) {
    cleaned.edges = cleaned.edges.map((edge) => {
      if (!isPlainObject(edge)) return edge;
      const nextEdge = mergeJsonLike({}, edge);
      const edgeMode = nextEdge.radiusMode || mode;
      if (edgeMode !== 'constant') delete nextEdge.radius;
      if (edgeMode !== 'startEnd') {
        delete nextEdge.startRadius;
        delete nextEdge.endRadius;
      }
      if (edgeMode !== 'variable') {
        delete nextEdge.stations;
      } else {
        nextEdge.stations = cleanFilletStations(nextEdge.stations);
      }
      if (edgeMode !== 'law') {
        delete nextEdge.law;
      } else {
        nextEdge.law = cleanFilletRadiusLaw(nextEdge.law);
      }
      nextEdge.limits = cleanFilletLimits(nextEdge.limits);
      if (!nextEdge.limits) delete nextEdge.limits;
      if (!nextEdge.stations) delete nextEdge.stations;
      if (!nextEdge.law) delete nextEdge.law;
      return nextEdge;
    });
  }

  return cleaned;
}

function resolveFeatureEdgeKeys(feature, selectionContext, options = {}) {
  const updateFeature = options.updateFeature !== false;
  const stableKeys = Array.isArray(feature.stableEdgeKeys) ? feature.stableEdgeKeys : [];
  const fallbackEdgeKeys = Array.isArray(feature.edgeKeys) ? [...feature.edgeKeys] : [];
  const storedOcctEdgeRefs = sanitizeOcctEdgeRefs(feature?.occtEdgeRefs);
  if (stableKeys.length === 0) {
    if (storedOcctEdgeRefs.length > 0) {
      const resolvedFromRefs = resolveLegacyEdgeKeysFromOcctRefs(selectionContext, storedOcctEdgeRefs);
      if (resolvedFromRefs.length > 0) {
        if (updateFeature) feature.edgeKeys = resolvedFromRefs;
        return resolvedFromRefs;
      }
    }
    return fallbackEdgeKeys;
  }

  const bodyKeys = buildSelectionKeyMap(selectionContext, feature.id);
  if (!bodyKeys) {
    if (storedOcctEdgeRefs.length > 0) {
      const resolvedFromRefs = resolveLegacyEdgeKeysFromOcctRefs(selectionContext, storedOcctEdgeRefs);
      if (resolvedFromRefs.length > 0) {
        if (updateFeature) feature.edgeKeys = resolvedFromRefs;
        return resolvedFromRefs;
      }
    }
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
      if (storedOcctEdgeRefs.length > 0) {
        const resolvedFromRefs = resolveLegacyEdgeKeysFromOcctRefs(selectionContext, storedOcctEdgeRefs);
        if (resolvedFromRefs.length > 0) {
          if (updateFeature) feature.edgeKeys = resolvedFromRefs;
          return resolvedFromRefs;
        }
      }
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

function sanitizeOcctEdgeRefs(refs) {
  return uniqueOcctEdgeRefs((Array.isArray(refs) ? refs : []).map((ref) => toOcctEdgeRef(ref)).filter(Boolean));
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

function sampleTopoEdgePoints(edge, segments = 64) {
  if (!edge) return [];
  const curve = edge.curve || null;
  const isLinear = !curve || (
    curve.degree === 1
    && Array.isArray(curve.controlPoints)
    && curve.controlPoints.length === 2
  );
  const sampleCount = isLinear ? 1 : segments;
  return _legacyTopoEdgeSampler.sampleEdge(edge, sampleCount).map((point) => ({
    x: Number(point.x),
    y: Number(point.y),
    z: Number(point.z),
  }));
}

function pointLiesOnSampledEdge(point, samples, tolerance = 5e-2) {
  if (!point || !Array.isArray(samples) || samples.length < 2) return false;
  for (let index = 0; index < samples.length - 1; index += 1) {
    if (pointLiesOnEdge(point, { start: samples[index], end: samples[index + 1] }, tolerance)) {
      return true;
    }
  }
  return false;
}

function legacyKeyMatchesTopoEdge(key, edge, tolerance = 5e-2) {
  const parsed = parseLegacyEdgeKey(key);
  if (!parsed) return false;
  const samples = sampleTopoEdgePoints(edge, 64);
  if (samples.length < 2) return false;
  return pointLiesOnSampledEdge(parsed.start, samples, tolerance)
    && pointLiesOnSampledEdge(parsed.end, samples, tolerance);
}

function pointLiesOnEdge(point, edge, tolerance = 1e-3) {
  if (!point || !edge?.start || !edge?.end) return false;
  const tolSq = tolerance * tolerance;
  if (pointDistanceSquared(point, edge.start) <= tolSq) return true;
  if (pointDistanceSquared(point, edge.end) <= tolSq) return true;

  const abx = edge.end.x - edge.start.x;
  const aby = edge.end.y - edge.start.y;
  const abz = edge.end.z - edge.start.z;
  const apx = point.x - edge.start.x;
  const apy = point.y - edge.start.y;
  const apz = point.z - edge.start.z;
  const abLen2 = abx * abx + aby * aby + abz * abz;
  if (abLen2 < 1e-14) return false;

  const t = (apx * abx + apy * aby + apz * abz) / abLen2;
  if (t < -1e-4 || t > 1 + 1e-4) return false;

  const projX = edge.start.x + t * abx;
  const projY = edge.start.y + t * aby;
  const projZ = edge.start.z + t * abz;
  return pointDistanceSquared(point, { x: projX, y: projY, z: projZ }) <= tolSq;
}

function legacyKeyMatchesPath(key, path, nativeEdges, tolerance = 1e-3) {
  const parsed = parseLegacyEdgeKey(key);
  if (!parsed || !Array.isArray(path?.edgeIndices) || path.edgeIndices.length === 0) return false;

  let startMatched = false;
  let endMatched = false;
  for (const edgeIndex of path.edgeIndices) {
    const edge = nativeEdges[edgeIndex];
    if (!edge) continue;
    if (!startMatched && pointLiesOnEdge(parsed.start, edge, tolerance)) startMatched = true;
    if (!endMatched && pointLiesOnEdge(parsed.end, edge, tolerance)) endMatched = true;
    if (startMatched && endMatched) return true;
  }

  return false;
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

function occtEntityMatchesRef(entity, edgeRef) {
  if (!entity || !edgeRef) return false;
  const entityStableHash = typeof entity.stableHash === 'string' && entity.stableHash.length > 0
    ? entity.stableHash
    : (typeof entity.hash === 'string' && entity.hash.length > 0 ? entity.hash : null);
  const entityTopoId = Number.isInteger(entity.topoId)
    ? entity.topoId
    : (Number.isInteger(entity.id) ? entity.id : null);
  if (edgeRef.stableHash && entityStableHash === edgeRef.stableHash) return true;
  if (Number.isInteger(edgeRef.topoId) && entityTopoId === edgeRef.topoId) return true;
  return false;
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

function selectionNativeOcctEdges(selectionContext) {
  const geometry = selectionContext?.geometry;
  if (Array.isArray(geometry?._selectionCompatOcctFeatureEdges) && geometry._selectionCompatOcctFeatureEdges.length > 0) {
    return geometry._selectionCompatOcctFeatureEdges;
  }
  if (Array.isArray(geometry?._occtFeatureEdges) && geometry._occtFeatureEdges.length > 0) {
    return geometry._occtFeatureEdges;
  }
  return Array.isArray(geometry?.edges) ? geometry.edges : [];
}

function selectionNativeOcctPaths(selectionContext) {
  const geometry = selectionContext?.geometry;
  if (Array.isArray(geometry?._selectionCompatOcctFeaturePaths) && hasOcctEdgeRef(geometry._selectionCompatOcctFeaturePaths)) {
    return geometry._selectionCompatOcctFeaturePaths;
  }
  if (Array.isArray(geometry?._occtFeaturePaths) && hasOcctEdgeRef(geometry._occtFeaturePaths)) {
    return geometry._occtFeaturePaths;
  }
  if (Array.isArray(geometry?.paths) && hasOcctEdgeRef(geometry.paths)) {
    return geometry.paths;
  }
  return [];
}

function topoBodyEdges(selectionContext) {
  const topoBody = selectionContext?.body || selectionContext?.solid?.body || selectionContext?.geometry?.topoBody || null;
  if (!topoBody || typeof topoBody.edges !== 'function') return [];
  return [...topoBody.edges()];
}

function resolveLegacyEdgeKeysFromOcctRefs(selectionContext, edgeRefs) {
  const normalizedRefs = sanitizeOcctEdgeRefs(edgeRefs);
  if (normalizedRefs.length === 0) return [];

  const nativeEdges = selectionNativeOcctEdges(selectionContext);
  const nativePaths = selectionNativeOcctPaths(selectionContext);
  const resolvedKeys = [];

  for (const edgeRef of normalizedRefs) {
    const matchedPath = nativePaths.find((path) => occtEntityMatchesRef(path, edgeRef));
    if (matchedPath) {
      resolvedKeys.push(...collectOcctPathLegacyKeys(matchedPath, nativeEdges));
      continue;
    }

    const matchedNativeEdge = nativeEdges.find((edge) => occtEntityMatchesRef(edge, edgeRef));
    if (matchedNativeEdge) {
      const legacyKey = edgeEntityToLegacyKey(matchedNativeEdge);
      if (legacyKey) resolvedKeys.push(legacyKey);
      continue;
    }

    const matchedTopoEdge = topoBodyEdges(selectionContext).find((edge) => occtEntityMatchesRef(edge, edgeRef));
    if (matchedTopoEdge) {
      const legacyKey = edgeEntityToLegacyKey(matchedTopoEdge);
      if (legacyKey) resolvedKeys.push(legacyKey);
    }
  }

  return [...new Set(resolvedKeys)];
}

function resolveOcctFeatureChainRefs(selectionContext, fallbackEdgeKeys) {
  if (!Array.isArray(fallbackEdgeKeys) || fallbackEdgeKeys.length === 0) return [];

  const geometry = selectionContext?.geometry;
  const compatOcctEdges = Array.isArray(geometry?._selectionCompatOcctFeatureEdges) && geometry._selectionCompatOcctFeatureEdges.length > 0
    ? geometry._selectionCompatOcctFeatureEdges
    : null;
  const compatOcctPaths = Array.isArray(geometry?._selectionCompatOcctFeaturePaths) && geometry._selectionCompatOcctFeaturePaths.length > 0
    ? geometry._selectionCompatOcctFeaturePaths
    : null;
  const nativeEdges = Array.isArray(compatOcctEdges) && compatOcctEdges.length > 0
    ? compatOcctEdges
    : (Array.isArray(geometry?._occtFeatureEdges) && geometry._occtFeatureEdges.length > 0
      ? geometry._occtFeatureEdges
      : (Array.isArray(geometry?.edges) ? geometry.edges : []));
  const nativePaths = hasOcctEdgeRef(compatOcctPaths)
    ? compatOcctPaths
    : (hasOcctEdgeRef(geometry?._occtFeaturePaths)
      ? geometry._occtFeaturePaths
      : (hasOcctEdgeRef(geometry?.paths) ? geometry.paths : []));
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
    const exactMatch = collectOcctPathLegacyKeys(path, nativeEdges)
      .some((legacyKey) => wanted.has(legacyKey));
    const matched = exactMatch || fallbackEdgeKeys.some((legacyKey) => legacyKeyMatchesPath(legacyKey, path, nativeEdges));
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

  if (refs.length === 0) {
    for (const edge of topoBodyEdges(selectionContext)) {
      const ref = toOcctEdgeRef(edge);
      if (!ref) continue;
      const matched = fallbackEdgeKeys.some((legacyKey) => legacyKeyMatchesTopoEdge(legacyKey, edge));
      if (!matched) continue;
      refs.push(ref);
    }
  }

  return uniqueOcctEdgeRefs(refs);
}

export function resolveOcctEdgeRefsFromSelectionContext(selectionContext, legacyKeys = []) {
  const fallbackEdgeKeys = Array.isArray(legacyKeys) && legacyKeys.length > 0
    ? [...new Set(legacyKeys)]
    : [];
  if (fallbackEdgeKeys.length === 0) return [];

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
  return geometryRefs.length > 0 ? uniqueOcctEdgeRefs(geometryRefs) : [];
}

function resolveStoredOcctEdgeRefs(feature, selectionContext) {
  const directRefs = sanitizeOcctEdgeRefs(feature?.occtEdgeRefs);
  if (directRefs.length > 0) return directRefs;

  const resolvedLegacyKeys = resolveLegacyEdgeKeysFromOcctRefs(selectionContext, feature?.occtEdgeRefs);
  if (resolvedLegacyKeys.length === 0) return [];
  return resolveOcctEdgeRefsFromSelectionContext(selectionContext, resolvedLegacyKeys);
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
    this.occtEdgeRefs = [];
    this.occtSpec = null;
    // Whether this feature result was produced by the exact topology path
    this._resultExact = false;
  }

  getCbrepCacheVersion() {
    return 'fillet-exact-brep-v3-rolling-curved-chains';
  }

  execute(context) {
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
    let occtRestoreError = null;
    const occtCheckpoint = occtInputGeometry?.occtCheckpoint || sourceResult?.occtCheckpoint || null;
    let restoredSelectionRetry = null;

    if (!(occtInputGeometry?.occtShapeHandle > 0)) {
      if (occtCheckpoint) {
        try {
          const restored = ensureOcctGeometryResidentFromCheckpoint(occtInputGeometry, occtCheckpoint);
          if (restored?.geometry?.occtShapeHandle > 0) {
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
    }

    const hadOcctInput = occtInputGeometry?.occtShapeHandle > 0;
    let occtGeometry = null;
    const selectedOcctEdgeRefs = hadOcctInput
      ? this._resolveSelectedOcctEdgeRefs(selectionContext, edgeKeys)
      : [];
    occtGeometry = hadOcctInput
      ? tryBuildOcctFilletMetadataSync({
        handle: occtInputGeometry.occtShapeHandle,
        edgeRefs: selectedOcctEdgeRefs,
        radius: this.radius,
        spec: this.buildOcctSpec(selectedOcctEdgeRefs),
        sourceTopology: occtInputGeometry?._occtModeling?.topology || null,
        topoBody: inputTopoBody,
      })
      : null;

    if (!occtGeometry && hadOcctInput && occtCheckpoint) {
      try {
        const retryMeshSnapshot = this._buildRetryMeshSnapshot(occtInputGeometry, sourceResult?.geometry || null);
        restoredSelectionRetry = restoreOcctSketchModelingCheckpoint(occtCheckpoint, null, retryMeshSnapshot);
        if (restoredSelectionRetry?.geometry?.occtShapeHandle > 0) {
          this._copySelectionCompatGeometry(occtInputGeometry, restoredSelectionRetry.geometry);
          const retrySelectionContext = {
            ...solid,
            geometry: restoredSelectionRetry.geometry,
            body: solid.body || restoredSelectionRetry.geometry.topoBody || null,
          };
          const retryOcctEdgeRefs = this._resolveSelectedOcctEdgeRefs(retrySelectionContext, edgeKeys);
          occtGeometry = retryOcctEdgeRefs.length > 0
            ? tryBuildOcctFilletMetadataSync({
              handle: restoredSelectionRetry.geometry.occtShapeHandle,
              edgeRefs: retryOcctEdgeRefs,
              radius: this.radius,
              spec: this.buildOcctSpec(retryOcctEdgeRefs),
              sourceTopology: restoredSelectionRetry.geometry?._occtModeling?.topology || null,
              topoBody: inputTopoBody,
            })
            : null;
        }
      } catch (error) {
        if (!occtRestoreError) {
          occtRestoreError = error;
        }
      } finally {
        if (restoredSelectionRetry?.geometry) {
          this._disposeTemporaryOcctGeometry(restoredSelectionRetry.geometry, occtGeometry?.occtShapeHandle || 0);
        }
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

    const restoreMessage = occtRestoreError
      ? `Failed to restore the upstream OCCT checkpoint: ${occtRestoreError?.message || String(occtRestoreError)}`
      : (hadOcctInput
        ? 'The OCCT fillet operation did not produce a replacement shape for the selected edges.'
        : 'No resident or restorable OCCT handle was available on the input solid.');
    throw new Error(
      `[OCCT-only] FilletFeature requires resident or restorable OCCT geometry. ${restoreMessage}`
    );
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

  _copySelectionCompatGeometry(sourceGeometry, targetGeometry) {
    if (!sourceGeometry || !targetGeometry) return;
    if ((!Array.isArray(targetGeometry._selectionCompatEdges) || targetGeometry._selectionCompatEdges.length === 0)
        && Array.isArray(sourceGeometry._selectionCompatEdges)) {
      targetGeometry._selectionCompatEdges = sourceGeometry._selectionCompatEdges;
    }
    if ((!Array.isArray(targetGeometry._selectionCompatPaths) || targetGeometry._selectionCompatPaths.length === 0)
        && Array.isArray(sourceGeometry._selectionCompatPaths)) {
      targetGeometry._selectionCompatPaths = sourceGeometry._selectionCompatPaths;
    }
    if ((!Array.isArray(targetGeometry._selectionCompatOcctFeatureEdges) || targetGeometry._selectionCompatOcctFeatureEdges.length === 0)
        && Array.isArray(sourceGeometry._selectionCompatOcctFeatureEdges)) {
      targetGeometry._selectionCompatOcctFeatureEdges = sourceGeometry._selectionCompatOcctFeatureEdges;
    }
    if ((!Array.isArray(targetGeometry._selectionCompatOcctFeaturePaths) || targetGeometry._selectionCompatOcctFeaturePaths.length === 0)
        && Array.isArray(sourceGeometry._selectionCompatOcctFeaturePaths)) {
      targetGeometry._selectionCompatOcctFeaturePaths = sourceGeometry._selectionCompatOcctFeaturePaths;
    }
  }

  _buildRetryMeshSnapshot(primaryGeometry, fallbackGeometry = null) {
    const primarySnapshot = cloneOcctCheckpointMeshSnapshot(primaryGeometry);
    if (primarySnapshot?.faces?.length) return primarySnapshot;
    const fallbackSnapshot = cloneOcctCheckpointMeshSnapshot(fallbackGeometry);
    return fallbackSnapshot?.faces?.length ? fallbackSnapshot : null;
  }

  _disposeTemporaryOcctGeometry(geometry, keepHandle = 0) {
    const handle = geometry?.occtShapeHandle || 0;
    if (!handle || handle === keepHandle) return;
    disposeOcctSketchModelingShape(handle);
    geometry.occtShapeHandle = 0;
    geometry.occtShapeResident = false;
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
    const storedRefs = resolveStoredOcctEdgeRefs(feature, selectionContext);
    if (storedRefs.length > 0) return storedRefs;

    const fallbackEdgeKeys = Array.isArray(legacyKeys) && legacyKeys.length > 0
      ? [...new Set(legacyKeys)]
      : (Array.isArray(feature.edgeKeys) ? [...feature.edgeKeys] : []);
    const directRefs = resolveOcctEdgeRefsFromSelectionContext(selectionContext, fallbackEdgeKeys);
    if (directRefs.length > 0) return directRefs;

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
    this.stableEdgeKeys = this.edgeKeys
      .filter((key) => isLegacyEdgeKey(key))
      .map((key) => legacyEdgeKeyToStable(key, this.id || ''))
      .filter((key) => key !== null);
    this.modified = new Date();
  }

  setOcctEdgeRefs(edgeRefs) {
    this.occtEdgeRefs = sanitizeOcctEdgeRefs(edgeRefs);
    this.modified = new Date();
  }

  setOcctSpec(spec) {
    this.occtSpec = spec && typeof spec === 'object' ? cloneJsonLike(spec) : null;
    this.modified = new Date();
  }

  buildOcctSpec(edgeRefs = []) {
    const normalizedEdgeRefs = Array.isArray(edgeRefs) ? edgeRefs.filter((edgeRef) => !!edgeRef) : [];
    const baseSpec = buildDefaultFilletOcctSpec(normalizedEdgeRefs, this.radius);
    if (!this.occtSpec || typeof this.occtSpec !== 'object') return baseSpec;
    return cleanEffectiveFilletSpec(mergeJsonLike(baseSpec, this.occtSpec));
  }

  serialize() {
    return {
      ...super.serialize(),
      radius: this.radius,
      segments: this.segments,
      edgeKeys: [...this.edgeKeys],
      stableEdgeKeys: [...this.stableEdgeKeys],
      occtEdgeRefs: sanitizeOcctEdgeRefs(this.occtEdgeRefs),
      occtSpec: this.occtSpec && typeof this.occtSpec === 'object' ? cloneJsonLike(this.occtSpec) : this.occtSpec,
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
    feature.occtEdgeRefs = sanitizeOcctEdgeRefs(data.occtEdgeRefs);
    feature.occtSpec = data.occtSpec && typeof data.occtSpec === 'object' ? cloneJsonLike(data.occtSpec) : null;
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

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
import { ensureOcctGeometryResidentFromCheckpoint, tryBuildOcctChamferMetadataSync } from './occt/OcctSketchModeling.js';
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

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

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

function buildDefaultChamferOcctSpec(edgeRefs, distance) {
  const normalizedDistance = Number(distance) || 0;
  return {
    schemaVersion: 1,
    unit: { length: 'model', angle: 'radians' },
    mode: 'symmetric',
    distance: normalizedDistance,
    edges: edgeRefs.map((edgeRef) => {
      const topoFaceIds = Array.isArray(edgeRef?.topoFaceIds)
        ? edgeRef.topoFaceIds.filter((value) => Number.isInteger(value) && value > 0)
        : [];
      return {
        edge: cloneJsonLike(edgeRef),
        mode: 'symmetric',
        distance: normalizedDistance,
        ...(topoFaceIds.length > 0 ? { referenceFace: { topoId: topoFaceIds[0] } } : {}),
      };
    }),
  };
}

function cleanChamferReferenceFace(face) {
  if (!isPlainObject(face)) return null;
  const cleaned = {};
  if (typeof face.stableHash === 'string' && face.stableHash.length > 0) {
    cleaned.stableHash = face.stableHash;
  }
  const topoId = Number(face.topoId);
  if (Number.isFinite(topoId)) cleaned.topoId = Math.trunc(topoId);
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

function cleanChamferLimits(limits) {
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

function cleanChamferAngleFields(target) {
  if (!isPlainObject(target)) return;
  const angleDegrees = Number(target.angleDegrees);
  const angleRadians = Number(target.angleRadians);
  if (Number.isFinite(angleDegrees)) {
    target.angleDegrees = angleDegrees;
    delete target.angleRadians;
    return;
  }
  if (Number.isFinite(angleRadians)) {
    target.angleRadians = angleRadians;
    delete target.angleDegrees;
    return;
  }
  delete target.angleDegrees;
  delete target.angleRadians;
}

function cleanEffectiveChamferSpec(spec) {
  const cleaned = mergeJsonLike({}, spec);
  const mode = cleaned.mode || 'symmetric';
  const angleUnit = cleaned.unit?.angle === 'degrees' ? 'degrees' : 'radians';

  if (mode !== 'twoDistance') {
    delete cleaned.distance1;
    delete cleaned.distance2;
  }
  if (mode !== 'distanceAngle') {
    delete cleaned.angleDegrees;
    delete cleaned.angleRadians;
    delete cleaned.referenceFace;
  } else {
    cleanChamferAngleFields(cleaned);
    cleaned.referenceFace = cleanChamferReferenceFace(cleaned.referenceFace);
    if (!cleaned.referenceFace) delete cleaned.referenceFace;
  }

  cleaned.limits = cleanChamferLimits(cleaned.limits);
  if (!cleaned.limits) delete cleaned.limits;

  if (Array.isArray(cleaned.edges)) {
    cleaned.edges = cleaned.edges.map((edge) => {
      if (!isPlainObject(edge)) return edge;
      const nextEdge = mergeJsonLike({}, edge);
      const edgeMode = nextEdge.mode || mode;
      if (edgeMode !== 'twoDistance') {
        delete nextEdge.distance1;
        delete nextEdge.distance2;
      }
      if (edgeMode !== 'distanceAngle') {
        delete nextEdge.angleDegrees;
        delete nextEdge.angleRadians;
        delete nextEdge.referenceFace;
      } else {
        cleanChamferAngleFields(nextEdge);
        nextEdge.referenceFace = cleanChamferReferenceFace(nextEdge.referenceFace);
        if (!nextEdge.referenceFace) delete nextEdge.referenceFace;
      }
      nextEdge.limits = cleanChamferLimits(nextEdge.limits);
      if (!nextEdge.limits) delete nextEdge.limits;
      return nextEdge;
    });
  }

  return cleaned;
}

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
  const topoFaceIds = Array.isArray(entity.topoFaceIds)
    ? entity.topoFaceIds.filter((value) => Number.isInteger(value) && value > 0)
    : [];
  if (!stableHash && topoId == null) return null;
  return {
    ...(stableHash ? { stableHash } : {}),
    ...(topoId != null ? { topoId } : {}),
    ...(topoFaceIds.length > 0 ? { topoFaceIds } : {}),
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
    if (!(solid.geometry?.occtShapeHandle > 0) && solid.geometry?.occtCheckpoint) {
      ensureOcctGeometryResidentFromCheckpoint(solid.geometry);
    }
    const selectedOcctEdgeRefs = solid.geometry?.occtShapeHandle > 0
      ? this._resolveSelectedOcctEdgeRefs(solid, selectedEdgeKeys)
      : [];
    const occtGeometry = solid.geometry?.occtShapeHandle > 0
      ? tryBuildOcctChamferMetadataSync({
        handle: solid.geometry.occtShapeHandle,
        edgeRefs: selectedOcctEdgeRefs,
        distance: this.distance,
        spec: this.buildOcctSpec(selectedOcctEdgeRefs),
        sourceTopology: solid.geometry?._occtModeling?.topology || null,
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

  setOcctSpec(spec) {
    this.occtSpec = spec && typeof spec === 'object' ? cloneJsonLike(spec) : null;
    this.modified = new Date();
  }

  buildOcctSpec(edgeRefs = []) {
    const normalizedEdgeRefs = Array.isArray(edgeRefs) ? edgeRefs.filter((edgeRef) => !!edgeRef) : [];
    const baseSpec = buildDefaultChamferOcctSpec(normalizedEdgeRefs, this.distance);
    if (!this.occtSpec || typeof this.occtSpec !== 'object') return baseSpec;
    return cleanEffectiveChamferSpec(mergeJsonLike(baseSpec, this.occtSpec));
  }

  serialize() {
    return {
      ...super.serialize(),
      distance: this.distance,
      edgeKeys: [...this.edgeKeys],
      stableEdgeKeys: [...this.stableEdgeKeys],
      occtSpec: this.occtSpec && typeof this.occtSpec === 'object' ? cloneJsonLike(this.occtSpec) : this.occtSpec,
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

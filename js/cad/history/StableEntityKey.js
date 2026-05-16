// js/cad/history/StableEntityKey.js — Stable entity reference keys
//
// Provides deterministic, topology-derived keys for faces, edges, and
// vertices so that selections survive history replay, save/load, and
// upstream parameter edits.
//
// Key anatomy:
//   <version>:<entityType>:<geometrySignature>:<provenance>
//
// Keys must NOT depend on:
//   - object identity / memory address
//   - iteration order or array index
//   - transient topo-id counters
//
// Keys SHOULD be stable across:
//   - repeated recompute of the same model
//   - save/load roundtrip
//   - deterministic workflow replay
//
// Versioning: keys start with "sek1:" to allow future schema changes.

import { makeEdgeKey } from '../EdgeAnalysis.js';

const KEY_VERSION = 'sek1';
const PRECISION = 5;

// -----------------------------------------------------------------------
// Geometry signature helpers
// -----------------------------------------------------------------------

function _snapCoord(v) {
  return +v.toFixed(PRECISION);
}

function _pointSig(p) {
  return `${_snapCoord(p.x)},${_snapCoord(p.y)},${_snapCoord(p.z)}`;
}

function _parsePointSig(text) {
  if (typeof text !== 'string') return null;
  const coords = text.split(',').map(Number);
  if (coords.length !== 3 || coords.some((value) => Number.isNaN(value))) return null;
  return { x: coords[0], y: coords[1], z: coords[2] };
}

function _normalizeGeomSig(entityType, geomSig) {
  if (typeof geomSig !== 'string') return geomSig;
  if (entityType === EntityType.VERTEX) {
    const point = _parsePointSig(geomSig);
    return point ? vertexGeomSig(point) : geomSig;
  }
  if (entityType === EntityType.EDGE) {
    const parts = geomSig.split('|');
    if (parts.length !== 2) return geomSig;
    const start = _parsePointSig(parts[0]);
    const end = _parsePointSig(parts[1]);
    return start && end ? edgeGeomSig(start, end) : geomSig;
  }
  return geomSig;
}

/**
 * Geometry signature for a vertex (its snapped position).
 * @param {{x:number,y:number,z:number}} point
 * @returns {string}
 */
function vertexGeomSig(point) {
  return _pointSig(point);
}

/**
 * Geometry signature for an edge (sorted endpoint positions).
 * Sorting makes the key direction-independent.
 * @param {{x:number,y:number,z:number}} startPoint
 * @param {{x:number,y:number,z:number}} endPoint
 * @returns {string}
 */
function edgeGeomSig(startPoint, endPoint) {
  const a = _pointSig(startPoint);
  const b = _pointSig(endPoint);
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Geometry signature for a face (surface type + centroid of outer loop
 * vertices). This is lightweight and deterministic for analytic faces.
 * @param {string} surfaceType
 * @param {Array<{x:number,y:number,z:number}>} outerLoopPoints
 * @returns {string}
 */
function faceGeomSig(surfaceType, outerLoopPoints) {
  if (!outerLoopPoints || outerLoopPoints.length === 0) {
    return `${surfaceType}:empty`;
  }
  // Centroid of outer loop
  let cx = 0, cy = 0, cz = 0;
  for (const p of outerLoopPoints) {
    cx += p.x; cy += p.y; cz += p.z;
  }
  const n = outerLoopPoints.length;
  cx /= n; cy /= n; cz /= n;
  return `${surfaceType}:c${_snapCoord(cx)},${_snapCoord(cy)},${_snapCoord(cz)}:n${n}`;
}

// -----------------------------------------------------------------------
// StableEntityKey — public API
// -----------------------------------------------------------------------

/**
 * Entity type prefixes for stable keys.
 */
export const EntityType = Object.freeze({
  FACE: 'F',
  EDGE: 'E',
  VERTEX: 'V',
});

/**
 * Build a stable key for a TopoVertex.
 * @param {{point:{x:number,y:number,z:number}}} vertex
 * @param {string} [provenance=''] - Origin context (e.g. feature id)
 * @returns {string}
 */
export function vertexKey(vertex, provenance = '') {
  const sig = vertexGeomSig(vertex.point);
  return `${KEY_VERSION}:${EntityType.VERTEX}:${sig}:${provenance}`;
}

/**
 * Build a stable key for a TopoEdge.
 * @param {{startVertex:{point:{x,y,z}}, endVertex:{point:{x,y,z}}}} edge
 * @param {string} [provenance=''] - Origin context
 * @returns {string}
 */
export function edgeKey(edge, provenance = '') {
  const sig = edgeGeomSig(edge.startVertex.point, edge.endVertex.point);
  return `${KEY_VERSION}:${EntityType.EDGE}:${sig}:${provenance}`;
}

/**
 * Build a stable key for a TopoFace.
 * @param {Object} face - TopoFace with surfaceType, outerLoop
 * @param {string} [provenance=''] - Origin context
 * @returns {string}
 */
export function faceKey(face, provenance = '') {
  const pts = face.outerLoop ? face.outerLoop.points() : [];
  const sig = faceGeomSig(face.surfaceType || 'unknown', pts);
  return `${KEY_VERSION}:${EntityType.FACE}:${sig}:${provenance}`;
}

/**
 * Parse a stable entity key into its components.
 * @param {string} key
 * @returns {{ version:string, entityType:string, geomSig:string, provenance:string }|null}
 */
export function parseKey(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split(':');
  if (parts.length < 4) return null;
  return {
    version: parts[0],
    entityType: parts[1],
    geomSig: parts.slice(2, parts.length - 1).join(':'),
    provenance: parts[parts.length - 1],
  };
}

/**
 * Check whether a string looks like a stable entity key.
 * @param {string} key
 * @returns {boolean}
 */
export function isStableKey(key) {
  if (typeof key !== 'string') return false;
  return key.startsWith(KEY_VERSION + ':');
}

/**
 * Check whether a string is a legacy position-based edge key
 * (format: "x1,y1,z1|x2,y2,z2").
 * @param {string} key
 * @returns {boolean}
 */
export function isLegacyEdgeKey(key) {
  if (typeof key !== 'string') return false;
  if (isStableKey(key)) return false;
  const idx = key.indexOf('|');
  if (idx < 0) return false;
  const parts = key.split('|');
  if (parts.length !== 2) return false;
  return parts[0].split(',').length === 3 && parts[1].split(',').length === 3;
}

// -----------------------------------------------------------------------
// Keying a full TopoBody
// -----------------------------------------------------------------------

/**
 * Compute a Map of stable entity keys for every face, edge, and vertex
 * in a TopoBody.
 *
 * @param {Object} topoBody - A TopoBody (with shells[].faces[])
 * @param {string} [provenance=''] - Feature provenance tag
 * @returns {{ faces: Map<string,Object>, edges: Map<string,Object>, vertices: Map<string,Object> }}
 */
export function keyBody(topoBody, provenance = '') {
  const faces = new Map();
  const edges = new Map();
  const vertices = new Map();

  if (!topoBody || !topoBody.shells) return { faces, edges, vertices };

  for (const shell of topoBody.shells) {
    for (const face of shell.faces) {
      const fk = faceKey(face, provenance);
      faces.set(fk, face);

      for (const edge of face.edges()) {
        const ek = edgeKey(edge, provenance);
        if (!edges.has(ek)) edges.set(ek, edge);
      }
      for (const vert of face.vertices()) {
        const vk = vertexKey(vert, provenance);
        if (!vertices.has(vk)) vertices.set(vk, vert);
      }
    }
  }

  return { faces, edges, vertices };
}

/**
 * Compute a Map of stable edge keys for a geometry edge-segment array.
 * Useful when an OCCT-native result has semantic edges but no JS TopoBody.
 *
 * @param {Array<{start:{x:number,y:number,z:number},end:{x:number,y:number,z:number}}>} edgeSegments
 * @param {string} [provenance='']
 * @returns {{ faces: Map<string,Object>, edges: Map<string,Object>, vertices: Map<string,Object> }}
 */
export function keyEdgeSegments(edgeSegments, provenance = '') {
  const faces = new Map();
  const edges = new Map();
  const vertices = new Map();

  if (!Array.isArray(edgeSegments)) return { faces, edges, vertices };

  for (const edge of edgeSegments) {
    if (!edge?.start || !edge?.end) continue;
    const sig = edgeGeomSig(edge.start, edge.end);
    const key = `${KEY_VERSION}:${EntityType.EDGE}:${sig}:${provenance}`;
    if (!edges.has(key)) edges.set(key, edge);
  }

  return { faces, edges, vertices };
}

function _extractTopoBodyFromSelectionContext(selectionContext) {
  if (!selectionContext) return null;
  if (selectionContext.body) return selectionContext.body;
  if (selectionContext.solid?.body) return selectionContext.solid.body;
  if (selectionContext.brep?.shells) return selectionContext.brep;
  return null;
}

function _extractGeometryFromSelectionContext(selectionContext) {
  if (!selectionContext) return null;
  if (selectionContext.geometry) return selectionContext.geometry;
  if (selectionContext.solid?.geometry) return selectionContext.solid.geometry;
  return null;
}

/**
 * Build a stable-key lookup map for either a TopoBody-backed solid result or
 * an OCCT-style geometry edge list.
 *
 * @param {Object|null} selectionContext
 * @param {string} [provenance='']
 * @returns {{ faces: Map<string,Object>, edges: Map<string,Object>, vertices: Map<string,Object> }|null}
 */
export function buildSelectionKeyMap(selectionContext, provenance = '') {
  const topoBody = _extractTopoBodyFromSelectionContext(selectionContext) || selectionContext;
  if (topoBody?.shells) {
    return keyBody(topoBody, provenance);
  }

  const geometry = _extractGeometryFromSelectionContext(selectionContext) || selectionContext?.geometry || null;
  if (Array.isArray(geometry?.edges) && geometry.edges.length > 0) {
    return keyEdgeSegments(geometry.edges, provenance);
  }

  return null;
}

/**
 * Convert a resolved edge entity back into the legacy edge-key string format
 * expected by the exact chamfer/fillet kernels.
 *
 * @param {Object|null} entity
 * @returns {string|null}
 */
export function edgeEntityToLegacyKey(entity) {
  if (!entity) return null;
  if (entity.startVertex?.point && entity.endVertex?.point) {
    return makeEdgeKey(entity.startVertex.point, entity.endVertex.point);
  }
  if (entity.start && entity.end) {
    return makeEdgeKey(entity.start, entity.end);
  }
  return null;
}

/**
 * Convert a stable edge key back into the legacy edge-key string format using
 * the stored geometry signature alone.
 *
 * @param {string} key
 * @returns {string|null}
 */
export function selectionKeyToLegacyEdgeKey(key) {
  const parsed = parseKey(key);
  if (!parsed || parsed.entityType !== EntityType.EDGE) return null;
  const parts = parsed.geomSig.split('|');
  if (parts.length !== 2) return null;
  const start = _parsePointSig(parts[0]);
  const end = _parsePointSig(parts[1]);
  if (!start || !end) return null;
  return makeEdgeKey(start, end);
}

// -----------------------------------------------------------------------
// Entity lookup / remap
// -----------------------------------------------------------------------

/**
 * Remap result status.
 */
export const RemapStatus = Object.freeze({
  EXACT: 'exact',
  REMAPPED: 'remapped',
  MISSING: 'missing',
  AMBIGUOUS: 'ambiguous',
});

/**
 * Try to resolve a stored stable entity key against a current TopoBody.
 *
 * Resolution strategy:
 *  1. Exact key match in current body key map → EXACT
 *  2. Match by geometry signature alone (ignoring provenance) → REMAPPED
 *  3. Multiple geometry-sig matches → AMBIGUOUS
 *  4. No match → MISSING
 *
 * @param {string} storedKey - Previously persisted entity key
 * @param {{ faces:Map, edges:Map, vertices:Map }} bodyKeyMap - from keyBody()
 * @returns {{ status:string, entity:Object|null, key:string|null, reason?:string }}
 */
export function resolveKey(storedKey, bodyKeyMap) {
  const parsed = parseKey(storedKey);
  if (!parsed) {
    return { status: RemapStatus.MISSING, entity: null, key: null, reason: 'unparseable key' };
  }
  const normalizedStoredGeomSig = _normalizeGeomSig(parsed.entityType, parsed.geomSig);

  // Choose the right map based on entity type
  let map;
  if (parsed.entityType === EntityType.FACE) map = bodyKeyMap.faces;
  else if (parsed.entityType === EntityType.EDGE) map = bodyKeyMap.edges;
  else if (parsed.entityType === EntityType.VERTEX) map = bodyKeyMap.vertices;
  else return { status: RemapStatus.MISSING, entity: null, key: null, reason: 'unknown entity type' };

  // 1. Exact match
  if (map.has(storedKey)) {
    return { status: RemapStatus.EXACT, entity: map.get(storedKey), key: storedKey };
  }

  // 2. Geometry-signature match with normalized numeric formatting.
  const exactCandidates = [];
  const remapCandidates = [];
  for (const [k, ent] of map) {
    const kParsed = parseKey(k);
    if (!kParsed) continue;
    if (_normalizeGeomSig(kParsed.entityType, kParsed.geomSig) !== normalizedStoredGeomSig) continue;
    if (kParsed.provenance === parsed.provenance) {
      exactCandidates.push({ key: k, entity: ent });
    } else {
      remapCandidates.push({ key: k, entity: ent });
    }
  }

  if (exactCandidates.length === 1) {
    return { status: RemapStatus.EXACT, entity: exactCandidates[0].entity, key: exactCandidates[0].key };
  }
  if (exactCandidates.length > 1) {
    return { status: RemapStatus.AMBIGUOUS, entity: null, key: null, reason: `${exactCandidates.length} exact geometry matches` };
  }

  if (remapCandidates.length === 1) {
    return { status: RemapStatus.REMAPPED, entity: remapCandidates[0].entity, key: remapCandidates[0].key, reason: 'provenance changed' };
  }
  if (remapCandidates.length > 1) {
    return { status: RemapStatus.AMBIGUOUS, entity: null, key: null, reason: `${remapCandidates.length} geometry matches` };
  }

  return { status: RemapStatus.MISSING, entity: null, key: null, reason: 'no geometry match' };
}

/**
 * Convert a legacy position-based edge key to a stable edge key.
 * @param {string} legacyKey - "x1,y1,z1|x2,y2,z2"
 * @param {string} [provenance='']
 * @returns {string|null} Stable edge key, or null if the input is not a valid legacy key
 */
export function legacyEdgeKeyToStable(legacyKey, provenance = '') {
  const sep = legacyKey.indexOf('|');
  if (sep < 0) return null;
  const start = _parsePointSig(legacyKey.slice(0, sep));
  const end = _parsePointSig(legacyKey.slice(sep + 1));
  if (!start || !end) return null;
  const sig = edgeGeomSig(start, end);
  return `${KEY_VERSION}:${EntityType.EDGE}:${sig}:${provenance}`;
}

// -----------------------------------------------------------------------
// Serialization helpers
// -----------------------------------------------------------------------

/**
 * Serialize a collection of stable keys to a plain array.
 * @param {string[]} keys
 * @returns {string[]}
 */
export function serializeKeys(keys) {
  return [...keys];
}

/**
 * Deserialize a collection of stable keys.
 * @param {*} data
 * @returns {string[]}
 */
export function deserializeKeys(data) {
  if (!Array.isArray(data)) return [];
  return data.filter(k => typeof k === 'string');
}

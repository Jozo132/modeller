// js/cad/occt/OcctKernelAdapter.js -- small facade over the optional OCCT WASM build.

import { getCachedOcctKernelModule, getOcctKernelStatus, loadOcctKernelModule } from './OcctKernelLoader.js';

const DEFAULT_LINEAR_DEFLECTION = 0.1;
const DEFAULT_ANGULAR_DEFLECTION = 0.5;

function cleanNumber(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.abs(value) < 1e-12 ? 0 : value;
}

function integerOrNull(value) {
  if (!Number.isFinite(value)) return null;
  return Math.trunc(Number(value));
}

function stringOrNull(value) {
  if (value == null) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

function readVec3(flat, index) {
  const offset = index * 3;
  return {
    x: cleanNumber(Number(flat[offset] ?? 0)),
    y: cleanNumber(Number(flat[offset + 1] ?? 0)),
    z: cleanNumber(Number(flat[offset + 2] ?? 0)),
  };
}

function readVec3ish(value) {
  if (Array.isArray(value) && value.length >= 3) {
    return {
      x: cleanNumber(Number(value[0] ?? 0)),
      y: cleanNumber(Number(value[1] ?? 0)),
      z: cleanNumber(Number(value[2] ?? 0)),
    };
  }
  if (value && typeof value === 'object') {
    return {
      x: cleanNumber(Number(value.x ?? 0)),
      y: cleanNumber(Number(value.y ?? 0)),
      z: cleanNumber(Number(value.z ?? 0)),
    };
  }
  return null;
}

function firstArray(source, keys) {
  for (const key of keys) {
    if (Array.isArray(source?.[key])) return source[key];
  }
  return null;
}

function firstObject(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return null;
}

function normalize(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (length < 1e-14) return { x: 0, y: 0, z: 1 };
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function triangleNormal(a, b, c) {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  return normalize({
    x: uy * vz - uz * vy,
    y: uz * vx - ux * vz,
    z: ux * vy - uy * vx,
  });
}

function averageNormal(normals, i0, i1, i2) {
  if (!Array.isArray(normals) || normals.length < Math.max(i0, i1, i2) * 3 + 3) return null;
  return normalize({
    x: Number(normals[i0 * 3] ?? 0) + Number(normals[i1 * 3] ?? 0) + Number(normals[i2 * 3] ?? 0),
    y: Number(normals[i0 * 3 + 1] ?? 0) + Number(normals[i1 * 3 + 1] ?? 0) + Number(normals[i2 * 3 + 1] ?? 0),
    z: Number(normals[i0 * 3 + 2] ?? 0) + Number(normals[i1 * 3 + 2] ?? 0) + Number(normals[i2 * 3 + 2] ?? 0),
  });
}

function dot(a, b) {
  if (!a || !b) return 0;
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function vectorKey(vector) {
  return `${Math.round(vector.x * 1e6)},${Math.round(vector.y * 1e6)},${Math.round(vector.z * 1e6)}`;
}

function uniqueVectors(vectors) {
  const out = [];
  const seen = new Set();
  for (const vector of vectors || []) {
    if (!vector) continue;
    const normalized = normalize(vector);
    const key = vectorKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function normalizeVec3List(value) {
  if (!Array.isArray(value)) {
    const vector = readVec3ish(value);
    return vector ? [normalize(vector)] : [];
  }
  if (value.length === 0) return [];
  if (typeof value[0] === 'number') {
    const out = [];
    for (let offset = 0; offset + 2 < value.length; offset += 3) {
      out.push(normalize(readVec3(value, offset / 3)));
    }
    return out;
  }
  const out = [];
  for (const entry of value) {
    const vector = readVec3ish(entry);
    if (vector) out.push(normalize(vector));
  }
  return out;
}

function pointsCoincident(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < 1e-6
    && Math.abs(a.y - b.y) < 1e-6
    && Math.abs(a.z - b.z) < 1e-6;
}

function parseJson(value, label) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`OCCT ${label} returned invalid JSON: ${error.message}`);
  }
}

function normalizeStepImportMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const text = typeof message.text === 'string'
    ? message.text
    : String(message.text ?? '');
  return {
    phase: typeof message.phase === 'string' ? message.phase : 'unknown',
    severity: typeof message.severity === 'string' ? message.severity : 'info',
    text,
    entityNumber: Number.isInteger(message.entityNumber) ? message.entityNumber : undefined,
  };
}

function normalizeStepImportResult(result) {
  const messageList = Array.isArray(result?.messageList)
    ? result.messageList.map(normalizeStepImportMessage).filter(Boolean)
    : [];
  const shapeHandle = Number.isInteger(result?.shapeHandle) && result.shapeHandle > 0
    ? result.shapeHandle
    : Number.isInteger(result?.shapeId) && result.shapeId > 0
      ? result.shapeId
      : Number.isInteger(result?.shape?.id) && result.shape.id > 0
        ? result.shape.id
        : 0;
  return {
    readStatus: result?.readStatus ?? null,
    transferStatus: result?.transferStatus ?? null,
    rootCount: Number.isFinite(result?.rootCount) ? Number(result.rootCount) : 0,
    transferredRootCount: Number.isFinite(result?.transferredRootCount)
      ? Number(result.transferredRootCount)
      : 0,
    messageList,
    shapeHandle,
    isValid: result?.isValid === true,
    wasValidBeforeHealing: result?.wasValidBeforeHealing === true,
    healed: result?.healed === true,
  };
}

function formatStepImportFailure(result) {
  const firstFailure = Array.isArray(result?.messageList)
    ? result.messageList.find((message) => message?.severity === 'fail' && message.text)
    : null;
  if (firstFailure?.text) return firstFailure.text;
  const firstWarning = Array.isArray(result?.messageList)
    ? result.messageList.find((message) => message?.severity === 'warning' && message.text)
    : null;
  if (firstWarning?.text) return firstWarning.text;
  const readStatus = result?.readStatus ?? 'unknown-read-status';
  const transferStatus = result?.transferStatus ?? 'unknown-transfer-status';
  return `OCCT STEP import failed (${readStatus}/${transferStatus})`;
}

function readTriangleVector(vectors, triangleIndex) {
  if (!Array.isArray(vectors) || vectors.length === 0) return null;
  if (typeof vectors[0] === 'number') {
    if (vectors.length < triangleIndex * 3 + 3) return null;
    return normalize(readVec3(vectors, triangleIndex));
  }
  const vector = readVec3ish(vectors[triangleIndex]);
  return vector ? normalize(vector) : null;
}

function buildOcctFaceMetadataIndex(topology) {
  const faces = firstArray(topology, ['faces', 'topoFaces']);
  const byId = new Map();
  if (!faces) return byId;

  for (let index = 0; index < faces.length; index++) {
    const face = faces[index];
    if (!face || typeof face !== 'object') continue;
    const topoFaceId = integerOrNull(face.topoFaceId ?? face.faceId ?? face.id) ?? index;
    let shared = face.shared && typeof face.shared === 'object' && !Array.isArray(face.shared)
      ? { ...face.shared }
      : null;
    const sourceFeatureId = stringOrNull(face.sourceFeatureId ?? face.featureId ?? shared?.sourceFeatureId);
    if (sourceFeatureId) {
      if (!shared) shared = { sourceFeatureId };
      else if (!shared.sourceFeatureId) shared.sourceFeatureId = sourceFeatureId;
    }
    byId.set(topoFaceId, {
      topoFaceId,
      faceGroup: integerOrNull(face.faceGroup ?? face.groupId) ?? topoFaceId,
      stableHash: stringOrNull(face.stableHash ?? face.hash ?? face.faceHash),
      shared,
    });
  }

  return byId;
}

function normalizeEdgeNormals(value, faceIndices, faces) {
  const explicit = uniqueVectors(normalizeVec3List(value));
  if (explicit.length > 0) return explicit;
  if (!Array.isArray(faceIndices) || !Array.isArray(faces)) return [];
  return uniqueVectors(faceIndices.map((faceIndex) => faces[faceIndex]?.normal));
}

function normalizePointSequence(entry) {
  const rawPoints = Array.isArray(entry?.points)
    ? entry.points
    : Array.isArray(entry?.polyline)
      ? entry.polyline
      : null;
  if (rawPoints) {
    const points = rawPoints.map((point) => readVec3ish(point)).filter(Boolean);
    return points.length >= 2 ? points : [];
  }
  const start = readVec3ish(entry?.start);
  const end = readVec3ish(entry?.end);
  return start && end ? [start, end] : [];
}

function resolveEdgeMetadata(entry, triangleIndicesByTopoFaceId, faces) {
  const topoFaceIds = [];
  if (Array.isArray(entry?.topoFaceIds)) {
    for (const topoFaceId of entry.topoFaceIds) {
      const normalized = integerOrNull(topoFaceId);
      if (normalized != null) topoFaceIds.push(normalized);
    }
  } else {
    const topoFaceId = integerOrNull(entry?.topoFaceId);
    if (topoFaceId != null) topoFaceIds.push(topoFaceId);
  }

  const faceIndices = [];
  if (Array.isArray(entry?.faceIndices)) {
    for (const faceIndex of entry.faceIndices) {
      const normalized = integerOrNull(faceIndex);
      if (normalized != null && normalized >= 0 && normalized < faces.length) faceIndices.push(normalized);
    }
  }
  if (faceIndices.length === 0) {
    for (const topoFaceId of topoFaceIds) {
      const indices = triangleIndicesByTopoFaceId.get(topoFaceId) || [];
      for (const faceIndex of indices) faceIndices.push(faceIndex);
    }
  }

  return {
    stableHash: stringOrNull(entry?.stableHash ?? entry?.hash ?? entry?.edgeHash),
    topoFaceIds: [...new Set(topoFaceIds)],
    faceIndices: [...new Set(faceIndices)],
    normals: normalizeEdgeNormals(entry?.normals ?? entry?.normal, faceIndices, faces),
  };
}

function buildEdgeSegmentsFromEntries(entries, triangleIndicesByTopoFaceId, faces, includePaths) {
  const edges = [];
  const paths = [];
  if (!Array.isArray(entries)) return { edges, paths };

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const points = normalizePointSequence(entry);
    if (points.length < 2) continue;
    const metadata = resolveEdgeMetadata(entry, triangleIndicesByTopoFaceId, faces);
    const edgeIndices = [];
    for (let index = 0; index + 1 < points.length; index++) {
      const edge = {
        start: points[index],
        end: points[index + 1],
        source: 'occt',
      };
      if (metadata.faceIndices.length > 0) edge.faceIndices = metadata.faceIndices;
      if (metadata.normals.length > 0) edge.normals = metadata.normals;
      if (metadata.topoFaceIds.length > 0) edge.topoFaceIds = metadata.topoFaceIds;
      if (metadata.stableHash) edge.stableHash = metadata.stableHash;
      edges.push(edge);
      edgeIndices.push(edges.length - 1);
    }
    if (!includePaths || edgeIndices.length === 0) continue;
    const path = {
      edgeIndices,
      isClosed: entry.isClosed === true || pointsCoincident(points[0], points[points.length - 1]),
    };
    if (metadata.stableHash) path.stableHash = metadata.stableHash;
    if (metadata.topoFaceIds.length > 0) path.topoFaceIds = metadata.topoFaceIds;
    paths.push(path);
  }

  return { edges, paths };
}

function parseEdgeSegments(edgeSegments, triangleIndicesByTopoFaceId, faces) {
  if (!Array.isArray(edgeSegments) || edgeSegments.length === 0) return [];
  if (typeof edgeSegments[0] === 'object') {
    return buildEdgeSegmentsFromEntries(edgeSegments, triangleIndicesByTopoFaceId, faces, false).edges;
  }
  if (edgeSegments.length < 6) return [];
  const edges = [];
  for (let offset = 0; offset + 5 < edgeSegments.length; offset += 6) {
    edges.push({
      start: {
        x: cleanNumber(Number(edgeSegments[offset] ?? 0)),
        y: cleanNumber(Number(edgeSegments[offset + 1] ?? 0)),
        z: cleanNumber(Number(edgeSegments[offset + 2] ?? 0)),
      },
      end: {
        x: cleanNumber(Number(edgeSegments[offset + 3] ?? 0)),
        y: cleanNumber(Number(edgeSegments[offset + 4] ?? 0)),
        z: cleanNumber(Number(edgeSegments[offset + 5] ?? 0)),
      },
      source: 'occt',
    });
  }
  return edges;
}

function normalizeExtrudeOptions(options) {
  if (Number.isFinite(options)) {
    return { height: Number(options) };
  }
  if (!options || typeof options !== 'object') {
    return {};
  }
  return { ...options };
}

function normalizeRevolveOptions(options) {
  if (Number.isFinite(options)) {
    return { angleDegrees: Number(options) * 180 / Math.PI };
  }
  if (!options || typeof options !== 'object') {
    return {};
  }
  const normalized = { ...options };
  if (!Number.isFinite(normalized.angleDegrees) && Number.isFinite(normalized.angleRadians)) {
    normalized.angleDegrees = Number(normalized.angleRadians) * 180 / Math.PI;
  }
  delete normalized.angleRadians;
  return normalized;
}

function normalizeBoxArgs(dx, dy, dz) {
  if (dx && typeof dx === 'object') {
    return {
      dx: Number(dx.dx ?? dx.x ?? dx.width ?? 0),
      dy: Number(dx.dy ?? dx.y ?? dx.depth ?? 0),
      dz: Number(dx.dz ?? dx.z ?? dx.height ?? 0),
    };
  }
  return {
    dx: Number(dx || 0),
    dy: Number(dy || 0),
    dz: Number(dz || 0),
  };
}

function shapeHandleFromResult(result, label) {
  const value = typeof result === 'string' ? parseJson(result, label) : result;
  if (Number.isInteger(value) && value > 0) return value;
  if (!value || typeof value !== 'object') return 0;
  const candidates = [
    value.shapeHandle,
    value.shapeId,
    value.id,
    value.shape,
    value.shape?.id,
    value.shape?.shapeHandle,
  ];
  for (const candidate of candidates) {
    const handle = integerOrNull(Number(candidate));
    if (handle != null && handle > 0) return handle;
  }
  return 0;
}

function normalizeShapeInput(shape) {
  if (Number.isInteger(shape) && shape > 0) return shape;
  if (shape && typeof shape === 'object') {
    const handle = shapeHandleFromResult(shape, 'shape');
    if (handle > 0) return handle;
  }
  return shape;
}

function normalizeStructuredSpec(spec = {}) {
  const normalized = spec && typeof spec === 'object' ? { ...spec } : {};
  normalized.schemaVersion = integerOrNull(normalized.schemaVersion) ?? 1;
  if (Number.isFinite(normalized.draftAngleRadians) && !Number.isFinite(normalized.draftAngleDegrees)) {
    normalized.draftAngleDegrees = Number(normalized.draftAngleRadians) * 180 / Math.PI;
  }
  delete normalized.draftAngleRadians;

  if (normalized.extent && typeof normalized.extent === 'object') {
    normalized.extent = { ...normalized.extent };
    if (Number.isFinite(normalized.extent.angleRadians) && !Number.isFinite(normalized.extent.angleDegrees)) {
      normalized.extent.angleDegrees = Number(normalized.extent.angleRadians) * 180 / Math.PI;
    }
    delete normalized.extent.angleRadians;
  }
  return normalized;
}

function normalizeStructuredFeatureRequest(request = {}, defaults = {}) {
  if (!request || typeof request !== 'object') {
    throw new Error('OCCT structured feature request must be an object');
  }
  const normalized = { ...request };
  if (normalized.shape == null && normalized.shapeHandle != null) normalized.shape = normalized.shapeHandle;
  if (normalized.shape != null) normalized.shape = normalizeShapeInput(normalized.shape);
  delete normalized.shapeHandle;
  normalized.spec = normalizeStructuredSpec(normalized.spec || defaults.spec || {});
  if (defaults.cut != null && normalized.cut == null) normalized.cut = defaults.cut;
  return normalized;
}

function buildRawSweepTrihedronMode(mode) {
  if (!mode || typeof mode !== 'object') return null;
  switch (mode.type) {
    case 'correctedFrenet':
    case 'frenet':
    case 'discrete':
      return { type: mode.type };
    case 'fixedTrihedron':
      return mode.frame ? { type: 'fixedTrihedron', frame: mode.frame } : null;
    case 'fixedBinormal':
      return Array.isArray(mode.binormal) ? { type: 'fixedBinormal', binormal: mode.binormal } : null;
    case 'auxiliarySpine': {
      if (!mode.spine) return null;
      const normalized = {
        type: 'auxiliarySpine',
        spineJson: JSON.stringify(mode.spine),
      };
      if (mode.curvilinearEquivalence != null) normalized.curvilinearEquivalence = mode.curvilinearEquivalence;
      if (mode.contact != null) normalized.contact = mode.contact;
      return normalized;
    }
    default:
      return null;
  }
}

function buildRawSweepSpec(spec = {}, cut = false) {
  const raw = {
    schemaVersion: integerOrNull(spec.schemaVersion) ?? 1,
    spineJson: JSON.stringify(spec.spine || { segments: [] }),
  };
  if (spec.allowUnknownFields != null) raw.allowUnknownFields = spec.allowUnknownFields;
  if (spec.unit != null) raw.unit = spec.unit;
  if (spec.plane != null) raw.plane = spec.plane;
  const trihedronMode = buildRawSweepTrihedronMode(spec.trihedronMode);
  if (trihedronMode) raw.trihedronMode = trihedronMode;
  if (spec.sectionWithContact != null) raw.sectionWithContact = spec.sectionWithContact;
  if (spec.sectionWithCorrection != null) raw.sectionWithCorrection = spec.sectionWithCorrection;
  if (spec.solid != null) raw.solid = spec.solid;
  if (spec.forceApproxC1 != null) raw.forceApproxC1 = spec.forceApproxC1;
  if (spec.transitionMode != null) raw.transitionMode = spec.transitionMode;
  if (spec.tolerance != null) raw.tolerance = spec.tolerance;
  if (spec.maxDegree != null) raw.maxDegree = spec.maxDegree;
  if (spec.maxSegments != null) raw.maxSegments = spec.maxSegments;
  if (cut) raw.cut = true;
  if (spec.metadata != null) raw.metadata = spec.metadata;
  return raw;
}

function buildRawLoftSections(sections = []) {
  return (sections || []).map((section) => {
    if (!section || typeof section !== 'object') return section;
    if (section.type === 'wire') {
      return {
        type: 'wire',
        wireJson: JSON.stringify(section.wire),
      };
    }
    if (section.type === 'point') {
      return {
        type: 'point',
        point: section.point,
      };
    }
    return {
      type: 'profile',
      profileJson: JSON.stringify(section.profile),
      ...(section.plane ? { plane: section.plane } : {}),
    };
  });
}

function buildRawLoftSpec(spec = {}, cut = false) {
  const raw = {
    schemaVersion: integerOrNull(spec.schemaVersion) ?? 1,
  };
  if (spec.allowUnknownFields != null) raw.allowUnknownFields = spec.allowUnknownFields;
  if (spec.solid != null) raw.solid = spec.solid;
  if (spec.ruled != null) raw.ruled = spec.ruled;
  if (spec.pres3d != null) raw.pres3d = spec.pres3d;
  if (spec.checkCompatibility != null) raw.checkCompatibility = spec.checkCompatibility;
  if (spec.smoothing != null) raw.smoothing = spec.smoothing;
  if (spec.parametrization != null) raw.parametrization = spec.parametrization;
  if (spec.continuity != null) raw.continuity = spec.continuity;
  if (spec.criteriumWeight != null) raw.criteriumWeight = spec.criteriumWeight;
  if (spec.maxDegree != null) raw.maxDegree = spec.maxDegree;
  if (spec.mutableInput != null) raw.mutableInput = spec.mutableInput;
  if (cut) raw.cut = true;
  if (spec.metadata != null) raw.metadata = spec.metadata;
  return raw;
}

function buildStructuredNativeArgs(methodName, request) {
  const shape = integerOrNull(request?.shape);
  if (shape == null || shape <= 0) return null;

  switch (methodName) {
    case 'extrudeProfileWithSpec':
    case 'extrudeCutProfileWithSpec':
    case 'revolveProfileWithSpec':
    case 'revolveCutProfileWithSpec':
      if (!request.profile) return null;
      return [shape, JSON.stringify(request.profile), JSON.stringify(request.spec || {})];
    case 'sweepProfileWithSpec': {
      if (!request.profile) return null;
      const spec = buildRawSweepSpec(request.spec, request.cut === true);
      return [shape, JSON.stringify(request.profile), JSON.stringify(spec)];
    }
    case 'loftWithSpec': {
      const sections = buildRawLoftSections(Array.isArray(request.sections) ? request.sections : []);
      const spec = buildRawLoftSpec(request.spec, request.cut === true);
      return [shape, JSON.stringify(sections), JSON.stringify(spec)];
    }
    default:
      return null;
  }
}

function invokeStructuredFeature(kernel, methodName, request) {
  const method = kernel?.[methodName];
  if (typeof method !== 'function') {
    throw new Error(`OCCT ${methodName} is unavailable in this build`);
  }
  let firstError = null;
  try {
    return method.call(kernel, request);
  } catch (error) {
    firstError = error;
  }

  try {
    return method.call(kernel, JSON.stringify(request));
  } catch {}

  const nativeArgs = buildStructuredNativeArgs(methodName, request);
  if (nativeArgs) {
    return method.call(kernel, ...nativeArgs);
  }

  throw firstError;
}

function normalizeEdgeRef(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const topoId = integerOrNull(ref.topoId ?? ref.id);
  const stableHash = stringOrNull(ref.stableHash ?? ref.hash);
  if (topoId == null && !stableHash) return null;
  return {
    ...(topoId != null ? { topoId } : {}),
    ...(stableHash ? { stableHash } : {}),
  };
}

function normalizeFaceRef(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const topoId = integerOrNull(ref.topoId ?? ref.id);
  const stableHash = stringOrNull(ref.stableHash ?? ref.hash);
  if (topoId == null && !stableHash) return null;
  return {
    ...(topoId != null ? { topoId } : {}),
    ...(stableHash ? { stableHash } : {}),
  };
}

function normalizeFilletSpec(spec = {}) {
  if (!spec || typeof spec !== 'object') return { schemaVersion: 1 };
  const normalized = { ...spec };
  normalized.schemaVersion = integerOrNull(spec.schemaVersion) ?? 1;
  if (Array.isArray(spec.edges)) {
    normalized.edges = spec.edges.map((edge) => {
      if (!edge || typeof edge !== 'object') return edge;
      const normalizedEdge = { ...edge };
      const edgeRef = normalizeEdgeRef(edge.edgeRef ?? edge.edge ?? edge);
      if (edgeRef) normalizedEdge.edge = edgeRef;
      delete normalizedEdge.edgeRef;
      delete normalizedEdge.topoId;
      delete normalizedEdge.stableHash;
      if (edge.referenceFace) {
        const faceRef = normalizeFaceRef(edge.referenceFace);
        if (faceRef) normalizedEdge.referenceFace = faceRef;
      }
      return normalizedEdge;
    });
  }
  return normalized;
}

function normalizeChamferSpec(spec = {}) {
  if (!spec || typeof spec !== 'object') return { schemaVersion: 1 };
  const normalized = { ...spec };
  normalized.schemaVersion = integerOrNull(spec.schemaVersion) ?? 1;
  if (Array.isArray(spec.edges)) {
    normalized.edges = spec.edges.map((edge) => {
      if (!edge || typeof edge !== 'object') return edge;
      const normalizedEdge = { ...edge };
      const edgeRef = normalizeEdgeRef(edge.edgeRef ?? edge.edge ?? edge);
      if (edgeRef) normalizedEdge.edge = edgeRef;
      delete normalizedEdge.edgeRef;
      delete normalizedEdge.topoId;
      delete normalizedEdge.stableHash;
      if (edge.referenceFace) {
        const faceRef = normalizeFaceRef(edge.referenceFace);
        if (faceRef) normalizedEdge.referenceFace = faceRef;
      }
      return normalizedEdge;
    });
  }
  if (normalized.referenceFace) {
    const faceRef = normalizeFaceRef(normalized.referenceFace);
    if (faceRef) normalized.referenceFace = faceRef;
  }
  return normalized;
}

export function occtTessellationToMesh(tessellation, opts = {}) {
  const data = parseJson(tessellation, 'tessellate') || {};
  const topology = firstObject(opts, ['topology', 'occtTopology'])
    || firstObject(data, ['topology', 'occtTopology']);
  const positions = Array.isArray(data.positions) ? data.positions : [];
  const normals = Array.isArray(data.normals) ? data.normals : [];
  const indices = Array.isArray(data.indices) ? data.indices : [];
  const triangleNormals = firstArray(data, ['triangleNormals', 'faceNormals']);
  const triangleTopoFaceIds = firstArray(data, ['triangleTopoFaceIds', 'topoFaceIds', 'faceIds']);
  const triangleFaceGroups = firstArray(data, ['triangleFaceGroups', 'faceGroups']);
  const triangleStableHashes = firstArray(data, ['triangleStableHashes', 'faceStableHashes']);
  const triangleSharedValues = firstArray(data, ['triangleShared', 'faceShared']);
  const triangleSourceFeatureIds = firstArray(data, ['triangleSourceFeatureIds', 'sourceFeatureIds']);
  const faceMetadataById = buildOcctFaceMetadataIndex(topology);
  const vertexCount = Math.floor(positions.length / 3);
  const vertices = new Array(vertexCount);

  for (let index = 0; index < vertexCount; index++) {
    vertices[index] = readVec3(positions, index);
  }

  const faces = [];
  const triangleIndicesByTopoFaceId = new Map();
  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const i0 = Number(indices[offset] ?? 0);
    const i1 = Number(indices[offset + 1] ?? 0);
    const i2 = Number(indices[offset + 2] ?? 0);
    if (!vertices[i0] || !vertices[i1] || !vertices[i2]) continue;
    const faceVertices = [vertices[i0], vertices[i1], vertices[i2]];
    const triangleIndex = faces.length;
    const fallbackTopoFaceId = opts.topoFaceIdOffset != null ? opts.topoFaceIdOffset + triangleIndex : triangleIndex;
    const declaredTopoFaceId = integerOrNull(triangleTopoFaceIds?.[triangleIndex]);
    const faceMeta = faceMetadataById.get(declaredTopoFaceId ?? fallbackTopoFaceId) || null;
    const topoFaceId = faceMeta?.topoFaceId ?? declaredTopoFaceId ?? fallbackTopoFaceId;
    const fallbackFaceGroup = opts.faceGroupOffset != null ? opts.faceGroupOffset + triangleIndex : triangleIndex;
    const faceGroup = integerOrNull(triangleFaceGroups?.[triangleIndex]) ?? faceMeta?.faceGroup ?? topoFaceId ?? fallbackFaceGroup;
    const explicitTriangleNormal = readTriangleVector(triangleNormals, triangleIndex);
    const analyticNormal = triangleNormal(faceVertices[0], faceVertices[1], faceVertices[2]);
    const smoothNormal = explicitTriangleNormal ? null : averageNormal(normals, i0, i1, i2);
    const normal = explicitTriangleNormal || (smoothNormal && dot(analyticNormal, smoothNormal) < 0
      ? { x: -analyticNormal.x, y: -analyticNormal.y, z: -analyticNormal.z }
      : analyticNormal);
    let shared = triangleSharedValues?.[triangleIndex] && typeof triangleSharedValues[triangleIndex] === 'object' && !Array.isArray(triangleSharedValues[triangleIndex])
      ? { ...triangleSharedValues[triangleIndex] }
      : (faceMeta?.shared ? { ...faceMeta.shared } : undefined);
    const sourceFeatureId = stringOrNull(
      triangleSharedValues?.[triangleIndex]?.sourceFeatureId
      ?? triangleSourceFeatureIds?.[triangleIndex]
      ?? shared?.sourceFeatureId
    );
    if (sourceFeatureId) {
      if (!shared) shared = { sourceFeatureId };
      else if (!shared.sourceFeatureId) shared.sourceFeatureId = sourceFeatureId;
    }
    const face = {
      vertices: faceVertices,
      normal,
      vertexNormals: explicitTriangleNormal
        ? [normal, normal, normal]
        : (normals.length >= vertexCount * 3
          ? [readVec3(normals, i0), readVec3(normals, i1), readVec3(normals, i2)]
          : undefined),
      faceGroup,
      topoFaceId,
      faceType: 'occt-triangle',
      source: 'occt',
    };
    const stableHash = stringOrNull(triangleStableHashes?.[triangleIndex]) ?? faceMeta?.stableHash ?? null;
    if (stableHash) face.stableHash = stableHash;
    if (shared) face.shared = shared;
    faces.push(face);
    if (Number.isInteger(topoFaceId)) {
      if (!triangleIndicesByTopoFaceId.has(topoFaceId)) triangleIndicesByTopoFaceId.set(topoFaceId, []);
      triangleIndicesByTopoFaceId.get(topoFaceId).push(triangleIndex);
    }
  }

  const featureEdgeEntries = firstArray(data, ['featureEdges', 'edgeChains', 'featureEdgeChains', 'stableEdges', 'sanitizedEdges']);
  const featureEdgeData = buildEdgeSegmentsFromEntries(featureEdgeEntries, triangleIndicesByTopoFaceId, faces, true);
  const edges = featureEdgeData.edges.length > 0
    ? featureEdgeData.edges
    : parseEdgeSegments(data.edgeSegments, triangleIndicesByTopoFaceId, faces);
  const rawEdgeSegmentCount = Array.isArray(data.edgeSegments)
    ? (typeof data.edgeSegments[0] === 'number' ? data.edgeSegments.length / 6 : data.edgeSegments.length)
    : 0;

  return {
    vertices,
    faces,
    edges,
    paths: featureEdgeData.paths,
    _tessellator: 'occt',
    _occt: {
      positionCount: positions.length,
      normalCount: normals.length,
      indexCount: indices.length,
      edgeSegmentCount: rawEdgeSegmentCount,
      hasStableFaceMap: Array.isArray(triangleTopoFaceIds) || faceMetadataById.size > 0,
      hasStableHashes: faces.some((face) => !!face.stableHash),
      featureEdgeChainCount: featureEdgeData.paths.length,
    },
  };
}

export class OcctKernelAdapter {
  constructor(options = {}) {
    this.options = { ...options };
    this.module = options.module || null;
    this.apiModule = options.apiModule || null;
    this.kernel = options.kernel || null;
    this.paths = null;
    this._ownsKernel = !options.kernel;
    this._usesWrapperApi = options.wrapperApi === true
      || (!!this.apiModule && !!this.kernel && typeof this.apiModule.OcctKernel === 'function' && this.kernel instanceof this.apiModule.OcctKernel);
    this._ownedShapes = new Set();
  }

  static async create(options = {}) {
    const adapter = new OcctKernelAdapter(options);
    await adapter.init();
    return adapter;
  }

  static createSync(options = {}) {
    const loaded = options.loaded || getCachedOcctKernelModule(options);
    const module = options.module || loaded?.module;
    const apiModule = options.apiModule || loaded?.apiModule || null;
    if (!module || typeof module.OcctKernel !== 'function') {
      throw new Error('OCCT module is not ready for synchronous adapter creation');
    }

    const adapter = new OcctKernelAdapter({ ...options, module, apiModule });
    adapter.paths = options.paths || loaded?.paths || null;
    if (!adapter.kernel) {
      adapter.kernel = adapter._createKernelInstance(module);
      adapter._ownsKernel = true;
    }
    return adapter;
  }

  async init() {
    if (!this.module) {
      const loaded = await loadOcctKernelModule(this.options);
      this.module = loaded.module;
      this.apiModule = this.options.apiModule || loaded.apiModule || null;
      this.paths = loaded.paths;
    }
    if (!this.kernel) {
      this.kernel = this._createKernelInstance(this.module);
      this._ownsKernel = true;
    }
    return this;
  }

  get ready() {
    return !!this.kernel;
  }

  get status() {
    return {
      ...getOcctKernelStatus(this.module),
      ready: this.ready,
      wrapperApi: this._usesWrapperApi,
      ownedShapeCount: this._ownedShapes.size,
      paths: this.paths,
    };
  }

  _createKernelInstance(module = this.module) {
    if (this.apiModule && typeof this.apiModule.OcctKernel === 'function') {
      this._usesWrapperApi = true;
      return new this.apiModule.OcctKernel(module);
    }
    this._usesWrapperApi = false;
    return new module.OcctKernel();
  }

  _shapeHandleObject(shapeHandle) {
    const handle = normalizeShapeInput(shapeHandle);
    return { id: handle };
  }

  _wrapperResultHandle(result, label) {
    return shapeHandleFromResult(result, label);
  }

  _wrapperStructuredRequest(request = {}) {
    const payload = { ...request };
    if (payload.shape != null) payload.shape = this._shapeHandleObject(payload.shape);
    return payload;
  }

  _wrapperProfile(profile) {
    return typeof profile === 'string' ? parseJson(profile, 'profile') : profile;
  }

  _wrapperTessellationResult(result) {
    if (!result || typeof result !== 'object') return result;
    const toArray = (value) => Array.isArray(value) ? value : (ArrayBuffer.isView(value) ? Array.from(value) : undefined);
    return {
      positions: toArray(result.positions) || [],
      normals: toArray(result.normals) || [],
      indices: toArray(result.indices) || [],
      ...(toArray(result.triangleNormals) ? { triangleNormals: toArray(result.triangleNormals) } : {}),
      ...(toArray(result.triangleTopoFaceIds) ? { triangleTopoFaceIds: toArray(result.triangleTopoFaceIds) } : {}),
      ...(toArray(result.triangleFaceGroups) ? { triangleFaceGroups: toArray(result.triangleFaceGroups) } : {}),
      ...(Array.isArray(result.triangleStableHashes) ? { triangleStableHashes: result.triangleStableHashes } : {}),
      ...(Array.isArray(result.featureEdges) ? { featureEdges: result.featureEdges } : {}),
      ...(toArray(result.rawEdgeSegments) ? { rawEdgeSegments: toArray(result.rawEdgeSegments) } : {}),
    };
  }

  requireReady() {
    if (!this.kernel) throw new Error('OCCT adapter is not initialized');
    return this.kernel;
  }

  rememberShape(handle) {
    if (Number.isInteger(handle) && handle > 0) this._ownedShapes.add(handle);
    return handle;
  }

  createBox(dx, dy, dz) {
    const dimensions = normalizeBoxArgs(dx, dy, dz);
    const kernel = this.requireReady();
    const result = this._usesWrapperApi
      ? kernel.createBox(dimensions)
      : kernel.createBox(dimensions.dx, dimensions.dy, dimensions.dz);
    return this.rememberShape(this._wrapperResultHandle(result, 'createBox'));
  }

  createCylinder(radius, height) {
    const kernel = this.requireReady();
    const result = this._usesWrapperApi
      ? kernel.createCylinder({ radius, height })
      : kernel.createCylinder(radius, height);
    return this.rememberShape(this._wrapperResultHandle(result, 'createCylinder'));
  }

  createSphere(radius) {
    const kernel = this.requireReady();
    const result = this._usesWrapperApi
      ? kernel.createSphere({ radius })
      : kernel.createSphere(radius);
    return this.rememberShape(this._wrapperResultHandle(result, 'createSphere'));
  }

  extrudeProfile(profileJson, options = {}) {
    const kernel = this.requireReady();
    const normalizedOptions = normalizeExtrudeOptions(options);
    const result = this._usesWrapperApi
      ? kernel.extrudeProfile({ profile: this._wrapperProfile(profileJson), ...normalizedOptions })
      : (() => {
          const payload = typeof profileJson === 'string' ? profileJson : JSON.stringify(profileJson);
          const optionsPayload = JSON.stringify(normalizedOptions);
          return kernel.extrudeProfile(payload, optionsPayload);
        })();
    return this.rememberShape(this._wrapperResultHandle(result, 'extrudeProfile'));
  }

  revolveProfile(profileJson, options = {}) {
    const kernel = this.requireReady();
    const normalizedOptions = normalizeRevolveOptions(options);
    const result = this._usesWrapperApi
      ? kernel.revolveProfile({ profile: this._wrapperProfile(profileJson), ...normalizedOptions })
      : (() => {
          const payload = typeof profileJson === 'string' ? profileJson : JSON.stringify(profileJson);
          const optionsPayload = JSON.stringify(normalizedOptions);
          return kernel.revolveProfile(payload, optionsPayload);
        })();
    return this.rememberShape(this._wrapperResultHandle(result, 'revolveProfile'));
  }

  extrudeProfileWithSpec(request = {}) {
    const kernel = this.requireReady();
    const payload = normalizeStructuredFeatureRequest(request);
    const result = this._usesWrapperApi
      ? kernel.extrudeProfileWithSpec(this._wrapperStructuredRequest(payload))
      : invokeStructuredFeature(kernel, 'extrudeProfileWithSpec', payload);
    return this.rememberShape(shapeHandleFromResult(result, 'extrudeProfileWithSpec'));
  }

  extrudeCutProfileWithSpec(request = {}) {
    const kernel = this.requireReady();
    const payload = normalizeStructuredFeatureRequest(request, { cut: true });
    const result = this._usesWrapperApi
      ? kernel.extrudeCutProfileWithSpec(this._wrapperStructuredRequest(payload))
      : invokeStructuredFeature(kernel, 'extrudeCutProfileWithSpec', payload);
    return this.rememberShape(shapeHandleFromResult(result, 'extrudeCutProfileWithSpec'));
  }

  revolveProfileWithSpec(request = {}) {
    const kernel = this.requireReady();
    const payload = normalizeStructuredFeatureRequest(request);
    const result = this._usesWrapperApi
      ? kernel.revolveProfileWithSpec(this._wrapperStructuredRequest(payload))
      : invokeStructuredFeature(kernel, 'revolveProfileWithSpec', payload);
    return this.rememberShape(shapeHandleFromResult(result, 'revolveProfileWithSpec'));
  }

  revolveCutProfileWithSpec(request = {}) {
    const kernel = this.requireReady();
    const payload = normalizeStructuredFeatureRequest(request, { cut: true });
    const result = this._usesWrapperApi
      ? kernel.revolveCutProfileWithSpec(this._wrapperStructuredRequest(payload))
      : invokeStructuredFeature(kernel, 'revolveCutProfileWithSpec', payload);
    return this.rememberShape(shapeHandleFromResult(result, 'revolveCutProfileWithSpec'));
  }

  sweepProfileWithSpec(request = {}) {
    const kernel = this.requireReady();
    const payload = normalizeStructuredFeatureRequest(request);
    const result = this._usesWrapperApi
      ? kernel.sweepProfileWithSpec(this._wrapperStructuredRequest(payload))
      : invokeStructuredFeature(kernel, 'sweepProfileWithSpec', payload);
    return this.rememberShape(shapeHandleFromResult(result, 'sweepProfileWithSpec'));
  }

  loftWithSpec(request = {}) {
    const kernel = this.requireReady();
    const payload = normalizeStructuredFeatureRequest(request);
    const result = this._usesWrapperApi
      ? kernel.loftWithSpec(this._wrapperStructuredRequest(payload))
      : invokeStructuredFeature(kernel, 'loftWithSpec', payload);
    return this.rememberShape(shapeHandleFromResult(result, 'loftWithSpec'));
  }

  booleanUnion(firstHandle, secondHandle) {
    const kernel = this.requireReady();
    const result = this._usesWrapperApi
      ? kernel.booleanUnion({ base: this._shapeHandleObject(firstHandle), tool: this._shapeHandleObject(secondHandle) })
      : kernel.booleanUnion(firstHandle, secondHandle);
    return this.rememberShape(this._wrapperResultHandle(result, 'booleanUnion'));
  }

  booleanSubtract(firstHandle, secondHandle) {
    const kernel = this.requireReady();
    const result = this._usesWrapperApi
      ? kernel.booleanSubtract({ base: this._shapeHandleObject(firstHandle), tool: this._shapeHandleObject(secondHandle) })
      : kernel.booleanSubtract(firstHandle, secondHandle);
    return this.rememberShape(this._wrapperResultHandle(result, 'booleanSubtract'));
  }

  booleanIntersect(firstHandle, secondHandle) {
    const kernel = this.requireReady();
    const result = this._usesWrapperApi
      ? kernel.booleanIntersect({ base: this._shapeHandleObject(firstHandle), tool: this._shapeHandleObject(secondHandle) })
      : kernel.booleanIntersect(firstHandle, secondHandle);
    return this.rememberShape(this._wrapperResultHandle(result, 'booleanIntersect'));
  }

  filletEdges(shapeHandle, edgeSelectionJson) {
    const kernel = this.requireReady();
    if (this._usesWrapperApi) {
      if (edgeSelectionJson && typeof edgeSelectionJson === 'object' && typeof kernel.filletEdgesWithSpec === 'function') {
        return kernel.filletEdgesWithSpec({
          shape: this._shapeHandleObject(shapeHandle),
          spec: normalizeFilletSpec(edgeSelectionJson),
        });
      }
      return this.rememberShape(this._wrapperResultHandle(kernel.filletEdges({
        shape: this._shapeHandleObject(shapeHandle),
        radius: Number(edgeSelectionJson) || 0,
      }), 'filletEdges'));
    }
    if (edgeSelectionJson && typeof edgeSelectionJson === 'object' && typeof kernel.filletEdgesWithSpec === 'function') {
      const payload = normalizeFilletSpec(edgeSelectionJson);
      return parseJson(kernel.filletEdgesWithSpec(shapeHandle, JSON.stringify(payload)), 'filletEdgesWithSpec');
    }
    if (typeof kernel.filletEdges === 'function' && !Number.isFinite(edgeSelectionJson)) {
      const payload = typeof edgeSelectionJson === 'string' ? edgeSelectionJson : JSON.stringify(edgeSelectionJson);
      return this.rememberShape(kernel.filletEdges(shapeHandle, payload));
    }
    return this.rememberShape(kernel.filletEdges(shapeHandle, Number(edgeSelectionJson) || 0));
  }

  chamferEdges(shapeHandle, edgeSelectionJson) {
    const kernel = this.requireReady();
    if (this._usesWrapperApi) {
      if (edgeSelectionJson && typeof edgeSelectionJson === 'object' && typeof kernel.chamferEdgesWithSpec === 'function') {
        return kernel.chamferEdgesWithSpec({
          shape: this._shapeHandleObject(shapeHandle),
          spec: normalizeChamferSpec(edgeSelectionJson),
        });
      }
      return this.rememberShape(this._wrapperResultHandle(kernel.chamferEdges({
        shape: this._shapeHandleObject(shapeHandle),
        distance: Number(edgeSelectionJson) || 0,
      }), 'chamferEdges'));
    }
    if (edgeSelectionJson && typeof edgeSelectionJson === 'object' && typeof kernel.chamferEdgesWithSpec === 'function') {
      const payload = normalizeChamferSpec(edgeSelectionJson);
      return parseJson(kernel.chamferEdgesWithSpec(shapeHandle, JSON.stringify(payload)), 'chamferEdgesWithSpec');
    }
    if (typeof kernel.chamferEdges === 'function' && !Number.isFinite(edgeSelectionJson)) {
      const payload = typeof edgeSelectionJson === 'string' ? edgeSelectionJson : JSON.stringify(edgeSelectionJson);
      return this.rememberShape(kernel.chamferEdges(shapeHandle, payload));
    }
    return this.rememberShape(kernel.chamferEdges(shapeHandle, Number(edgeSelectionJson) || 0));
  }

  transformShape(shapeHandle, transformJson) {
    const kernel = this.requireReady();
    if (typeof kernel.transformShape !== 'function') {
      throw new Error('OCCT transformShape is unavailable in this build');
    }
    if (this._usesWrapperApi) {
      const result = kernel.transformShape({
        shape: this._shapeHandleObject(shapeHandle),
        transform: typeof transformJson === 'string' ? parseJson(transformJson, 'transformShape') : transformJson,
      });
      return this.rememberShape(this._wrapperResultHandle(result, 'transformShape'));
    }
    const payload = typeof transformJson === 'string' ? transformJson : JSON.stringify(transformJson);
    return this.rememberShape(kernel.transformShape(shapeHandle, payload));
  }

  importStepDetailed(stepText, opts = {}) {
    const kernel = this.requireReady();
    if (this._usesWrapperApi) {
      const result = kernel.importStepDetailed({ content: stepText, options: opts });
      const normalized = normalizeStepImportResult(result);
      if (normalized.shapeHandle > 0) this.rememberShape(normalized.shapeHandle);
      return normalized;
    }
    if (typeof kernel.importStepDetailed !== 'function') {
      const shapeHandle = this.rememberShape(kernel.importStep(stepText));
      const isValid = this.checkValidity(shapeHandle);
      return {
        readStatus: 'legacy-import',
        transferStatus: 'legacy-import',
        rootCount: shapeHandle > 0 ? 1 : 0,
        transferredRootCount: shapeHandle > 0 ? 1 : 0,
        messageList: [],
        shapeHandle,
        isValid,
        wasValidBeforeHealing: isValid,
        healed: false,
      };
    }

    const sewingTolerance = opts.sewingTolerance ?? opts.sewTolerance ?? 1e-6;
    const result = normalizeStepImportResult(parseJson(
      kernel.importStepDetailed(
        stepText,
        opts.heal === true,
        opts.sew === true,
        opts.fixSameParameter === true,
        opts.fixSolid === true,
        sewingTolerance,
      ),
      'importStepDetailed',
    ));
    if (result.shapeHandle > 0) this.rememberShape(result.shapeHandle);
    return result;
  }

  importStep(stepText, opts = undefined) {
    if (opts && typeof opts === 'object' && Object.keys(opts).length > 0) {
      const result = this.importStepDetailed(stepText, opts);
      if (result.shapeHandle > 0) return result.shapeHandle;
      throw new Error(formatStepImportFailure(result));
    }
    const kernel = this.requireReady();
    const result = this._usesWrapperApi
      ? kernel.importStep({ content: stepText })
      : kernel.importStep(stepText);
    return this.rememberShape(this._wrapperResultHandle(result, 'importStep'));
  }

  exportStep(shapeHandle) {
    const kernel = this.requireReady();
    return this._usesWrapperApi
      ? kernel.exportStep({ shape: this._shapeHandleObject(shapeHandle) })
      : kernel.exportStep(shapeHandle);
  }

  checkValidity(shapeHandle) {
    const kernel = this.requireReady();
    return this._usesWrapperApi
      ? !!kernel.checkValidity(this._shapeHandleObject(shapeHandle))
      : !!kernel.checkValidity(shapeHandle);
  }

  getTopology(shapeHandle) {
    const kernel = this.requireReady();
    const result = this._usesWrapperApi
      ? kernel.getTopology(this._shapeHandleObject(shapeHandle))
      : kernel.getTopology(shapeHandle);
    return parseJson(result, 'getTopology');
  }

  getRevisionInfo(shapeHandle) {
    const kernel = this.requireReady();
    if (typeof kernel.getRevisionInfo !== 'function') {
      throw new Error('OCCT getRevisionInfo is unavailable in this build');
    }
    const result = this._usesWrapperApi
      ? kernel.getRevisionInfo(this._shapeHandleObject(shapeHandle))
      : kernel.getRevisionInfo(shapeHandle);
    return parseJson(result, 'getRevisionInfo');
  }

  resolveStableEntity(shapeHandle, stableHash) {
    const kernel = this.requireReady();
    if (typeof kernel.resolveStableEntity !== 'function') {
      throw new Error('OCCT resolveStableEntity is unavailable in this build');
    }
    const result = this._usesWrapperApi
      ? kernel.resolveStableEntity({ shape: this._shapeHandleObject(shapeHandle), stableHash: String(stableHash ?? '') })
      : kernel.resolveStableEntity(shapeHandle, String(stableHash ?? ''));
    return parseJson(result, 'resolveStableEntity');
  }

  mapEntitiesAcrossRevisions(fromRevisionId, toRevisionId, stableHashes = []) {
    const kernel = this.requireReady();
    if (typeof kernel.mapEntitiesAcrossRevisions !== 'function') {
      throw new Error('OCCT mapEntitiesAcrossRevisions is unavailable in this build');
    }
    if (this._usesWrapperApi) {
      return parseJson(kernel.mapEntitiesAcrossRevisions({
        fromRevisionId: String(fromRevisionId ?? ''),
        toRevisionId: String(toRevisionId ?? ''),
        stableHashes: Array.isArray(stableHashes) ? stableHashes : parseJson(stableHashes, 'stableHashes') || [],
      }), 'mapEntitiesAcrossRevisions');
    }
    const payload = typeof stableHashes === 'string' ? stableHashes : JSON.stringify(stableHashes);
    return parseJson(
      kernel.mapEntitiesAcrossRevisions(String(fromRevisionId ?? ''), String(toRevisionId ?? ''), payload),
      'mapEntitiesAcrossRevisions',
    );
  }

  getCapabilities() {
    const kernel = this.requireReady();
    if (typeof kernel.getCapabilities !== 'function') return {};
    return parseJson(kernel.getCapabilities(), 'getCapabilities') || {};
  }

  getOperationSchema() {
    const kernel = this.requireReady();
    if (typeof kernel.getOperationSchema !== 'function') return null;
    return parseJson(kernel.getOperationSchema(), 'getOperationSchema');
  }

  evaluateEdge(shapeHandle, edgeRef, t) {
    const kernel = this.requireReady();
    if (typeof kernel.evaluateEdge !== 'function') {
      throw new Error('OCCT evaluateEdge is unavailable in this build');
    }
    const normalizedEdge = normalizeEdgeRef(edgeRef) || edgeRef || {};
    const result = this._usesWrapperApi
      ? kernel.evaluateEdge({ shape: this._shapeHandleObject(shapeHandle), edge: normalizedEdge, t: Number(t) || 0 })
      : kernel.evaluateEdge(shapeHandle, JSON.stringify(normalizedEdge), Number(t) || 0);
    return parseJson(result, 'evaluateEdge');
  }

  sampleEdge(shapeHandle, edgeRef, options = {}) {
    const kernel = this.requireReady();
    if (typeof kernel.sampleEdge !== 'function') {
      throw new Error('OCCT sampleEdge is unavailable in this build');
    }
    const payload = {
      ...(options && typeof options === 'object' ? options : {}),
      edge: normalizeEdgeRef(edgeRef) || edgeRef || {},
    };
    const result = this._usesWrapperApi
      ? kernel.sampleEdge({ shape: this._shapeHandleObject(shapeHandle), ...payload })
      : kernel.sampleEdge(shapeHandle, JSON.stringify(payload.edge), JSON.stringify(payload));
    return parseJson(result, 'sampleEdge');
  }

  getEdgeCurve(shapeHandle, edgeRef) {
    const kernel = this.requireReady();
    if (typeof kernel.getEdgeCurve !== 'function') {
      throw new Error('OCCT getEdgeCurve is unavailable in this build');
    }
    const normalizedEdge = normalizeEdgeRef(edgeRef) || edgeRef || {};
    const result = this._usesWrapperApi
      ? kernel.getEdgeCurve({ shape: this._shapeHandleObject(shapeHandle), edge: normalizedEdge })
      : kernel.getEdgeCurve(shapeHandle, JSON.stringify(normalizedEdge));
    return parseJson(result, 'getEdgeCurve');
  }

  evaluateFace(shapeHandle, faceRef, u, v) {
    const kernel = this.requireReady();
    if (typeof kernel.evaluateFace !== 'function') {
      throw new Error('OCCT evaluateFace is unavailable in this build');
    }
    const normalizedFace = normalizeFaceRef(faceRef) || faceRef || {};
    const result = this._usesWrapperApi
      ? kernel.evaluateFace({ shape: this._shapeHandleObject(shapeHandle), face: normalizedFace, u: Number(u) || 0, v: Number(v) || 0 })
      : kernel.evaluateFace(shapeHandle, JSON.stringify(normalizedFace), Number(u) || 0, Number(v) || 0);
    return parseJson(result, 'evaluateFace');
  }

  createCheckpoint(shapeHandle) {
    const kernel = this.requireReady();
    if (typeof kernel.createCheckpoint !== 'function') {
      throw new Error('OCCT createCheckpoint is unavailable in this build');
    }
    const result = this._usesWrapperApi
      ? kernel.createCheckpoint({ shape: this._shapeHandleObject(shapeHandle) })
      : kernel.createCheckpoint(shapeHandle);
    return parseJson(result, 'createCheckpoint');
  }

  hydrateCheckpoint(checkpoint) {
    const kernel = this.requireReady();
    if (typeof kernel.hydrateCheckpoint !== 'function') {
      throw new Error('OCCT hydrateCheckpoint is unavailable in this build');
    }
    const result = this._usesWrapperApi
      ? kernel.hydrateCheckpoint({ checkpoint })
      : kernel.hydrateCheckpoint(typeof checkpoint === 'string' ? checkpoint : JSON.stringify(checkpoint));
    return this.rememberShape(this._wrapperResultHandle(result, 'hydrateCheckpoint'));
  }

  retainRevision(shapeHandle) {
    const kernel = this.requireReady();
    if (typeof kernel.retainRevision !== 'function') {
      throw new Error('OCCT retainRevision is unavailable in this build');
    }
    return this._usesWrapperApi
      ? kernel.retainRevision({ shape: this._shapeHandleObject(shapeHandle) })
      : kernel.retainRevision(shapeHandle);
  }

  releaseRevision(shapeHandle) {
    const kernel = this.requireReady();
    if (typeof kernel.releaseRevision !== 'function') {
      throw new Error('OCCT releaseRevision is unavailable in this build');
    }
    const disposed = this._usesWrapperApi
      ? !!kernel.releaseRevision({ shape: this._shapeHandleObject(shapeHandle) })
      : !!kernel.releaseRevision(shapeHandle);
    if (disposed) this._ownedShapes.delete(shapeHandle);
    return disposed;
  }

  tessellateRaw(shapeHandle, opts = {}) {
    const linearDeflection = opts.linearDeflection ?? opts.chordalDeviation ?? DEFAULT_LINEAR_DEFLECTION;
    const angularDeflection = opts.angularDeflection ?? opts.angularTolerance ?? DEFAULT_ANGULAR_DEFLECTION;
    const kernel = this.requireReady();
    if (this._usesWrapperApi) {
      return this._wrapperTessellationResult(kernel.tessellate({
        shape: this._shapeHandleObject(shapeHandle),
        linearDeflection,
        angularDeflection,
      }));
    }
    return kernel.tessellate(shapeHandle, linearDeflection, angularDeflection);
  }

  tessellate(shapeHandle, opts = {}) {
    return occtTessellationToMesh(this.tessellateRaw(shapeHandle, opts), opts);
  }

  disposeShape(shapeHandle) {
    if (!shapeHandle || !this.kernel) return;
    if (this._usesWrapperApi) this.kernel.disposeShape({ shape: this._shapeHandleObject(shapeHandle) });
    else this.kernel.disposeShape(shapeHandle);
    this._ownedShapes.delete(shapeHandle);
  }

  disposeAllShapes() {
    for (const handle of Array.from(this._ownedShapes)) {
      this.disposeShape(handle);
    }
  }

  dispose() {
    this.disposeAllShapes();
    if (this._ownsKernel && this.kernel) {
      if (typeof this.kernel.delete === 'function') {
        this.kernel.delete();
      } else if (typeof this.kernel._native?.delete === 'function') {
        this.kernel._native.delete();
      }
    }
    this.kernel = null;
    this.module = null;
  }
}

export default OcctKernelAdapter;
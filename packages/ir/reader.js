// packages/ir/reader.js — Deserialize CBREP v0 binary → TopoBody
//
// Reads a CBREP ArrayBuffer and reconstructs a TopoBody with full
// topology and exact NURBS geometry. Unknown section types are skipped
// gracefully for forward compatibility.

import {
  CBREP_MAGIC, CBREP_VERSION,
  SectionType, HEADER_SIZE, SECTION_ENTRY_SIZE, NULL_IDX,
  SurfTypeStr, SurfInfoTypeStr,
  CbrepError, FeatureFlag, CurveMetadataFlag,
} from './schema.js';

/**
 * Validate a CBREP buffer without full deserialization.
 * Returns { ok: true } or { ok: false, error: string }.
 *
 * @param {ArrayBuffer} buf
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateCbrep(buf) {
  try {
    _readHeader(new DataView(buf));
    // Attempt a full parse to catch data-level errors
    readCbrep(buf);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Read a CBREP binary buffer and return the canonical flat representation
 * (same shape as canonicalize() output).
 *
 * @param {ArrayBuffer} buf
 * @returns {object} canonical body representation
 */
export function readCbrepCanon(buf) {
  const dv = new DataView(buf);
  const { numSections, featureFlags } = _readHeader(dv);

  // Parse section table
  const sectionMap = new Map();
  let pos = HEADER_SIZE;
  for (let i = 0; i < numSections; i++) {
    const type = dv.getUint32(pos, true); pos += 4;
    const offset = dv.getUint32(pos, true); pos += 4;
    const length = dv.getUint32(pos, true); pos += 4;
    sectionMap.set(type, { offset, length });
  }

  // Read each section
  const curves = _readCurves(dv, sectionMap);
  const surfaces = _readSurfaces(dv, sectionMap);
  const surfaceInfos = _readSurfInfos(dv, sectionMap, featureFlags);
  const curveMetadata = _readCurveMetadata(dv, sectionMap);
  const vertices = _readVertices(dv, sectionMap);
  const edges = _readEdges(dv, sectionMap);
  const coedges = _readCoEdges(dv, sectionMap);
  const loops = _readLoops(dv, sectionMap);
  const faces = _readFaces(dv, sectionMap);
  const shells = _readShells(dv, sectionMap);
  const faceMetadata = _readFaceMetadata(dv, sectionMap);

  return { vertices, edges, coedges, loops, faces, shells, curves, surfaces, surfaceInfos, curveMetadata, faceMetadata, featureFlags };
}

/**
 * Read a CBREP binary buffer and reconstruct a TopoBody.
 *
 * @param {ArrayBuffer} buf
 * @param {{ TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody, NurbsCurve, NurbsSurface }} [deps]
 *   Optional dependency injection for topology classes. If not provided,
 *   dynamically imports from the cad module.
 * @returns {import('../../js/cad/BRepTopology.js').TopoBody}
 */
export function readCbrep(buf, deps = null) {
  const canon = readCbrepCanon(buf);

  // Use injected deps or import
  const {
    TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
    NurbsCurve, NurbsSurface, SurfaceType,
  } = deps || _getTopoDeps();

  // Reconstruct NurbsCurves
  const curveMetadataByIdx = new Map((canon.curveMetadata || []).map((entry) => [entry.curveIdx, entry.flags | 0]));
  const nurbsCurves = canon.curves.map((c, curveIdx) => {
    const curve = new NurbsCurve(c.degree, c.controlPoints, c.knots, c.weights);
    if ((curveMetadataByIdx.get(curveIdx) & CurveMetadataFlag.PRESERVE_CONTROL_POINT_SAMPLES) !== 0) {
      curve._preserveControlPointSamples = true;
    }
    return curve;
  });

  // Reconstruct NurbsSurfaces
  const nurbsSurfaces = canon.surfaces.map(s =>
    new NurbsSurface(s.degreeU, s.degreeV, s.numRowsU, s.numColsV,
      s.controlPoints, s.knotsU, s.knotsV, s.weights)
  );

  // Reconstruct vertices
  const topoVertices = canon.vertices.map(v => {
    const tv = new TopoVertex({ x: v.x, y: v.y, z: v.z }, v.tolerance);
    return tv;
  });

  // Reconstruct edges
  const topoEdges = canon.edges.map(e => {
    const sv = topoVertices[e.startVertexIdx];
    const ev = topoVertices[e.endVertexIdx];
    const curve = e.curveIdx >= 0 ? nurbsCurves[e.curveIdx] : null;
    return new TopoEdge(sv, ev, curve, e.tolerance);
  });

  // Reconstruct coedges
  const topoCoEdges = canon.coedges.map(ce => {
    const edge = topoEdges[ce.edgeIdx];
    const pCurve = ce.pCurveIdx >= 0 ? nurbsCurves[ce.pCurveIdx] : null;
    return new TopoCoEdge(edge, ce.sameSense, pCurve);
  });

  // Reconstruct loops
  const topoLoops = canon.loops.map(l => {
    const ces = l.coedgeIndices.map(i => topoCoEdges[i]);
    return new TopoLoop(ces);
  });

  const faceMetadataByIdx = new Map((canon.faceMetadata || []).map((entry) => [entry.faceIdx, entry.shared]));

  // Reconstruct faces
  const topoFaces = canon.faces.map((f, faceIdx) => {
    const surfTypeStr = SurfTypeStr[f.surfaceTypeId] || 'unknown';
    const surface = f.surfaceIdx >= 0 ? nurbsSurfaces[f.surfaceIdx] : null;
    const face = new TopoFace(surface, surfTypeStr, f.sameSense);
    face.tolerance = f.tolerance;

    if (f.outerLoopIdx >= 0) face.setOuterLoop(topoLoops[f.outerLoopIdx]);
    for (const ilIdx of f.innerLoopIndices) {
      if (ilIdx >= 0) face.addInnerLoop(topoLoops[ilIdx]);
    }

    // Restore surfaceInfo
    if (f.surfaceInfoIdx >= 0 && canon.surfaceInfos[f.surfaceInfoIdx]) {
      const si = canon.surfaceInfos[f.surfaceInfoIdx];
      face.surfaceInfo = {
        type: SurfInfoTypeStr[si.typeId] || 'plane',
        origin: { ...si.origin },
      };
      if (si.axis) face.surfaceInfo.axis = { ...si.axis };
      if (si.xDir) {
        face.surfaceInfo.xDir = { ...si.xDir };
        // yDir is derived: z × x. Computed here so the STEP-import
        // tessellator's downstream consumers (_computeVertexNormal,
        // _tessellateStripFromEdgeBounds) see the same frame as the live
        // import path.
        if (si.axis) {
          const ax = si.axis, xd = si.xDir;
          face.surfaceInfo.yDir = {
            x: ax.y * xd.z - ax.z * xd.y,
            y: ax.z * xd.x - ax.x * xd.z,
            z: ax.x * xd.y - ax.y * xd.x,
          };
        }
      }
      // PLANE uses `normal` field; STEP import sets it from axis.zDir
      if (si.axis && (SurfInfoTypeStr[si.typeId] || 'plane') === 'plane') {
        face.surfaceInfo.normal = { ...si.axis };
      }
      if (si.radius) face.surfaceInfo.radius = si.radius;
      if (si.semiAngle) face.surfaceInfo.semiAngle = si.semiAngle;
      if (si.majorR) face.surfaceInfo.majorR = si.majorR;
      if (si.minorR) face.surfaceInfo.minorR = si.minorR;
    }

    const shared = faceMetadataByIdx.get(faceIdx);
    if (shared && typeof shared === 'object') {
      face.shared = _clonePlainObject(shared);
    }

    return face;
  });

  // Reconstruct shells
  const topoShells = canon.shells.map(s => {
    const faces = s.faceIndices.map(i => topoFaces[i]);
    const shell = new TopoShell(faces);
    shell.closed = s.closed;
    return shell;
  });

  return new TopoBody(topoShells);
}

// ── Internal helpers ──────────────────────────────────────────────

let _topoDeps = null;

function _getTopoDeps() {
  if (_topoDeps) return _topoDeps;
  // Synchronous dynamic import not possible in ESM; caller must supply deps
  // or we lazy-load. For Node.js CLI use, the deps parameter is expected.
  throw new CbrepError(
    'readCbrep requires topology class dependencies. Pass { TopoVertex, TopoEdge, ... } as second argument, ' +
    'or use the readCbrepWithDeps() helper from the CLI.'
  );
}

/**
 * Set the topology dependencies for readCbrep (call once at startup).
 */
export function setTopoDeps(deps) {
  _topoDeps = deps;
}

function _readHeader(dv) {
  if (dv.byteLength < HEADER_SIZE) {
    throw new CbrepError('Buffer too small for CBREP header');
  }
  const magic = dv.getUint32(0, true);
  if (magic !== CBREP_MAGIC) {
    throw new CbrepError(`Invalid magic: 0x${magic.toString(16)} (expected 0x${CBREP_MAGIC.toString(16)})`);
  }
  const version = dv.getUint16(4, true);
  if (version > CBREP_VERSION) {
    throw new CbrepError(`Unsupported CBREP version ${version} (max supported: ${CBREP_VERSION})`);
  }
  const featureFlags = dv.getUint16(6, true);
  const headerSize = dv.getUint32(8, true);
  const numSections = dv.getUint32(12, true);

  const expectedHeaderSize = HEADER_SIZE + numSections * SECTION_ENTRY_SIZE;
  if (headerSize !== expectedHeaderSize) {
    throw new CbrepError(`Header size mismatch: ${headerSize} vs expected ${expectedHeaderSize}`);
  }
  if (dv.byteLength < headerSize) {
    throw new CbrepError('Buffer too small for section table');
  }

  return { version, featureFlags, headerSize, numSections };
}

function _readIdx(dv, pos) {
  const v = dv.getUint32(pos, true);
  return v === NULL_IDX ? -1 : v;
}

function _readVertices(dv, sectionMap) {
  const sec = sectionMap.get(SectionType.VERTICES);
  if (!sec) return [];
  let pos = sec.offset;
  const count = dv.getUint32(pos, true); pos += 4;
  const arr = [];
  for (let i = 0; i < count; i++) {
    const x = dv.getFloat64(pos, true); pos += 8;
    const y = dv.getFloat64(pos, true); pos += 8;
    const z = dv.getFloat64(pos, true); pos += 8;
    const tolerance = dv.getFloat64(pos, true); pos += 8;
    arr.push({ x, y, z, tolerance });
  }
  return arr;
}

function _readEdges(dv, sectionMap) {
  const sec = sectionMap.get(SectionType.EDGES);
  if (!sec) return [];
  let pos = sec.offset;
  const count = dv.getUint32(pos, true); pos += 4;
  const arr = [];
  for (let i = 0; i < count; i++) {
    const startVertexIdx = _readIdx(dv, pos); pos += 4;
    const endVertexIdx = _readIdx(dv, pos); pos += 4;
    const curveIdx = _readIdx(dv, pos); pos += 4;
    const tolerance = dv.getFloat64(pos, true); pos += 8;
    arr.push({ startVertexIdx, endVertexIdx, curveIdx, tolerance });
  }
  return arr;
}

function _readCoEdges(dv, sectionMap) {
  const sec = sectionMap.get(SectionType.COEDGES);
  if (!sec) return [];
  let pos = sec.offset;
  const count = dv.getUint32(pos, true); pos += 4;
  const arr = [];
  for (let i = 0; i < count; i++) {
    const edgeIdx = _readIdx(dv, pos); pos += 4;
    const sameSense = dv.getUint8(pos) === 1; pos += 1;
    const pCurveIdx = _readIdx(dv, pos); pos += 4;
    arr.push({ edgeIdx, sameSense, pCurveIdx });
  }
  return arr;
}

function _readLoops(dv, sectionMap) {
  const sec = sectionMap.get(SectionType.LOOPS);
  if (!sec) return [];
  let pos = sec.offset;
  const count = dv.getUint32(pos, true); pos += 4;
  const arr = [];
  for (let i = 0; i < count; i++) {
    const numCe = dv.getUint32(pos, true); pos += 4;
    const coedgeIndices = [];
    for (let j = 0; j < numCe; j++) {
      coedgeIndices.push(_readIdx(dv, pos)); pos += 4;
    }
    arr.push({ coedgeIndices });
  }
  return arr;
}

function _readFaces(dv, sectionMap) {
  const sec = sectionMap.get(SectionType.FACES);
  if (!sec) return [];
  let pos = sec.offset;
  const count = dv.getUint32(pos, true); pos += 4;
  const arr = [];
  for (let i = 0; i < count; i++) {
    const surfaceTypeId = dv.getUint8(pos); pos += 1;
    const surfaceIdx = _readIdx(dv, pos); pos += 4;
    const sameSense = dv.getUint8(pos) === 1; pos += 1;
    const outerLoopIdx = _readIdx(dv, pos); pos += 4;
    const numInner = dv.getUint32(pos, true); pos += 4;
    const innerLoopIndices = [];
    for (let j = 0; j < numInner; j++) {
      innerLoopIndices.push(_readIdx(dv, pos)); pos += 4;
    }
    const surfaceInfoIdx = _readIdx(dv, pos); pos += 4;
    const tolerance = dv.getFloat64(pos, true); pos += 8;
    arr.push({ surfaceTypeId, surfaceIdx, sameSense, outerLoopIdx, innerLoopIndices, surfaceInfoIdx, tolerance });
  }
  return arr;
}

function _readShells(dv, sectionMap) {
  const sec = sectionMap.get(SectionType.SHELLS);
  if (!sec) return [];
  let pos = sec.offset;
  const count = dv.getUint32(pos, true); pos += 4;
  const arr = [];
  for (let i = 0; i < count; i++) {
    const closed = dv.getUint8(pos) === 1; pos += 1;
    const numFaces = dv.getUint32(pos, true); pos += 4;
    const faceIndices = [];
    for (let j = 0; j < numFaces; j++) {
      faceIndices.push(_readIdx(dv, pos)); pos += 4;
    }
    arr.push({ closed, faceIndices });
  }
  return arr;
}

function _readCurves(dv, sectionMap) {
  const sec = sectionMap.get(SectionType.CURVES);
  if (!sec) return [];
  let pos = sec.offset;
  const count = dv.getUint32(pos, true); pos += 4;
  const arr = [];
  for (let i = 0; i < count; i++) {
    const degree = dv.getUint32(pos, true); pos += 4;
    const numCp = dv.getUint32(pos, true); pos += 4;
    const controlPoints = [];
    for (let j = 0; j < numCp; j++) {
      const x = dv.getFloat64(pos, true); pos += 8;
      const y = dv.getFloat64(pos, true); pos += 8;
      const z = dv.getFloat64(pos, true); pos += 8;
      controlPoints.push({ x, y, z });
    }
    const numKnots = dv.getUint32(pos, true); pos += 4;
    const knots = [];
    for (let j = 0; j < numKnots; j++) {
      knots.push(dv.getFloat64(pos, true)); pos += 8;
    }
    const numWeights = dv.getUint32(pos, true); pos += 4;
    const weights = [];
    for (let j = 0; j < numWeights; j++) {
      weights.push(dv.getFloat64(pos, true)); pos += 8;
    }
    arr.push({ degree, controlPoints, knots, weights });
  }
  return arr;
}

function _readSurfaces(dv, sectionMap) {
  const sec = sectionMap.get(SectionType.SURFACES);
  if (!sec) return [];
  let pos = sec.offset;
  const count = dv.getUint32(pos, true); pos += 4;
  const arr = [];
  for (let i = 0; i < count; i++) {
    const degreeU = dv.getUint32(pos, true); pos += 4;
    const degreeV = dv.getUint32(pos, true); pos += 4;
    const numRowsU = dv.getUint32(pos, true); pos += 4;
    const numColsV = dv.getUint32(pos, true); pos += 4;
    const numCp = numRowsU * numColsV;
    const controlPoints = [];
    for (let j = 0; j < numCp; j++) {
      const x = dv.getFloat64(pos, true); pos += 8;
      const y = dv.getFloat64(pos, true); pos += 8;
      const z = dv.getFloat64(pos, true); pos += 8;
      controlPoints.push({ x, y, z });
    }
    const numKnotsU = dv.getUint32(pos, true); pos += 4;
    const knotsU = [];
    for (let j = 0; j < numKnotsU; j++) {
      knotsU.push(dv.getFloat64(pos, true)); pos += 8;
    }
    const numKnotsV = dv.getUint32(pos, true); pos += 4;
    const knotsV = [];
    for (let j = 0; j < numKnotsV; j++) {
      knotsV.push(dv.getFloat64(pos, true)); pos += 8;
    }
    const numWeights = dv.getUint32(pos, true); pos += 4;
    const weights = [];
    for (let j = 0; j < numWeights; j++) {
      weights.push(dv.getFloat64(pos, true)); pos += 8;
    }
    arr.push({ degreeU, degreeV, numRowsU, numColsV, controlPoints, knotsU, knotsV, weights });
  }
  return arr;
}

function _readSurfInfos(dv, sectionMap, featureFlags = 0) {
  const sec = sectionMap.get(SectionType.SURF_INFOS);
  if (!sec) return [];
  const hasXDir = (featureFlags & FeatureFlag.HAS_SURFACE_INFOS_V2) !== 0;
  let pos = sec.offset;
  const count = dv.getUint32(pos, true); pos += 4;
  const arr = [];
  for (let i = 0; i < count; i++) {
    const typeId = dv.getUint8(pos); pos += 1;
    const ox = dv.getFloat64(pos, true); pos += 8;
    const oy = dv.getFloat64(pos, true); pos += 8;
    const oz = dv.getFloat64(pos, true); pos += 8;
    const hasAxis = dv.getUint8(pos); pos += 1;
    let axis = null;
    if (hasAxis) {
      const ax = dv.getFloat64(pos, true); pos += 8;
      const ay = dv.getFloat64(pos, true); pos += 8;
      const az = dv.getFloat64(pos, true); pos += 8;
      axis = { x: ax, y: ay, z: az };
    }
    let xDir = null;
    if (hasXDir) {
      const hasX = dv.getUint8(pos); pos += 1;
      if (hasX) {
        const xx = dv.getFloat64(pos, true); pos += 8;
        const xy = dv.getFloat64(pos, true); pos += 8;
        const xz = dv.getFloat64(pos, true); pos += 8;
        xDir = { x: xx, y: xy, z: xz };
      }
    }
    const radius = dv.getFloat64(pos, true); pos += 8;
    const semiAngle = dv.getFloat64(pos, true); pos += 8;
    const majorR = dv.getFloat64(pos, true); pos += 8;
    const minorR = dv.getFloat64(pos, true); pos += 8;
    arr.push({ typeId, origin: { x: ox, y: oy, z: oz }, axis, xDir, radius, semiAngle, majorR, minorR });
  }
  return arr;
}

function _readCurveMetadata(dv, sectionMap) {
  const sec = sectionMap.get(SectionType.CURVE_METADATA);
  if (!sec) return [];
  let pos = sec.offset;
  const count = dv.getUint32(pos, true); pos += 4;
  const arr = [];
  for (let i = 0; i < count; i++) {
    const curveIdx = dv.getUint32(pos, true); pos += 4;
    const flags = dv.getUint32(pos, true); pos += 4;
    arr.push({ curveIdx, flags });
  }
  return arr;
}

function _readFaceMetadata(dv, sectionMap) {
  const sec = sectionMap.get(SectionType.FACE_METADATA);
  if (!sec) return [];
  const decoder = new TextDecoder();
  let pos = sec.offset;
  const count = dv.getUint32(pos, true); pos += 4;
  const arr = [];
  for (let i = 0; i < count; i++) {
    const faceIdx = dv.getUint32(pos, true); pos += 4;
    const byteLength = dv.getUint32(pos, true); pos += 4;
    if (pos + byteLength > sec.offset + sec.length) {
      throw new CbrepError('face metadata section overruns its declared length');
    }
    const json = decoder.decode(new Uint8Array(dv.buffer, dv.byteOffset + pos, byteLength));
    pos += byteLength;
    let shared;
    try {
      shared = JSON.parse(json);
    } catch (error) {
      throw new CbrepError(`invalid face metadata JSON: ${error.message}`);
    }
    arr.push({ faceIdx, shared });
  }
  return arr;
}

function _clonePlainObject(value) {
  if (Array.isArray(value)) return value.map(_clonePlainObject);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = _clonePlainObject(child);
  return out;
}

// packages/ir/writer.js — Serialize canonical TopoBody → CBREP v0 binary
//
// Produces a deterministic ArrayBuffer from the canonical flat representation
// returned by canonicalize(). The output is byte-for-byte identical for the
// same input model regardless of runtime or platform.
//
// ─── Section data layouts ──────────────────────────────────────────
//
// VERTICES section:
//   uint32   count
//   per vertex: float64 x, float64 y, float64 z, float64 tolerance   (32 bytes)
//
// EDGES section:
//   uint32   count
//   per edge: uint32 startVertexIdx, uint32 endVertexIdx, uint32 curveIdx, float64 tolerance   (20 bytes)
//
// COEDGES section:
//   uint32   count
//   per coedge: uint32 edgeIdx, uint8 sameSense, uint32 pCurveIdx   (9 bytes)
//
// LOOPS section:
//   uint32   count
//   per loop: uint32 numCoedges, uint32[] coedgeIndices
//
// FACES section:
//   uint32   count
//   per face: uint8 surfaceTypeId, uint32 surfaceIdx, uint8 sameSense,
//             uint32 outerLoopIdx, uint32 numInnerLoops, uint32[] innerLoopIndices,
//             uint32 surfaceInfoIdx, float64 tolerance
//
// SHELLS section:
//   uint32   count
//   per shell: uint8 closed, uint32 numFaces, uint32[] faceIndices
//
// CURVES section:
//   uint32   count
//   per curve: uint32 degree, uint32 numControlPoints,
//              float64[numCp * 3] controlPoints (x,y,z),
//              uint32 numKnots, float64[] knots,
//              uint32 numWeights, float64[] weights
//
// SURFACES section:
//   uint32   count
//   per surface: uint32 degreeU, uint32 degreeV, uint32 numRowsU, uint32 numColsV,
//                float64[numCp * 3] controlPoints,
//                uint32 numKnotsU, float64[] knotsU,
//                uint32 numKnotsV, float64[] knotsV,
//                uint32 numWeights, float64[] weights
//
// SURF_INFOS section:
//   uint32   count
//   per info: uint8 typeId, float64 originX/Y/Z, uint8 hasAxis, float64 axisX/Y/Z (if hasAxis),
//             float64 radius, float64 semiAngle, float64 majorR, float64 minorR

import {
  CBREP_MAGIC, CBREP_VERSION,
  SectionType, HEADER_SIZE, SECTION_ENTRY_SIZE, NULL_IDX,
} from './schema.js';

/**
 * Write a canonical body to CBREP v0 binary format.
 *
 * @param {import('./canonicalize.js').CanonBody} canon — output of canonicalize()
 * @returns {ArrayBuffer}
 */
export function writeCbrep(canon) {
  // ── Phase 1: compute section sizes ──

  const sections = [];

  // Vertices: 4 + count * 32
  const vertSize = 4 + canon.vertices.length * 32;
  sections.push({ type: SectionType.VERTICES, size: vertSize });

  // Edges: 4 + count * 20
  const edgeSize = 4 + canon.edges.length * 20;
  sections.push({ type: SectionType.EDGES, size: edgeSize });

  // CoEdges: 4 + count * 9
  const ceSize = 4 + canon.coedges.length * 9;
  sections.push({ type: SectionType.COEDGES, size: ceSize });

  // Loops: variable length
  let loopSize = 4; // count
  for (const l of canon.loops) {
    loopSize += 4 + l.coedgeIndices.length * 4; // numCoedges + indices
  }
  sections.push({ type: SectionType.LOOPS, size: loopSize });

  // Faces: variable length
  let faceSize = 4; // count
  for (const f of canon.faces) {
    faceSize += 1 + 4 + 1 + 4 + 4 + f.innerLoopIndices.length * 4 + 4 + 8;
    // surfTypeId(1) + surfIdx(4) + sameSense(1) + outerLoopIdx(4) +
    // numInnerLoops(4) + innerLoopIdxs(var) + surfInfoIdx(4) + tolerance(8)
  }
  sections.push({ type: SectionType.FACES, size: faceSize });

  // Shells: variable length
  let shellSize = 4; // count
  for (const s of canon.shells) {
    shellSize += 1 + 4 + s.faceIndices.length * 4; // closed(1) + numFaces(4) + indices
  }
  sections.push({ type: SectionType.SHELLS, size: shellSize });

  // Curves: variable length
  let curveSize = 4; // count
  for (const c of canon.curves) {
    curveSize += 4 + 4 + c.controlPoints.length * 24 + 4 + c.knots.length * 8 + 4 + c.weights.length * 8;
    // degree(4) + numCp(4) + cp_data + numKnots(4) + knots + numWeights(4) + weights
  }
  sections.push({ type: SectionType.CURVES, size: curveSize });

  // Surfaces: variable length
  let surfSize = 4; // count
  for (const s of canon.surfaces) {
    surfSize += 4 + 4 + 4 + 4 + s.controlPoints.length * 24 +
      4 + s.knotsU.length * 8 + 4 + s.knotsV.length * 8 + 4 + s.weights.length * 8;
    // degreeU(4) + degreeV(4) + numRowsU(4) + numColsV(4) + cp_data +
    // numKnotsU(4) + knotsU + numKnotsV(4) + knotsV + numWeights(4) + weights
  }
  sections.push({ type: SectionType.SURFACES, size: surfSize });

  // SurfaceInfos: variable length (only if present)
  let siSize = 0;
  if (canon.surfaceInfos.length > 0) {
    siSize = 4; // count
    for (const si of canon.surfaceInfos) {
      siSize += 1 + 24 + 1 + (si.axis ? 24 : 0) + 32;
      // typeId(1) + origin(24) + hasAxis(1) + axis?(24) + radius+semiAngle+majorR+minorR(32)
    }
    sections.push({ type: SectionType.SURF_INFOS, size: siSize });
  }

  // ── Phase 2: compute offsets ──

  const numSections = sections.length;
  const headerTotal = HEADER_SIZE + numSections * SECTION_ENTRY_SIZE;

  let dataOffset = headerTotal;
  for (const sec of sections) {
    sec.offset = dataOffset;
    dataOffset += sec.size;
  }

  const totalSize = dataOffset;

  // ── Phase 3: write binary ──

  const buf = new ArrayBuffer(totalSize);
  const dv = new DataView(buf);
  let pos = 0;

  // Header
  dv.setUint32(pos, CBREP_MAGIC, true); pos += 4;
  dv.setUint16(pos, CBREP_VERSION, true); pos += 2;
  dv.setUint16(pos, canon.featureFlags, true); pos += 2;
  dv.setUint32(pos, headerTotal, true); pos += 4;
  dv.setUint32(pos, numSections, true); pos += 4;

  // Section table
  for (const sec of sections) {
    dv.setUint32(pos, sec.type, true); pos += 4;
    dv.setUint32(pos, sec.offset, true); pos += 4;
    dv.setUint32(pos, sec.size, true); pos += 4;
  }

  // ── Write section data ──

  // Helper: write idx (uses NULL_IDX sentinel for -1)
  function writeIdx(idx) {
    dv.setUint32(pos, idx < 0 ? NULL_IDX : idx, true); pos += 4;
  }

  // VERTICES
  pos = sections[0].offset;
  dv.setUint32(pos, canon.vertices.length, true); pos += 4;
  for (const v of canon.vertices) {
    dv.setFloat64(pos, v.x, true); pos += 8;
    dv.setFloat64(pos, v.y, true); pos += 8;
    dv.setFloat64(pos, v.z, true); pos += 8;
    dv.setFloat64(pos, v.tolerance, true); pos += 8;
  }

  // EDGES
  pos = sections[1].offset;
  dv.setUint32(pos, canon.edges.length, true); pos += 4;
  for (const e of canon.edges) {
    writeIdx(e.startVertexIdx);
    writeIdx(e.endVertexIdx);
    writeIdx(e.curveIdx);
    dv.setFloat64(pos, e.tolerance, true); pos += 8;
  }

  // COEDGES
  pos = sections[2].offset;
  dv.setUint32(pos, canon.coedges.length, true); pos += 4;
  for (const ce of canon.coedges) {
    writeIdx(ce.edgeIdx);
    dv.setUint8(pos, ce.sameSense ? 1 : 0); pos += 1;
    writeIdx(ce.pCurveIdx);
  }

  // LOOPS
  pos = sections[3].offset;
  dv.setUint32(pos, canon.loops.length, true); pos += 4;
  for (const l of canon.loops) {
    dv.setUint32(pos, l.coedgeIndices.length, true); pos += 4;
    for (const ci of l.coedgeIndices) {
      writeIdx(ci);
    }
  }

  // FACES
  pos = sections[4].offset;
  dv.setUint32(pos, canon.faces.length, true); pos += 4;
  for (const f of canon.faces) {
    dv.setUint8(pos, f.surfaceTypeId); pos += 1;
    writeIdx(f.surfaceIdx);
    dv.setUint8(pos, f.sameSense ? 1 : 0); pos += 1;
    writeIdx(f.outerLoopIdx);
    dv.setUint32(pos, f.innerLoopIndices.length, true); pos += 4;
    for (const il of f.innerLoopIndices) writeIdx(il);
    writeIdx(f.surfaceInfoIdx);
    dv.setFloat64(pos, f.tolerance, true); pos += 8;
  }

  // SHELLS
  pos = sections[5].offset;
  dv.setUint32(pos, canon.shells.length, true); pos += 4;
  for (const s of canon.shells) {
    dv.setUint8(pos, s.closed ? 1 : 0); pos += 1;
    dv.setUint32(pos, s.faceIndices.length, true); pos += 4;
    for (const fi of s.faceIndices) writeIdx(fi);
  }

  // CURVES
  const curveSecIdx = 6;
  pos = sections[curveSecIdx].offset;
  dv.setUint32(pos, canon.curves.length, true); pos += 4;
  for (const c of canon.curves) {
    dv.setUint32(pos, c.degree, true); pos += 4;
    dv.setUint32(pos, c.controlPoints.length, true); pos += 4;
    for (const p of c.controlPoints) {
      dv.setFloat64(pos, p.x, true); pos += 8;
      dv.setFloat64(pos, p.y, true); pos += 8;
      dv.setFloat64(pos, p.z, true); pos += 8;
    }
    dv.setUint32(pos, c.knots.length, true); pos += 4;
    for (const k of c.knots) { dv.setFloat64(pos, k, true); pos += 8; }
    dv.setUint32(pos, c.weights.length, true); pos += 4;
    for (const w of c.weights) { dv.setFloat64(pos, w, true); pos += 8; }
  }

  // SURFACES
  const surfSecIdx = 7;
  pos = sections[surfSecIdx].offset;
  dv.setUint32(pos, canon.surfaces.length, true); pos += 4;
  for (const s of canon.surfaces) {
    dv.setUint32(pos, s.degreeU, true); pos += 4;
    dv.setUint32(pos, s.degreeV, true); pos += 4;
    dv.setUint32(pos, s.numRowsU, true); pos += 4;
    dv.setUint32(pos, s.numColsV, true); pos += 4;
    for (const p of s.controlPoints) {
      dv.setFloat64(pos, p.x, true); pos += 8;
      dv.setFloat64(pos, p.y, true); pos += 8;
      dv.setFloat64(pos, p.z, true); pos += 8;
    }
    dv.setUint32(pos, s.knotsU.length, true); pos += 4;
    for (const k of s.knotsU) { dv.setFloat64(pos, k, true); pos += 8; }
    dv.setUint32(pos, s.knotsV.length, true); pos += 4;
    for (const k of s.knotsV) { dv.setFloat64(pos, k, true); pos += 8; }
    dv.setUint32(pos, s.weights.length, true); pos += 4;
    for (const w of s.weights) { dv.setFloat64(pos, w, true); pos += 8; }
  }

  // SURF_INFOS (if present)
  if (canon.surfaceInfos.length > 0) {
    const siSecIdx = sections.findIndex(s => s.type === SectionType.SURF_INFOS);
    pos = sections[siSecIdx].offset;
    dv.setUint32(pos, canon.surfaceInfos.length, true); pos += 4;
    for (const si of canon.surfaceInfos) {
      dv.setUint8(pos, si.typeId); pos += 1;
      dv.setFloat64(pos, si.origin.x, true); pos += 8;
      dv.setFloat64(pos, si.origin.y, true); pos += 8;
      dv.setFloat64(pos, si.origin.z, true); pos += 8;
      const hasAxis = si.axis ? 1 : 0;
      dv.setUint8(pos, hasAxis); pos += 1;
      if (si.axis) {
        dv.setFloat64(pos, si.axis.x, true); pos += 8;
        dv.setFloat64(pos, si.axis.y, true); pos += 8;
        dv.setFloat64(pos, si.axis.z, true); pos += 8;
      }
      dv.setFloat64(pos, si.radius, true); pos += 8;
      dv.setFloat64(pos, si.semiAngle, true); pos += 8;
      dv.setFloat64(pos, si.majorR, true); pos += 8;
      dv.setFloat64(pos, si.minorR, true); pos += 8;
    }
  }

  return buf;
}

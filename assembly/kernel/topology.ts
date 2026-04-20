// kernel/topology — native B-Rep entities
//
// Exact B-Rep data structures stored in WASM linear memory.
// Each body is a hierarchy: Body → Shell → Face → Loop → CoEdge → Edge → Vertex
//
// All entities use dense flat arrays indexed by entity id (u32).
// Entity ids are local to a body handle — they are NOT global across bodies.
// This keeps per-body memory compact and allows parallel body construction.

// ---------- capacity limits ----------

/** Max entities per body. Sized for large imported STEP solids. */
export const MAX_VERTICES: u32 = 16384;
export const MAX_EDGES: u32 = 32768;
export const MAX_COEDGES: u32 = 65536;
export const MAX_LOOPS: u32 = 32768;
export const MAX_FACES: u32 = 16384;
export const MAX_SHELLS: u32 = 256;

// ---------- geometry type tags ----------

export const GEOM_NONE: u8 = 0;
export const GEOM_PLANE: u8 = 1;
export const GEOM_CYLINDER: u8 = 2;
export const GEOM_CONE: u8 = 3;
export const GEOM_SPHERE: u8 = 4;
export const GEOM_TORUS: u8 = 5;
export const GEOM_NURBS_SURFACE: u8 = 6;
export const GEOM_LINE: u8 = 7;
export const GEOM_CIRCLE: u8 = 8;
export const GEOM_ELLIPSE: u8 = 9;
export const GEOM_NURBS_CURVE: u8 = 10;

// ---------- orientation ----------

export const ORIENT_FORWARD: u8 = 0;
export const ORIENT_REVERSED: u8 = 1;

// ---------- vertex ----------

/** Vertex coordinates — 3 × f64 per vertex (x, y, z). */
const vertexCoords = new StaticArray<f64>(MAX_VERTICES * 3);
let vertexCount: u32 = 0;

export function vertexAdd(x: f64, y: f64, z: f64): u32 {
  const id = vertexCount;
  if (id >= MAX_VERTICES) return 0xFFFFFFFF; // overflow sentinel
  const off = id * 3;
  unchecked(vertexCoords[off] = x);
  unchecked(vertexCoords[off + 1] = y);
  unchecked(vertexCoords[off + 2] = z);
  vertexCount++;
  return id;
}

export function vertexGetX(id: u32): f64 { return unchecked(vertexCoords[id * 3]); }
export function vertexGetY(id: u32): f64 { return unchecked(vertexCoords[id * 3 + 1]); }
export function vertexGetZ(id: u32): f64 { return unchecked(vertexCoords[id * 3 + 2]); }
export function vertexGetCount(): u32 { return vertexCount; }

// ---------- edge ----------

/** Edge: startVertex, endVertex, geometryType, geometryDataOffset */
const edgeStartVertex = new StaticArray<u32>(MAX_EDGES);
const edgeEndVertex = new StaticArray<u32>(MAX_EDGES);
const edgeGeomType = new StaticArray<u8>(MAX_EDGES);
/** Offset into a geometry data pool (curve definition). */
const edgeGeomOffset = new StaticArray<u32>(MAX_EDGES);
let edgeCount: u32 = 0;

export function edgeAdd(startV: u32, endV: u32, geomType: u8, geomOffset: u32): u32 {
  const id = edgeCount;
  if (id >= MAX_EDGES) return 0xFFFFFFFF;
  unchecked(edgeStartVertex[id] = startV);
  unchecked(edgeEndVertex[id] = endV);
  unchecked(edgeGeomType[id] = geomType);
  unchecked(edgeGeomOffset[id] = geomOffset);
  edgeCount++;
  return id;
}

export function edgeGetStartVertex(id: u32): u32 { return unchecked(edgeStartVertex[id]); }
export function edgeGetEndVertex(id: u32): u32 { return unchecked(edgeEndVertex[id]); }
export function edgeGetGeomType(id: u32): u8 { return unchecked(edgeGeomType[id]); }
export function edgeGetGeomOffset(id: u32): u32 { return unchecked(edgeGeomOffset[id]); }
export function edgeGetCount(): u32 { return edgeCount; }

// ---------- coedge ----------

/** CoEdge: edgeId, orientation, nextCoEdge, loopId */
const coedgeEdge = new StaticArray<u32>(MAX_COEDGES);
const coedgeOrient = new StaticArray<u8>(MAX_COEDGES);
const coedgeNext = new StaticArray<u32>(MAX_COEDGES);
const coedgeLoop = new StaticArray<u32>(MAX_COEDGES);
let coedgeCount: u32 = 0;

export function coedgeAdd(edgeId: u32, orient: u8, nextCoedge: u32, loopId: u32): u32 {
  const id = coedgeCount;
  if (id >= MAX_COEDGES) return 0xFFFFFFFF;
  unchecked(coedgeEdge[id] = edgeId);
  unchecked(coedgeOrient[id] = orient);
  unchecked(coedgeNext[id] = nextCoedge);
  unchecked(coedgeLoop[id] = loopId);
  coedgeCount++;
  return id;
}

export function coedgeGetEdge(id: u32): u32 { return unchecked(coedgeEdge[id]); }
export function coedgeGetOrient(id: u32): u8 { return unchecked(coedgeOrient[id]); }
export function coedgeGetNext(id: u32): u32 { return unchecked(coedgeNext[id]); }
export function coedgeGetLoop(id: u32): u32 { return unchecked(coedgeLoop[id]); }
export function coedgeSetNext(id: u32, nextId: u32): void { unchecked(coedgeNext[id] = nextId); }
export function coedgeGetCount(): u32 { return coedgeCount; }

// ---------- loop ----------

/** Loop: firstCoEdge, faceId, isOuter */
const loopFirstCoedge = new StaticArray<u32>(MAX_LOOPS);
const loopFace = new StaticArray<u32>(MAX_LOOPS);
const loopIsOuter = new StaticArray<u8>(MAX_LOOPS);
let loopCount: u32 = 0;

export function loopAdd(firstCoedge: u32, faceId: u32, isOuter: u8): u32 {
  const id = loopCount;
  if (id >= MAX_LOOPS) return 0xFFFFFFFF;
  unchecked(loopFirstCoedge[id] = firstCoedge);
  unchecked(loopFace[id] = faceId);
  unchecked(loopIsOuter[id] = isOuter);
  loopCount++;
  return id;
}

export function loopGetFirstCoedge(id: u32): u32 { return unchecked(loopFirstCoedge[id]); }
export function loopGetFace(id: u32): u32 { return unchecked(loopFace[id]); }
export function loopIsOuterLoop(id: u32): u8 { return unchecked(loopIsOuter[id]); }
export function loopGetCount(): u32 { return loopCount; }

// ---------- face ----------

/** Face: firstLoop, shellId, geometryType, geometryDataOffset, orientation */
const faceFirstLoop = new StaticArray<u32>(MAX_FACES);
const faceShell = new StaticArray<u32>(MAX_FACES);
const faceGeomType = new StaticArray<u8>(MAX_FACES);
const faceGeomOffset = new StaticArray<u32>(MAX_FACES);
const faceOrient = new StaticArray<u8>(MAX_FACES);
/** Number of loops per face (first is outer, rest are inner/holes). */
const faceLoopCount = new StaticArray<u32>(MAX_FACES);
let faceCount: u32 = 0;

export function faceAdd(firstLoop: u32, shellId: u32, geomType: u8, geomOffset: u32, orient: u8, numLoops: u32): u32 {
  const id = faceCount;
  if (id >= MAX_FACES) return 0xFFFFFFFF;
  unchecked(faceFirstLoop[id] = firstLoop);
  unchecked(faceShell[id] = shellId);
  unchecked(faceGeomType[id] = geomType);
  unchecked(faceGeomOffset[id] = geomOffset);
  unchecked(faceOrient[id] = orient);
  unchecked(faceLoopCount[id] = numLoops);
  faceCount++;
  return id;
}

export function faceGetFirstLoop(id: u32): u32 { return unchecked(faceFirstLoop[id]); }
export function faceGetShell(id: u32): u32 { return unchecked(faceShell[id]); }
export function faceGetGeomType(id: u32): u8 { return unchecked(faceGeomType[id]); }
export function faceGetGeomOffset(id: u32): u32 { return unchecked(faceGeomOffset[id]); }
export function faceGetOrient(id: u32): u8 { return unchecked(faceOrient[id]); }
export function faceGetLoopCount(id: u32): u32 { return unchecked(faceLoopCount[id]); }
export function faceGetCount(): u32 { return faceCount; }

// ---------- shell ----------

/** Shell: firstFace, faceCount, isClosed */
const shellFirstFace = new StaticArray<u32>(MAX_SHELLS);
const shellFaceCount = new StaticArray<u32>(MAX_SHELLS);
const shellIsClosed = new StaticArray<u8>(MAX_SHELLS);
let shellCount: u32 = 0;

export function shellAdd(firstFace: u32, numFaces: u32, isClosed: u8): u32 {
  const id = shellCount;
  if (id >= MAX_SHELLS) return 0xFFFFFFFF;
  unchecked(shellFirstFace[id] = firstFace);
  unchecked(shellFaceCount[id] = numFaces);
  unchecked(shellIsClosed[id] = isClosed);
  shellCount++;
  return id;
}

export function shellGetFirstFace(id: u32): u32 { return unchecked(shellFirstFace[id]); }
export function shellGetFaceCount(id: u32): u32 { return unchecked(shellFaceCount[id]); }
export function shellIsClosed_(id: u32): u8 { return unchecked(shellIsClosed[id]); }
export function shellGetCount(): u32 { return shellCount; }

// ---------- body-level ----------

/** Number of shells in the current body being built. */
let bodyShellCount: u32 = 0;
let bodyFirstShell: u32 = 0;

/** Handle id for the body currently being built (0 = legacy single-body mode). */
let activeHandleId: u32 = 0;

export function bodyBegin(): void {
  // Reset all counters for a fresh body (legacy single-body mode)
  vertexCount = 0;
  edgeCount = 0;
  coedgeCount = 0;
  loopCount = 0;
  faceCount = 0;
  shellCount = 0;
  bodyShellCount = 0;
  bodyFirstShell = 0;
  activeHandleId = 0;
}

import {
  handleSetBodyStart, handleSetBodyEnd,
  handleGetFaceStart as _hgfs, handleGetFaceEnd as _hgfe,
} from './core';
import { geomPoolUsed as _geomPoolUsed2 } from './geometry';

/**
 * Begin building a body for a specific handle (append-only mode).
 * Records current entity counts as the handle's start offsets.
 * Does NOT reset counters — entities are appended after existing data.
 */
export function bodyBeginForHandle(handleId: u32): void {
  activeHandleId = handleId;
  bodyShellCount = 0;
  bodyFirstShell = shellCount;
  handleSetBodyStart(handleId,
    vertexCount, edgeCount, coedgeCount, loopCount,
    faceCount, shellCount, _geomPoolUsed2()
  );
}

/**
 * End body definition for the active handle. Records end offsets.
 * @returns shell count for this body
 */
export function bodyEndForHandle(): u32 {
  const shells = shellCount - bodyFirstShell;
  bodyShellCount = shells;
  if (activeHandleId != 0) {
    handleSetBodyEnd(activeHandleId,
      vertexCount, edgeCount, coedgeCount, loopCount,
      faceCount, shellCount, _geomPoolUsed2()
    );
  }
  activeHandleId = 0;
  return shells;
}

export function bodyEnd(): u32 {
  // Returns the total shell count for this body
  if (activeHandleId != 0) {
    return bodyEndForHandle();
  }
  bodyShellCount = shellCount;
  return shellCount;
}

export function bodyGetShellCount(): u32 { return bodyShellCount; }
export function bodyGetFirstShell(): u32 { return bodyFirstShell; }

/**
 * Reset all topology (for full clear / project load).
 * Distinct from bodyBegin which only resets for single-body mode.
 */
export function topologyResetAll(): void {
  vertexCount = 0;
  edgeCount = 0;
  coedgeCount = 0;
  loopCount = 0;
  faceCount = 0;
  shellCount = 0;
  bodyShellCount = 0;
  bodyFirstShell = 0;
  activeHandleId = 0;
}

// ---------- bulk data access (for interop / JS bridge) ----------

/** Get pointer to vertex coordinate array for zero-copy read from JS. */
export function getVertexCoordsPtr(): usize {
  return changetype<usize>(vertexCoords);
}

export function getVertexCoordsLen(): u32 {
  return vertexCount * 3;
}

/** Get pointer to edge arrays for JS bridge. */
export function getEdgeStartVertexPtr(): usize { return changetype<usize>(edgeStartVertex); }
export function getEdgeEndVertexPtr(): usize { return changetype<usize>(edgeEndVertex); }

/** Entity count summary for diagnostics. */
export function topoGetSummary(outBuf: StaticArray<u32>): void {
  unchecked(outBuf[0] = vertexCount);
  unchecked(outBuf[1] = edgeCount);
  unchecked(outBuf[2] = coedgeCount);
  unchecked(outBuf[3] = loopCount);
  unchecked(outBuf[4] = faceCount);
  unchecked(outBuf[5] = shellCount);
}

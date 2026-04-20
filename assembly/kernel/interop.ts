// kernel/interop — CBREP hydration/dehydration and JS bridge contracts
//
// Provides serialization of native B-Rep topology to/from a deterministic
// binary format (CBREP) that can be stored outside the WASM heap for
// persistence, undo/redo, and cross-worker transfer.
//
// CBREP wire format (all little-endian):
//   Header:
//     [0..3]   magic 'CBRP' (0x43425250)
//     [4..7]   version (u32, currently 1)
//     [8..11]  vertexCount (u32)
//     [12..15] edgeCount (u32)
//     [16..19] coedgeCount (u32)
//     [20..23] loopCount (u32)
//     [24..27] faceCount (u32)
//     [28..31] shellCount (u32)
//     [32..35] geomPoolUsed (u32)
//   Sections (in order):
//     vertices:  vertexCount × 3 × f64 (24 bytes each)
//     edges:     edgeCount × (startV:u32 + endV:u32 + geomType:u8 + pad:u8[3] + geomOffset:u32) = 16 bytes each
//     coedges:   coedgeCount × (edgeId:u32 + orient:u8 + pad:u8[3] + nextCoedge:u32 + loopId:u32) = 16 bytes each
//     loops:     loopCount × (firstCoedge:u32 + faceId:u32 + isOuter:u8 + pad:u8[3]) = 12 bytes each
//     faces:     faceCount × (firstLoop:u32 + shellId:u32 + geomType:u8 + pad:u8[3] + geomOffset:u32 + orient:u8 + pad:u8[3] + loopCount:u32) = 24 bytes each
//     shells:    shellCount × (firstFace:u32 + faceCount:u32 + isClosed:u8 + pad:u8[3]) = 12 bytes each
//     geomPool:  geomPoolUsed × f64 (8 bytes each)

import {
  vertexAdd, vertexGetX, vertexGetY, vertexGetZ, vertexGetCount,
  edgeAdd, edgeGetStartVertex, edgeGetEndVertex, edgeGetGeomType, edgeGetGeomOffset, edgeGetCount,
  coedgeAdd, coedgeGetEdge, coedgeGetOrient, coedgeGetNext, coedgeGetLoop, coedgeGetCount,
  loopAdd, loopGetFirstCoedge, loopGetFace, loopIsOuterLoop, loopGetCount,
  faceAdd, faceGetFirstLoop, faceGetShell, faceGetGeomType, faceGetGeomOffset, faceGetOrient, faceGetLoopCount, faceGetCount,
  shellAdd, shellGetFirstFace, shellGetFaceCount, shellIsClosed_, shellGetCount,
  bodyBegin, bodyBeginForHandle, bodyEndForHandle
} from './topology';

import { geomPoolRead, geomPoolUsed, geomPoolReset, geomPoolSetUsed as _geomPoolSetUsed } from './geometry';

// ---------- constants ----------

const CBREP_MAGIC: u32 = 0x43425250; // 'CBRP'
const CBREP_VERSION: u32 = 1;
const HEADER_SIZE: u32 = 36; // 9 × u32

// ---------- serialization output ----------

/** Max CBREP output size in bytes (4 MB). */
const MAX_CBREP_SIZE: u32 = 4194304;
const cbrepOut = new StaticArray<u8>(MAX_CBREP_SIZE);
let cbrepOutLen: u32 = 0;

// ---------- serialization helpers ----------

@inline
function writeU32(buf: StaticArray<u8>, offset: u32, val: u32): void {
  unchecked(buf[offset]     = <u8>(val & 0xFF));
  unchecked(buf[offset + 1] = <u8>((val >> 8) & 0xFF));
  unchecked(buf[offset + 2] = <u8>((val >> 16) & 0xFF));
  unchecked(buf[offset + 3] = <u8>((val >> 24) & 0xFF));
}

@inline
function writeU8(buf: StaticArray<u8>, offset: u32, val: u8): void {
  unchecked(buf[offset] = val);
}

@inline
function writeF64(buf: StaticArray<u8>, offset: u32, val: f64): void {
  // Reinterpret f64 as u64 bits
  const bits = reinterpret<u64>(val);
  unchecked(buf[offset]     = <u8>(bits & 0xFF));
  unchecked(buf[offset + 1] = <u8>((bits >> 8)  & 0xFF));
  unchecked(buf[offset + 2] = <u8>((bits >> 16) & 0xFF));
  unchecked(buf[offset + 3] = <u8>((bits >> 24) & 0xFF));
  unchecked(buf[offset + 4] = <u8>((bits >> 32) & 0xFF));
  unchecked(buf[offset + 5] = <u8>((bits >> 40) & 0xFF));
  unchecked(buf[offset + 6] = <u8>((bits >> 48) & 0xFF));
  unchecked(buf[offset + 7] = <u8>((bits >> 56) & 0xFF));
}

@inline
function readU32(buf: StaticArray<u8>, offset: u32): u32 {
  return <u32>unchecked(buf[offset])
       | (<u32>unchecked(buf[offset + 1]) << 8)
       | (<u32>unchecked(buf[offset + 2]) << 16)
       | (<u32>unchecked(buf[offset + 3]) << 24);
}

@inline
function readU8(buf: StaticArray<u8>, offset: u32): u8 {
  return unchecked(buf[offset]);
}

@inline
function readF64(buf: StaticArray<u8>, offset: u32): f64 {
  const bits: u64 = <u64>unchecked(buf[offset])
                  | (<u64>unchecked(buf[offset + 1]) << 8)
                  | (<u64>unchecked(buf[offset + 2]) << 16)
                  | (<u64>unchecked(buf[offset + 3]) << 24)
                  | (<u64>unchecked(buf[offset + 4]) << 32)
                  | (<u64>unchecked(buf[offset + 5]) << 40)
                  | (<u64>unchecked(buf[offset + 6]) << 48)
                  | (<u64>unchecked(buf[offset + 7]) << 56);
  return reinterpret<f64>(bits);
}

// ---------- dehydrate (topology + geometry → CBREP bytes) ----------

/**
 * Serialize the current topology + geometry pool to the CBREP output buffer.
 * Returns the byte length of the CBREP, or 0 on overflow.
 */
export function cbrepDehydrate(): u32 {
  const nVerts = vertexGetCount();
  const nEdges = edgeGetCount();
  const nCoedges = coedgeGetCount();
  const nLoops = loopGetCount();
  const nFaces = faceGetCount();
  const nShells = shellGetCount();
  const nGeom = geomPoolUsed();

  const totalBytes: u32 = HEADER_SIZE
    + nVerts * 24
    + nEdges * 16
    + nCoedges * 16
    + nLoops * 12
    + nFaces * 24
    + nShells * 12
    + nGeom * 8;

  if (totalBytes > MAX_CBREP_SIZE) {
    cbrepOutLen = 0;
    return 0;
  }

  let p: u32 = 0;

  // Header
  writeU32(cbrepOut, p, CBREP_MAGIC); p += 4;
  writeU32(cbrepOut, p, CBREP_VERSION); p += 4;
  writeU32(cbrepOut, p, nVerts); p += 4;
  writeU32(cbrepOut, p, nEdges); p += 4;
  writeU32(cbrepOut, p, nCoedges); p += 4;
  writeU32(cbrepOut, p, nLoops); p += 4;
  writeU32(cbrepOut, p, nFaces); p += 4;
  writeU32(cbrepOut, p, nShells); p += 4;
  writeU32(cbrepOut, p, nGeom); p += 4;

  // Vertices: 3 × f64 each
  for (let i: u32 = 0; i < nVerts; i++) {
    writeF64(cbrepOut, p, vertexGetX(i)); p += 8;
    writeF64(cbrepOut, p, vertexGetY(i)); p += 8;
    writeF64(cbrepOut, p, vertexGetZ(i)); p += 8;
  }

  // Edges: startV(u32) + endV(u32) + geomType(u8) + pad(3) + geomOffset(u32)
  for (let i: u32 = 0; i < nEdges; i++) {
    writeU32(cbrepOut, p, edgeGetStartVertex(i)); p += 4;
    writeU32(cbrepOut, p, edgeGetEndVertex(i)); p += 4;
    writeU8(cbrepOut, p, edgeGetGeomType(i)); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU32(cbrepOut, p, edgeGetGeomOffset(i)); p += 4;
  }

  // CoEdges: edgeId(u32) + orient(u8) + pad(3) + nextCoedge(u32) + loopId(u32)
  for (let i: u32 = 0; i < nCoedges; i++) {
    writeU32(cbrepOut, p, coedgeGetEdge(i)); p += 4;
    writeU8(cbrepOut, p, coedgeGetOrient(i)); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU32(cbrepOut, p, coedgeGetNext(i)); p += 4;
    writeU32(cbrepOut, p, coedgeGetLoop(i)); p += 4;
  }

  // Loops: firstCoedge(u32) + faceId(u32) + isOuter(u8) + pad(3)
  for (let i: u32 = 0; i < nLoops; i++) {
    writeU32(cbrepOut, p, loopGetFirstCoedge(i)); p += 4;
    writeU32(cbrepOut, p, loopGetFace(i)); p += 4;
    writeU8(cbrepOut, p, loopIsOuterLoop(i)); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU8(cbrepOut, p, 0); p++;
  }

  // Faces: firstLoop(u32) + shellId(u32) + geomType(u8) + pad(3) + geomOffset(u32) + orient(u8) + pad(3) + loopCount(u32)
  for (let i: u32 = 0; i < nFaces; i++) {
    writeU32(cbrepOut, p, faceGetFirstLoop(i)); p += 4;
    writeU32(cbrepOut, p, faceGetShell(i)); p += 4;
    writeU8(cbrepOut, p, faceGetGeomType(i)); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU32(cbrepOut, p, faceGetGeomOffset(i)); p += 4;
    writeU8(cbrepOut, p, faceGetOrient(i)); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU32(cbrepOut, p, faceGetLoopCount(i)); p += 4;
  }

  // Shells: firstFace(u32) + faceCount(u32) + isClosed(u8) + pad(3)
  for (let i: u32 = 0; i < nShells; i++) {
    writeU32(cbrepOut, p, shellGetFirstFace(i)); p += 4;
    writeU32(cbrepOut, p, shellGetFaceCount(i)); p += 4;
    writeU8(cbrepOut, p, shellIsClosed_(i)); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU8(cbrepOut, p, 0); p++;
    writeU8(cbrepOut, p, 0); p++;
  }

  // Geometry pool: f64 values
  for (let i: u32 = 0; i < nGeom; i++) {
    writeF64(cbrepOut, p, geomPoolRead(i)); p += 8;
  }

  cbrepOutLen = p;
  return p;
}

// ---------- hydrate (CBREP bytes → topology + geometry) ----------

/**
 * Restore topology + geometry from a CBREP buffer.
 * The input buffer must be provided via cbrepInputBuf.
 * Returns 1 on success, 0 on failure (bad magic, version, or overflow).
 */
export function cbrepHydrate(input: StaticArray<u8>, inputLen: u32): u32 {
  if (inputLen < HEADER_SIZE) return 0;

  let p: u32 = 0;
  const magic = readU32(input, p); p += 4;
  if (magic != CBREP_MAGIC) return 0;

  const version = readU32(input, p); p += 4;
  if (version != CBREP_VERSION) return 0;

  const nVerts = readU32(input, p); p += 4;
  const nEdges = readU32(input, p); p += 4;
  const nCoedges = readU32(input, p); p += 4;
  const nLoops = readU32(input, p); p += 4;
  const nFaces = readU32(input, p); p += 4;
  const nShells = readU32(input, p); p += 4;
  const nGeom = readU32(input, p); p += 4;

  const expectedLen = HEADER_SIZE
    + nVerts * 24
    + nEdges * 16
    + nCoedges * 16
    + nLoops * 12
    + nFaces * 24
    + nShells * 12
    + nGeom * 8;

  if (inputLen < expectedLen) return 0;

  // Reset topology and geometry
  bodyBegin();
  geomPoolReset();

  // Vertices
  for (let i: u32 = 0; i < nVerts; i++) {
    const x = readF64(input, p); p += 8;
    const y = readF64(input, p); p += 8;
    const z = readF64(input, p); p += 8;
    vertexAdd(x, y, z);
  }

  // Edges
  for (let i: u32 = 0; i < nEdges; i++) {
    const startV = readU32(input, p); p += 4;
    const endV = readU32(input, p); p += 4;
    const geomType = readU8(input, p); p += 4; // +3 pad
    const geomOffset = readU32(input, p); p += 4;
    edgeAdd(startV, endV, geomType, geomOffset);
  }

  // CoEdges
  for (let i: u32 = 0; i < nCoedges; i++) {
    const edgeId = readU32(input, p); p += 4;
    const orient = readU8(input, p); p += 4; // +3 pad
    const nextCoedge = readU32(input, p); p += 4;
    const loopId = readU32(input, p); p += 4;
    coedgeAdd(edgeId, orient, nextCoedge, loopId);
  }

  // Loops
  for (let i: u32 = 0; i < nLoops; i++) {
    const firstCoedge = readU32(input, p); p += 4;
    const face = readU32(input, p); p += 4;
    const isOuter = readU8(input, p); p += 4; // +3 pad
    loopAdd(firstCoedge, face, isOuter);
  }

  // Faces
  for (let i: u32 = 0; i < nFaces; i++) {
    const firstLoop = readU32(input, p); p += 4;
    const shell = readU32(input, p); p += 4;
    const geomType = readU8(input, p); p += 4; // +3 pad
    const geomOffset = readU32(input, p); p += 4;
    const orient = readU8(input, p); p += 4; // +3 pad
    const loopCnt = readU32(input, p); p += 4;
    faceAdd(firstLoop, shell, geomType, geomOffset, orient, loopCnt);
  }

  // Shells
  for (let i: u32 = 0; i < nShells; i++) {
    const firstFace = readU32(input, p); p += 4;
    const faceCnt = readU32(input, p); p += 4;
    const isClosed = readU8(input, p); p += 4; // +3 pad
    shellAdd(firstFace, faceCnt, isClosed);
  }

  // Geometry pool
  // We need to write directly — use the store helpers to fill pool sequentially
  // For simplicity, we read values and use a direct-write helper
  for (let i: u32 = 0; i < nGeom; i++) {
    const val = readF64(input, p); p += 8;
    geomPoolDirectWrite(i, val);
  }
  geomPoolSetUsed(nGeom);

  return 1;
}

/**
 * Hydrate a CBREP into the topology workspace in append-only mode,
 * bound to a specific handle. Entity indices in the CBREP are rebased
 * relative to the current topology counts so they don't collide with
 * previously loaded bodies.
 *
 * Returns 1 on success, 0 on failure.
 */
export function cbrepHydrateForHandle(handleId: u32, input: StaticArray<u8>, inputLen: u32): u32 {
  if (inputLen < HEADER_SIZE) return 0;

  let p: u32 = 0;
  const magic = readU32(input, p); p += 4;
  if (magic != CBREP_MAGIC) return 0;
  const version = readU32(input, p); p += 4;
  if (version != CBREP_VERSION) return 0;

  const nVerts = readU32(input, p); p += 4;
  const nEdges = readU32(input, p); p += 4;
  const nCoedges = readU32(input, p); p += 4;
  const nLoops = readU32(input, p); p += 4;
  const nFaces = readU32(input, p); p += 4;
  const nShells = readU32(input, p); p += 4;
  const nGeom = readU32(input, p); p += 4;

  const expectedLen = HEADER_SIZE
    + nVerts * 24 + nEdges * 16 + nCoedges * 16
    + nLoops * 12 + nFaces * 24 + nShells * 12 + nGeom * 8;
  if (inputLen < expectedLen) return 0;

  // Record start offsets and enter append mode for this handle
  bodyBeginForHandle(handleId);

  // Rebase offsets: new entity IDs = old ID + current count before adding
  const vertBase = vertexGetCount() - 0; // vertexGetCount is already the start offset
  // Actually — vertexAdd returns sequential IDs starting from vertexCount.
  // The CBREP references are 0-based within the body. We need to add the
  // base offset to all cross-references (edges→vertices, coedges→edges, etc).

  // Since vertexAdd/edgeAdd/etc are append-only and return the new ID,
  // and CBREP entity refs are 0-based within the body, we need to rebase
  // the references by adding the base offsets.

  const vBase = vertexGetCount();
  const eBase = edgeGetCount();
  const ceBase = coedgeGetCount();
  const lBase = loopGetCount();
  const fBase = faceGetCount();
  const sBase = shellGetCount();
  const gBase = geomPoolUsed();

  // Vertices (no cross-references)
  for (let i: u32 = 0; i < nVerts; i++) {
    const x = readF64(input, p); p += 8;
    const y = readF64(input, p); p += 8;
    const z = readF64(input, p); p += 8;
    vertexAdd(x, y, z);
  }

  // Edges: rebase vertex references
  for (let i: u32 = 0; i < nEdges; i++) {
    const startV = readU32(input, p) + vBase; p += 4;
    const endV = readU32(input, p) + vBase; p += 4;
    const geomType = readU8(input, p); p += 4;
    const geomOffset = readU32(input, p) + gBase; p += 4;
    edgeAdd(startV, endV, geomType, geomOffset);
  }

  // CoEdges: rebase edge and loop references
  for (let i: u32 = 0; i < nCoedges; i++) {
    const edgeId = readU32(input, p) + eBase; p += 4;
    const orient = readU8(input, p); p += 4;
    const nextCoedge = readU32(input, p) + ceBase; p += 4;
    const loopId = readU32(input, p) + lBase; p += 4;
    coedgeAdd(edgeId, orient, nextCoedge, loopId);
  }

  // Loops: rebase coedge and face references
  for (let i: u32 = 0; i < nLoops; i++) {
    const firstCoedge = readU32(input, p) + ceBase; p += 4;
    const face = readU32(input, p) + fBase; p += 4;
    const isOuter = readU8(input, p); p += 4;
    loopAdd(firstCoedge, face, isOuter);
  }

  // Faces: rebase loop, shell, and geom references
  for (let i: u32 = 0; i < nFaces; i++) {
    const firstLoop = readU32(input, p) + lBase; p += 4;
    const shell = readU32(input, p) + sBase; p += 4;
    const geomType = readU8(input, p); p += 4;
    const geomOffset = readU32(input, p) + gBase; p += 4;
    const orient = readU8(input, p); p += 4;
    const loopCnt = readU32(input, p); p += 4;
    faceAdd(firstLoop, shell, geomType, geomOffset, orient, loopCnt);
  }

  // Shells: rebase face references
  for (let i: u32 = 0; i < nShells; i++) {
    const firstFace = readU32(input, p) + fBase; p += 4;
    const faceCnt = readU32(input, p); p += 4;
    const isClosed = readU8(input, p); p += 4;
    shellAdd(firstFace, faceCnt, isClosed);
  }

  // Geometry pool: append values after existing pool data
  for (let i: u32 = 0; i < nGeom; i++) {
    const val = readF64(input, p); p += 8;
    geomPoolDirectWrite(gBase + i, val);
  }
  geomPoolSetUsed(gBase + nGeom);

  // Finalize handle body ranges
  bodyEndForHandle();

  return 1;
}

// ---------- geometry pool direct access (friend of geometry module) ----------
// These allow interop to write directly into the pool during hydration.

import { getGeomPoolPtr } from './geometry';

function geomPoolDirectWrite(index: u32, val: f64): void {
  // Write directly to the pool's memory via its pointer
  const ptr = getGeomPoolPtr();
  store<f64>(ptr + (<usize>index << 3), val);
}

function geomPoolSetUsed(count: u32): void {
  _geomPoolSetUsed(count);
}

// ---------- output access ----------

export function getCbrepOutPtr(): usize { return changetype<usize>(cbrepOut); }
export function getCbrepOutLen(): u32 { return cbrepOutLen; }

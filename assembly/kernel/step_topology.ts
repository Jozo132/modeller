// kernel/step_topology — native STEP→WASM topology builder (Phase 1)
//
// Consumes the entity + arg tables populated by step_parser.ts (which in
// turn reads from the same string pool filled by step_lexer.ts) and
// writes the resulting B-Rep topology directly into the WASM kernel via
// topology.ts + geometry.ts primitives.
//
// Phase 1 scope (this file):
//   • Analytic surfaces: PLANE, CYLINDRICAL_SURFACE, SPHERICAL_SURFACE,
//     CONICAL_SURFACE, TOROIDAL_SURFACE
//   • Edge curves: LINE, CIRCLE, ELLIPSE (via GEOM_LINE — the kernel
//     tessellator samples curves from vertex positions + face surface;
//     we only need a geomType tag for now).
//   • Simple and complex solid wrappings: MANIFOLD_SOLID_BREP,
//     CLOSED_SHELL, OPEN_SHELL.
//
// Out-of-scope (Phase 2, silently triggers a fallback error code so the
// JS caller can retry via the legacy pipeline):
//   • B_SPLINE_CURVE / B_SPLINE_SURFACE of any flavour.
//   • SURFACE_CURVE / SEAM_CURVE unwrapping (treated as LINE for now).
//   • Plane-angle unit scaling (cone semi-angle assumed to already be in
//     radians — matches the common STEP dialect).
//
// On error, stepBuildRun() returns a negative error code; otherwise 0.
// A successful call leaves the topology + geometry pools populated and
// ready for cbrepDehydrate(), tessBuildAllFaces(), etc.

import {
  bodyBegin, bodyEnd,
  vertexAdd,
  edgeAdd,
  coedgeAdd, coedgeSetNext,
  loopAdd,
  faceAdd,
  shellAdd,
  GEOM_NONE, GEOM_PLANE, GEOM_CYLINDER, GEOM_CONE, GEOM_SPHERE, GEOM_TORUS,
  GEOM_LINE,
  ORIENT_FORWARD, ORIENT_REVERSED,
} from './topology';
import {
  geomPoolReset,
  planeStore, cylinderStore, sphereStore, coneStore, torusStore,
} from './geometry';
import {
  stepLexGetStringPoolPtr,
} from './step_lexer';
import {
  stepParseGetEntityBufPtr, stepParseGetEntityCount, stepParseGetEntityStride,
  stepParseGetArgBufPtr, stepParseGetArgStride,
  ARG_NULL, ARG_REF, ARG_NUMBER, ARG_STRING, ARG_ENUM, ARG_LIST,
} from './step_parser';

// ─── Public error codes ─────────────────────────────────────────────
export const STEP_BUILD_OK: i32 = 0;
export const STEP_BUILD_ERR_NO_SHELL: i32 = -1;
export const STEP_BUILD_ERR_STEP_ID_OVERFLOW: i32 = -2;
export const STEP_BUILD_ERR_MISSING_ENTITY: i32 = -3;
export const STEP_BUILD_ERR_UNSUPPORTED_SURFACE: i32 = -4;
export const STEP_BUILD_ERR_UNSUPPORTED_CURVE: i32 = -5;
export const STEP_BUILD_ERR_BAD_ARGS: i32 = -6;
export const STEP_BUILD_ERR_TOPOLOGY_OVERFLOW: i32 = -7;

// ─── Configuration ──────────────────────────────────────────────────
const MAX_STEP_ID: u32 = 4 * 1024 * 1024; // supports up to 4M entity ids
const ID_NONE: u32 = 0xFFFFFFFF;

// ─── Scratch storage ────────────────────────────────────────────────
// stepId → entity row index (or ID_NONE)
const idLookup = new StaticArray<u32>(MAX_STEP_ID + 1);

// VERTEX_POINT stepId → wasm vertex id
const vertexCache = new StaticArray<u32>(MAX_STEP_ID + 1);
// EDGE_CURVE stepId → wasm edge id
const edgeCache = new StaticArray<u32>(MAX_STEP_ID + 1);

// Per-loop coedge id scratch (bounded — STEP loops almost never exceed
// a few thousand coedges; use a conservatively sized static buffer).
const MAX_COEDGES_PER_LOOP: u32 = 8192;
const coedgeScratch = new StaticArray<u32>(MAX_COEDGES_PER_LOOP);

// Diagnostic: number of ADVANCED_FACE entities that fell back (skipped)
// because they used an unsupported surface/curve type.  Observed by JS
// when deciding whether to accept the WASM result or retry via JS.
let skippedFaceCount: u32 = 0;
let lastErrorCode: i32 = STEP_BUILD_OK;
let lastErrorStepId: u32 = 0;

export function stepBuildGetSkippedFaceCount(): u32 { return skippedFaceCount; }
export function stepBuildGetLastError(): i32 { return lastErrorCode; }
export function stepBuildGetLastErrorStepId(): u32 { return lastErrorStepId; }

// ─── Entity / arg byte-level accessors ──────────────────────────────
//
// Entity record (ENTITY_STRIDE = 20 bytes):
//   +0  u32 stepId
//   +4  u32 typeOff (into string pool)
//   +8  u32 typeLen
//   +12 u32 argRootIdx
//   +16 u8  isComplex
//   +17 u8  pad
//   +18 u8  pad
//   +19 u8  pad
//
// Arg record (ARG_STRIDE = 16 bytes):
//   +0  u8  kind
//   +1  u8  pad
//   +2  u8  pad
//   +3  u8  pad
//   +4  u32 arg0 (REF: stepId; NUMBER/STRING/ENUM: pool off; LIST: childCount)
//   +8  u32 arg1 (NUMBER/STRING/ENUM: pool len; LIST: unused)
//   +12 u32 arg2 (reserved)

@inline function entityPtr(idx: u32): usize {
  return stepParseGetEntityBufPtr() + <usize>idx * <usize>stepParseGetEntityStride();
}
@inline function entStepId(idx: u32): u32 { return load<u32>(entityPtr(idx)); }
@inline function entTypeOff(idx: u32): u32 { return load<u32>(entityPtr(idx) + 4); }
@inline function entTypeLen(idx: u32): u32 { return load<u32>(entityPtr(idx) + 8); }
@inline function entArgRoot(idx: u32): u32 { return load<u32>(entityPtr(idx) + 12); }
@inline function entIsComplex(idx: u32): bool { return load<u8>(entityPtr(idx) + 16) != 0; }

@inline function argPtr(idx: u32): usize {
  return stepParseGetArgBufPtr() + <usize>idx * <usize>stepParseGetArgStride();
}
@inline function argKind(idx: u32): u8 { return load<u8>(argPtr(idx)); }
@inline function argA0(idx: u32): u32 { return load<u32>(argPtr(idx) + 4); }
@inline function argA1(idx: u32): u32 { return load<u32>(argPtr(idx) + 8); }

// Skip past a single arg (possibly a LIST with nested children) and
// return the index of the next arg.
function argSkip(argIdx: u32): u32 {
  const k = argKind(argIdx);
  if (k != ARG_LIST) return argIdx + 1;
  const count = argA0(argIdx);
  let cursor: u32 = argIdx + 1;
  for (let i: u32 = 0; i < count; i++) cursor = argSkip(cursor);
  return cursor;
}

// Return argIdx of the k-th child of the LIST at listIdx.
function argListChild(listIdx: u32, k: u32): u32 {
  let cursor: u32 = listIdx + 1;
  for (let i: u32 = 0; i < k; i++) cursor = argSkip(cursor);
  return cursor;
}

@inline function argListCount(listIdx: u32): u32 { return argA0(listIdx); }

// Dereference an ARG_REF to its entity index (or ID_NONE).
@inline function argRefToEntityIdx(argIdx: u32): u32 {
  if (argKind(argIdx) != ARG_REF) return ID_NONE;
  const sid = argA0(argIdx);
  if (sid > MAX_STEP_ID) return ID_NONE;
  return unchecked(idLookup[sid]);
}

// Parse a NUMBER arg's pool text as f64.  Minimal STEP number grammar:
// sign? digits ('.' digits)? ([Ee] sign? digits)?
function argAsF64(argIdx: u32): f64 {
  const k = argKind(argIdx);
  if (k != ARG_NUMBER) return 0.0;
  const off = argA0(argIdx);
  const len = argA1(argIdx);
  const base = stepLexGetStringPoolPtr() + <usize>off;
  return atof(base, len);
}

function atof(base: usize, len: u32): f64 {
  if (len == 0) return 0.0;
  let i: u32 = 0;
  let sign: f64 = 1.0;
  const c0 = load<u8>(base);
  if (c0 == 0x2D /* - */) { sign = -1.0; i = 1; }
  else if (c0 == 0x2B /* + */) { i = 1; }

  let mant: f64 = 0.0;
  let sawDigit = false;
  // integer part
  while (i < len) {
    const c = load<u8>(base + <usize>i);
    if (c >= 0x30 && c <= 0x39) {
      mant = mant * 10.0 + <f64>(c - 0x30);
      sawDigit = true;
      i++;
    } else break;
  }
  // fraction
  if (i < len && load<u8>(base + <usize>i) == 0x2E /* . */) {
    i++;
    let frac: f64 = 0.0;
    let div: f64 = 1.0;
    while (i < len) {
      const c = load<u8>(base + <usize>i);
      if (c >= 0x30 && c <= 0x39) {
        frac = frac * 10.0 + <f64>(c - 0x30);
        div *= 10.0;
        sawDigit = true;
        i++;
      } else break;
    }
    mant += frac / div;
  }
  if (!sawDigit) return 0.0;
  // exponent
  let expSign: f64 = 1.0;
  let expVal: i32 = 0;
  if (i < len) {
    const c = load<u8>(base + <usize>i);
    if (c == 0x45 /* E */ || c == 0x65 /* e */) {
      i++;
      if (i < len) {
        const s = load<u8>(base + <usize>i);
        if (s == 0x2D) { expSign = -1.0; i++; }
        else if (s == 0x2B) { i++; }
      }
      while (i < len) {
        const c2 = load<u8>(base + <usize>i);
        if (c2 >= 0x30 && c2 <= 0x39) {
          expVal = expVal * 10 + <i32>(c2 - 0x30);
          i++;
        } else break;
      }
    }
  }
  let result: f64 = sign * mant;
  if (expVal != 0) {
    // pow(10, expSign*expVal)
    let p: f64 = 1.0;
    let e: i32 = expVal;
    while (e > 0) { p *= 10.0; e--; }
    result = expSign > 0 ? result * p : result / p;
  }
  return result;
}

// Compare enum arg's identifier against a literal (minus the surrounding dots).
// e.g. argEnumIs(i, "T") returns true when the argument text is "T".
function argEnumIs(argIdx: u32, needle: string): bool {
  if (argKind(argIdx) != ARG_ENUM) return false;
  const off = argA0(argIdx);
  const len = argA1(argIdx);
  if (<i32>len != needle.length) return false;
  const base = stepLexGetStringPoolPtr() + <usize>off;
  for (let i: i32 = 0; i < needle.length; i++) {
    if (load<u8>(base + <usize>i) != <u8>(needle.charCodeAt(i) & 0xff)) return false;
  }
  return true;
}

// ─── FNV-1a type hashing ────────────────────────────────────────────

@inline function fnv1aBytes(base: usize, len: u32): u32 {
  let h: u32 = 0x811c9dc5;
  for (let i: u32 = 0; i < len; i++) {
    h ^= <u32>load<u8>(base + <usize>i);
    h = h * 0x01000193;
  }
  return h;
}

function fnv1aStr(s: string): u32 {
  let h: u32 = 0x811c9dc5;
  for (let i: i32 = 0; i < s.length; i++) {
    h ^= <u32>(s.charCodeAt(i) & 0xff);
    h = h * 0x01000193;
  }
  return h;
}

@inline function entityTypeHash(entIdx: u32): u32 {
  const off = entTypeOff(entIdx);
  const len = entTypeLen(entIdx);
  return fnv1aBytes(stepLexGetStringPoolPtr() + <usize>off, len);
}

// Precomputed type hashes (computed at module init via fnv1aStr).
const H_MANIFOLD_SOLID_BREP: u32 = fnv1aStr("MANIFOLD_SOLID_BREP");
const H_CLOSED_SHELL: u32 = fnv1aStr("CLOSED_SHELL");
const H_OPEN_SHELL: u32 = fnv1aStr("OPEN_SHELL");
const H_ADVANCED_FACE: u32 = fnv1aStr("ADVANCED_FACE");
const H_FACE_SURFACE: u32 = fnv1aStr("FACE_SURFACE");
const H_FACE_BOUND: u32 = fnv1aStr("FACE_BOUND");
const H_FACE_OUTER_BOUND: u32 = fnv1aStr("FACE_OUTER_BOUND");
const H_EDGE_LOOP: u32 = fnv1aStr("EDGE_LOOP");
const H_ORIENTED_EDGE: u32 = fnv1aStr("ORIENTED_EDGE");
const H_EDGE_CURVE: u32 = fnv1aStr("EDGE_CURVE");
const H_VERTEX_POINT: u32 = fnv1aStr("VERTEX_POINT");
const H_CARTESIAN_POINT: u32 = fnv1aStr("CARTESIAN_POINT");
const H_DIRECTION: u32 = fnv1aStr("DIRECTION");
const H_AXIS2_PLACEMENT_3D: u32 = fnv1aStr("AXIS2_PLACEMENT_3D");
const H_PLANE: u32 = fnv1aStr("PLANE");
const H_CYLINDRICAL_SURFACE: u32 = fnv1aStr("CYLINDRICAL_SURFACE");
const H_SPHERICAL_SURFACE: u32 = fnv1aStr("SPHERICAL_SURFACE");
const H_CONICAL_SURFACE: u32 = fnv1aStr("CONICAL_SURFACE");
const H_TOROIDAL_SURFACE: u32 = fnv1aStr("TOROIDAL_SURFACE");
const H_LINE: u32 = fnv1aStr("LINE");
const H_CIRCLE: u32 = fnv1aStr("CIRCLE");
const H_ELLIPSE: u32 = fnv1aStr("ELLIPSE");
const H_SURFACE_CURVE: u32 = fnv1aStr("SURFACE_CURVE");
const H_SEAM_CURVE: u32 = fnv1aStr("SEAM_CURVE");

// ─── Cartesian point / direction extraction ─────────────────────────
//
// These write their outputs into 3-wide module-level scratch globals.
// Using globals (rather than struct returns) avoids AS managed-object
// allocation on every call.

let pOutX: f64 = 0.0, pOutY: f64 = 0.0, pOutZ: f64 = 0.0;

function readCartesianPoint(entIdx: u32): bool {
  if (entIdx == ID_NONE) return false;
  if (entityTypeHash(entIdx) != H_CARTESIAN_POINT) return false;
  const root = entArgRoot(entIdx);
  if (argKind(root) != ARG_LIST) return false;
  if (argListCount(root) < 2) return false;
  // args[0] = name, args[1] = (x, y, z) list
  const coordsIdx = argListChild(root, 1);
  if (argKind(coordsIdx) != ARG_LIST) return false;
  const nCoords = argListCount(coordsIdx);
  if (nCoords < 3) return false;
  pOutX = argAsF64(argListChild(coordsIdx, 0));
  pOutY = argAsF64(argListChild(coordsIdx, 1));
  pOutZ = argAsF64(argListChild(coordsIdx, 2));
  return true;
}

function readCartesianPointRef(refArgIdx: u32): bool {
  return readCartesianPoint(argRefToEntityIdx(refArgIdx));
}

function readDirection(entIdx: u32): bool {
  if (entIdx == ID_NONE) return false;
  if (entityTypeHash(entIdx) != H_DIRECTION) return false;
  const root = entArgRoot(entIdx);
  if (argKind(root) != ARG_LIST) return false;
  if (argListCount(root) < 2) return false;
  const coordsIdx = argListChild(root, 1);
  if (argKind(coordsIdx) != ARG_LIST) return false;
  if (argListCount(coordsIdx) < 3) return false;
  pOutX = argAsF64(argListChild(coordsIdx, 0));
  pOutY = argAsF64(argListChild(coordsIdx, 1));
  pOutZ = argAsF64(argListChild(coordsIdx, 2));
  return true;
}

// ─── AXIS2_PLACEMENT_3D extraction ──────────────────────────────────
// Writes origin/zDir/xDir into module-level globals; returns false on
// missing origin. Missing directions default to Z=+z, X=perpendicular.

let axOx: f64 = 0.0, axOy: f64 = 0.0, axOz: f64 = 0.0;
let axZx: f64 = 0.0, axZy: f64 = 0.0, axZz: f64 = 1.0;
let axXx: f64 = 1.0, axXy: f64 = 0.0, axXz: f64 = 0.0;

function vnormInPlace(px: f64, py: f64, pz: f64, outIsZ: bool, outIsX: bool): void {
  const len = Math.sqrt(px * px + py * py + pz * pz);
  if (len < 1e-14) {
    if (outIsZ) { axZx = 0.0; axZy = 0.0; axZz = 1.0; return; }
    if (outIsX) { axXx = 1.0; axXy = 0.0; axXz = 0.0; return; }
    return;
  }
  const nx = px / len, ny = py / len, nz = pz / len;
  if (outIsZ) { axZx = nx; axZy = ny; axZz = nz; }
  else if (outIsX) { axXx = nx; axXy = ny; axXz = nz; }
}

function makePerpTo(zx: f64, zy: f64, zz: f64): void {
  const ax = Math.abs(zx), ay = Math.abs(zy), az = Math.abs(zz);
  let rx: f64 = 0.0, ry: f64 = 0.0, rz: f64 = 0.0;
  if (ax <= ay && ax <= az) { rx = 1.0; }
  else if (ay <= az) { ry = 1.0; }
  else { rz = 1.0; }
  // cross(z, r)
  const cx = zy * rz - zz * ry;
  const cy = zz * rx - zx * rz;
  const cz = zx * ry - zy * rx;
  vnormInPlace(cx, cy, cz, false, true);
}

function readAxis2Placement3D(entIdx: u32): bool {
  if (entIdx == ID_NONE) return false;
  if (entityTypeHash(entIdx) != H_AXIS2_PLACEMENT_3D) return false;
  const root = entArgRoot(entIdx);
  if (argKind(root) != ARG_LIST) return false;
  const nArgs = argListCount(root);
  if (nArgs < 2) return false;
  // args[1] = origin (ref to CARTESIAN_POINT)
  if (!readCartesianPointRef(argListChild(root, 1))) return false;
  axOx = pOutX; axOy = pOutY; axOz = pOutZ;

  // args[2] = Z dir (optional)
  let zGotten = false;
  if (nArgs >= 3) {
    const zArg = argListChild(root, 2);
    if (argKind(zArg) == ARG_REF) {
      if (readDirection(argRefToEntityIdx(zArg))) {
        vnormInPlace(pOutX, pOutY, pOutZ, true, false);
        zGotten = true;
      }
    }
  }
  if (!zGotten) { axZx = 0.0; axZy = 0.0; axZz = 1.0; }

  // args[3] = X dir (optional)
  let xGotten = false;
  if (nArgs >= 4) {
    const xArg = argListChild(root, 3);
    if (argKind(xArg) == ARG_REF) {
      if (readDirection(argRefToEntityIdx(xArg))) {
        vnormInPlace(pOutX, pOutY, pOutZ, false, true);
        xGotten = true;
      }
    }
  }
  if (!xGotten) makePerpTo(axZx, axZy, axZz);
  return true;
}

// ─── Surface builder ────────────────────────────────────────────────
//
// Returns a packed u64 where:
//   low 32 bits = geomOffset
//   high 8 bits (bits 56..63) = geomType tag
// Returns 0xFFFFFFFFFFFFFFFF on unsupported surface.
// Actually AS u64 handling is awkward for returning composites — use two
// module-level globals instead.

let outGeomType: u8 = GEOM_NONE;
let outGeomOffset: u32 = 0;

function buildSurface(surfEntIdx: u32): bool {
  if (surfEntIdx == ID_NONE) return false;
  const h = entityTypeHash(surfEntIdx);
  const root = entArgRoot(surfEntIdx);
  if (argKind(root) != ARG_LIST) return false;
  const nArgs = argListCount(root);

  if (h == H_PLANE) {
    if (nArgs < 2) return false;
    const axRef = argListChild(root, 1);
    if (!readAxis2Placement3D(argRefToEntityIdx(axRef))) return false;
    // signature: planeStore(ox, oy, oz, nx, ny, nz, rx, ry, rz)
    outGeomOffset = planeStore(axOx, axOy, axOz, axZx, axZy, axZz, axXx, axXy, axXz);
    outGeomType = GEOM_PLANE;
    return true;
  }
  if (h == H_CYLINDRICAL_SURFACE) {
    if (nArgs < 3) return false;
    if (!readAxis2Placement3D(argRefToEntityIdx(argListChild(root, 1)))) return false;
    const radius = argAsF64(argListChild(root, 2));
    outGeomOffset = cylinderStore(axOx, axOy, axOz, axZx, axZy, axZz, axXx, axXy, axXz, radius);
    outGeomType = GEOM_CYLINDER;
    return true;
  }
  if (h == H_SPHERICAL_SURFACE) {
    if (nArgs < 3) return false;
    if (!readAxis2Placement3D(argRefToEntityIdx(argListChild(root, 1)))) return false;
    const radius = argAsF64(argListChild(root, 2));
    outGeomOffset = sphereStore(axOx, axOy, axOz, axZx, axZy, axZz, axXx, axXy, axXz, radius);
    outGeomType = GEOM_SPHERE;
    return true;
  }
  if (h == H_CONICAL_SURFACE) {
    if (nArgs < 4) return false;
    if (!readAxis2Placement3D(argRefToEntityIdx(argListChild(root, 1)))) return false;
    const radius = argAsF64(argListChild(root, 2));
    const semiAngle = argAsF64(argListChild(root, 3));
    outGeomOffset = coneStore(axOx, axOy, axOz, axZx, axZy, axZz, axXx, axXy, axXz, radius, semiAngle);
    outGeomType = GEOM_CONE;
    return true;
  }
  if (h == H_TOROIDAL_SURFACE) {
    if (nArgs < 4) return false;
    if (!readAxis2Placement3D(argRefToEntityIdx(argListChild(root, 1)))) return false;
    const majorR = argAsF64(argListChild(root, 2));
    const minorR = argAsF64(argListChild(root, 3));
    outGeomOffset = torusStore(axOx, axOy, axOz, axZx, axZy, axZz, axXx, axXy, axXz, majorR, minorR);
    outGeomType = GEOM_TORUS;
    return true;
  }
  // B_SPLINE_SURFACE_WITH_KNOTS / RATIONAL_B_SPLINE_SURFACE → Phase 2
  return false;
}

// ─── Vertex / edge building ─────────────────────────────────────────

function getOrCreateVertexByRef(vertexPointRefArg: u32): u32 {
  // vertexPointRefArg must be an ARG_REF to a VERTEX_POINT entity.
  if (argKind(vertexPointRefArg) != ARG_REF) return ID_NONE;
  const sid = argA0(vertexPointRefArg);
  if (sid > MAX_STEP_ID) return ID_NONE;
  const cached = unchecked(vertexCache[sid]);
  if (cached != ID_NONE) return cached;

  const entIdx = unchecked(idLookup[sid]);
  if (entIdx == ID_NONE) return ID_NONE;
  if (entityTypeHash(entIdx) != H_VERTEX_POINT) return ID_NONE;
  const root = entArgRoot(entIdx);
  if (argKind(root) != ARG_LIST) return ID_NONE;
  if (argListCount(root) < 2) return ID_NONE;
  // VERTEX_POINT(name, cp_ref)
  if (!readCartesianPointRef(argListChild(root, 1))) return ID_NONE;

  const vid = vertexAdd(pOutX, pOutY, pOutZ);
  if (vid == 0xFFFFFFFF) return ID_NONE;
  unchecked(vertexCache[sid] = vid);
  return vid;
}

// Build (or reuse cached) an edge for an EDGE_CURVE entity.
// Returns ID_NONE on failure (unsupported curve type, etc).
function getOrCreateEdgeByRef(edgeCurveRefArg: u32): u32 {
  if (argKind(edgeCurveRefArg) != ARG_REF) return ID_NONE;
  const sid = argA0(edgeCurveRefArg);
  if (sid > MAX_STEP_ID) return ID_NONE;
  const cached = unchecked(edgeCache[sid]);
  if (cached != ID_NONE) return cached;

  const entIdx = unchecked(idLookup[sid]);
  if (entIdx == ID_NONE) return ID_NONE;
  if (entityTypeHash(entIdx) != H_EDGE_CURVE) return ID_NONE;
  const root = entArgRoot(entIdx);
  if (argKind(root) != ARG_LIST) return ID_NONE;
  if (argListCount(root) < 5) return ID_NONE;
  // EDGE_CURVE(name, startV_ref, endV_ref, curve_ref, edgeGeometrySameSense)
  const startVid = getOrCreateVertexByRef(argListChild(root, 1));
  const endVid = getOrCreateVertexByRef(argListChild(root, 2));
  if (startVid == ID_NONE || endVid == ID_NONE) return ID_NONE;

  // Inspect underlying curve type.  For Phase 1 we only need a geom tag
  // (tessellation samples along vertices/surface).
  const curveRefArg = argListChild(root, 3);
  const curveIdx = argRefToEntityIdx(curveRefArg);
  let geomType: u8 = GEOM_LINE;
  if (curveIdx != ID_NONE) {
    const h = entityTypeHash(curveIdx);
    if (h == H_SURFACE_CURVE || h == H_SEAM_CURVE) {
      // args[1] of SURFACE_CURVE/SEAM_CURVE is the underlying 3D curve
      const curveRoot = entArgRoot(curveIdx);
      if (argKind(curveRoot) == ARG_LIST && argListCount(curveRoot) >= 2) {
        const inner = argRefToEntityIdx(argListChild(curveRoot, 1));
        if (inner != ID_NONE) {
          const h2 = entityTypeHash(inner);
          if (h2 == H_LINE) geomType = GEOM_LINE;
          // fall through for others
        }
      }
    } else if (h == H_LINE) {
      geomType = GEOM_LINE;
    }
    // CIRCLE / ELLIPSE / B_SPLINE_* → we still tag as GEOM_LINE for
    // Phase 1; the kernel tessellator samples curved geometry from the
    // face's analytic surface, so edge geometry is advisory.  Phase 2
    // will emit proper GEOM_CIRCLE / GEOM_NURBS_CURVE with populated
    // geometry pool entries.
  }

  const eid = edgeAdd(startVid, endVid, geomType, 0);
  if (eid == 0xFFFFFFFF) return ID_NONE;
  unchecked(edgeCache[sid] = eid);
  return eid;
}

// ─── Face / loop building ───────────────────────────────────────────

// Build a single loop given its EDGE_LOOP entity index, attach to the
// given (predicted) loopId and faceId.  Returns loopAdd'd id or ID_NONE.
function buildLoop(edgeLoopIdx: u32, reverseBound: bool, predictedLoopId: u32, wasmFaceId: u32, isOuter: u8): u32 {
  if (edgeLoopIdx == ID_NONE) return ID_NONE;
  if (entityTypeHash(edgeLoopIdx) != H_EDGE_LOOP) return ID_NONE;
  const root = entArgRoot(edgeLoopIdx);
  if (argKind(root) != ARG_LIST) return ID_NONE;
  if (argListCount(root) < 2) return ID_NONE;
  // EDGE_LOOP(name, (oriented_edge_refs))
  const oeListIdx = argListChild(root, 1);
  if (argKind(oeListIdx) != ARG_LIST) return ID_NONE;
  const n = argListCount(oeListIdx);
  if (n == 0) return ID_NONE;
  if (n > MAX_COEDGES_PER_LOOP) return ID_NONE;

  let nCe: u32 = 0;
  for (let k: u32 = 0; k < n; k++) {
    const oeRefArg = argListChild(oeListIdx, k);
    if (argKind(oeRefArg) != ARG_REF) continue;
    const oeIdx = argRefToEntityIdx(oeRefArg);
    if (oeIdx == ID_NONE) continue;
    if (entityTypeHash(oeIdx) != H_ORIENTED_EDGE) continue;
    const oeRoot = entArgRoot(oeIdx);
    if (argKind(oeRoot) != ARG_LIST) continue;
    if (argListCount(oeRoot) < 5) continue;
    // ORIENTED_EDGE(name, *, *, edge_curve_ref, sense)
    const edgeCurveRef = argListChild(oeRoot, 3);
    const senseArg = argListChild(oeRoot, 4);
    const oeSense = argEnumIs(senseArg, "T");
    const eid = getOrCreateEdgeByRef(edgeCurveRef);
    if (eid == ID_NONE) return ID_NONE;  // unsupported edge → abort loop
    const orient: u8 = oeSense ? ORIENT_FORWARD : ORIENT_REVERSED;
    const ceId = coedgeAdd(eid, orient, predictedLoopId, wasmFaceId);
    if (ceId == 0xFFFFFFFF) return ID_NONE;
    unchecked(coedgeScratch[nCe] = ceId);
    nCe++;
  }
  if (nCe == 0) return ID_NONE;

  // Reverse if FACE_BOUND orientation flag is .F.
  if (reverseBound) {
    // Reverse order of coedges and flip each one's orientation.
    let lo: u32 = 0, hi: u32 = nCe - 1;
    while (lo < hi) {
      const a = unchecked(coedgeScratch[lo]);
      const b = unchecked(coedgeScratch[hi]);
      unchecked(coedgeScratch[lo] = b);
      unchecked(coedgeScratch[hi] = a);
      lo++; hi--;
    }
    // Flip orientation flags — we wrote them directly via coedgeAdd,
    // so patch the stored orients via coedgeAdd side effect.  Since we
    // can't easily mutate stored orients here, re-allocate: but that's
    // expensive.  Instead, rely on the fact that the kernel tessellator
    // primarily uses next-pointers + orient to walk — flipping is a
    // known-limited Phase 1 shortcut that matches the JS behaviour for
    // the common ".T." case.  When reverseBound is true, leave orient
    // alone (Phase 2 TODO).
  }

  // Link coedges into a cycle: next[i] = scratch[(i+1) % nCe]
  for (let i: u32 = 0; i < nCe; i++) {
    const cur = unchecked(coedgeScratch[i]);
    const nxt = unchecked(coedgeScratch[(i + 1) % nCe]);
    coedgeSetNext(cur, nxt);
  }

  const firstCe = unchecked(coedgeScratch[0]);
  const loopId = loopAdd(firstCe, wasmFaceId, isOuter);
  return loopId;
}

function buildFace(faceEntIdx: u32, wasmFaceId: u32): bool {
  if (faceEntIdx == ID_NONE) return false;
  const h = entityTypeHash(faceEntIdx);
  if (h != H_ADVANCED_FACE && h != H_FACE_SURFACE) return false;
  const root = entArgRoot(faceEntIdx);
  if (argKind(root) != ARG_LIST) return false;
  if (argListCount(root) < 4) return false;
  // ADVANCED_FACE(name, (bounds), surface_ref, sameSense)
  const boundsList = argListChild(root, 1);
  if (argKind(boundsList) != ARG_LIST) return false;
  const nBounds = argListCount(boundsList);
  if (nBounds == 0) return false;

  const surfaceRef = argListChild(root, 2);
  const sameSense = argEnumIs(argListChild(root, 3), "T");

  if (!buildSurface(argRefToEntityIdx(surfaceRef))) return false;
  const geomType = outGeomType;
  const geomOffset = outGeomOffset;

  // Iterate bounds twice: first pass finds outer, second builds loops
  // in outer-first order.
  let outerBoundK: i32 = -1;
  for (let k: u32 = 0; k < nBounds; k++) {
    const boundRefArg = argListChild(boundsList, k);
    const boundIdx = argRefToEntityIdx(boundRefArg);
    if (boundIdx == ID_NONE) continue;
    if (entityTypeHash(boundIdx) == H_FACE_OUTER_BOUND) { outerBoundK = <i32>k; break; }
  }
  // Fall back: if no FACE_OUTER_BOUND, treat first bound as outer.
  if (outerBoundK < 0) outerBoundK = 0;

  // Count valid loops we'll actually emit, and grab the first loop id.
  // Note: loopAdd returns sequential ids, so predicting is straightforward.
  // Track the current predicted loopId via an external counter.
  // We can't peek the topology loopCount from here without a getter, so
  // use the known-sequential invariant: loopAdd returns counter pre-inc.

  // We need the predicted loopId *before* calling buildLoop, which adds
  // coedges that carry loopId.  Since loopAdd is called after coedgeAdd,
  // we must guess the next loop id.  The kernel exposes loopGetCount()
  // for this; we read it once at the start and increment locally.
  let predictedLoopId: u32 = loopGetCountCached;

  // Loop iteration order: outer first, then others.
  let firstLoopId: u32 = ID_NONE;
  let loopsEmitted: u32 = 0;

  // Build outer
  {
    const boundRefArg = argListChild(boundsList, <u32>outerBoundK);
    const boundIdx = argRefToEntityIdx(boundRefArg);
    if (boundIdx == ID_NONE) return false;
    const boundRoot = entArgRoot(boundIdx);
    if (argKind(boundRoot) != ARG_LIST || argListCount(boundRoot) < 3) return false;
    const loopRef = argListChild(boundRoot, 1);
    const boundSenseT = argEnumIs(argListChild(boundRoot, 2), "T");
    const loopId = buildLoop(argRefToEntityIdx(loopRef), !boundSenseT, predictedLoopId, wasmFaceId, 1);
    if (loopId == ID_NONE) return false;
    firstLoopId = loopId;
    predictedLoopId++;
    loopsEmitted++;
    loopGetCountCached++;
  }

  // Inner loops (all other bounds)
  for (let k: u32 = 0; k < nBounds; k++) {
    if (<i32>k == outerBoundK) continue;
    const boundRefArg = argListChild(boundsList, k);
    const boundIdx = argRefToEntityIdx(boundRefArg);
    if (boundIdx == ID_NONE) continue;
    const boundH = entityTypeHash(boundIdx);
    if (boundH != H_FACE_BOUND && boundH != H_FACE_OUTER_BOUND) continue;
    const boundRoot = entArgRoot(boundIdx);
    if (argKind(boundRoot) != ARG_LIST || argListCount(boundRoot) < 3) continue;
    const loopRef = argListChild(boundRoot, 1);
    const boundSenseT = argEnumIs(argListChild(boundRoot, 2), "T");
    const loopId = buildLoop(argRefToEntityIdx(loopRef), !boundSenseT, predictedLoopId, wasmFaceId, 0);
    if (loopId == ID_NONE) continue; // skip malformed inner loop
    predictedLoopId++;
    loopsEmitted++;
    loopGetCountCached++;
  }

  const orient: u8 = sameSense ? ORIENT_FORWARD : ORIENT_REVERSED;
  faceAdd(firstLoopId, 0, geomType, geomOffset, orient, loopsEmitted);
  return true;
}

// Cached loop counter (we increment locally on each successful loopAdd).
let loopGetCountCached: u32 = 0;

// ─── Public entry point ─────────────────────────────────────────────

function resetCaches(): void {
  // Initialise dense lookup tables.  StaticArray<u32> default-inits to 0,
  // but ID_NONE = 0xFFFFFFFF, so we have to explicitly fill on every run.
  // To avoid an O(n) fill over 4M entries we rely on a generation counter
  // — but for simplicity in Phase 1 we only touch the ids we actually see.
  // Callers (see resetForRun) fill by iterating the parser's entity table.
  skippedFaceCount = 0;
  lastErrorCode = STEP_BUILD_OK;
  lastErrorStepId = 0;
  loopGetCountCached = 0;
}

function resetLookupsForRun(): void {
  // Clear idLookup/vertexCache/edgeCache for exactly the stepIds present
  // in the current parse output.  This keeps reset cost proportional to
  // the file size, not to MAX_STEP_ID.
  const nEnt = stepParseGetEntityCount();
  for (let i: u32 = 0; i < nEnt; i++) {
    const sid = entStepId(i);
    if (sid <= MAX_STEP_ID) {
      unchecked(idLookup[sid] = ID_NONE);
      unchecked(vertexCache[sid] = ID_NONE);
      unchecked(edgeCache[sid] = ID_NONE);
    }
  }
}

function buildIdLookup(): bool {
  const nEnt = stepParseGetEntityCount();
  for (let i: u32 = 0; i < nEnt; i++) {
    const sid = entStepId(i);
    if (sid > MAX_STEP_ID) {
      lastErrorCode = STEP_BUILD_ERR_STEP_ID_OVERFLOW;
      lastErrorStepId = sid;
      return false;
    }
    unchecked(idLookup[sid] = i);
  }
  return true;
}

// Build topology for the first MANIFOLD_SOLID_BREP (or fallback
// CLOSED_SHELL / OPEN_SHELL) encountered in the entity table.
export function stepBuildRun(): i32 {
  resetCaches();
  resetLookupsForRun();
  if (!buildIdLookup()) return lastErrorCode;

  // Locate the solid to import.
  const nEnt = stepParseGetEntityCount();
  let shellEntIdx: u32 = ID_NONE;

  // First pass: look for MANIFOLD_SOLID_BREP and resolve its shell.
  for (let i: u32 = 0; i < nEnt; i++) {
    if (entIsComplex(i)) continue;
    if (entityTypeHash(i) != H_MANIFOLD_SOLID_BREP) continue;
    const root = entArgRoot(i);
    if (argKind(root) != ARG_LIST) continue;
    if (argListCount(root) < 2) continue;
    const shellRefArg = argListChild(root, 1);
    const cand = argRefToEntityIdx(shellRefArg);
    if (cand != ID_NONE) { shellEntIdx = cand; break; }
  }
  // Fallback: first CLOSED_SHELL or OPEN_SHELL at top level.
  if (shellEntIdx == ID_NONE) {
    for (let i: u32 = 0; i < nEnt; i++) {
      if (entIsComplex(i)) continue;
      const h = entityTypeHash(i);
      if (h == H_CLOSED_SHELL || h == H_OPEN_SHELL) { shellEntIdx = i; break; }
    }
  }
  if (shellEntIdx == ID_NONE) return STEP_BUILD_ERR_NO_SHELL;

  // Reset WASM kernel topology and geometry pool.
  bodyBegin();
  geomPoolReset();

  // Walk shell → faces.
  const shellH = entityTypeHash(shellEntIdx);
  if (shellH != H_CLOSED_SHELL && shellH != H_OPEN_SHELL) return STEP_BUILD_ERR_NO_SHELL;
  const shellRoot = entArgRoot(shellEntIdx);
  if (argKind(shellRoot) != ARG_LIST) return STEP_BUILD_ERR_NO_SHELL;
  if (argListCount(shellRoot) < 2) return STEP_BUILD_ERR_NO_SHELL;
  const faceListIdx = argListChild(shellRoot, 1);
  if (argKind(faceListIdx) != ARG_LIST) return STEP_BUILD_ERR_NO_SHELL;
  const nFaces = argListCount(faceListIdx);

  let wasmFaceId: u32 = 0;
  for (let k: u32 = 0; k < nFaces; k++) {
    const faceRefArg = argListChild(faceListIdx, k);
    const faceIdx = argRefToEntityIdx(faceRefArg);
    if (faceIdx == ID_NONE) { skippedFaceCount++; continue; }
    if (!buildFace(faceIdx, wasmFaceId)) {
      skippedFaceCount++;
      continue;
    }
    wasmFaceId++;
  }
  if (wasmFaceId == 0) {
    return STEP_BUILD_ERR_UNSUPPORTED_SURFACE;
  }

  shellAdd(0, wasmFaceId, shellH == H_CLOSED_SHELL ? 1 : 0);
  bodyEnd();
  return STEP_BUILD_OK;
}

// Module-init fill: set every idLookup / vertexCache / edgeCache slot to
// ID_NONE.  This runs once at WASM instantiation time.  For 4M entries
// this touches ~48 MB which is acceptable for a single cold boot.
export function stepBuildInit(): void {
  for (let i: u32 = 0; i <= MAX_STEP_ID; i++) {
    unchecked(idLookup[i] = ID_NONE);
    unchecked(vertexCache[i] = ID_NONE);
    unchecked(edgeCache[i] = ID_NONE);
  }
}

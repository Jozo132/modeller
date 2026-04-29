// kernel/extrude — WASM-resident extrude feature construction
//
// Builds analytic extrusion topology directly into the native B-Rep arrays.
// The JS caller provides flat profile loops in the staging buffer; this module
// owns vertex/edge/loop/face/shell construction and leaves the result resident
// on a WASM handle, ready for native tessellation and downstream kernel ops.

import {
  bodyBegin, bodyBeginForHandle, bodyEnd, bodyEndForHandle,
  vertexAdd, vertexGetX, vertexGetY, vertexGetZ,
  edgeAdd, edgeSetCurveSameSense,
  edgeGetStartVertex, edgeGetEndVertex,
  coedgeAdd, coedgeSetNext,
  coedgeGetEdge,
  loopAdd, loopGetCount,
  faceAdd, faceGetCount,
  shellAdd, shellGetCount,
  MAX_EDGES,
  GEOM_LINE, GEOM_PLANE, GEOM_CYLINDER, GEOM_CIRCLE,
  ORIENT_FORWARD, ORIENT_REVERSED,
} from './topology';
import {
  geomPoolReset,
  planeStore, cylinderStore, circleStore,
} from './geometry';
import {
  HANDLE_NONE,
  RESIDENCY_RESIDENT,
  handleBumpRevision,
  handleGetCoedgeStart, handleGetCoedgeEnd,
  handleGetEdgeStart, handleGetEdgeEnd,
  handleIsValid,
  handleSetResidency,
} from './core';

// ─── Public status codes ────────────────────────────────────────────

export const NATIVE_EXTRUDE_OK: i32 = 0;
export const NATIVE_EXTRUDE_ERR_INVALID_HANDLE: i32 = -1;
export const NATIVE_EXTRUDE_ERR_BAD_PROFILE: i32 = -2;
export const NATIVE_EXTRUDE_ERR_STAGING_OVERFLOW: i32 = -3;
export const NATIVE_EXTRUDE_ERR_TOPOLOGY_OVERFLOW: i32 = -4;
export const NATIVE_EXTRUDE_ERR_DEGENERATE: i32 = -5;

export const NATIVE_EXTRUDE_EDGE_LINE: u32 = 0;
export const NATIVE_EXTRUDE_EDGE_ARC: u32 = 1;

// ─── Staging contract ───────────────────────────────────────────────
//
// The staging buffer is f64 based so callers can write it as a Float64Array.
// Layout for each loop:
//   pointCount, edgeCount, isOuter
//   pointCount × (x, y, z) world-space bottom profile points
//   edgeCount × (type, startIdx, endIdx, cx, cy, cz, radius, sweep)
//
// If edgeCount is zero, each adjacent point pair is treated as a line edge.

const STAGING_CAPACITY: u32 = 262144;
const staging = new StaticArray<f64>(STAGING_CAPACITY);

export function nativeExtrudeStagingPtr(): usize {
  return changetype<usize>(staging);
}

export function nativeExtrudeStagingCapacity(): u32 {
  return STAGING_CAPACITY;
}

// ─── Scratch storage ────────────────────────────────────────────────

const MAX_EXTRUDE_LOOPS: u32 = 256;
const MAX_EXTRUDE_POINTS: u32 = 8192;
const MAX_EXTRUDE_PROFILE_EDGES: u32 = 8192;

const loopPointStart = new StaticArray<u32>(MAX_EXTRUDE_LOOPS);
const loopPointCount = new StaticArray<u32>(MAX_EXTRUDE_LOOPS);
const loopEdgeStart = new StaticArray<u32>(MAX_EXTRUDE_LOOPS);
const loopEdgeCount = new StaticArray<u32>(MAX_EXTRUDE_LOOPS);
const loopOuterFlag = new StaticArray<u8>(MAX_EXTRUDE_LOOPS);

const pointBottomVertex = new StaticArray<u32>(MAX_EXTRUDE_POINTS);
const pointTopVertex = new StaticArray<u32>(MAX_EXTRUDE_POINTS);
const pointVerticalEdge = new StaticArray<u32>(MAX_EXTRUDE_POINTS);

const profileEdgeType = new StaticArray<u32>(MAX_EXTRUDE_PROFILE_EDGES);
const profileEdgeStartPoint = new StaticArray<u32>(MAX_EXTRUDE_PROFILE_EDGES);
const profileEdgeEndPoint = new StaticArray<u32>(MAX_EXTRUDE_PROFILE_EDGES);
const profileEdgeCenterX = new StaticArray<f64>(MAX_EXTRUDE_PROFILE_EDGES);
const profileEdgeCenterY = new StaticArray<f64>(MAX_EXTRUDE_PROFILE_EDGES);
const profileEdgeCenterZ = new StaticArray<f64>(MAX_EXTRUDE_PROFILE_EDGES);
const profileEdgeRadius = new StaticArray<f64>(MAX_EXTRUDE_PROFILE_EDGES);
const profileEdgeSweep = new StaticArray<f64>(MAX_EXTRUDE_PROFILE_EDGES);
const profileBottomEdge = new StaticArray<u32>(MAX_EXTRUDE_PROFILE_EDGES);
const profileTopEdge = new StaticArray<u32>(MAX_EXTRUDE_PROFILE_EDGES);

const shellEdgeUseCount = new StaticArray<u8>(MAX_EDGES);

let totalPoints: u32 = 0;
let totalProfileEdges: u32 = 0;
let parsedLoopCount: u32 = 0;
let lastError: i32 = NATIVE_EXTRUDE_OK;
let lastIssueEdge: u32 = 0xFFFFFFFF;

let ex: f64 = 0.0, ey: f64 = 0.0, ez: f64 = 1.0;
let ux: f64 = 1.0, uy: f64 = 0.0, uz: f64 = 0.0;
let dxGlobal: f64 = 0.0, dyGlobal: f64 = 0.0, dzGlobal: f64 = 1.0;

export function nativeExtrudeGetLastError(): i32 { return lastError; }
export function nativeExtrudeGetLastIssueEdge(): u32 { return lastIssueEdge; }

// ─── Builder API ────────────────────────────────────────────────────

export function nativeExtrudeBuildFromStaging(
  handleId: u32,
  loopCount: u32,
  dx: f64, dy: f64, dz: f64,
  planeOx: f64, planeOy: f64, planeOz: f64,
  planeNx: f64, planeNy: f64, planeNz: f64,
  refX: f64, refY: f64, refZ: f64,
): i32 {
  lastError = NATIVE_EXTRUDE_OK;
  lastIssueEdge = 0xFFFFFFFF;

  if (handleId != HANDLE_NONE && !handleIsValid(handleId)) return fail(NATIVE_EXTRUDE_ERR_INVALID_HANDLE);
  if (loopCount == 0 || loopCount > MAX_EXTRUDE_LOOPS) return fail(NATIVE_EXTRUDE_ERR_BAD_PROFILE);

  dxGlobal = dx; dyGlobal = dy; dzGlobal = dz;
  const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dLen < 1e-12) return fail(NATIVE_EXTRUDE_ERR_DEGENERATE);
  ex = dx / dLen; ey = dy / dLen; ez = dz / dLen;

  setRefDir(refX, refY, refZ);

  if (handleId == HANDLE_NONE) {
    bodyBegin();
    geomPoolReset();
  } else {
    bodyBeginForHandle(handleId);
  }

  const parseResult = parseAndEmitProfile(loopCount);
  if (parseResult != NATIVE_EXTRUDE_OK) return fail(parseResult);

  const firstFace = faceGetCount();
  const firstShell = shellGetCount();

  const bottomPlane = planeStore(planeOx, planeOy, planeOz, ex, ey, ez, ux, uy, uz);
  const topPlane = planeStore(planeOx + dx, planeOy + dy, planeOz + dz, ex, ey, ez, ux, uy, uz);
  if (bottomPlane == 0xFFFFFFFF || topPlane == 0xFFFFFFFF) return fail(NATIVE_EXTRUDE_ERR_TOPOLOGY_OVERFLOW);

  const bottomFirstLoop = loopGetCount();
  const bottomFaceId = faceGetCount();
  const bottomLoops = emitCapLoops(bottomFaceId, false);
  if (bottomLoops == 0) return fail(NATIVE_EXTRUDE_ERR_BAD_PROFILE);
  if (faceAdd(bottomFirstLoop, firstShell, GEOM_PLANE, bottomPlane, ORIENT_REVERSED, bottomLoops) == 0xFFFFFFFF) {
    return fail(NATIVE_EXTRUDE_ERR_TOPOLOGY_OVERFLOW);
  }

  const topFirstLoop = loopGetCount();
  const topFaceId = faceGetCount();
  const topLoops = emitCapLoops(topFaceId, true);
  if (topLoops == 0) return fail(NATIVE_EXTRUDE_ERR_BAD_PROFILE);
  if (faceAdd(topFirstLoop, firstShell, GEOM_PLANE, topPlane, ORIENT_FORWARD, topLoops) == 0xFFFFFFFF) {
    return fail(NATIVE_EXTRUDE_ERR_TOPOLOGY_OVERFLOW);
  }

  for (let edgeIndex: u32 = 0; edgeIndex < totalProfileEdges; edgeIndex++) {
    const rc = emitSideFace(edgeIndex, firstShell);
    if (rc != NATIVE_EXTRUDE_OK) return fail(rc);
  }

  const faceCount = faceGetCount() - firstFace;
  if (faceCount == 0) return fail(NATIVE_EXTRUDE_ERR_BAD_PROFILE);
  if (shellAdd(firstFace, faceCount, 1) == 0xFFFFFFFF) return fail(NATIVE_EXTRUDE_ERR_TOPOLOGY_OVERFLOW);

  if (handleId == HANDLE_NONE) {
    bodyEnd();
  } else {
    bodyEndForHandle();
    handleSetResidency(handleId, RESIDENCY_RESIDENT);
    handleBumpRevision(handleId);
  }

  return NATIVE_EXTRUDE_OK;
}

// Native shell-builder diagnostic: all edges in a handle-owned shell should
// have exactly two coedge uses after feature construction/sewing.
export function nativeShellValidateHandle(handleId: u32): u32 {
  lastIssueEdge = 0xFFFFFFFF;
  if (!handleIsValid(handleId)) {
    lastError = NATIVE_EXTRUDE_ERR_INVALID_HANDLE;
    return 1;
  }

  const edgeStart = handleGetEdgeStart(handleId);
  const edgeEnd = handleGetEdgeEnd(handleId);
  const coedgeStart = handleGetCoedgeStart(handleId);
  const coedgeEnd = handleGetCoedgeEnd(handleId);
  if (edgeEnd < edgeStart || edgeEnd > MAX_EDGES) {
    lastError = NATIVE_EXTRUDE_ERR_BAD_PROFILE;
    return 1;
  }

  for (let e: u32 = edgeStart; e < edgeEnd; e++) unchecked(shellEdgeUseCount[e] = 0);
  for (let ce: u32 = coedgeStart; ce < coedgeEnd; ce++) {
    const edgeId = coedgeGetEdge(ce);
    if (edgeId >= edgeStart && edgeId < edgeEnd) {
      const used = unchecked(shellEdgeUseCount[edgeId]);
      unchecked(shellEdgeUseCount[edgeId] = used < 255 ? used + 1 : used);
    }
  }

  let issues: u32 = 0;
  for (let e: u32 = edgeStart; e < edgeEnd; e++) {
    const sv = edgeGetStartVertex(e);
    const ev = edgeGetEndVertex(e);
    const dxv = vertexGetX(sv) - vertexGetX(ev);
    const dyv = vertexGetY(sv) - vertexGetY(ev);
    const dzv = vertexGetZ(sv) - vertexGetZ(ev);
    const degenerate = dxv * dxv + dyv * dyv + dzv * dzv < 1e-24;
    if (unchecked(shellEdgeUseCount[e]) != 2 || degenerate) {
      if (lastIssueEdge == 0xFFFFFFFF) lastIssueEdge = e;
      issues++;
    }
  }

  lastError = issues == 0 ? NATIVE_EXTRUDE_OK : NATIVE_EXTRUDE_ERR_BAD_PROFILE;
  return issues;
}

// ─── Internal construction ──────────────────────────────────────────

function parseAndEmitProfile(loopCount: u32): i32 {
  totalPoints = 0;
  totalProfileEdges = 0;
  parsedLoopCount = loopCount;
  let cursor: u32 = 0;

  for (let loopIndex: u32 = 0; loopIndex < loopCount; loopIndex++) {
    if (cursor + 3 > STAGING_CAPACITY) return NATIVE_EXTRUDE_ERR_STAGING_OVERFLOW;
    const pointCount = <u32>readStage(cursor); cursor++;
    const explicitEdgeCount = <u32>readStage(cursor); cursor++;
    const isOuter = readStage(cursor) != 0.0 ? <u8>1 : <u8>0; cursor++;
    if (pointCount < 3 || totalPoints + pointCount > MAX_EXTRUDE_POINTS) return NATIVE_EXTRUDE_ERR_BAD_PROFILE;

    const pointStart = totalPoints;
    unchecked(loopPointStart[loopIndex] = pointStart);
    unchecked(loopPointCount[loopIndex] = pointCount);
    unchecked(loopOuterFlag[loopIndex] = isOuter);

    for (let i: u32 = 0; i < pointCount; i++) {
      if (cursor + 3 > STAGING_CAPACITY) return NATIVE_EXTRUDE_ERR_STAGING_OVERFLOW;
      const x = readStage(cursor); cursor++;
      const y = readStage(cursor); cursor++;
      const z = readStage(cursor); cursor++;
      const bottom = vertexAdd(x, y, z);
      const top = vertexAdd(x + dxGlobal, y + dyGlobal, z + dzGlobal);
      if (bottom == 0xFFFFFFFF || top == 0xFFFFFFFF) return NATIVE_EXTRUDE_ERR_TOPOLOGY_OVERFLOW;
      unchecked(pointBottomVertex[pointStart + i] = bottom);
      unchecked(pointTopVertex[pointStart + i] = top);
    }

    for (let i: u32 = 0; i < pointCount; i++) {
      const a = unchecked(pointBottomVertex[pointStart + i]);
      const b = unchecked(pointTopVertex[pointStart + i]);
      const edgeId = edgeAdd(a, b, GEOM_LINE, 0);
      if (edgeId == 0xFFFFFFFF) return NATIVE_EXTRUDE_ERR_TOPOLOGY_OVERFLOW;
      unchecked(pointVerticalEdge[pointStart + i] = edgeId);
    }

    const edgeStart = totalProfileEdges;
    unchecked(loopEdgeStart[loopIndex] = edgeStart);

    if (explicitEdgeCount == 0) {
      if (totalProfileEdges + pointCount > MAX_EXTRUDE_PROFILE_EDGES) return NATIVE_EXTRUDE_ERR_BAD_PROFILE;
      for (let i: u32 = 0; i < pointCount; i++) {
        const ei = totalProfileEdges;
        unchecked(profileEdgeType[ei] = NATIVE_EXTRUDE_EDGE_LINE);
        unchecked(profileEdgeStartPoint[ei] = pointStart + i);
        unchecked(profileEdgeEndPoint[ei] = pointStart + ((i + 1) % pointCount));
        unchecked(profileEdgeCenterX[ei] = 0.0);
        unchecked(profileEdgeCenterY[ei] = 0.0);
        unchecked(profileEdgeCenterZ[ei] = 0.0);
        unchecked(profileEdgeRadius[ei] = 0.0);
        unchecked(profileEdgeSweep[ei] = 0.0);
        const rc = emitProfileEdges(ei);
        if (rc != NATIVE_EXTRUDE_OK) return rc;
        totalProfileEdges++;
      }
    } else {
      if (totalProfileEdges + explicitEdgeCount > MAX_EXTRUDE_PROFILE_EDGES) return NATIVE_EXTRUDE_ERR_BAD_PROFILE;
      for (let i: u32 = 0; i < explicitEdgeCount; i++) {
        if (cursor + 8 > STAGING_CAPACITY) return NATIVE_EXTRUDE_ERR_STAGING_OVERFLOW;
        const ei = totalProfileEdges;
        const edgeType = <u32>readStage(cursor); cursor++;
        const startLocal = <u32>readStage(cursor); cursor++;
        const endLocal = <u32>readStage(cursor); cursor++;
        if (startLocal >= pointCount || endLocal >= pointCount) return NATIVE_EXTRUDE_ERR_BAD_PROFILE;
        unchecked(profileEdgeType[ei] = edgeType);
        unchecked(profileEdgeStartPoint[ei] = pointStart + startLocal);
        unchecked(profileEdgeEndPoint[ei] = pointStart + endLocal);
        unchecked(profileEdgeCenterX[ei] = readStage(cursor)); cursor++;
        unchecked(profileEdgeCenterY[ei] = readStage(cursor)); cursor++;
        unchecked(profileEdgeCenterZ[ei] = readStage(cursor)); cursor++;
        unchecked(profileEdgeRadius[ei] = readStage(cursor)); cursor++;
        unchecked(profileEdgeSweep[ei] = readStage(cursor)); cursor++;
        const rc = emitProfileEdges(ei);
        if (rc != NATIVE_EXTRUDE_OK) return rc;
        totalProfileEdges++;
      }
    }

    unchecked(loopEdgeCount[loopIndex] = totalProfileEdges - edgeStart);
    totalPoints += pointCount;
  }

  return totalProfileEdges > 0 ? NATIVE_EXTRUDE_OK : NATIVE_EXTRUDE_ERR_BAD_PROFILE;
}

function emitProfileEdges(edgeIndex: u32): i32 {
  const startPoint = unchecked(profileEdgeStartPoint[edgeIndex]);
  const endPoint = unchecked(profileEdgeEndPoint[edgeIndex]);
  const bottomStart = unchecked(pointBottomVertex[startPoint]);
  const bottomEnd = unchecked(pointBottomVertex[endPoint]);
  const topStart = unchecked(pointTopVertex[startPoint]);
  const topEnd = unchecked(pointTopVertex[endPoint]);
  const edgeType = unchecked(profileEdgeType[edgeIndex]);

  if (edgeType == NATIVE_EXTRUDE_EDGE_ARC) {
    const radius = unchecked(profileEdgeRadius[edgeIndex]);
    if (radius <= 1e-12) return NATIVE_EXTRUDE_ERR_DEGENERATE;
    const cx = unchecked(profileEdgeCenterX[edgeIndex]);
    const cy = unchecked(profileEdgeCenterY[edgeIndex]);
    const cz = unchecked(profileEdgeCenterZ[edgeIndex]);
    let rx = vertexGetX(bottomStart) - cx;
    let ry = vertexGetY(bottomStart) - cy;
    let rz = vertexGetZ(bottomStart) - cz;
    const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (rLen < 1e-12) return NATIVE_EXTRUDE_ERR_DEGENERATE;
    rx /= rLen; ry /= rLen; rz /= rLen;

    const bottomOff = circleStore(cx, cy, cz, ex, ey, ez, rx, ry, rz, radius);
    const topOff = circleStore(cx + dxGlobal, cy + dyGlobal, cz + dzGlobal, ex, ey, ez, rx, ry, rz, radius);
    if (bottomOff == 0xFFFFFFFF || topOff == 0xFFFFFFFF) return NATIVE_EXTRUDE_ERR_TOPOLOGY_OVERFLOW;

    const bottomEdge = edgeAdd(bottomStart, bottomEnd, GEOM_CIRCLE, bottomOff);
    const topEdge = edgeAdd(topStart, topEnd, GEOM_CIRCLE, topOff);
    if (bottomEdge == 0xFFFFFFFF || topEdge == 0xFFFFFFFF) return NATIVE_EXTRUDE_ERR_TOPOLOGY_OVERFLOW;
    const sameSense: u8 = unchecked(profileEdgeSweep[edgeIndex]) >= 0.0 ? 1 : 0;
    edgeSetCurveSameSense(bottomEdge, sameSense);
    edgeSetCurveSameSense(topEdge, sameSense);
    unchecked(profileBottomEdge[edgeIndex] = bottomEdge);
    unchecked(profileTopEdge[edgeIndex] = topEdge);
    return NATIVE_EXTRUDE_OK;
  }

  const bottomEdge = edgeAdd(bottomStart, bottomEnd, GEOM_LINE, 0);
  const topEdge = edgeAdd(topStart, topEnd, GEOM_LINE, 0);
  if (bottomEdge == 0xFFFFFFFF || topEdge == 0xFFFFFFFF) return NATIVE_EXTRUDE_ERR_TOPOLOGY_OVERFLOW;
  unchecked(profileBottomEdge[edgeIndex] = bottomEdge);
  unchecked(profileTopEdge[edgeIndex] = topEdge);
  return NATIVE_EXTRUDE_OK;
}

function emitCapLoops(faceId: u32, top: bool): u32 {
  let emitted: u32 = 0;
  // Emit outer loops before inner loops so face.firstLoop remains the outer
  // boundary for readers that assume loop 0 is special.
  for (let pass: u32 = 0; pass < 2; pass++) {
    const wantOuter: u8 = pass == 0 ? 1 : 0;
    for (let loopIndex: u32 = 0; loopIndex < parsedLoopCount; loopIndex++) {
      if (unchecked(loopOuterFlag[loopIndex]) != wantOuter) continue;
      const edgeStart = unchecked(loopEdgeStart[loopIndex]);
      const edgeCount = unchecked(loopEdgeCount[loopIndex]);
      if (edgeCount == 0) continue;
      const loopId = loopGetCount();
      const firstCoedge = emitCapCoedges(loopId, edgeStart, edgeCount, top);
      if (firstCoedge == 0xFFFFFFFF) return emitted;
      const added = loopAdd(firstCoedge, faceId, wantOuter);
      if (added == 0xFFFFFFFF) return emitted;
      emitted++;
    }
  }
  return emitted;
}

function emitCapCoedges(loopId: u32, edgeStart: u32, edgeCount: u32, top: bool): u32 {
  const firstCoedge = coedgeAdd(capEdgeId(edgeStart, edgeCount, 0, top), capOrient(top), 0, loopId);
  if (firstCoedge == 0xFFFFFFFF) return firstCoedge;
  let prev = firstCoedge;
  for (let i: u32 = 1; i < edgeCount; i++) {
    const ce = coedgeAdd(capEdgeId(edgeStart, edgeCount, i, top), capOrient(top), 0, loopId);
    if (ce == 0xFFFFFFFF) return ce;
    coedgeSetNext(prev, ce);
    prev = ce;
  }
  coedgeSetNext(prev, firstCoedge);
  return firstCoedge;
}

function capEdgeId(edgeStart: u32, edgeCount: u32, i: u32, top: bool): u32 {
  if (top) return unchecked(profileTopEdge[edgeStart + i]);
  const reversedIndex = edgeStart + (edgeCount - 1 - i);
  return unchecked(profileBottomEdge[reversedIndex]);
}

function capOrient(top: bool): u8 {
  return top ? ORIENT_FORWARD : ORIENT_REVERSED;
}

function emitSideFace(edgeIndex: u32, shellId: u32): i32 {
  const startPoint = unchecked(profileEdgeStartPoint[edgeIndex]);
  const endPoint = unchecked(profileEdgeEndPoint[edgeIndex]);

  let geomType: u8 = GEOM_PLANE;
  let geomOffset: u32 = 0;
  if (unchecked(profileEdgeType[edgeIndex]) == NATIVE_EXTRUDE_EDGE_ARC) {
    const radius = unchecked(profileEdgeRadius[edgeIndex]);
    const cx = unchecked(profileEdgeCenterX[edgeIndex]);
    const cy = unchecked(profileEdgeCenterY[edgeIndex]);
    const cz = unchecked(profileEdgeCenterZ[edgeIndex]);
    const startVertex = unchecked(pointBottomVertex[startPoint]);
    let rx = vertexGetX(startVertex) - cx;
    let ry = vertexGetY(startVertex) - cy;
    let rz = vertexGetZ(startVertex) - cz;
    const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (rLen < 1e-12) return NATIVE_EXTRUDE_ERR_DEGENERATE;
    rx /= rLen; ry /= rLen; rz /= rLen;
    geomOffset = cylinderStore(cx, cy, cz, ex, ey, ez, rx, ry, rz, radius);
    geomType = GEOM_CYLINDER;
  } else {
    const a = unchecked(pointBottomVertex[startPoint]);
    const b = unchecked(pointBottomVertex[endPoint]);
    const sx = vertexGetX(b) - vertexGetX(a);
    const sy = vertexGetY(b) - vertexGetY(a);
    const sz = vertexGetZ(b) - vertexGetZ(a);
    const sLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (sLen < 1e-12) return NATIVE_EXTRUDE_ERR_DEGENERATE;
    const rx = sx / sLen, ry = sy / sLen, rz = sz / sLen;
    let nx = sy * dzGlobal - sz * dyGlobal;
    let ny = sz * dxGlobal - sx * dzGlobal;
    let nz = sx * dyGlobal - sy * dxGlobal;
    const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nLen < 1e-12) return NATIVE_EXTRUDE_ERR_DEGENERATE;
    nx /= nLen; ny /= nLen; nz /= nLen;
    geomOffset = planeStore(vertexGetX(a), vertexGetY(a), vertexGetZ(a), nx, ny, nz, rx, ry, rz);
    geomType = GEOM_PLANE;
  }
  if (geomOffset == 0xFFFFFFFF) return NATIVE_EXTRUDE_ERR_TOPOLOGY_OVERFLOW;

  const faceId = faceGetCount();
  const loopId = loopGetCount();
  const ce0 = coedgeAdd(unchecked(profileBottomEdge[edgeIndex]), ORIENT_FORWARD, 0, loopId);
  const ce1 = coedgeAdd(unchecked(pointVerticalEdge[endPoint]), ORIENT_FORWARD, 0, loopId);
  const ce2 = coedgeAdd(unchecked(profileTopEdge[edgeIndex]), ORIENT_REVERSED, 0, loopId);
  const ce3 = coedgeAdd(unchecked(pointVerticalEdge[startPoint]), ORIENT_REVERSED, 0, loopId);
  if (ce0 == 0xFFFFFFFF || ce1 == 0xFFFFFFFF || ce2 == 0xFFFFFFFF || ce3 == 0xFFFFFFFF) {
    return NATIVE_EXTRUDE_ERR_TOPOLOGY_OVERFLOW;
  }
  coedgeSetNext(ce0, ce1);
  coedgeSetNext(ce1, ce2);
  coedgeSetNext(ce2, ce3);
  coedgeSetNext(ce3, ce0);
  const loop = loopAdd(ce0, faceId, 1);
  if (loop == 0xFFFFFFFF) return NATIVE_EXTRUDE_ERR_TOPOLOGY_OVERFLOW;
  if (faceAdd(loop, shellId, geomType, geomOffset, ORIENT_FORWARD, 1) == 0xFFFFFFFF) {
    return NATIVE_EXTRUDE_ERR_TOPOLOGY_OVERFLOW;
  }
  return NATIVE_EXTRUDE_OK;
}

function setRefDir(rx: f64, ry: f64, rz: f64): void {
  const axial = rx * ex + ry * ey + rz * ez;
  ux = rx - axial * ex;
  uy = ry - axial * ey;
  uz = rz - axial * ez;
  let len = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (len < 1e-12) {
    if (Math.abs(ex) < 0.9) { ux = 1.0; uy = 0.0; uz = 0.0; }
    else { ux = 0.0; uy = 1.0; uz = 0.0; }
    const ax = ux * ex + uy * ey + uz * ez;
    ux -= ax * ex; uy -= ax * ey; uz -= ax * ez;
    len = Math.sqrt(ux * ux + uy * uy + uz * uz);
  }
  ux /= len; uy /= len; uz /= len;
}

@inline
function readStage(i: u32): f64 {
  return unchecked(staging[i]);
}

function fail(code: i32): i32 {
  lastError = code;
  return code;
}

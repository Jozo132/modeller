// kernel/tessellation — native face-level tessellation for WASM-resident bodies
//
// Tessellates faces stored in kernel/topology + kernel/geometry into flat
// vertex/normal/index buffers. Supports:
//   - Planes (trivial face from boundary loop vertices)
//   - Cylinders, cones (UV parametric grid, boundary-trimmed)
//   - Spheres (UV parametric grid, boundary-trimmed)
//   - Tori (UV parametric grid, boundary-trimmed)
//   - NURBS surfaces (delegates to assembly/nurbs.ts nurbsSurfaceTessellate)
//
// Boundary-aware trimming: parametric grid vertices are culled using a
// point-in-polygon test against the face boundary projected to UV space.
// NURBS edge curves are sampled at intermediate points for accurate boundary.
//
// Cross-parametric edge mapping: shared edges are sampled once into a shared
// edge sample cache keyed by edge id. Both adjacent faces reuse the same
// boundary samples, ensuring watertight seams by construction.
//
// Output buffers:
//   tessOutVerts   — flat f64 [x,y,z, x,y,z, ...]
//   tessOutNormals — flat f64 [nx,ny,nz, ...]
//   tessOutIndices — flat u32 [i0,i1,i2, ...]
//   tessOutFaceMap — u32 per triangle: which source face id it belongs to

import {
  faceGetCount, faceGetGeomType, faceGetGeomOffset, faceGetOrient,
  faceGetFirstLoop, faceGetLoopCount,
  loopGetFirstCoedge,
  coedgeGetEdge, coedgeGetOrient, coedgeGetNext,
  edgeGetStartVertex, edgeGetEndVertex,
  edgeGetGeomType, edgeGetGeomOffset, edgeGetCurveSameSense,
  vertexGetX, vertexGetY, vertexGetZ,
  GEOM_PLANE, GEOM_CYLINDER, GEOM_CONE, GEOM_SPHERE, GEOM_TORUS,
  GEOM_LINE,
  GEOM_NURBS_SURFACE, GEOM_NURBS_CURVE, GEOM_CIRCLE, GEOM_ROLLING_FILLET, GEOM_BOUNDARY_FAN,
  ORIENT_REVERSED,
} from './topology';

import { geomPoolRead } from './geometry';

import {
  nurbsSurfaceTessellate,
  nurbsSurfaceNormal,
  nurbsSurfaceDerivEval,
  nurbsCurveEvaluate,
  getResultPtr,
  getDerivBufPtr,
  getTessVertsPtr, getTessNormalsPtr, getTessFacesPtr,
} from '../nurbs';

import {
  RESIDENCY_RESIDENT,
  handleGetFaceEnd,
  handleGetFaceStart,
  handleGetResidency,
  handleIsValid,
} from './core';

// ─── Output buffer constants ─────────────────────────────────────────

/** Max output vertices across all faces combined. */
const MAX_OUT_VERTS: u32 = 262144;     // 256K vertices
/** Max output triangles. */
const MAX_OUT_TRIS: u32 = 524288;      // 512K triangles

const tessOutVerts = new StaticArray<f64>(MAX_OUT_VERTS * 3);
const tessOutNormals = new StaticArray<f64>(MAX_OUT_VERTS * 3);
const tessOutIndices = new StaticArray<u32>(MAX_OUT_TRIS * 3);
const tessOutFaceMap = new StaticArray<u32>(MAX_OUT_TRIS);

let outVertCount: u32 = 0;
let outTriCount: u32 = 0;

// ─── Edge sample cache for cross-parametric mapping ──────────────────

/** Max distinct edges that can be sampled. */
const MAX_EDGE_CACHE: u32 = 32768;
/** Max total edge sample points across all cached edges. */
const MAX_EDGE_SAMPLES: u32 = 524288;   // 512K sample points

/** Per-edge: start index into edgeSamplePts, sample count, cached flag. */
const edgeCacheStart = new StaticArray<u32>(MAX_EDGE_CACHE);
const edgeCacheCount = new StaticArray<u32>(MAX_EDGE_CACHE);
const edgeCacheDone = new StaticArray<u8>(MAX_EDGE_CACHE);
/** Flat sample point storage [x,y,z, x,y,z, ...]. */
const edgeSamplePts = new StaticArray<f64>(MAX_EDGE_SAMPLES * 3);
let edgeSampleTotal: u32 = 0;

// ─── Temp working buffers ────────────────────────────────────────────

/** Boundary loop vertices (indices) for the current face. */
const loopVerts = new StaticArray<u32>(8192);
let loopVertCount: u32 = 0;

/** Planar face working buffers: sampled loop points and a bridged polygon path. */
const MAX_PLANAR_PTS: u32 = 65536;
const MAX_PLANAR_PATH: u32 = 65536;
const MAX_PLANAR_LOOPS: u32 = 128;
const MAX_TRIM_TRIS: u32 = 131072;
const MAX_TRIM_MIDS: u32 = 65536;
const _planarX = new StaticArray<f64>(MAX_PLANAR_PTS);
const _planarY = new StaticArray<f64>(MAX_PLANAR_PTS);
const _planarZ = new StaticArray<f64>(MAX_PLANAR_PTS);
const _planarU = new StaticArray<f64>(MAX_PLANAR_PTS);
const _planarV = new StaticArray<f64>(MAX_PLANAR_PTS);
const _planarLoopStart = new StaticArray<u32>(MAX_PLANAR_LOOPS);
const _planarLoopEnd = new StaticArray<u32>(MAX_PLANAR_LOOPS);
const _planarPath = new StaticArray<u32>(MAX_PLANAR_PATH);
const _planarPathNext = new StaticArray<u32>(MAX_PLANAR_PATH);
const _planarRemaining = new StaticArray<u32>(MAX_PLANAR_PATH);
const _planarOutVert = new StaticArray<u32>(MAX_PLANAR_PTS);
const _trimTriA = new StaticArray<u32>(MAX_TRIM_TRIS);
const _trimTriB = new StaticArray<u32>(MAX_TRIM_TRIS);
const _trimTriC = new StaticArray<u32>(MAX_TRIM_TRIS);
const _trimNextA = new StaticArray<u32>(MAX_TRIM_TRIS);
const _trimNextB = new StaticArray<u32>(MAX_TRIM_TRIS);
const _trimNextC = new StaticArray<u32>(MAX_TRIM_TRIS);
const _trimMidA = new StaticArray<u32>(MAX_TRIM_MIDS);
const _trimMidB = new StaticArray<u32>(MAX_TRIM_MIDS);
const _trimMidId = new StaticArray<u32>(MAX_TRIM_MIDS);
let _planarPointCount: u32 = 0;
let _planarLoopCount: u32 = 0;
let _planarPathCount: u32 = 0;
let _trimTriCount: u32 = 0;
let _trimNextCount: u32 = 0;
let _trimMidCount: u32 = 0;
let _trimOriginalPointCount: u32 = 0;
let _trimDidSplit: bool = false;

let _planeOx: f64 = 0, _planeOy: f64 = 0, _planeOz: f64 = 0;
let _planeRx: f64 = 1, _planeRy: f64 = 0, _planeRz: f64 = 0;
let _planeYx: f64 = 0, _planeYy: f64 = 1, _planeYz: f64 = 0;
let _planeNx: f64 = 0, _planeNy: f64 = 0, _planeNz: f64 = 1;

/** Default tessellation segments for analytic surfaces. */
const DEFAULT_SEGS: i32 = 16;

// ─── Boundary UV collection system ───────────────────────────────────

/** Max boundary polygon points (all loops combined, including edge samples). */
const MAX_BND: u32 = 16384;
const _bndU = new StaticArray<f64>(MAX_BND);
const _bndV = new StaticArray<f64>(MAX_BND);
let _bndCount: u32 = 0;

const MAX_BND_LOOPS: u32 = 128;
const _bndLoopStart = new StaticArray<u32>(MAX_BND_LOOPS);
const _bndLoopEnd = new StaticArray<u32>(MAX_BND_LOOPS);
const _bndLoopFirstU = new StaticArray<f64>(MAX_BND_LOOPS);
const _bndLoopFirstV = new StaticArray<f64>(MAX_BND_LOOPS);
let _bndLoopCount: u32 = 0;

/** UV bounding box (U shifted relative to center). */
let _uvUmin: f64 = 0, _uvUmax: f64 = 0;
let _uvVmin: f64 = 0, _uvVmax: f64 = 0;
let _uvUcenter: f64 = 0;

/** Whether boundary-polygon trimming is appropriate for this face. */
let _trimEnabled: bool = true;

/** Number of intermediate samples per NURBS curve edge. */
const EDGE_INTERP: i32 = 4;

// ─── Curve sampling buffers ──────────────────────────────────────────

const _CRV_MAX: i32 = 256;
const _crvCtrl = new Float64Array(_CRV_MAX * 3);
const _crvKnots = new Float64Array(_CRV_MAX * 2);
const _crvWts = new Float64Array(_CRV_MAX);
let _crvDeg: i32 = 0, _crvNCtrl: i32 = 0;
let _crvTmin: f64 = 0, _crvTmax: f64 = 1;

// ─── UV projection state ────────────────────────────────────────────

/** Projection mode: 0=revolution (cyl/cone), 1=sphere, 2=torus */
let _projMode: i32 = 0;
let _proj_ox: f64 = 0, _proj_oy: f64 = 0, _proj_oz: f64 = 0;
let _proj_ax: f64 = 0, _proj_ay: f64 = 0, _proj_az: f64 = 0;
let _proj_rx: f64 = 0, _proj_ry: f64 = 0, _proj_rz: f64 = 0;
let _proj_bx: f64 = 0, _proj_by: f64 = 0, _proj_bz: f64 = 0;
let _proj_majorR: f64 = 0;
let _projU: f64 = 0, _projV: f64 = 0;

// ─── Surface evaluation output ───────────────────────────────────────

let _surfX: f64 = 0, _surfY: f64 = 0, _surfZ: f64 = 0;
let _surfNX: f64 = 0, _surfNY: f64 = 0, _surfNZ: f64 = 0;
let _nurbsClosestU: f64 = 0, _nurbsClosestV: f64 = 0, _nurbsClosestDist2: f64 = 0;

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Tessellate all faces in the current body.
 * Reads from topology + geometry, writes to output buffers.
 *
 * @param segsU — segments in U direction for parametric surfaces
 * @param segsV — segments in V direction for parametric surfaces
 * @returns number of triangles written, or -1 on overflow
 */
export function tessBuildAllFaces(segsU: i32, segsV: i32): i32 {
  tessReset();
  return _tessBuildFaceRange(0, faceGetCount(), segsU, segsV);
}

/**
 * Tessellate only the face range owned by a resident handle.
 * Returns the number of triangles written, or a negative error code:
 *   -1 overflow, -2 invalid handle, -3 handle is not resident, -4 bad range.
 */
export function tessBuildHandleFaces(handleId: u32, segsU: i32, segsV: i32): i32 {
  if (!handleIsValid(handleId)) return -2;
  if (handleGetResidency(handleId) != RESIDENCY_RESIDENT) return -3;

  const faceStart = handleGetFaceStart(handleId);
  const faceEnd = handleGetFaceEnd(handleId);
  if (faceEnd < faceStart || faceEnd > faceGetCount()) return -4;

  tessReset();
  return _tessBuildFaceRange(faceStart, faceEnd, segsU, segsV);
}

/**
 * Tessellate a single face.
 * @param faceId — the face index in the topology
 * @param segsU — U segments
 * @param segsV — V segments
 * @returns number of triangles added, or -1 on overflow
 */
export function tessBuildFace(faceId: u32, segsU: i32, segsV: i32): i32 {
  return _tessBuildOneFace(faceId, segsU, segsV);
}

function _tessBuildFaceRange(faceStart: u32, faceEnd: u32, segsU: i32, segsV: i32): i32 {
  for (let f: u32 = faceStart; f < faceEnd; f++) {
    const result = _tessBuildOneFace(f, segsU, segsV);
    if (result < 0) return -1;
  }
  return <i32>outTriCount;
}

function _tessBuildOneFace(faceId: u32, segsU: i32, segsV: i32): i32 {
  const geomType = faceGetGeomType(faceId);

  if (geomType == GEOM_PLANE) return _tessPlaneFace(faceId, segsU);
  if (geomType == GEOM_CYLINDER) return _tessCylinderFace(faceId, segsU, segsV);
  if (geomType == GEOM_CONE) return _tessConeFace(faceId, segsU, segsV);
  if (geomType == GEOM_SPHERE) return _tessSphereFace(faceId, segsU, segsV);
  if (geomType == GEOM_TORUS) return _tessTorusFace(faceId, segsU, segsV);
  if (geomType == GEOM_ROLLING_FILLET) return _tessRollingFilletFace(faceId);
  if (geomType == GEOM_BOUNDARY_FAN) return _tessBoundaryFanFace(faceId);
  if (geomType == GEOM_NURBS_SURFACE) return _tessNurbsFace(faceId, segsU, segsV);

  return 0;
}

/** Reset output buffers for a new tessellation pass. */
export function tessReset(): void {
  outVertCount = 0;
  outTriCount = 0;
  edgeSampleTotal = 0;
  for (let e: u32 = 0; e < MAX_EDGE_CACHE; e++) {
    unchecked(edgeCacheDone[e] = 0);
  }
}

// ─── Output accessors ────────────────────────────────────────────────

export function getTessOutVertsPtr(): usize { return changetype<usize>(tessOutVerts); }
export function getTessOutNormalsPtr(): usize { return changetype<usize>(tessOutNormals); }
export function getTessOutIndicesPtr(): usize { return changetype<usize>(tessOutIndices); }
export function getTessOutFaceMapPtr(): usize { return changetype<usize>(tessOutFaceMap); }
export function getTessOutVertCount(): u32 { return outVertCount; }
export function getTessOutTriCount(): u32 { return outTriCount; }

// ─── Typed accessors for intra-kernel consumers (e.g. ops.classifyPointVsTriangles) ──

/** Read a triangle vertex position (triIndex 0..triCount-1, corner 0..2, comp 0=x 1=y 2=z). */
@inline
export function tessTriVertComp(triIdx: u32, corner: u32, comp: u32): f64 {
  const vIdx = unchecked(tessOutIndices[triIdx * 3 + corner]);
  return unchecked(tessOutVerts[vIdx * 3 + comp]);
}

// Edge cache accessors
export function getEdgeSamplePtsPtr(): usize { return changetype<usize>(edgeSamplePts); }
export function getEdgeSampleCount(edgeId: u32): u32 {
  if (edgeId >= MAX_EDGE_CACHE || !unchecked(edgeCacheDone[edgeId])) return 0;
  return unchecked(edgeCacheCount[edgeId]);
}
export function getEdgeSampleStart(edgeId: u32): u32 {
  if (edgeId >= MAX_EDGE_CACHE) return 0;
  return unchecked(edgeCacheStart[edgeId]);
}

// ─── Internal: collect boundary loop vertices ────────────────────────

function _collectOuterLoopVerts(faceId: u32): void {
  loopVertCount = 0;
  const firstLoop = faceGetFirstLoop(faceId);
  const firstCE = loopGetFirstCoedge(firstLoop);
  let ce = firstCE;
  let guard: u32 = 0;

  do {
    const eid = coedgeGetEdge(ce);
    const orient = coedgeGetOrient(ce);
    const vid = orient == ORIENT_REVERSED
      ? edgeGetEndVertex(eid)
      : edgeGetStartVertex(eid);

    if (loopVertCount < 8192) {
      unchecked(loopVerts[loopVertCount] = vid);
      loopVertCount++;
    }

    // Cache edge samples (just the endpoints for now — the shared cache
    // guarantees adjacent faces reuse the same sample points)
    _cacheEdgeSamples(eid);

    ce = coedgeGetNext(ce);
    guard++;
  } while (ce != firstCE && guard < 65536);
}

/**
 * Cache sampled points for an edge (currently just start+end vertices).
 * Adjacent faces sharing this edge will hit the cache and get the same
 * boundary points, ensuring watertight seams.
 */
function _cacheEdgeSamples(edgeId: u32): void {
  if (edgeId >= MAX_EDGE_CACHE) return;
  if (unchecked(edgeCacheDone[edgeId])) return;

  const sv = edgeGetStartVertex(edgeId);
  const ev = edgeGetEndVertex(edgeId);
  const start = edgeSampleTotal;

  if (start + 2 > MAX_EDGE_SAMPLES) return; // overflow guard

  let p = start * 3;
  unchecked(edgeSamplePts[p] = vertexGetX(sv));
  unchecked(edgeSamplePts[p + 1] = vertexGetY(sv));
  unchecked(edgeSamplePts[p + 2] = vertexGetZ(sv));
  p += 3;
  unchecked(edgeSamplePts[p] = vertexGetX(ev));
  unchecked(edgeSamplePts[p + 1] = vertexGetY(ev));
  unchecked(edgeSamplePts[p + 2] = vertexGetZ(ev));

  unchecked(edgeCacheStart[edgeId] = start);
  unchecked(edgeCacheCount[edgeId] = 2);
  unchecked(edgeCacheDone[edgeId] = 1);
  edgeSampleTotal += 2;
}

// ─── Internal: curve loading ─────────────────────────────────────────

/** Load a NURBS curve from the geometry pool into pre-allocated buffers. */
function _loadCurve(geomOff: u32): bool {
  const deg = <i32>geomPoolRead(geomOff);
  const nCtrl = <i32>geomPoolRead(geomOff + 1);
  const nKnots = <i32>geomPoolRead(geomOff + 2);
  if (nCtrl > _CRV_MAX || nKnots > _CRV_MAX * 2) return false;

  _crvDeg = deg;
  _crvNCtrl = nCtrl;

  let p: u32 = geomOff + 3;
  for (let i: i32 = 0; i < nKnots; i++) { unchecked(_crvKnots[i] = geomPoolRead(p)); p++; }
  for (let i: i32 = 0; i < nCtrl * 3; i++) { unchecked(_crvCtrl[i] = geomPoolRead(p)); p++; }
  for (let i: i32 = 0; i < nCtrl; i++) { unchecked(_crvWts[i] = geomPoolRead(p)); p++; }

  _crvTmin = unchecked(_crvKnots[deg]);
  _crvTmax = unchecked(_crvKnots[nCtrl]);
  return true;
}

// ─── Internal: UV projection ─────────────────────────────────────────

/** Project a 3D point to UV parameters based on current projection mode. */
function _projectPoint(px: f64, py: f64, pz: f64): void {
  const dx = px - _proj_ox;
  const dy = py - _proj_oy;
  const dz = pz - _proj_oz;

  if (_projMode == 0) {
    // Revolution (cylinder/cone): u=angle, v=height along axis
    const h = dx * _proj_ax + dy * _proj_ay + dz * _proj_az;
    const radX = dx - h * _proj_ax;
    const radY = dy - h * _proj_ay;
    const radZ = dz - h * _proj_az;
    _projU = Math.atan2(
      radX * _proj_bx + radY * _proj_by + radZ * _proj_bz,
      radX * _proj_rx + radY * _proj_ry + radZ * _proj_rz
    );
    _projV = h;
  } else if (_projMode == 1) {
    // Sphere: u=longitude around axis, v=latitude from equatorial plane
    const h = dx * _proj_ax + dy * _proj_ay + dz * _proj_az;
    const radX = dx - h * _proj_ax;
    const radY = dy - h * _proj_ay;
    const radZ = dz - h * _proj_az;
    _projU = Math.atan2(
      radX * _proj_bx + radY * _proj_by + radZ * _proj_bz,
      radX * _proj_rx + radY * _proj_ry + radZ * _proj_rz
    );
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const sinLat = r > 1e-15 ? h / r : 0.0;
    _projV = Math.asin(sinLat < -1.0 ? -1.0 : sinLat > 1.0 ? 1.0 : sinLat);
  } else {
    // Torus: u=major angle, v=minor angle
    const h = dx * _proj_ax + dy * _proj_ay + dz * _proj_az;
    const radX = dx - h * _proj_ax;
    const radY = dy - h * _proj_ay;
    const radZ = dz - h * _proj_az;
    const cosA = radX * _proj_rx + radY * _proj_ry + radZ * _proj_rz;
    const sinA = radX * _proj_bx + radY * _proj_by + radZ * _proj_bz;
    _projU = Math.atan2(sinA, cosA);
    const ringDist = Math.sqrt(cosA * cosA + sinA * sinA);
    _projV = Math.atan2(h, ringDist - _proj_majorR);
  }
}

function _projectCircleEdgePoint(edgeId: u32, theta: f64): void {
  const off = edgeGetGeomOffset(edgeId);
  const cx = geomPoolRead(off);
  const cy = geomPoolRead(off + 1);
  const cz = geomPoolRead(off + 2);
  const ax = geomPoolRead(off + 3);
  const ay = geomPoolRead(off + 4);
  const az = geomPoolRead(off + 5);
  const rx = geomPoolRead(off + 6);
  const ry = geomPoolRead(off + 7);
  const rz = geomPoolRead(off + 8);
  const radius = geomPoolRead(off + 9);
  const bx = ay * rz - az * ry;
  const by = az * rx - ax * rz;
  const bz = ax * ry - ay * rx;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  _projectPoint(
    cx + radius * (rx * c + bx * s),
    cy + radius * (ry * c + by * s),
    cz + radius * (rz * c + bz * s),
  );
}

// ─── Internal: boundary UV collection ────────────────────────────────

/**
 * Collect boundary polygon in UV space from all face loops.
 * Samples NURBS curve edges at intermediate points for accuracy.
 * Sets _bndU/_bndV, _bndLoopStart/_bndLoopEnd, UV bounding box.
 */
function _collectBoundaryUV(faceId: u32): void {
  _bndCount = 0;
  _bndLoopCount = 0;

  const firstLoop = faceGetFirstLoop(faceId);
  const nLoops = faceGetLoopCount(faceId);

  let sumCos: f64 = 0, sumSin: f64 = 0;
  let nSamples: u32 = 0;

  for (let l: u32 = 0; l < nLoops; l++) {
    const loopId = firstLoop + l;
    const loopStartIdx = _bndCount;
    let loopFirstU: f64 = 0.0;
    let loopFirstV: f64 = 0.0;
    let loopHaveFirst: bool = false;

    const firstCE = loopGetFirstCoedge(loopId);
    let ce = firstCE;
    let guard: u32 = 0;

    do {
      const eid = coedgeGetEdge(ce);
      const orient = coedgeGetOrient(ce);

      // Add coedge start vertex
      const vid = orient == ORIENT_REVERSED
        ? edgeGetEndVertex(eid) : edgeGetStartVertex(eid);
      _projectPoint(vertexGetX(vid), vertexGetY(vid), vertexGetZ(vid));
      if (!loopHaveFirst) {
        loopFirstU = _projU;
        loopFirstV = _projV;
        loopHaveFirst = true;
      }
      if (_bndCount < MAX_BND) {
        unchecked(_bndU[_bndCount] = _projU);
        unchecked(_bndV[_bndCount] = _projV);
        _bndCount++;
      }
      sumCos += Math.cos(_projU);
      sumSin += Math.sin(_projU);
      nSamples++;

      // Cache edge samples for watertight seams
      _cacheEdgeSamples(eid);

      // Sample intermediate NURBS curve points
      if (edgeGetGeomType(eid) == GEOM_NURBS_CURVE) {
        const geomOff = edgeGetGeomOffset(eid);
        if (_loadCurve(geomOff)) {
          const rev = orient == ORIENT_REVERSED;
          for (let s: i32 = 1; s <= EDGE_INTERP; s++) {
            const frac: f64 = <f64>s / <f64>(EDGE_INTERP + 1);
            const t = rev
              ? _crvTmax - frac * (_crvTmax - _crvTmin)
              : _crvTmin + frac * (_crvTmax - _crvTmin);
            nurbsCurveEvaluate(_crvDeg, _crvNCtrl, _crvCtrl, _crvKnots, _crvWts, t);
            const rp = getResultPtr();
            _projectPoint(
              load<f64>(rp),
              load<f64>(rp + 8),
              load<f64>(rp + 16)
            );
            if (_bndCount < MAX_BND) {
              unchecked(_bndU[_bndCount] = _projU);
              unchecked(_bndV[_bndCount] = _projV);
              _bndCount++;
            }
            sumCos += Math.cos(_projU);
            sumSin += Math.sin(_projU);
            nSamples++;
          }
        }
      } else if (edgeGetGeomType(eid) == GEOM_CIRCLE) {
        const rev = orient == ORIENT_REVERSED;
        for (let s: i32 = 1; s <= EDGE_INTERP; s++) {
          const frac: f64 = <f64>s / <f64>(EDGE_INTERP + 1);
          const theta = (rev ? -2.0 : 2.0) * Math.PI * frac;
          _projectCircleEdgePoint(eid, theta);
          if (_bndCount < MAX_BND) {
            unchecked(_bndU[_bndCount] = _projU);
            unchecked(_bndV[_bndCount] = _projV);
            _bndCount++;
          }
          sumCos += Math.cos(_projU);
          sumSin += Math.sin(_projU);
          nSamples++;
        }
      }

      ce = coedgeGetNext(ce);
      guard++;
    } while (ce != firstCE && guard < 65536);

    if (_bndLoopCount < MAX_BND_LOOPS) {
      unchecked(_bndLoopStart[_bndLoopCount] = loopStartIdx);
      unchecked(_bndLoopEnd[_bndLoopCount] = _bndCount);
      unchecked(_bndLoopFirstU[_bndLoopCount] = loopFirstU);
      unchecked(_bndLoopFirstV[_bndLoopCount] = loopFirstV);
      _bndLoopCount++;
    }
  }

  // Center angle for wraparound handling (circular mean)
  _uvUcenter = nSamples > 0
    ? Math.atan2(sumSin / <f64>nSamples, sumCos / <f64>nSamples)
    : 0.0;

  // Shift U values relative to center, compute UV bounding box
  _uvUmin = Infinity;
  _uvUmax = -Infinity;
  _uvVmin = Infinity;
  _uvVmax = -Infinity;

  for (let i: u32 = 0; i < _bndCount; i++) {
    let u = unchecked(_bndU[i]) - _uvUcenter;
    while (u > Math.PI) u -= 2.0 * Math.PI;
    while (u < -Math.PI) u += 2.0 * Math.PI;
    unchecked(_bndU[i] = u);
    if (u < _uvUmin) _uvUmin = u;
    if (u > _uvUmax) _uvUmax = u;
    const v = unchecked(_bndV[i]);
    if (v < _uvVmin) _uvVmin = v;
    if (v > _uvVmax) _uvVmax = v;
  }

  // Decide if polygon trimming is appropriate
  _trimEnabled = true;

  // Check for degenerate loops (< 3 vertices → polygon test unusable)
  for (let dl: u32 = 0; dl < _bndLoopCount; dl++) {
    const dn = unchecked(_bndLoopEnd[dl]) - unchecked(_bndLoopStart[dl]);
    if (dn < 3) { _trimEnabled = false; break; }
  }

  // Full-revolution detection: if boundary covers most of the circle,
  // vertices are spread uniformly, or the raw U range is large (>250°),
  // use full 2π range and skip polygon trimming.
  const mag = nSamples > 0
    ? Math.sqrt(sumCos * sumCos + sumSin * sumSin) / <f64>nSamples
    : 0.0;
  const rawURange = _uvUmax - _uvUmin;
  if (nSamples == 0 || mag < 0.1 || rawURange > 1.4 * Math.PI) {
    _uvUmin = -Math.PI;
    _uvUmax = Math.PI;
    _trimEnabled = false;
  }

  // When trimming is disabled but U range is degenerate, expand to full circle
  if (!_trimEnabled && _uvUmax - _uvUmin < 0.01) {
    _uvUmin = -Math.PI;
    _uvUmax = Math.PI;
  }

  // Keep the analytic grid clamped to the exact trim box. Expanding it by
  // even a tiny amount moves seam vertices off their topological edges, so
  // adjacent faces no longer share coordinates after CBREP restore.
  const uMargin: f64 = 0.0;
  const vMargin: f64 = 0.0;
  _uvUmin -= uMargin;
  _uvUmax += uMargin;
  _uvVmin -= vMargin;
  _uvVmax += vMargin;
}

// ─── Internal: point-in-polygon test ─────────────────────────────────

/**
 * Test if a UV point lies inside the face boundary polygon.
 * Uses ray-casting (even-odd rule) across all face loops.
 * Handles multiple loops (outer + inner/holes) via the even-odd rule.
 */
function _pointInsideBoundary(u: f64, v: f64): bool {
  let crossings: i32 = 0;

  for (let l: u32 = 0; l < _bndLoopCount; l++) {
    const start = unchecked(_bndLoopStart[l]);
    const end = unchecked(_bndLoopEnd[l]);
    const n = end - start;
    if (n < 3) continue;

    let j = start + n - 1;
    for (let i: u32 = start; i < end; i++) {
      const vi = unchecked(_bndV[i]);
      const vj = unchecked(_bndV[j]);
      if ((vi > v) != (vj > v)) {
        const ui = unchecked(_bndU[i]);
        const uj = unchecked(_bndU[j]);
        const uCross = ui + (v - vi) / (vj - vi) * (uj - ui);
        if (u < uCross) crossings++;
      }
      j = i;
    }
  }

  return (crossings & 1) != 0;
}

// ─── Internal: surface evaluation ────────────────────────────────────

/**
 * Evaluate surface position and normal at (u, v).
 * surfType: 1=cylinder, 2=cone, 3=sphere, 4=torus
 */
function _evalSurface(
  surfType: i32, u: f64, v: f64,
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  radius: f64, semiAngle: f64,
  majorR: f64, minorR: f64
): void {
  const cosU = Math.cos(u);
  const sinU = Math.sin(u);

  if (surfType == 1) {
    // Cylinder: u=angle, v=height
    _surfX = ox + radius * (rx * cosU + bx * sinU) + v * ax;
    _surfY = oy + radius * (ry * cosU + by * sinU) + v * ay;
    _surfZ = oz + radius * (rz * cosU + bz * sinU) + v * az;
    _surfNX = rx * cosU + bx * sinU;
    _surfNY = ry * cosU + by * sinU;
    _surfNZ = rz * cosU + bz * sinU;
  } else if (surfType == 2) {
    // Cone: u=angle, v=height
    const tanSA = Math.tan(semiAngle);
    const r = radius + v * tanSA;
    _surfX = ox + r * (rx * cosU + bx * sinU) + v * ax;
    _surfY = oy + r * (ry * cosU + by * sinU) + v * ay;
    _surfZ = oz + r * (rz * cosU + bz * sinU) + v * az;
    const cosSA = Math.cos(semiAngle);
    const sinSA = Math.sin(semiAngle);
    _surfNX = (rx * cosU + bx * sinU) * cosSA - ax * sinSA;
    _surfNY = (ry * cosU + by * sinU) * cosSA - ay * sinSA;
    _surfNZ = (rz * cosU + bz * sinU) * cosSA - az * sinSA;
  } else if (surfType == 3) {
    // Sphere: u=longitude around axis, v=latitude from equatorial plane
    const cosV = Math.cos(v);
    const sinV = Math.sin(v);
    // Position on sphere using local frame: refDir (rx), binormal (bx), axis (ax)
    const dirX = rx * cosU + bx * sinU;
    const dirY = ry * cosU + by * sinU;
    const dirZ = rz * cosU + bz * sinU;
    _surfX = ox + radius * (dirX * cosV + ax * sinV);
    _surfY = oy + radius * (dirY * cosV + ay * sinV);
    _surfZ = oz + radius * (dirZ * cosV + az * sinV);
    _surfNX = dirX * cosV + ax * sinV;
    _surfNY = dirY * cosV + ay * sinV;
    _surfNZ = dirZ * cosV + az * sinV;
  } else {
    // Torus: u=major angle, v=minor angle
    const cosV = Math.cos(v);
    const sinV = Math.sin(v);
    const dirX = rx * cosU + bx * sinU;
    const dirY = ry * cosU + by * sinU;
    const dirZ = rz * cosU + bz * sinU;
    const rcX = ox + majorR * dirX;
    const rcY = oy + majorR * dirY;
    const rcZ = oz + majorR * dirZ;
    _surfX = rcX + minorR * (dirX * cosV + ax * sinV);
    _surfY = rcY + minorR * (dirY * cosV + ay * sinV);
    _surfZ = rcZ + minorR * (dirZ * cosV + az * sinV);
    _surfNX = dirX * cosV + ax * sinV;
    _surfNY = dirY * cosV + ay * sinV;
    _surfNZ = dirZ * cosV + az * sinV;
  }
}

// ─── Internal: emit helpers ──────────────────────────────────────────

/** Emit a vertex+normal, return its output index. */
function _emitVert(x: f64, y: f64, z: f64, nx: f64, ny: f64, nz: f64): u32 {
  const id = outVertCount;
  if (id >= MAX_OUT_VERTS) return 0xFFFFFFFF;
  const off = id * 3;
  unchecked(tessOutVerts[off] = x);
  unchecked(tessOutVerts[off + 1] = y);
  unchecked(tessOutVerts[off + 2] = z);
  unchecked(tessOutNormals[off] = nx);
  unchecked(tessOutNormals[off + 1] = ny);
  unchecked(tessOutNormals[off + 2] = nz);
  outVertCount++;
  return id;
}

/** Emit a triangle. Returns 0 on success, -1 on overflow. */
function _emitTri(i0: u32, i1: u32, i2: u32, faceId: u32): i32 {
  if (outTriCount >= MAX_OUT_TRIS) return -1;
  const off = outTriCount * 3;
  unchecked(tessOutIndices[off] = i0);
  unchecked(tessOutIndices[off + 1] = i1);
  unchecked(tessOutIndices[off + 2] = i2);
  unchecked(tessOutFaceMap[outTriCount] = faceId);
  outTriCount++;
  return 0;
}

function _triangleAreaByIds(i0: u32, i1: u32, i2: u32): f64 {
  const o0 = i0 * 3;
  const o1 = i1 * 3;
  const o2 = i2 * 3;
  const ax = unchecked(tessOutVerts[o0]);
  const ay = unchecked(tessOutVerts[o0 + 1]);
  const az = unchecked(tessOutVerts[o0 + 2]);
  const bx = unchecked(tessOutVerts[o1]);
  const by = unchecked(tessOutVerts[o1 + 1]);
  const bz = unchecked(tessOutVerts[o1 + 2]);
  const cx = unchecked(tessOutVerts[o2]);
  const cy = unchecked(tessOutVerts[o2 + 1]);
  const cz = unchecked(tessOutVerts[o2 + 2]);
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
}

function _emitTriSkipDegenerate(i0: u32, i1: u32, i2: u32, faceId: u32): i32 {
  if (_triangleAreaByIds(i0, i1, i2) < 1e-12) return 0;
  return _emitTri(i0, i1, i2, faceId);
}

// ─── Planar face tessellation ────────────────────────────────────────

const INVALID_ID: u32 = 0xFFFFFFFF;

function _singleCircleLoopEdge(loopId: u32): u32 {
  const firstCE = loopGetFirstCoedge(loopId);
  const nextCE = coedgeGetNext(firstCE);
  if (nextCE != firstCE) return INVALID_ID;
  const eid = coedgeGetEdge(firstCE);
  if (edgeGetGeomType(eid) != GEOM_CIRCLE) return INVALID_ID;
  return eid;
}

function _singleSelfLoopEdge(loopId: u32): u32 {
  const firstCE = loopGetFirstCoedge(loopId);
  const nextCE = coedgeGetNext(firstCE);
  if (nextCE != firstCE) return INVALID_ID;
  const eid = coedgeGetEdge(firstCE);
  if (edgeGetStartVertex(eid) != edgeGetEndVertex(eid)) return INVALID_ID;
  return eid;
}

function _circleRadius(edgeId: u32): f64 {
  return geomPoolRead(edgeGetGeomOffset(edgeId) + 9);
}

function _circleCentersCoincident(a: u32, b: u32): bool {
  const ao = edgeGetGeomOffset(a);
  const bo = edgeGetGeomOffset(b);
  const dx = geomPoolRead(ao) - geomPoolRead(bo);
  const dy = geomPoolRead(ao + 1) - geomPoolRead(bo + 1);
  const dz = geomPoolRead(ao + 2) - geomPoolRead(bo + 2);
  return dx * dx + dy * dy + dz * dz < 1e-12;
}

function _emitCircleVertex(edgeId: u32, theta: f64, nx: f64, ny: f64, nz: f64): u32 {
  const off = edgeGetGeomOffset(edgeId);
  const cx = geomPoolRead(off);
  const cy = geomPoolRead(off + 1);
  const cz = geomPoolRead(off + 2);
  const ax = geomPoolRead(off + 3);
  const ay = geomPoolRead(off + 4);
  const az = geomPoolRead(off + 5);
  const rx = geomPoolRead(off + 6);
  const ry = geomPoolRead(off + 7);
  const rz = geomPoolRead(off + 8);
  const r = geomPoolRead(off + 9);
  const bx = ay * rz - az * ry;
  const by = az * rx - ax * rz;
  const bz = ax * ry - ay * rx;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return _emitVert(
    cx + r * (rx * c + bx * s),
    cy + r * (ry * c + by * s),
    cz + r * (rz * c + bz * s),
    nx, ny, nz,
  );
}

const RULED_QUAD_MAX_SAMPLES: i32 = 129;
const ruledQuadRowA = new StaticArray<f64>(RULED_QUAD_MAX_SAMPLES * 3);
const ruledQuadRowB = new StaticArray<f64>(RULED_QUAD_MAX_SAMPLES * 3);
let _rowStatUStart: f64 = 0.0;
let _rowStatUEnd: f64 = 0.0;
let _rowStatVStart: f64 = 0.0;
let _rowStatVEnd: f64 = 0.0;
let _rowStatUMin: f64 = 0.0;
let _rowStatUMax: f64 = 0.0;
let _rowStatVMin: f64 = 0.0;
let _rowStatVMax: f64 = 0.0;
let _rowStatUAvg: f64 = 0.0;
let _rowStatVAvg: f64 = 0.0;
let _ruledStripNormalSign: f64 = 1.0;
let _ruledCandidateReverseB: bool = false;

@inline
function _ruledRowWrite(row: StaticArray<f64>, idx: i32, x: f64, y: f64, z: f64): void {
  const p = idx * 3;
  unchecked(row[p] = x);
  unchecked(row[p + 1] = y);
  unchecked(row[p + 2] = z);
}

@inline
function _ruledRowEmit(row: StaticArray<f64>, idx: i32, nx: f64, ny: f64, nz: f64): u32 {
  const p = idx * 3;
  return _emitVert(
    unchecked(row[p]),
    unchecked(row[p + 1]),
    unchecked(row[p + 2]),
    nx, ny, nz,
  );
}

@inline
function _circleAngleAtVertex(edgeId: u32, vertexId: u32): f64 {
  const off = edgeGetGeomOffset(edgeId);
  const cx = geomPoolRead(off);
  const cy = geomPoolRead(off + 1);
  const cz = geomPoolRead(off + 2);
  const ax = geomPoolRead(off + 3);
  const ay = geomPoolRead(off + 4);
  const az = geomPoolRead(off + 5);
  const rx = geomPoolRead(off + 6);
  const ry = geomPoolRead(off + 7);
  const rz = geomPoolRead(off + 8);
  const px = vertexGetX(vertexId) - cx;
  const py = vertexGetY(vertexId) - cy;
  const pz = vertexGetZ(vertexId) - cz;
  const axial = px * ax + py * ay + pz * az;
  const radX = px - axial * ax;
  const radY = py - axial * ay;
  const radZ = pz - axial * az;
  const bx = ay * rz - az * ry;
  const by = az * rx - ax * rz;
  const bz = ax * ry - ay * rx;
  return Math.atan2(
    radX * bx + radY * by + radZ * bz,
    radX * rx + radY * ry + radZ * rz
  );
}

@inline
function _positiveModulo(value: f64, period: f64): f64 {
  let out = value % period;
  if (out < 0.0) out += period;
  return out;
}

function _directedPeriodicSweep(startAngle: f64, endAngle: f64, curveSameSense: bool, closedLoop: bool = false): f64 {
  const tau = 2.0 * Math.PI;
  if (closedLoop) return tau;
  const delta = endAngle - startAngle;
  if (curveSameSense) {
    const forward = _positiveModulo(delta, tau);
    return forward > 1e-12 ? forward : tau;
  }
  const reverse = _positiveModulo(-delta, tau);
  return reverse > 1e-12 ? -reverse : -tau;
}

@inline
function _wrapPeriodicNear(value: f64, reference: f64): f64 {
  let out = value;
  while (out - reference > Math.PI) out -= 2.0 * Math.PI;
  while (out - reference < -Math.PI) out += 2.0 * Math.PI;
  return out;
}

function _sampleCircleCoedgeRow(edgeId: u32, orient: u8, segs: i32, row: StaticArray<f64>): bool {
  if (segs < 1 || segs + 1 > RULED_QUAD_MAX_SAMPLES) return false;
  const off = edgeGetGeomOffset(edgeId);
  const cx = geomPoolRead(off);
  const cy = geomPoolRead(off + 1);
  const cz = geomPoolRead(off + 2);
  const ax = geomPoolRead(off + 3);
  const ay = geomPoolRead(off + 4);
  const az = geomPoolRead(off + 5);
  const rx = geomPoolRead(off + 6);
  const ry = geomPoolRead(off + 7);
  const rz = geomPoolRead(off + 8);
  const radius = geomPoolRead(off + 9);
  const bx = ay * rz - az * ry;
  const by = az * rx - ax * rz;
  const bz = ax * ry - ay * rx;
  const startV = edgeGetStartVertex(edgeId);
  const endV = edgeGetEndVertex(edgeId);
  const coStart = orient == ORIENT_REVERSED ? endV : startV;
  const coEnd = orient == ORIENT_REVERSED ? startV : endV;
  const startAngle = _circleAngleAtVertex(edgeId, startV);
  const endAngle = _circleAngleAtVertex(edgeId, endV);
  const sweep = _directedPeriodicSweep(startAngle, endAngle, edgeGetCurveSameSense(edgeId) != 0, startV == endV);
  for (let i: i32 = 0; i <= segs; i++) {
    if (i == 0) {
      _ruledRowWrite(row, i, vertexGetX(coStart), vertexGetY(coStart), vertexGetZ(coStart));
      continue;
    }
    if (i == segs) {
      _ruledRowWrite(row, i, vertexGetX(coEnd), vertexGetY(coEnd), vertexGetZ(coEnd));
      continue;
    }
    let frac = <f64>i / <f64>segs;
    if (orient == ORIENT_REVERSED) frac = 1.0 - frac;
    const theta = startAngle + frac * sweep;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    _ruledRowWrite(row, i,
      cx + radius * (rx * c + bx * s),
      cy + radius * (ry * c + by * s),
      cz + radius * (rz * c + bz * s));
  }
  return true;
}

function _sampleLineCoedgeRow(edgeId: u32, orient: u8, segs: i32, row: StaticArray<f64>): bool {
  if (segs < 1 || segs + 1 > RULED_QUAD_MAX_SAMPLES) return false;
  const startV = orient == ORIENT_REVERSED ? edgeGetEndVertex(edgeId) : edgeGetStartVertex(edgeId);
  const endV = orient == ORIENT_REVERSED ? edgeGetStartVertex(edgeId) : edgeGetEndVertex(edgeId);
  const sx = vertexGetX(startV);
  const sy = vertexGetY(startV);
  const sz = vertexGetZ(startV);
  const ex = vertexGetX(endV);
  const ey = vertexGetY(endV);
  const ez = vertexGetZ(endV);
  for (let i: i32 = 0; i <= segs; i++) {
    const t = <f64>i / <f64>segs;
    _ruledRowWrite(row, i,
      sx + (ex - sx) * t,
      sy + (ey - sy) * t,
      sz + (ez - sz) * t);
  }
  return true;
}

function _sampleNurbsCoedgeRow(edgeId: u32, orient: u8, segs: i32, row: StaticArray<f64>): bool {
  if (segs < 1 || segs + 1 > RULED_QUAD_MAX_SAMPLES) return false;
  if (!_loadCurve(edgeGetGeomOffset(edgeId))) return _sampleLineCoedgeRow(edgeId, orient, segs, row);
  const startV = orient == ORIENT_REVERSED ? edgeGetEndVertex(edgeId) : edgeGetStartVertex(edgeId);
  const endV = orient == ORIENT_REVERSED ? edgeGetStartVertex(edgeId) : edgeGetEndVertex(edgeId);
  for (let i: i32 = 0; i <= segs; i++) {
    if (i == 0) {
      _ruledRowWrite(row, i, vertexGetX(startV), vertexGetY(startV), vertexGetZ(startV));
      continue;
    }
    if (i == segs) {
      _ruledRowWrite(row, i, vertexGetX(endV), vertexGetY(endV), vertexGetZ(endV));
      continue;
    }
    let frac = <f64>i / <f64>segs;
    if (orient == ORIENT_REVERSED) frac = 1.0 - frac;
    const t = _crvTmin + frac * (_crvTmax - _crvTmin);
    nurbsCurveEvaluate(_crvDeg, _crvNCtrl, _crvCtrl, _crvKnots, _crvWts, t);
    const rp = getResultPtr();
    _ruledRowWrite(row, i, load<f64>(rp), load<f64>(rp + 8), load<f64>(rp + 16));
  }
  return true;
}

function _sampleCoedgeRow(edgeId: u32, orient: u8, segs: i32, row: StaticArray<f64>): bool {
  const geomType = edgeGetGeomType(edgeId);
  if (geomType == GEOM_CIRCLE) return _sampleCircleCoedgeRow(edgeId, orient, segs, row);
  if (geomType == GEOM_NURBS_CURVE) return _sampleNurbsCoedgeRow(edgeId, orient, segs, row);
  return _sampleLineCoedgeRow(edgeId, orient, segs, row);
}

function _reverseRuledRow(row: StaticArray<f64>, segs: i32): void {
  for (let i: i32 = 0; i <= segs / 2; i++) {
    const j = segs - i;
    const pi = i * 3;
    const pj = j * 3;
    const tx = unchecked(row[pi]);
    const ty = unchecked(row[pi + 1]);
    const tz = unchecked(row[pi + 2]);
    unchecked(row[pi] = unchecked(row[pj]));
    unchecked(row[pi + 1] = unchecked(row[pj + 1]));
    unchecked(row[pi + 2] = unchecked(row[pj + 2]));
    unchecked(row[pj] = tx);
    unchecked(row[pj + 1] = ty);
    unchecked(row[pj + 2] = tz);
  }
}

function _ruledStripNormalAt(idx: i32, segs: i32): void {
  const prev = idx > 0 ? idx - 1 : idx;
  const next = idx < segs ? idx + 1 : idx;
  const pi = idx * 3;
  const pp = prev * 3;
  const pn = next * 3;

  const tx = (unchecked(ruledQuadRowA[pn]) - unchecked(ruledQuadRowA[pp]))
    + (unchecked(ruledQuadRowB[pn]) - unchecked(ruledQuadRowB[pp]));
  const ty = (unchecked(ruledQuadRowA[pn + 1]) - unchecked(ruledQuadRowA[pp + 1]))
    + (unchecked(ruledQuadRowB[pn + 1]) - unchecked(ruledQuadRowB[pp + 1]));
  const tz = (unchecked(ruledQuadRowA[pn + 2]) - unchecked(ruledQuadRowA[pp + 2]))
    + (unchecked(ruledQuadRowB[pn + 2]) - unchecked(ruledQuadRowB[pp + 2]));
  const ax = unchecked(ruledQuadRowB[pi]) - unchecked(ruledQuadRowA[pi]);
  const ay = unchecked(ruledQuadRowB[pi + 1]) - unchecked(ruledQuadRowA[pi + 1]);
  const az = unchecked(ruledQuadRowB[pi + 2]) - unchecked(ruledQuadRowA[pi + 2]);

  let nx = ty * az - tz * ay;
  let ny = tz * ax - tx * az;
  let nz = tx * ay - ty * ax;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-14) {
    nx /= len;
    ny /= len;
    nz /= len;
  } else {
    nx = 0.0;
    ny = 0.0;
    nz = 1.0;
  }
  _surfNX = nx * _ruledStripNormalSign;
  _surfNY = ny * _ruledStripNormalSign;
  _surfNZ = nz * _ruledStripNormalSign;
}

function _emitRuledStripVertex(row: StaticArray<f64>, idx: i32, segs: i32): u32 {
  _ruledStripNormalAt(idx, segs);
  return _ruledRowEmit(row, idx, _surfNX, _surfNY, _surfNZ);
}

function _emitTriTowardVertexNormals(i0: u32, i1: u32, i2: u32, faceId: u32): i32 {
  const a = i0 * 3;
  const b = i1 * 3;
  const c = i2 * 3;
  const nx = unchecked(tessOutNormals[a]) + unchecked(tessOutNormals[b]) + unchecked(tessOutNormals[c]);
  const ny = unchecked(tessOutNormals[a + 1]) + unchecked(tessOutNormals[b + 1]) + unchecked(tessOutNormals[c + 1]);
  const nz = unchecked(tessOutNormals[a + 2]) + unchecked(tessOutNormals[b + 2]) + unchecked(tessOutNormals[c + 2]);
  if (nx * nx + ny * ny + nz * nz < 1e-14) return _emitTri(i0, i1, i2, faceId);
  return _emitPlaneTriOriented(i0, i1, i2, nx, ny, nz, faceId);
}

const ROLLING_MAX_ROWS: i32 = 512;
const ROLLING_MAX_COLS: i32 = 129;
const rollingRowStarts = new StaticArray<u32>(ROLLING_MAX_ROWS);
const rollingRowCounts = new StaticArray<i32>(ROLLING_MAX_ROWS);

function _rollingPoint(off: u32, base: i32, idx: i32, component: i32): f64 {
  return geomPoolRead(off + 3 + <u32>(base + idx * 3 + component));
}

function _rollingRailBase(nRows: i32, rail: i32): i32 {
  if (rail == 0) return 0;
  if (rail == 1) return nRows * 3;
  return nRows * 6;
}

function _rollingStartBase(nRows: i32): i32 {
  return nRows * 9;
}

function _rollingEndBase(nRows: i32, startCount: i32): i32 {
  return nRows * 9 + startCount * 3;
}

function _emitRollingPoint(x: f64, y: f64, z: f64, cx: f64, cy: f64, cz: f64): u32 {
  let nx = x - cx;
  let ny = y - cy;
  let nz = z - cz;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-12) {
    nx /= len;
    ny /= len;
    nz /= len;
  } else {
    nx = 0.0;
    ny = 0.0;
    nz = 1.0;
  }
  return _emitVert(x, y, z, nx, ny, nz);
}

function _emitRollingStoredPoint(off: u32, base: i32, idx: i32, cx: f64, cy: f64, cz: f64): u32 {
  return _emitRollingPoint(
    _rollingPoint(off, base, idx, 0),
    _rollingPoint(off, base, idx, 1),
    _rollingPoint(off, base, idx, 2),
    cx, cy, cz,
  );
}

function _emitRollingCrossSectionPoint(off: u32, row: i32, nRows: i32, t: f64): u32 {
  const rail0Base = _rollingRailBase(nRows, 0);
  const rail1Base = _rollingRailBase(nRows, 1);
  const centerBase = _rollingRailBase(nRows, 2);
  const ax = _rollingPoint(off, rail0Base, row, 0);
  const ay = _rollingPoint(off, rail0Base, row, 1);
  const az = _rollingPoint(off, rail0Base, row, 2);
  const bx = _rollingPoint(off, rail1Base, row, 0);
  const by = _rollingPoint(off, rail1Base, row, 1);
  const bz = _rollingPoint(off, rail1Base, row, 2);
  const cx = _rollingPoint(off, centerBase, row, 0);
  const cy = _rollingPoint(off, centerBase, row, 1);
  const cz = _rollingPoint(off, centerBase, row, 2);

  if (t <= 1e-12) return _emitRollingPoint(ax, ay, az, cx, cy, cz);
  if (1.0 - t <= 1e-12) return _emitRollingPoint(bx, by, bz, cx, cy, cz);

  let vax = ax - cx;
  let vay = ay - cy;
  let vaz = az - cz;
  let vbx = bx - cx;
  let vby = by - cy;
  let vbz = bz - cz;
  const ra = Math.sqrt(vax * vax + vay * vay + vaz * vaz);
  const rb = Math.sqrt(vbx * vbx + vby * vby + vbz * vbz);
  const radius = ra > rb ? ra : rb;
  if (ra > 1e-12) { vax /= ra; vay /= ra; vaz /= ra; }
  if (rb > 1e-12) { vbx /= rb; vby /= rb; vbz /= rb; }
  let dot = vax * vbx + vay * vby + vaz * vbz;
  if (dot < -1.0) dot = -1.0;
  if (dot > 1.0) dot = 1.0;
  const angle = Math.acos(dot);
  if (radius > 1e-12 && angle > 1e-8 && angle < Math.PI - 1e-8) {
    const sinAngle = Math.sin(angle);
    const w0 = Math.sin((1.0 - t) * angle) / sinAngle;
    const w1 = Math.sin(t * angle) / sinAngle;
    let dx = vax * w0 + vbx * w1;
    let dy = vay * w0 + vby * w1;
    let dz = vaz * w0 + vbz * w1;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len > 1e-12) {
      dx /= len;
      dy /= len;
      dz /= len;
      return _emitRollingPoint(cx + dx * radius, cy + dy * radius, cz + dz * radius, cx, cy, cz);
    }
  }

  return _emitRollingPoint(
    ax + (bx - ax) * t,
    ay + (by - ay) * t,
    az + (bz - az) * t,
    cx, cy, cz,
  );
}

function _emitRollingRow(off: u32, row: i32, nRows: i32, startCount: i32, endCount: i32, interiorCount: i32): i32 {
  const centerBase = _rollingRailBase(nRows, 2);
  const cx = _rollingPoint(off, centerBase, row, 0);
  const cy = _rollingPoint(off, centerBase, row, 1);
  const cz = _rollingPoint(off, centerBase, row, 2);

  let count = interiorCount;
  let sampleBase = -1;
  if (row == 0 && startCount > 2) {
    count = startCount;
    sampleBase = _rollingStartBase(nRows);
  } else if (row == nRows - 1 && endCount > 2) {
    count = endCount;
    sampleBase = _rollingEndBase(nRows, startCount);
  } else if (row == 0 && startCount == 2) {
    count = 2;
  } else if (row == nRows - 1 && endCount == 2) {
    count = 2;
  }

  if (count < 2 || count > ROLLING_MAX_COLS) return -1;
  unchecked(rollingRowStarts[row] = outVertCount);
  unchecked(rollingRowCounts[row] = count);

  if (sampleBase >= 0) {
    for (let i: i32 = 0; i < count; i++) {
      if (_emitRollingStoredPoint(off, sampleBase, i, cx, cy, cz) == INVALID_ID) return -1;
    }
    return count;
  }

  for (let i: i32 = 0; i < count; i++) {
    const t = count == 1 ? 0.0 : <f64>i / <f64>(count - 1);
    if (_emitRollingCrossSectionPoint(off, row, nRows, t) == INVALID_ID) return -1;
  }
  return count;
}

function _rollingRowId(row: i32, col: i32): u32 {
  return unchecked(rollingRowStarts[row]) + <u32>col;
}

function _emitRollingBand(rowA: i32, rowB: i32, faceId: u32): i32 {
  const countA = unchecked(rollingRowCounts[rowA]);
  const countB = unchecked(rollingRowCounts[rowB]);
  const startTriCount = outTriCount;
  if (countA == countB) {
    for (let j: i32 = 0; j < countA - 1; j++) {
      const p00 = _rollingRowId(rowA, j);
      const p01 = _rollingRowId(rowA, j + 1);
      const p10 = _rollingRowId(rowB, j);
      const p11 = _rollingRowId(rowB, j + 1);
      if (_emitTriSkipDegenerate(p00, p10, p11, faceId) < 0) return -1;
      if (_emitTriSkipDegenerate(p00, p11, p01, faceId) < 0) return -1;
    }
    return <i32>(outTriCount - startTriCount);
  }
  if (countA > 2 && countB == 2) {
    const b0 = _rollingRowId(rowB, 0);
    const b1 = _rollingRowId(rowB, 1);
    for (let j: i32 = 0; j < countA - 1; j++) {
      if (_emitTriSkipDegenerate(b0, _rollingRowId(rowA, j), _rollingRowId(rowA, j + 1), faceId) < 0) return -1;
    }
    if (_emitTriSkipDegenerate(b0, _rollingRowId(rowA, countA - 1), b1, faceId) < 0) return -1;
    return <i32>(outTriCount - startTriCount);
  }
  if (countA == 2 && countB > 2) {
    const a0 = _rollingRowId(rowA, 0);
    const a1 = _rollingRowId(rowA, 1);
    if (_emitTriSkipDegenerate(a0, a1, _rollingRowId(rowB, countB - 1), faceId) < 0) return -1;
    for (let j: i32 = countB - 1; j > 0; j--) {
      if (_emitTriSkipDegenerate(a0, _rollingRowId(rowB, j), _rollingRowId(rowB, j - 1), faceId) < 0) return -1;
    }
    return <i32>(outTriCount - startTriCount);
  }

  const count = countA < countB ? countA : countB;
  for (let j: i32 = 0; j < count - 1; j++) {
    if (_emitTriSkipDegenerate(_rollingRowId(rowA, j), _rollingRowId(rowB, j), _rollingRowId(rowB, j + 1), faceId) < 0) return -1;
    if (_emitTriSkipDegenerate(_rollingRowId(rowA, j), _rollingRowId(rowB, j + 1), _rollingRowId(rowA, j + 1), faceId) < 0) return -1;
  }
  return <i32>(outTriCount - startTriCount);
}

function _tessRollingFilletFace(faceId: u32): i32 {
  const off = faceGetGeomOffset(faceId);
  const nRows = <i32>geomPoolRead(off);
  const startCount = <i32>geomPoolRead(off + 1);
  const endCount = <i32>geomPoolRead(off + 2);
  if (nRows < 2 || nRows > ROLLING_MAX_ROWS) return -2;
  if (startCount < 2 || endCount < 2 || startCount > ROLLING_MAX_COLS || endCount > ROLLING_MAX_COLS) return -2;
  const interiorCount = startCount > endCount ? startCount : endCount;
  if (outVertCount + <u32>(nRows * interiorCount) > MAX_OUT_VERTS) return -1;

  const startTriCount = outTriCount;

  for (let i: i32 = 0; i < nRows; i++) {
    if (_emitRollingRow(off, i, nRows, startCount, endCount, interiorCount) < 0) return -1;
  }
  for (let i: i32 = 0; i < nRows - 1; i++) {
    if (_emitRollingBand(i, i + 1, faceId) < 0) return -1;
  }

  return <i32>(outTriCount - startTriCount);
}

function _boundaryFanPoint(off: u32, idx: i32, component: i32): f64 {
  return geomPoolRead(off + 1 + <u32>(idx * 3 + component));
}

function _setProjectionFrameFromBoundaryFan(off: u32, nPts: i32): bool {
  if (nPts < 3) return false;
  _planeOx = _boundaryFanPoint(off, 0, 0);
  _planeOy = _boundaryFanPoint(off, 0, 1);
  _planeOz = _boundaryFanPoint(off, 0, 2);

  let nx: f64 = 0.0;
  let ny: f64 = 0.0;
  let nz: f64 = 0.0;
  for (let i: i32 = 0; i < nPts; i++) {
    const j = i == nPts - 1 ? 0 : i + 1;
    const x0 = _boundaryFanPoint(off, i, 0);
    const y0 = _boundaryFanPoint(off, i, 1);
    const z0 = _boundaryFanPoint(off, i, 2);
    const x1 = _boundaryFanPoint(off, j, 0);
    const y1 = _boundaryFanPoint(off, j, 1);
    const z1 = _boundaryFanPoint(off, j, 2);
    nx += (y0 - y1) * (z0 + z1);
    ny += (z0 - z1) * (x0 + x1);
    nz += (x0 - x1) * (y0 + y1);
  }

  let nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (nLen < 1e-12) {
    const x0 = _boundaryFanPoint(off, 0, 0);
    const y0 = _boundaryFanPoint(off, 0, 1);
    const z0 = _boundaryFanPoint(off, 0, 2);
    const x1 = _boundaryFanPoint(off, 1, 0);
    const y1 = _boundaryFanPoint(off, 1, 1);
    const z1 = _boundaryFanPoint(off, 1, 2);
    for (let i: i32 = 2; i < nPts; i++) {
      const ax = x1 - x0;
      const ay = y1 - y0;
      const az = z1 - z0;
      const bx = _boundaryFanPoint(off, i, 0) - x0;
      const by = _boundaryFanPoint(off, i, 1) - y0;
      const bz = _boundaryFanPoint(off, i, 2) - z0;
      nx = ay * bz - az * by;
      ny = az * bx - ax * bz;
      nz = ax * by - ay * bx;
      nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nLen >= 1e-12) break;
    }
  }
  if (nLen < 1e-12) return false;
  nx /= nLen;
  ny /= nLen;
  nz /= nLen;
  _planeNx = nx;
  _planeNy = ny;
  _planeNz = nz;

  let rx: f64 = 0.0;
  let ry: f64 = 0.0;
  let rz: f64 = 0.0;
  for (let i: i32 = 0; i < nPts; i++) {
    const j = i == nPts - 1 ? 0 : i + 1;
    rx = _boundaryFanPoint(off, j, 0) - _boundaryFanPoint(off, i, 0);
    ry = _boundaryFanPoint(off, j, 1) - _boundaryFanPoint(off, i, 1);
    rz = _boundaryFanPoint(off, j, 2) - _boundaryFanPoint(off, i, 2);
    const dot = rx * nx + ry * ny + rz * nz;
    rx -= dot * nx;
    ry -= dot * ny;
    rz -= dot * nz;
    if (Math.sqrt(rx * rx + ry * ry + rz * rz) > 1e-12) break;
  }

  let rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (rLen < 1e-12) {
    if (Math.abs(nx) <= Math.abs(ny) && Math.abs(nx) <= Math.abs(nz)) { rx = 1.0; ry = 0.0; rz = 0.0; }
    else if (Math.abs(ny) <= Math.abs(nz)) { rx = 0.0; ry = 1.0; rz = 0.0; }
    else { rx = 0.0; ry = 0.0; rz = 1.0; }
    const dot = rx * nx + ry * ny + rz * nz;
    rx -= dot * nx;
    ry -= dot * ny;
    rz -= dot * nz;
    rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
  }
  if (rLen < 1e-12) return false;
  _planeRx = rx / rLen;
  _planeRy = ry / rLen;
  _planeRz = rz / rLen;

  _planeYx = ny * _planeRz - nz * _planeRy;
  _planeYy = nz * _planeRx - nx * _planeRz;
  _planeYz = nx * _planeRy - ny * _planeRx;
  const yLen = Math.sqrt(_planeYx * _planeYx + _planeYy * _planeYy + _planeYz * _planeYz);
  if (yLen <= 1e-12) return false;
  _planeYx /= yLen;
  _planeYy /= yLen;
  _planeYz /= yLen;
  return true;
}

function _tessBoundaryFanEarClippedFace(faceId: u32, off: u32, nPts: i32): i32 {
  if (nPts < 3 || <u32>nPts > MAX_PLANAR_PTS) return -2;
  if (!_setProjectionFrameFromBoundaryFan(off, nPts)) return -2;
  _planarPointCount = 0;
  _planarLoopCount = 0;
  _planarPathCount = 0;
  for (let i: i32 = 0; i < nPts; i++) {
    if (!_planarAppendPoint(
      _boundaryFanPoint(off, i, 0),
      _boundaryFanPoint(off, i, 1),
      _boundaryFanPoint(off, i, 2),
      0,
    )) return -2;
  }
  if (_planarPointCount < 3) return -2;
  unchecked(_planarLoopStart[0] = 0);
  unchecked(_planarLoopEnd[0] = _planarPointCount);
  _planarLoopCount = 1;
  if (!_planarBuildBridgedPath()) return -2;
  if (!_buildTrimBaseTrianglesFromPath()) return -2;

  let nx = _planeNx;
  let ny = _planeNy;
  let nz = _planeNz;
  if (faceGetOrient(faceId) == ORIENT_REVERSED) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }

  const startTriCount = outTriCount;
  for (let i: u32 = 0; i < _planarPointCount; i++) {
    const id = _emitVert(
      unchecked(_planarX[i]),
      unchecked(_planarY[i]),
      unchecked(_planarZ[i]),
      nx, ny, nz,
    );
    if (id == INVALID_ID) return -1;
    unchecked(_planarOutVert[i] = id);
  }
  for (let i: u32 = 0; i < _trimTriCount; i++) {
    const a = unchecked(_planarOutVert[unchecked(_trimTriA[i])]);
    const b = unchecked(_planarOutVert[unchecked(_trimTriB[i])]);
    const c = unchecked(_planarOutVert[unchecked(_trimTriC[i])]);
    if (_emitPlaneTriOriented(a, b, c, nx, ny, nz, faceId) < 0) return -1;
  }
  return <i32>(outTriCount - startTriCount);
}

function _tessBoundaryFanFace(faceId: u32): i32 {
  const off = faceGetGeomOffset(faceId);
  const nPts = <i32>geomPoolRead(off);
  if (nPts < 3) return -2;
  const clipped = _tessBoundaryFanEarClippedFace(faceId, off, nPts);
  if (clipped >= 0) return clipped;
  if (outVertCount + <u32>(nPts + 1) > MAX_OUT_VERTS) return -1;

  let cx: f64 = 0.0;
  let cy: f64 = 0.0;
  let cz: f64 = 0.0;
  let nx: f64 = 0.0;
  let ny: f64 = 0.0;
  let nz: f64 = 0.0;

  for (let i: i32 = 0; i < nPts; i++) {
    const j = i == nPts - 1 ? 0 : i + 1;
    const x0 = _boundaryFanPoint(off, i, 0);
    const y0 = _boundaryFanPoint(off, i, 1);
    const z0 = _boundaryFanPoint(off, i, 2);
    const x1 = _boundaryFanPoint(off, j, 0);
    const y1 = _boundaryFanPoint(off, j, 1);
    const z1 = _boundaryFanPoint(off, j, 2);
    cx += x0;
    cy += y0;
    cz += z0;
    nx += (y0 - y1) * (z0 + z1);
    ny += (z0 - z1) * (x0 + x1);
    nz += (x0 - x1) * (y0 + y1);
  }

  const invCount = 1.0 / <f64>nPts;
  cx *= invCount;
  cy *= invCount;
  cz *= invCount;
  let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-12) {
    nx /= len;
    ny /= len;
    nz /= len;
  } else {
    nx = 0.0;
    ny = 0.0;
    nz = 1.0;
  }
  if (faceGetOrient(faceId) == ORIENT_REVERSED) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }

  const startTriCount = outTriCount;
  const centerId = _emitVert(cx, cy, cz, nx, ny, nz);
  if (centerId == INVALID_ID) return -1;
  const firstBoundaryId = outVertCount;
  for (let i: i32 = 0; i < nPts; i++) {
    if (_emitVert(
      _boundaryFanPoint(off, i, 0),
      _boundaryFanPoint(off, i, 1),
      _boundaryFanPoint(off, i, 2),
      nx, ny, nz,
    ) == INVALID_ID) return -1;
  }

  for (let i: i32 = 0; i < nPts; i++) {
    const a = firstBoundaryId + <u32>i;
    const b = firstBoundaryId + <u32>(i == nPts - 1 ? 0 : i + 1);
    if (_emitPlaneTriOriented(centerId, a, b, nx, ny, nz, faceId) < 0) return -1;
  }

  return <i32>(outTriCount - startTriCount);
}

function _calibrateRuledStripNormalSign(
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
  reversed: bool,
  segs: i32,
): void {
  _ruledStripNormalSign = 1.0;
  const midIndex = segs / 2;
  _ruledStripNormalAt(midIndex, segs);
  const tx = _surfNX;
  const ty = _surfNY;
  const tz = _surfNZ;
  const uMin = unchecked(knotsU[degU]);
  const uMax = unchecked(knotsU[numCtrlU]);
  const vMin = unchecked(knotsV[degV]);
  const vMax = unchecked(knotsV[numCtrlV]);
  nurbsSurfaceNormal(
    degU, degV, numCtrlU, numCtrlV,
    ctrlPts, knotsU, knotsV, weights,
    0.5 * (uMin + uMax),
    0.5 * (vMin + vMax),
  );
  const rp = getResultPtr();
  let nx = load<f64>(rp + 24);
  let ny = load<f64>(rp + 32);
  let nz = load<f64>(rp + 40);
  if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
  if (tx * nx + ty * ny + tz * nz < 0.0) _ruledStripNormalSign = -1.0;
}

function _measureProjectedRow(row: StaticArray<f64>, segs: i32): void {
  const count = segs + 1;
  let prevU: f64 = 0.0;
  let prevV: f64 = 0.0;
  let sumU: f64 = 0.0;
  let sumV: f64 = 0.0;
  for (let i: i32 = 0; i < count; i++) {
    const p = i * 3;
    _projectPoint(
      unchecked(row[p]),
      unchecked(row[p + 1]),
      unchecked(row[p + 2])
    );
    let u = _projU;
    let v = _projV;
    if (i > 0) {
      u = _wrapPeriodicNear(u, prevU);
      v = _wrapPeriodicNear(v, prevV);
    } else {
      _rowStatUStart = u;
      _rowStatVStart = v;
      _rowStatUMin = u;
      _rowStatUMax = u;
      _rowStatVMin = v;
      _rowStatVMax = v;
    }
    prevU = u;
    prevV = v;
    if (u < _rowStatUMin) _rowStatUMin = u;
    if (u > _rowStatUMax) _rowStatUMax = u;
    if (v < _rowStatVMin) _rowStatVMin = v;
    if (v > _rowStatVMax) _rowStatVMax = v;
    sumU += u;
    sumV += v;
    if (i == count - 1) {
      _rowStatUEnd = u;
      _rowStatVEnd = v;
    }
  }
  _rowStatUAvg = sumU / <f64>count;
  _rowStatVAvg = sumV / <f64>count;
}

function _emitAnalyticTriOriented(
  i0: u32, i1: u32, i2: u32,
  faceId: u32, reversed: bool,
  surfType: i32,
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  radius: f64, semiAngle: f64,
  majorR: f64, minorR: f64
): i32 {
  const a = i0 * 3;
  const b = i1 * 3;
  const c = i2 * 3;
  const x0 = unchecked(tessOutVerts[a]);
  const y0 = unchecked(tessOutVerts[a + 1]);
  const z0 = unchecked(tessOutVerts[a + 2]);
  const x1 = unchecked(tessOutVerts[b]);
  const y1 = unchecked(tessOutVerts[b + 1]);
  const z1 = unchecked(tessOutVerts[b + 2]);
  const x2 = unchecked(tessOutVerts[c]);
  const y2 = unchecked(tessOutVerts[c + 1]);
  const z2 = unchecked(tessOutVerts[c + 2]);

  const abx = x1 - x0;
  const aby = y1 - y0;
  const abz = z1 - z0;
  const acx = x2 - x0;
  const acy = y2 - y0;
  const acz = z2 - z0;
  const tx = aby * acz - abz * acy;
  const ty = abz * acx - abx * acz;
  const tz = abx * acy - aby * acx;

  _projectPoint((x0 + x1 + x2) / 3.0, (y0 + y1 + y2) / 3.0, (z0 + z1 + z2) / 3.0);
  _evalSurface(surfType, _projU, _projV,
    ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
    radius, semiAngle, majorR, minorR);
  let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
  if (reversed) { nx = -nx; ny = -ny; nz = -nz; }

  return tx * nx + ty * ny + tz * nz >= 0.0
    ? _emitTri(i0, i1, i2, faceId)
    : _emitTri(i0, i2, i1, faceId);
}

function _scoreAnalyticRuledPair(
  edgeA: u32,
  orientA: u8,
  edgeB: u32,
  orientB: u8,
  segs: i32,
  surfType: i32,
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  radius: f64, semiAngle: f64,
  majorR: f64, minorR: f64
): f64 {
  _ruledCandidateReverseB = false;
  if (!_sampleCoedgeRow(edgeA, orientA, segs, ruledQuadRowA)) return Infinity;
  if (!_sampleCoedgeRow(edgeB, orientB, segs, ruledQuadRowB)) return Infinity;

  const end = segs * 3;
  const directDx0 = unchecked(ruledQuadRowA[0]) - unchecked(ruledQuadRowB[0]);
  const directDy0 = unchecked(ruledQuadRowA[1]) - unchecked(ruledQuadRowB[1]);
  const directDz0 = unchecked(ruledQuadRowA[2]) - unchecked(ruledQuadRowB[2]);
  const directDx1 = unchecked(ruledQuadRowA[end]) - unchecked(ruledQuadRowB[end]);
  const directDy1 = unchecked(ruledQuadRowA[end + 1]) - unchecked(ruledQuadRowB[end + 1]);
  const directDz1 = unchecked(ruledQuadRowA[end + 2]) - unchecked(ruledQuadRowB[end + 2]);
  const reverseDx0 = unchecked(ruledQuadRowA[0]) - unchecked(ruledQuadRowB[end]);
  const reverseDy0 = unchecked(ruledQuadRowA[1]) - unchecked(ruledQuadRowB[end + 1]);
  const reverseDz0 = unchecked(ruledQuadRowA[2]) - unchecked(ruledQuadRowB[end + 2]);
  const reverseDx1 = unchecked(ruledQuadRowA[end]) - unchecked(ruledQuadRowB[0]);
  const reverseDy1 = unchecked(ruledQuadRowA[end + 1]) - unchecked(ruledQuadRowB[1]);
  const reverseDz1 = unchecked(ruledQuadRowA[end + 2]) - unchecked(ruledQuadRowB[2]);
  const directScore = directDx0 * directDx0 + directDy0 * directDy0 + directDz0 * directDz0
    + directDx1 * directDx1 + directDy1 * directDy1 + directDz1 * directDz1;
  const reverseScore = reverseDx0 * reverseDx0 + reverseDy0 * reverseDy0 + reverseDz0 * reverseDz0
    + reverseDx1 * reverseDx1 + reverseDy1 * reverseDy1 + reverseDz1 * reverseDz1;
  if (reverseScore < directScore) {
    _reverseRuledRow(ruledQuadRowB, segs);
    _ruledCandidateReverseB = true;
  }

  let maxSurfaceError2: f64 = 0.0;
  let maxRailGap2: f64 = 0.0;
  for (let i: i32 = 0; i <= segs; i++) {
    const p = i * 3;
    const axp = unchecked(ruledQuadRowA[p]);
    const ayp = unchecked(ruledQuadRowA[p + 1]);
    const azp = unchecked(ruledQuadRowA[p + 2]);
    const bxp = unchecked(ruledQuadRowB[p]);
    const byp = unchecked(ruledQuadRowB[p + 1]);
    const bzp = unchecked(ruledQuadRowB[p + 2]);
    const gx = bxp - axp;
    const gy = byp - ayp;
    const gz = bzp - azp;
    const gap2 = gx * gx + gy * gy + gz * gz;
    if (gap2 > maxRailGap2) maxRailGap2 = gap2;

    const mx = 0.5 * (axp + bxp);
    const my = 0.5 * (ayp + byp);
    const mz = 0.5 * (azp + bzp);
    _projectPoint(mx, my, mz);
    _evalSurface(surfType, _projU, _projV,
      ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, semiAngle, majorR, minorR);
    const dx = mx - _surfX;
    const dy = my - _surfY;
    const dz = mz - _surfZ;
    const err2 = dx * dx + dy * dy + dz * dz;
    if (err2 > maxSurfaceError2) maxSurfaceError2 = err2;
  }

  if (maxRailGap2 < 1e-20) return Infinity;
  return maxSurfaceError2;
}

function _tessAnalyticRuledBoundaryQuadFace(
  faceId: u32, reversed: bool,
  segsU: i32,
  surfType: i32,
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  radius: f64, semiAngle: f64,
  majorR: f64, minorR: f64
): i32 {
  if (faceGetLoopCount(faceId) != 1) return -2;
  const loopId = faceGetFirstLoop(faceId);
  const ce0 = loopGetFirstCoedge(loopId);
  const ce1 = coedgeGetNext(ce0);
  const ce2 = coedgeGetNext(ce1);
  const ce3 = coedgeGetNext(ce2);
  if (coedgeGetNext(ce3) != ce0) return -2;

  const edge0 = coedgeGetEdge(ce0);
  const edge1 = coedgeGetEdge(ce1);
  const edge2 = coedgeGetEdge(ce2);
  const edge3 = coedgeGetEdge(ce3);
  if (edgeGetStartVertex(edge0) == edgeGetEndVertex(edge0)) return -2;
  if (edgeGetStartVertex(edge1) == edgeGetEndVertex(edge1)) return -2;
  if (edgeGetStartVertex(edge2) == edgeGetEndVertex(edge2)) return -2;
  if (edgeGetStartVertex(edge3) == edgeGetEndVertex(edge3)) return -2;

  let segs02 = segsU > 0 ? segsU : DEFAULT_SEGS;
  const min02a = _edgeRowMinSegments(edgeGetGeomType(edge0));
  const min02b = _edgeRowMinSegments(edgeGetGeomType(edge2));
  if (segs02 < min02a) segs02 = min02a;
  if (segs02 < min02b) segs02 = min02b;
  if (segs02 + 1 > RULED_QUAD_MAX_SAMPLES) segs02 = RULED_QUAD_MAX_SAMPLES - 1;

  let bestPair: i32 = -1;
  let bestSegs: i32 = 0;
  let bestReverseB: bool = false;
  let bestScore = _scoreAnalyticRuledPair(edge0, coedgeGetOrient(ce0), edge2, coedgeGetOrient(ce2), segs02,
    surfType, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, semiAngle, majorR, minorR);
  if (bestScore < Infinity) {
    bestPair = 0;
    bestSegs = segs02;
    bestReverseB = _ruledCandidateReverseB;
  }

  let segs13 = segsU > 0 ? segsU : DEFAULT_SEGS;
  const min13a = _edgeRowMinSegments(edgeGetGeomType(edge1));
  const min13b = _edgeRowMinSegments(edgeGetGeomType(edge3));
  if (segs13 < min13a) segs13 = min13a;
  if (segs13 < min13b) segs13 = min13b;
  if (segs13 + 1 > RULED_QUAD_MAX_SAMPLES) segs13 = RULED_QUAD_MAX_SAMPLES - 1;

  const score13 = _scoreAnalyticRuledPair(edge1, coedgeGetOrient(ce1), edge3, coedgeGetOrient(ce3), segs13,
    surfType, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, semiAngle, majorR, minorR);
  if (score13 < bestScore) {
    bestScore = score13;
    bestPair = 1;
    bestSegs = segs13;
    bestReverseB = _ruledCandidateReverseB;
  }

  if (bestPair < 0 || bestScore > 1e-4) return -2;

  let railAEdge = edge0;
  let railBEdge = edge2;
  let railAOrient = coedgeGetOrient(ce0);
  let railBOrient = coedgeGetOrient(ce2);
  if (bestPair == 1) {
    railAEdge = edge1;
    railBEdge = edge3;
    railAOrient = coedgeGetOrient(ce1);
    railBOrient = coedgeGetOrient(ce3);
  }

  if (!_sampleCoedgeRow(railAEdge, railAOrient, bestSegs, ruledQuadRowA)) return -2;
  if (!_sampleCoedgeRow(railBEdge, railBOrient, bestSegs, ruledQuadRowB)) return -2;
  if (bestReverseB) _reverseRuledRow(ruledQuadRowB, bestSegs);

  const baseA = outVertCount;
  for (let i: i32 = 0; i <= bestSegs; i++) {
    const p = i * 3;
    _projectPoint(
      unchecked(ruledQuadRowA[p]),
      unchecked(ruledQuadRowA[p + 1]),
      unchecked(ruledQuadRowA[p + 2])
    );
    _evalSurface(surfType, _projU, _projV,
      ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, semiAngle, majorR, minorR);
    let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
    if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
    if (_ruledRowEmit(ruledQuadRowA, i, nx, ny, nz) == INVALID_ID) return -1;
  }

  const baseB = outVertCount;
  for (let i: i32 = 0; i <= bestSegs; i++) {
    const p = i * 3;
    _projectPoint(
      unchecked(ruledQuadRowB[p]),
      unchecked(ruledQuadRowB[p + 1]),
      unchecked(ruledQuadRowB[p + 2])
    );
    _evalSurface(surfType, _projU, _projV,
      ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, semiAngle, majorR, minorR);
    let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
    if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
    if (_ruledRowEmit(ruledQuadRowB, i, nx, ny, nz) == INVALID_ID) return -1;
  }

  let triCount: i32 = 0;
  for (let i: i32 = 0; i < bestSegs; i++) {
    const a0 = baseA + <u32>i;
    const a1 = baseA + <u32>(i + 1);
    const b0 = baseB + <u32>i;
    const b1 = baseB + <u32>(i + 1);
    if (_emitAnalyticTriOriented(a0, a1, b0, faceId, reversed,
      surfType, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, semiAngle, majorR, minorR) < 0) return -1;
    if (_emitAnalyticTriOriented(b0, a1, b1, faceId, reversed,
      surfType, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, semiAngle, majorR, minorR) < 0) return -1;
    triCount += 2;
  }

  return triCount;
}

function _tessRuledCircleQuadFace(
  faceId: u32, reversed: bool,
  segsU: i32,
  surfType: i32,
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  radius: f64, semiAngle: f64,
  majorR: f64, minorR: f64
): i32 {
  if (faceGetLoopCount(faceId) != 1) return -2;
  const loopId = faceGetFirstLoop(faceId);
  const ce0 = loopGetFirstCoedge(loopId);
  const ce1 = coedgeGetNext(ce0);
  const ce2 = coedgeGetNext(ce1);
  const ce3 = coedgeGetNext(ce2);
  if (coedgeGetNext(ce3) != ce0) return -2;

  const edge0 = coedgeGetEdge(ce0);
  const edge1 = coedgeGetEdge(ce1);
  const edge2 = coedgeGetEdge(ce2);
  const edge3 = coedgeGetEdge(ce3);
  if (edgeGetStartVertex(edge0) == edgeGetEndVertex(edge0)) return -2;
  if (edgeGetStartVertex(edge1) == edgeGetEndVertex(edge1)) return -2;
  if (edgeGetStartVertex(edge2) == edgeGetEndVertex(edge2)) return -2;
  if (edgeGetStartVertex(edge3) == edgeGetEndVertex(edge3)) return -2;

  const type0 = edgeGetGeomType(edge0);
  const type1 = edgeGetGeomType(edge1);
  const type2 = edgeGetGeomType(edge2);
  const type3 = edgeGetGeomType(edge3);
  const line0 = type0 == GEOM_LINE;
  const line1 = type1 == GEOM_LINE;
  const line2 = type2 == GEOM_LINE;
  const line3 = type3 == GEOM_LINE;
  const circle0 = type0 == GEOM_CIRCLE;
  const circle1 = type1 == GEOM_CIRCLE;
  const circle2 = type2 == GEOM_CIRCLE;
  const circle3 = type3 == GEOM_CIRCLE;
  const lineCount = (line0 ? 1 : 0) + (line1 ? 1 : 0) + (line2 ? 1 : 0) + (line3 ? 1 : 0);
  const circleCount = (circle0 ? 1 : 0) + (circle1 ? 1 : 0) + (circle2 ? 1 : 0) + (circle3 ? 1 : 0);
  if (lineCount != 2 || circleCount != 2) return -2;

  let railAEdge: u32 = INVALID_ID;
  let railBEdge: u32 = INVALID_ID;
  let railAOrient: u8 = 0;
  let railBOrient: u8 = 0;
  let railAIdx: i32 = -1;
  let railBIdx: i32 = -1;
  if (circle0) { railAEdge = edge0; railAOrient = coedgeGetOrient(ce0); railAIdx = 0; }
  if (circle1) {
    if (railAIdx < 0) { railAEdge = edge1; railAOrient = coedgeGetOrient(ce1); railAIdx = 1; }
    else { railBEdge = edge1; railBOrient = coedgeGetOrient(ce1); railBIdx = 1; }
  }
  if (circle2) {
    if (railAIdx < 0) { railAEdge = edge2; railAOrient = coedgeGetOrient(ce2); railAIdx = 2; }
    else { railBEdge = edge2; railBOrient = coedgeGetOrient(ce2); railBIdx = 2; }
  }
  if (circle3) {
    if (railAIdx < 0) { railAEdge = edge3; railAOrient = coedgeGetOrient(ce3); railAIdx = 3; }
    else { railBEdge = edge3; railBOrient = coedgeGetOrient(ce3); railBIdx = 3; }
  }
  if (railAIdx < 0 || railBIdx < 0) return -2;
  if (((railBIdx - railAIdx + 4) & 3) != 2) return -2;

  let su = segsU > 0 ? segsU : DEFAULT_SEGS;
  if (surfType == 1) {
    if (su < 32) su = 32;
  } else if (su < 16) su = 16;
  if (su + 1 > RULED_QUAD_MAX_SAMPLES) su = RULED_QUAD_MAX_SAMPLES - 1;

  if (!_sampleCircleCoedgeRow(railAEdge, railAOrient, su, ruledQuadRowA)) return -2;
  if (!_sampleCircleCoedgeRow(railBEdge, railBOrient, su, ruledQuadRowB)) return -2;

  const endA = su * 3;
  const directDx0 = unchecked(ruledQuadRowA[0]) - unchecked(ruledQuadRowB[0]);
  const directDy0 = unchecked(ruledQuadRowA[1]) - unchecked(ruledQuadRowB[1]);
  const directDz0 = unchecked(ruledQuadRowA[2]) - unchecked(ruledQuadRowB[2]);
  const directDx1 = unchecked(ruledQuadRowA[endA]) - unchecked(ruledQuadRowB[endA]);
  const directDy1 = unchecked(ruledQuadRowA[endA + 1]) - unchecked(ruledQuadRowB[endA + 1]);
  const directDz1 = unchecked(ruledQuadRowA[endA + 2]) - unchecked(ruledQuadRowB[endA + 2]);
  const reverseDx0 = unchecked(ruledQuadRowA[0]) - unchecked(ruledQuadRowB[endA]);
  const reverseDy0 = unchecked(ruledQuadRowA[1]) - unchecked(ruledQuadRowB[endA + 1]);
  const reverseDz0 = unchecked(ruledQuadRowA[2]) - unchecked(ruledQuadRowB[endA + 2]);
  const reverseDx1 = unchecked(ruledQuadRowA[endA]) - unchecked(ruledQuadRowB[0]);
  const reverseDy1 = unchecked(ruledQuadRowA[endA + 1]) - unchecked(ruledQuadRowB[1]);
  const reverseDz1 = unchecked(ruledQuadRowA[endA + 2]) - unchecked(ruledQuadRowB[2]);
  const reverseB =
    reverseDx0 * reverseDx0 + reverseDy0 * reverseDy0 + reverseDz0 * reverseDz0
    + reverseDx1 * reverseDx1 + reverseDy1 * reverseDy1 + reverseDz1 * reverseDz1
    < directDx0 * directDx0 + directDy0 * directDy0 + directDz0 * directDz0
      + directDx1 * directDx1 + directDy1 * directDy1 + directDz1 * directDz1;

  const baseA = outVertCount;
  for (let i: i32 = 0; i <= su; i++) {
    const p = i * 3;
    _projectPoint(
      unchecked(ruledQuadRowA[p]),
      unchecked(ruledQuadRowA[p + 1]),
      unchecked(ruledQuadRowA[p + 2])
    );
    _evalSurface(surfType, _projU, _projV,
      ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, semiAngle, majorR, minorR);
    let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
    if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
    if (_ruledRowEmit(ruledQuadRowA, i, nx, ny, nz) == INVALID_ID) return -1;
  }
  const baseB = outVertCount;
  for (let i: i32 = 0; i <= su; i++) {
    const idx = reverseB ? (su - i) : i;
    const p = idx * 3;
    _projectPoint(
      unchecked(ruledQuadRowB[p]),
      unchecked(ruledQuadRowB[p + 1]),
      unchecked(ruledQuadRowB[p + 2])
    );
    _evalSurface(surfType, _projU, _projV,
      ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, semiAngle, majorR, minorR);
    let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
    if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
    if (_ruledRowEmit(ruledQuadRowB, idx, nx, ny, nz) == INVALID_ID) return -1;
  }

  let triCount: i32 = 0;
  for (let i: i32 = 0; i < su; i++) {
    const a0 = baseA + <u32>i;
    const a1 = baseA + <u32>(i + 1);
    const b0 = baseB + <u32>i;
    const b1 = baseB + <u32>(i + 1);
    if (_emitAnalyticTriOriented(a0, a1, b0, faceId, reversed,
      surfType, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, semiAngle, majorR, minorR) < 0) return -1;
    if (_emitAnalyticTriOriented(b0, a1, b1, faceId, reversed,
      surfType, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, semiAngle, majorR, minorR) < 0) return -1;
    triCount += 2;
  }

  return triCount;
}

function _tessTorusFourCircleFace(
  faceId: u32, reversed: bool,
  segsU: i32, segsV: i32,
  cx: f64, cy: f64, cz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  majorR: f64, minorR: f64
): i32 {
  if (faceGetLoopCount(faceId) != 1) return -2;
  const loopId = faceGetFirstLoop(faceId);
  const ce0 = loopGetFirstCoedge(loopId);
  const ce1 = coedgeGetNext(ce0);
  const ce2 = coedgeGetNext(ce1);
  const ce3 = coedgeGetNext(ce2);
  if (coedgeGetNext(ce3) != ce0) return -2;

  const ceIds = [ce0, ce1, ce2, ce3];
  for (let i = 0; i < 4; i++) {
    const eid = coedgeGetEdge(unchecked(ceIds[i]));
    if (edgeGetStartVertex(eid) == edgeGetEndVertex(eid)) return -2;
    if (edgeGetGeomType(eid) != GEOM_CIRCLE) return -2;
  }

  let su = segsU > 0 ? segsU : DEFAULT_SEGS;
  let sv = segsV > 0 ? segsV : DEFAULT_SEGS;
  if (su < 16) su = 16;
  if (sv < 8) sv = 8;
  if (su + 1 > RULED_QUAD_MAX_SAMPLES) su = RULED_QUAD_MAX_SAMPLES - 1;

  if (!_sampleCircleCoedgeRow(coedgeGetEdge(ce0), coedgeGetOrient(ce0), 8, ruledQuadRowA)) return -2;
  _measureProjectedRow(ruledQuadRowA, 8);
  const edge0USpan = _rowStatUMax - _rowStatUMin;
  const edge0VSpan = _rowStatVMax - _rowStatVMin;

  let rowCeA = ce0;
  let rowCeB = ce2;
  if (edge0USpan < edge0VSpan) {
    rowCeA = ce1;
    rowCeB = ce3;
  }

  if (!_sampleCircleCoedgeRow(coedgeGetEdge(rowCeA), coedgeGetOrient(rowCeA), su, ruledQuadRowA)) return -2;
  if (!_sampleCircleCoedgeRow(coedgeGetEdge(rowCeB), coedgeGetOrient(rowCeB), su, ruledQuadRowB)) return -2;

  const endP = su * 3;
  const directDx0 = unchecked(ruledQuadRowA[0]) - unchecked(ruledQuadRowB[0]);
  const directDy0 = unchecked(ruledQuadRowA[1]) - unchecked(ruledQuadRowB[1]);
  const directDz0 = unchecked(ruledQuadRowA[2]) - unchecked(ruledQuadRowB[2]);
  const directDx1 = unchecked(ruledQuadRowA[endP]) - unchecked(ruledQuadRowB[endP]);
  const directDy1 = unchecked(ruledQuadRowA[endP + 1]) - unchecked(ruledQuadRowB[endP + 1]);
  const directDz1 = unchecked(ruledQuadRowA[endP + 2]) - unchecked(ruledQuadRowB[endP + 2]);
  const reverseDx0 = unchecked(ruledQuadRowA[0]) - unchecked(ruledQuadRowB[endP]);
  const reverseDy0 = unchecked(ruledQuadRowA[1]) - unchecked(ruledQuadRowB[endP + 1]);
  const reverseDz0 = unchecked(ruledQuadRowA[2]) - unchecked(ruledQuadRowB[endP + 2]);
  const reverseDx1 = unchecked(ruledQuadRowA[endP]) - unchecked(ruledQuadRowB[0]);
  const reverseDy1 = unchecked(ruledQuadRowA[endP + 1]) - unchecked(ruledQuadRowB[1]);
  const reverseDz1 = unchecked(ruledQuadRowA[endP + 2]) - unchecked(ruledQuadRowB[2]);
  const reverseB =
    reverseDx0 * reverseDx0 + reverseDy0 * reverseDy0 + reverseDz0 * reverseDz0
    + reverseDx1 * reverseDx1 + reverseDy1 * reverseDy1 + reverseDz1 * reverseDz1
    < directDx0 * directDx0 + directDy0 * directDy0 + directDz0 * directDz0
      + directDx1 * directDx1 + directDy1 * directDy1 + directDz1 * directDz1;
  if (reverseB) {
    for (let i: i32 = 0; i <= su / 2; i++) {
      const j = su - i;
      const pi = i * 3;
      const pj = j * 3;
      const tx = unchecked(ruledQuadRowB[pi]);
      const ty = unchecked(ruledQuadRowB[pi + 1]);
      const tz = unchecked(ruledQuadRowB[pi + 2]);
      unchecked(ruledQuadRowB[pi] = unchecked(ruledQuadRowB[pj]));
      unchecked(ruledQuadRowB[pi + 1] = unchecked(ruledQuadRowB[pj + 1]));
      unchecked(ruledQuadRowB[pi + 2] = unchecked(ruledQuadRowB[pj + 2]));
      unchecked(ruledQuadRowB[pj] = tx);
      unchecked(ruledQuadRowB[pj + 1] = ty);
      unchecked(ruledQuadRowB[pj + 2] = tz);
    }
  }

  _measureProjectedRow(ruledQuadRowA, su);
  const uStartA = _rowStatUStart;
  const uEndA = _rowStatUEnd;
  const vA = _rowStatVAvg;
  _measureProjectedRow(ruledQuadRowB, su);
  const uStartB = _wrapPeriodicNear(_rowStatUStart, uStartA);
  const uEndB = _wrapPeriodicNear(_rowStatUEnd, uEndA);
  const vB = _wrapPeriodicNear(_rowStatVAvg, vA);

  const uStart = 0.5 * (uStartA + uStartB);
  const uEnd = 0.5 * (uEndA + uEndB);
  if (Math.abs(uEnd - uStart) < 1e-10 || Math.abs(vB - vA) < 1e-10) return -2;

  const baseVert = outVertCount;
  for (let j: i32 = 0; j <= sv; j++) {
    const beta = <f64>j / <f64>sv;
    for (let i: i32 = 0; i <= su; i++) {
      if (j == 0) {
        const p = i * 3;
        _projectPoint(
          unchecked(ruledQuadRowA[p]),
          unchecked(ruledQuadRowA[p + 1]),
          unchecked(ruledQuadRowA[p + 2])
        );
        _evalSurface(4, _projU, _projV,
          cx, cy, cz, ax, ay, az, rx, ry, rz, bx, by, bz,
          0.0, 0.0, majorR, minorR);
        let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
        if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
        if (_ruledRowEmit(ruledQuadRowA, i, nx, ny, nz) == INVALID_ID) return -1;
        continue;
      }
      if (j == sv) {
        const p = i * 3;
        _projectPoint(
          unchecked(ruledQuadRowB[p]),
          unchecked(ruledQuadRowB[p + 1]),
          unchecked(ruledQuadRowB[p + 2])
        );
        _evalSurface(4, _projU, _projV,
          cx, cy, cz, ax, ay, az, rx, ry, rz, bx, by, bz,
          0.0, 0.0, majorR, minorR);
        let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
        if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
        if (_ruledRowEmit(ruledQuadRowB, i, nx, ny, nz) == INVALID_ID) return -1;
        continue;
      }

      const alpha = <f64>i / <f64>su;
      const uParam = uStart + alpha * (uEnd - uStart);
      const vParam = vA + beta * (vB - vA);
      _evalSurface(4, uParam, vParam,
        cx, cy, cz, ax, ay, az, rx, ry, rz, bx, by, bz,
        0.0, 0.0, majorR, minorR);
      let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
      if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
      if (_emitVert(_surfX, _surfY, _surfZ, nx, ny, nz) == INVALID_ID) return -1;
    }
  }

  let triCount: i32 = 0;
  for (let j: i32 = 0; j < sv; j++) {
    for (let i: i32 = 0; i < su; i++) {
      const i00 = baseVert + <u32>(j * (su + 1) + i);
      const i10 = baseVert + <u32>((j + 1) * (su + 1) + i);
      const i11 = baseVert + <u32>((j + 1) * (su + 1) + i + 1);
      const i01 = baseVert + <u32>(j * (su + 1) + i + 1);
      if (_emitAnalyticTriOriented(i00, i01, i10, faceId, reversed,
        4, cx, cy, cz, ax, ay, az, rx, ry, rz, bx, by, bz,
        0.0, 0.0, majorR, minorR) < 0) return -1;
      if (_emitAnalyticTriOriented(i10, i01, i11, faceId, reversed,
        4, cx, cy, cz, ax, ay, az, rx, ry, rz, bx, by, bz,
        0.0, 0.0, majorR, minorR) < 0) return -1;
      triCount += 2;
    }
  }

  return triCount;
}

function _emitPlaneTriOriented(i0: u32, i1: u32, i2: u32, nx: f64, ny: f64, nz: f64, faceId: u32): i32 {
  const a = i0 * 3;
  const b = i1 * 3;
  const c = i2 * 3;
  const abx = unchecked(tessOutVerts[b]) - unchecked(tessOutVerts[a]);
  const aby = unchecked(tessOutVerts[b + 1]) - unchecked(tessOutVerts[a + 1]);
  const abz = unchecked(tessOutVerts[b + 2]) - unchecked(tessOutVerts[a + 2]);
  const acx = unchecked(tessOutVerts[c]) - unchecked(tessOutVerts[a]);
  const acy = unchecked(tessOutVerts[c + 1]) - unchecked(tessOutVerts[a + 1]);
  const acz = unchecked(tessOutVerts[c + 2]) - unchecked(tessOutVerts[a + 2]);
  const tx = aby * acz - abz * acy;
  const ty = abz * acx - abx * acz;
  const tz = abx * acy - aby * acx;
  const dot = tx * nx + ty * ny + tz * nz;
  return dot >= 0.0
    ? _emitTri(i0, i1, i2, faceId)
    : _emitTri(i0, i2, i1, faceId);
}

@inline
function _planarProject(x: f64, y: f64, z: f64): void {
  const dx = x - _planeOx;
  const dy = y - _planeOy;
  const dz = z - _planeOz;
  _projU = dx * _planeRx + dy * _planeRy + dz * _planeRz;
  _projV = dx * _planeYx + dy * _planeYy + dz * _planeYz;
}

function _setPlaneProjection(gOff: u32, nx: f64, ny: f64, nz: f64): void {
  _planeOx = geomPoolRead(gOff);
  _planeOy = geomPoolRead(gOff + 1);
  _planeOz = geomPoolRead(gOff + 2);
  _planeNx = nx;
  _planeNy = ny;
  _planeNz = nz;

  let rx = geomPoolRead(gOff + 6);
  let ry = geomPoolRead(gOff + 7);
  let rz = geomPoolRead(gOff + 8);
  const dot = rx * nx + ry * ny + rz * nz;
  rx -= dot * nx;
  ry -= dot * ny;
  rz -= dot * nz;
  let rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (rLen < 1e-14) {
    if (Math.abs(nx) <= Math.abs(ny) && Math.abs(nx) <= Math.abs(nz)) { rx = 1.0; ry = 0.0; rz = 0.0; }
    else if (Math.abs(ny) <= Math.abs(nz)) { rx = 0.0; ry = 1.0; rz = 0.0; }
    else { rx = 0.0; ry = 0.0; rz = 1.0; }
    const dot2 = rx * nx + ry * ny + rz * nz;
    rx -= dot2 * nx;
    ry -= dot2 * ny;
    rz -= dot2 * nz;
    rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
  }
  if (rLen < 1e-14) { rx = 1.0; ry = 0.0; rz = 0.0; rLen = 1.0; }
  _planeRx = rx / rLen;
  _planeRy = ry / rLen;
  _planeRz = rz / rLen;

  _planeYx = ny * _planeRz - nz * _planeRy;
  _planeYy = nz * _planeRx - nx * _planeRz;
  _planeYz = nx * _planeRy - ny * _planeRx;
  const yLen = Math.sqrt(_planeYx * _planeYx + _planeYy * _planeYy + _planeYz * _planeYz);
  if (yLen > 1e-14) {
    _planeYx /= yLen;
    _planeYy /= yLen;
    _planeYz /= yLen;
  }
}

function _setProjectionFrameFromBoundary(faceId: u32): bool {
  if (faceGetLoopCount(faceId) != 1) return false;
  _collectOuterLoopVerts(faceId);
  if (loopVertCount < 5) return false;

  _planeOx = vertexGetX(unchecked(loopVerts[0]));
  _planeOy = vertexGetY(unchecked(loopVerts[0]));
  _planeOz = vertexGetZ(unchecked(loopVerts[0]));

  let nx: f64 = 0.0;
  let ny: f64 = 0.0;
  let nz: f64 = 0.0;
  let prev = unchecked(loopVerts[loopVertCount - 1]);
  for (let i: u32 = 0; i < loopVertCount; i++) {
    const curr = unchecked(loopVerts[i]);
    const px = vertexGetX(prev), py = vertexGetY(prev), pz = vertexGetZ(prev);
    const cx = vertexGetX(curr), cy = vertexGetY(curr), cz = vertexGetZ(curr);
    nx += (py - cy) * (pz + cz);
    ny += (pz - cz) * (px + cx);
    nz += (px - cx) * (py + cy);
    prev = curr;
  }

  let nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (nLen < 1e-12) {
    const v0 = unchecked(loopVerts[0]);
    const v1 = unchecked(loopVerts[1]);
    for (let i: u32 = 2; i < loopVertCount; i++) {
      const v2 = unchecked(loopVerts[i]);
      const ax = vertexGetX(v1) - vertexGetX(v0);
      const ay = vertexGetY(v1) - vertexGetY(v0);
      const az = vertexGetZ(v1) - vertexGetZ(v0);
      const bx = vertexGetX(v2) - vertexGetX(v0);
      const by = vertexGetY(v2) - vertexGetY(v0);
      const bz = vertexGetZ(v2) - vertexGetZ(v0);
      nx = ay * bz - az * by;
      ny = az * bx - ax * bz;
      nz = ax * by - ay * bx;
      nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nLen >= 1e-12) break;
    }
  }
  if (nLen < 1e-12) return false;

  nx /= nLen;
  ny /= nLen;
  nz /= nLen;
  _planeNx = nx;
  _planeNy = ny;
  _planeNz = nz;

  let rx: f64 = 0.0;
  let ry: f64 = 0.0;
  let rz: f64 = 0.0;
  for (let i: u32 = 0; i < loopVertCount; i++) {
    const a = unchecked(loopVerts[i]);
    const b = unchecked(loopVerts[(i + 1) % loopVertCount]);
    rx = vertexGetX(b) - vertexGetX(a);
    ry = vertexGetY(b) - vertexGetY(a);
    rz = vertexGetZ(b) - vertexGetZ(a);
    const dot = rx * nx + ry * ny + rz * nz;
    rx -= dot * nx;
    ry -= dot * ny;
    rz -= dot * nz;
    const rLenTry = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (rLenTry > 1e-12) break;
  }

  let rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (rLen < 1e-12) {
    if (Math.abs(nx) <= Math.abs(ny) && Math.abs(nx) <= Math.abs(nz)) { rx = 1.0; ry = 0.0; rz = 0.0; }
    else if (Math.abs(ny) <= Math.abs(nz)) { rx = 0.0; ry = 1.0; rz = 0.0; }
    else { rx = 0.0; ry = 0.0; rz = 1.0; }
    const dot = rx * nx + ry * ny + rz * nz;
    rx -= dot * nx;
    ry -= dot * ny;
    rz -= dot * nz;
    rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
  }
  if (rLen < 1e-12) return false;

  _planeRx = rx / rLen;
  _planeRy = ry / rLen;
  _planeRz = rz / rLen;

  _planeYx = ny * _planeRz - nz * _planeRy;
  _planeYy = nz * _planeRx - nx * _planeRz;
  _planeYz = nx * _planeRy - ny * _planeRx;
  const yLen = Math.sqrt(_planeYx * _planeYx + _planeYy * _planeYy + _planeYz * _planeYz);
  if (yLen <= 1e-12) return false;
  _planeYx /= yLen;
  _planeYy /= yLen;
  _planeYz /= yLen;
  return true;
}

function _planarAppendPoint(x: f64, y: f64, z: f64, loopStart: u32): bool {
  if (_planarPointCount >= MAX_PLANAR_PTS) return false;
  if (_planarPointCount > loopStart) {
    const prev = _planarPointCount - 1;
    const dx = x - unchecked(_planarX[prev]);
    const dy = y - unchecked(_planarY[prev]);
    const dz = z - unchecked(_planarZ[prev]);
    if (dx * dx + dy * dy + dz * dz < 1e-20) return true;
  }
  _planarProject(x, y, z);
  unchecked(_planarX[_planarPointCount] = x);
  unchecked(_planarY[_planarPointCount] = y);
  unchecked(_planarZ[_planarPointCount] = z);
  unchecked(_planarU[_planarPointCount] = _projU);
  unchecked(_planarV[_planarPointCount] = _projV);
  _planarPointCount++;
  return true;
}

function _planarAppendVertex(vertexId: u32, loopStart: u32): bool {
  return _planarAppendPoint(vertexGetX(vertexId), vertexGetY(vertexId), vertexGetZ(vertexId), loopStart);
}

function _planarAppendCircleCoedge(edgeId: u32, orient: u8, segsU: i32, loopStart: u32): bool {
  let segs = segsU;
  if (segs < 32) segs = 32;
  if (segs > 192) segs = 192;

  const off = edgeGetGeomOffset(edgeId);
  const cx = geomPoolRead(off);
  const cy = geomPoolRead(off + 1);
  const cz = geomPoolRead(off + 2);
  const ax = geomPoolRead(off + 3);
  const ay = geomPoolRead(off + 4);
  const az = geomPoolRead(off + 5);
  const rx = geomPoolRead(off + 6);
  const ry = geomPoolRead(off + 7);
  const rz = geomPoolRead(off + 8);
  const radius = geomPoolRead(off + 9);
  const bx = ay * rz - az * ry;
  const by = az * rx - ax * rz;
  const bz = ax * ry - ay * rx;
  const startV = edgeGetStartVertex(edgeId);
  const endV = edgeGetEndVertex(edgeId);
  const coStart = orient == ORIENT_REVERSED ? endV : startV;
  const coEnd = orient == ORIENT_REVERSED ? startV : endV;
  const startAngle = _circleAngleAtVertex(edgeId, startV);
  const endAngle = _circleAngleAtVertex(edgeId, endV);
  const sweep = _directedPeriodicSweep(startAngle, endAngle, edgeGetCurveSameSense(edgeId) != 0, startV == endV);

  for (let i: i32 = 0; i <= segs; i++) {
    if (i == 0) {
      if (!_planarAppendVertex(coStart, loopStart)) return false;
      continue;
    }
    if (i == segs) {
      if (!_planarAppendVertex(coEnd, loopStart)) return false;
      continue;
    }
    let frac = <f64>i / <f64>segs;
    if (orient == ORIENT_REVERSED) frac = 1.0 - frac;
    const theta = startAngle + frac * sweep;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    if (!_planarAppendPoint(
      cx + radius * (rx * c + bx * s),
      cy + radius * (ry * c + by * s),
      cz + radius * (rz * c + bz * s),
      loopStart,
    )) return false;
  }
  return true;
}

function _planarAppendNurbsCoedge(edgeId: u32, orient: u8, segsU: i32, loopStart: u32): bool {
  if (!_loadCurve(edgeGetGeomOffset(edgeId))) {
    const startV = orient == ORIENT_REVERSED ? edgeGetEndVertex(edgeId) : edgeGetStartVertex(edgeId);
    const endV = orient == ORIENT_REVERSED ? edgeGetStartVertex(edgeId) : edgeGetEndVertex(edgeId);
    return _planarAppendVertex(startV, loopStart) && _planarAppendVertex(endV, loopStart);
  }
  let segs = segsU;
  if (segs < 8) segs = 8;
  if (segs > 192) segs = 192;
  const startV = orient == ORIENT_REVERSED ? edgeGetEndVertex(edgeId) : edgeGetStartVertex(edgeId);
  const endV = orient == ORIENT_REVERSED ? edgeGetStartVertex(edgeId) : edgeGetEndVertex(edgeId);
  for (let i: i32 = 0; i <= segs; i++) {
    if (i == 0) {
      if (!_planarAppendVertex(startV, loopStart)) return false;
      continue;
    }
    if (i == segs) {
      if (!_planarAppendVertex(endV, loopStart)) return false;
      continue;
    }
    let frac = <f64>i / <f64>segs;
    if (orient == ORIENT_REVERSED) frac = 1.0 - frac;
    const t = _crvTmin + frac * (_crvTmax - _crvTmin);
    nurbsCurveEvaluate(_crvDeg, _crvNCtrl, _crvCtrl, _crvKnots, _crvWts, t);
    const rp = getResultPtr();
    if (!_planarAppendPoint(load<f64>(rp), load<f64>(rp + 8), load<f64>(rp + 16), loopStart)) return false;
  }
  return true;
}

function _collectPlanarLoops(faceId: u32, segsU: i32): bool {
  _planarPointCount = 0;
  _planarLoopCount = 0;
  _planarPathCount = 0;

  const firstLoop = faceGetFirstLoop(faceId);
  const nLoops = faceGetLoopCount(faceId);
  for (let l: u32 = 0; l < nLoops; l++) {
    if (_planarLoopCount >= MAX_PLANAR_LOOPS) return false;
    const loopId = firstLoop + l;
    const loopStart = _planarPointCount;
    const firstCE = loopGetFirstCoedge(loopId);
    let ce = firstCE;
    let guard: u32 = 0;

    do {
      const eid = coedgeGetEdge(ce);
      const orient = coedgeGetOrient(ce);
      _cacheEdgeSamples(eid);
      const geomType = edgeGetGeomType(eid);
      if (geomType == GEOM_CIRCLE) {
        if (!_planarAppendCircleCoedge(eid, orient, segsU, loopStart)) return false;
      } else if (geomType == GEOM_NURBS_CURVE) {
        if (!_planarAppendNurbsCoedge(eid, orient, segsU, loopStart)) return false;
      } else {
        const startV = orient == ORIENT_REVERSED ? edgeGetEndVertex(eid) : edgeGetStartVertex(eid);
        const endV = orient == ORIENT_REVERSED ? edgeGetStartVertex(eid) : edgeGetEndVertex(eid);
        if (!_planarAppendVertex(startV, loopStart)) return false;
        if (!_planarAppendVertex(endV, loopStart)) return false;
      }
      ce = coedgeGetNext(ce);
      guard++;
    } while (ce != firstCE && guard < 65536);

    if (_planarPointCount > loopStart + 1) {
      const last = _planarPointCount - 1;
      const dx = unchecked(_planarX[last]) - unchecked(_planarX[loopStart]);
      const dy = unchecked(_planarY[last]) - unchecked(_planarY[loopStart]);
      const dz = unchecked(_planarZ[last]) - unchecked(_planarZ[loopStart]);
      if (dx * dx + dy * dy + dz * dz < 1e-20) _planarPointCount--;
    }

    if (_planarPointCount - loopStart >= 3) {
      unchecked(_planarLoopStart[_planarLoopCount] = loopStart);
      unchecked(_planarLoopEnd[_planarLoopCount] = _planarPointCount);
      _planarLoopCount++;
    } else {
      _planarPointCount = loopStart;
    }
  }

  return _planarLoopCount > 0 && _planarPointCount >= 3;
}

function _planarLoopArea(loopNo: u32): f64 {
  const start = unchecked(_planarLoopStart[loopNo]);
  const end = unchecked(_planarLoopEnd[loopNo]);
  const n = end - start;
  let area: f64 = 0.0;
  if (n < 3) return 0.0;
  let j = end - 1;
  for (let i: u32 = start; i < end; i++) {
    area += unchecked(_planarU[j]) * unchecked(_planarV[i]) - unchecked(_planarU[i]) * unchecked(_planarV[j]);
    j = i;
  }
  return 0.5 * area;
}

function _planarLoopIndexAt(loopNo: u32, offset: u32, reverse: bool): u32 {
  const start = unchecked(_planarLoopStart[loopNo]);
  const end = unchecked(_planarLoopEnd[loopNo]);
  const n = end - start;
  const local = offset % n;
  return reverse ? start + (n - 1 - local) : start + local;
}

function _planarLoopOffsetForPoint(loopNo: u32, pointId: u32, reverse: bool): u32 {
  const start = unchecked(_planarLoopStart[loopNo]);
  const end = unchecked(_planarLoopEnd[loopNo]);
  const n = end - start;
  for (let i: u32 = 0; i < n; i++) {
    if (_planarLoopIndexAt(loopNo, i, reverse) == pointId) return i;
  }
  return 0;
}

function _planarAppendPathIndex(pointId: u32): bool {
  if (_planarPathCount >= MAX_PLANAR_PATH) return false;
  unchecked(_planarPath[_planarPathCount] = pointId);
  _planarPathCount++;
  return true;
}

function _planarInitOuterPath(): bool {
  _planarPathCount = 0;
  const n = unchecked(_planarLoopEnd[0]) - unchecked(_planarLoopStart[0]);
  const reverse = _planarLoopArea(0) < 0.0;
  for (let i: u32 = 0; i < n; i++) {
    if (!_planarAppendPathIndex(_planarLoopIndexAt(0, i, reverse))) return false;
  }
  return _planarPathCount >= 3;
}

@inline
function _planarOrient(a: u32, b: u32, c: u32): f64 {
  return (unchecked(_planarU[b]) - unchecked(_planarU[a])) * (unchecked(_planarV[c]) - unchecked(_planarV[a]))
    - (unchecked(_planarV[b]) - unchecked(_planarV[a])) * (unchecked(_planarU[c]) - unchecked(_planarU[a]));
}

function _planarSegmentsProperlyIntersect(a: u32, b: u32, c: u32, d: u32): bool {
  if (a == c || a == d || b == c || b == d) return false;
  const o1 = _planarOrient(a, b, c);
  const o2 = _planarOrient(a, b, d);
  const o3 = _planarOrient(c, d, a);
  const o4 = _planarOrient(c, d, b);
  return o1 * o2 < -1e-12 && o3 * o4 < -1e-12;
}

function _planarPointInLoop(u: f64, v: f64, loopNo: u32): bool {
  const start = unchecked(_planarLoopStart[loopNo]);
  const end = unchecked(_planarLoopEnd[loopNo]);
  const n = end - start;
  if (n < 3) return false;
  let inside = false;
  let j = end - 1;
  for (let i: u32 = start; i < end; i++) {
    const vi = unchecked(_planarV[i]);
    const vj = unchecked(_planarV[j]);
    if ((vi > v) != (vj > v)) {
      const ui = unchecked(_planarU[i]);
      const uj = unchecked(_planarU[j]);
      const uCross = ui + (v - vi) / ((vj - vi) == 0.0 ? 1e-30 : (vj - vi)) * (uj - ui);
      if (u < uCross) inside = !inside;
    }
    j = i;
  }
  return inside;
}

function _planarPointInsideTrim(u: f64, v: f64): bool {
  if (!_planarPointInLoop(u, v, 0)) return false;
  for (let l: u32 = 1; l < _planarLoopCount; l++) {
    if (_planarPointInLoop(u, v, l)) return false;
  }
  return true;
}

function _planarBridgeVisible(a: u32, b: u32): bool {
  const mu = (unchecked(_planarU[a]) + unchecked(_planarU[b])) * 0.5;
  const mv = (unchecked(_planarV[a]) + unchecked(_planarV[b])) * 0.5;
  if (!_planarPointInsideTrim(mu, mv)) return false;

  for (let l: u32 = 0; l < _planarLoopCount; l++) {
    const start = unchecked(_planarLoopStart[l]);
    const end = unchecked(_planarLoopEnd[l]);
    const n = end - start;
    if (n < 2) continue;
    let prev = end - 1;
    for (let i: u32 = start; i < end; i++) {
      if (_planarSegmentsProperlyIntersect(a, b, prev, i)) return false;
      prev = i;
    }
  }
  return true;
}

function _planarBridgeHole(loopNo: u32): bool {
  const start = unchecked(_planarLoopStart[loopNo]);
  const end = unchecked(_planarLoopEnd[loopNo]);
  const n = end - start;
  if (n < 3) return true;

  let holePoint = start;
  for (let i: u32 = start + 1; i < end; i++) {
    const u = unchecked(_planarU[i]);
    const hu = unchecked(_planarU[holePoint]);
    if (u > hu || (Math.abs(u - hu) < 1e-10 && unchecked(_planarV[i]) < unchecked(_planarV[holePoint]))) {
      holePoint = i;
    }
  }

  let bestPos: i32 = -1;
  let bestDist: f64 = Infinity;
  for (let pi: u32 = 0; pi < _planarPathCount; pi++) {
    const candidate = unchecked(_planarPath[pi]);
    if (!_planarBridgeVisible(holePoint, candidate)) continue;
    const du = unchecked(_planarU[candidate]) - unchecked(_planarU[holePoint]);
    const dv = unchecked(_planarV[candidate]) - unchecked(_planarV[holePoint]);
    const dist = du * du + dv * dv;
    if (dist < bestDist) {
      bestDist = dist;
      bestPos = <i32>pi;
    }
  }
  if (bestPos < 0) return false;

  const holeReverse = _planarLoopArea(loopNo) > 0.0;
  const holeOffset = _planarLoopOffsetForPoint(loopNo, holePoint, holeReverse);
  const bridgePoint = unchecked(_planarPath[<u32>bestPos]);

  let outCount: u32 = 0;
  for (let i: u32 = 0; i <= <u32>bestPos; i++) {
    if (outCount >= MAX_PLANAR_PATH) return false;
    unchecked(_planarPathNext[outCount++] = unchecked(_planarPath[i]));
  }
  if (outCount >= MAX_PLANAR_PATH) return false;
  unchecked(_planarPathNext[outCount++] = holePoint);
  for (let k: u32 = 1; k < n; k++) {
    if (outCount >= MAX_PLANAR_PATH) return false;
    unchecked(_planarPathNext[outCount++] = _planarLoopIndexAt(loopNo, (holeOffset + k) % n, holeReverse));
  }
  if (outCount + 2 >= MAX_PLANAR_PATH) return false;
  unchecked(_planarPathNext[outCount++] = holePoint);
  unchecked(_planarPathNext[outCount++] = bridgePoint);
  for (let i: u32 = <u32>bestPos + 1; i < _planarPathCount; i++) {
    if (outCount >= MAX_PLANAR_PATH) return false;
    unchecked(_planarPathNext[outCount++] = unchecked(_planarPath[i]));
  }

  _planarPathCount = outCount;
  for (let i: u32 = 0; i < _planarPathCount; i++) {
    unchecked(_planarPath[i] = unchecked(_planarPathNext[i]));
  }
  return true;
}

function _planarBuildBridgedPath(): bool {
  if (!_planarInitOuterPath()) return false;
  for (let l: u32 = 1; l < _planarLoopCount; l++) {
    if (!_planarBridgeHole(l)) return false;
  }
  return _planarPathCount >= 3;
}

function _planarPathArea(): f64 {
  let area: f64 = 0.0;
  if (_planarPathCount < 3) return 0.0;
  let prev = unchecked(_planarPath[_planarPathCount - 1]);
  for (let i: u32 = 0; i < _planarPathCount; i++) {
    const curr = unchecked(_planarPath[i]);
    area += unchecked(_planarU[prev]) * unchecked(_planarV[curr]) - unchecked(_planarU[curr]) * unchecked(_planarV[prev]);
    prev = curr;
  }
  return 0.5 * area;
}

function _planarPointInTri(p: u32, a: u32, b: u32, c: u32, winding: f64): bool {
  if (p == a || p == b || p == c) return false;
  const c1 = _planarOrient(a, b, p) * winding;
  const c2 = _planarOrient(b, c, p) * winding;
  const c3 = _planarOrient(c, a, p) * winding;
  return c1 >= -1e-9 && c2 >= -1e-9 && c3 >= -1e-9;
}

function _trimAddBaseTri(a: u32, b: u32, c: u32): bool {
  if (_trimTriCount >= MAX_TRIM_TRIS) return false;
  unchecked(_trimTriA[_trimTriCount] = a);
  unchecked(_trimTriB[_trimTriCount] = b);
  unchecked(_trimTriC[_trimTriCount] = c);
  _trimTriCount++;
  return true;
}

function _trimAddNextTri(a: u32, b: u32, c: u32): bool {
  if (_trimNextCount >= MAX_TRIM_TRIS) return false;
  unchecked(_trimNextA[_trimNextCount] = a);
  unchecked(_trimNextB[_trimNextCount] = b);
  unchecked(_trimNextC[_trimNextCount] = c);
  _trimNextCount++;
  return true;
}

function _trimCopyNextToBase(): void {
  _trimTriCount = _trimNextCount;
  for (let i: u32 = 0; i < _trimTriCount; i++) {
    unchecked(_trimTriA[i] = unchecked(_trimNextA[i]));
    unchecked(_trimTriB[i] = unchecked(_trimNextB[i]));
    unchecked(_trimTriC[i] = unchecked(_trimNextC[i]));
  }
}

function _buildTrimBaseTrianglesFromPath(): bool {
  _trimTriCount = 0;
  let remCount = _planarPathCount;
  if (remCount > MAX_PLANAR_PATH) return false;
  for (let i: u32 = 0; i < remCount; i++) unchecked(_planarRemaining[i] = unchecked(_planarPath[i]));

  const pathArea = _planarPathArea();
  const winding: f64 = pathArea >= 0.0 ? 1.0 : -1.0;
  let guard: u32 = 0;
  const maxGuard = remCount * remCount + 16;

  while (remCount > 3 && guard < maxGuard) {
    let earFound = false;
    for (let ri: u32 = 0; ri < remCount; ri++) {
      const prevPos = (ri + remCount - 1) % remCount;
      const nextPos = (ri + 1) % remCount;
      const a = unchecked(_planarRemaining[prevPos]);
      const b = unchecked(_planarRemaining[ri]);
      const c = unchecked(_planarRemaining[nextPos]);
      const cross = _planarOrient(a, b, c) * winding;
      if (a == b || b == c) {
        for (let s: u32 = ri; s + 1 < remCount; s++) unchecked(_planarRemaining[s] = unchecked(_planarRemaining[s + 1]));
        remCount--;
        earFound = true;
        break;
      }
      if (a == c || Math.abs(cross) <= 1e-12) continue;
      if (cross < 0.0) continue;

      const cu = (unchecked(_planarU[a]) + unchecked(_planarU[b]) + unchecked(_planarU[c])) / 3.0;
      const cv = (unchecked(_planarV[a]) + unchecked(_planarV[b]) + unchecked(_planarV[c])) / 3.0;
      if (!_planarPointInsideTrim(cu, cv)) continue;

      let contains = false;
      for (let oi: u32 = 0; oi < remCount; oi++) {
        if (oi == prevPos || oi == ri || oi == nextPos) continue;
        const p = unchecked(_planarRemaining[oi]);
        if (_planarPointInTri(p, a, b, c, winding)) { contains = true; break; }
      }
      if (contains) continue;

      if (!_trimAddBaseTri(a, b, c)) return false;
      for (let s: u32 = ri; s + 1 < remCount; s++) unchecked(_planarRemaining[s] = unchecked(_planarRemaining[s + 1]));
      remCount--;
      earFound = true;
      break;
    }
    if (!earFound) return false;
    guard++;
  }

  if (remCount != 3) return false;
  return _trimAddBaseTri(
    unchecked(_planarRemaining[0]),
    unchecked(_planarRemaining[1]),
    unchecked(_planarRemaining[2]),
  );
}

function _trimEdgeMatch(a: u32, b: u32, c: u32, d: u32): bool {
  return (a == c && b == d) || (a == d && b == c);
}

function _trimEdgeUseCount(a: u32, b: u32): u32 {
  let count: u32 = 0;
  for (let i: u32 = 0; i < _trimTriCount; i++) {
    const ta = unchecked(_trimTriA[i]);
    const tb = unchecked(_trimTriB[i]);
    const tc = unchecked(_trimTriC[i]);
    if (_trimEdgeMatch(a, b, ta, tb)) count++;
    if (_trimEdgeMatch(a, b, tb, tc)) count++;
    if (_trimEdgeMatch(a, b, tc, ta)) count++;
  }
  return count;
}

function _trimEdgeUvLen2(a: u32, b: u32): f64 {
  let du = unchecked(_planarU[b]) - unchecked(_planarU[a]);
  while (du > Math.PI) du -= 2.0 * Math.PI;
  while (du < -Math.PI) du += 2.0 * Math.PI;
  const dv = unchecked(_planarV[b]) - unchecked(_planarV[a]);
  return du * du + dv * dv;
}

function _trimShouldSplitEdge(a: u32, b: u32, maxEdge2: f64): bool {
  if (_trimEdgeUseCount(a, b) < 2) return false;
  return _trimEdgeUvLen2(a, b) > maxEdge2;
}

function _trimEdgeKey(a: u32, b: u32): u64 {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return (<u64>lo << 32) | <u64>hi;
}

function _trimCountEdge(edgeUse: Map<u64,u32>, a: u32, b: u32): void {
  const key = _trimEdgeKey(a, b);
  const prev = edgeUse.has(key) ? edgeUse.get(key) : 0;
  edgeUse.set(key, prev + 1);
}

function _trimShouldSplitEdgeCached(edgeUse: Map<u64,u32>, a: u32, b: u32, maxEdge2: f64): bool {
  const key = _trimEdgeKey(a, b);
  if (!edgeUse.has(key) || edgeUse.get(key) < 2) return false;
  return _trimEdgeUvLen2(a, b) > maxEdge2;
}

function _trimMidpointIndex(a: u32, b: u32): u32 {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  for (let i: u32 = 0; i < _trimMidCount; i++) {
    if (unchecked(_trimMidA[i]) == lo && unchecked(_trimMidB[i]) == hi) {
      return unchecked(_trimMidId[i]);
    }
  }
  if (_trimMidCount >= MAX_TRIM_MIDS || _planarPointCount >= MAX_PLANAR_PTS) return INVALID_ID;

  let ua = unchecked(_planarU[a]);
  let ub = unchecked(_planarU[b]);
  while (ub - ua > Math.PI) ub -= 2.0 * Math.PI;
  while (ub - ua < -Math.PI) ub += 2.0 * Math.PI;
  const id = _planarPointCount;
  unchecked(_planarU[id] = (ua + ub) * 0.5);
  unchecked(_planarV[id] = (unchecked(_planarV[a]) + unchecked(_planarV[b])) * 0.5);
  unchecked(_planarX[id] = 0.0);
  unchecked(_planarY[id] = 0.0);
  unchecked(_planarZ[id] = 0.0);
  _planarPointCount++;

  unchecked(_trimMidA[_trimMidCount] = lo);
  unchecked(_trimMidB[_trimMidCount] = hi);
  unchecked(_trimMidId[_trimMidCount] = id);
  _trimMidCount++;
  return id;
}

function _trimAppendSubdividedTri(
  a: u32,
  b: u32,
  c: u32,
  ab: u32,
  bc: u32,
  ca: u32,
): bool {
  const hasAB = ab != INVALID_ID;
  const hasBC = bc != INVALID_ID;
  const hasCA = ca != INVALID_ID;
  if (hasAB) _trimDidSplit = true;
  if (hasBC) _trimDidSplit = true;
  if (hasCA) _trimDidSplit = true;

  if (hasAB && hasBC && hasCA) {
    return _trimAddNextTri(a, ab, ca)
      && _trimAddNextTri(ab, b, bc)
      && _trimAddNextTri(ca, bc, c)
      && _trimAddNextTri(ab, bc, ca);
  }
  if (hasAB && hasBC) {
    return _trimAddNextTri(a, ab, c)
      && _trimAddNextTri(ab, bc, c)
      && _trimAddNextTri(ab, b, bc);
  }
  if (hasBC && hasCA) {
    return _trimAddNextTri(a, b, ca)
      && _trimAddNextTri(b, bc, ca)
      && _trimAddNextTri(bc, c, ca);
  }
  if (hasCA && hasAB) {
    return _trimAddNextTri(a, ab, ca)
      && _trimAddNextTri(ab, b, c)
      && _trimAddNextTri(ab, c, ca);
  }
  if (hasAB) return _trimAddNextTri(a, ab, c) && _trimAddNextTri(ab, b, c);
  if (hasBC) return _trimAddNextTri(a, b, bc) && _trimAddNextTri(a, bc, c);
  if (hasCA) return _trimAddNextTri(a, b, ca) && _trimAddNextTri(ca, b, c);
  return _trimAddNextTri(a, b, c);
}

function _trimRefinePass(maxEdge2: f64): bool {
  _trimNextCount = 0;
  _trimMidCount = 0;
  _trimDidSplit = false;
  const edgeUse = new Map<u64,u32>();
  for (let i: u32 = 0; i < _trimTriCount; i++) {
    const a = unchecked(_trimTriA[i]);
    const b = unchecked(_trimTriB[i]);
    const c = unchecked(_trimTriC[i]);
    _trimCountEdge(edgeUse, a, b);
    _trimCountEdge(edgeUse, b, c);
    _trimCountEdge(edgeUse, c, a);
  }
  for (let i: u32 = 0; i < _trimTriCount; i++) {
    const a = unchecked(_trimTriA[i]);
    const b = unchecked(_trimTriB[i]);
    const c = unchecked(_trimTriC[i]);
    let ab: u32 = INVALID_ID;
    let bc: u32 = INVALID_ID;
    let ca: u32 = INVALID_ID;
    const splitAB = _trimShouldSplitEdgeCached(edgeUse, a, b, maxEdge2);
    const splitBC = _trimShouldSplitEdgeCached(edgeUse, b, c, maxEdge2);
    const splitCA = _trimShouldSplitEdgeCached(edgeUse, c, a, maxEdge2);
    if (splitAB) ab = _trimMidpointIndex(a, b);
    if (splitBC) bc = _trimMidpointIndex(b, c);
    if (splitCA) ca = _trimMidpointIndex(c, a);
    if ((ab == INVALID_ID && splitAB)
      || (bc == INVALID_ID && splitBC)
      || (ca == INVALID_ID && splitCA)) {
      return false;
    }
    if (!_trimAppendSubdividedTri(a, b, c, ab, bc, ca)) return false;
  }
  _trimCopyNextToBase();
  return true;
}

function _trimRefineTriangles(segsU: i32, segsV: i32): void {
  if (_trimOriginalPointCount > 120) return;

  let uMin = unchecked(_planarU[0]);
  let uMax = uMin;
  let vMin = unchecked(_planarV[0]);
  let vMax = vMin;
  for (let i: u32 = 1; i < _planarPointCount; i++) {
    const u = unchecked(_planarU[i]);
    const v = unchecked(_planarV[i]);
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const uRange = uMax - uMin;
  const vRange = vMax - vMin;
  let target = segsU > segsV ? segsU : segsV;
  if (target < 24) target = 24;
  if (target > 64) target = 64;
  const maxRange = uRange > vRange ? uRange : vRange;
  if (maxRange <= 1e-12) return;
  const maxEdge = maxRange / <f64>target;
  const maxEdge2 = maxEdge * maxEdge;

  for (let pass: i32 = 0; pass < 4; pass++) {
    if (!_trimRefinePass(maxEdge2)) break;
    if (!_trimDidSplit) break;
  }
}

function _tessPlanarPolygonFace(faceId: u32, segsU: i32, nx: f64, ny: f64, nz: f64): i32 {
  if (!_collectPlanarLoops(faceId, segsU)) return -2;
  if (!_planarBuildBridgedPath()) return -2;

  const baseVert = outVertCount;
  const baseTri = outTriCount;
  for (let i: u32 = 0; i < _planarPointCount; i++) {
    const v = _emitVert(unchecked(_planarX[i]), unchecked(_planarY[i]), unchecked(_planarZ[i]), nx, ny, nz);
    if (v == INVALID_ID) {
      outVertCount = baseVert;
      outTriCount = baseTri;
      return -1;
    }
  }

  let remCount = _planarPathCount;
  if (remCount > MAX_PLANAR_PATH) return -1;
  for (let i: u32 = 0; i < remCount; i++) unchecked(_planarRemaining[i] = unchecked(_planarPath[i]));

  const pathArea = _planarPathArea();
  const winding: f64 = pathArea >= 0.0 ? 1.0 : -1.0;
  let triCount: i32 = 0;
  let guard: u32 = 0;
  const maxGuard = remCount * remCount + 16;

  while (remCount > 3 && guard < maxGuard) {
    let earFound = false;
    for (let ri: u32 = 0; ri < remCount; ri++) {
      const prevPos = (ri + remCount - 1) % remCount;
      const nextPos = (ri + 1) % remCount;
      const a = unchecked(_planarRemaining[prevPos]);
      const b = unchecked(_planarRemaining[ri]);
      const c = unchecked(_planarRemaining[nextPos]);
      const cross = _planarOrient(a, b, c) * winding;

      if (a == b || b == c) {
        for (let s: u32 = ri; s + 1 < remCount; s++) unchecked(_planarRemaining[s] = unchecked(_planarRemaining[s + 1]));
        remCount--;
        earFound = true;
        break;
      }
      if (a == c || Math.abs(cross) <= 1e-10) continue;
      if (cross < 0.0) continue;

      const cu = (unchecked(_planarU[a]) + unchecked(_planarU[b]) + unchecked(_planarU[c])) / 3.0;
      const cv = (unchecked(_planarV[a]) + unchecked(_planarV[b]) + unchecked(_planarV[c])) / 3.0;
      if (!_planarPointInsideTrim(cu, cv)) continue;

      let contains = false;
      for (let oi: u32 = 0; oi < remCount; oi++) {
        if (oi == prevPos || oi == ri || oi == nextPos) continue;
        const p = unchecked(_planarRemaining[oi]);
        if (_planarPointInTri(p, a, b, c, winding)) { contains = true; break; }
      }
      if (contains) continue;

      if (_emitPlaneTriOriented(baseVert + a, baseVert + b, baseVert + c, nx, ny, nz, faceId) < 0) {
        outVertCount = baseVert;
        outTriCount = baseTri;
        return -1;
      }
      triCount++;
      for (let s: u32 = ri; s + 1 < remCount; s++) unchecked(_planarRemaining[s] = unchecked(_planarRemaining[s + 1]));
      remCount--;
      earFound = true;
      break;
    }
    if (!earFound) {
      outVertCount = baseVert;
      outTriCount = baseTri;
      return -2;
    }
    guard++;
  }

  if (remCount != 3) {
    outVertCount = baseVert;
    outTriCount = baseTri;
    return -2;
  }

  const a = unchecked(_planarRemaining[0]);
  const b = unchecked(_planarRemaining[1]);
  const c = unchecked(_planarRemaining[2]);
  const cu = (unchecked(_planarU[a]) + unchecked(_planarU[b]) + unchecked(_planarU[c])) / 3.0;
  const cv = (unchecked(_planarV[a]) + unchecked(_planarV[b]) + unchecked(_planarV[c])) / 3.0;
  if (!_planarPointInsideTrim(cu, cv) || Math.abs(_planarOrient(a, b, c)) <= 1e-10) {
    outVertCount = baseVert;
    outTriCount = baseTri;
    return -2;
  }
  if (_emitPlaneTriOriented(baseVert + a, baseVert + b, baseVert + c, nx, ny, nz, faceId) < 0) {
    outVertCount = baseVert;
    outTriCount = baseTri;
    return -1;
  }
  triCount++;

  return triCount > 0 ? triCount : -2;
}

function _tessCircularPlaneFace(faceId: u32, segsU: i32, nx: f64, ny: f64, nz: f64): i32 {
  const nLoops = faceGetLoopCount(faceId);
  if (nLoops < 1 || nLoops > 2) return -2;
  const firstLoop = faceGetFirstLoop(faceId);
  const edge0 = _singleCircleLoopEdge(firstLoop);
  if (edge0 == INVALID_ID) return -2;

  let segs = segsU;
  if (segs < 32) segs = 32;
  if (segs > 512) segs = 512;

  if (nLoops == 1) {
    const off = edgeGetGeomOffset(edge0);
    const center = _emitVert(geomPoolRead(off), geomPoolRead(off + 1), geomPoolRead(off + 2), nx, ny, nz);
    if (center == INVALID_ID) return -1;
    const ringBase = outVertCount;
    for (let i: i32 = 0; i < segs; i++) {
      if (_emitCircleVertex(edge0, 2.0 * Math.PI * <f64>i / <f64>segs, nx, ny, nz) == INVALID_ID) return -1;
    }
    for (let i: i32 = 0; i < segs; i++) {
      const a = ringBase + <u32>i;
      const b = ringBase + <u32>((i + 1) % segs);
      if (_emitPlaneTriOriented(center, a, b, nx, ny, nz, faceId) < 0) return -1;
    }
    return segs;
  }

  const edge1 = _singleCircleLoopEdge(firstLoop + 1);
  if (edge1 == INVALID_ID) return -2;
  if (!_circleCentersCoincident(edge0, edge1)) return -2;

  const r0 = _circleRadius(edge0);
  const r1 = _circleRadius(edge1);
  if (Math.abs(r0 - r1) < 1e-10) return -2;
  const outer = r0 > r1 ? edge0 : edge1;
  const inner = r0 > r1 ? edge1 : edge0;

  const outerBase = outVertCount;
  for (let i: i32 = 0; i < segs; i++) {
    if (_emitCircleVertex(outer, 2.0 * Math.PI * <f64>i / <f64>segs, nx, ny, nz) == INVALID_ID) return -1;
  }
  const innerBase = outVertCount;
  for (let i: i32 = 0; i < segs; i++) {
    if (_emitCircleVertex(inner, 2.0 * Math.PI * <f64>i / <f64>segs, nx, ny, nz) == INVALID_ID) return -1;
  }
  for (let i: i32 = 0; i < segs; i++) {
    const next = (i + 1) % segs;
    const o0 = outerBase + <u32>i;
    const o1 = outerBase + <u32>next;
    const i0 = innerBase + <u32>i;
    const i1 = innerBase + <u32>next;
    if (_emitPlaneTriOriented(o0, o1, i1, nx, ny, nz, faceId) < 0) return -1;
    if (_emitPlaneTriOriented(o0, i1, i0, nx, ny, nz, faceId) < 0) return -1;
  }

  return segs * 2;
}

function _tessPlaneFace(faceId: u32, segsU: i32): i32 {
  _collectOuterLoopVerts(faceId);

  const gOff = faceGetGeomOffset(faceId);
  const reversed = faceGetOrient(faceId) == ORIENT_REVERSED;

  // Read plane normal from geometry pool
  let nx = geomPoolRead(gOff + 3);
  let ny = geomPoolRead(gOff + 4);
  let nz = geomPoolRead(gOff + 5);
  if (reversed) { nx = -nx; ny = -ny; nz = -nz; }

  const circular = _tessCircularPlaneFace(faceId, segsU, nx, ny, nz);
  if (circular != -2) return circular;

  _setPlaneProjection(gOff, nx, ny, nz);
  const polygon = _tessPlanarPolygonFace(faceId, segsU, nx, ny, nz);
  if (polygon != -2) return polygon;

  if (loopVertCount < 3) return 0;

  // Emit vertices
  const baseVert = outVertCount;
  for (let i: u32 = 0; i < loopVertCount; i++) {
    const vid = unchecked(loopVerts[i]);
    const v = _emitVert(
      vertexGetX(vid), vertexGetY(vid), vertexGetZ(vid),
      nx, ny, nz,
    );
    if (v == 0xFFFFFFFF) return -1;
  }

  // Fan triangulation
  const nTris = loopVertCount - 2;
  for (let i: u32 = 1; i <= nTris; i++) {
    if (reversed) {
      if (_emitTri(baseVert, baseVert + i + 1, baseVert + i, faceId) < 0) return -1;
    } else {
      if (_emitTri(baseVert, baseVert + i, baseVert + i + 1, faceId) < 0) return -1;
    }
  }

  return <i32>nTris;
}

function _tessFullRevolutionBand(
  faceId: u32, reversed: bool,
  segsU: i32, segsV: i32,
  surfType: i32,
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  radius: f64, semiAngle: f64,
  majorR: f64, minorR: f64
): i32 {
  if (_bndLoopCount != 2) return -2;
  const firstLoop = faceGetFirstLoop(faceId);
  if (_singleSelfLoopEdge(firstLoop) == INVALID_ID) return -2;
  if (_singleSelfLoopEdge(firstLoop + 1) == INVALID_ID) return -2;

  let su = segsU > 0 ? segsU : DEFAULT_SEGS;
  let sv = segsV > 0 ? segsV : DEFAULT_SEGS;
  if (su < 32) su = 32;
  if (sv < 1) sv = 1;

  const v0 = unchecked(_bndLoopFirstV[0]);
  const v1 = unchecked(_bndLoopFirstV[1]);
  if (Math.abs(v1 - v0) < 1e-10) return -2;

  let phase0 = unchecked(_bndLoopFirstU[0]);
  let phase1 = unchecked(_bndLoopFirstU[1]);
  while (phase1 - phase0 > Math.PI) phase1 -= 2.0 * Math.PI;
  while (phase1 - phase0 < -Math.PI) phase1 += 2.0 * Math.PI;

  const baseVert = outVertCount;
  let triCount: i32 = 0;

  for (let j: i32 = 0; j <= sv; j++) {
    const alpha = <f64>j / <f64>sv;
    const vParam = v0 + alpha * (v1 - v0);
    const rowPhase = phase0 + alpha * (phase1 - phase0);

    for (let i: i32 = 0; i <= su; i++) {
      const uActual = rowPhase + (<f64>i / <f64>su) * 2.0 * Math.PI;
      _evalSurface(surfType, uActual, vParam,
        ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
        radius, semiAngle, majorR, minorR);

      let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
      if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
      if (_emitVert(_surfX, _surfY, _surfZ, nx, ny, nz) == INVALID_ID) return -1;
    }
  }

  for (let j: i32 = 0; j < sv; j++) {
    for (let i: i32 = 0; i < su; i++) {
      const i00 = baseVert + <u32>(j * (su + 1) + i);
      const i10 = baseVert + <u32>((j + 1) * (su + 1) + i);
      const i11 = baseVert + <u32>((j + 1) * (su + 1) + i + 1);
      const i01 = baseVert + <u32>(j * (su + 1) + i + 1);
      if (reversed) {
        if (_emitTri(i00, i10, i11, faceId) < 0) return -1;
        if (_emitTri(i00, i11, i01, faceId) < 0) return -1;
      } else {
        if (_emitTri(i00, i11, i10, faceId) < 0) return -1;
        if (_emitTri(i00, i01, i11, faceId) < 0) return -1;
      }
      triCount += 2;
    }
  }

  return triCount;
}

function _tessConeApexFace(
  faceId: u32, reversed: bool,
  segsU: i32,
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  radius: f64, semiAngle: f64
): i32 {
  if (_bndLoopCount != 1) return -2;
  const firstLoop = faceGetFirstLoop(faceId);
  if (_singleSelfLoopEdge(firstLoop) == INVALID_ID) return -2;

  const tanSA = Math.tan(semiAngle);
  if (Math.abs(tanSA) < 1e-12) return -2;
  const apexV = -radius / tanSA;
  const ringV = unchecked(_bndLoopFirstV[0]);
  if (Math.abs(ringV - apexV) < 1e-10) return -2;

  let su = segsU > 0 ? segsU : DEFAULT_SEGS;
  if (su < 32) su = 32;

  const phase = unchecked(_bndLoopFirstU[0]);

  _evalSurface(2, phase, apexV,
    ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
    radius, semiAngle, 0.0, 0.0);
  let anx = _surfNX, any = _surfNY, anz = _surfNZ;
  if (reversed) { anx = -anx; any = -any; anz = -anz; }
  const apex = _emitVert(_surfX, _surfY, _surfZ, anx, any, anz);
  if (apex == INVALID_ID) return -1;

  const ringBase = outVertCount;
  for (let i: i32 = 0; i <= su; i++) {
    const uActual = phase + (<f64>i / <f64>su) * 2.0 * Math.PI;
    _evalSurface(2, uActual, ringV,
      ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, semiAngle, 0.0, 0.0);
    let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
    if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
    if (_emitVert(_surfX, _surfY, _surfZ, nx, ny, nz) == INVALID_ID) return -1;
  }

  for (let i: i32 = 0; i < su; i++) {
    const a = ringBase + <u32>i;
    const b = ringBase + <u32>(i + 1);
    if (reversed) {
      if (_emitTri(apex, a, b, faceId) < 0) return -1;
    } else {
      if (_emitTri(apex, b, a, faceId) < 0) return -1;
    }
  }

  return su;
}

function _paramAppendPoint(x: f64, y: f64, z: f64, loopStart: u32): bool {
  if (_planarPointCount >= MAX_PLANAR_PTS) return false;
  if (_planarPointCount > loopStart) {
    const prev = _planarPointCount - 1;
    const dx = x - unchecked(_planarX[prev]);
    const dy = y - unchecked(_planarY[prev]);
    const dz = z - unchecked(_planarZ[prev]);
    if (dx * dx + dy * dy + dz * dz < 1e-20) return true;
  }

  _projectPoint(x, y, z);
  let u = _projU;
  if (_planarPointCount > loopStart) u = _wrapPeriodicNear(u, unchecked(_planarU[_planarPointCount - 1]));

  unchecked(_planarX[_planarPointCount] = x);
  unchecked(_planarY[_planarPointCount] = y);
  unchecked(_planarZ[_planarPointCount] = z);
  unchecked(_planarU[_planarPointCount] = u);
  unchecked(_planarV[_planarPointCount] = _projV);
  _planarPointCount++;
  return true;
}

function _paramAppendVertex(vertexId: u32, loopStart: u32): bool {
  return _paramAppendPoint(vertexGetX(vertexId), vertexGetY(vertexId), vertexGetZ(vertexId), loopStart);
}

function _paramAppendLineCoedge(edgeId: u32, orient: u8, loopStart: u32): bool {
  const startV = orient == ORIENT_REVERSED ? edgeGetEndVertex(edgeId) : edgeGetStartVertex(edgeId);
  const endV = orient == ORIENT_REVERSED ? edgeGetStartVertex(edgeId) : edgeGetEndVertex(edgeId);
  return _paramAppendVertex(startV, loopStart) && _paramAppendVertex(endV, loopStart);
}

function _paramAppendNurbsCoedge(edgeId: u32, orient: u8, segsU: i32, loopStart: u32): bool {
  if (!_loadCurve(edgeGetGeomOffset(edgeId))) return _paramAppendLineCoedge(edgeId, orient, loopStart);
  let segs = segsU;
  if (_crvDeg == 1 && _crvNCtrl == 2) segs = 1;
  else if (segs < 16) segs = 16;
  if (segs > 192) segs = 192;

  const startV = orient == ORIENT_REVERSED ? edgeGetEndVertex(edgeId) : edgeGetStartVertex(edgeId);
  const endV = orient == ORIENT_REVERSED ? edgeGetStartVertex(edgeId) : edgeGetEndVertex(edgeId);
  for (let i: i32 = 0; i <= segs; i++) {
    if (i == 0) {
      if (!_paramAppendVertex(startV, loopStart)) return false;
      continue;
    }
    if (i == segs) {
      if (!_paramAppendVertex(endV, loopStart)) return false;
      continue;
    }
    let frac = <f64>i / <f64>segs;
    if (orient == ORIENT_REVERSED) frac = 1.0 - frac;
    const t = _crvTmin + frac * (_crvTmax - _crvTmin);
    nurbsCurveEvaluate(_crvDeg, _crvNCtrl, _crvCtrl, _crvKnots, _crvWts, t);
    const rp = getResultPtr();
    if (!_paramAppendPoint(load<f64>(rp), load<f64>(rp + 8), load<f64>(rp + 16), loopStart)) return false;
  }
  return true;
}

function _paramAppendCircleCoedge(edgeId: u32, orient: u8, segsU: i32, loopStart: u32): bool {
  let segs = segsU;
  if (segs < 32) segs = 32;
  if (segs > 192) segs = 192;

  const off = edgeGetGeomOffset(edgeId);
  const cx = geomPoolRead(off);
  const cy = geomPoolRead(off + 1);
  const cz = geomPoolRead(off + 2);
  const ax = geomPoolRead(off + 3);
  const ay = geomPoolRead(off + 4);
  const az = geomPoolRead(off + 5);
  const rx = geomPoolRead(off + 6);
  const ry = geomPoolRead(off + 7);
  const rz = geomPoolRead(off + 8);
  const radius = geomPoolRead(off + 9);
  const bx = ay * rz - az * ry;
  const by = az * rx - ax * rz;
  const bz = ax * ry - ay * rx;
  const startV = edgeGetStartVertex(edgeId);
  const endV = edgeGetEndVertex(edgeId);
  const coStart = orient == ORIENT_REVERSED ? endV : startV;
  const coEnd = orient == ORIENT_REVERSED ? startV : endV;
  const startAngle = _circleAngleAtVertex(edgeId, startV);
  const endAngle = _circleAngleAtVertex(edgeId, endV);
  const sweep = _directedPeriodicSweep(startAngle, endAngle, edgeGetCurveSameSense(edgeId) != 0, startV == endV);

  for (let i: i32 = 0; i <= segs; i++) {
    if (i == 0) {
      if (!_paramAppendVertex(coStart, loopStart)) return false;
      continue;
    }
    if (i == segs) {
      if (!_paramAppendVertex(coEnd, loopStart)) return false;
      continue;
    }
    let frac = <f64>i / <f64>segs;
    if (orient == ORIENT_REVERSED) frac = 1.0 - frac;
    const theta = startAngle + frac * sweep;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    if (!_paramAppendPoint(
      cx + radius * (rx * c + bx * s),
      cy + radius * (ry * c + by * s),
      cz + radius * (rz * c + bz * s),
      loopStart,
    )) return false;
  }
  return true;
}

function _collectParametricTrimLoops(faceId: u32, segsU: i32): bool {
  _planarPointCount = 0;
  _planarLoopCount = 0;
  _planarPathCount = 0;

  const firstLoop = faceGetFirstLoop(faceId);
  const nLoops = faceGetLoopCount(faceId);
  for (let l: u32 = 0; l < nLoops; l++) {
    if (_planarLoopCount >= MAX_PLANAR_LOOPS) return false;
    const loopId = firstLoop + l;
    const loopStart = _planarPointCount;
    const firstCE = loopGetFirstCoedge(loopId);
    let ce = firstCE;
    let guard: u32 = 0;

    do {
      const eid = coedgeGetEdge(ce);
      const orient = coedgeGetOrient(ce);
      _cacheEdgeSamples(eid);
      const geomType = edgeGetGeomType(eid);
      if (geomType == GEOM_CIRCLE) {
        if (!_paramAppendCircleCoedge(eid, orient, segsU, loopStart)) return false;
      } else if (geomType == GEOM_NURBS_CURVE) {
        if (!_paramAppendNurbsCoedge(eid, orient, segsU, loopStart)) return false;
      } else {
        if (!_paramAppendLineCoedge(eid, orient, loopStart)) return false;
      }
      ce = coedgeGetNext(ce);
      guard++;
    } while (ce != firstCE && guard < 65536);

    if (_planarPointCount > loopStart + 1) {
      const last = _planarPointCount - 1;
      const dx = unchecked(_planarX[last]) - unchecked(_planarX[loopStart]);
      const dy = unchecked(_planarY[last]) - unchecked(_planarY[loopStart]);
      const dz = unchecked(_planarZ[last]) - unchecked(_planarZ[loopStart]);
      if (dx * dx + dy * dy + dz * dz < 1e-20) _planarPointCount--;
    }

    if (_planarPointCount - loopStart >= 3) {
      unchecked(_planarLoopStart[_planarLoopCount] = loopStart);
      unchecked(_planarLoopEnd[_planarLoopCount] = _planarPointCount);
      _planarLoopCount++;
    } else {
      _planarPointCount = loopStart;
    }
  }

  return _planarLoopCount > 0 && _planarPointCount >= 3;
}

function _emitAnalyticBoundaryPoint(
  pointId: u32,
  surfType: i32,
  reversed: bool,
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  radius: f64, semiAngle: f64,
  majorR: f64, minorR: f64,
): u32 {
  _evalSurface(surfType, unchecked(_planarU[pointId]), unchecked(_planarV[pointId]),
    ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
    radius, semiAngle, majorR, minorR);
  let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
  if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
  const x = pointId < _trimOriginalPointCount ? unchecked(_planarX[pointId]) : _surfX;
  const y = pointId < _trimOriginalPointCount ? unchecked(_planarY[pointId]) : _surfY;
  const z = pointId < _trimOriginalPointCount ? unchecked(_planarZ[pointId]) : _surfZ;
  return _emitVert(
    x,
    y,
    z,
    nx, ny, nz,
  );
}

function _emitAnalyticInteriorPoint(
  u: f64,
  v: f64,
  surfType: i32,
  reversed: bool,
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  radius: f64, semiAngle: f64,
  majorR: f64, minorR: f64,
): u32 {
  _evalSurface(surfType, u, v,
    ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
    radius, semiAngle, majorR, minorR);
  let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
  if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
  return _emitVert(_surfX, _surfY, _surfZ, nx, ny, nz);
}

function _emitAnalyticTrimTriangle(
  a: u32,
  b: u32,
  c: u32,
  faceId: u32,
  surfType: i32,
  reversed: bool,
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  radius: f64, semiAngle: f64,
  majorR: f64, minorR: f64,
): i32 {
  if (Math.abs(_planarOrient(a, b, c)) <= 1e-14) return 0;
  const ia = unchecked(_planarOutVert[a]);
  const ib = unchecked(_planarOutVert[b]);
  const ic = unchecked(_planarOutVert[c]);
  const cu = (unchecked(_planarU[a]) + unchecked(_planarU[b]) + unchecked(_planarU[c])) / 3.0;
  const cv = (unchecked(_planarV[a]) + unchecked(_planarV[b]) + unchecked(_planarV[c])) / 3.0;
  const center = _emitAnalyticInteriorPoint(cu, cv, surfType, reversed,
    ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
    radius, semiAngle, majorR, minorR);
  if (center == INVALID_ID) return -1;
  if (_emitAnalyticTriOriented(ia, ib, center, faceId, reversed, surfType,
    ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
    radius, semiAngle, majorR, minorR) < 0) return -1;
  if (_emitAnalyticTriOriented(ib, ic, center, faceId, reversed, surfType,
    ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
    radius, semiAngle, majorR, minorR) < 0) return -1;
  if (_emitAnalyticTriOriented(ic, ia, center, faceId, reversed, surfType,
    ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
    radius, semiAngle, majorR, minorR) < 0) return -1;
  return 3;
}

function _tessTrimmedAnalyticBoundaryFace(
  faceId: u32,
  reversed: bool,
  segsU: i32,
  surfType: i32,
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  radius: f64, semiAngle: f64,
  majorR: f64, minorR: f64,
): i32 {
  const baseVert = outVertCount;
  const baseTri = outTriCount;
  if (!_collectParametricTrimLoops(faceId, segsU)) return -2;
  if (!_planarBuildBridgedPath()) return -2;
  _trimOriginalPointCount = _planarPointCount;
  if (!_buildTrimBaseTrianglesFromPath()) return -2;
  _trimRefineTriangles(segsU, segsU);

  for (let i: u32 = 0; i < _planarPointCount; i++) {
    const outId = _emitAnalyticBoundaryPoint(i, surfType, reversed,
      ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, semiAngle, majorR, minorR);
    if (outId == INVALID_ID) {
      outVertCount = baseVert;
      outTriCount = baseTri;
      return -1;
    }
    unchecked(_planarOutVert[i] = outId);
  }

  let triCount: i32 = 0;
  for (let i: u32 = 0; i < _trimTriCount; i++) {
    const ia = unchecked(_planarOutVert[unchecked(_trimTriA[i])]);
    const ib = unchecked(_planarOutVert[unchecked(_trimTriB[i])]);
    const ic = unchecked(_planarOutVert[unchecked(_trimTriC[i])]);
    if (_emitAnalyticTriOriented(ia, ib, ic, faceId, reversed, surfType,
      ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, semiAngle, majorR, minorR) < 0) {
      outVertCount = baseVert;
      outTriCount = baseTri;
      return -1;
    }
    triCount++;
  }

  return triCount > 0 ? triCount : -2;
}

// ─── Cylinder face tessellation ──────────────────────────────────────

function _tessCylinderFace(faceId: u32, segsU: i32, segsV: i32): i32 {
  const gOff = faceGetGeomOffset(faceId);
  const reversed = faceGetOrient(faceId) == ORIENT_REVERSED;

  // Read cylinder params: origin(3), axis(3), refDir(3), radius(1)
  const ox = geomPoolRead(gOff);
  const oy = geomPoolRead(gOff + 1);
  const oz = geomPoolRead(gOff + 2);
  const ax = geomPoolRead(gOff + 3);
  const ay = geomPoolRead(gOff + 4);
  const az = geomPoolRead(gOff + 5);
  const rx = geomPoolRead(gOff + 6);
  const ry = geomPoolRead(gOff + 7);
  const rz = geomPoolRead(gOff + 8);
  const radius = geomPoolRead(gOff + 9);

  // Compute binormal = axis × refDir
  const bx = ay * rz - az * ry;
  const by = az * rx - ax * rz;
  const bz = ax * ry - ay * rx;

  // Setup UV projection: revolution surface (u=angle, v=height)
  _projMode = 0;
  _proj_ox = ox; _proj_oy = oy; _proj_oz = oz;
  _proj_ax = ax; _proj_ay = ay; _proj_az = az;
  _proj_rx = rx; _proj_ry = ry; _proj_rz = rz;
  _proj_bx = bx; _proj_by = by; _proj_bz = bz;

  _collectBoundaryUV(faceId);
  const ruledQuad = _tessRuledCircleQuadFace(faceId, reversed, segsU,
    1, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, 0.0, 0.0, 0.0);
  if (ruledQuad != -2) return ruledQuad;
  const filletStrip = _tessCylinderCurvedBoundaryStripFace(faceId, reversed, segsU,
    ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius);
  if (filletStrip != -2) return filletStrip;
  const analyticRuledQuad = _tessAnalyticRuledBoundaryQuadFace(faceId, reversed, segsU,
    1, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, 0.0, 0.0, 0.0);
  if (analyticRuledQuad != -2) return analyticRuledQuad;
  const fullBand = _tessFullRevolutionBand(faceId, reversed, segsU, segsV,
    1, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, 0.0, 0.0, 0.0);
  if (fullBand != -2) return fullBand;

  const boundaryFace = _tessTrimmedAnalyticBoundaryFace(faceId, reversed, segsU,
    1, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, 0.0, 0.0, 0.0);
  if (boundaryFace != -2) return boundaryFace;

  if (_uvVmax - _uvVmin < 1e-10 || _uvUmax - _uvUmin < 1e-10) return 0;

  let cylSegsU = segsU;
  if (!_trimEnabled && Math.abs((_uvUmax - _uvUmin) - 2.0 * Math.PI) < 0.01 && cylSegsU < 32) {
    cylSegsU = 32;
  }

  return _tessTrimmedParametricGrid(faceId, reversed, cylSegsU, segsV,
    1, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, 0.0, 0.0, 0.0);
}

function _tessCylinderCurvedBoundaryStripFace(
  faceId: u32, reversed: bool, segsU: i32,
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  radius: f64,
): i32 {
  if (faceGetLoopCount(faceId) != 1) return -2;
  const loopId = faceGetFirstLoop(faceId);
  const ce0 = loopGetFirstCoedge(loopId);
  const ce1 = coedgeGetNext(ce0);
  const ce2 = coedgeGetNext(ce1);
  const ce3 = coedgeGetNext(ce2);
  if (coedgeGetNext(ce3) != ce0) return -2;

  const ceIds = new StaticArray<u32>(4);
  unchecked(ceIds[0] = ce0);
  unchecked(ceIds[1] = ce1);
  unchecked(ceIds[2] = ce2);
  unchecked(ceIds[3] = ce3);

  let curvedAIdx: i32 = -1;
  let curvedBIdx: i32 = -1;
  let lineCount: i32 = 0;
  let curvedCount: i32 = 0;
  for (let i: i32 = 0; i < 4; i++) {
    const eid = coedgeGetEdge(unchecked(ceIds[i]));
    if (edgeGetStartVertex(eid) == edgeGetEndVertex(eid)) return -2;
    const isLine = edgeGetGeomType(eid) == GEOM_LINE;
    if (isLine) {
      lineCount++;
    } else {
      if (curvedAIdx < 0) curvedAIdx = i;
      else curvedBIdx = i;
      curvedCount++;
    }
  }
  if (lineCount != 2 || curvedCount != 2) return -2;
  if (curvedAIdx < 0 || curvedBIdx < 0) return -2;
  if (((curvedBIdx - curvedAIdx + 4) & 3) != 2) return -2;

  let su = segsU > 0 ? segsU : DEFAULT_SEGS;
  if (su < 32) su = 32;
  const edgeA = coedgeGetEdge(unchecked(ceIds[curvedAIdx]));
  const edgeB = coedgeGetEdge(unchecked(ceIds[curvedBIdx]));
  const minA = _edgeRowMinSegments(edgeGetGeomType(edgeA));
  const minB = _edgeRowMinSegments(edgeGetGeomType(edgeB));
  if (su < minA) su = minA;
  if (su < minB) su = minB;
  if (su + 1 > RULED_QUAD_MAX_SAMPLES) su = RULED_QUAD_MAX_SAMPLES - 1;

  if (!_sampleCoedgeRow(edgeA, coedgeGetOrient(unchecked(ceIds[curvedAIdx])), su, ruledQuadRowA)) return -2;
  if (!_sampleCoedgeRow(edgeB, coedgeGetOrient(unchecked(ceIds[curvedBIdx])), su, ruledQuadRowB)) return -2;

  const end = su * 3;
  const directDx0 = unchecked(ruledQuadRowA[0]) - unchecked(ruledQuadRowB[0]);
  const directDy0 = unchecked(ruledQuadRowA[1]) - unchecked(ruledQuadRowB[1]);
  const directDz0 = unchecked(ruledQuadRowA[2]) - unchecked(ruledQuadRowB[2]);
  const directDx1 = unchecked(ruledQuadRowA[end]) - unchecked(ruledQuadRowB[end]);
  const directDy1 = unchecked(ruledQuadRowA[end + 1]) - unchecked(ruledQuadRowB[end + 1]);
  const directDz1 = unchecked(ruledQuadRowA[end + 2]) - unchecked(ruledQuadRowB[end + 2]);
  const reverseDx0 = unchecked(ruledQuadRowA[0]) - unchecked(ruledQuadRowB[end]);
  const reverseDy0 = unchecked(ruledQuadRowA[1]) - unchecked(ruledQuadRowB[end + 1]);
  const reverseDz0 = unchecked(ruledQuadRowA[2]) - unchecked(ruledQuadRowB[end + 2]);
  const reverseDx1 = unchecked(ruledQuadRowA[end]) - unchecked(ruledQuadRowB[0]);
  const reverseDy1 = unchecked(ruledQuadRowA[end + 1]) - unchecked(ruledQuadRowB[1]);
  const reverseDz1 = unchecked(ruledQuadRowA[end + 2]) - unchecked(ruledQuadRowB[2]);
  const reverseB = reverseDx0 * reverseDx0 + reverseDy0 * reverseDy0 + reverseDz0 * reverseDz0
    + reverseDx1 * reverseDx1 + reverseDy1 * reverseDy1 + reverseDz1 * reverseDz1
    < directDx0 * directDx0 + directDy0 * directDy0 + directDz0 * directDz0
      + directDx1 * directDx1 + directDy1 * directDy1 + directDz1 * directDz1;
  if (reverseB) _reverseRuledRow(ruledQuadRowB, su);

  const baseA = outVertCount;
  for (let i: i32 = 0; i <= su; i++) {
    const p = i * 3;
    _projectPoint(unchecked(ruledQuadRowA[p]), unchecked(ruledQuadRowA[p + 1]), unchecked(ruledQuadRowA[p + 2]));
    _evalSurface(1, _projU, _projV,
      ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, 0.0, 0.0, 0.0);
    let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
    if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
    if (_ruledRowEmit(ruledQuadRowA, i, nx, ny, nz) == INVALID_ID) return -1;
  }

  const baseB = outVertCount;
  for (let i: i32 = 0; i <= su; i++) {
    const p = i * 3;
    _projectPoint(unchecked(ruledQuadRowB[p]), unchecked(ruledQuadRowB[p + 1]), unchecked(ruledQuadRowB[p + 2]));
    _evalSurface(1, _projU, _projV,
      ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, 0.0, 0.0, 0.0);
    let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
    if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
    if (_ruledRowEmit(ruledQuadRowB, i, nx, ny, nz) == INVALID_ID) return -1;
  }

  let triCount: i32 = 0;
  for (let i: i32 = 0; i < su; i++) {
    const a0 = baseA + <u32>i;
    const a1 = baseA + <u32>(i + 1);
    const b0 = baseB + <u32>i;
    const b1 = baseB + <u32>(i + 1);
    if (_emitAnalyticTriOriented(a0, a1, b0, faceId, reversed,
      1, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, 0.0, 0.0, 0.0) < 0) return -1;
    if (_emitAnalyticTriOriented(b0, a1, b1, faceId, reversed,
      1, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
      radius, 0.0, 0.0, 0.0) < 0) return -1;
    triCount += 2;
  }

  return triCount;
}

// ─── Cone face tessellation ──────────────────────────────────────────

function _tessConeFace(faceId: u32, segsU: i32, segsV: i32): i32 {
  const gOff = faceGetGeomOffset(faceId);
  const reversed = faceGetOrient(faceId) == ORIENT_REVERSED;

  const ox = geomPoolRead(gOff);
  const oy = geomPoolRead(gOff + 1);
  const oz = geomPoolRead(gOff + 2);
  const ax = geomPoolRead(gOff + 3);
  const ay = geomPoolRead(gOff + 4);
  const az = geomPoolRead(gOff + 5);
  const rx = geomPoolRead(gOff + 6);
  const ry = geomPoolRead(gOff + 7);
  const rz = geomPoolRead(gOff + 8);
  const radius = geomPoolRead(gOff + 9);
  const semiAngle = geomPoolRead(gOff + 10);

  const bx = ay * rz - az * ry;
  const by = az * rx - ax * rz;
  const bz = ax * ry - ay * rx;

  // Setup UV projection: revolution surface (u=angle, v=height)
  _projMode = 0;
  _proj_ox = ox; _proj_oy = oy; _proj_oz = oz;
  _proj_ax = ax; _proj_ay = ay; _proj_az = az;
  _proj_rx = rx; _proj_ry = ry; _proj_rz = rz;
  _proj_bx = bx; _proj_by = by; _proj_bz = bz;

  _collectBoundaryUV(faceId);
  const ruledQuad = _tessRuledCircleQuadFace(faceId, reversed, segsU,
    2, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, semiAngle, 0.0, 0.0);
  if (ruledQuad != -2) return ruledQuad;
  const apexFace = _tessConeApexFace(faceId, reversed, segsU,
    ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, semiAngle);
  if (apexFace != -2) return apexFace;

  const boundaryFace = _tessTrimmedAnalyticBoundaryFace(faceId, reversed, segsU,
    2, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, semiAngle, 0.0, 0.0);
  if (boundaryFace != -2) return boundaryFace;

  if (_uvVmax - _uvVmin < 1e-10 || _uvUmax - _uvUmin < 1e-10) return 0;

  return _tessTrimmedParametricGrid(faceId, reversed, segsU, segsV,
    2, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, semiAngle, 0.0, 0.0);
}

// ─── Sphere face tessellation ────────────────────────────────────────

function _tessSphereFace(faceId: u32, segsU: i32, segsV: i32): i32 {
  const gOff = faceGetGeomOffset(faceId);
  const reversed = faceGetOrient(faceId) == ORIENT_REVERSED;

  // Read sphere params: center(3) + axis(3) + refDir(3) + radius(1)
  const cx = geomPoolRead(gOff);
  const cy = geomPoolRead(gOff + 1);
  const cz = geomPoolRead(gOff + 2);
  const ax = geomPoolRead(gOff + 3);
  const ay = geomPoolRead(gOff + 4);
  const az = geomPoolRead(gOff + 5);
  const rx = geomPoolRead(gOff + 6);
  const ry = geomPoolRead(gOff + 7);
  const rz = geomPoolRead(gOff + 8);
  const radius = geomPoolRead(gOff + 9);

  // Compute binormal = axis × refDir
  const bx = ay * rz - az * ry;
  const by = az * rx - ax * rz;
  const bz = ax * ry - ay * rx;

  // Setup UV projection: sphere as revolution surface (u=longitude, v=latitude)
  _projMode = 1;
  _proj_ox = cx; _proj_oy = cy; _proj_oz = cz;
  _proj_ax = ax; _proj_ay = ay; _proj_az = az;
  _proj_rx = rx; _proj_ry = ry; _proj_rz = rz;
  _proj_bx = bx; _proj_by = by; _proj_bz = bz;

  _collectBoundaryUV(faceId);

  // For degenerate boundaries (e.g. full sphere), expand to full domain
  if (!_trimEnabled) {
    if (_uvVmax - _uvVmin < 1e-10) {
      _uvVmin = -Math.PI / 2.0;
      _uvVmax = Math.PI / 2.0;
    }
  }

  if (_uvVmax - _uvVmin < 1e-10 || _uvUmax - _uvUmin < 1e-10) return 0;

  const boundaryFace = _tessTrimmedAnalyticBoundaryFace(faceId, reversed, segsU,
    3, cx, cy, cz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, 0.0, 0.0, 0.0);
  if (boundaryFace != -2) return boundaryFace;

  return _tessTrimmedParametricGrid(faceId, reversed, segsU, segsV,
    3, cx, cy, cz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, 0.0, 0.0, 0.0);
}

// ─── Torus face tessellation ─────────────────────────────────────────

function _tessTorusFace(faceId: u32, segsU: i32, segsV: i32): i32 {
  const gOff = faceGetGeomOffset(faceId);
  const reversed = faceGetOrient(faceId) == ORIENT_REVERSED;

  const cx = geomPoolRead(gOff);
  const cy = geomPoolRead(gOff + 1);
  const cz = geomPoolRead(gOff + 2);
  const ax = geomPoolRead(gOff + 3);
  const ay = geomPoolRead(gOff + 4);
  const az = geomPoolRead(gOff + 5);
  const rx = geomPoolRead(gOff + 6);
  const ry = geomPoolRead(gOff + 7);
  const rz = geomPoolRead(gOff + 8);
  const majorR = geomPoolRead(gOff + 9);
  const minorR = geomPoolRead(gOff + 10);

  // Binormal = axis × refDir
  const bx = ay * rz - az * ry;
  const by = az * rx - ax * rz;
  const bz = ax * ry - ay * rx;

  // Setup UV projection: torus (u=major angle, v=minor angle)
  _projMode = 2;
  _proj_ox = cx; _proj_oy = cy; _proj_oz = cz;
  _proj_ax = ax; _proj_ay = ay; _proj_az = az;
  _proj_rx = rx; _proj_ry = ry; _proj_rz = rz;
  _proj_bx = bx; _proj_by = by; _proj_bz = bz;
  _proj_majorR = majorR;

  _collectBoundaryUV(faceId);

  // For degenerate boundaries (e.g. full torus), expand V to full domain
  if (!_trimEnabled) {
    if (_uvVmax - _uvVmin < 1e-10) {
      _uvVmin = -Math.PI;
      _uvVmax = Math.PI;
    }
  }

  if (_uvVmax - _uvVmin < 1e-10 || _uvUmax - _uvUmin < 1e-10) return 0;

  let torusSegsU = segsU;
  let torusSegsV = segsV;
  if (!_trimEnabled && _bndLoopCount >= 2 && Math.abs((_uvUmax - _uvUmin) - 2.0 * Math.PI) < 0.01) {
    // Phase-blended full-revolution trims can be watertight but twisted at
    // coarse quality.  Refine just these torus bands; native tessellation is
    // still millisecond-scale and avoids the much slower robust JS fallback.
    if (torusSegsU < 32) torusSegsU = 32;
    if (torusSegsV < 32) torusSegsV = 32;
  }

  const torusPatch = _tessTorusFourCircleFace(faceId, reversed, torusSegsU, torusSegsV,
    cx, cy, cz, ax, ay, az, rx, ry, rz, bx, by, bz, majorR, minorR);
  if (torusPatch != -2) return torusPatch;

  const boundaryFace = _tessTrimmedAnalyticBoundaryFace(faceId, reversed, torusSegsU,
    4, cx, cy, cz, ax, ay, az, rx, ry, rz, bx, by, bz, 0.0, 0.0, majorR, minorR);
  if (boundaryFace != -2) return boundaryFace;

  return _tessTrimmedParametricGrid(faceId, reversed, torusSegsU, torusSegsV,
    4, cx, cy, cz, ax, ay, az, rx, ry, rz, bx, by, bz, 0.0, 0.0, majorR, minorR);
}

// ─── NURBS face tessellation ─────────────────────────────────────────

function _edgeRowMinSegments(edgeType: u8): i32 {
  if (edgeType == GEOM_CIRCLE) return 32;
  if (edgeType == GEOM_NURBS_CURVE) return 8;
  return 1;
}

function _tessNurbsRuledBoundaryQuadFace(
  faceId: u32,
  segsU: i32,
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
  reversed: bool,
): i32 {
  const surfaceIsRuled = (degU == 1 && numCtrlU == 2) || (degV == 1 && numCtrlV == 2);
  if (!surfaceIsRuled) return -2;
  if (faceGetLoopCount(faceId) != 1) return -2;

  const loopId = faceGetFirstLoop(faceId);
  const ce0 = loopGetFirstCoedge(loopId);
  const ce1 = coedgeGetNext(ce0);
  const ce2 = coedgeGetNext(ce1);
  const ce3 = coedgeGetNext(ce2);
  if (coedgeGetNext(ce3) != ce0) return -2;

  const edge0 = coedgeGetEdge(ce0);
  const edge1 = coedgeGetEdge(ce1);
  const edge2 = coedgeGetEdge(ce2);
  const edge3 = coedgeGetEdge(ce3);
  if (edgeGetStartVertex(edge0) == edgeGetEndVertex(edge0)) return -2;
  if (edgeGetStartVertex(edge1) == edgeGetEndVertex(edge1)) return -2;
  if (edgeGetStartVertex(edge2) == edgeGetEndVertex(edge2)) return -2;
  if (edgeGetStartVertex(edge3) == edgeGetEndVertex(edge3)) return -2;

  const type0 = edgeGetGeomType(edge0);
  const type1 = edgeGetGeomType(edge1);
  const type2 = edgeGetGeomType(edge2);
  const type3 = edgeGetGeomType(edge3);
  const line0 = type0 == GEOM_LINE;
  const line1 = type1 == GEOM_LINE;
  const line2 = type2 == GEOM_LINE;
  const line3 = type3 == GEOM_LINE;
  const rail0 = type0 == GEOM_CIRCLE || type0 == GEOM_NURBS_CURVE;
  const rail1 = type1 == GEOM_CIRCLE || type1 == GEOM_NURBS_CURVE;
  const rail2 = type2 == GEOM_CIRCLE || type2 == GEOM_NURBS_CURVE;
  const rail3 = type3 == GEOM_CIRCLE || type3 == GEOM_NURBS_CURVE;
  const lineCount = (line0 ? 1 : 0) + (line1 ? 1 : 0) + (line2 ? 1 : 0) + (line3 ? 1 : 0);
  const railCount = (rail0 ? 1 : 0) + (rail1 ? 1 : 0) + (rail2 ? 1 : 0) + (rail3 ? 1 : 0);
  if (lineCount != 2 || railCount != 2) return -2;

  let railAEdge: u32 = INVALID_ID;
  let railBEdge: u32 = INVALID_ID;
  let railAOrient: u8 = 0;
  let railBOrient: u8 = 0;
  let railAType: u8 = GEOM_LINE;
  let railBType: u8 = GEOM_LINE;
  if (rail0 && rail2) {
    railAEdge = edge0; railAOrient = coedgeGetOrient(ce0); railAType = type0;
    railBEdge = edge2; railBOrient = coedgeGetOrient(ce2); railBType = type2;
  } else if (rail1 && rail3) {
    railAEdge = edge1; railAOrient = coedgeGetOrient(ce1); railAType = type1;
    railBEdge = edge3; railBOrient = coedgeGetOrient(ce3); railBType = type3;
  } else {
    return -2;
  }

  let su = segsU > 0 ? segsU : DEFAULT_SEGS;
  const minA = _edgeRowMinSegments(railAType);
  const minB = _edgeRowMinSegments(railBType);
  if (su < minA) su = minA;
  if (su < minB) su = minB;
  if (su + 1 > RULED_QUAD_MAX_SAMPLES) su = RULED_QUAD_MAX_SAMPLES - 1;

  if (!_sampleCoedgeRow(railAEdge, railAOrient, su, ruledQuadRowA)) return -2;
  if (!_sampleCoedgeRow(railBEdge, railBOrient, su, ruledQuadRowB)) return -2;

  const end = su * 3;
  const directDx0 = unchecked(ruledQuadRowA[0]) - unchecked(ruledQuadRowB[0]);
  const directDy0 = unchecked(ruledQuadRowA[1]) - unchecked(ruledQuadRowB[1]);
  const directDz0 = unchecked(ruledQuadRowA[2]) - unchecked(ruledQuadRowB[2]);
  const directDx1 = unchecked(ruledQuadRowA[end]) - unchecked(ruledQuadRowB[end]);
  const directDy1 = unchecked(ruledQuadRowA[end + 1]) - unchecked(ruledQuadRowB[end + 1]);
  const directDz1 = unchecked(ruledQuadRowA[end + 2]) - unchecked(ruledQuadRowB[end + 2]);
  const reverseDx0 = unchecked(ruledQuadRowA[0]) - unchecked(ruledQuadRowB[end]);
  const reverseDy0 = unchecked(ruledQuadRowA[1]) - unchecked(ruledQuadRowB[end + 1]);
  const reverseDz0 = unchecked(ruledQuadRowA[2]) - unchecked(ruledQuadRowB[end + 2]);
  const reverseDx1 = unchecked(ruledQuadRowA[end]) - unchecked(ruledQuadRowB[0]);
  const reverseDy1 = unchecked(ruledQuadRowA[end + 1]) - unchecked(ruledQuadRowB[1]);
  const reverseDz1 = unchecked(ruledQuadRowA[end + 2]) - unchecked(ruledQuadRowB[2]);
  const reverseB =
    reverseDx0 * reverseDx0 + reverseDy0 * reverseDy0 + reverseDz0 * reverseDz0
    + reverseDx1 * reverseDx1 + reverseDy1 * reverseDy1 + reverseDz1 * reverseDz1
    < directDx0 * directDx0 + directDy0 * directDy0 + directDz0 * directDz0
      + directDx1 * directDx1 + directDy1 * directDy1 + directDz1 * directDz1;
  if (reverseB) _reverseRuledRow(ruledQuadRowB, su);

  _calibrateRuledStripNormalSign(
    degU, degV, numCtrlU, numCtrlV,
    ctrlPts, knotsU, knotsV, weights,
    reversed, su,
  );

  const baseA = outVertCount;
  for (let i: i32 = 0; i <= su; i++) {
    if (_emitRuledStripVertex(ruledQuadRowA, i, su) == INVALID_ID) return -1;
  }
  const baseB = outVertCount;
  for (let i: i32 = 0; i <= su; i++) {
    if (_emitRuledStripVertex(ruledQuadRowB, i, su) == INVALID_ID) return -1;
  }

  let triCount: i32 = 0;
  for (let i: i32 = 0; i < su; i++) {
    const a0 = baseA + <u32>i;
    const a1 = baseA + <u32>(i + 1);
    const b0 = baseB + <u32>i;
    const b1 = baseB + <u32>(i + 1);
    if (_emitTriTowardVertexNormals(a0, a1, b0, faceId) < 0) return -1;
    if (_emitTriTowardVertexNormals(b0, a1, b1, faceId) < 0) return -1;
    triCount += 2;
  }

  return triCount;
}

function _evalNurbsSurfaceToGlobals(
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
  u: f64,
  v: f64,
  reversed: bool,
): void {
  nurbsSurfaceDerivEval(degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights, u, v);
  const rp = getDerivBufPtr();
  _surfX = load<f64>(rp);
  _surfY = load<f64>(rp + 8);
  _surfZ = load<f64>(rp + 16);
  _surfNX = load<f64>(rp + 144);
  _surfNY = load<f64>(rp + 152);
  _surfNZ = load<f64>(rp + 160);
  if (reversed) {
    _surfNX = -_surfNX;
    _surfNY = -_surfNY;
    _surfNZ = -_surfNZ;
  }
}

function _refineNurbsClosestUV(
  px: f64,
  py: f64,
  pz: f64,
  seedU: f64,
  seedV: f64,
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
): bool {
  const uMin = unchecked(knotsU[degU]);
  const uMax = unchecked(knotsU[numCtrlU]);
  const vMin = unchecked(knotsV[degV]);
  const vMax = unchecked(knotsV[numCtrlV]);
  const uRange = uMax - uMin;
  const vRange = vMax - vMin;
  if (uRange <= 1e-14 || vRange <= 1e-14) return false;

  let u = seedU;
  let v = seedV;
  if (u < uMin) u = uMin;
  else if (u > uMax) u = uMax;
  if (v < vMin) v = vMin;
  else if (v > vMax) v = vMax;

  for (let iter: i32 = 0; iter < 14; iter++) {
    nurbsSurfaceDerivEval(degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights, u, v);
    const rp = getDerivBufPtr();
    const sx = load<f64>(rp);
    const sy = load<f64>(rp + 8);
    const sz = load<f64>(rp + 16);
    const sux = load<f64>(rp + 24);
    const suy = load<f64>(rp + 32);
    const suz = load<f64>(rp + 40);
    const svx = load<f64>(rp + 48);
    const svy = load<f64>(rp + 56);
    const svz = load<f64>(rp + 64);
    const rx = px - sx;
    const ry = py - sy;
    const rz = pz - sz;

    const a00 = sux * sux + suy * suy + suz * suz;
    const a01 = sux * svx + suy * svy + suz * svz;
    const a11 = svx * svx + svy * svy + svz * svz;
    const b0 = sux * rx + suy * ry + suz * rz;
    const b1 = svx * rx + svy * ry + svz * rz;
    const det = a00 * a11 - a01 * a01;
    if (Math.abs(det) < 1e-24) break;

    let du = (b0 * a11 - b1 * a01) / det;
    let dv = (a00 * b1 - a01 * b0) / det;
    if (du != du || dv != dv) break;

    const maxDu = uRange * 0.35;
    const maxDv = vRange * 0.35;
    if (du > maxDu) du = maxDu;
    else if (du < -maxDu) du = -maxDu;
    if (dv > maxDv) dv = maxDv;
    else if (dv < -maxDv) dv = -maxDv;

    const nextU = u + du;
    const nextV = v + dv;
    u = nextU < uMin ? uMin : nextU > uMax ? uMax : nextU;
    v = nextV < vMin ? vMin : nextV > vMax ? vMax : nextV;
    if (Math.abs(du) <= uRange * 1e-9 && Math.abs(dv) <= vRange * 1e-9) break;
  }

  nurbsSurfaceDerivEval(degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights, u, v);
  const rp = getDerivBufPtr();
  const dx = px - load<f64>(rp);
  const dy = py - load<f64>(rp + 8);
  const dz = pz - load<f64>(rp + 16);
  _nurbsClosestU = u;
  _nurbsClosestV = v;
  _nurbsClosestDist2 = dx * dx + dy * dy + dz * dz;
  return true;
}

function _closestNurbsUV(
  px: f64,
  py: f64,
  pz: f64,
  seedU: f64,
  seedV: f64,
  haveSeed: bool,
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
): bool {
  const uMin = unchecked(knotsU[degU]);
  const uMax = unchecked(knotsU[numCtrlU]);
  const vMin = unchecked(knotsV[degV]);
  const vMax = unchecked(knotsV[numCtrlV]);

  let found = false;
  let bestU: f64 = 0.0;
  let bestV: f64 = 0.0;
  let bestDist = Infinity;

  if (haveSeed && _refineNurbsClosestUV(px, py, pz, seedU, seedV,
    degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights)) {
    found = true;
    bestU = _nurbsClosestU;
    bestV = _nurbsClosestV;
    bestDist = _nurbsClosestDist2;
    if (bestDist < 1e-14) return true;
  }

  for (let iu: i32 = 0; iu <= 4; iu++) {
    const u = uMin + (<f64>iu / 4.0) * (uMax - uMin);
    for (let iv: i32 = 0; iv <= 4; iv++) {
      const v = vMin + (<f64>iv / 4.0) * (vMax - vMin);
      if (!_refineNurbsClosestUV(px, py, pz, u, v,
        degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights)) continue;
      if (!found || _nurbsClosestDist2 < bestDist) {
        found = true;
        bestU = _nurbsClosestU;
        bestV = _nurbsClosestV;
        bestDist = _nurbsClosestDist2;
      }
    }
  }

  if (!found) return false;
  _nurbsClosestU = bestU;
  _nurbsClosestV = bestV;
  _nurbsClosestDist2 = bestDist;
  return true;
}

function _nurbsAppendProjectedPoint(
  x: f64,
  y: f64,
  z: f64,
  loopStart: u32,
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
): bool {
  if (_planarPointCount >= MAX_PLANAR_PTS) return false;
  if (_planarPointCount > loopStart) {
    const prev = _planarPointCount - 1;
    const dx = x - unchecked(_planarX[prev]);
    const dy = y - unchecked(_planarY[prev]);
    const dz = z - unchecked(_planarZ[prev]);
    if (dx * dx + dy * dy + dz * dz < 1e-20) return true;
  }

  const haveSeed = _planarPointCount > loopStart;
  const seedIdx = haveSeed ? _planarPointCount - 1 : loopStart;
  const seedU = haveSeed ? unchecked(_planarU[seedIdx]) : 0.0;
  const seedV = haveSeed ? unchecked(_planarV[seedIdx]) : 0.0;
  if (!_closestNurbsUV(x, y, z, seedU, seedV, haveSeed,
    degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights)) return false;

  unchecked(_planarX[_planarPointCount] = x);
  unchecked(_planarY[_planarPointCount] = y);
  unchecked(_planarZ[_planarPointCount] = z);
  unchecked(_planarU[_planarPointCount] = _nurbsClosestU);
  unchecked(_planarV[_planarPointCount] = _nurbsClosestV);
  _planarPointCount++;
  return true;
}

function _nurbsAppendVertex(
  vertexId: u32,
  loopStart: u32,
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
): bool {
  return _nurbsAppendProjectedPoint(vertexGetX(vertexId), vertexGetY(vertexId), vertexGetZ(vertexId), loopStart,
    degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights);
}

function _nurbsAppendLineCoedge(
  edgeId: u32,
  orient: u8,
  loopStart: u32,
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
): bool {
  const startV = orient == ORIENT_REVERSED ? edgeGetEndVertex(edgeId) : edgeGetStartVertex(edgeId);
  const endV = orient == ORIENT_REVERSED ? edgeGetStartVertex(edgeId) : edgeGetEndVertex(edgeId);
  return _nurbsAppendVertex(startV, loopStart, degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights)
    && _nurbsAppendVertex(endV, loopStart, degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights);
}

function _nurbsAppendNurbsCoedge(
  edgeId: u32,
  orient: u8,
  segsU: i32,
  loopStart: u32,
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
): bool {
  if (!_loadCurve(edgeGetGeomOffset(edgeId))) {
    return _nurbsAppendLineCoedge(edgeId, orient, loopStart,
      degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights);
  }

  let segs = segsU;
  if (_crvDeg == 1 && _crvNCtrl == 2) segs = 1;
  else if (segs < 16) segs = 16;
  if (segs > 128) segs = 128;

  const startV = orient == ORIENT_REVERSED ? edgeGetEndVertex(edgeId) : edgeGetStartVertex(edgeId);
  const endV = orient == ORIENT_REVERSED ? edgeGetStartVertex(edgeId) : edgeGetEndVertex(edgeId);
  for (let i: i32 = 0; i <= segs; i++) {
    if (i == 0) {
      if (!_nurbsAppendVertex(startV, loopStart, degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights)) return false;
      continue;
    }
    if (i == segs) {
      if (!_nurbsAppendVertex(endV, loopStart, degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights)) return false;
      continue;
    }
    let frac = <f64>i / <f64>segs;
    if (orient == ORIENT_REVERSED) frac = 1.0 - frac;
    const t = _crvTmin + frac * (_crvTmax - _crvTmin);
    nurbsCurveEvaluate(_crvDeg, _crvNCtrl, _crvCtrl, _crvKnots, _crvWts, t);
    const rp = getResultPtr();
    if (!_nurbsAppendProjectedPoint(load<f64>(rp), load<f64>(rp + 8), load<f64>(rp + 16), loopStart,
      degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights)) return false;
  }
  return true;
}

function _nurbsAppendCircleCoedge(
  edgeId: u32,
  orient: u8,
  segsU: i32,
  loopStart: u32,
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
): bool {
  let segs = segsU;
  if (segs < 32) segs = 32;
  if (segs > 192) segs = 192;

  const off = edgeGetGeomOffset(edgeId);
  const cx = geomPoolRead(off);
  const cy = geomPoolRead(off + 1);
  const cz = geomPoolRead(off + 2);
  const ax = geomPoolRead(off + 3);
  const ay = geomPoolRead(off + 4);
  const az = geomPoolRead(off + 5);
  const rx = geomPoolRead(off + 6);
  const ry = geomPoolRead(off + 7);
  const rz = geomPoolRead(off + 8);
  const radius = geomPoolRead(off + 9);
  const bx = ay * rz - az * ry;
  const by = az * rx - ax * rz;
  const bz = ax * ry - ay * rx;
  const startV = edgeGetStartVertex(edgeId);
  const endV = edgeGetEndVertex(edgeId);
  const coStart = orient == ORIENT_REVERSED ? endV : startV;
  const coEnd = orient == ORIENT_REVERSED ? startV : endV;
  const startAngle = _circleAngleAtVertex(edgeId, startV);
  const endAngle = _circleAngleAtVertex(edgeId, endV);
  const sweep = _directedPeriodicSweep(startAngle, endAngle, edgeGetCurveSameSense(edgeId) != 0, startV == endV);

  for (let i: i32 = 0; i <= segs; i++) {
    if (i == 0) {
      if (!_nurbsAppendVertex(coStart, loopStart, degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights)) return false;
      continue;
    }
    if (i == segs) {
      if (!_nurbsAppendVertex(coEnd, loopStart, degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights)) return false;
      continue;
    }
    let frac = <f64>i / <f64>segs;
    if (orient == ORIENT_REVERSED) frac = 1.0 - frac;
    const theta = startAngle + frac * sweep;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    if (!_nurbsAppendProjectedPoint(
      cx + radius * (rx * c + bx * s),
      cy + radius * (ry * c + by * s),
      cz + radius * (rz * c + bz * s),
      loopStart,
      degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights,
    )) return false;
  }
  return true;
}

function _collectNurbsTrimLoops(
  faceId: u32,
  segsU: i32,
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
): bool {
  _planarPointCount = 0;
  _planarLoopCount = 0;
  _planarPathCount = 0;

  const firstLoop = faceGetFirstLoop(faceId);
  const nLoops = faceGetLoopCount(faceId);
  for (let l: u32 = 0; l < nLoops; l++) {
    if (_planarLoopCount >= MAX_PLANAR_LOOPS) return false;
    const loopId = firstLoop + l;
    const loopStart = _planarPointCount;
    const firstCE = loopGetFirstCoedge(loopId);
    let ce = firstCE;
    let guard: u32 = 0;

    do {
      const eid = coedgeGetEdge(ce);
      const orient = coedgeGetOrient(ce);
      _cacheEdgeSamples(eid);
      const geomType = edgeGetGeomType(eid);
      if (geomType == GEOM_CIRCLE) {
        if (!_nurbsAppendCircleCoedge(eid, orient, segsU, loopStart,
          degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights)) return false;
      } else if (geomType == GEOM_NURBS_CURVE) {
        if (!_nurbsAppendNurbsCoedge(eid, orient, segsU, loopStart,
          degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights)) return false;
      } else {
        if (!_nurbsAppendLineCoedge(eid, orient, loopStart,
          degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights)) return false;
      }
      ce = coedgeGetNext(ce);
      guard++;
    } while (ce != firstCE && guard < 65536);

    if (_planarPointCount > loopStart + 1) {
      const last = _planarPointCount - 1;
      const dx = unchecked(_planarX[last]) - unchecked(_planarX[loopStart]);
      const dy = unchecked(_planarY[last]) - unchecked(_planarY[loopStart]);
      const dz = unchecked(_planarZ[last]) - unchecked(_planarZ[loopStart]);
      if (dx * dx + dy * dy + dz * dz < 1e-20) _planarPointCount--;
    }

    if (_planarPointCount - loopStart >= 3) {
      unchecked(_planarLoopStart[_planarLoopCount] = loopStart);
      unchecked(_planarLoopEnd[_planarLoopCount] = _planarPointCount);
      _planarLoopCount++;
    } else {
      _planarPointCount = loopStart;
    }
  }

  return _planarLoopCount > 0 && _planarPointCount >= 3;
}

function _emitNurbsBoundaryPoint(
  pointId: u32,
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
  reversed: bool,
): u32 {
  _evalNurbsSurfaceToGlobals(degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights,
    unchecked(_planarU[pointId]), unchecked(_planarV[pointId]), reversed);
  const x = pointId < _trimOriginalPointCount ? unchecked(_planarX[pointId]) : _surfX;
  const y = pointId < _trimOriginalPointCount ? unchecked(_planarY[pointId]) : _surfY;
  const z = pointId < _trimOriginalPointCount ? unchecked(_planarZ[pointId]) : _surfZ;
  return _emitVert(
    x,
    y,
    z,
    _surfNX, _surfNY, _surfNZ,
  );
}

function _emitNurbsInteriorPoint(
  u: f64,
  v: f64,
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
  reversed: bool,
): u32 {
  _evalNurbsSurfaceToGlobals(degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights, u, v, reversed);
  return _emitVert(_surfX, _surfY, _surfZ, _surfNX, _surfNY, _surfNZ);
}

function _emitNurbsTrimTriangle(
  a: u32,
  b: u32,
  c: u32,
  faceId: u32,
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
  reversed: bool,
): i32 {
  const ia = unchecked(_planarOutVert[a]);
  const ib = unchecked(_planarOutVert[b]);
  const ic = unchecked(_planarOutVert[c]);
  if (Math.abs(_planarOrient(a, b, c)) <= 1e-14) return 0;

  const cu = (unchecked(_planarU[a]) + unchecked(_planarU[b]) + unchecked(_planarU[c])) / 3.0;
  const cv = (unchecked(_planarV[a]) + unchecked(_planarV[b]) + unchecked(_planarV[c])) / 3.0;
  if (!_planarPointInsideTrim(cu, cv)) {
    return _emitTriTowardVertexNormals(ia, ib, ic, faceId) < 0 ? -1 : 1;
  }

  const center = _emitNurbsInteriorPoint(cu, cv,
    degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights, reversed);
  if (center == INVALID_ID) return -1;
  if (_emitTriTowardVertexNormals(ia, ib, center, faceId) < 0) return -1;
  if (_emitTriTowardVertexNormals(ib, ic, center, faceId) < 0) return -1;
  if (_emitTriTowardVertexNormals(ic, ia, center, faceId) < 0) return -1;
  return 3;
}

function _tessTrimmedNurbsBoundaryFace(
  faceId: u32,
  segsU: i32,
  degU: i32,
  degV: i32,
  numCtrlU: i32,
  numCtrlV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array,
  knotsV: Float64Array,
  weights: Float64Array,
  reversed: bool,
): i32 {
  const baseVert = outVertCount;
  const baseTri = outTriCount;
  if (!_collectNurbsTrimLoops(faceId, segsU, degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights)) return -2;
  if (!_planarBuildBridgedPath()) return -2;
  _trimOriginalPointCount = _planarPointCount;
  if (!_buildTrimBaseTrianglesFromPath()) return -2;
  _trimRefineTriangles(segsU, segsU);

  for (let i: u32 = 0; i < _planarPointCount; i++) {
    const outId = _emitNurbsBoundaryPoint(i, degU, degV, numCtrlU, numCtrlV, ctrlPts, knotsU, knotsV, weights, reversed);
    if (outId == INVALID_ID) {
      outVertCount = baseVert;
      outTriCount = baseTri;
      return -1;
    }
    unchecked(_planarOutVert[i] = outId);
  }

  let triCount: i32 = 0;
  for (let i: u32 = 0; i < _trimTriCount; i++) {
    const ia = unchecked(_planarOutVert[unchecked(_trimTriA[i])]);
    const ib = unchecked(_planarOutVert[unchecked(_trimTriB[i])]);
    const ic = unchecked(_planarOutVert[unchecked(_trimTriC[i])]);
    if (_emitTriTowardVertexNormals(ia, ib, ic, faceId) < 0) {
      outVertCount = baseVert;
      outTriCount = baseTri;
      return -1;
    }
    triCount++;
  }

  return triCount > 0 ? triCount : -2;
}

function _tessNurbsFace(faceId: u32, segsU: i32, segsV: i32): i32 {
  const gOff = faceGetGeomOffset(faceId);
  const reversed = faceGetOrient(faceId) == ORIENT_REVERSED;

  // Read NURBS header from geometry pool
  const degU = <i32>geomPoolRead(gOff);
  const degV = <i32>geomPoolRead(gOff + 1);
  const numCtrlU = <i32>geomPoolRead(gOff + 2);
  const numCtrlV = <i32>geomPoolRead(gOff + 3);
  const numKnotsU = <i32>geomPoolRead(gOff + 4);
  const numKnotsV = <i32>geomPoolRead(gOff + 5);
  const nCtrl = numCtrlU * numCtrlV;

  // Build typed arrays from pool data for the nurbs tessellator
  const knotsU = new Float64Array(numKnotsU);
  const knotsV = new Float64Array(numKnotsV);
  const ctrlPts = new Float64Array(nCtrl * 3);
  const weights = new Float64Array(nCtrl);

  let p: u32 = <u32>(gOff + 6);
  for (let i: i32 = 0; i < numKnotsU; i++) {
    unchecked(knotsU[i] = geomPoolRead(p++));
  }
  for (let i: i32 = 0; i < numKnotsV; i++) {
    unchecked(knotsV[i] = geomPoolRead(p++));
  }
  for (let i: i32 = 0; i < nCtrl * 3; i++) {
    unchecked(ctrlPts[i] = geomPoolRead(p++));
  }
  for (let i: i32 = 0; i < nCtrl; i++) {
    unchecked(weights[i] = geomPoolRead(p++));
  }

  const su = segsU > 0 ? segsU : DEFAULT_SEGS;
  const sv = segsV > 0 ? segsV : DEFAULT_SEGS;

  const ruledBoundary = _tessNurbsRuledBoundaryQuadFace(
    faceId, segsU, degU, degV, numCtrlU, numCtrlV,
    ctrlPts, knotsU, knotsV, weights, reversed,
  );
  if (ruledBoundary != -2) return ruledBoundary;

  const trimmedBoundary = _tessTrimmedNurbsBoundaryFace(
    faceId, segsU, degU, degV, numCtrlU, numCtrlV,
    ctrlPts, knotsU, knotsV, weights, reversed,
  );
  if (trimmedBoundary != -2) return trimmedBoundary;

  // Delegate to existing NURBS tessellator (fixed: pass control point counts)
  const nTris = nurbsSurfaceTessellate(
    degU, degV, numCtrlU, numCtrlV,
    ctrlPts, knotsU, knotsV, weights, su, sv,
  );
  if (nTris < 0) return -1;

  // Copy from the NURBS tessellator's output buffers into our combined output
  const nVerts: u32 = <u32>((su + 1) * (sv + 1));
  const baseVert = outVertCount;

  // Read nurbs output via raw pointers
  const nurbsVertsPtr = getTessVertsPtr();
  const nurbsNormsPtr = getTessNormalsPtr();
  const nurbsFacesPtr = getTessFacesPtr();

  for (let i: u32 = 0; i < nVerts; i++) {
    const si: u32 = i * 3;
    const vx = load<f64>(nurbsVertsPtr + (<usize>si << 3));
    const vy = load<f64>(nurbsVertsPtr + (<usize>(si + 1) << 3));
    const vz = load<f64>(nurbsVertsPtr + (<usize>(si + 2) << 3));
    let nx = load<f64>(nurbsNormsPtr + (<usize>si << 3));
    let ny = load<f64>(nurbsNormsPtr + (<usize>(si + 1) << 3));
    let nz = load<f64>(nurbsNormsPtr + (<usize>(si + 2) << 3));
    if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
    if (_emitVert(vx, vy, vz, nx, ny, nz) == 0xFFFFFFFF) return -1;
  }

  const triCountU32 = <u32>nTris;
  for (let t: u32 = 0; t < triCountU32; t++) {
    const ti: u32 = t * 3;
    const i0 = baseVert + load<u32>(nurbsFacesPtr + (<usize>ti << 2));
    const i1 = baseVert + load<u32>(nurbsFacesPtr + (<usize>(ti + 1) << 2));
    const i2 = baseVert + load<u32>(nurbsFacesPtr + (<usize>(ti + 2) << 2));
    if (reversed) {
      if (_emitTri(i0, i2, i1, faceId) < 0) return -1;
    } else {
      if (_emitTri(i0, i1, i2, faceId) < 0) return -1;
    }
  }

  return nTris;
}

// ─── Trimmed parametric surface grid ─────────────────────────────────

/**
 * Generate a boundary-trimmed UV grid for an analytic parametric surface.
 * Uses the UV bounding box and boundary polygon from _collectBoundaryUV().
 * Grid vertices outside the face boundary (tested via point-in-polygon)
 * are still emitted but their triangles are culled.
 *
 * @param surfType — 1=cylinder, 2=cone, 3=sphere, 4=torus
 */
function _tessTrimmedParametricGrid(
  faceId: u32, reversed: bool,
  segsU: i32, segsV: i32,
  surfType: i32,
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  radius: f64, semiAngle: f64,
  majorR: f64, minorR: f64
): i32 {
  const su = segsU > 0 ? segsU : DEFAULT_SEGS;
  const sv = segsV > 0 ? segsV : DEFAULT_SEGS;
  const baseVert = outVertCount;
  let triCount: i32 = 0;

  const uRange = _uvUmax - _uvUmin;
  const vRange = _uvVmax - _uvVmin;
  if (uRange < 1e-10 || vRange < 1e-10) return 0;

  let useLoopPhaseBlend = false;
  let phaseV0: f64 = 0.0;
  let phaseV1: f64 = 0.0;
  let phaseU0: f64 = 0.0;
  let phaseU1: f64 = 0.0;
  if (!_trimEnabled && _bndLoopCount >= 2 && Math.abs(uRange - 2.0 * Math.PI) < 0.01) {
    let minLoop: u32 = 0;
    let maxLoop: u32 = 0;
    let minV = unchecked(_bndLoopFirstV[0]);
    let maxV = minV;
    for (let l: u32 = 1; l < _bndLoopCount; l++) {
      const lv = unchecked(_bndLoopFirstV[l]);
      if (lv < minV) { minV = lv; minLoop = l; }
      if (lv > maxV) { maxV = lv; maxLoop = l; }
    }
    if (Math.abs(maxV - minV) > 1e-10) {
      phaseV0 = minV;
      phaseV1 = maxV;
      phaseU0 = unchecked(_bndLoopFirstU[minLoop]);
      phaseU1 = unchecked(_bndLoopFirstU[maxLoop]);
      while (phaseU1 - phaseU0 > Math.PI) phaseU1 -= 2.0 * Math.PI;
      while (phaseU1 - phaseU0 < -Math.PI) phaseU1 += 2.0 * Math.PI;
      useLoopPhaseBlend = true;
    }
  }

  // Emit all grid vertices (some may be unused after boundary trimming)
  for (let j: i32 = 0; j <= sv; j++) {
    const vParam = _uvVmin + (<f64>j / <f64>sv) * vRange;

    for (let i: i32 = 0; i <= su; i++) {
      const uShifted = _uvUmin + (<f64>i / <f64>su) * uRange;
      let uActual = uShifted + _uvUcenter; // un-shift for surface evaluation
      if (useLoopPhaseBlend) {
        let alpha = (vParam - phaseV0) / (phaseV1 - phaseV0);
        if (alpha < 0.0) alpha = 0.0;
        else if (alpha > 1.0) alpha = 1.0;
        const rowPhase = phaseU0 + alpha * (phaseU1 - phaseU0);
        uActual = rowPhase + (<f64>i / <f64>su) * 2.0 * Math.PI;
      }

      _evalSurface(surfType, uActual, vParam,
        ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz,
        radius, semiAngle, majorR, minorR);

      let nx = _surfNX, ny = _surfNY, nz = _surfNZ;
      if (reversed) { nx = -nx; ny = -ny; nz = -nz; }

      if (_emitVert(_surfX, _surfY, _surfZ, nx, ny, nz) == 0xFFFFFFFF) return -1;
    }
  }

  // Emit trimmed triangles: only where centroid is inside boundary polygon
  for (let j: i32 = 0; j < sv; j++) {
    for (let i: i32 = 0; i < su; i++) {
      const i00 = baseVert + <u32>(j * (su + 1) + i);
      const i10 = baseVert + <u32>((j + 1) * (su + 1) + i);
      const i11 = baseVert + <u32>((j + 1) * (su + 1) + i + 1);
      const i01 = baseVert + <u32>(j * (su + 1) + i + 1);

      // Triangle 1 centroid (in shifted UV space)
      const cu1 = _uvUmin + (<f64>i + 2.0 / 3.0) / <f64>su * uRange;
      const cv1 = _uvVmin + (<f64>j + 1.0 / 3.0) / <f64>sv * vRange;

      // Triangle 2 centroid
      const cu2 = _uvUmin + (<f64>i + 1.0 / 3.0) / <f64>su * uRange;
      const cv2 = _uvVmin + (<f64>j + 2.0 / 3.0) / <f64>sv * vRange;

      const inside1 = !_trimEnabled || _pointInsideBoundary(cu1, cv1);
      const inside2 = !_trimEnabled || _pointInsideBoundary(cu2, cv2);

      if (inside1) {
        if (reversed) {
          if (_emitTri(i00, i10, i11, faceId) < 0) return -1;
        } else {
          if (_emitTri(i00, i11, i10, faceId) < 0) return -1;
        }
        triCount++;
      }

      if (inside2) {
        if (reversed) {
          if (_emitTri(i00, i11, i01, faceId) < 0) return -1;
        } else {
          if (_emitTri(i00, i01, i11, faceId) < 0) return -1;
        }
        triCount++;
      }
    }
  }

  return triCount;
}

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
  GEOM_NURBS_SURFACE, GEOM_NURBS_CURVE, GEOM_CIRCLE,
  ORIENT_REVERSED,
} from './topology';

import { geomPoolRead } from './geometry';

import {
  nurbsSurfaceTessellate,
  nurbsCurveEvaluate,
  getResultPtr,
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

  // Small margin helps centroid culling on polygon-trimmed faces, but it
  // breaks watertight seams on full-revolution faces by moving grid
  // boundaries past the exact STEP trim loops.
  const uMargin: f64 = _trimEnabled ? 0.001 : 0.0;
  const vMargin: f64 = _trimEnabled ? 0.001 : 0.0;
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
  const startAngle = _circleAngleAtVertex(edgeId, startV);
  const endAngle = _circleAngleAtVertex(edgeId, endV);
  const sweep = _directedPeriodicSweep(startAngle, endAngle, edgeGetCurveSameSense(edgeId) != 0, startV == endV);
  for (let i: i32 = 0; i <= segs; i++) {
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
  const fullBand = _tessFullRevolutionBand(faceId, reversed, segsU, segsV,
    1, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, 0.0, 0.0, 0.0);
  if (fullBand != -2) return fullBand;

  if (_uvVmax - _uvVmin < 1e-10 || _uvUmax - _uvUmin < 1e-10) return 0;

  let cylSegsU = segsU;
  if (!_trimEnabled && Math.abs((_uvUmax - _uvUmin) - 2.0 * Math.PI) < 0.01 && cylSegsU < 32) {
    cylSegsU = 32;
  }

  return _tessTrimmedParametricGrid(faceId, reversed, cylSegsU, segsV,
    1, ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius, 0.0, 0.0, 0.0);
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

  return _tessTrimmedParametricGrid(faceId, reversed, torusSegsU, torusSegsV,
    4, cx, cy, cz, ax, ay, az, rx, ry, rz, bx, by, bz, 0.0, 0.0, majorR, minorR);
}

// ─── NURBS face tessellation ─────────────────────────────────────────

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

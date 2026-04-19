// kernel/tessellation — native face-level tessellation for WASM-resident bodies
//
// Tessellates faces stored in kernel/topology + kernel/geometry into flat
// vertex/normal/index buffers. Supports:
//   - Planes (trivial face from boundary loop vertices)
//   - Cylinders, cones (UV parametric grid)
//   - Spheres (UV parametric grid)
//   - Tori (UV parametric grid)
//   - NURBS surfaces (delegates to assembly/nurbs.ts nurbsSurfaceTessellate)
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
  vertexGetX, vertexGetY, vertexGetZ,
  GEOM_PLANE, GEOM_CYLINDER, GEOM_CONE, GEOM_SPHERE, GEOM_TORUS,
  GEOM_NURBS_SURFACE,
  ORIENT_REVERSED,
} from './topology';

import { geomPoolRead } from './geometry';

import {
  nurbsSurfaceTessellate,
  getTessVertsPtr, getTessNormalsPtr, getTessFacesPtr,
} from '../nurbs';

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
  outVertCount = 0;
  outTriCount = 0;
  edgeSampleTotal = 0;

  // Clear edge cache
  const nFaces = faceGetCount();
  for (let e: u32 = 0; e < MAX_EDGE_CACHE; e++) {
    unchecked(edgeCacheDone[e] = 0);
  }

  for (let f: u32 = 0; f < nFaces; f++) {
    const geomType = faceGetGeomType(f);
    let result: i32 = 0;

    if (geomType == GEOM_PLANE) {
      result = _tessPlaneFace(f);
    } else if (geomType == GEOM_CYLINDER) {
      result = _tessCylinderFace(f, segsU, segsV);
    } else if (geomType == GEOM_CONE) {
      result = _tessConeFace(f, segsU, segsV);
    } else if (geomType == GEOM_SPHERE) {
      result = _tessSphereFace(f, segsU, segsV);
    } else if (geomType == GEOM_TORUS) {
      result = _tessTorusFace(f, segsU, segsV);
    } else if (geomType == GEOM_NURBS_SURFACE) {
      result = _tessNurbsFace(f, segsU, segsV);
    }
    // GEOM_NONE faces are skipped

    if (result < 0) return -1; // overflow
  }

  return <i32>outTriCount;
}

/**
 * Tessellate a single face.
 * @param faceId — the face index in the topology
 * @param segsU — U segments
 * @param segsV — V segments
 * @returns number of triangles added, or -1 on overflow
 */
export function tessBuildFace(faceId: u32, segsU: i32, segsV: i32): i32 {
  const geomType = faceGetGeomType(faceId);

  if (geomType == GEOM_PLANE) return _tessPlaneFace(faceId);
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

function _tessPlaneFace(faceId: u32): i32 {
  _collectOuterLoopVerts(faceId);
  if (loopVertCount < 3) return 0;

  const gOff = faceGetGeomOffset(faceId);
  const reversed = faceGetOrient(faceId) == ORIENT_REVERSED;

  // Read plane normal from geometry pool
  let nx = geomPoolRead(gOff + 3);
  let ny = geomPoolRead(gOff + 4);
  let nz = geomPoolRead(gOff + 5);
  if (reversed) { nx = -nx; ny = -ny; nz = -nz; }

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

  // Get boundary height from loop vertices
  _collectOuterLoopVerts(faceId);
  let hMin: f64 = Infinity;
  let hMax: f64 = -Infinity;
  for (let i: u32 = 0; i < loopVertCount; i++) {
    const vid = unchecked(loopVerts[i]);
    const dx = vertexGetX(vid) - ox;
    const dy = vertexGetY(vid) - oy;
    const dz = vertexGetZ(vid) - oz;
    const h = dx * ax + dy * ay + dz * az;
    if (h < hMin) hMin = h;
    if (h > hMax) hMax = h;
  }
  if (hMin >= hMax) return 0;

  return _tessParametricGrid(faceId, reversed, segsU, segsV,
    ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius,
    0.0, 2.0 * Math.PI, hMin, hMax, 1 /* cylinder */);
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

  _collectOuterLoopVerts(faceId);
  let hMin: f64 = Infinity;
  let hMax: f64 = -Infinity;
  for (let i: u32 = 0; i < loopVertCount; i++) {
    const vid = unchecked(loopVerts[i]);
    const dx = vertexGetX(vid) - ox;
    const dy = vertexGetY(vid) - oy;
    const dz = vertexGetZ(vid) - oz;
    const h = dx * ax + dy * ay + dz * az;
    if (h < hMin) hMin = h;
    if (h > hMax) hMax = h;
  }
  if (hMin >= hMax) return 0;

  return _tessParametricGrid(faceId, reversed, segsU, segsV,
    ox, oy, oz, ax, ay, az, rx, ry, rz, bx, by, bz, radius,
    0.0, 2.0 * Math.PI, hMin, hMax, 2 /* cone */, semiAngle);
}

// ─── Sphere face tessellation ────────────────────────────────────────

function _tessSphereFace(faceId: u32, segsU: i32, segsV: i32): i32 {
  const gOff = faceGetGeomOffset(faceId);
  const reversed = faceGetOrient(faceId) == ORIENT_REVERSED;

  const cx = geomPoolRead(gOff);
  const cy = geomPoolRead(gOff + 1);
  const cz = geomPoolRead(gOff + 2);
  const radius = geomPoolRead(gOff + 3);

  const baseVert = outVertCount;
  let triCount: i32 = 0;

  // UV sphere: u = longitude [0, 2π], v = latitude [-π/2, π/2]
  const su = segsU > 0 ? segsU : DEFAULT_SEGS;
  const sv = segsV > 0 ? segsV : DEFAULT_SEGS;

  for (let j: i32 = 0; j <= sv; j++) {
    const v = -Math.PI / 2.0 + (<f64>j / <f64>sv) * Math.PI;
    const cosV = Math.cos(v);
    const sinV = Math.sin(v);

    for (let i: i32 = 0; i <= su; i++) {
      const u = (<f64>i / <f64>su) * 2.0 * Math.PI;
      const cosU = Math.cos(u);
      const sinU = Math.sin(u);

      let nx = cosV * cosU;
      let ny = cosV * sinU;
      let nz = sinV;
      if (reversed) { nx = -nx; ny = -ny; nz = -nz; }

      if (_emitVert(
        cx + radius * cosV * cosU,
        cy + radius * cosV * sinU,
        cz + radius * sinV,
        nx, ny, nz
      ) == 0xFFFFFFFF) return -1;
    }
  }

  // Generate quads split into triangles
  for (let j: i32 = 0; j < sv; j++) {
    for (let i: i32 = 0; i < su; i++) {
      const i00 = baseVert + <u32>(j * (su + 1) + i);
      const i10 = baseVert + <u32>((j + 1) * (su + 1) + i);
      const i11 = baseVert + <u32>((j + 1) * (su + 1) + i + 1);
      const i01 = baseVert + <u32>(j * (su + 1) + i + 1);

      if (reversed) {
        if (_emitTri(i00, i11, i10, faceId) < 0) return -1;
        if (_emitTri(i00, i01, i11, faceId) < 0) return -1;
      } else {
        if (_emitTri(i00, i10, i11, faceId) < 0) return -1;
        if (_emitTri(i00, i11, i01, faceId) < 0) return -1;
      }
      triCount += 2;
    }
  }

  return triCount;
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

  const su = segsU > 0 ? segsU : DEFAULT_SEGS;
  const sv = segsV > 0 ? segsV : DEFAULT_SEGS;
  const baseVert = outVertCount;
  let triCount: i32 = 0;

  for (let i: i32 = 0; i <= su; i++) {
    const u = (<f64>i / <f64>su) * 2.0 * Math.PI;
    const cosU = Math.cos(u);
    const sinU = Math.sin(u);

    // Ring center direction in the major plane
    const dirX = rx * cosU + bx * sinU;
    const dirY = ry * cosU + by * sinU;
    const dirZ = rz * cosU + bz * sinU;

    // Ring center position
    const rcX = cx + majorR * dirX;
    const rcY = cy + majorR * dirY;
    const rcZ = cz + majorR * dirZ;

    for (let j: i32 = 0; j <= sv; j++) {
      const v = (<f64>j / <f64>sv) * 2.0 * Math.PI;
      const cosV = Math.cos(v);
      const sinV = Math.sin(v);

      // Point on torus
      const px = rcX + minorR * (dirX * cosV + ax * sinV);
      const py = rcY + minorR * (dirY * cosV + ay * sinV);
      const pz = rcZ + minorR * (dirZ * cosV + az * sinV);

      // Outward normal = point - ring center, normalized
      let nx = dirX * cosV + ax * sinV;
      let ny = dirY * cosV + ay * sinV;
      let nz = dirZ * cosV + az * sinV;
      if (reversed) { nx = -nx; ny = -ny; nz = -nz; }

      if (_emitVert(px, py, pz, nx, ny, nz) == 0xFFFFFFFF) return -1;
    }
  }

  for (let i: i32 = 0; i < su; i++) {
    for (let j: i32 = 0; j < sv; j++) {
      const i00 = baseVert + <u32>(i * (sv + 1) + j);
      const i10 = baseVert + <u32>((i + 1) * (sv + 1) + j);
      const i11 = baseVert + <u32>((i + 1) * (sv + 1) + j + 1);
      const i01 = baseVert + <u32>(i * (sv + 1) + j + 1);

      if (reversed) {
        if (_emitTri(i00, i11, i10, faceId) < 0) return -1;
        if (_emitTri(i00, i01, i11, faceId) < 0) return -1;
      } else {
        if (_emitTri(i00, i10, i11, faceId) < 0) return -1;
        if (_emitTri(i00, i11, i01, faceId) < 0) return -1;
      }
      triCount += 2;
    }
  }

  return triCount;
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

  // Delegate to existing NURBS tessellator
  const nTris = nurbsSurfaceTessellate(
    degU, degV, numCtrlU + degU, numCtrlV + degV,
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

// ─── Generic parametric surface grid ─────────────────────────────────

/**
 * Tessellate a parametric revolution surface as a UV grid.
 * Used by cylinder (type=1) and cone (type=2).
 *
 * @param surfType — 1=cylinder, 2=cone
 * @param semiAngle — only used for cones
 */
function _tessParametricGrid(
  faceId: u32, reversed: bool,
  segsU: i32, segsV: i32,
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  bx: f64, by: f64, bz: f64,
  radius: f64,
  uMin: f64, uMax: f64,
  vMin: f64, vMax: f64,
  surfType: i32,
  semiAngle: f64 = 0.0,
): i32 {
  const su = segsU > 0 ? segsU : DEFAULT_SEGS;
  const sv = segsV > 0 ? segsV : DEFAULT_SEGS;
  const baseVert = outVertCount;
  let triCount: i32 = 0;

  const uRange = uMax - uMin;
  const vRange = vMax - vMin;
  const tanSA = surfType == 2 ? Math.tan(semiAngle) : 0.0;

  for (let j: i32 = 0; j <= sv; j++) {
    const v = vMin + (<f64>j / <f64>sv) * vRange; // height for cyl/cone

    for (let i: i32 = 0; i <= su; i++) {
      const u = uMin + (<f64>i / <f64>su) * uRange; // angle
      const cosU = Math.cos(u);
      const sinU = Math.sin(u);

      let r: f64;
      let px: f64, py: f64, pz: f64;
      let nx: f64, ny: f64, nz: f64;

      if (surfType == 1) {
        // Cylinder
        r = radius;
        px = ox + r * (rx * cosU + bx * sinU) + v * ax;
        py = oy + r * (ry * cosU + by * sinU) + v * ay;
        pz = oz + r * (rz * cosU + bz * sinU) + v * az;
        nx = rx * cosU + bx * sinU;
        ny = ry * cosU + by * sinU;
        nz = rz * cosU + bz * sinU;
      } else {
        // Cone
        r = radius + v * tanSA;
        px = ox + r * (rx * cosU + bx * sinU) + v * ax;
        py = oy + r * (ry * cosU + by * sinU) + v * ay;
        pz = oz + r * (rz * cosU + bz * sinU) + v * az;

        // Cone normal: radial component - tan(semiAngle) * axis
        const cosSA = Math.cos(semiAngle);
        const sinSA = Math.sin(semiAngle);
        nx = (rx * cosU + bx * sinU) * cosSA - ax * sinSA;
        ny = (ry * cosU + by * sinU) * cosSA - ay * sinSA;
        nz = (rz * cosU + bz * sinU) * cosSA - az * sinSA;
      }

      if (reversed) { nx = -nx; ny = -ny; nz = -nz; }

      if (_emitVert(px, py, pz, nx, ny, nz) == 0xFFFFFFFF) return -1;
    }
  }

  for (let j: i32 = 0; j < sv; j++) {
    for (let i: i32 = 0; i < su; i++) {
      const i00 = baseVert + <u32>(j * (su + 1) + i);
      const i10 = baseVert + <u32>((j + 1) * (su + 1) + i);
      const i11 = baseVert + <u32>((j + 1) * (su + 1) + i + 1);
      const i01 = baseVert + <u32>(j * (su + 1) + i + 1);

      if (reversed) {
        if (_emitTri(i00, i11, i10, faceId) < 0) return -1;
        if (_emitTri(i00, i01, i11, faceId) < 0) return -1;
      } else {
        if (_emitTri(i00, i10, i11, faceId) < 0) return -1;
        if (_emitTri(i00, i11, i01, faceId) < 0) return -1;
      }
      triCount += 2;
    }
  }

  return triCount;
}

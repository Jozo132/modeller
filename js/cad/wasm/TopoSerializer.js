// js/cad/wasm/TopoSerializer.js — reusable JS TopoBody → WASM topology serializer
//
// H11 scaffold. Consolidates the body-upload walk that previously lived
// embedded inside `js/cad/Containment.js`. The serializer writes vertices,
// edges, coedges, loops, faces (with analytic surface geometry), and a
// shell into the active kernel body via the `bodyBegin` / `bodyEnd`
// contract.
//
// Callers are responsible for their own caching and for calling
// `bodyBegin()` / `geomPoolReset()` as needed. This module intentionally
// does NOT manage revision caches — see Containment._wasmLoadBody for the
// cache layer.
//
// Scope (H11 scaffold): body load only. No face splitter, no fragment
// classification, no topology readback helpers beyond what the kernel
// already exports.

import { SurfaceType } from '../BRepTopology.js';
import {
  circumCenter3D,
  vec3Cross,
  vec3Dot,
  vec3Len,
  vec3Normalize,
  vec3Scale,
  vec3Sub,
} from '../toolkit/Vec3Utils.js';

// The AssemblyScript loader re-exports `export const X: u8` values as
// `WebAssembly.Global` objects rather than plain numbers. Passing a
// Global into a typed numeric parameter silently coerces to 0, which
// would corrupt every `faceAdd` geomType tag. Resolve constants to
// their numeric values at call time so the serializer stays correct
// regardless of whether the caller passed the raw `exports` namespace
// or the already-unwrapped loader object.
function _num(v, fallback = 0) {
  if (v == null) return fallback;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'value' in v) return Number(v.value);
  return Number(v);
}

function _kernelConstants(w) {
  return {
    GEOM_NONE: _num(w.GEOM_NONE, 0),
    GEOM_PLANE: _num(w.GEOM_PLANE, 1),
    GEOM_CYLINDER: _num(w.GEOM_CYLINDER, 2),
    GEOM_CONE: _num(w.GEOM_CONE, 3),
    GEOM_SPHERE: _num(w.GEOM_SPHERE, 4),
    GEOM_TORUS: _num(w.GEOM_TORUS, 5),
    GEOM_NURBS_SURFACE: _num(w.GEOM_NURBS_SURFACE, 6),
    GEOM_LINE: _num(w.GEOM_LINE, 7),
    GEOM_CIRCLE: _num(w.GEOM_CIRCLE, 8),
    GEOM_NURBS_CURVE: _num(w.GEOM_NURBS_CURVE, 10),
    ORIENT_FORWARD: _num(w.ORIENT_FORWARD, 0),
    ORIENT_REVERSED: _num(w.ORIENT_REVERSED, 1),
  };
}

/**
 * @typedef {Object} TopoFaceInfo
 * @property {object} face - The source TopoFace.
 * @property {number} geomType - Kernel GEOM_* tag actually stored.
 * @property {number} geomOffset - Offset into the kernel geometry pool.
 * @property {boolean} isCurved - True if the surface is not a plane.
 * @property {object|null} surfaceInfo - The original `face.surfaceInfo`, if any.
 */

/**
 * @typedef {Object} TopoSerializeResult
 * @property {number} faceCount - Number of WASM faces actually added.
 * @property {Map<object, number>} vertexMap - TopoVertex → WASM vertex id.
 * @property {Map<object, number>} edgeMap - TopoEdge → WASM edge id.
 * @property {Map<object, number>} faceMap - TopoFace → WASM face id.
 * @property {TopoFaceInfo[]} faceInfos - Parallel to WASM face ids (0..faceCount-1).
 */

/**
 * @typedef {Object} TopoSerializeOptions
 * @property {boolean} [nurbs] - If true, store NURBS curves on edges and
 *   NURBS surfaces on faces via the kernel's `nurbs*StoreFromStaging`
 *   exports. Defaults to auto-detect (enabled iff those exports exist).
 * @property {WebAssembly.Memory} [memory] - Optional kernel memory; if
 *   omitted, the serializer falls back to `wasm.memory`. Only used when
 *   `nurbs` is enabled (for writing into the kernel staging buffer).
 */

/**
 * Serialize a JS TopoBody into the currently active WASM kernel body.
 *
 * Preconditions: caller has already invoked `wasm.bodyBegin()` (or the
 * per-handle equivalent) and `wasm.geomPoolReset()`. The serializer will
 * NOT call `wasm.bodyEnd()` — the caller owns that boundary so it can
 * inject additional per-body state (e.g. handle metadata) before closing.
 *
 * Supported analytic surfaces: PLANE, SPHERE, CYLINDER, CONE, TORUS.
 * With `opts.nurbs=true` (auto-detected by default) NURBS curves on edges
 * and NURBS surfaces on faces are also stored.
 * Faces with unsupported surface types are still added topologically but
 * carry `GEOM_NONE`, matching the prior Containment behavior.
 *
 * @param {import('../BRepTopology.js').TopoBody} body
 * @param {object} wasm - WASM kernel module (build/release.js exports)
 * @param {TopoSerializeOptions} [opts]
 * @returns {TopoSerializeResult}
 */
export function loadBodyIntoWasm(body, wasm, opts = {}) {
  const w = wasm;
  const K = _kernelConstants(w);
  const nurbsEnabled = opts.nurbs === true || (opts.nurbs !== false
    && typeof w.nurbsCurveStoreFromStaging === 'function'
    && typeof w.nurbsSurfaceStoreFromStaging === 'function'
    && typeof w.geomStagingPtr === 'function');
  const mem = opts.memory || w.memory;
  const ctx = { w, K, nurbsEnabled, mem };
  const vertexMap = new Map();
  const edgeMap = new Map();
  const faceMap = new Map();
  const faceInfos = [];

  const allFaces = body.faces();

  // ---- vertices ----------------------------------------------------------
  for (const face of allFaces) {
    for (const loop of _loopsOf(face)) {
      for (const ce of loop.coedges || []) {
        const edge = ce.edge;
        if (!edge) continue;
        if (edge.startVertex && !vertexMap.has(edge.startVertex)) {
          const v = edge.startVertex.point || edge.startVertex;
          vertexMap.set(edge.startVertex, w.vertexAdd(v.x, v.y, v.z));
        }
        if (edge.endVertex && !vertexMap.has(edge.endVertex)) {
          const v = edge.endVertex.point || edge.endVertex;
          vertexMap.set(edge.endVertex, w.vertexAdd(v.x, v.y, v.z));
        }
      }
    }
  }

  // ---- edges -------------------------------------------------------------
  for (const face of allFaces) {
    for (const loop of _loopsOf(face)) {
      for (const ce of loop.coedges || []) {
        const edge = ce.edge;
        if (!edge || edgeMap.has(edge)) continue;
        const sv = vertexMap.get(edge.startVertex);
        const ev = vertexMap.get(edge.endVertex);
        if (sv === undefined || ev === undefined) continue;
        const curveGeom = _storeEdgeGeometry(edge, ctx);
        edgeMap.set(edge, w.edgeAdd(sv, ev, curveGeom.geomType, curveGeom.geomOffset));
      }
    }
  }

  // ---- faces + loops + coedges ------------------------------------------
  let wasmFaceId = 0;
  for (const face of allFaces) {
    const loops = _loopsOf(face).filter(Boolean);
    if (loops.length === 0) continue;

    const { geomType, geomOffset } = _storeFaceGeometry(face, ctx);
    const orient = face.sameSense !== false ? K.ORIENT_FORWARD : K.ORIENT_REVERSED;

    let firstLoopId = -1;
    let numLoops = 0;
    for (let li = 0; li < loops.length; li++) {
      const loop = loops[li];
      const coedges = loop.coedges || [];
      if (coedges.length === 0) continue;

      const isOuter = li === 0 ? 1 : 0;
      const ceIds = [];
      const predictedLoopId = w.loopGetCount ? w.loopGetCount() : 0;
      for (const ce of coedges) {
        const eid = edgeMap.get(ce.edge);
        if (eid === undefined) continue;
        const ceOrient = ce.sameSense ? K.ORIENT_FORWARD : K.ORIENT_REVERSED;
        ceIds.push(w.coedgeAdd(eid, ceOrient, 0, predictedLoopId + numLoops));
      }
      if (ceIds.length === 0) continue;
      for (let i = 0; i < ceIds.length; i++) {
        w.coedgeSetNext(ceIds[i], ceIds[(i + 1) % ceIds.length]);
      }
      const loopId = w.loopAdd(ceIds[0], wasmFaceId, isOuter);
      if (firstLoopId < 0) firstLoopId = loopId;
      numLoops++;
    }

    if (firstLoopId < 0) continue;
    const faceId = w.faceAdd(firstLoopId, 0, geomType, geomOffset, orient, numLoops);
    faceMap.set(face, faceId);
    faceInfos.push({
      face,
      geomType,
      geomOffset,
      isCurved: geomType !== K.GEOM_PLANE && geomType !== K.GEOM_NONE,
      surfaceInfo: face.surfaceInfo || (face.surface && face.surface.surfaceInfo) || null,
    });
    wasmFaceId++;
  }

  if (wasmFaceId > 0) {
    w.shellAdd(0, wasmFaceId, 1);
  }

  return { faceCount: wasmFaceId, vertexMap, edgeMap, faceMap, faceInfos };
}

function _loopsOf(face) {
  if (!face) return [];
  return [face.outerLoop, ...(face.innerLoops || [])].filter(Boolean);
}

function _storeEdgeGeometry(edge, ctx) {
  const { w, K, nurbsEnabled, mem } = ctx;
  if (!edge || !edge.curve) {
    return { geomType: K.GEOM_LINE, geomOffset: 0 };
  }
  if (_isSimpleLineCurve(edge.curve)) {
    return { geomType: K.GEOM_LINE, geomOffset: 0 };
  }
  const circleGeom = _storeCircleGeometry(edge, ctx);
  if (circleGeom) return circleGeom;
  if (!nurbsEnabled || !mem) {
    return { geomType: K.GEOM_LINE, geomOffset: 0 };
  }
  const curve = edge.curve;
  if (curve.degree == null || !curve.controlPoints || !curve.knots) {
    return { geomType: K.GEOM_LINE, geomOffset: 0 };
  }
  const nCtrl = curve.controlPoints.length;
  const nKnots = curve.knots.length;
  if (nCtrl === 0 || nKnots === 0) {
    return { geomType: K.GEOM_LINE, geomOffset: 0 };
  }
  const stagingPtr = w.geomStagingPtr() >>> 0;
  const view = new Float64Array(mem.buffer, stagingPtr, nKnots + nCtrl * 3 + nCtrl);
  let i = 0;
  for (let k = 0; k < nKnots; k++) view[i++] = curve.knots[k];
  for (let k = 0; k < nCtrl; k++) {
    const cp = curve.controlPoints[k];
    view[i++] = cp.x; view[i++] = cp.y; view[i++] = cp.z;
  }
  for (let k = 0; k < nCtrl; k++) view[i++] = curve.weights ? curve.weights[k] : 1.0;
  const offset = w.nurbsCurveStoreFromStaging(curve.degree, nCtrl, nKnots);
  return { geomType: K.GEOM_NURBS_CURVE, geomOffset: offset };
}

function _isSimpleLineCurve(curve) {
  if (!curve || curve.degree !== 1) return false;
  if (!Array.isArray(curve.controlPoints) || curve.controlPoints.length !== 2) return false;
  if (!Array.isArray(curve.weights) || curve.weights.length !== 2) return false;
  return Math.abs(curve.weights[0] - 1) <= 1e-8 && Math.abs(curve.weights[1] - 1) <= 1e-8;
}

function _storeCircleGeometry(edge, ctx) {
  const { w, K } = ctx;
  if (typeof w.circleStore !== 'function') return null;
  const curve = edge?.curve;
  if (!curve || curve.degree !== 2 || typeof curve.evaluate !== 'function') return null;

  const controlPoints = curve.controlPoints;
  const weights = curve.weights;
  if (!Array.isArray(controlPoints) || controlPoints.length < 3 || (controlPoints.length % 2) === 0) return null;
  if (!Array.isArray(weights) || weights.length !== controlPoints.length) return null;

  let nonUnitWeight = false;
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight <= 0) return null;
    if (Math.abs(weight - 1) > 1e-8) nonUnitWeight = true;
  }
  if (!nonUnitWeight) return null;

  const uMin = curve.uMin;
  const uMax = curve.uMax;
  const uRange = uMax - uMin;
  if (!(uRange > 1e-9)) return null;

  const sampleParams = [0.0, 0.2, 0.35, 0.5, 0.8, 1.0]
    .map((t) => uMin + uRange * t);
  const samples = sampleParams.map((u) => curve.evaluate(u));

  let center = null;
  for (let i = 0; i < samples.length - 2 && !center; i++) {
    for (let j = i + 1; j < samples.length - 1 && !center; j++) {
      for (let k = j + 1; k < samples.length && !center; k++) {
        center = circumCenter3D(samples[i], samples[j], samples[k]);
      }
    }
  }
  if (!center) return null;

  const startPoint = edge.startVertex?.point || samples[0];
  const xAxis = vec3Normalize(vec3Sub(startPoint, center));
  const radius = vec3Len(vec3Sub(startPoint, center));
  if (radius < 1e-8 || vec3Len(xAxis) < 0.99) return null;

  let tangent = vec3Sub(curve.evaluate(uMin + uRange * 0.05), startPoint);
  if (vec3Len(tangent) < 1e-8) tangent = vec3Sub(samples[2], startPoint);
  const normal = vec3Normalize(vec3Cross(xAxis, tangent));
  if (vec3Len(normal) < 0.99) return null;

  const planeTol = Math.max(1e-6, radius * 1e-5);
  const radiusTol = Math.max(1e-6, radius * 1e-5);
  for (const point of samples) {
    const radial = vec3Sub(point, center);
    if (Math.abs(vec3Dot(radial, normal)) > planeTol) return null;
    const inPlane = vec3Sub(radial, vec3Scale(normal, vec3Dot(radial, normal)));
    if (Math.abs(vec3Len(inPlane) - radius) > radiusTol) return null;
  }

  return {
    geomType: K.GEOM_CIRCLE,
    geomOffset: w.circleStore(
      center.x, center.y, center.z,
      normal.x, normal.y, normal.z,
      xAxis.x, xAxis.y, xAxis.z,
      radius,
    ),
  };
}

function _storeFaceGeometry(face, ctx) {
  const { w, K } = ctx;
  const fallback = { geomType: K.GEOM_NONE, geomOffset: 0 };
  if (!face) return fallback;
  const si = (face.surfaceInfo)
    || (face.surface ? (face.surface.surfaceInfo || face.surface._analyticParams) : null);

  if (face.surfaceType === SurfaceType.PLANE) {
    if (si && si.origin && si.normal) {
      const rd = si.refDir || si.xDir || _computeRefDir(si.normal);
      return {
        geomType: K.GEOM_PLANE,
        geomOffset: w.planeStore(
          si.origin.x, si.origin.y, si.origin.z,
          si.normal.x, si.normal.y, si.normal.z,
          rd.x, rd.y, rd.z,
        ),
      };
    }
    if (face.outerLoop) {
      const pts = face.outerLoop.points();
      if (pts.length >= 3) {
        const n = _polyNormal(pts);
        const rd = _computeRefDir(n);
        return {
          geomType: K.GEOM_PLANE,
          geomOffset: w.planeStore(pts[0].x, pts[0].y, pts[0].z, n.x, n.y, n.z, rd.x, rd.y, rd.z),
        };
      }
    }
    return fallback;
  }

  if (face.surfaceType === SurfaceType.SPHERE) {
    const ctr = si && (si.origin || si.center);
    if (si && ctr && si.radius != null) {
      const ax = si.axis || { x: 0, y: 0, z: 1 };
      const rd = si.xDir || si.refDir || _computeRefDir(ax);
      return {
        geomType: K.GEOM_SPHERE,
        geomOffset: w.sphereStore(
          ctr.x, ctr.y, ctr.z,
          ax.x, ax.y, ax.z,
          rd.x, rd.y, rd.z,
          si.radius,
        ),
      };
    }
    return fallback;
  }

  if (face.surfaceType === SurfaceType.CYLINDER) {
    if (si && si.origin && si.axis && si.radius != null) {
      const rd = si.xDir || si.refDir || _computeRefDir(si.axis);
      return {
        geomType: K.GEOM_CYLINDER,
        geomOffset: w.cylinderStore(
          si.origin.x, si.origin.y, si.origin.z,
          si.axis.x, si.axis.y, si.axis.z,
          rd.x, rd.y, rd.z,
          si.radius,
        ),
      };
    }
    return fallback;
  }

  if (face.surfaceType === SurfaceType.CONE) {
    if (si && si.origin && si.axis && si.radius != null && si.semiAngle != null) {
      const rd = si.xDir || si.refDir || _computeRefDir(si.axis);
      return {
        geomType: K.GEOM_CONE,
        geomOffset: w.coneStore(
          si.origin.x, si.origin.y, si.origin.z,
          si.axis.x, si.axis.y, si.axis.z,
          rd.x, rd.y, rd.z,
          si.radius, si.semiAngle,
        ),
      };
    }
    return fallback;
  }

  if (face.surfaceType === SurfaceType.TORUS) {
    const majorR = si && (si.majorR ?? si.majorRadius);
    const minorR = si && (si.minorR ?? si.minorRadius);
    if (si && si.origin && si.axis && majorR != null && minorR != null) {
      const rd = si.xDir || si.refDir || _computeRefDir(si.axis);
      return {
        geomType: K.GEOM_TORUS,
        geomOffset: w.torusStore(
          si.origin.x, si.origin.y, si.origin.z,
          si.axis.x, si.axis.y, si.axis.z,
          rd.x, rd.y, rd.z,
          majorR, minorR,
        ),
      };
    }
    return fallback;
  }

  if (!face.surface) return fallback;

  // NURBS / B-spline surfaces (auto-enabled when the kernel exports the
  // staging path and the caller supplied a memory buffer).
  if (ctx.nurbsEnabled && ctx.mem && face.surface) {
    const s = face.surface;
    const isBSplineKind = face.surfaceType === SurfaceType.BSPLINE
      || face.surfaceType === SurfaceType.EXTRUSION
      || face.surfaceType === SurfaceType.REVOLUTION
      || face.surfaceType === SurfaceType.UNKNOWN;
    if (isBSplineKind && s.degreeU != null && s.controlPoints && s.knotsU && s.knotsV) {
      const numU = s.numRowsU;
      const numV = s.numColsV;
      const nCtrl = numU * numV;
      const nKnotsU = s.knotsU.length;
      const nKnotsV = s.knotsV.length;
      if (nCtrl > 0 && nKnotsU > 0 && nKnotsV > 0) {
        const stagingPtr = w.geomStagingPtr() >>> 0;
        const view = new Float64Array(
          ctx.mem.buffer,
          stagingPtr,
          nKnotsU + nKnotsV + nCtrl * 3 + nCtrl,
        );
        let i = 0;
        for (let k = 0; k < nKnotsU; k++) view[i++] = s.knotsU[k];
        for (let k = 0; k < nKnotsV; k++) view[i++] = s.knotsV[k];
        for (let k = 0; k < nCtrl; k++) {
          const cp = s.controlPoints[k];
          view[i++] = cp.x; view[i++] = cp.y; view[i++] = cp.z;
        }
        for (let k = 0; k < nCtrl; k++) view[i++] = s.weights ? s.weights[k] : 1.0;
        const offset = w.nurbsSurfaceStoreFromStaging(
          s.degreeU, s.degreeV, numU, numV, nKnotsU, nKnotsV,
        );
        return { geomType: K.GEOM_NURBS_SURFACE, geomOffset: offset };
      }
    }
  }

  return fallback;
}

function _computeRefDir(n) {
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  let up;
  if (ax <= ay && ax <= az) up = { x: 1, y: 0, z: 0 };
  else if (ay <= az) up = { x: 0, y: 1, z: 0 };
  else up = { x: 0, y: 0, z: 1 };
  const rx = n.y * up.z - n.z * up.y;
  const ry = n.z * up.x - n.x * up.z;
  const rz = n.x * up.y - n.y * up.x;
  const len = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (len < 1e-14) return { x: 1, y: 0, z: 0 };
  return { x: rx / len, y: ry / len, z: rz / len };
}

function _polyNormal(pts) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-14) return { x: 0, y: 0, z: 1 };
  return { x: nx / len, y: ny / len, z: nz / len };
}

/**
 * Read the kernel's topology summary (`[vertexCount, edgeCount, coedgeCount,
 * loopCount, faceCount, shellCount]`) via the `topoGetSummary` export.
 * Useful for scaffold-level readback and test assertions.
 *
 * @param {object} wasm - WASM kernel module
 * @returns {{ vertices:number, edges:number, coedges:number, loops:number, faces:number, shells:number }}
 */
export function readTopoSummary(wasm) {
  if (typeof wasm.topoGetSummary !== 'function') {
    return { vertices: 0, edges: 0, coedges: 0, loops: 0, faces: 0, shells: 0 };
  }
  // The kernel writes into a StaticArray<u32>; the generated JS binding
  // accepts a typed array-like. We allocate a plain Uint32Array(6) and
  // rely on the AS loader's wrap-around marshalling for StaticArray.
  const buf = wasm.__newArray
    ? wasm.__newArray(wasm.StaticArrayU32_ID ?? 0, new Uint32Array(6))
    : null;
  if (buf != null) {
    wasm.__pin?.(buf);
    try {
      wasm.topoGetSummary(buf);
      const view = wasm.__getArray?.(buf) ?? wasm.__getArrayView?.(buf);
      const arr = view ? Array.from(view) : [0, 0, 0, 0, 0, 0];
      return {
        vertices: arr[0] | 0,
        edges: arr[1] | 0,
        coedges: arr[2] | 0,
        loops: arr[3] | 0,
        faces: arr[4] | 0,
        shells: arr[5] | 0,
      };
    } finally {
      wasm.__unpin?.(buf);
    }
  }
  // Fallback: use the individual count accessors, which are always exported.
  return {
    vertices: (wasm.vertexGetCount?.() ?? 0) | 0,
    edges: (wasm.edgeGetCount?.() ?? 0) | 0,
    coedges: (wasm.coedgeGetCount?.() ?? 0) | 0,
    loops: (wasm.loopGetCount?.() ?? 0) | 0,
    faces: (wasm.faceGetCount?.() ?? 0) | 0,
    shells: (wasm.shellGetCount?.() ?? 0) | 0,
  };
}

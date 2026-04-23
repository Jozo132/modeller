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
    GEOM_LINE: _num(w.GEOM_LINE, 7),
    ORIENT_FORWARD: _num(w.ORIENT_FORWARD, 0),
    ORIENT_REVERSED: _num(w.ORIENT_REVERSED, 1),
  };
}

/**
 * @typedef {Object} TopoSerializeResult
 * @property {number} faceCount - Number of WASM faces actually added.
 * @property {Map<object, number>} vertexMap - TopoVertex → WASM vertex id.
 * @property {Map<object, number>} edgeMap - TopoEdge → WASM edge id.
 * @property {Map<object, number>} faceMap - TopoFace → WASM face id.
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
 * Faces with unsupported surface types are still added topologically but
 * carry `GEOM_NONE`, matching the prior Containment behavior.
 *
 * @param {import('../BRepTopology.js').TopoBody} body
 * @param {object} wasm - WASM kernel module (build/release.js exports)
 * @returns {TopoSerializeResult}
 */
export function loadBodyIntoWasm(body, wasm) {
  const w = wasm;
  const K = _kernelConstants(w);
  const vertexMap = new Map();
  const edgeMap = new Map();
  const faceMap = new Map();

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
        edgeMap.set(edge, w.edgeAdd(sv, ev, K.GEOM_LINE, 0));
      }
    }
  }

  // ---- faces + loops + coedges ------------------------------------------
  let wasmFaceId = 0;
  for (const face of allFaces) {
    const loops = _loopsOf(face).filter(Boolean);
    if (loops.length === 0) continue;

    const { geomType, geomOffset } = _storeFaceGeometry(face, w, K);
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
    wasmFaceId++;
  }

  if (wasmFaceId > 0) {
    w.shellAdd(0, wasmFaceId, 1);
  }

  return { faceCount: wasmFaceId, vertexMap, edgeMap, faceMap };
}

function _loopsOf(face) {
  if (!face) return [];
  return [face.outerLoop, ...(face.innerLoops || [])].filter(Boolean);
}

function _storeFaceGeometry(face, w, K) {
  const fallback = { geomType: K.GEOM_NONE, geomOffset: 0 };
  if (!face) return fallback;
  const si = face.surface ? (face.surface.surfaceInfo || face.surface._analyticParams) : null;

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

  if (!face.surface) return fallback;

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

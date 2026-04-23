// packages/ir/canonicalize.js — Deterministic canonicalization of TopoBody
//
// Produces a canonical flat representation of a TopoBody graph suitable
// for deterministic binary serialization. Assigns stable sequential indices
// and orders all entities by canonical traversal.
//
// Canonicalization rules:
//   1. Float snapping: values with |v| < 1e-12 → 0 (matches STEP import)
//   2. Traversal order: shells → faces (per shell) → outerLoop then innerLoops
//      → coedges (per loop) — all in declaration order
//   3. Entities receive 0-based indices in first-visit order
//   4. Geometry pools (curves, surfaces, surfaceInfos) deduplicated by
//      reference identity, indexed in first-visit order
//   5. Orientation (sameSense) preserved as-is

import { SurfTypeId, SurfInfoTypeId, FeatureFlag } from './schema.js';

/**
 * Snap near-zero floats to exactly 0, matching STEP import behavior.
 * @param {number} v
 * @returns {number}
 */
export function snapFloat(v) {
  return Math.abs(v) < 1e-12 ? 0 : v;
}

/**
 * Snap a 3D point's components.
 * @param {{x:number,y:number,z:number}} p
 * @returns {{x:number,y:number,z:number}}
 */
export function snapPoint(p) {
  return { x: snapFloat(p.x), y: snapFloat(p.y), z: snapFloat(p.z) };
}

/**
 * Canonicalize a TopoBody into flat indexed arrays with stable ordering.
 *
 * @param {import('../../js/cad/BRepTopology.js').TopoBody} body
 * @returns {{
 *   vertices: Array<{x:number,y:number,z:number,tolerance:number}>,
 *   edges: Array<{startVertexIdx:number,endVertexIdx:number,curveIdx:number,tolerance:number}>,
 *   coedges: Array<{edgeIdx:number,sameSense:boolean,pCurveIdx:number}>,
 *   loops: Array<{coedgeIndices:number[]}>,
 *   faces: Array<{surfaceTypeId:number,surfaceIdx:number,sameSense:boolean,outerLoopIdx:number,innerLoopIndices:number[],surfaceInfoIdx:number,tolerance:number}>,
 *   shells: Array<{closed:boolean,faceIndices:number[]}>,
 *   curves: Array<{degree:number,controlPoints:Array<{x:number,y:number,z:number}>,knots:number[],weights:number[]}>,
 *   surfaces: Array<{degreeU:number,degreeV:number,numRowsU:number,numColsV:number,controlPoints:Array<{x:number,y:number,z:number}>,knotsU:number[],knotsV:number[],weights:number[]}>,
 *   surfaceInfos: Array<{typeId:number,origin:{x:number,y:number,z:number},axis:{x:number,y:number,z:number}|null,radius:number,semiAngle:number,majorR:number,minorR:number}>,
 *   featureFlags: number,
 * }}
 */
export function canonicalize(body) {
  // Maps from original object → canonical index
  const vertexMap = new Map();
  const edgeMap = new Map();
  const coedgeMap = new Map();
  const loopMap = new Map();
  const curveMap = new Map();
  const surfaceMap = new Map();
  const surfInfoMap = new Map();

  const vertices = [];
  const edges = [];
  const coedges = [];
  const loops = [];
  const faces = [];
  const shells = [];
  const curves = [];
  const surfaces = [];
  const surfaceInfos = [];

  let featureFlags = FeatureFlag.NONE;

  // ── Pool helpers ──

  function internVertex(v) {
    if (vertexMap.has(v)) return vertexMap.get(v);
    const idx = vertices.length;
    vertexMap.set(v, idx);
    const p = snapPoint(v.point);
    vertices.push({ x: p.x, y: p.y, z: p.z, tolerance: v.tolerance || 0 });
    return idx;
  }

  function internCurve(c) {
    if (!c) return -1;
    if (curveMap.has(c)) return curveMap.get(c);
    const idx = curves.length;
    curveMap.set(c, idx);
    curves.push({
      degree: c.degree,
      controlPoints: c.controlPoints.map(p => snapPoint(p)),
      knots: c.knots.map(k => snapFloat(k)),
      weights: [...c.weights],
    });
    return idx;
  }

  function internSurface(s) {
    if (!s) return -1;
    if (surfaceMap.has(s)) return surfaceMap.get(s);
    const idx = surfaces.length;
    surfaceMap.set(s, idx);
    surfaces.push({
      degreeU: s.degreeU,
      degreeV: s.degreeV,
      numRowsU: s.numRowsU,
      numColsV: s.numColsV,
      controlPoints: s.controlPoints.map(p => snapPoint(p)),
      knotsU: s.knotsU.map(k => snapFloat(k)),
      knotsV: s.knotsV.map(k => snapFloat(k)),
      weights: [...s.weights],
    });
    return idx;
  }

  function internSurfaceInfo(info) {
    if (!info) return -1;
    if (surfInfoMap.has(info)) return surfInfoMap.get(info);
    const idx = surfaceInfos.length;
    surfInfoMap.set(info, idx);
    const typeId = SurfInfoTypeId[info.type] ?? 0;
    const origin = info.origin ? snapPoint(info.origin) : { x: 0, y: 0, z: 0 };
    const axis = info.axis ? snapPoint(info.axis) : null;
    const xDir = info.xDir ? snapPoint(info.xDir) : null;
    surfaceInfos.push({
      typeId,
      origin,
      axis,
      xDir,
      radius: info.radius ?? 0,
      semiAngle: info.semiAngle ?? 0,
      majorR: info.majorR ?? 0,
      minorR: info.minorR ?? 0,
    });
    return idx;
  }

  function internEdge(e) {
    if (edgeMap.has(e)) return edgeMap.get(e);
    const idx = edges.length;
    edgeMap.set(e, idx);
    edges.push(null); // reserve slot
    const svIdx = internVertex(e.startVertex);
    const evIdx = internVertex(e.endVertex);
    const cIdx = internCurve(e.curve);
    edges[idx] = { startVertexIdx: svIdx, endVertexIdx: evIdx, curveIdx: cIdx, tolerance: e.tolerance || 0 };
    return idx;
  }

  function internCoEdge(ce) {
    if (coedgeMap.has(ce)) return coedgeMap.get(ce);
    const idx = coedges.length;
    coedgeMap.set(ce, idx);
    coedges.push(null); // reserve slot
    const eIdx = internEdge(ce.edge);
    const pIdx = internCurve(ce.pCurve);
    coedges[idx] = { edgeIdx: eIdx, sameSense: ce.sameSense, pCurveIdx: pIdx };
    return idx;
  }

  function internLoop(l) {
    if (loopMap.has(l)) return loopMap.get(l);
    const idx = loops.length;
    loopMap.set(l, idx);
    loops.push(null); // reserve slot
    const ceIndices = l.coedges.map(ce => internCoEdge(ce));
    loops[idx] = { coedgeIndices: ceIndices };
    return idx;
  }

  // ── Traverse body in canonical order ──

  for (const shell of body.shells) {
    const faceIndices = [];

    for (const face of shell.faces) {
      const fIdx = faces.length;
      faces.push(null); // reserve slot

      const sTypeId = SurfTypeId[face.surfaceType] ?? SurfTypeId['unknown'];
      const surfIdx = internSurface(face.surface);
      const olIdx = face.outerLoop ? internLoop(face.outerLoop) : -1;
      const ilIndices = (face.innerLoops || []).map(il => internLoop(il));

      let siIdx = -1;
      if (face.surfaceInfo) {
        siIdx = internSurfaceInfo(face.surfaceInfo);
        featureFlags |= FeatureFlag.HAS_SURFACE_INFOS;
        // Any xDir anywhere promotes the file to the v2 layout. Writer
        // reads this flag to decide record size; reader keys on it too.
        if (face.surfaceInfo.xDir) {
          featureFlags |= FeatureFlag.HAS_SURFACE_INFOS_V2;
        }
      }

      faces[fIdx] = {
        surfaceTypeId: sTypeId,
        surfaceIdx: surfIdx,
        sameSense: face.sameSense,
        outerLoopIdx: olIdx,
        innerLoopIndices: ilIndices,
        surfaceInfoIdx: siIdx,
        tolerance: face.tolerance || 0,
      };

      faceIndices.push(fIdx);
    }

    shells.push({ closed: shell.closed || false, faceIndices });
  }

  return {
    vertices,
    edges,
    coedges,
    loops,
    faces,
    shells,
    curves,
    surfaces,
    surfaceInfos,
    featureFlags,
  };
}

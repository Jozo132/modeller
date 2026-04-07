// js/cad/BRepTopology.js — Full B-Rep topology graph
//
// Replaces the minimal B-Rep with a complete topology graph suitable for
// manufacturing-grade exact-geometry operations:
//
//   BRepBody → BRepShell → BRepFace → BRepLoop → BRepCoEdge → BRepEdge → BRepVertex
//
// Every face carries a support surface (plane, cylinder, cone, sphere, torus,
// extrusion, revolution, bspline). Every edge carries an exact 3D curve and
// optional p-curves on adjacent faces. This is the minimum topology required
// for STEP-quality boolean operations and export.

import { NurbsCurve } from './NurbsCurve.js';
import { NurbsSurface } from './NurbsSurface.js';
import { DEFAULT_TOLERANCE } from './Tolerance.js';

// -----------------------------------------------------------------------
// Surface type constants
// -----------------------------------------------------------------------

export const SurfaceType = Object.freeze({
  PLANE:              'plane',
  CYLINDER:           'cylinder',
  CONE:               'cone',
  SPHERE:             'sphere',
  TORUS:              'torus',
  EXTRUSION:          'extrusion',
  REVOLUTION:         'revolution',
  BSPLINE:            'bspline',
  UNKNOWN:            'unknown',
});

// -----------------------------------------------------------------------
// BRepVertex
// -----------------------------------------------------------------------

/**
 * BRepVertex — A topological vertex with exact 3D position.
 */
export class TopoVertex {
  /**
   * @param {{x:number,y:number,z:number}} point
   * @param {number} [tolerance=0]
   */
  constructor(point, tolerance = 0) {
    this.point = { x: point.x, y: point.y, z: point.z };
    this.tolerance = tolerance;
    /** @type {TopoEdge[]} Incident edges */
    this.edges = [];
    /** Unique id for topology graph traversal */
    this.id = TopoVertex._nextId++;
  }

  clone() {
    const v = new TopoVertex({ ...this.point }, this.tolerance);
    v.id = this.id;
    return v;
  }

  serialize() {
    return { id: this.id, point: { ...this.point }, tolerance: this.tolerance };
  }

  static deserialize(data) {
    const v = new TopoVertex(data.point, data.tolerance || 0);
    v.id = data.id ?? v.id;
    return v;
  }
}
TopoVertex._nextId = 0;

/**
 * Reset the vertex id counter (for testing).
 */
export function resetTopoIds() {
  TopoVertex._nextId = 0;
  TopoEdge._nextId = 0;
  TopoCoEdge._nextId = 0;
  TopoLoop._nextId = 0;
  TopoFace._nextId = 0;
  TopoShell._nextId = 0;
  TopoBody._nextId = 0;
}

// -----------------------------------------------------------------------
// TopoEdge
// -----------------------------------------------------------------------

/**
 * TopoEdge — A topological edge with exact 3D curve and endpoint vertices.
 */
export class TopoEdge {
  /**
   * @param {TopoVertex} startVertex
   * @param {TopoVertex} endVertex
   * @param {NurbsCurve|null} [curve=null] - Exact 3D edge curve
   * @param {number} [tolerance=0]
   */
  constructor(startVertex, endVertex, curve = null, tolerance = 0) {
    this.startVertex = startVertex;
    this.endVertex = endVertex;
    this.curve = curve;
    this.tolerance = tolerance;
    /** @type {TopoCoEdge[]} Adjacent coedges (one per face sharing this edge) */
    this.coedges = [];
    this.id = TopoEdge._nextId++;

    // Register with vertices
    if (startVertex && !startVertex.edges.includes(this)) startVertex.edges.push(this);
    if (endVertex && !endVertex.edges.includes(this)) endVertex.edges.push(this);
  }

  /**
   * Tessellate this edge.
   * @param {number} [segments=16]
   * @returns {Array<{x,y,z}>}
   */
  tessellate(segments = 16) {
    if (this.curve) return this.curve.tessellate(segments);
    const s = this.startVertex.point, e = this.endVertex.point;
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      pts.push({
        x: s.x + t * (e.x - s.x),
        y: s.y + t * (e.y - s.y),
        z: s.z + t * (e.z - s.z),
      });
    }
    return pts;
  }

  /**
   * The other vertex from a given one.
   * @param {TopoVertex} v
   * @returns {TopoVertex}
   */
  otherVertex(v) {
    return v === this.startVertex ? this.endVertex : this.startVertex;
  }

  clone() {
    const e = new TopoEdge(
      this.startVertex ? this.startVertex.clone() : null,
      this.endVertex ? this.endVertex.clone() : null,
      this.curve ? this.curve.clone() : null,
      this.tolerance,
    );
    e.id = this.id;
    return e;
  }

  serialize() {
    return {
      id: this.id,
      startVertexId: this.startVertex ? this.startVertex.id : null,
      endVertexId: this.endVertex ? this.endVertex.id : null,
      curve: this.curve ? this.curve.serialize() : null,
      tolerance: this.tolerance,
    };
  }
}
TopoEdge._nextId = 0;

// -----------------------------------------------------------------------
// TopoCoEdge (oriented edge use within a loop)
// -----------------------------------------------------------------------

/**
 * TopoCoEdge — An oriented usage of an edge within a face loop.
 *
 * Each edge typically has two coedges (one per adjacent face). The coedge
 * stores the orientation (same or opposite to the underlying edge direction)
 * and an optional p-curve in the owning face's parameter space.
 */
export class TopoCoEdge {
  /**
   * @param {TopoEdge} edge - The topological edge
   * @param {boolean} [sameSense=true] - true if coedge direction matches edge direction
   * @param {NurbsCurve|null} [pCurve=null] - 2D curve in face parameter space
   */
  constructor(edge, sameSense = true, pCurve = null) {
    this.edge = edge;
    this.sameSense = sameSense;
    this.pCurve = pCurve;
    /** @type {TopoLoop|null} Owning loop */
    this.loop = null;
    /** @type {TopoFace|null} Owning face */
    this.face = null;
    this.id = TopoCoEdge._nextId++;

    // Register with edge
    if (edge && !edge.coedges.includes(this)) edge.coedges.push(this);
  }

  /**
   * Start vertex of this coedge (respecting orientation).
   * @returns {TopoVertex}
   */
  startVertex() {
    return this.sameSense ? this.edge.startVertex : this.edge.endVertex;
  }

  /**
   * End vertex of this coedge (respecting orientation).
   * @returns {TopoVertex}
   */
  endVertex() {
    return this.sameSense ? this.edge.endVertex : this.edge.startVertex;
  }

  clone() {
    const c = new TopoCoEdge(
      this.edge, this.sameSense,
      this.pCurve ? this.pCurve.clone() : null,
    );
    c.id = this.id;
    return c;
  }

  serialize() {
    return {
      id: this.id,
      edgeId: this.edge ? this.edge.id : null,
      sameSense: this.sameSense,
      pCurve: this.pCurve ? this.pCurve.serialize() : null,
    };
  }
}
TopoCoEdge._nextId = 0;

// -----------------------------------------------------------------------
// TopoLoop
// -----------------------------------------------------------------------

/**
 * TopoLoop — An ordered cycle of coedges forming a face boundary.
 *
 * The outer loop of a face winds CCW when viewed from the face-outward direction.
 * Inner loops (holes) wind CW.
 */
export class TopoLoop {
  /**
   * @param {TopoCoEdge[]} [coedges=[]]
   */
  constructor(coedges = []) {
    this.coedges = coedges;
    /** @type {TopoFace|null} Owning face */
    this.face = null;
    this.id = TopoLoop._nextId++;

    for (const ce of coedges) {
      ce.loop = this;
    }
  }

  /**
   * Check if this loop is topologically closed.
   * @returns {boolean}
   */
  isClosed() {
    if (this.coedges.length === 0) return false;
    for (let i = 0; i < this.coedges.length; i++) {
      const curr = this.coedges[i];
      const next = this.coedges[(i + 1) % this.coedges.length];
      if (curr.endVertex() !== next.startVertex()) return false;
    }
    return true;
  }

  /**
   * Get ordered vertices around the loop.
   * @returns {TopoVertex[]}
   */
  vertices() {
    return this.coedges.map(ce => ce.startVertex());
  }

  /**
   * Get ordered 3D points around the loop.
   * @returns {Array<{x,y,z}>}
   */
  points() {
    return this.vertices().map(v => ({ ...v.point }));
  }

  clone() {
    const l = new TopoLoop(this.coedges.map(ce => ce.clone()));
    l.id = this.id;
    return l;
  }

  serialize() {
    return {
      id: this.id,
      coedgeIds: this.coedges.map(ce => ce.id),
    };
  }
}
TopoLoop._nextId = 0;

// -----------------------------------------------------------------------
// TopoFace
// -----------------------------------------------------------------------

/**
 * TopoFace — A bounded region on a support surface.
 *
 * The face knows its support surface type, the NURBS surface definition,
 * the outer trim loop, and any inner trim loops (holes).
 */
export class TopoFace {
  /**
   * @param {NurbsSurface|null} surface - Support surface
   * @param {string} surfaceType - One of SurfaceType constants
   * @param {boolean} [sameSense=true] - true if face normal agrees with surface normal
   */
  constructor(surface = null, surfaceType = SurfaceType.UNKNOWN, sameSense = true) {
    this.surface = surface;
    this.surfaceType = surfaceType;
    this.sameSense = sameSense;
    /**
     * Analytic surface geometry for per-vertex normal computation.
     * Populated for cylinder, sphere, cone, torus surfaces.
     * @type {{ type:string, origin:{x,y,z}, axis?:{x,y,z}, radius?:number, semiAngle?:number, majorR?:number, minorR?:number }|null}
     */
    this.surfaceInfo = null;
    /** @type {TopoLoop|null} Outer boundary loop */
    this.outerLoop = null;
    /** @type {TopoLoop[]} Inner loops (holes) */
    this.innerLoops = [];
    /** @type {TopoShell|null} Owning shell */
    this.shell = null;
    /** Shared metadata (sourceFeatureId, etc.) */
    this.shared = null;
    this.tolerance = 0;
    this.id = TopoFace._nextId++;
  }

  /**
   * Set the outer boundary loop.
   * @param {TopoLoop} loop
   */
  setOuterLoop(loop) {
    this.outerLoop = loop;
    loop.face = this;
    for (const ce of loop.coedges) ce.face = this;
  }

  /**
   * Add an inner (hole) loop.
   * @param {TopoLoop} loop
   */
  addInnerLoop(loop) {
    this.innerLoops.push(loop);
    loop.face = this;
    for (const ce of loop.coedges) ce.face = this;
  }

  /**
   * Get all loops (outer + inner).
   * @returns {TopoLoop[]}
   */
  allLoops() {
    const loops = [];
    if (this.outerLoop) loops.push(this.outerLoop);
    loops.push(...this.innerLoops);
    return loops;
  }

  /**
   * Get all edges referenced by this face.
   * @returns {TopoEdge[]}
   */
  edges() {
    const edgeSet = new Set();
    for (const loop of this.allLoops()) {
      for (const ce of loop.coedges) edgeSet.add(ce.edge);
    }
    return [...edgeSet];
  }

  /**
   * Get all vertices referenced by this face.
   * @returns {TopoVertex[]}
   */
  vertices() {
    const vertSet = new Set();
    for (const loop of this.allLoops()) {
      for (const ce of loop.coedges) {
        vertSet.add(ce.edge.startVertex);
        vertSet.add(ce.edge.endVertex);
      }
    }
    return [...vertSet];
  }

  clone() {
    const f = new TopoFace(
      this.surface ? this.surface.clone() : null,
      this.surfaceType,
      this.sameSense,
    );
    f.shared = this.shared ? { ...this.shared } : null;
    f.surfaceInfo = this.surfaceInfo ? { ...this.surfaceInfo } : null;
    f.tolerance = this.tolerance;
    f.id = this.id;
    if (this.outerLoop) f.setOuterLoop(this.outerLoop.clone());
    for (const il of this.innerLoops) f.addInnerLoop(il.clone());
    return f;
  }

  serialize() {
    return {
      id: this.id,
      surfaceType: this.surfaceType,
      surface: this.surface ? this.surface.serialize() : null,
      sameSense: this.sameSense,
      surfaceInfo: this.surfaceInfo || null,
      outerLoopId: this.outerLoop ? this.outerLoop.id : null,
      innerLoopIds: this.innerLoops.map(l => l.id),
      shared: this.shared,
      tolerance: this.tolerance,
    };
  }
}
TopoFace._nextId = 0;

// -----------------------------------------------------------------------
// TopoShell
// -----------------------------------------------------------------------

/**
 * TopoShell — A connected set of faces forming a closed or open shell.
 */
export class TopoShell {
  /**
   * @param {TopoFace[]} [faces=[]]
   */
  constructor(faces = []) {
    this.faces = faces;
    /** @type {TopoBody|null} Owning body */
    this.body = null;
    /** Whether this is a closed (manifold) shell */
    this.closed = false;
    this.id = TopoShell._nextId++;

    for (const f of faces) f.shell = this;
  }

  addFace(face) {
    this.faces.push(face);
    face.shell = this;
  }

  /**
   * Get all unique edges in this shell.
   * @returns {TopoEdge[]}
   */
  edges() {
    const edgeSet = new Set();
    for (const f of this.faces) {
      for (const e of f.edges()) edgeSet.add(e);
    }
    return [...edgeSet];
  }

  /**
   * Get all unique vertices in this shell.
   * @returns {TopoVertex[]}
   */
  vertices() {
    const vertSet = new Set();
    for (const f of this.faces) {
      for (const v of f.vertices()) vertSet.add(v);
    }
    return [...vertSet];
  }

  clone() {
    const s = new TopoShell(this.faces.map(f => f.clone()));
    s.closed = this.closed;
    s.id = this.id;
    return s;
  }

  serialize() {
    return {
      id: this.id,
      closed: this.closed,
      faceIds: this.faces.map(f => f.id),
    };
  }
}
TopoShell._nextId = 0;

// -----------------------------------------------------------------------
// TopoBody
// -----------------------------------------------------------------------

/**
 * TopoBody — The top-level topological entity representing a solid.
 *
 * Contains one or more shells (outer shell, possibly void shells for
 * internal cavities).
 */
export class TopoBody {
  /**
   * @param {TopoShell[]} [shells=[]]
   */
  constructor(shells = []) {
    this.shells = shells;
    this.id = TopoBody._nextId++;

    for (const s of shells) s.body = this;
  }

  addShell(shell) {
    this.shells.push(shell);
    shell.body = this;
  }

  /**
   * Get the outer (first) shell.
   * @returns {TopoShell|null}
   */
  outerShell() {
    return this.shells.length > 0 ? this.shells[0] : null;
  }

  /**
   * Get all faces across all shells.
   * @returns {TopoFace[]}
   */
  faces() {
    const faces = [];
    for (const s of this.shells) faces.push(...s.faces);
    return faces;
  }

  /**
   * Get all unique edges across all shells.
   * @returns {TopoEdge[]}
   */
  edges() {
    const edgeSet = new Set();
    for (const s of this.shells) {
      for (const e of s.edges()) edgeSet.add(e);
    }
    return [...edgeSet];
  }

  /**
   * Get all unique vertices across all shells.
   * @returns {TopoVertex[]}
   */
  vertices() {
    const vertSet = new Set();
    for (const s of this.shells) {
      for (const v of s.vertices()) vertSet.add(v);
    }
    return [...vertSet];
  }

  clone() {
    const b = new TopoBody(this.shells.map(s => s.clone()));
    b.id = this.id;
    return b;
  }

  serialize() {
    // Full graph serialization
    const vertices = [];
    const edges = [];
    const coedges = [];
    const loops = [];
    const faces = [];
    const shells = [];

    const vertMap = new Map();
    const edgeMap = new Map();
    const ceMap = new Map();
    const loopMap = new Map();

    for (const s of this.shells) {
      for (const f of s.faces) {
        for (const l of f.allLoops()) {
          for (const ce of l.coedges) {
            const e = ce.edge;
            if (!vertMap.has(e.startVertex.id)) {
              vertMap.set(e.startVertex.id, e.startVertex.serialize());
            }
            if (!vertMap.has(e.endVertex.id)) {
              vertMap.set(e.endVertex.id, e.endVertex.serialize());
            }
            if (!edgeMap.has(e.id)) {
              edgeMap.set(e.id, e.serialize());
            }
            if (!ceMap.has(ce.id)) {
              ceMap.set(ce.id, ce.serialize());
            }
          }
          if (!loopMap.has(l.id)) {
            loopMap.set(l.id, l.serialize());
          }
        }
        faces.push(f.serialize());
      }
      shells.push(s.serialize());
    }

    return {
      type: 'TopoBody',
      id: this.id,
      vertices: [...vertMap.values()],
      edges: [...edgeMap.values()],
      coedges: [...ceMap.values()],
      loops: [...loopMap.values()],
      faces,
      shells,
    };
  }

  /**
   * Deserialize from a plain object.
   * @param {Object} data
   * @returns {TopoBody}
   */
  static deserialize(data) {
    if (!data || data.type !== 'TopoBody') return new TopoBody();

    // Rebuild vertex map
    const vertMap = new Map();
    for (const vd of (data.vertices || [])) {
      const v = TopoVertex.deserialize(vd);
      vertMap.set(v.id, v);
    }

    // Rebuild edge map
    const edgeMap = new Map();
    for (const ed of (data.edges || [])) {
      const sv = vertMap.get(ed.startVertexId);
      const ev = vertMap.get(ed.endVertexId);
      const curve = ed.curve ? NurbsCurve.deserialize(ed.curve) : null;
      const e = new TopoEdge(sv, ev, curve, ed.tolerance || 0);
      e.id = ed.id;
      edgeMap.set(e.id, e);
    }

    // Rebuild coedge map
    const ceMap = new Map();
    for (const cd of (data.coedges || [])) {
      const edge = edgeMap.get(cd.edgeId);
      const pCurve = cd.pCurve ? NurbsCurve.deserialize(cd.pCurve) : null;
      const ce = new TopoCoEdge(edge, cd.sameSense, pCurve);
      ce.id = cd.id;
      ceMap.set(ce.id, ce);
    }

    // Rebuild loop map
    const loopMap = new Map();
    for (const ld of (data.loops || [])) {
      const ces = (ld.coedgeIds || []).map(id => ceMap.get(id)).filter(Boolean);
      const loop = new TopoLoop(ces);
      loop.id = ld.id;
      loopMap.set(loop.id, loop);
    }

    // Rebuild faces
    const faceMap = new Map();
    for (const fd of (data.faces || [])) {
      const surf = fd.surface ? NurbsSurface.deserialize(fd.surface) : null;
      const face = new TopoFace(surf, fd.surfaceType || SurfaceType.UNKNOWN, fd.sameSense !== false);
      face.id = fd.id;
      face.shared = fd.shared || null;
      face.surfaceInfo = fd.surfaceInfo || null;
      face.tolerance = fd.tolerance || 0;
      if (fd.outerLoopId != null) {
        const ol = loopMap.get(fd.outerLoopId);
        if (ol) face.setOuterLoop(ol);
      }
      for (const ilId of (fd.innerLoopIds || [])) {
        const il = loopMap.get(ilId);
        if (il) face.addInnerLoop(il);
      }
      faceMap.set(face.id, face);
    }

    // Rebuild shells
    const shells = [];
    for (const sd of (data.shells || [])) {
      const faces = (sd.faceIds || []).map(id => faceMap.get(id)).filter(Boolean);
      const shell = new TopoShell(faces);
      shell.id = sd.id;
      shell.closed = sd.closed || false;
      shells.push(shell);
    }

    const body = new TopoBody(shells);
    body.id = data.id ?? body.id;
    return body;
  }
}
TopoBody._nextId = 0;

// -----------------------------------------------------------------------
// Builder helpers
// -----------------------------------------------------------------------

/**
 * Compute the correct sameSense flag for a face by comparing the vertex-loop
 * winding normal (Newell method) to the surface normal at the parametric
 * center.  Returns true if both agree (outward), false if the surface normal
 * must be flipped.  Falls back to true when no determination is possible.
 *
 * @param {import('./NurbsSurface.js').NurbsSurface|null} surface
 * @param {Array<{x:number,y:number,z:number}|{point:{x:y,z}}>} vertices - Raw points or vertex objects with .point
 * @returns {boolean}
 */
function _computeSameSense(surface, vertices) {
  if (!surface || !vertices || vertices.length < 3) return true;

  // 1. Loop normal via Newell method
  const pts = vertices.map(v => v.point ? v.point : v);
  let lnx = 0, lny = 0, lnz = 0;
  for (let i = 0; i < pts.length; i++) {
    const c = pts[i];
    const n = pts[(i + 1) % pts.length];
    lnx += (c.y - n.y) * (c.z + n.z);
    lny += (c.z - n.z) * (c.x + n.x);
    lnz += (c.x - n.x) * (c.y + n.y);
  }
  const llen = Math.sqrt(lnx * lnx + lny * lny + lnz * lnz);
  if (llen < 1e-10) return true; // degenerate loop, can't determine
  lnx /= llen; lny /= llen; lnz /= llen;

  // 2. Surface normal at (0.5, 0.5) via finite differences
  try {
    const eps = 1e-4;
    const p = surface.evaluate(0.5, 0.5);
    const pu = surface.evaluate(0.5 + eps, 0.5);
    const pv = surface.evaluate(0.5, 0.5 + eps);
    if (!p || !pu || !pv) return true;
    const dux = (pu.x - p.x) / eps, duy = (pu.y - p.y) / eps, duz = (pu.z - p.z) / eps;
    const dvx = (pv.x - p.x) / eps, dvy = (pv.y - p.y) / eps, dvz = (pv.z - p.z) / eps;
    const snx = duy * dvz - duz * dvy;
    const sny = duz * dvx - dux * dvz;
    const snz = dux * dvy - duy * dvx;
    const slen = Math.sqrt(snx * snx + sny * sny + snz * snz);
    if (slen < 1e-10) return true;
    const dot = lnx * (snx / slen) + lny * (sny / slen) + lnz * (snz / slen);
    return dot >= 0;
  } catch {
    return true;
  }
}

/**
 * Build a TopoBody from a set of flat face descriptions.
 * Useful for constructing topology from feature generators.
 *
 * @param {Array<{
 *   surface: NurbsSurface|null,
 *   surfaceType: string,
 *   vertices: Array<{x,y,z,topologyKey?:string}>,
 *   edgeCurves: Array<NurbsCurve|null>,
 *   innerLoops?: Array<{
 *     vertices: Array<{x,y,z,topologyKey?:string}>,
 *     edgeCurves?: Array<NurbsCurve|null>,
 *   }>,
 *   shared: Object|null,
 * }>} faceDescs
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {TopoBody}
 */
export function buildTopoBody(faceDescs, tol = DEFAULT_TOLERANCE) {
  // Vertex deduplication map: "x,y,z" -> TopoVertex
  const fmtCoord = (n) => (Math.abs(n) < 1e-12 ? 0 : n).toFixed(8);
  const vertKey = (p) => `${fmtCoord(p.x)},${fmtCoord(p.y)},${fmtCoord(p.z)}`;
  const vertMap = new Map();
  const getOrCreateVertex = (entry) => {
    const point = entry && entry.point ? entry.point : entry;
    const key = entry && entry.topologyKey ? `topology:${entry.topologyKey}` : vertKey(point);
    if (vertMap.has(key)) return vertMap.get(key);
    const v = new TopoVertex(point, tol.pointCoincidence);
    vertMap.set(key, v);
    return v;
  };

  // Edge deduplication: "v1.id,v2.id" -> TopoEdge[] (unordered)
  // Multiple edges can connect the same two vertices with different curves
  // (e.g. upper and lower semicircular arcs of a circle).
  const edgeMap = new Map();

  /** Check if two edge curves follow the same geometric path. */
  const _curvesCompatible = (c1, c2) => {
    if (!c1 || !c2) return true; // null/line edges are always compatible
    if (c1 === c2) return true;
    if (c1.degree !== c2.degree) return false;
    try {
      // Evaluate at the normalized midpoint of each curve's knot domain.
      // Polyline knots may span [0, N-1] rather than [0, 1], so using a
      // fixed parameter like 0.5 would compare different geometric positions
      // for curves with different knot ranges.
      const k1s = c1.knots, k2s = c2.knots;
      const t1 = (k1s[0] + k1s[k1s.length - 1]) * 0.5;
      const t2 = (k2s[0] + k2s[k2s.length - 1]) * 0.5;
      const m1 = c1.evaluate(t1);
      const m2 = c2.evaluate(t2);
      const d = Math.sqrt((m1.x - m2.x) ** 2 + (m1.y - m2.y) ** 2 + (m1.z - m2.z) ** 2);
      // Tolerance relaxed from 1e-6 to 1e-4 to accommodate numerical
      // precision differences between polyline curves (many control points)
      // and simple line curves whose knot domains may differ.
      return d < 1e-4;
    } catch { return true; }
  };

  const getOrCreateEdge = (v1, v2, curve) => {
    const k1 = `${v1.id},${v2.id}`;
    const k2 = `${v2.id},${v1.id}`;
    const fwd = edgeMap.get(k1);
    if (fwd) {
      for (const e of fwd) {
        if (_curvesCompatible(e.curve, curve)) return { edge: e, sameSense: true };
      }
    }
    const rev = edgeMap.get(k2);
    if (rev) {
      for (const e of rev) {
        if (_curvesCompatible(e.curve, curve)) return { edge: e, sameSense: false };
      }
    }
    const e = new TopoEdge(v1, v2, curve, tol.edgeOverlap);
    if (!fwd) edgeMap.set(k1, [e]); else fwd.push(e);
    return { edge: e, sameSense: true };
  };

  const buildLoop = (loopDesc) => {
    const verts = (loopDesc.vertices || []).map((vertex) => getOrCreateVertex(vertex));
    const n = verts.length;
    const coedges = [];
    for (let i = 0; i < n; i++) {
      const v1 = verts[i];
      const v2 = verts[(i + 1) % n];
      const curve = (loopDesc.edgeCurves && loopDesc.edgeCurves[i]) || null;
      const { edge, sameSense } = getOrCreateEdge(v1, v2, curve);
      coedges.push(new TopoCoEdge(edge, sameSense, null));
    }
    return new TopoLoop(coedges);
  };

  const faces = [];

  for (const fd of faceDescs) {
    // Determine sameSense: if explicitly provided, use it.
    // Otherwise, auto-compute from vertex-loop winding vs. surface normal.
    let sameSense;
    if (fd.sameSense === true || fd.sameSense === false) {
      sameSense = fd.sameSense;
    } else {
      sameSense = _computeSameSense(fd.surface, fd.vertices);
    }

    const face = new TopoFace(
      fd.surface || null,
      fd.surfaceType || SurfaceType.UNKNOWN,
      sameSense
    );
    face.setOuterLoop(buildLoop({ vertices: fd.vertices || [], edgeCurves: fd.edgeCurves || [] }));
    for (const innerLoop of (fd.innerLoops || [])) {
      face.addInnerLoop(buildLoop(innerLoop));
    }
    face.shared = fd.shared || null;
    faces.push(face);
  }

  const shell = new TopoShell(faces);
  shell.closed = true; // Assume closed solid
  return new TopoBody([shell]);
}

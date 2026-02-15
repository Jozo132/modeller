// js/cad/Scene.js — Central manager for all primitives and constraints
import { PPoint } from './Point.js';
import { PSegment } from './Segment.js';
import { PArc } from './ArcPrimitive.js';
import { PCircle } from './CirclePrimitive.js';
import { TextPrimitive } from './TextPrimitive.js';
import { DimensionPrimitive } from './DimensionPrimitive.js';
import { solve } from './Solver.js';
import { resetPrimitiveIds, peekNextPrimitiveId } from './Primitive.js';
import { resetConstraintIds, serializeVariables, deserializeVariables, clearVariables } from './Constraint.js';
import {
  Coincident, Distance, Fixed,
  Horizontal, Vertical,
  Parallel, Perpendicular, Angle,
  EqualLength, Length,
  RadiusConstraint, Tangent,
  OnLine, OnCircle, Midpoint,
} from './Constraint.js';

const MERGE_TOLERANCE = 1e-4; // world units — points closer than this auto-merge

export class Scene {
  constructor() {
    this.points = [];       // PPoint[]
    this.segments = [];     // PSegment[]
    this.arcs = [];         // PArc[]
    this.circles = [];      // PCircle[]
    this.constraints = [];  // Constraint[]
    this.texts = [];        // TextPrimitive[] (pass-through, non-constraint)
    this.dimensions = [];   // DimensionPrimitive[] (pass-through)
  }

  // -----------------------------------------------------------------------
  // Point helpers
  // -----------------------------------------------------------------------

  /** Register a new free point. */
  addPoint(x, y, fixed = false) {
    const p = new PPoint(x, y, fixed);
    this.points.push(p);
    return p;
  }

  /** Find an existing point within tolerance, or create a new one. */
  getOrCreatePoint(x, y, tolerance = MERGE_TOLERANCE) {
    for (const p of this.points) {
      if (Math.hypot(p.x - x, p.y - y) < tolerance) return p;
    }
    return this.addPoint(x, y);
  }

  /** Find point by id */
  pointById(id) { return this.points.find(p => p.id === id) || null; }

  // -----------------------------------------------------------------------
  // Shape creation
  // -----------------------------------------------------------------------

  /** Add a line segment, auto-merging endpoints. */
  addSegment(x1, y1, x2, y2, { merge = true, layer = '0', color = null } = {}) {
    const p1 = merge ? this.getOrCreatePoint(x1, y1) : this.addPoint(x1, y1);
    const p2 = merge ? this.getOrCreatePoint(x2, y2) : this.addPoint(x2, y2);
    const seg = new PSegment(p1, p2);
    seg.layer = layer;
    seg.color = color;
    this.segments.push(seg);
    return seg;
  }

  addCircle(cx, cy, radius, { merge = true, layer = '0', color = null } = {}) {
    const center = merge ? this.getOrCreatePoint(cx, cy) : this.addPoint(cx, cy);
    const c = new PCircle(center, radius);
    c.layer = layer;
    c.color = color;
    this.circles.push(c);
    return c;
  }

  addArc(cx, cy, radius, startAngle, endAngle, { merge = true, layer = '0', color = null } = {}) {
    const center = merge ? this.getOrCreatePoint(cx, cy) : this.addPoint(cx, cy);
    const a = new PArc(center, radius, startAngle, endAngle);
    a.layer = layer;
    a.color = color;
    this.arcs.push(a);
    return a;
  }

  // -----------------------------------------------------------------------
  // Constraint management
  // -----------------------------------------------------------------------

  addConstraint(c) {
    this.constraints.push(c);
    this.solve();
    return c;
  }

  removeConstraint(c) {
    const idx = this.constraints.indexOf(c);
    if (idx >= 0) this.constraints.splice(idx, 1);
  }

  /** Run the solver on all constraints. */
  solve(opts) {
    const result = solve(this.constraints, opts);
    // Update dimension coordinates from live geometry after solving
    for (const dim of this.dimensions) {
      if (dim.sourceA) dim.syncFromSources();
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Removal
  // -----------------------------------------------------------------------

  removePoint(pt) {
    // Remove all shapes that reference this point
    this.segments = this.segments.filter(s => s.p1 !== pt && s.p2 !== pt);
    this.circles = this.circles.filter(c => c.center !== pt);
    this.arcs = this.arcs.filter(a => a.center !== pt);
    // Remove constraints referencing this point
    this.constraints = this.constraints.filter(c => !c.involvedPoints().includes(pt));
    // Remove the point itself
    this.points = this.points.filter(p => p !== pt);
  }

  removeSegment(seg) {
    this.segments = this.segments.filter(s => s !== seg);
    this.constraints = this.constraints.filter(c => {
      if (c.seg === seg || c.segA === seg || c.segB === seg) return false;
      if (c.sourceA === seg || c.sourceB === seg) return false;
      return true;
    });
    this._cleanOrphanPoints();
  }

  removeCircle(circ) {
    this.circles = this.circles.filter(c => c !== circ);
    this.constraints = this.constraints.filter(c => {
      if (c.circle === circ || c.shape === circ) return false;
      if (c.sourceA === circ || c.sourceB === circ) return false;
      return true;
    });
    this._cleanOrphanPoints();
  }

  removeArc(arc) {
    this.arcs = this.arcs.filter(a => a !== arc);
    this.constraints = this.constraints.filter(c => {
      if (c.circle === arc || c.shape === arc) return false;
      if (c.sourceA === arc || c.sourceB === arc) return false;
      return true;
    });
    this._cleanOrphanPoints();
  }

  removePrimitive(prim) {
    switch (prim.type) {
      case 'point':     this.removePoint(prim); break;
      case 'segment':   this.removeSegment(prim); break;
      case 'circle':    this.removeCircle(prim); break;
      case 'arc':       this.removeArc(prim); break;
      case 'dimension':
        this.dimensions = this.dimensions.filter(d => d !== prim);
        // Also remove from constraints if it was acting as one
        this.constraints = this.constraints.filter(c => c !== prim);
        break;
    }
  }

  /** Remove points not used by any shape. */
  _cleanOrphanPoints() {
    const used = new Set();
    for (const s of this.segments) { used.add(s.p1); used.add(s.p2); }
    for (const c of this.circles) { used.add(c.center); }
    for (const a of this.arcs) { used.add(a.center); }
    this.points = this.points.filter(p => used.has(p));
    this.constraints = this.constraints.filter(c =>
      c.involvedPoints().every(pt => this.points.includes(pt))
    );
    // Also mark orphaned dimension constraints as non-constraining
    for (const dim of this.dimensions) {
      if (dim.isConstraint && dim.sourceA) {
        const pts = dim.involvedPoints();
        if (pts.length > 0 && !pts.every(pt => this.points.includes(pt))) {
          dim.isConstraint = false;
          dim.sourceA = null;
          dim.sourceB = null;
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Iteration — all drawable primitives (used by renderer & snap)
  // -----------------------------------------------------------------------

  /** All drawable shapes (not bare points). */
  *shapes() {
    yield* this.segments;
    yield* this.circles;
    yield* this.arcs;
    yield* this.texts;
    yield* this.dimensions;
  }

  /** All primitives including bare points. */
  *allPrimitives() {
    yield* this.points;
    yield* this.segments;
    yield* this.circles;
    yield* this.arcs;
    yield* this.texts;
    yield* this.dimensions;
  }

  // -----------------------------------------------------------------------
  // Lookup helpers
  // -----------------------------------------------------------------------

  /** Find the shape closest to (wx, wy) within world tolerance. */
  findClosestShape(wx, wy, worldTolerance) {
    let best = null, bestDist = Infinity;
    for (const s of this.shapes()) {
      if (!s.visible) continue;
      const d = s.distanceTo(wx, wy);
      if (d < worldTolerance && d < bestDist) { bestDist = d; best = s; }
    }
    return best;
  }

  /** Find the closest point to (wx, wy) within world tolerance. */
  findClosestPoint(wx, wy, worldTolerance) {
    let best = null, bestDist = Infinity;
    for (const p of this.points) {
      const d = p.distanceTo(wx, wy);
      if (d < worldTolerance && d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  }

  /** Get all shapes that reference a given point. */
  shapesUsingPoint(pt) {
    const out = [];
    for (const s of this.segments) if (s.p1 === pt || s.p2 === pt) out.push(s);
    for (const c of this.circles) if (c.center === pt) out.push(c);
    for (const a of this.arcs) if (a.center === pt) out.push(a);
    return out;
  }

  /** Get constraints involving a specific primitive. */
  constraintsOn(prim) {
    return this.constraints.filter(c => {
      // Handle dimension constraints which use sourceA/sourceB
      if (c.type === 'dimension') {
        if (c.sourceA === prim || c.sourceB === prim) return true;
        const pts = c.involvedPoints();
        if (prim.type === 'point') return pts.includes(prim);
        if (prim.type === 'segment') return pts.includes(prim.p1) || pts.includes(prim.p2);
        if (prim.type === 'circle' || prim.type === 'arc') return pts.includes(prim.center);
        return false;
      }
      const pts = c.involvedPoints();
      if (prim.type === 'point') return pts.includes(prim);
      if (prim.type === 'segment') return c.seg === prim || c.segA === prim || c.segB === prim ||
        pts.includes(prim.p1) || pts.includes(prim.p2);
      if (prim.type === 'circle' || prim.type === 'arc') return c.circle === prim || c.shape === prim ||
        pts.includes(prim.center);
      return false;
    });
  }

  // -----------------------------------------------------------------------
  // Bounds for fitEntities
  // -----------------------------------------------------------------------

  getBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of this.shapes()) {
      const b = s.getBounds();
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }
    if (!isFinite(minX)) return { minX: -10, minY: -10, maxX: 10, maxY: 10 };
    return { minX, minY, maxX, maxY };
  }

  // -----------------------------------------------------------------------
  // Clear / reset
  // -----------------------------------------------------------------------

  clear() {
    this.points = [];
    this.segments = [];
    this.arcs = [];
    this.circles = [];
    this.constraints = [];
    this.texts = [];
    this.dimensions = [];
    resetPrimitiveIds();
    resetConstraintIds();
    clearVariables();
  }

  // -----------------------------------------------------------------------
  // Serialization (for history / persistence)
  // -----------------------------------------------------------------------

  serialize() {
    return {
      points: this.points.map(p => p.serialize()),
      segments: this.segments.map(s => s.serialize()),
      circles: this.circles.map(c => c.serialize()),
      arcs: this.arcs.map(a => a.serialize()),
      // Exclude dimension-type constraints — they are serialized via dimensions[]
      constraints: this.constraints.filter(c => c.type !== 'dimension').map(c => c.serialize()),
      texts: this.texts.map(t => t.serialize()),
      dimensions: this.dimensions.map(d => d.serialize()),
      variables: serializeVariables(),
    };
  }

  // -----------------------------------------------------------------------
  // Deserialization
  // -----------------------------------------------------------------------

  /** Restore a Scene from a plain JSON object produced by serialize(). */
  static deserialize(data) {
    const scene = new Scene();
    if (!data) return scene;

    // 1. Rebuild points & build id→point map
    const ptMap = new Map();
    let maxPrimId = 0;
    for (const d of (data.points || [])) {
      const p = new PPoint(d.x, d.y, d.fixed || false);
      p.id = d.id;
      p.layer = d.layer || '0';
      p.color = d.color || null;
      scene.points.push(p);
      ptMap.set(d.id, p);
      if (d.id > maxPrimId) maxPrimId = d.id;
    }

    // 2. Rebuild segments
    const shapeMap = new Map();
    for (const d of (data.segments || [])) {
      const p1 = ptMap.get(d.p1);
      const p2 = ptMap.get(d.p2);
      if (!p1 || !p2) continue;
      const seg = new PSegment(p1, p2);
      seg.id = d.id;
      seg.layer = d.layer || '0';
      seg.color = d.color || null;
      if (d.construction) seg.construction = true;
      scene.segments.push(seg);
      shapeMap.set(d.id, seg);
      if (d.id > maxPrimId) maxPrimId = d.id;
    }

    // 3. Rebuild circles
    for (const d of (data.circles || [])) {
      const center = ptMap.get(d.center);
      if (!center) continue;
      const c = new PCircle(center, d.radius);
      c.id = d.id;
      c.layer = d.layer || '0';
      c.color = d.color || null;
      if (d.construction) c.construction = true;
      scene.circles.push(c);
      shapeMap.set(d.id, c);
      if (d.id > maxPrimId) maxPrimId = d.id;
    }

    // 4. Rebuild arcs
    for (const d of (data.arcs || [])) {
      const center = ptMap.get(d.center);
      if (!center) continue;
      const a = new PArc(center, d.radius, d.startAngle, d.endAngle);
      a.id = d.id;
      a.layer = d.layer || '0';
      a.color = d.color || null;
      if (d.construction) a.construction = true;
      scene.arcs.push(a);
      shapeMap.set(d.id, a);
      if (d.id > maxPrimId) maxPrimId = d.id;
    }

    // 5. Rebuild texts
    for (const d of (data.texts || [])) {
      const t = new TextPrimitive(d.x, d.y, d.text, d.height);
      t.id = d.id;
      t.layer = d.layer || '0';
      t.color = d.color || null;
      t.rotation = d.rotation || 0;
      scene.texts.push(t);
      if (d.id > maxPrimId) maxPrimId = d.id;
    }

    // 6. Rebuild dimensions
    for (const d of (data.dimensions || [])) {
      const dm = new DimensionPrimitive(d.x1, d.y1, d.x2, d.y2, d.offset, {
        dimType: d.dimType,
        isConstraint: d.isConstraint,
        variableName: d.variableName,
        displayMode: d.displayMode,
        formula: d.formula,
        sourceAId: d.sourceAId,
        sourceBId: d.sourceBId,
      });
      dm.id = d.id;
      dm.layer = d.layer || '0';
      dm.color = d.color || null;
      if (d._angleStart != null) dm._angleStart = d._angleStart;
      if (d._angleSweep != null) dm._angleSweep = d._angleSweep;
      if (d.min != null) dm.min = d.min;
      if (d.max != null) dm.max = d.max;

      // Resolve source references from the rebuilt primitives
      if (d.sourceAId != null) {
        dm.sourceA = ptMap.get(d.sourceAId) || shapeMap.get(d.sourceAId) || null;
      }
      if (d.sourceBId != null) {
        dm.sourceB = ptMap.get(d.sourceBId) || shapeMap.get(d.sourceBId) || null;
      }

      scene.dimensions.push(dm);

      // If this dimension is a constraint and sources are resolved, add to solver
      if (dm.isConstraint && dm.sourceA) {
        scene.constraints.push(dm);
      }

      if (d.id > maxPrimId) maxPrimId = d.id;
    }

    // 7. Rebuild constraints
    let maxCId = 0;
    for (const d of (data.constraints || [])) {
      const c = Scene._deserializeConstraint(d, ptMap, shapeMap);
      if (c) {
        c.id = d.id;
        if (d.min != null) c.min = d.min;
        if (d.max != null) c.max = d.max;
        scene.constraints.push(c);
        if (d.id > maxCId) maxCId = d.id;
      }
    }

    // 8. Restore named variables
    deserializeVariables(data.variables);

    // 9. Reset counters so new primitives get unique IDs
    resetPrimitiveIds(maxPrimId + 1);
    resetConstraintIds(maxCId + 1);

    return scene;
  }

  /** Helper: reconstruct one constraint from serialized data. */
  static _deserializeConstraint(d, ptMap, shapeMap) {
    switch (d.type) {
      case 'coincident':   return new Coincident(ptMap.get(d.ptA), ptMap.get(d.ptB));
      case 'distance':     return new Distance(ptMap.get(d.ptA), ptMap.get(d.ptB), d.value);
      case 'fixed':        { const c = new Fixed(ptMap.get(d.pt), d.fx, d.fy); return c; }
      case 'horizontal':   return new Horizontal(shapeMap.get(d.seg));
      case 'vertical':     return new Vertical(shapeMap.get(d.seg));
      case 'parallel':     return new Parallel(shapeMap.get(d.segA), shapeMap.get(d.segB));
      case 'perpendicular':return new Perpendicular(shapeMap.get(d.segA), shapeMap.get(d.segB));
      case 'angle':        return new Angle(shapeMap.get(d.segA), shapeMap.get(d.segB), d.value);
      case 'equal_length': return new EqualLength(shapeMap.get(d.segA), shapeMap.get(d.segB));
      case 'length':       return new Length(shapeMap.get(d.seg), d.value);
      case 'radius':       return new RadiusConstraint(shapeMap.get(d.shape), d.value);
      case 'tangent':      return new Tangent(shapeMap.get(d.seg), shapeMap.get(d.circle));
      case 'on_line':      return new OnLine(ptMap.get(d.pt), shapeMap.get(d.seg));
      case 'on_circle':    return new OnCircle(ptMap.get(d.pt), shapeMap.get(d.circle));
      case 'midpoint':     return new Midpoint(ptMap.get(d.pt), shapeMap.get(d.seg));
      default:             return null;
    }
  }
}

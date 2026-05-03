// js/cad/Scene.js — Central manager for all primitives and constraints
import { PPoint } from './Point.js';
import { PSegment } from './Segment.js';
import { PArc } from './ArcPrimitive.js';
import { PCircle } from './CirclePrimitive.js';
import { PSpline } from './SplinePrimitive.js';
import { PBezier } from './BezierPrimitive.js';
import { TextPrimitive } from './TextPrimitive.js';
import { DimensionPrimitive } from './DimensionPrimitive.js';
import { ImagePrimitive } from './ImagePrimitive.js';
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
  Mirror, LinearPattern, RadialPattern,
} from './Constraint.js';

const MERGE_TOLERANCE = 1e-4; // world units — points closer than this auto-merge

export class Scene {
  constructor() {
    this.points = [];       // PPoint[]
    this.segments = [];     // PSegment[]
    this.arcs = [];         // PArc[]
    this.circles = [];      // PCircle[]
    this.splines = [];      // PSpline[]
    this.beziers = [];      // PBezier[]
    this.constraints = [];  // Constraint[]
    this.texts = [];        // TextPrimitive[] (pass-through, non-constraint)
    this.dimensions = [];   // DimensionPrimitive[] (pass-through)
    this.images = [];       // ImagePrimitive[] (sketch-local reference images)

    // Reference entities — always present, not serialized, constrainable
    this._initReferenceEntities();
  }

  /** Create the origin point and axis lines as reference entities. */
  _initReferenceEntities() {
    const origin = new PPoint(0, 0, true);
    origin.id = -1;
    origin._isReference = true;
    origin.visible = true;

    const xEnd = new PPoint(1, 0, true);
    xEnd.id = -2;
    xEnd._isReference = true;
    xEnd.visible = false;

    const yEnd = new PPoint(0, 1, true);
    yEnd.id = -3;
    yEnd._isReference = true;
    yEnd.visible = false;

    const xAxis = new PSegment(origin, xEnd);
    xAxis.id = -4;
    xAxis._isReference = true;
    xAxis.construction = true;
    xAxis.constructionType = 'infinite-both';
    xAxis.visible = true;

    const yAxis = new PSegment(origin, yEnd);
    yAxis.id = -5;
    yAxis._isReference = true;
    yAxis.construction = true;
    yAxis.constructionType = 'infinite-both';
    yAxis.visible = true;

    this._originPoint = origin;
    this._xAxisLine = xAxis;
    this._yAxisLine = yAxis;
  }

  /** Get the reference entities map for serialization lookups. */
  _refPtMap() {
    return new Map([
      [-1, this._originPoint],
      [-2, this._xAxisLine.p1 === this._originPoint ? this._xAxisLine.p2 : this._xAxisLine.p1],
      [-3, this._yAxisLine.p1 === this._originPoint ? this._yAxisLine.p2 : this._yAxisLine.p1],
    ]);
  }
  _refShapeMap() {
    return new Map([[-4, this._xAxisLine], [-5, this._yAxisLine]]);
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
  addSegment(x1, y1, x2, y2, { merge = true, layer = '0', color = null, construction = false } = {}) {
    const p1 = merge ? this.getOrCreatePoint(x1, y1) : this.addPoint(x1, y1);
    const p2 = merge ? this.getOrCreatePoint(x2, y2) : this.addPoint(x2, y2);
    const seg = new PSegment(p1, p2);
    seg.layer = layer;
    seg.color = color;
    seg.construction = construction;
    this.segments.push(seg);
    return seg;
  }

  addCircle(cx, cy, radius, { merge = true, layer = '0', color = null, construction = false } = {}) {
    const center = merge ? this.getOrCreatePoint(cx, cy) : this.addPoint(cx, cy);
    const c = new PCircle(center, radius);
    c.layer = layer;
    c.color = color;
    c.construction = construction;
    this.circles.push(c);
    return c;
  }

  addArc(cx, cy, radius, startAngle, endAngle, { merge = true, layer = '0', color = null, construction = false } = {}) {
    const center = merge ? this.getOrCreatePoint(cx, cy) : this.addPoint(cx, cy);
    const a = new PArc(center, radius, startAngle, endAngle);
    a.layer = layer;
    a.color = color;
    a.construction = construction;
    this.arcs.push(a);
    return a;
  }

  /**
   * Add a spline through the given control-point coordinates.
   * @param {Array<{x: number, y: number}>} controlCoords - 2D coordinates for control points
   * @param {Object} [opts] - Options (merge, layer, color, construction)
   * @returns {PSpline}
   */
  addSpline(controlCoords, { merge = true, layer = '0', color = null, construction = false } = {}) {
    const pts = controlCoords.map(c =>
      merge ? this.getOrCreatePoint(c.x, c.y) : this.addPoint(c.x, c.y)
    );
    const spl = new PSpline(pts);
    spl.layer = layer;
    spl.color = color;
    spl.construction = construction;
    this.splines.push(spl);
    return spl;
  }

  /**
   * Add a bezier curve from vertex descriptors.
   * @param {Array<{x:number, y:number, handleIn?:{dx:number,dy:number}, handleOut?:{dx:number,dy:number}, tangent?:boolean}>} vertexDescs
   * @param {Object} [options]
   */
  addBezier(vertexDescs, { merge = true, layer = '0', color = null, construction = false } = {}) {
    const vertices = vertexDescs.map(v => ({
      point: merge ? this.getOrCreatePoint(v.x, v.y) : this.addPoint(v.x, v.y),
      handleIn: v.handleIn || null,
      handleOut: v.handleOut || null,
      tangent: v.tangent !== false,
    }));
    const bez = new PBezier(vertices);
    bez.layer = layer;
    bez.color = color;
    bez.construction = construction;
    this.beziers.push(bez);
    return bez;
  }

  addImage(dataUrl, x, y, width, height, options = {}) {
    const image = new ImagePrimitive(dataUrl, x, y, width, height, options);
    image.layer = options.layer || '0';
    image.color = options.color || null;
    this.images.push(image);
    return image;
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
    this.splines = this.splines.filter(spl => !spl.points.includes(pt));
    this.beziers = this.beziers.filter(bez => !bez.points.includes(pt));
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

  removeSpline(spl) {
    this.splines = this.splines.filter(s => s !== spl);
    this.constraints = this.constraints.filter(c => {
      if (c.sourceA === spl || c.sourceB === spl) return false;
      return true;
    });
    this._cleanOrphanPoints();
  }

  removeBezier(bez) {
    this.beziers = this.beziers.filter(b => b !== bez);
    this.constraints = this.constraints.filter(c => {
      if (c.sourceA === bez || c.sourceB === bez) return false;
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
      case 'spline':    this.removeSpline(prim); break;
      case 'bezier':    this.removeBezier(prim); break;
      case 'text':
        this.texts = this.texts.filter(t => t !== prim);
        break;
      case 'dimension':
        this.dimensions = this.dimensions.filter(d => d !== prim);
        // Also remove from constraints if it was acting as one
        this.constraints = this.constraints.filter(c => c !== prim);
        break;
      case 'image':
        this.images = this.images.filter(i => i !== prim);
        break;
    }
  }

  /** Remove points not used by any shape. */
  _cleanOrphanPoints() {
    const used = new Set();
    for (const s of this.segments) { used.add(s.p1); used.add(s.p2); }
    for (const c of this.circles) { used.add(c.center); }
    for (const a of this.arcs) { used.add(a.center); }
    for (const spl of this.splines) { for (const p of spl.points) used.add(p); }
    for (const bez of this.beziers) { for (const p of bez.points) used.add(p); }
    this.points = this.points.filter(p => used.has(p));
    this.constraints = this.constraints.filter(c =>
      c.involvedPoints().every(pt => this.points.includes(pt) || (pt && pt._isReference))
    );
    // Also mark orphaned dimension constraints as non-constraining
    for (const dim of this.dimensions) {
      if (dim.isConstraint && dim.sourceA) {
        const pts = dim.involvedPoints();
        if (pts.length > 0 && !pts.every(pt => this.points.includes(pt) || (pt && pt._isReference))) {
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
    yield* this.splines;
    yield* this.beziers;
    yield* this.images;
    yield* this.texts;
    yield* this.dimensions;
  }

  /** Fast count of drawable shapes (avoids array allocation). */
  entityCount() {
    return this.segments.length + this.circles.length + this.arcs.length +
      this.splines.length + this.beziers.length + this.images.length + this.texts.length + this.dimensions.length;
  }

  /** All primitives including bare points. */
  *allPrimitives() {
    yield* this.points;
    yield* this.segments;
    yield* this.circles;
    yield* this.arcs;
    yield* this.splines;
    yield* this.beziers;
    yield* this.images;
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
    // Also check reference axis lines
    for (const ref of [this._xAxisLine, this._yAxisLine]) {
      if (!ref) continue;
      const d = ref.distanceTo(wx, wy);
      if (d < worldTolerance && d < bestDist) { bestDist = d; best = ref; }
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
    // Also check origin reference point
    if (this._originPoint) {
      const d = this._originPoint.distanceTo(wx, wy);
      if (d < worldTolerance && d < bestDist) { bestDist = d; best = this._originPoint; }
    }
    return best;
  }

  /** Get all shapes that reference a given point. */
  shapesUsingPoint(pt) {
    const out = [];
    for (const s of this.segments) if (s.p1 === pt || s.p2 === pt) out.push(s);
    for (const c of this.circles) if (c.center === pt) out.push(c);
    for (const a of this.arcs) if (a.center === pt) out.push(a);
    for (const spl of this.splines) if (spl.points.includes(pt)) out.push(spl);
    for (const bez of this.beziers) if (bez.points.includes(pt)) out.push(bez);
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
        if (prim.type === 'spline' || prim.type === 'bezier') return prim.points.some(p => pts.includes(p));
        return false;
      }
      const pts = c.involvedPoints();
      if (prim.type === 'point') return pts.includes(prim);
      if (prim.type === 'segment') return c.seg === prim || c.segA === prim || c.segB === prim ||
        pts.includes(prim.p1) || pts.includes(prim.p2);
      if (prim.type === 'circle' || prim.type === 'arc') return c.circle === prim || c.shape === prim ||
        pts.includes(prim.center);
      if (prim.type === 'spline' || prim.type === 'bezier') return prim.points.some(p => pts.includes(p));
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
    this.splines = [];
    this.beziers = [];
    this.constraints = [];
    this.texts = [];
    this.dimensions = [];
    this.images = [];
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
      splines: this.splines.map(s => s.serialize()),
      beziers: this.beziers.map(b => b.serialize()),
      // Exclude dimension-type constraints — they are serialized via dimensions[]
      constraints: this.constraints.filter(c => c.type !== 'dimension').map(c => c.serialize()),
      images: this.images.map(i => i.serialize()),
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

    // Add reference entities to maps so constraints can resolve them
    for (const [id, pt] of scene._refPtMap()) ptMap.set(id, pt);

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
    for (const [id, shape] of scene._refShapeMap()) shapeMap.set(id, shape);
    for (const d of (data.segments || [])) {
      const p1 = ptMap.get(d.p1);
      const p2 = ptMap.get(d.p2);
      if (!p1 || !p2) continue;
      const seg = new PSegment(p1, p2);
      seg.id = d.id;
      seg.layer = d.layer || '0';
      seg.color = d.color || null;
      if (d.construction) seg.construction = true;
      if (d.constructionType) seg.constructionType = d.constructionType;
      if (d.constructionDash) seg.constructionDash = d.constructionDash;
      if (d.lineWidth != null) seg.lineWidth = d.lineWidth;
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
      if (d.constructionType) c.constructionType = d.constructionType;
      if (d.constructionDash) c.constructionDash = d.constructionDash;
      if (d.lineWidth != null) c.lineWidth = d.lineWidth;
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
      if (d.constructionType) a.constructionType = d.constructionType;
      if (d.constructionDash) a.constructionDash = d.constructionDash;
      if (d.lineWidth != null) a.lineWidth = d.lineWidth;
      scene.arcs.push(a);
      shapeMap.set(d.id, a);
      if (d.id > maxPrimId) maxPrimId = d.id;
    }

    // 5. Rebuild splines
    for (const d of (data.splines || [])) {
      const cps = (d.controlPoints || []).map(id => ptMap.get(id));
      if (cps.some(p => !p) || cps.length < 2) continue;
      const spl = new PSpline(cps);
      spl.id = d.id;
      spl.layer = d.layer || '0';
      spl.color = d.color || null;
      if (d.construction) spl.construction = true;
      if (d.constructionType) spl.constructionType = d.constructionType;
      if (d.constructionDash) spl.constructionDash = d.constructionDash;
      if (d.lineWidth != null) spl.lineWidth = d.lineWidth;
      scene.splines.push(spl);
      shapeMap.set(d.id, spl);
      if (d.id > maxPrimId) maxPrimId = d.id;
    }

    // 6. Rebuild beziers
    for (const d of (data.beziers || [])) {
      const verts = (d.vertices || []).map(v => {
        const pt = ptMap.get(v.point);
        if (!pt) return null;
        return { point: pt, handleIn: v.handleIn || null, handleOut: v.handleOut || null, tangent: v.tangent !== false };
      });
      if (verts.some(v => !v) || verts.length < 2) continue;
      const bez = new PBezier(verts);
      bez.id = d.id;
      bez.layer = d.layer || '0';
      bez.color = d.color || null;
      if (d.construction) bez.construction = true;
      if (d.constructionType) bez.constructionType = d.constructionType;
      if (d.constructionDash) bez.constructionDash = d.constructionDash;
      if (d.lineWidth != null) bez.lineWidth = d.lineWidth;
      scene.beziers.push(bez);
      shapeMap.set(d.id, bez);
      if (d.id > maxPrimId) maxPrimId = d.id;
    }

    // 7. Rebuild images
    for (const d of (data.images || [])) {
      const image = new ImagePrimitive(d.dataUrl, d.x, d.y, d.width, d.height, {
        name: d.name,
        mimeType: d.mimeType,
        naturalWidth: d.naturalWidth,
        naturalHeight: d.naturalHeight,
        rotation: d.rotation,
        scaleX: d.scaleX,
        scaleY: d.scaleY,
        opacity: d.opacity,
        brightness: d.brightness,
        contrast: d.contrast,
        gamma: d.gamma,
        quantization: d.quantization,
        pinnedBackground: d.pinnedBackground,
        perspectiveEnabled: d.perspectiveEnabled,
        gridWidth: d.gridWidth,
        gridHeight: d.gridHeight,
        gridCellsX: d.gridCellsX,
        gridCellsY: d.gridCellsY,
        quad: d.quad,
        cropRect: d.cropRect,
        traceSettings: d.traceSettings,
        perspectiveEditQuad: d.perspectiveEditQuad,
        perspectiveOutputQuad: d.perspectiveOutputQuad,
        sourceQuad: d.sourceQuad,
      });
      image.id = d.id;
      image.layer = d.layer || '0';
      image.color = d.color || null;
      if (d.lineWidth != null) image.lineWidth = d.lineWidth;
      scene.images.push(image);
      shapeMap.set(d.id, image);
      if (d.id > maxPrimId) maxPrimId = d.id;
    }

    // 8. Rebuild texts
    for (const d of (data.texts || [])) {
      const t = new TextPrimitive(d.x, d.y, d.text, d.height);
      t.id = d.id;
      t.layer = d.layer || '0';
      t.color = d.color || null;
      t.rotation = d.rotation || 0;
      scene.texts.push(t);
      if (d.id > maxPrimId) maxPrimId = d.id;
    }

    // 9. Rebuild dimensions
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
      if (d.arrowStyle) dm.arrowStyle = d.arrowStyle;

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

    // 10. Rebuild constraints
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

    // 11. Restore named variables
    deserializeVariables(data.variables);

    // 12. Reset counters so new primitives get unique IDs
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
      case 'mirror':       return new Mirror(ptMap.get(d.ptA), ptMap.get(d.ptB), shapeMap.get(d.seg));
      case 'linear_pattern': {
        const pairs = (d.pairs || []).map(p => ({ src: ptMap.get(p.src), dst: ptMap.get(p.dst) }));
        if (pairs.some(p => !p.src || !p.dst)) return null;
        return new LinearPattern(pairs, shapeMap.get(d.seg), d.count, d.spacing);
      }
      case 'radial_pattern': {
        const pairs = (d.pairs || []).map(p => ({ src: ptMap.get(p.src), dst: ptMap.get(p.dst) }));
        if (pairs.some(p => !p.src || !p.dst)) return null;
        return new RadialPattern(pairs, ptMap.get(d.center), d.count, d.angle);
      }
      default:             return null;
    }
  }
}

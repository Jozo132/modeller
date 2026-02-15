// js/cad/DimensionPrimitive.js — Smart constraint dimension annotation
//
// Supports multiple dimension types detected from source primitives:
//   'distance'  – linear distance between two points / point-line / parallel lines
//   'dx'        – horizontal distance between two points
//   'dy'        – vertical distance between two points
//   'angle'     – angle between two non-parallel segments
//   'radius'    – radius of a circle or arc
//   'diameter'  – diameter of a circle or arc
//
// Each dimension can be a passive follower or an active constraint.
// Dimensions can write their value into a named variable.
// Display mode controls the label: 'value', 'formula', or 'both'.
// Visibility can be toggled for cleaner drawings.

import { Primitive } from './Primitive.js';
import { resolveValue } from './Constraint.js';

/** Valid dimension types */
export const DIM_TYPES = ['distance', 'dx', 'dy', 'angle', 'radius', 'diameter'];

/** Display modes for the dimension label */
export const DISPLAY_MODES = ['value', 'formula', 'both'];

export class DimensionPrimitive extends Primitive {
  /**
   * @param {number} x1  Start point X (world)
   * @param {number} y1  Start point Y (world)
   * @param {number} x2  End point X (world)
   * @param {number} y2  End point Y (world)
   * @param {number} offset  Perpendicular offset of dimension line from geometry
   * @param {object} [opts]  Optional smart-dimension configuration
   * @param {string} [opts.dimType='distance']  Dimension type
   * @param {boolean} [opts.isConstraint=false]  Whether this acts as a constraint
   * @param {string|null} [opts.variableName=null]  Variable name to write value into
   * @param {string} [opts.displayMode='value']  Display mode
   * @param {string|number|null} [opts.formula=null]  Formula / variable ref for constraint value
   * @param {number|null} [opts.sourceAId=null]  ID of first source primitive
   * @param {number|null} [opts.sourceBId=null]  ID of second source primitive
   * @param {object|null} [opts.sourceA=null]   Direct reference to first source primitive
   * @param {object|null} [opts.sourceB=null]   Direct reference to second source primitive
   */
  constructor(x1, y1, x2, y2, offset = 10, opts = {}) {
    super('dimension');
    this.x1 = x1; this.y1 = y1;
    this.x2 = x2; this.y2 = y2;
    this.offset = offset;

    // Smart dimension properties
    this.dimType = opts.dimType || 'distance';
    this.isConstraint = opts.isConstraint || false;
    this.variableName = opts.variableName || null;
    this.displayMode = opts.displayMode || 'value';
    this.formula = opts.formula ?? null;     // number or variable name string
    this.sourceAId = opts.sourceAId ?? null; // id of first source primitive
    this.sourceBId = opts.sourceBId ?? null; // id of second source primitive

    // Direct object references to source primitives (for constraint solving)
    this.sourceA = opts.sourceA ?? null;
    this.sourceB = opts.sourceB ?? null;

    // Constraint range limits (like Constraint base class)
    this.min = opts.min ?? null;
    this.max = opts.max ?? null;
  }

  // -----------------------------------------------------------------------
  // Constraint interface — duck-typed so the Solver can call error() / apply()
  // -----------------------------------------------------------------------

  /** Whether this dimension's value can be edited in the constraint panel */
  get editable() { return this.isConstraint; }

  /** Resolve the constraint target value (formula → number, clamped to range) */
  _resolvedValue() {
    if (this.formula == null) return this.value;
    let v = resolveValue(this.formula);
    if (this.min != null && v < this.min) v = this.min;
    if (this.max != null && v > this.max) v = this.max;
    return v;
  }

  /** Constraint error — how far the current geometry deviates from the target */
  error() {
    if (!this.isConstraint || this.formula == null) return 0;
    const target = this._resolvedValue();
    if (isNaN(target)) return 0;

    const srcA = this.sourceA;
    const srcB = this.sourceB;
    if (!srcA) return 0;

    switch (this.dimType) {
      case 'distance': {
        if (srcA.type === 'point' && srcB && srcB.type === 'point') {
          return Math.abs(Math.hypot(srcB.x - srcA.x, srcB.y - srcA.y) - target);
        }
        if (srcA.type === 'segment' && !srcB) {
          return Math.abs(srcA.length - target);
        }
        return 0;
      }
      case 'dx': {
        if (srcA.type === 'point' && srcB && srcB.type === 'point') {
          return Math.abs(Math.abs(srcB.x - srcA.x) - target);
        }
        return 0;
      }
      case 'dy': {
        if (srcA.type === 'point' && srcB && srcB.type === 'point') {
          return Math.abs(Math.abs(srcB.y - srcA.y) - target);
        }
        return 0;
      }
      case 'angle': {
        if (srcA.type === 'segment' && srcB && srcB.type === 'segment') {
          const dxA = srcA.x2 - srcA.x1, dyA = srcA.y2 - srcA.y1;
          const dxB = srcB.x2 - srcB.x1, dyB = srcB.y2 - srcB.y1;
          const a = Math.atan2(dyA, dxA);
          const b = Math.atan2(dyB, dxB);
          let diff = b - a;
          while (diff > Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          return Math.abs(diff - target);
        }
        return 0;
      }
      case 'radius': {
        if ((srcA.type === 'circle' || srcA.type === 'arc') && !srcB) {
          return Math.abs(srcA.radius - target);
        }
        return 0;
      }
      case 'diameter': {
        if ((srcA.type === 'circle' || srcA.type === 'arc') && !srcB) {
          return Math.abs(srcA.radius * 2 - target);
        }
        return 0;
      }
      default: return 0;
    }
  }

  /** Constraint apply — push geometry toward the target value */
  apply() {
    if (!this.isConstraint || this.formula == null) return;
    const target = this._resolvedValue();
    if (isNaN(target)) return;

    const srcA = this.sourceA;
    const srcB = this.sourceB;
    if (!srcA) return;

    switch (this.dimType) {
      case 'distance': {
        if (srcA.type === 'point' && srcB && srcB.type === 'point') {
          // Same logic as Distance constraint
          const a = srcA, b = srcB;
          if (a.fixed && b.fixed) return;
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 1e-9;
          const err = d - target;
          const ux = dx / d, uy = dy / d;
          if (a.fixed) { b.x -= ux * err; b.y -= uy * err; }
          else if (b.fixed) { a.x += ux * err; a.y += uy * err; }
          else { const h = err / 2; a.x += ux * h; a.y += uy * h; b.x -= ux * h; b.y -= uy * h; }
          return;
        }
        if (srcA.type === 'segment' && !srcB) {
          // Same logic as Length constraint
          _scaleSegToLength(srcA, target);
          return;
        }
        return;
      }
      case 'dx': {
        if (srcA.type === 'point' && srcB && srcB.type === 'point') {
          const a = srcA, b = srcB;
          if (a.fixed && b.fixed) return;
          const currentDx = b.x - a.x;
          const sign = currentDx >= 0 ? 1 : -1;
          const targetDx = sign * target;
          const err = currentDx - targetDx;
          if (a.fixed) { b.x -= err; }
          else if (b.fixed) { a.x += err; }
          else { const h = err / 2; a.x += h; b.x -= h; }
          return;
        }
        return;
      }
      case 'dy': {
        if (srcA.type === 'point' && srcB && srcB.type === 'point') {
          const a = srcA, b = srcB;
          if (a.fixed && b.fixed) return;
          const currentDy = b.y - a.y;
          const sign = currentDy >= 0 ? 1 : -1;
          const targetDy = sign * target;
          const err = currentDy - targetDy;
          if (a.fixed) { b.y -= err; }
          else if (b.fixed) { a.y += err; }
          else { const h = err / 2; a.y += h; b.y -= h; }
          return;
        }
        return;
      }
      case 'angle': {
        if (srcA.type === 'segment' && srcB && srcB.type === 'segment') {
          // Same logic as Angle constraint
          const dxA = srcA.x2 - srcA.x1, dyA = srcA.y2 - srcA.y1;
          const angleA = Math.atan2(dyA, dxA);
          const targetAngle = angleA + target;
          const dxB = srcB.x2 - srcB.x1, dyB = srcB.y2 - srcB.y1;
          const lenB = Math.hypot(dxB, dyB) || 1e-9;
          const ux = Math.cos(targetAngle), uy = Math.sin(targetAngle);
          const mx = srcB.midX, my = srcB.midY;
          const halfLen = lenB / 2;
          if (!srcB.p1.fixed) { srcB.p1.x = mx - ux * halfLen; srcB.p1.y = my - uy * halfLen; }
          if (!srcB.p2.fixed) { srcB.p2.x = mx + ux * halfLen; srcB.p2.y = my + uy * halfLen; }
          return;
        }
        return;
      }
      case 'radius': {
        if ((srcA.type === 'circle' || srcA.type === 'arc') && !srcB) {
          srcA.radius = target;
          return;
        }
        return;
      }
      case 'diameter': {
        if ((srcA.type === 'circle' || srcA.type === 'arc') && !srcB) {
          srcA.radius = target / 2;
          return;
        }
        return;
      }
    }
  }

  /** Return points involved in this dimension constraint (for the solver/panel) */
  involvedPoints() {
    const pts = [];
    const srcA = this.sourceA;
    const srcB = this.sourceB;
    if (srcA) {
      if (srcA.type === 'point') pts.push(srcA);
      else if (srcA.type === 'segment') { pts.push(srcA.p1); pts.push(srcA.p2); }
      else if (srcA.type === 'circle' || srcA.type === 'arc') pts.push(srcA.center);
    }
    if (srcB) {
      if (srcB.type === 'point') pts.push(srcB);
      else if (srcB.type === 'segment') { pts.push(srcB.p1); pts.push(srcB.p2); }
      else if (srcB.type === 'circle' || srcB.type === 'arc') pts.push(srcB.center);
    }
    return pts;
  }

  /** Update drawing coordinates from live source geometry (call after solver) */
  syncFromSources() {
    const srcA = this.sourceA;
    const srcB = this.sourceB;
    if (!srcA) return;

    if (this.dimType === 'angle') {
      // Recalculate angle info
      if (srcA.type === 'segment' && srcB && srcB.type === 'segment') {
        const info = _segAngleInfoLive(srcA, srcB);
        this.x1 = info.vx; this.y1 = info.vy;
        this.x2 = info.vx; this.y2 = info.vy;
        this._angleStart = info.startAngle;
        this._angleSweep = info.sweep;
      }
      return;
    }

    if (this.dimType === 'radius' || this.dimType === 'diameter') {
      if (srcA.type === 'circle' || srcA.type === 'arc') {
        this.x1 = srcA.cx; this.y1 = srcA.cy;
        this.x2 = srcA.cx + srcA.radius; this.y2 = srcA.cy;
      }
      return;
    }

    // distance / dx / dy
    if (srcA.type === 'point' && srcB && srcB.type === 'point') {
      this.x1 = srcA.x; this.y1 = srcA.y;
      this.x2 = srcB.x; this.y2 = srcB.y;
    } else if (srcA.type === 'segment' && !srcB) {
      this.x1 = srcA.x1; this.y1 = srcA.y1;
      this.x2 = srcA.x2; this.y2 = srcA.y2;
    }
  }

  /** Computed measured value */
  get value() {
    switch (this.dimType) {
      case 'dx': return Math.abs(this.x2 - this.x1);
      case 'dy': return Math.abs(this.y2 - this.y1);
      case 'angle': return this._computeAngle();
      case 'radius': return Math.hypot(this.x2 - this.x1, this.y2 - this.y1);
      case 'diameter': return Math.hypot(this.x2 - this.x1, this.y2 - this.y1) * 2;
      case 'distance':
      default: return Math.hypot(this.x2 - this.x1, this.y2 - this.y1);
    }
  }

  /** Alias for backward compat */
  get length() { return this.value; }

  /** Resolve the formula to a numeric value (for constraint mode) */
  get resolvedFormula() {
    if (this.formula == null) return null;
    return resolveValue(this.formula);
  }

  /** Build the display label based on displayMode */
  get displayLabel() {
    const val = this.value;
    const unit = this.dimType === 'angle' ? '°' : '';
    const prefix = this.dimType === 'diameter' ? '⌀' : (this.dimType === 'radius' ? 'R' : '');
    const formatted = this.dimType === 'angle'
      ? (val * 180 / Math.PI).toFixed(1)
      : val.toFixed(2);

    if (this.displayMode === 'formula' && this.formula != null) {
      return `${prefix}${this.formula}`;
    }
    if (this.displayMode === 'both' && this.formula != null) {
      return `${prefix}${this.formula} = ${formatted}${unit}`;
    }
    return `${prefix}${formatted}${unit}`;
  }

  _computeAngle() {
    // For angle dims the sweep is stored in _angleSweep (set during detection/sync).
    // Return the absolute sweep so displayLabel shows the correct degrees.
    if (this._angleSweep != null) return Math.abs(this._angleSweep);
    // Fallback: compute from endpoint vectors (legacy/single-use)
    const dx = this.x2 - this.x1, dy = this.y2 - this.y1;
    return Math.abs(Math.atan2(dy, dx));
  }

  getBounds() {
    if (this.dimType === 'angle') {
      const r = Math.abs(this.offset) + 5;
      return {
        minX: this.x1 - r, minY: this.y1 - r,
        maxX: this.x1 + r, maxY: this.y1 + r,
      };
    }
    const pad = Math.abs(this.offset) + 5;
    return {
      minX: Math.min(this.x1, this.x2) - pad,
      minY: Math.min(this.y1, this.y2) - pad,
      maxX: Math.max(this.x1, this.x2) + pad,
      maxY: Math.max(this.y1, this.y2) + pad,
    };
  }

  getSnapPoints() {
    return [
      { x: this.x1, y: this.y1, type: 'endpoint' },
      { x: this.x2, y: this.y2, type: 'endpoint' },
    ];
  }

  distanceTo(px, py) {
    if (this.dimType === 'angle') {
      // Distance from the arc drawn at radius = |offset| from the vertex
      const vcx = this.x1, vcy = this.y1;
      const r = Math.abs(this.offset);
      const startA = this._angleStart != null ? this._angleStart : 0;
      const sweepA = this._angleSweep != null ? this._angleSweep : 0;
      // Angle of the point relative to vertex
      const pAngle = Math.atan2(py - vcy, px - vcx);
      // Normalise sweep direction
      const s0 = startA;
      const s1 = startA + sweepA;
      const minA = Math.min(s0, s1);
      const maxA = Math.max(s0, s1);
      // Check if the point's angle falls within the arc span
      let a = pAngle;
      // Normalise to [-PI, PI] range relative to the arc
      while (a < minA - Math.PI) a += 2 * Math.PI;
      while (a > maxA + Math.PI) a -= 2 * Math.PI;
      const dist = Math.hypot(px - vcx, py - vcy);
      if (a >= minA && a <= maxA) {
        // Within angular span — distance is |dist - r|
        return Math.abs(dist - r);
      }
      // Outside angular span — distance to nearest endpoint of the arc
      const e1x = vcx + r * Math.cos(s0), e1y = vcy + r * Math.sin(s0);
      const e2x = vcx + r * Math.cos(s1), e2y = vcy + r * Math.sin(s1);
      return Math.min(Math.hypot(px - e1x, py - e1y), Math.hypot(px - e2x, py - e2y));
    }
    const dx = this.x2 - this.x1, dy = this.y2 - this.y1;
    const len = Math.hypot(dx, dy) || 1e-9;
    const nx = -dy / len, ny = dx / len;
    const ox = nx * this.offset, oy = ny * this.offset;
    return _segDist(px, py, this.x1 + ox, this.y1 + oy, this.x2 + ox, this.y2 + oy);
  }

  draw(ctx, vp) {
    if (!this.visible) return;
    if (this.dimType === 'angle') {
      this._drawAngle(ctx, vp);
    } else {
      this._drawLinear(ctx, vp);
    }
  }

  _drawLinear(ctx, vp) {
    const dx = this.x2 - this.x1, dy = this.y2 - this.y1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    const nx = -dy / len, ny = dx / len;
    const ox = nx * this.offset, oy = ny * this.offset;

    const p1 = vp.worldToScreen(this.x1, this.y1);
    const p2 = vp.worldToScreen(this.x2, this.y2);
    const d1 = vp.worldToScreen(this.x1 + ox, this.y1 + oy);
    const d2 = vp.worldToScreen(this.x2 + ox, this.y2 + oy);

    ctx.save();
    // Constraint dimensions shown in a different color
    if (this.isConstraint) {
      ctx.strokeStyle = 'rgba(255,180,50,0.8)';
      ctx.fillStyle = 'rgba(255,180,50,0.9)';
    }

    // Extension lines (dashed)
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y); ctx.lineTo(d1.x, d1.y);
    ctx.moveTo(p2.x, p2.y); ctx.lineTo(d2.x, d2.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Measure label to compute gap
    const fontSize = Math.max(10, 12);
    ctx.font = `${fontSize}px 'Consolas', monospace`;
    const label = this.displayLabel;
    const tm = ctx.measureText(label);
    const gapHalf = (tm.width / 2) + 4; // half-gap in pixels

    // Dimension line with gap for text
    const lineLen = Math.hypot(d2.x - d1.x, d2.y - d1.y);
    const angle = Math.atan2(d2.y - d1.y, d2.x - d1.x);
    const mx = (d1.x + d2.x) / 2, my = (d1.y + d2.y) / 2;
    const ux = Math.cos(angle), uy = Math.sin(angle);
    const gapStart_x = mx - ux * gapHalf, gapStart_y = my - uy * gapHalf;
    const gapEnd_x = mx + ux * gapHalf, gapEnd_y = my + uy * gapHalf;

    ctx.beginPath();
    if (lineLen > gapHalf * 2) {
      // Line is long enough for a gap
      ctx.moveTo(d1.x, d1.y); ctx.lineTo(gapStart_x, gapStart_y);
      ctx.moveTo(gapEnd_x, gapEnd_y); ctx.lineTo(d2.x, d2.y);
    } else {
      // Too short — draw full line, text will overlap a bit
      ctx.moveTo(d1.x, d1.y); ctx.lineTo(d2.x, d2.y);
    }
    ctx.stroke();

    const arrowLen = 8;
    _drawArrow(ctx, d1.x, d1.y, angle, arrowLen);
    _drawArrow(ctx, d2.x, d2.y, angle + Math.PI, arrowLen);

    // Draw label
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.save();
    ctx.translate(mx, my);
    let ta = angle;
    if (ta > Math.PI / 2 || ta < -Math.PI / 2) ta += Math.PI;
    ctx.rotate(ta);
    ctx.fillText(label, 0, -4);
    ctx.restore();
    ctx.restore();
  }

  _drawAngle(ctx, vp) {
    const vcx = this.x1, vcy = this.y1;
    const vs = vp.worldToScreen(vcx, vcy);
    const r = Math.abs(this.offset) * vp.zoom;
    // x2,y2 encode angle: startAngle in lower bits, sweep via _angleStart/_angleSweep
    const startA = this._angleStart != null ? this._angleStart : 0;
    const sweepA = this._angleSweep != null ? this._angleSweep : this._computeAngle();

    ctx.save();
    if (this.isConstraint) {
      ctx.strokeStyle = 'rgba(255,180,50,0.8)';
      ctx.fillStyle = 'rgba(255,180,50,0.9)';
    }

    // Draw the arc — split around label midpoint for a gap
    const midA = -(startA + sweepA / 2);
    const fontSize = Math.max(10, 12);
    ctx.font = `${fontSize}px 'Consolas', monospace`;
    const label = this.displayLabel;
    const tm = ctx.measureText(label);
    const gapHalf = (tm.width / 2 + 4) / r; // angular half-gap in radians (arc length / radius)

    const arcStart = -startA;
    const arcEnd = -(startA + sweepA);
    const gapCenter = midA; // angle of label midpoint

    // Draw arc in two parts, skipping the gap
    if (Math.abs(sweepA) > gapHalf * 2) {
      ctx.beginPath();
      ctx.arc(vs.x, vs.y, r, arcStart, gapCenter + gapHalf, true);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(vs.x, vs.y, r, gapCenter - gapHalf, arcEnd, true);
      ctx.stroke();
    } else {
      // Arc too small for a gap — draw full
      ctx.beginPath();
      ctx.arc(vs.x, vs.y, r, arcStart, arcEnd, true);
      ctx.stroke();
    }

    // Arrow at end
    const endAngle = startA + sweepA;
    const arrowLen = 8;
    const ea = -endAngle;
    const tangent = ea - Math.PI / 2; // tangent at arc end
    const ex = vs.x + r * Math.cos(ea);
    const ey = vs.y + r * Math.sin(ea);
    _drawArrow(ctx, ex, ey, tangent, arrowLen);

    // Label at midpoint of arc (outside)
    const labelR = r + 12;
    const lx = vs.x + labelR * Math.cos(midA);
    const ly = vs.y + labelR * Math.sin(midA);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx, ly);

    ctx.restore();
  }

  translate(dx, dy) {
    this.x1 += dx; this.y1 += dy;
    this.x2 += dx; this.y2 += dy;
  }

  serialize() {
    const out = {
      ...super.serialize(),
      x1: this.x1, y1: this.y1, x2: this.x2, y2: this.y2,
      offset: this.offset,
      dimType: this.dimType,
      isConstraint: this.isConstraint,
      displayMode: this.displayMode,
    };
    if (this.variableName) out.variableName = this.variableName;
    if (this.formula != null) out.formula = this.formula;
    if (this.sourceAId != null) out.sourceAId = this.sourceAId;
    if (this.sourceBId != null) out.sourceBId = this.sourceBId;
    if (this._angleStart != null) out._angleStart = this._angleStart;
    if (this._angleSweep != null) out._angleSweep = this._angleSweep;
    if (this.min != null) out.min = this.min;
    if (this.max != null) out.max = this.max;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Smart detection: determine what dimension type is appropriate
// ---------------------------------------------------------------------------

/**
 * Detect the appropriate dimension type between two primitives.
 * @param {Primitive} a  First primitive (point, segment, circle, arc)
 * @param {Primitive} [b]  Second primitive (optional, for single-entity dims)
 * @returns {{ dimType: string, x1: number, y1: number, x2: number, y2: number, angleStart?: number, angleSweep?: number }}
 */
export function detectDimensionType(a, b) {
  if (!b) {
    // Single entity
    if (a.type === 'segment') {
      return { dimType: 'distance', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 };
    }
    if (a.type === 'circle' || a.type === 'arc') {
      return { dimType: 'radius', x1: a.cx, y1: a.cy, x2: a.cx + a.radius, y2: a.cy };
    }
    return null;
  }

  // Two points → distance (dx, dy available via dimType override)
  if (a.type === 'point' && b.type === 'point') {
    return { dimType: 'distance', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }

  // Two segments
  if (a.type === 'segment' && b.type === 'segment') {
    if (_areParallel(a, b)) {
      // Parallel lines → perpendicular distance
      const foot = _footOnLine(a.midX, a.midY, b.x1, b.y1, b.x2, b.y2);
      return { dimType: 'distance', x1: a.midX, y1: a.midY, x2: foot.x, y2: foot.y };
    } else {
      // Non-parallel → angle between them
      const info = _segAngleInfo(a, b);
      return {
        dimType: 'angle',
        x1: info.vx, y1: info.vy,
        x2: info.vx, y2: info.vy,
        angleStart: info.startAngle,
        angleSweep: info.sweep,
      };
    }
  }

  // Point and segment → distance from point to line
  if (a.type === 'point' && b.type === 'segment') {
    const foot = _footOnSegment(a.x, a.y, b.x1, b.y1, b.x2, b.y2);
    return { dimType: 'distance', x1: a.x, y1: a.y, x2: foot.x, y2: foot.y };
  }
  if (a.type === 'segment' && b.type === 'point') {
    const foot = _footOnSegment(b.x, b.y, a.x1, a.y1, a.x2, a.y2);
    return { dimType: 'distance', x1: b.x, y1: b.y, x2: foot.x, y2: foot.y };
  }

  // Point / segment and circle / arc → distance from center
  if ((a.type === 'circle' || a.type === 'arc') && b.type === 'point') {
    return { dimType: 'distance', x1: a.cx, y1: a.cy, x2: b.x, y2: b.y };
  }
  if (a.type === 'point' && (b.type === 'circle' || b.type === 'arc')) {
    return { dimType: 'distance', x1: a.x, y1: a.y, x2: b.cx, y2: b.cy };
  }

  // Two circles/arcs → distance between centers
  if ((a.type === 'circle' || a.type === 'arc') && (b.type === 'circle' || b.type === 'arc')) {
    return { dimType: 'distance', x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy };
  }

  // Segment and circle/arc → distance from segment midpoint to center
  if (a.type === 'segment' && (b.type === 'circle' || b.type === 'arc')) {
    return { dimType: 'distance', x1: a.midX, y1: a.midY, x2: b.cx, y2: b.cy };
  }
  if ((a.type === 'circle' || a.type === 'arc') && b.type === 'segment') {
    return { dimType: 'distance', x1: a.cx, y1: a.cy, x2: b.midX, y2: b.midY };
  }

  // Fallback: endpoint-to-endpoint
  return { dimType: 'distance', x1: a.x1 ?? a.x ?? a.cx ?? 0, y1: a.y1 ?? a.y ?? a.cy ?? 0,
           x2: b.x1 ?? b.x ?? b.cx ?? 0, y2: b.y1 ?? b.y ?? b.cy ?? 0 };
}

/**
 * Return ALL possible dimension types for a given pair of primitives.
 * The first entry is the default/recommended type; the rest are alternatives.
 * Each entry has { dimType, label, x1, y1, x2, y2, angleStart?, angleSweep? }.
 */
export function detectAllDimensionTypes(a, b) {
  const results = [];

  if (!b) {
    // --- Single entity ---
    if (a.type === 'segment') {
      results.push({ dimType: 'distance', label: 'Length', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 });
      // Horizontal/vertical components
      results.push({ dimType: 'dx', label: 'Horizontal (ΔX)', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 });
      results.push({ dimType: 'dy', label: 'Vertical (ΔY)', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 });
    }
    if (a.type === 'circle' || a.type === 'arc') {
      results.push({ dimType: 'diameter', label: 'Diameter', x1: a.cx, y1: a.cy, x2: a.cx + a.radius, y2: a.cy });
      results.push({ dimType: 'radius', label: 'Radius', x1: a.cx, y1: a.cy, x2: a.cx + a.radius, y2: a.cy });
    }
    return results;
  }

  // --- Two primitives ---

  // Two points
  if (a.type === 'point' && b.type === 'point') {
    results.push({ dimType: 'distance', label: 'Distance', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    results.push({ dimType: 'dx', label: 'Horizontal (ΔX)', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    results.push({ dimType: 'dy', label: 'Vertical (ΔY)', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    return results;
  }

  // Two segments — possibly both angle and distance
  if (a.type === 'segment' && b.type === 'segment') {
    if (_areParallel(a, b)) {
      // Parallel: distance is default
      const foot = _footOnLine(a.midX, a.midY, b.x1, b.y1, b.x2, b.y2);
      results.push({ dimType: 'distance', label: 'Distance', x1: a.midX, y1: a.midY, x2: foot.x, y2: foot.y });
    } else {
      // Non-parallel: angle is default, but also offer distance
      const info = _segAngleInfo(a, b);
      results.push({
        dimType: 'angle', label: 'Angle',
        x1: info.vx, y1: info.vy, x2: info.vx, y2: info.vy,
        angleStart: info.startAngle, angleSweep: info.sweep,
      });
      const foot = _footOnLine(a.midX, a.midY, b.x1, b.y1, b.x2, b.y2);
      results.push({ dimType: 'distance', label: 'Distance', x1: a.midX, y1: a.midY, x2: foot.x, y2: foot.y });
    }
    return results;
  }

  // Point + segment
  if (a.type === 'point' && b.type === 'segment') {
    const foot = _footOnSegment(a.x, a.y, b.x1, b.y1, b.x2, b.y2);
    results.push({ dimType: 'distance', label: 'Distance', x1: a.x, y1: a.y, x2: foot.x, y2: foot.y });
    return results;
  }
  if (a.type === 'segment' && b.type === 'point') {
    const foot = _footOnSegment(b.x, b.y, a.x1, a.y1, a.x2, a.y2);
    results.push({ dimType: 'distance', label: 'Distance', x1: b.x, y1: b.y, x2: foot.x, y2: foot.y });
    return results;
  }

  // Circle/arc + point
  if ((a.type === 'circle' || a.type === 'arc') && b.type === 'point') {
    results.push({ dimType: 'distance', label: 'Distance (center)', x1: a.cx, y1: a.cy, x2: b.x, y2: b.y });
    return results;
  }
  if (a.type === 'point' && (b.type === 'circle' || b.type === 'arc')) {
    results.push({ dimType: 'distance', label: 'Distance (center)', x1: a.x, y1: a.y, x2: b.cx, y2: b.cy });
    return results;
  }

  // Two circles/arcs
  if ((a.type === 'circle' || a.type === 'arc') && (b.type === 'circle' || b.type === 'arc')) {
    results.push({ dimType: 'distance', label: 'Distance (centers)', x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy });
    return results;
  }

  // Segment + circle/arc
  if (a.type === 'segment' && (b.type === 'circle' || b.type === 'arc')) {
    results.push({ dimType: 'distance', label: 'Distance', x1: a.midX, y1: a.midY, x2: b.cx, y2: b.cy });
    return results;
  }
  if ((a.type === 'circle' || a.type === 'arc') && b.type === 'segment') {
    results.push({ dimType: 'distance', label: 'Distance', x1: a.cx, y1: a.cy, x2: b.midX, y2: b.midY });
    return results;
  }

  // Fallback
  results.push({ dimType: 'distance', label: 'Distance',
    x1: a.x1 ?? a.x ?? a.cx ?? 0, y1: a.y1 ?? a.y ?? a.cy ?? 0,
    x2: b.x1 ?? b.x ?? b.cx ?? 0, y2: b.y1 ?? b.y ?? b.cy ?? 0 });
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _areParallel(segA, segB) {
  const dxA = segA.x2 - segA.x1, dyA = segA.y2 - segA.y1;
  const dxB = segB.x2 - segB.x1, dyB = segB.y2 - segB.y1;
  const lenA = Math.hypot(dxA, dyA) || 1e-9;
  const lenB = Math.hypot(dxB, dyB) || 1e-9;
  const cross = Math.abs(dxA * dyB - dyA * dxB) / (lenA * lenB);
  return cross < 0.01; // within ~0.6°
}

function _footOnLine(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: ax, y: ay };
  const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  return { x: ax + t * dx, y: ay + t * dy };
}

function _footOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: ax, y: ay };
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: ax + t * dx, y: ay + t * dy };
}

function _segAngleInfo(segA, segB) {
  // Find intersection of two lines (or use closest point)
  const a1x = segA.x1, a1y = segA.y1, a2x = segA.x2, a2y = segA.y2;
  const b1x = segB.x1, b1y = segB.y1, b2x = segB.x2, b2y = segB.y2;
  const dAx = a2x - a1x, dAy = a2y - a1y;
  const dBx = b2x - b1x, dBy = b2y - b1y;
  const denom = dAx * dBy - dAy * dBx;
  let vx, vy;
  if (Math.abs(denom) < 1e-9) {
    vx = (a1x + a2x + b1x + b2x) / 4;
    vy = (a1y + a2y + b1y + b2y) / 4;
  } else {
    const t = ((b1x - a1x) * dBy - (b1y - a1y) * dBx) / denom;
    vx = a1x + t * dAx;
    vy = a1y + t * dAy;
  }
  const angleA = Math.atan2(dAy, dAx);
  const angleB = Math.atan2(dBy, dBx);
  let sweep = angleB - angleA;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  return { vx, vy, startAngle: angleA, sweep };
}

// Re-exported for use in syncFromSources (same logic as _segAngleInfo)
const _segAngleInfoLive = _segAngleInfo;

function _scaleSegToLength(seg, target) {
  const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
  const len = Math.hypot(dx, dy) || 1e-9;
  const scale = target / len;
  const mx = seg.midX, my = seg.midY;
  if (!seg.p1.fixed) {
    seg.p1.x = mx - (dx / 2) * scale;
    seg.p1.y = my - (dy / 2) * scale;
  }
  if (!seg.p2.fixed) {
    seg.p2.x = mx + (dx / 2) * scale;
    seg.p2.y = my + (dy / 2) * scale;
  }
}

function _drawArrow(ctx, x, y, angle, len) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - len * Math.cos(angle - 0.3), y - len * Math.sin(angle - 0.3));
  ctx.moveTo(x, y);
  ctx.lineTo(x - len * Math.cos(angle + 0.3), y - len * Math.sin(angle + 0.3));
  ctx.stroke();
}

function _segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

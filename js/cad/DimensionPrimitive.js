// js/cad/DimensionPrimitive.js — Smart constraint dimension annotation
//
// Supports multiple dimension types detected from source primitives:
//   'distance'  – linear distance between two points / point-line / parallel lines
//   'dx'        – horizontal distance between two points
//   'dy'        – vertical distance between two points
//   'angle'     – angle between two non-parallel segments
//   'radius'    – radius of a circle or arc
//
// Each dimension can be a passive follower or an active constraint.
// Dimensions can write their value into a named variable.
// Display mode controls the label: 'value', 'formula', or 'both'.
// Visibility can be toggled for cleaner drawings.

import { Primitive } from './Primitive.js';
import { resolveValue } from './Constraint.js';

/** Valid dimension types */
export const DIM_TYPES = ['distance', 'dx', 'dy', 'angle', 'radius'];

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
  }

  /** Computed measured value */
  get value() {
    switch (this.dimType) {
      case 'dx': return Math.abs(this.x2 - this.x1);
      case 'dy': return Math.abs(this.y2 - this.y1);
      case 'angle': return this._computeAngle();
      case 'radius': return Math.hypot(this.x2 - this.x1, this.y2 - this.y1);
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
    const formatted = this.dimType === 'angle'
      ? (val * 180 / Math.PI).toFixed(1)
      : val.toFixed(2);

    if (this.displayMode === 'formula' && this.formula != null) {
      return String(this.formula);
    }
    if (this.displayMode === 'both' && this.formula != null) {
      return `${this.formula} = ${formatted}${unit}`;
    }
    return `${formatted}${unit}`;
  }

  _computeAngle() {
    // Angle is stored as radians between the two direction vectors encoded in x1,y1→x2,y2
    // For angle dims, (x1,y1) is the vertex, (x2,y2) encodes the angle span
    const dx = this.x2 - this.x1, dy = this.y2 - this.y1;
    return Math.atan2(dy, dx);
  }

  getBounds() {
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
      // Distance from angle vertex
      return Math.hypot(px - this.x1, py - this.y1);
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

    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y); ctx.lineTo(d1.x, d1.y);
    ctx.moveTo(p2.x, p2.y); ctx.lineTo(d2.x, d2.y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(d1.x, d1.y); ctx.lineTo(d2.x, d2.y);
    ctx.stroke();

    const arrowLen = 8;
    const angle = Math.atan2(d2.y - d1.y, d2.x - d1.x);
    _drawArrow(ctx, d1.x, d1.y, angle, arrowLen);
    _drawArrow(ctx, d2.x, d2.y, angle + Math.PI, arrowLen);

    const mx = (d1.x + d2.x) / 2, my = (d1.y + d2.y) / 2;
    const fontSize = Math.max(10, 12);
    ctx.font = `${fontSize}px 'Consolas', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.save();
    ctx.translate(mx, my);
    let ta = angle;
    if (ta > Math.PI / 2 || ta < -Math.PI / 2) ta += Math.PI;
    ctx.rotate(ta);
    ctx.fillText(this.displayLabel, 0, -4);
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

    // Draw the arc
    ctx.beginPath();
    ctx.arc(vs.x, vs.y, r, -startA, -(startA + sweepA), true);
    ctx.stroke();

    // Arrow at end
    const endAngle = startA + sweepA;
    const arrowLen = 8;
    const ea = -endAngle;
    const tangent = ea - Math.PI / 2; // tangent at arc end
    const ex = vs.x + r * Math.cos(ea);
    const ey = vs.y + r * Math.sin(ea);
    _drawArrow(ctx, ex, ey, tangent, arrowLen);

    // Label at midpoint of arc
    const midA = -(startA + sweepA / 2);
    const labelR = r + 12;
    const lx = vs.x + labelR * Math.cos(midA);
    const ly = vs.y + labelR * Math.sin(midA);
    const fontSize = Math.max(10, 12);
    ctx.font = `${fontSize}px 'Consolas', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.displayLabel, lx, ly);

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

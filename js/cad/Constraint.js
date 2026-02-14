// js/cad/Constraint.js — Geometric constraints between primitives
//
// Each constraint implements:
//   error()  → scalar residual (0 = satisfied)
//   apply()  → push involved points toward satisfaction (one relaxation step)
//   serialize() → plain JSON
//
// The solver iteratively calls apply() on all constraints until convergence.

let _nextCId = 1;
export function resetConstraintIds(v = 1) { _nextCId = v; }

// ---------------------------------------------------------------------------
// Named variables — a simple store that constraints can reference by name
// ---------------------------------------------------------------------------
const _variables = new Map(); // name → number

export function setVariable(name, value) { _variables.set(name, value); }
export function getVariable(name) { return _variables.get(name); }
export function removeVariable(name) { _variables.delete(name); }
export function getAllVariables() { return new Map(_variables); }
export function clearVariables() { _variables.clear(); }
export function serializeVariables() {
  const out = {};
  for (const [k, v] of _variables) out[k] = v;
  return out;
}
export function deserializeVariables(data) {
  _variables.clear();
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) _variables.set(k, Number(v));
  }
}

/** Resolve a value that may be a number or a variable name string. */
export function resolveValue(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const v = _variables.get(val);
    return v !== undefined ? v : NaN;
  }
  return NaN;
}

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------
export class Constraint {
  constructor(type) {
    this.id = _nextCId++;
    this.type = type;
    this.min = null; // optional limit range minimum
    this.max = null; // optional limit range maximum
  }
  error() { return 0; }
  apply() {}
  involvedPoints() { return []; }
  /** Check if this constraint type has an editable value. */
  get editable() { return false; }
  serialize() {
    const out = { id: this.id, type: this.type };
    if (this.min != null) out.min = this.min;
    if (this.max != null) out.max = this.max;
    return out;
  }
  /** Clamp a value to the constraint's limit range if set. */
  clampToRange(v) {
    if (this.min != null && v < this.min) v = this.min;
    if (this.max != null && v > this.max) v = this.max;
    return v;
  }
}

// ---------------------------------------------------------------------------
// Coincident – two points share the same position
// ---------------------------------------------------------------------------
export class Coincident extends Constraint {
  constructor(ptA, ptB) {
    super('coincident');
    this.ptA = ptA;
    this.ptB = ptB;
  }
  error() {
    return Math.hypot(this.ptB.x - this.ptA.x, this.ptB.y - this.ptA.y);
  }
  apply() {
    const a = this.ptA, b = this.ptB;
    if (a.fixed && b.fixed) return;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    if (a.fixed) { b.x = a.x; b.y = a.y; }
    else if (b.fixed) { a.x = b.x; a.y = b.y; }
    else { a.x = b.x = mx; a.y = b.y = my; }
  }
  involvedPoints() { return [this.ptA, this.ptB]; }
  serialize() { return { ...super.serialize(), ptA: this.ptA.id, ptB: this.ptB.id }; }
}

// ---------------------------------------------------------------------------
// Distance – distance between two points equals a target value
// ---------------------------------------------------------------------------
export class Distance extends Constraint {
  constructor(ptA, ptB, value) {
    super('distance');
    this.ptA = ptA;
    this.ptB = ptB;
    this.value = value; // number or variable name string
  }
  get editable() { return true; }
  _resolvedValue() { return this.clampToRange(resolveValue(this.value)); }
  error() {
    return Math.abs(Math.hypot(this.ptB.x - this.ptA.x, this.ptB.y - this.ptA.y) - this._resolvedValue());
  }
  apply() {
    const a = this.ptA, b = this.ptB;
    if (a.fixed && b.fixed) return;
    const target = this._resolvedValue();
    if (isNaN(target)) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-9;
    const err = d - target;
    const ux = dx / d, uy = dy / d;
    if (a.fixed) {
      b.x -= ux * err; b.y -= uy * err;
    } else if (b.fixed) {
      a.x += ux * err; a.y += uy * err;
    } else {
      const half = err / 2;
      a.x += ux * half; a.y += uy * half;
      b.x -= ux * half; b.y -= uy * half;
    }
  }
  involvedPoints() { return [this.ptA, this.ptB]; }
  serialize() { return { ...super.serialize(), ptA: this.ptA.id, ptB: this.ptB.id, value: this.value }; }
}

// ---------------------------------------------------------------------------
// Fixed – a point must stay at a given position
// ---------------------------------------------------------------------------
export class Fixed extends Constraint {
  constructor(pt, x = null, y = null) {
    super('fixed');
    this.pt = pt;
    this.fx = x ?? pt.x;
    this.fy = y ?? pt.y;
    pt.fixed = true;
  }
  get editable() { return true; }
  error() {
    return Math.hypot(this.pt.x - this.fx, this.pt.y - this.fy);
  }
  apply() {
    this.pt.x = this.fx; this.pt.y = this.fy;
  }
  involvedPoints() { return [this.pt]; }
  serialize() { return { ...super.serialize(), pt: this.pt.id, fx: this.fx, fy: this.fy }; }
}

// ---------------------------------------------------------------------------
// Horizontal – a segment's two endpoints share the same Y
// ---------------------------------------------------------------------------
export class Horizontal extends Constraint {
  /** @param {import('./Segment.js').PSegment} seg */
  constructor(seg) {
    super('horizontal');
    this.seg = seg;
  }
  error() { return Math.abs(this.seg.p2.y - this.seg.p1.y); }
  apply() {
    const a = this.seg.p1, b = this.seg.p2;
    if (a.fixed && b.fixed) return;
    const my = (a.y + b.y) / 2;
    if (a.fixed) { b.y = a.y; }
    else if (b.fixed) { a.y = b.y; }
    else { a.y = b.y = my; }
  }
  involvedPoints() { return [this.seg.p1, this.seg.p2]; }
  serialize() { return { ...super.serialize(), seg: this.seg.id }; }
}

// ---------------------------------------------------------------------------
// Vertical – a segment's two endpoints share the same X
// ---------------------------------------------------------------------------
export class Vertical extends Constraint {
  constructor(seg) {
    super('vertical');
    this.seg = seg;
  }
  error() { return Math.abs(this.seg.p2.x - this.seg.p1.x); }
  apply() {
    const a = this.seg.p1, b = this.seg.p2;
    if (a.fixed && b.fixed) return;
    const mx = (a.x + b.x) / 2;
    if (a.fixed) { b.x = a.x; }
    else if (b.fixed) { a.x = b.x; }
    else { a.x = b.x = mx; }
  }
  involvedPoints() { return [this.seg.p1, this.seg.p2]; }
  serialize() { return { ...super.serialize(), seg: this.seg.id }; }
}

// ---------------------------------------------------------------------------
// Parallel – two segments share the same direction
// ---------------------------------------------------------------------------
export class Parallel extends Constraint {
  constructor(segA, segB) {
    super('parallel');
    this.segA = segA;
    this.segB = segB;
  }
  error() {
    const dxA = this.segA.x2 - this.segA.x1, dyA = this.segA.y2 - this.segA.y1;
    const dxB = this.segB.x2 - this.segB.x1, dyB = this.segB.y2 - this.segB.y1;
    const lenA = Math.hypot(dxA, dyA) || 1e-9;
    const lenB = Math.hypot(dxB, dyB) || 1e-9;
    // cross product of unit vectors = sin(angle between them)
    return Math.abs((dxA * dyB - dyA * dxB) / (lenA * lenB));
  }
  apply() {
    // Rotate segB to match segA's direction.
    // If segA is axis-aligned, enforce exact axis alignment on segB too.
    const dxA = this.segA.x2 - this.segA.x1, dyA = this.segA.y2 - this.segA.y1;
    const lenA = Math.hypot(dxA, dyA) || 1e-9;
    let uxA = dxA / lenA, uyA = dyA / lenA;

    // Preserve exact horizontal/vertical orientation when segA is near axis-aligned.
    const axisTol = 1e-9;
    if (Math.abs(dyA) <= axisTol * lenA) {
      uyA = 0;
      uxA = dxA >= 0 ? 1 : -1;
    } else if (Math.abs(dxA) <= axisTol * lenA) {
      uxA = 0;
      uyA = dyA >= 0 ? 1 : -1;
    }

    const dxB = this.segB.x2 - this.segB.x1, dyB = this.segB.y2 - this.segB.y1;
    const lenB = Math.hypot(dxB, dyB) || 1e-9;

    // Check direction alignment (keep same direction as original)
    const dot = dxB * uxA + dyB * uyA;
    const sign = dot >= 0 ? 1 : -1;

    const dirX = sign * uxA;
    const dirY = sign * uyA;
    const p1 = this.segB.p1;
    const p2 = this.segB.p2;

    if (p1.fixed && p2.fixed) return;

    // One fixed endpoint: move the other along the target direction.
    if (p1.fixed && !p2.fixed) {
      p2.x = p1.x + dirX * lenB;
      p2.y = p1.y + dirY * lenB;
      return;
    }
    if (!p1.fixed && p2.fixed) {
      p1.x = p2.x - dirX * lenB;
      p1.y = p2.y - dirY * lenB;
      return;
    }

    // No fixed endpoints: keep segB midpoint fixed.
    const mx = this.segB.midX, my = this.segB.midY;
    const halfLen = lenB / 2;
    p1.x = mx - dirX * halfLen;
    p1.y = my - dirY * halfLen;
    p2.x = mx + dirX * halfLen;
    p2.y = my + dirY * halfLen;
  }
  involvedPoints() { return [this.segA.p1, this.segA.p2, this.segB.p1, this.segB.p2]; }
  serialize() { return { ...super.serialize(), segA: this.segA.id, segB: this.segB.id }; }
}

// ---------------------------------------------------------------------------
// Perpendicular – two segments are at 90°
// ---------------------------------------------------------------------------
export class Perpendicular extends Constraint {
  constructor(segA, segB) {
    super('perpendicular');
    this.segA = segA;
    this.segB = segB;
  }
  error() {
    const dxA = this.segA.x2 - this.segA.x1, dyA = this.segA.y2 - this.segA.y1;
    const dxB = this.segB.x2 - this.segB.x1, dyB = this.segB.y2 - this.segB.y1;
    const lenA = Math.hypot(dxA, dyA) || 1e-9;
    const lenB = Math.hypot(dxB, dyB) || 1e-9;
    // dot product of unit vectors = cos(angle between them)
    return Math.abs((dxA * dxB + dyA * dyB) / (lenA * lenB));
  }
  apply() {
    // Rotate segB 90° from segA, keeping segB's midpoint fixed
    const dxA = this.segA.x2 - this.segA.x1, dyA = this.segA.y2 - this.segA.y1;
    const lenA = Math.hypot(dxA, dyA) || 1e-9;
    // Perpendicular unit vector to segA
    const upX = -dyA / lenA, upY = dxA / lenA;

    const dxB = this.segB.x2 - this.segB.x1, dyB = this.segB.y2 - this.segB.y1;
    const lenB = Math.hypot(dxB, dyB) || 1e-9;
    const dot = dxB * upX + dyB * upY;
    const sign = dot >= 0 ? 1 : -1;

    const mx = this.segB.midX, my = this.segB.midY;
    const halfLen = lenB / 2;
    if (!this.segB.p1.fixed) {
      this.segB.p1.x = mx - sign * upX * halfLen;
      this.segB.p1.y = my - sign * upY * halfLen;
    }
    if (!this.segB.p2.fixed) {
      this.segB.p2.x = mx + sign * upX * halfLen;
      this.segB.p2.y = my + sign * upY * halfLen;
    }
  }
  involvedPoints() { return [this.segA.p1, this.segA.p2, this.segB.p1, this.segB.p2]; }
  serialize() { return { ...super.serialize(), segA: this.segA.id, segB: this.segB.id }; }
}

// ---------------------------------------------------------------------------
// Angle – angle between two segments equals a target (radians)
// ---------------------------------------------------------------------------
export class Angle extends Constraint {
  constructor(segA, segB, value) {
    super('angle');
    this.segA = segA;
    this.segB = segB;
    this.value = value; // radians, number or variable name
  }
  get editable() { return true; }
  _resolvedValue() { return this.clampToRange(resolveValue(this.value)); }
  error() {
    const dxA = this.segA.x2 - this.segA.x1, dyA = this.segA.y2 - this.segA.y1;
    const dxB = this.segB.x2 - this.segB.x1, dyB = this.segB.y2 - this.segB.y1;
    const a = Math.atan2(dyA, dxA);
    const b = Math.atan2(dyB, dxB);
    let diff = b - a;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return Math.abs(diff - this._resolvedValue());
  }
  apply() {
    const target = this._resolvedValue();
    if (isNaN(target)) return;
    const dxA = this.segA.x2 - this.segA.x1, dyA = this.segA.y2 - this.segA.y1;
    const angleA = Math.atan2(dyA, dxA);
    const targetAngle = angleA + target;

    const dxB = this.segB.x2 - this.segB.x1, dyB = this.segB.y2 - this.segB.y1;
    const lenB = Math.hypot(dxB, dyB) || 1e-9;
    const ux = Math.cos(targetAngle), uy = Math.sin(targetAngle);

    const mx = this.segB.midX, my = this.segB.midY;
    const halfLen = lenB / 2;
    if (!this.segB.p1.fixed) {
      this.segB.p1.x = mx - ux * halfLen;
      this.segB.p1.y = my - uy * halfLen;
    }
    if (!this.segB.p2.fixed) {
      this.segB.p2.x = mx + ux * halfLen;
      this.segB.p2.y = my + uy * halfLen;
    }
  }
  involvedPoints() { return [this.segA.p1, this.segA.p2, this.segB.p1, this.segB.p2]; }
  serialize() { return { ...super.serialize(), segA: this.segA.id, segB: this.segB.id, value: this.value }; }
}

// ---------------------------------------------------------------------------
// EqualLength – two segments share the same length
// ---------------------------------------------------------------------------
export class EqualLength extends Constraint {
  constructor(segA, segB) {
    super('equal_length');
    this.segA = segA;
    this.segB = segB;
  }
  error() { return Math.abs(this.segA.length - this.segB.length); }
  apply() {
    const target = (this.segA.length + this.segB.length) / 2;
    _scaleSegToLength(this.segB, target);
    _scaleSegToLength(this.segA, target);
  }
  involvedPoints() { return [this.segA.p1, this.segA.p2, this.segB.p1, this.segB.p2]; }
  serialize() { return { ...super.serialize(), segA: this.segA.id, segB: this.segB.id }; }
}

// ---------------------------------------------------------------------------
// Length – a segment has a specific length
// ---------------------------------------------------------------------------
export class Length extends Constraint {
  constructor(seg, value) {
    super('length');
    this.seg = seg;
    this.value = value; // number or variable name
  }
  get editable() { return true; }
  _resolvedValue() { return this.clampToRange(resolveValue(this.value)); }
  error() { return Math.abs(this.seg.length - this._resolvedValue()); }
  apply() {
    const target = this._resolvedValue();
    if (isNaN(target)) return;
    _scaleSegToLength(this.seg, target);
  }
  involvedPoints() { return [this.seg.p1, this.seg.p2]; }
  serialize() { return { ...super.serialize(), seg: this.seg.id, value: this.value }; }
}

// ---------------------------------------------------------------------------
// Radius – circle or arc has a specific radius
// ---------------------------------------------------------------------------
export class RadiusConstraint extends Constraint {
  constructor(shape, value) {
    super('radius');
    this.shape = shape; // PCircle or PArc
    this.value = value; // number or variable name
  }
  get editable() { return true; }
  _resolvedValue() { return this.clampToRange(resolveValue(this.value)); }
  error() { return Math.abs(this.shape.radius - this._resolvedValue()); }
  apply() {
    const target = this._resolvedValue();
    if (isNaN(target)) return;
    this.shape.radius = target;
  }
  involvedPoints() { return [this.shape.center]; }
  serialize() { return { ...super.serialize(), shape: this.shape.id, value: this.value }; }
}

// ---------------------------------------------------------------------------
// Tangent – segment tangent to circle/arc
// ---------------------------------------------------------------------------
export class Tangent extends Constraint {
  constructor(seg, circle) {
    super('tangent');
    this.seg = seg;
    this.circle = circle; // PCircle or PArc
  }
  error() {
    // distance from circle center to the line should equal radius
    const d = _ptLineDist(this.circle.cx, this.circle.cy,
      this.seg.x1, this.seg.y1, this.seg.x2, this.seg.y2);
    return Math.abs(d - this.circle.radius);
  }
  apply() {
    // Move the segment so that its line is exactly tangent
    const cx = this.circle.cx, cy = this.circle.cy;
    const dx = this.seg.x2 - this.seg.x1, dy = this.seg.y2 - this.seg.y1;
    const len = Math.hypot(dx, dy) || 1e-9;
    // Foot of perpendicular from center to the infinite line
    const t = ((cx - this.seg.x1) * dx + (cy - this.seg.y1) * dy) / (len * len);
    const fx = this.seg.x1 + t * dx, fy = this.seg.y1 + t * dy;
    const fdist = Math.hypot(cx - fx, cy - fy) || 1e-9;
    const nx = (fx - cx) / fdist, ny = (fy - cy) / fdist;
    const correction = this.circle.radius - fdist;
    // Shift both endpoints along normal
    if (!this.seg.p1.fixed) { this.seg.p1.x += nx * correction; this.seg.p1.y += ny * correction; }
    if (!this.seg.p2.fixed) { this.seg.p2.x += nx * correction; this.seg.p2.y += ny * correction; }
  }
  involvedPoints() { return [this.seg.p1, this.seg.p2, this.circle.center]; }
  serialize() { return { ...super.serialize(), seg: this.seg.id, circle: this.circle.id }; }
}

// ---------------------------------------------------------------------------
// OnLine – a point lies on the infinite line through a segment
// ---------------------------------------------------------------------------
export class OnLine extends Constraint {
  constructor(pt, seg) {
    super('on_line');
    this.pt = pt;
    this.seg = seg;
  }
  error() {
    return _ptLineDist(this.pt.x, this.pt.y,
      this.seg.x1, this.seg.y1, this.seg.x2, this.seg.y2);
  }
  apply() {
    if (this.pt.fixed) return;
    const dx = this.seg.x2 - this.seg.x1, dy = this.seg.y2 - this.seg.y1;
    const len = Math.hypot(dx, dy) || 1e-9;
    const t = ((this.pt.x - this.seg.x1) * dx + (this.pt.y - this.seg.y1) * dy) / (len * len);
    this.pt.x = this.seg.x1 + t * dx;
    this.pt.y = this.seg.y1 + t * dy;
  }
  involvedPoints() { return [this.pt, this.seg.p1, this.seg.p2]; }
  serialize() { return { ...super.serialize(), pt: this.pt.id, seg: this.seg.id }; }
}

// ---------------------------------------------------------------------------
// OnCircle – a point lies on a circle / arc perimeter
// ---------------------------------------------------------------------------
export class OnCircle extends Constraint {
  constructor(pt, circle) {
    super('on_circle');
    this.pt = pt;
    this.circle = circle;
  }
  error() {
    return Math.abs(Math.hypot(this.pt.x - this.circle.cx, this.pt.y - this.circle.cy) - this.circle.radius);
  }
  apply() {
    if (this.pt.fixed) return;
    const dx = this.pt.x - this.circle.cx;
    const dy = this.pt.y - this.circle.cy;
    const d = Math.hypot(dx, dy) || 1e-9;
    this.pt.x = this.circle.cx + (dx / d) * this.circle.radius;
    this.pt.y = this.circle.cy + (dy / d) * this.circle.radius;
  }
  involvedPoints() { return [this.pt, this.circle.center]; }
  serialize() { return { ...super.serialize(), pt: this.pt.id, circle: this.circle.id }; }
}

// ---------------------------------------------------------------------------
// Midpoint – a point sits at the midpoint of a segment
// ---------------------------------------------------------------------------
export class Midpoint extends Constraint {
  constructor(pt, seg) {
    super('midpoint');
    this.pt = pt;
    this.seg = seg;
  }
  error() {
    return Math.hypot(this.pt.x - this.seg.midX, this.pt.y - this.seg.midY);
  }
  apply() {
    if (this.pt.fixed) return;
    this.pt.x = this.seg.midX;
    this.pt.y = this.seg.midY;
  }
  involvedPoints() { return [this.pt, this.seg.p1, this.seg.p2]; }
  serialize() { return { ...super.serialize(), pt: this.pt.id, seg: this.seg.id }; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

function _ptLineDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(px - ax, py - ay);
  return Math.abs((dy * px - dx * py + bx * ay - by * ax)) / len;
}

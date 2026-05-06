// js/cad/ArcPrimitive.js — An arc defined by a center PPoint, radius, and angle range
import { Primitive } from './Primitive.js';

const _DASH_PATTERNS = { 'dashed': [10, 5], 'dash-dot': [12, 4, 2, 4], 'dotted': [2, 4] };
function _constructionDash(style) { return _DASH_PATTERNS[style] || _DASH_PATTERNS['dashed']; }
const ARC_ANGLE_EPS = 1e-12;

export class PArc extends Primitive {
  /**
   * @param {import('./Point.js').PPoint} center
   * @param {number} radius
   * @param {number} startAngle — radians
   * @param {number} endAngle   — radians
   */
  constructor(center, radius, startAngle, endAngle, startPoint = null, endPoint = null) {
    super('arc');
    this.center = center;
    this._radius = radius;
    this._startAngle = startAngle;
    this._endAngle = endAngle;
    this.startPoint = startPoint;
    this.endPoint = endPoint;
  }

  get cx() { return this.center.x; }
  get cy() { return this.center.y; }
  get radius() {
    if (this.startPoint && this.endPoint) {
      const rs = Math.hypot(this.startPoint.x - this.cx, this.startPoint.y - this.cy);
      const re = Math.hypot(this.endPoint.x - this.cx, this.endPoint.y - this.cy);
      if (Number.isFinite(rs) && Number.isFinite(re)) return (rs + re) / 2;
    }
    return this._radius;
  }
  set radius(value) {
    const startAngle = this.startAngle;
    const endAngle = this.endAngle;
    this._radius = Math.max(0, value);
    this._startAngle = startAngle;
    this._endAngle = endAngle;
    this._syncEndpointRadius();
  }
  get startAngle() {
    return this.startPoint
      ? _angleNear(Math.atan2(this.startPoint.y - this.cy, this.startPoint.x - this.cx), this._startAngle)
      : this._startAngle;
  }
  set startAngle(value) {
    this._startAngle = value;
    if (this.startPoint) {
      const r = this.radius;
      this.startPoint.x = this.cx + r * Math.cos(value);
      this.startPoint.y = this.cy + r * Math.sin(value);
    }
  }
  get endAngle() {
    return this.endPoint
      ? _angleNear(Math.atan2(this.endPoint.y - this.cy, this.endPoint.x - this.cx), this._endAngle)
      : this._endAngle;
  }
  set endAngle(value) {
    this._endAngle = value;
    if (this.endPoint) {
      const r = this.radius;
      this.endPoint.x = this.cx + r * Math.cos(value);
      this.endPoint.y = this.cy + r * Math.sin(value);
    }
  }

  /** Start-point on perimeter */
  get startPt() {
    if (this.startPoint) return { x: this.startPoint.x, y: this.startPoint.y };
    return { x: this.cx + this.radius * Math.cos(this.startAngle),
             y: this.cy + this.radius * Math.sin(this.startAngle) };
  }
  /** End-point on perimeter */
  get endPt() {
    if (this.endPoint) return { x: this.endPoint.x, y: this.endPoint.y };
    return { x: this.cx + this.radius * Math.cos(this.endAngle),
             y: this.cy + this.radius * Math.sin(this.endAngle) };
  }

  getBounds() {
    const pts = this._sample(32);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  _sample(n) {
    const pts = [];
    const sweep = this.sweepAngle;
    for (let i = 0; i <= n; i++) {
      const a = this.startAngle + (sweep * i) / n;
      pts.push({ x: this.cx + this.radius * Math.cos(a), y: this.cy + this.radius * Math.sin(a) });
    }
    return pts;
  }

  get sweepAngle() {
    let sweep = this.endAngle - this.startAngle;
    if (Math.abs(sweep) < ARC_ANGLE_EPS) return 0;
    while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
    while (sweep < -Math.PI * 2) sweep += Math.PI * 2;
    return sweep;
  }

  getSnapPoints() {
    const sp = this.startPt;
    const ep = this.endPt;
    const mid = this.startAngle + this.sweepAngle / 2;
    const points = [
      { ...sp, type: 'endpoint' },
      { ...ep, type: 'endpoint' },
      { x: this.cx, y: this.cy, type: 'center' },
    ];
    for (const angle of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
      if (this._angleInArc(angle)) {
        points.push({ x: this.cx + this.radius * Math.cos(angle), y: this.cy + this.radius * Math.sin(angle), type: 'quadrant' });
      }
    }
    points.push({ x: this.cx + this.radius * Math.cos(mid), y: this.cy + this.radius * Math.sin(mid), type: 'midpoint' });
    return points;
  }

  distanceTo(px, py) {
    const angle = Math.atan2(py - this.cy, px - this.cx);
    const d = Math.hypot(px - this.cx, py - this.cy);
    if (this._angleInArc(angle)) return Math.abs(d - this.radius);
    const sp = this.startPt, ep = this.endPt;
    return Math.min(Math.hypot(px - sp.x, py - sp.y), Math.hypot(px - ep.x, py - ep.y));
  }

  _angleInArc(angle) {
    const sweep = this.sweepAngle;
    if (Math.abs(Math.abs(sweep) - Math.PI * 2) < ARC_ANGLE_EPS) return true;
    if (sweep >= 0) {
      const a = ((angle - this.startAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      return a <= sweep;
    }
    const a = ((this.startAngle - angle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    return a <= -sweep;
  }

  draw(ctx, vp) {
    const c = vp.worldToScreen(this.cx, this.cy);
    const r = this.radius * vp.zoom;
    if (this.construction) {
      ctx.save();
      ctx.setLineDash(_constructionDash(this.constructionDash));
    }
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, -this.startAngle, -this.endAngle, this.sweepAngle < 0);
    ctx.stroke();
    if (this.construction) ctx.restore();
  }

  translate(dx, dy) {
    this.center.translate(dx, dy);
    if (this.startPoint) this.startPoint.translate(dx, dy);
    if (this.endPoint) this.endPoint.translate(dx, dy);
  }

  setEndpointPosition(which, x, y) {
    const startAngle = this.startAngle;
    const endAngle = this.endAngle;
    const sweep = this.sweepAngle;
    const nextRadius = Math.max(0, Math.hypot(x - this.cx, y - this.cy));
    const nextAngle = Math.atan2(y - this.cy, x - this.cx);
    const keepShortSweep = Math.abs(sweep) <= Math.PI + ARC_ANGLE_EPS;
    this._radius = nextRadius;
    if (which === 'start') {
      this._startAngle = keepShortSweep
        ? _angleForShortestSweep(nextAngle, endAngle, sweep, 'start')
        : _anglePreservingSweep(nextAngle, startAngle, endAngle, sweep, 'start');
      this._endAngle = endAngle;
    } else {
      this._startAngle = startAngle;
      this._endAngle = keepShortSweep
        ? _angleForShortestSweep(nextAngle, startAngle, sweep, 'end')
        : _anglePreservingSweep(nextAngle, endAngle, startAngle, sweep, 'end');
    }
    this._syncEndpointRadius();
  }

  _syncEndpointRadius() {
    if (this.startPoint) {
      const a = this._startAngle;
      this.startPoint.x = this.cx + this._radius * Math.cos(a);
      this.startPoint.y = this.cy + this._radius * Math.sin(a);
    }
    if (this.endPoint) {
      const a = this._endAngle;
      this.endPoint.x = this.cx + this._radius * Math.cos(a);
      this.endPoint.y = this.cy + this._radius * Math.sin(a);
    }
  }

  serialize() {
    return {
      ...super.serialize(),
      center: this.center.id,
      radius: this.radius,
      startAngle: this.startAngle,
      endAngle: this.endAngle,
      startPoint: this.startPoint?.id ?? null,
      endPoint: this.endPoint?.id ?? null,
    };
  }
}

function _angleNear(angle, reference) {
  while (angle - reference > Math.PI) angle -= Math.PI * 2;
  while (angle - reference < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function _anglePreservingSweep(angle, previousAngle, fixedAngle, previousSweep, which) {
  if (Math.abs(previousSweep) <= ARC_ANGLE_EPS) return _angleNear(angle, previousAngle);
  const sign = Math.sign(previousSweep);
  let best = null;
  for (let turn = -2; turn <= 2; turn++) {
    const candidate = angle + turn * Math.PI * 2;
    const sweep = which === 'start' ? fixedAngle - candidate : candidate - fixedAngle;
    if (sign > 0 && (sweep <= ARC_ANGLE_EPS || sweep > Math.PI * 2 + ARC_ANGLE_EPS)) continue;
    if (sign < 0 && (sweep >= -ARC_ANGLE_EPS || sweep < -Math.PI * 2 - ARC_ANGLE_EPS)) continue;
    const score = Math.abs(candidate - previousAngle);
    if (!best || score < best.score) best = { angle: candidate, score };
  }
  return best ? best.angle : _angleNear(angle, previousAngle);
}

function _angleForShortestSweep(angle, fixedAngle, previousSweep, which) {
  let sweep = which === 'start' ? fixedAngle - angle : angle - fixedAngle;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;
  if (Math.abs(Math.abs(sweep) - Math.PI) <= ARC_ANGLE_EPS && Math.sign(previousSweep) < 0) {
    sweep = -Math.PI;
  }
  return which === 'start' ? fixedAngle - sweep : fixedAngle + sweep;
}

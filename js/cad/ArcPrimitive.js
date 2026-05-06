// js/cad/ArcPrimitive.js — An arc defined by a center PPoint, radius, and angle range
import { Primitive } from './Primitive.js';

const _DASH_PATTERNS = { 'dashed': [10, 5], 'dash-dot': [12, 4, 2, 4], 'dotted': [2, 4] };
function _constructionDash(style) { return _DASH_PATTERNS[style] || _DASH_PATTERNS['dashed']; }

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
    this._radius = Math.max(0, value);
    this._syncEndpointRadius();
  }
  get startAngle() {
    return this.startPoint ? Math.atan2(this.startPoint.y - this.cy, this.startPoint.x - this.cx) : this._startAngle;
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
    return this.endPoint ? Math.atan2(this.endPoint.y - this.cy, this.endPoint.x - this.cx) : this._endAngle;
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
    if (Math.abs(sweep) < 1e-12) return Math.PI * 2;
    while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
    while (sweep < -Math.PI * 2) sweep += Math.PI * 2;
    return sweep;
  }

  getSnapPoints() {
    const sp = this.startPt;
    const ep = this.endPt;
    const mid = this.startAngle + this.sweepAngle / 2;
    return [
      { ...sp, type: 'endpoint' },
      { ...ep, type: 'endpoint' },
      { x: this.cx + this.radius * Math.cos(mid), y: this.cy + this.radius * Math.sin(mid), type: 'midpoint' },
      { x: this.cx, y: this.cy, type: 'center' },
      { x: this.cx + this.radius, y: this.cy, type: 'quadrant' },
      { x: this.cx - this.radius, y: this.cy, type: 'quadrant' },
      { x: this.cx, y: this.cy + this.radius, type: 'quadrant' },
      { x: this.cx, y: this.cy - this.radius, type: 'quadrant' },
    ];
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
    if (Math.abs(Math.abs(sweep) - Math.PI * 2) < 1e-12) return true;
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
    ctx.arc(c.x, c.y, r, -this.startAngle, -this.endAngle, this.sweepAngle >= 0);
    ctx.stroke();
    if (this.construction) ctx.restore();
  }

  translate(dx, dy) {
    this.center.translate(dx, dy);
    if (this.startPoint) this.startPoint.translate(dx, dy);
    if (this.endPoint) this.endPoint.translate(dx, dy);
  }

  _syncEndpointRadius() {
    if (this.startPoint) {
      const a = this.startAngle;
      this.startPoint.x = this.cx + this._radius * Math.cos(a);
      this.startPoint.y = this.cy + this._radius * Math.sin(a);
    }
    if (this.endPoint) {
      const a = this.endAngle;
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

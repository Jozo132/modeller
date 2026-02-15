// js/cad/ArcPrimitive.js — An arc defined by a center PPoint, radius, and angle range
import { Primitive } from './Primitive.js';

export class PArc extends Primitive {
  /**
   * @param {import('./Point.js').PPoint} center
   * @param {number} radius
   * @param {number} startAngle — radians
   * @param {number} endAngle   — radians
   */
  constructor(center, radius, startAngle, endAngle) {
    super('arc');
    this.center = center;
    this.radius = radius;
    this.startAngle = startAngle;
    this.endAngle = endAngle;
  }

  get cx() { return this.center.x; }
  get cy() { return this.center.y; }

  /** Start-point on perimeter */
  get startPt() {
    return { x: this.cx + this.radius * Math.cos(this.startAngle),
             y: this.cy + this.radius * Math.sin(this.startAngle) };
  }
  /** End-point on perimeter */
  get endPt() {
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
    let sweep = this.endAngle - this.startAngle;
    if (sweep <= 0) sweep += Math.PI * 2;
    for (let i = 0; i <= n; i++) {
      const a = this.startAngle + (sweep * i) / n;
      pts.push({ x: this.cx + this.radius * Math.cos(a), y: this.cy + this.radius * Math.sin(a) });
    }
    return pts;
  }

  getSnapPoints() {
    const sp = this.startPt;
    const ep = this.endPt;
    const mid = (this.startAngle + this.endAngle) / 2;
    return [
      { ...sp, type: 'endpoint' },
      { ...ep, type: 'endpoint' },
      { x: this.cx + this.radius * Math.cos(mid), y: this.cy + this.radius * Math.sin(mid), type: 'midpoint' },
      { x: this.cx, y: this.cy, type: 'center' },
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
    let a = ((angle - this.startAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    let sweep = ((this.endAngle - this.startAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    if (sweep === 0) sweep = Math.PI * 2;
    return a <= sweep;
  }

  draw(ctx, vp) {
    const c = vp.worldToScreen(this.cx, this.cy);
    const r = this.radius * vp.zoom;
    if (this.construction) {
      ctx.save();
      ctx.setLineDash([8, 4]); // dashed
    }
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, -this.startAngle, -this.endAngle, true);
    ctx.stroke();
    if (this.construction) ctx.restore();
  }

  translate(dx, dy) {
    this.center.translate(dx, dy);
  }

  serialize() {
    return {
      ...super.serialize(),
      center: this.center.id,
      radius: this.radius,
      startAngle: this.startAngle,
      endAngle: this.endAngle,
    };
  }
}

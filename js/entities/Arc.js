// js/entities/Arc.js
import { Entity } from './Entity.js';

export class Arc extends Entity {
  constructor(cx, cy, radius, startAngle, endAngle) {
    super('ARC');
    this.cx = cx; this.cy = cy;
    this.radius = radius;
    this.startAngle = startAngle; // radians
    this.endAngle = endAngle;     // radians
  }

  getBounds() {
    // Conservative bounding box
    const pts = this._samplePoints(32);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  _samplePoints(n) {
    const pts = [];
    let sweep = this.endAngle - this.startAngle;
    if (sweep <= 0) sweep += Math.PI * 2;
    for (let i = 0; i <= n; i++) {
      const a = this.startAngle + (sweep * i) / n;
      pts.push({
        x: this.cx + this.radius * Math.cos(a),
        y: this.cy + this.radius * Math.sin(a),
      });
    }
    return pts;
  }

  getSnapPoints() {
    const sp = { x: this.cx + this.radius * Math.cos(this.startAngle), y: this.cy + this.radius * Math.sin(this.startAngle), type: 'endpoint' };
    const ep = { x: this.cx + this.radius * Math.cos(this.endAngle), y: this.cy + this.radius * Math.sin(this.endAngle), type: 'endpoint' };
    const mid = (this.startAngle + this.endAngle) / 2;
    const mp = { x: this.cx + this.radius * Math.cos(mid), y: this.cy + this.radius * Math.sin(mid), type: 'midpoint' };
    return [sp, ep, mp, { x: this.cx, y: this.cy, type: 'center' }];
  }

  distanceTo(px, py) {
    const angle = Math.atan2(py - this.cy, px - this.cx);
    const d = Math.hypot(px - this.cx, py - this.cy);
    // Check if the angle lies within the arc
    if (this._angleInArc(angle)) {
      return Math.abs(d - this.radius);
    }
    // Otherwise distance to closest endpoint
    const sp = { x: this.cx + this.radius * Math.cos(this.startAngle), y: this.cy + this.radius * Math.sin(this.startAngle) };
    const ep = { x: this.cx + this.radius * Math.cos(this.endAngle), y: this.cy + this.radius * Math.sin(this.endAngle) };
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
    ctx.beginPath();
    // Canvas Y is flipped compared to world Y, so negate angles & swap direction
    ctx.arc(c.x, c.y, r, -this.startAngle, -this.endAngle, true);
    ctx.stroke();
  }

  translate(dx, dy) {
    this.cx += dx; this.cy += dy;
  }

  serialize() {
    return {
      ...super.serialize(),
      cx: this.cx, cy: this.cy, radius: this.radius,
      startAngle: this.startAngle, endAngle: this.endAngle,
    };
  }
}

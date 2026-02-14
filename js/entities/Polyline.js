// js/entities/Polyline.js
import { Entity } from './Entity.js';

export class Polyline extends Entity {
  constructor(points = [], closed = false) {
    super('LWPOLYLINE');
    this.points = points.map(p => ({ x: p.x, y: p.y })); // [{x,y}]
    this.closed = closed;
  }

  getBounds() {
    if (this.points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  getSnapPoints() {
    const snaps = this.points.map(p => ({ x: p.x, y: p.y, type: 'endpoint' }));
    const len = this.closed ? this.points.length : this.points.length - 1;
    for (let i = 0; i < len; i++) {
      const j = (i + 1) % this.points.length;
      snaps.push({
        x: (this.points[i].x + this.points[j].x) / 2,
        y: (this.points[i].y + this.points[j].y) / 2,
        type: 'midpoint',
      });
    }
    return snaps;
  }

  distanceTo(px, py) {
    let min = Infinity;
    const len = this.closed ? this.points.length : this.points.length - 1;
    for (let i = 0; i < len; i++) {
      const j = (i + 1) % this.points.length;
      const d = segDist(px, py, this.points[i].x, this.points[i].y, this.points[j].x, this.points[j].y);
      if (d < min) min = d;
    }
    return min;
  }

  draw(ctx, vp) {
    if (this.points.length < 2) return;
    ctx.beginPath();
    const p0 = vp.worldToScreen(this.points[0].x, this.points[0].y);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < this.points.length; i++) {
      const p = vp.worldToScreen(this.points[i].x, this.points[i].y);
      ctx.lineTo(p.x, p.y);
    }
    if (this.closed) ctx.closePath();
    ctx.stroke();
  }

  translate(dx, dy) {
    for (const p of this.points) { p.x += dx; p.y += dy; }
  }

  serialize() {
    return { ...super.serialize(), points: this.points, closed: this.closed };
  }
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

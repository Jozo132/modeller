// js/entities/Rectangle.js — Represented as a closed polyline of 4 line segments
import { Entity } from './Entity.js';

export class Rectangle extends Entity {
  constructor(x1, y1, x2, y2) {
    super('LWPOLYLINE'); // DXF stores as polyline
    this.x1 = Math.min(x1, x2); this.y1 = Math.min(y1, y2);
    this.x2 = Math.max(x1, x2); this.y2 = Math.max(y1, y2);
    this.closed = true;
  }

  get vertices() {
    return [
      { x: this.x1, y: this.y1 },
      { x: this.x2, y: this.y1 },
      { x: this.x2, y: this.y2 },
      { x: this.x1, y: this.y2 },
    ];
  }

  getBounds() {
    return { minX: this.x1, minY: this.y1, maxX: this.x2, maxY: this.y2 };
  }

  getSnapPoints() {
    const v = this.vertices;
    const snaps = v.map(p => ({ ...p, type: 'endpoint' }));
    // midpoints of edges
    for (let i = 0; i < v.length; i++) {
      const j = (i + 1) % v.length;
      snaps.push({ x: (v[i].x + v[j].x) / 2, y: (v[i].y + v[j].y) / 2, type: 'midpoint' });
    }
    // center
    snaps.push({ x: (this.x1 + this.x2) / 2, y: (this.y1 + this.y2) / 2, type: 'center' });
    return snaps;
  }

  distanceTo(px, py) {
    const v = this.vertices;
    let min = Infinity;
    for (let i = 0; i < v.length; i++) {
      const j = (i + 1) % v.length;
      const d = segDist(px, py, v[i].x, v[i].y, v[j].x, v[j].y);
      if (d < min) min = d;
    }
    return min;
  }

  draw(ctx, vp) {
    const v = this.vertices;
    ctx.beginPath();
    const p0 = vp.worldToScreen(v[0].x, v[0].y);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < v.length; i++) {
      const p = vp.worldToScreen(v[i].x, v[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  translate(dx, dy) {
    this.x1 += dx; this.y1 += dy;
    this.x2 += dx; this.y2 += dy;
  }

  serialize() {
    return { ...super.serialize(), x1: this.x1, y1: this.y1, x2: this.x2, y2: this.y2, closed: true };
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

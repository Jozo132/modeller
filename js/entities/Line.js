// js/entities/Line.js
import { Entity } from './Entity.js';

export class Line extends Entity {
  constructor(x1, y1, x2, y2) {
    super('LINE');
    this.x1 = x1; this.y1 = y1;
    this.x2 = x2; this.y2 = y2;
  }

  getBounds() {
    return {
      minX: Math.min(this.x1, this.x2),
      minY: Math.min(this.y1, this.y2),
      maxX: Math.max(this.x1, this.x2),
      maxY: Math.max(this.y1, this.y2),
    };
  }

  getSnapPoints() {
    const mx = (this.x1 + this.x2) / 2;
    const my = (this.y1 + this.y2) / 2;
    return [
      { x: this.x1, y: this.y1, type: 'endpoint' },
      { x: this.x2, y: this.y2, type: 'endpoint' },
      { x: mx, y: my, type: 'midpoint' },
    ];
  }

  distanceTo(px, py) {
    return pointToSegmentDist(px, py, this.x1, this.y1, this.x2, this.y2);
  }

  draw(ctx, vp) {
    const p1 = vp.worldToScreen(this.x1, this.y1);
    const p2 = vp.worldToScreen(this.x2, this.y2);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  translate(dx, dy) {
    this.x1 += dx; this.y1 += dy;
    this.x2 += dx; this.y2 += dy;
  }

  clone() {
    const c = super.clone();
    return c;
  }

  serialize() {
    return { ...super.serialize(), x1: this.x1, y1: this.y1, x2: this.x2, y2: this.y2 };
  }
}

function pointToSegmentDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

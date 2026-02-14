// js/cad/Segment.js — A line segment defined by two PPoint references
import { Primitive } from './Primitive.js';

export class PSegment extends Primitive {
  /**
   * @param {import('./Point.js').PPoint} p1
   * @param {import('./Point.js').PPoint} p2
   */
  constructor(p1, p2) {
    super('segment');
    this.p1 = p1;
    this.p2 = p2;
  }

  get x1() { return this.p1.x; }
  get y1() { return this.p1.y; }
  get x2() { return this.p2.x; }
  get y2() { return this.p2.y; }

  get length() { return Math.hypot(this.x2 - this.x1, this.y2 - this.y1); }

  get midX() { return (this.x1 + this.x2) / 2; }
  get midY() { return (this.y1 + this.y2) / 2; }

  getBounds() {
    return {
      minX: Math.min(this.x1, this.x2),
      minY: Math.min(this.y1, this.y2),
      maxX: Math.max(this.x1, this.x2),
      maxY: Math.max(this.y1, this.y2),
    };
  }

  getSnapPoints() {
    return [
      { x: this.x1, y: this.y1, type: 'endpoint' },
      { x: this.x2, y: this.y2, type: 'endpoint' },
      { x: this.midX, y: this.midY, type: 'midpoint' },
    ];
  }

  distanceTo(px, py) {
    return _ptSegDist(px, py, this.x1, this.y1, this.x2, this.y2);
  }

  draw(ctx, vp) {
    const a = vp.worldToScreen(this.x1, this.y1);
    const b = vp.worldToScreen(this.x2, this.y2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  translate(dx, dy) {
    this.p1.translate(dx, dy);
    this.p2.translate(dx, dy);
  }

  serialize() {
    return { ...super.serialize(), p1: this.p1.id, p2: this.p2.id };
  }
}

function _ptSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

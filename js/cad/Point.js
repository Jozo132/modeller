// js/cad/Point.js — A free 2D point, the fundamental building block
import { Primitive } from './Primitive.js';

export class PPoint extends Primitive {
  /**
   * @param {number} x
   * @param {number} y
   * @param {boolean} [fixed=false] — if true, the solver will not move this point
   */
  constructor(x, y, fixed = false) {
    super('point');
    this.x = x;
    this.y = y;
    this.fixed = fixed;
  }

  getBounds() { return { minX: this.x, minY: this.y, maxX: this.x, maxY: this.y }; }

  getSnapPoints() {
    return [{ x: this.x, y: this.y, type: 'endpoint' }];
  }

  distanceTo(px, py) { return Math.hypot(px - this.x, py - this.y); }

  draw(ctx, vp) {
    const s = vp.worldToScreen(this.x, this.y);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  translate(dx, dy) {
    if (!this.fixed) { this.x += dx; this.y += dy; }
  }

  clone() {
    const p = new PPoint(this.x, this.y, this.fixed);
    p.layer = this.layer;
    p.color = this.color;
    return p;
  }

  serialize() {
    return { ...super.serialize(), x: this.x, y: this.y, fixed: this.fixed };
  }
}

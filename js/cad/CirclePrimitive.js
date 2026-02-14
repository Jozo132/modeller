// js/cad/CirclePrimitive.js — A circle defined by a center PPoint and radius
import { Primitive } from './Primitive.js';

export class PCircle extends Primitive {
  /**
   * @param {import('./Point.js').PPoint} center
   * @param {number} radius
   */
  constructor(center, radius) {
    super('circle');
    this.center = center;
    this.radius = radius;
  }

  get cx() { return this.center.x; }
  get cy() { return this.center.y; }

  getBounds() {
    return {
      minX: this.cx - this.radius,
      minY: this.cy - this.radius,
      maxX: this.cx + this.radius,
      maxY: this.cy + this.radius,
    };
  }

  getSnapPoints() {
    return [
      { x: this.cx, y: this.cy, type: 'center' },
      { x: this.cx + this.radius, y: this.cy, type: 'quadrant' },
      { x: this.cx - this.radius, y: this.cy, type: 'quadrant' },
      { x: this.cx, y: this.cy + this.radius, type: 'quadrant' },
      { x: this.cx, y: this.cy - this.radius, type: 'quadrant' },
    ];
  }

  distanceTo(px, py) {
    return Math.abs(Math.hypot(px - this.cx, py - this.cy) - this.radius);
  }

  draw(ctx, vp) {
    const c = vp.worldToScreen(this.cx, this.cy);
    const r = this.radius * vp.zoom;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  translate(dx, dy) {
    this.center.translate(dx, dy);
  }

  serialize() {
    return { ...super.serialize(), center: this.center.id, radius: this.radius };
  }
}

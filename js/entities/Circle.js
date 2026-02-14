// js/entities/Circle.js
import { Entity } from './Entity.js';

export class Circle extends Entity {
  constructor(cx, cy, radius) {
    super('CIRCLE');
    this.cx = cx; this.cy = cy;
    this.radius = radius;
  }

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
    const d = Math.hypot(px - this.cx, py - this.cy);
    return Math.abs(d - this.radius);
  }

  draw(ctx, vp) {
    const c = vp.worldToScreen(this.cx, this.cy);
    const r = this.radius * vp.zoom;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  translate(dx, dy) {
    this.cx += dx; this.cy += dy;
  }

  serialize() {
    return { ...super.serialize(), cx: this.cx, cy: this.cy, radius: this.radius };
  }
}

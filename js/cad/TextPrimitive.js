// js/cad/TextPrimitive.js — Non-constraint text annotation
import { Primitive } from './Primitive.js';

export class TextPrimitive extends Primitive {
  constructor(x, y, text, height = 5) {
    super('text');
    this.x = x;
    this.y = y;
    this.text = text;
    this.height = height;
    this.rotation = 0;
  }

  getBounds() {
    const w = this.text.length * this.height * 0.6;
    return { minX: this.x, minY: this.y, maxX: this.x + w, maxY: this.y + this.height };
  }

  getSnapPoints() {
    return [{ x: this.x, y: this.y, type: 'endpoint' }];
  }

  distanceTo(px, py) {
    const b = this.getBounds();
    const cx = Math.max(b.minX, Math.min(px, b.maxX));
    const cy = Math.max(b.minY, Math.min(py, b.maxY));
    return Math.hypot(px - cx, py - cy);
  }

  draw(ctx, vp) {
    const p = vp.worldToScreen(this.x, this.y);
    const fontSize = Math.max(8, this.height * vp.zoom);
    ctx.save();
    ctx.font = `${fontSize}px 'Consolas', monospace`;
    ctx.textBaseline = 'bottom';
    if (this.rotation) {
      ctx.translate(p.x, p.y);
      ctx.rotate(-this.rotation * Math.PI / 180);
      ctx.fillText(this.text, 0, 0);
    } else {
      ctx.fillText(this.text, p.x, p.y);
    }
    ctx.restore();
  }

  translate(dx, dy) { this.x += dx; this.y += dy; }

  serialize() {
    return { ...super.serialize(), x: this.x, y: this.y, text: this.text, height: this.height, rotation: this.rotation };
  }
}

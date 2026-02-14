// js/entities/Dimension.js — Linear dimension
import { Entity } from './Entity.js';

export class Dimension extends Entity {
  constructor(x1, y1, x2, y2, offset = 10) {
    super('DIMENSION');
    this.x1 = x1; this.y1 = y1; // first point
    this.x2 = x2; this.y2 = y2; // second point
    this.offset = offset;        // offset distance from the line
  }

  get length() {
    return Math.hypot(this.x2 - this.x1, this.y2 - this.y1);
  }

  getBounds() {
    const pad = Math.abs(this.offset) + 5;
    return {
      minX: Math.min(this.x1, this.x2) - pad,
      minY: Math.min(this.y1, this.y2) - pad,
      maxX: Math.max(this.x1, this.x2) + pad,
      maxY: Math.max(this.y1, this.y2) + pad,
    };
  }

  getSnapPoints() {
    return [
      { x: this.x1, y: this.y1, type: 'endpoint' },
      { x: this.x2, y: this.y2, type: 'endpoint' },
    ];
  }

  distanceTo(px, py) {
    // Simplified — distance to the dimension line itself
    const dx = this.x2 - this.x1, dy = this.y2 - this.y1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return Math.hypot(px - this.x1, py - this.y1);
    const nx = -dy / len, ny = dx / len;
    const ox = nx * this.offset, oy = ny * this.offset;
    return segDist(px, py, this.x1 + ox, this.y1 + oy, this.x2 + ox, this.y2 + oy);
  }

  draw(ctx, vp) {
    const dx = this.x2 - this.x1, dy = this.y2 - this.y1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;

    const nx = -dy / len, ny = dx / len;
    const ox = nx * this.offset, oy = ny * this.offset;

    // Extension lines
    const p1 = vp.worldToScreen(this.x1, this.y1);
    const p2 = vp.worldToScreen(this.x2, this.y2);
    const d1 = vp.worldToScreen(this.x1 + ox, this.y1 + oy);
    const d2 = vp.worldToScreen(this.x2 + ox, this.y2 + oy);

    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y); ctx.lineTo(d1.x, d1.y);
    ctx.moveTo(p2.x, p2.y); ctx.lineTo(d2.x, d2.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Dimension line
    ctx.beginPath();
    ctx.moveTo(d1.x, d1.y); ctx.lineTo(d2.x, d2.y);
    ctx.stroke();

    // Arrows
    const arrowLen = 8;
    const angle = Math.atan2(d2.y - d1.y, d2.x - d1.x);
    drawArrow(ctx, d1.x, d1.y, angle, arrowLen);
    drawArrow(ctx, d2.x, d2.y, angle + Math.PI, arrowLen);

    // Text
    const mx = (d1.x + d2.x) / 2, my = (d1.y + d2.y) / 2;
    const text = len.toFixed(2);
    const fontSize = Math.max(10, 12);
    ctx.font = `${fontSize}px 'Consolas', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    ctx.save();
    ctx.translate(mx, my);
    let textAngle = angle;
    if (textAngle > Math.PI / 2 || textAngle < -Math.PI / 2) textAngle += Math.PI;
    ctx.rotate(textAngle);
    ctx.fillText(text, 0, -4);
    ctx.restore();

    ctx.restore();
  }

  translate(dx, dy) {
    this.x1 += dx; this.y1 += dy;
    this.x2 += dx; this.y2 += dy;
  }

  serialize() {
    return { ...super.serialize(), x1: this.x1, y1: this.y1, x2: this.x2, y2: this.y2, offset: this.offset };
  }
}

function drawArrow(ctx, x, y, angle, len) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - len * Math.cos(angle - 0.3), y - len * Math.sin(angle - 0.3));
  ctx.moveTo(x, y);
  ctx.lineTo(x - len * Math.cos(angle + 0.3), y - len * Math.sin(angle + 0.3));
  ctx.stroke();
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

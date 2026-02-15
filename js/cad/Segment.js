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
    if (this.construction) {
      const ct = this.constructionType || 'finite';
      if (ct === 'infinite-both') {
        return _ptLineDist(px, py, this.x1, this.y1, this.x2, this.y2);
      } else if (ct === 'infinite-start') {
        return _ptRayDist(px, py, this.x2, this.y2, this.x1, this.y1); // ray from p2 through p1
      } else if (ct === 'infinite-end') {
        return _ptRayDist(px, py, this.x1, this.y1, this.x2, this.y2); // ray from p1 through p2
      }
    }
    return _ptSegDist(px, py, this.x1, this.y1, this.x2, this.y2);
  }

  draw(ctx, vp) {
    if (this.construction) {
      const dx = this.x2 - this.x1;
      const dy = this.y2 - this.y1;
      const len = Math.hypot(dx, dy);
      if (len < 1e-12) return;
      const ux = dx / len, uy = dy / len;
      const ext = Math.max(vp.width, vp.height) / vp.zoom * 2;
      const ct = this.constructionType || 'finite';
      let ax, ay, bx, by;
      if (ct === 'infinite-both') {
        ax = this.x1 - ux * ext; ay = this.y1 - uy * ext;
        bx = this.x2 + ux * ext; by = this.y2 + uy * ext;
      } else if (ct === 'infinite-start') {
        ax = this.x1 - ux * ext; ay = this.y1 - uy * ext;
        bx = this.x2; by = this.y2;
      } else if (ct === 'infinite-end') {
        ax = this.x1; ay = this.y1;
        bx = this.x2 + ux * ext; by = this.y2 + uy * ext;
      } else { // finite
        ax = this.x1; ay = this.y1;
        bx = this.x2; by = this.y2;
      }
      const a = vp.worldToScreen(ax, ay);
      const b = vp.worldToScreen(bx, by);
      ctx.save();
      ctx.setLineDash([12, 4, 2, 4]); // dash-dot pattern
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    } else {
      const a = vp.worldToScreen(this.x1, this.y1);
      const b = vp.worldToScreen(this.x2, this.y2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
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

/** Distance from point to infinite line through (ax,ay)-(bx,by) */
function _ptLineDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  // perpendicular distance = |cross| / len
  const cross = Math.abs((px - ax) * dy - (py - ay) * dx);
  return cross / Math.sqrt(lenSq);
}

/** Distance from point to ray starting at (ax,ay) going through (bx,by) and beyond */
function _ptRayDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, t); // clamp at ray origin, no upper bound
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

import { Primitive } from './Primitive.js';

export class GroupPrimitive extends Primitive {
  constructor(childIds = [], options = {}) {
    super('group');
    this.name = options.name || 'Group';
    this.childIds = [...new Set(childIds.filter((id) => Number.isFinite(id)))];
    this.immutable = options.immutable === true;
    this.sourceGroupId = Number.isFinite(options.sourceGroupId) ? options.sourceGroupId : null;
    this.expanded = options.expanded !== false;
    this._resolver = null;
  }

  setResolver(resolver) {
    this._resolver = typeof resolver === 'function' ? resolver : null;
  }

  getChildren() {
    return this._resolver ? this.childIds.map((id) => this._resolver(id)).filter(Boolean) : [];
  }

  containsId(id) {
    return this.childIds.includes(id);
  }

  getBounds() {
    const children = this.getChildren().filter((child) => child && child.visible !== false && typeof child.getBounds === 'function');
    if (children.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const child of children) {
      const b = child.getBounds();
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }
    return { minX, minY, maxX, maxY };
  }

  getSnapPoints() {
    return this.getChildren().flatMap((child) => typeof child.getSnapPoints === 'function' ? child.getSnapPoints() : []);
  }

  distanceTo(px, py) {
    let best = Infinity;
    for (const child of this.getChildren()) {
      if (child && child.visible !== false && typeof child.distanceTo === 'function') {
        best = Math.min(best, child.distanceTo(px, py));
      }
    }
    return best;
  }

  translate(dx, dy) {
    const movedPoints = new Set();
    for (const child of this.getChildren()) {
      if (child?.type === 'segment') {
        for (const point of [child.p1, child.p2]) {
          if (!movedPoints.has(point)) {
            point.translate(dx, dy);
            movedPoints.add(point);
          }
        }
      } else if (child?.type === 'circle' || child?.type === 'arc') {
        if (!movedPoints.has(child.center)) {
          child.center.translate(dx, dy);
          movedPoints.add(child.center);
        }
      } else if (child?.type === 'spline') {
        for (const point of child.points) {
          if (!movedPoints.has(point)) {
            point.translate(dx, dy);
            movedPoints.add(point);
          }
        }
      } else if (child?.type === 'bezier') {
        for (const point of child.points) {
          if (!movedPoints.has(point)) {
            point.translate(dx, dy);
            movedPoints.add(point);
          }
        }
      } else if (child && typeof child.translate === 'function') {
        child.translate(dx, dy);
      }
    }
  }

  serialize() {
    return {
      ...super.serialize(),
      name: this.name,
      childIds: [...this.childIds],
      immutable: this.immutable,
      sourceGroupId: this.sourceGroupId,
      expanded: this.expanded,
    };
  }
}

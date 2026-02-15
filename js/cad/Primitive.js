// js/cad/Primitive.js — Base class for all geometric primitives
let _nextId = 1;

/** Reset ID counter (new file / tests) */
export function resetPrimitiveIds(v = 1) { _nextId = v; }
/** Get the next ID that will be assigned */
export function peekNextPrimitiveId() { return _nextId; }

export class Primitive {
  constructor(type) {
    this.id = _nextId++;
    this.type = type;       // 'point' | 'segment' | 'arc' | 'circle'
    this.layer = '0';
    this.color = null;      // null = ByLayer
    this.lineWidth = 1;
    this.selected = false;
    this.visible = true;
    this.construction = false; // construction geometry — dashed, light green, excluded from DXF/fill
    this.constructionType = 'finite'; // 'finite' | 'infinite-start' | 'infinite-end' | 'infinite-both'
    this.constructionDash = 'dashed'; // 'dashed' | 'dash-dot' | 'dotted'
  }

  /** Axis-aligned bounding box */
  getBounds() { return { minX: 0, minY: 0, maxX: 0, maxY: 0 }; }

  /** Return snap points [{x, y, type}] */
  getSnapPoints() { return []; }

  /** Distance from world point to this primitive */
  distanceTo(px, py) { return Infinity; }

  /** Draw on canvas */
  draw(ctx, vp) {}

  /** Translate by (dx, dy) */
  translate(dx, dy) {}

  /** Serialise to plain object */
  serialize() {
    const o = { id: this.id, type: this.type, layer: this.layer, color: this.color };
    if (this.construction) {
      o.construction = true;
      if (this.constructionType !== 'finite') o.constructionType = this.constructionType;
      if (this.constructionDash !== 'dashed') o.constructionDash = this.constructionDash;
    }
    return o;
  }
}

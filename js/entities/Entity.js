// js/entities/Entity.js — Base entity class
let nextId = 1;

export class Entity {
  constructor(type) {
    this.id = nextId++;
    this.type = type;
    this.layer = '0';
    this.color = null;       // null = ByLayer
    this.lineWidth = 1;
    this.lineType = 'CONTINUOUS';
    this.selected = false;
    this.visible = true;
  }

  /** Return axis-aligned bounding box {minX, minY, maxX, maxY} */
  getBounds() { return { minX: 0, minY: 0, maxX: 0, maxY: 0 }; }

  /** Return snap points [{x, y, type}] */
  getSnapPoints() { return []; }

  /** Hit test — distance from point to entity */
  distanceTo(px, py) { return Infinity; }

  /** Draw entity on canvas context */
  draw(ctx, viewport) {}

  /** Deep clone */
  clone() {
    const copy = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    copy.id = nextId++;
    copy.selected = false;
    return copy;
  }

  /** Translate entity by dx, dy */
  translate(dx, dy) {}

  /** Serialise to plain object for DXF / JSON */
  serialize() { return { type: this.type, layer: this.layer, color: this.color }; }
}

/** Reset id counter (for tests / new file) */
export function resetEntityIds() { nextId = 1; }

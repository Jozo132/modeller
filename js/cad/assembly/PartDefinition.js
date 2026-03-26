// js/cad/assembly/PartDefinition.js — Part definition (template/prototype)
//
// A PartDefinition holds the geometry, material, and metadata for a part type.
// Multiple PartInstances can reference the same definition.

let _defIdCounter = 0;

/**
 * PartDefinition — template for a part type.
 *
 * Holds geometry description (bounding box, reference features) and metadata
 * (name, material, mass). Instances reference a definition by its id.
 */
export class PartDefinition {
  /**
   * @param {Object} opts
   * @param {string} [opts.name]        - Human-readable name
   * @param {Object} [opts.boundingBox] - { min: {x,y,z}, max: {x,y,z} }
   * @param {string} [opts.material]    - Material name
   * @param {number} [opts.mass]        - Mass in kg (0 = auto-calculate)
   * @param {Object} [opts.geometry]    - Arbitrary geometry payload
   */
  constructor(opts = {}) {
    this.id = `partdef_${++_defIdCounter}`;
    this.name = opts.name || 'Part';
    this.boundingBox = opts.boundingBox || null;
    this.material = opts.material || 'default';
    this.mass = opts.mass ?? 0;
    this.geometry = opts.geometry || null;
    this.created = new Date();
    this.modified = new Date();
  }

  /**
   * Set or update the bounding box.
   * @param {{x:number,y:number,z:number}} min
   * @param {{x:number,y:number,z:number}} max
   */
  setBoundingBox(min, max) {
    this.boundingBox = { min: { ...min }, max: { ...max } };
    this.modified = new Date();
  }

  serialize() {
    return {
      type: 'PartDefinition',
      id: this.id,
      name: this.name,
      boundingBox: this.boundingBox,
      material: this.material,
      mass: this.mass,
      geometry: this.geometry,
      created: this.created.toISOString(),
      modified: this.modified.toISOString(),
    };
  }

  static deserialize(data) {
    const def = new PartDefinition({
      name: data.name,
      boundingBox: data.boundingBox,
      material: data.material,
      mass: data.mass,
      geometry: data.geometry,
    });
    if (data.id) def.id = data.id;
    if (data.created) def.created = new Date(data.created);
    if (data.modified) def.modified = new Date(data.modified);
    return def;
  }
}

/**
 * Reset the definition ID counter (for tests).
 */
export function resetPartDefinitionIds() {
  _defIdCounter = 0;
}

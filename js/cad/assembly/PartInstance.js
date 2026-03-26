// js/cad/assembly/PartInstance.js — Placed instance of a PartDefinition
//
// Each PartInstance references a PartDefinition and carries a world transform.

import { identity } from './Transform3D.js';

let _instIdCounter = 0;

/**
 * PartInstance — a placed occurrence of a PartDefinition inside an Assembly.
 */
export class PartInstance {
  /**
   * @param {import('./PartDefinition.js').PartDefinition} definition
   * @param {Object} [opts]
   * @param {string}       [opts.name]      - Instance label (defaults to definition name)
   * @param {Float64Array} [opts.transform] - 4×4 world transform (identity if omitted)
   * @param {boolean}      [opts.grounded]  - True if this instance is fixed in space
   * @param {boolean}      [opts.visible]   - Visibility flag
   */
  constructor(definition, opts = {}) {
    this.id = `partinst_${++_instIdCounter}`;
    this.definitionId = definition.id;
    this.definition = definition;
    this.name = opts.name || definition.name;
    this.transform = opts.transform ? new Float64Array(opts.transform) : identity();
    this.grounded = opts.grounded ?? false;
    this.visible = opts.visible ?? true;
  }

  /**
   * Replace the world transform.
   * @param {Float64Array} t
   */
  setTransform(t) {
    this.transform = new Float64Array(t);
  }

  serialize() {
    return {
      type: 'PartInstance',
      id: this.id,
      definitionId: this.definitionId,
      name: this.name,
      transform: Array.from(this.transform),
      grounded: this.grounded,
      visible: this.visible,
    };
  }

  static deserialize(data, definitionMap) {
    const def = definitionMap.get(data.definitionId);
    if (!def) throw new Error(`PartDefinition not found: ${data.definitionId}`);
    const inst = new PartInstance(def, {
      name: data.name,
      transform: new Float64Array(data.transform),
      grounded: data.grounded,
      visible: data.visible,
    });
    if (data.id) inst.id = data.id;
    return inst;
  }
}

/**
 * Reset instance ID counter (for tests).
 */
export function resetPartInstanceIds() {
  _instIdCounter = 0;
}

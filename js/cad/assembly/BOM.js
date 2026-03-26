// js/cad/assembly/BOM.js — Bill of Materials roll-up
//
// Generates a BOM from an Assembly's definitions and instances.
// Each BOM entry lists a part definition, quantity (instance count), and
// aggregate properties (total mass, material).

/**
 * @typedef {Object} BOMEntry
 * @property {string} definitionId
 * @property {string} name
 * @property {string} material
 * @property {number} massEach   - Mass per unit
 * @property {number} quantity   - Number of instances
 * @property {number} totalMass  - massEach × quantity
 * @property {string[]} instanceIds - IDs of the instances using this definition
 */

/**
 * Generate a Bill of Materials from an assembly.
 *
 * Groups instances by their definition and aggregates quantities.
 *
 * @param {import('./PartDefinition.js').PartDefinition[]} definitions
 * @param {import('./PartInstance.js').PartInstance[]}       instances
 * @returns {BOMEntry[]}
 */
export function generateBOM(definitions, instances) {
  const defMap = new Map();
  for (const def of definitions) defMap.set(def.id, def);

  // Group instances by definitionId
  const groups = new Map();
  for (const inst of instances) {
    if (!groups.has(inst.definitionId)) {
      groups.set(inst.definitionId, []);
    }
    groups.get(inst.definitionId).push(inst);
  }

  const bom = [];
  for (const [defId, insts] of groups) {
    const def = defMap.get(defId);
    if (!def) continue;
    bom.push({
      definitionId: defId,
      name: def.name,
      material: def.material,
      massEach: def.mass,
      quantity: insts.length,
      totalMass: def.mass * insts.length,
      instanceIds: insts.map(i => i.id),
    });
  }

  // Sort by name for deterministic output
  bom.sort((a, b) => a.name.localeCompare(b.name));
  return bom;
}

/**
 * Compute aggregate BOM statistics.
 *
 * @param {BOMEntry[]} bom
 * @returns {{ totalParts: number, uniqueParts: number, totalMass: number }}
 */
export function bomSummary(bom) {
  let totalParts = 0;
  let totalMass = 0;
  for (const entry of bom) {
    totalParts += entry.quantity;
    totalMass += entry.totalMass;
  }
  return {
    totalParts,
    uniqueParts: bom.length,
    totalMass,
  };
}

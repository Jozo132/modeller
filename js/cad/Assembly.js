// js/cad/Assembly.js — Assembly design: multi-part assembly with mate constraints
//
// Supports:
//   - Part definitions and instances (definition/instance split)
//   - Insert part / place-instance workflows
//   - Five mate types: coincident, concentric, distance, angle, planar
//   - Deterministic hybrid solver (grounded + spanning-tree + loop correction)
//   - DOF diagnostics (under/over-constrained detection)
//   - AABB broadphase collision detection
//   - BOM roll-up

import { PartDefinition } from './assembly/PartDefinition.js';
import { PartInstance } from './assembly/PartInstance.js';
import { Mate } from './assembly/Mate.js';
import { solveAssembly } from './assembly/AssemblySolver.js';
import { broadphaseCollisions, clearanceQuery } from './assembly/CollisionDetection.js';
import { generateBOM, bomSummary } from './assembly/BOM.js';
import { identity, fromTranslation } from './assembly/Transform3D.js';

/**
 * Assembly — collection of part instances constrained by mates.
 */
export class Assembly {
  constructor(name = 'Assembly1') {
    this.name = name;
    this.description = '';
    this.created = new Date();
    this.modified = new Date();

    /** @type {Map<string, PartDefinition>} */
    this.definitions = new Map();

    /** @type {PartInstance[]} */
    this.instances = [];

    /** @type {Mate[]} */
    this.mates = [];

    /** Last solver result (populated after solve()) */
    this._solverResult = null;
  }

  // ── Definition management ─────────────────────────────────────────

  /**
   * Register a part definition in the assembly.
   * @param {PartDefinition} def
   * @returns {PartDefinition}
   */
  addDefinition(def) {
    this.definitions.set(def.id, def);
    this.modified = new Date();
    return def;
  }

  /**
   * Get a definition by ID.
   * @param {string} id
   * @returns {PartDefinition|undefined}
   */
  getDefinition(id) {
    return this.definitions.get(id);
  }

  // ── Instance management (insert / place) ──────────────────────────

  /**
   * Insert a part into the assembly by creating a new instance of a definition.
   * @param {PartDefinition} definition
   * @param {Object} [opts]
   * @param {string}       [opts.name]
   * @param {Float64Array} [opts.transform]
   * @param {boolean}      [opts.grounded]
   * @returns {PartInstance}
   */
  insertPart(definition, opts = {}) {
    if (!this.definitions.has(definition.id)) {
      this.addDefinition(definition);
    }
    const inst = new PartInstance(definition, opts);
    this.instances.push(inst);
    this.modified = new Date();
    return inst;
  }

  /**
   * Place an instance at a specific transform.
   * @param {PartInstance} instance
   * @param {Float64Array} transform - 4×4 world transform
   */
  placeInstance(instance, transform) {
    instance.setTransform(transform);
    this.modified = new Date();
  }

  /**
   * Remove an instance from the assembly.
   * Also removes any mates referencing it.
   * @param {string} instanceId
   */
  removeInstance(instanceId) {
    this.instances = this.instances.filter(i => i.id !== instanceId);
    this.mates = this.mates.filter(
      m => m.instanceA !== instanceId && m.instanceB !== instanceId,
    );
    this.modified = new Date();
  }

  /**
   * Get an instance by ID.
   * @param {string} id
   * @returns {PartInstance|undefined}
   */
  getInstance(id) {
    return this.instances.find(i => i.id === id);
  }

  // ── Mate management ───────────────────────────────────────────────

  /**
   * Add a mate constraint between two instances.
   * @param {Mate} mate
   * @returns {Mate}
   */
  addMate(mate) {
    this.mates.push(mate);
    this.modified = new Date();
    return mate;
  }

  /**
   * Remove a mate by ID.
   * @param {string} mateId
   */
  removeMate(mateId) {
    this.mates = this.mates.filter(m => m.id !== mateId);
    this.modified = new Date();
  }

  // ── Solver ────────────────────────────────────────────────────────

  /**
   * Solve all mates and update instance transforms in place.
   * Returns the full solver result including diagnostics.
   * Note: this mutates instance transforms. To inspect results without
   * mutation, call solveAssembly(this.instances, this.mates, opts) directly.
   * @param {Object} [opts] - Solver options (maxIterations, tolerance)
   * @returns {import('./assembly/AssemblySolver.js').SolverResult}
   */
  solve(opts) {
    const result = solveAssembly(this.instances, this.mates, opts);
    this._solverResult = result;

    // Apply solved transforms back to instances
    for (const inst of this.instances) {
      if (result.transforms.has(inst.id)) {
        inst.setTransform(result.transforms.get(inst.id));
      }
    }
    return result;
  }

  // ── Collision detection ───────────────────────────────────────────

  /**
   * Run broadphase collision detection.
   * @returns {Array<{ a: string, b: string, clearance: Object }>}
   */
  detectCollisions() {
    return broadphaseCollisions(this.instances);
  }

  /**
   * Query clearances between all instance pairs.
   * @returns {Array<{ a: string, b: string, clearance: Object }>}
   */
  queryClearances() {
    return clearanceQuery(this.instances);
  }

  // ── BOM ───────────────────────────────────────────────────────────

  /**
   * Generate Bill of Materials.
   * @returns {import('./assembly/BOM.js').BOMEntry[]}
   */
  generateBOM() {
    return generateBOM(Array.from(this.definitions.values()), this.instances);
  }

  /**
   * Get BOM summary statistics.
   * @returns {{ totalParts: number, uniqueParts: number, totalMass: number }}
   */
  getBOMSummary() {
    return bomSummary(this.generateBOM());
  }

  // ── Serialization ─────────────────────────────────────────────────

  serialize() {
    return {
      type: 'Assembly',
      name: this.name,
      description: this.description,
      created: this.created.toISOString(),
      modified: this.modified.toISOString(),
      definitions: Array.from(this.definitions.values()).map(d => d.serialize()),
      instances: this.instances.map(i => i.serialize()),
      mates: this.mates.map(m => m.serialize()),
    };
  }

  static deserialize(data) {
    const asm = new Assembly(data.name);
    asm.description = data.description || '';
    asm.created = data.created ? new Date(data.created) : new Date();
    asm.modified = data.modified ? new Date(data.modified) : new Date();

    // Definitions
    const defMap = new Map();
    if (data.definitions) {
      for (const d of data.definitions) {
        const def = PartDefinition.deserialize(d);
        asm.definitions.set(def.id, def);
        defMap.set(def.id, def);
      }
    }

    // Instances
    if (data.instances) {
      for (const i of data.instances) {
        const inst = PartInstance.deserialize(i, defMap);
        asm.instances.push(inst);
      }
    }

    // Mates
    if (data.mates) {
      for (const m of data.mates) {
        asm.mates.push(Mate.deserialize(m));
      }
    }

    return asm;
  }
}

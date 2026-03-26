// js/cad/assembly/AssemblySolver.js — Deterministic hybrid constraint solver
//
// Algorithm:
//   1. Build a mate graph (instances = nodes, mates = edges).
//   2. Identify grounded (fixed) instances.
//   3. BFS from grounded nodes to build a spanning tree.
//   4. Traverse tree edges: for each mate, solve the child's transform.
//   5. For back-edges (cycles): run bounded iterative correction.
//   6. Produce DOF diagnostics for each instance.

import { identity, transformsEqual } from './Transform3D.js';
import { solveMate, mateResidual } from './Mate.js';

// ── Diagnostic types ────────────────────────────────────────────────

/**
 * @typedef {Object} SolverDiagnostics
 * @property {'ok'|'under-constrained'|'over-constrained'|'mixed'} status
 * @property {number}   totalDOF        - Sum of remaining DOF across all instances
 * @property {number}   maxResidual     - Largest mate residual after solving
 * @property {Array}    instanceDOF     - Per-instance DOF info
 * @property {Array}    unsatisfied     - Mates with residual > tolerance
 * @property {string[]} disconnected    - Instance IDs not reachable from grounded
 */

/**
 * @typedef {Object} SolverResult
 * @property {Map<string,Float64Array>} transforms  - instance ID → world transform
 * @property {SolverDiagnostics}        diagnostics
 */

// ── Solver ──────────────────────────────────────────────────────────

/**
 * Solve assembly constraints deterministically.
 *
 * @param {import('./PartInstance.js').PartInstance[]} instances
 * @param {import('./Mate.js').Mate[]}                 mates
 * @param {Object} [opts]
 * @param {number} [opts.maxIterations=20]    - Max loop-correction iterations
 * @param {number} [opts.tolerance=1e-9]      - Residual convergence tolerance
 * @returns {SolverResult}
 */
export function solveAssembly(instances, mates, opts = {}) {
  const maxIter = opts.maxIterations ?? 20;
  const tol     = opts.tolerance ?? 1e-9;

  // Instance map: id → instance
  const instMap = new Map();
  for (const inst of instances) instMap.set(inst.id, inst);

  // Working transforms (keyed by instance ID)
  const transforms = new Map();
  for (const inst of instances) {
    transforms.set(inst.id, new Float64Array(inst.transform));
  }

  // ── 1. Build adjacency list ───────────────────────────────────────
  const adj = new Map();
  for (const inst of instances) adj.set(inst.id, []);
  for (const m of mates) {
    if (!adj.has(m.instanceA) || !adj.has(m.instanceB)) continue;
    adj.get(m.instanceA).push({ mate: m, neighbor: m.instanceB, direction: 'A→B' });
    adj.get(m.instanceB).push({ mate: m, neighbor: m.instanceA, direction: 'B→A' });
  }

  // ── 2. Find grounded instances ────────────────────────────────────
  const grounded = new Set();
  for (const inst of instances) {
    if (inst.grounded) grounded.add(inst.id);
  }
  // If nothing is grounded, ground the first instance
  if (grounded.size === 0 && instances.length > 0) {
    grounded.add(instances[0].id);
  }

  // ── 3. BFS spanning tree ──────────────────────────────────────────
  const visited = new Set();
  const treeEdges = [];  // ordered list of { mate, parentId, childId }
  const backEdges = [];  // cycle-closing mates
  const queue = [];

  for (const gId of grounded) {
    visited.add(gId);
    queue.push(gId);
  }

  while (queue.length > 0) {
    const cur = queue.shift();
    for (const { mate, neighbor, direction } of (adj.get(cur) || [])) {
      if (visited.has(neighbor)) {
        // Possible back-edge — record only once
        const edgeKey = [mate.instanceA, mate.instanceB].sort().join('|') + '|' + mate.id;
        if (!backEdges.some(e => e._key === edgeKey) &&
            !treeEdges.some(e => e.mate.id === mate.id)) {
          backEdges.push({ ...{ mate, parentId: cur, childId: neighbor }, _key: edgeKey });
        }
        continue;
      }
      visited.add(neighbor);
      queue.push(neighbor);
      treeEdges.push({
        mate,
        parentId: cur,
        childId: neighbor,
      });
    }
  }

  // ── 4. Tree-edge placement ────────────────────────────────────────
  for (const { mate, parentId, childId } of treeEdges) {
    if (grounded.has(childId)) continue; // never move grounded parts

    const tA = transforms.get(mate.instanceA);
    const tB = transforms.get(mate.instanceB);
    const solved = solveMate(mate, tA, tB);

    // The child is the one being moved
    if (mate.instanceB === childId) {
      transforms.set(childId, solved);
    } else {
      // mate.instanceA is the child — need to solve inversely
      // Re-solve with swapped roles isn't trivial; use the direct solver
      // and swap the direction by calling solveMate(mate, tB, tA) then assign to child
      // Actually: if parentId is instanceB, we need to recompute for instanceA
      const solvedA = solveMate(
        _swapMate(mate),
        transforms.get(parentId),
        transforms.get(childId),
      );
      transforms.set(childId, solvedA);
    }
  }

  // ── 5. Back-edge iterative correction ─────────────────────────────
  for (let iter = 0; iter < maxIter; iter++) {
    let maxRes = 0;
    for (const { mate } of backEdges) {
      const tA = transforms.get(mate.instanceA);
      const tB = transforms.get(mate.instanceB);
      const res = mateResidual(mate, tA, tB);
      maxRes = Math.max(maxRes, res);

      if (res > tol) {
        // Correct the non-grounded side
        const moveB = !grounded.has(mate.instanceB);
        const moveA = !grounded.has(mate.instanceA);
        if (moveB) {
          transforms.set(mate.instanceB, solveMate(mate, tA, tB));
        } else if (moveA) {
          const swapped = _swapMate(mate);
          transforms.set(mate.instanceA, solveMate(swapped, tB, tA));
        }
        // If both grounded, cannot fix → over-constrained
      }
    }
    if (maxRes <= tol) break;
  }

  // ── 6. Diagnostics ────────────────────────────────────────────────
  const disconnected = [];
  for (const inst of instances) {
    if (!visited.has(inst.id) && !grounded.has(inst.id)) {
      disconnected.push(inst.id);
    }
  }

  // Per-instance DOF
  const dofMap = new Map();
  for (const inst of instances) {
    dofMap.set(inst.id, inst.grounded ? 0 : 6);
  }
  for (const m of mates) {
    if (dofMap.has(m.instanceB) && !instMap.get(m.instanceB)?.grounded) {
      dofMap.set(m.instanceB, Math.max(0, dofMap.get(m.instanceB) - m.dofRemoved));
    }
  }
  const instanceDOF = instances.map(inst => ({
    id: inst.id,
    name: inst.name,
    dof: dofMap.get(inst.id),
    grounded: inst.grounded || grounded.has(inst.id),
  }));

  // Check unsatisfied mates
  const unsatisfied = [];
  let maxResidual = 0;
  for (const m of mates) {
    const res = mateResidual(m, transforms.get(m.instanceA), transforms.get(m.instanceB));
    maxResidual = Math.max(maxResidual, res);
    if (res > tol) {
      unsatisfied.push({ mateId: m.id, mateType: m.type, residual: res });
    }
  }

  const totalDOF = instanceDOF.reduce((s, d) => s + d.dof, 0);

  let status = 'ok';
  if (disconnected.length > 0 || totalDOF > 0) status = 'under-constrained';
  if (unsatisfied.length > 0) {
    status = status === 'under-constrained' ? 'mixed' : 'over-constrained';
  }

  return {
    transforms,
    diagnostics: {
      status,
      totalDOF,
      maxResidual,
      instanceDOF,
      unsatisfied,
      disconnected,
    },
  };
}

// ── Swap helper ─────────────────────────────────────────────────────

/** Create a virtual mate with A↔B swapped. */
function _swapMate(mate) {
  return {
    type: mate.type,
    instanceA: mate.instanceB,
    instanceB: mate.instanceA,
    featureA: mate.featureB,
    featureB: mate.featureA,
    value: mate.value,
    get dofRemoved() { return mate.dofRemoved; },
  };
}

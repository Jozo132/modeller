// js/cad/Solver.js — Iterative Gauss-Seidel constraint solver

const MIN_RELAXATION = 1 / 64;

/**
 * Solve all constraints iteratively until convergence.
 *
 * Instead of applying each constraint directly onto the already-mutated state,
 * collect each constraint's proposed correction from the same starting geometry
 * for the iteration and blend those corrections together. This keeps newly
 * added constraints from immediately destroying other constraints elsewhere in
 * the same profile/chain.
 *
 * @param {import('./Constraint.js').Constraint[]} constraints
 * @param {object} [opts]
 * @param {number} [opts.maxIter=200]    — max relaxation iterations
 * @param {number} [opts.tolerance=1e-6] — max acceptable residual
 * @param {number} [opts.relaxation=0.8] — initial blended correction factor
 * @returns {{ converged: boolean, iterations: number, maxError: number }}
 */
export function solve(constraints, { maxIter = 200, tolerance = 1e-6, relaxation = 0.8 } = {}) {
  if (constraints.length === 0) return { converged: true, iterations: 0, maxError: 0 };

  const allTargets = _collectSolveTargets(constraints);
  let bestState = _snapshotTargets(allTargets);
  let bestError = _maxConstraintError(constraints);
  if (bestError <= tolerance) {
    return { converged: true, iterations: 0, maxError: bestError };
  }

  for (let i = 0; i < maxIter; i++) {
    const maxError = _maxConstraintError(constraints);
    if (maxError <= tolerance) {
      return { converged: true, iterations: i, maxError };
    }

    const proposals = _collectConstraintProposals(constraints, tolerance);
    if (proposals.size === 0) break;

    const startState = _snapshotTargets(allTargets);
    let applied = false;
    let nextError = maxError;
    let factor = Math.max(MIN_RELAXATION, Math.min(1, relaxation));

    while (factor >= MIN_RELAXATION) {
      _restoreTargets(startState);
      const magnitude = _applyProposalDeltas(proposals, factor);
      if (magnitude <= 1e-12) break;
      nextError = _maxConstraintError(constraints);
      if (Number.isFinite(nextError) && nextError <= maxError + tolerance) {
        applied = true;
        break;
      }
      factor *= 0.5;
    }

    if (!applied) {
      _restoreTargets(bestState);
      return { converged: bestError <= tolerance, iterations: i + 1, maxError: bestError };
    }

    if (nextError < bestError) {
      bestError = nextError;
      bestState = _snapshotTargets(allTargets);
    }
    if (nextError <= tolerance) {
      return { converged: true, iterations: i + 1, maxError: nextError };
    }
  }

  _restoreTargets(bestState);
  return { converged: bestError <= tolerance, iterations: maxIter, maxError: bestError };
}

function _maxConstraintError(constraints) {
  let maxError = 0;
  for (const constraint of constraints) {
    const err = Number(constraint?.error?.());
    if (!Number.isFinite(err)) return Number.POSITIVE_INFINITY;
    if (err > maxError) maxError = err;
  }
  return maxError;
}

function _collectConstraintProposals(constraints, tolerance) {
  const proposals = new Map();
  for (const constraint of constraints) {
    const err = Number(constraint?.error?.());
    if (!Number.isFinite(err) || err <= tolerance) continue;

    const targets = _collectConstraintTargets(constraint);
    if (targets.length === 0) continue;

    const before = _snapshotTargets(targets);
    constraint.apply();
    const after = _snapshotTargets(targets);
    _restoreTargets(before);

    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      const delta = after.values[index] - before.values[index];
      if (!Number.isFinite(delta) || Math.abs(delta) <= 1e-12) continue;
      const entry = proposals.get(target.key);
      if (entry) {
        entry.delta += delta;
        entry.count += 1;
      } else {
        proposals.set(target.key, { ...target, delta, count: 1 });
      }
    }
  }
  return proposals;
}

function _applyProposalDeltas(proposals, factor) {
  let magnitude = 0;
  for (const proposal of proposals.values()) {
    const delta = (proposal.delta / proposal.count) * factor;
    proposal.owner[proposal.prop] += delta;
    magnitude += Math.abs(delta);
  }
  return magnitude;
}

function _collectSolveTargets(constraints) {
  const targets = new Map();
  for (const constraint of constraints) {
    for (const target of _collectConstraintTargets(constraint)) {
      targets.set(target.key, target);
    }
  }
  return [...targets.values()];
}

function _collectConstraintTargets(constraint) {
  const targets = new Map();
  const addPoint = (point) => {
    if (!point) return;
    const base = _targetObjectId(point);
    targets.set(`${base}:x`, { key: `${base}:x`, owner: point, prop: 'x' });
    targets.set(`${base}:y`, { key: `${base}:y`, owner: point, prop: 'y' });
  };
  const addRadius = (shape) => {
    if (!shape || typeof shape.radius !== 'number') return;
    const base = _targetObjectId(shape);
    targets.set(`${base}:radius`, { key: `${base}:radius`, owner: shape, prop: 'radius' });
  };

  if (typeof constraint?.involvedPoints === 'function') {
    for (const point of constraint.involvedPoints()) addPoint(point);
  }
  addRadius(constraint?.shape);
  addRadius(constraint?.circle);

  return [...targets.values()];
}

function _restoreTargets(snapshot) {
  for (let index = 0; index < snapshot.targets.length; index++) {
    snapshot.targets[index].owner[snapshot.targets[index].prop] = snapshot.values[index];
  }
}

function _snapshotTargets(targets) {
  return { targets, values: targets.map((target) => target.owner[target.prop]) };
}

const _targetIds = new WeakMap();
let _nextTargetId = 1;

function _targetObjectId(object) {
  let id = _targetIds.get(object);
  if (id == null) {
    id = _nextTargetId++;
    _targetIds.set(object, id);
  }
  return id;
}

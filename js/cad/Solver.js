// js/cad/Solver.js — Iterative Gauss-Seidel constraint solver

/**
 * Solve all constraints iteratively until convergence.
 *
 * @param {import('./Constraint.js').Constraint[]} constraints
 * @param {object} [opts]
 * @param {number} [opts.maxIter=200]    — max relaxation iterations
 * @param {number} [opts.tolerance=1e-6] — max acceptable residual
 * @param {number} [opts.relaxation=1]   — damping factor for each constraint application
 * @returns {{ converged: boolean, iterations: number, maxError: number }}
 */
export function solve(constraints, { maxIter = 200, tolerance = 1e-6, relaxation = 1 } = {}) {
  if (constraints.length === 0) return { converged: true, iterations: 0, maxError: 0 };

  const allTargets = _collectSolveTargets(constraints);
  let bestState = _snapshotTargets(allTargets);
  let bestError = _maxConstraintError(constraints);
  if (bestError <= tolerance) {
    return { converged: true, iterations: 0, maxError: bestError };
  }

  const factor = Math.max(0, Math.min(1, relaxation));
  let iterations = 0;

  for (let i = 0; i < maxIter; i++) {
    iterations = i + 1;
    let appliedAny = false;

    for (const constraint of constraints) {
      const err = Number(constraint?.error?.());
      if (!Number.isFinite(err)) {
        _restoreTargets(bestState);
        return { converged: bestError <= tolerance, iterations, maxError: bestError };
      }
      if (err <= tolerance) continue;
      if (_applyConstraint(constraint, factor)) {
        appliedAny = true;
      }
    }

    const maxError = _maxConstraintError(constraints);
    if (maxError < bestError) {
      bestError = maxError;
      bestState = _snapshotTargets(allTargets);
    }
    if (maxError <= tolerance) {
      return { converged: true, iterations, maxError };
    }
    if (!appliedAny) break;
  }

  _restoreTargets(bestState);
  return { converged: bestError <= tolerance, iterations, maxError: bestError };
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

function _applyConstraint(constraint, factor) {
  if (factor <= 0) return false;

  const targets = _collectConstraintTargets(constraint);
  if (targets.length === 0) {
    constraint.apply();
    return true;
  }

  const before = _snapshotTargets(targets);
  constraint.apply();

  if (factor >= 1 - 1e-9) {
    return true;
  }

  const after = _snapshotTargets(targets);
  let changed = false;
  for (let index = 0; index < targets.length; index++) {
    const startValue = before.values[index];
    const endValue = after.values[index];
    if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) {
      _restoreTargets(before);
      return false;
    }
    const nextValue = startValue + ((endValue - startValue) * factor);
    targets[index].owner[targets[index].prop] = nextValue;
    if (Math.abs(nextValue - startValue) > 1e-12) changed = true;
  }
  return changed;
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
  if (id === undefined) {
    id = _nextTargetId++;
    _targetIds.set(object, id);
  }
  return id;
}

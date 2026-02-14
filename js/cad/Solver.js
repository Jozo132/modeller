// js/cad/Solver.js — Iterative Gauss-Seidel constraint solver

/**
 * Solve all constraints iteratively until convergence.
 *
 * @param {import('./Constraint.js').Constraint[]} constraints
 * @param {object} [opts]
 * @param {number} [opts.maxIter=200]    — max relaxation iterations
 * @param {number} [opts.tolerance=1e-6] — max acceptable residual
 * @returns {{ converged: boolean, iterations: number, maxError: number }}
 */
export function solve(constraints, { maxIter = 200, tolerance = 1e-6 } = {}) {
  if (constraints.length === 0) return { converged: true, iterations: 0, maxError: 0 };

  let maxError = 0;
  for (let i = 0; i < maxIter; i++) {
    maxError = 0;
    for (const c of constraints) {
      const err = c.error();
      if (err > maxError) maxError = err;
      if (err > tolerance) c.apply();
    }
    if (maxError <= tolerance) {
      return { converged: true, iterations: i + 1, maxError };
    }
  }
  return { converged: false, iterations: maxIter, maxError };
}

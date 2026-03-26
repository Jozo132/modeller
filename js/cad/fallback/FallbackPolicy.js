// js/cad/fallback/FallbackPolicy.js — Policy hook for routing boolean operations
//
// Provides a conservative routing policy that decides whether to attempt
// the discrete fallback lane when the exact boolean pipeline fails.
//
// Gated behind CAD_ALLOW_DISCRETE_FALLBACK=1 environment variable.

import { ResultGrade, FallbackDiagnostics } from './FallbackDiagnostics.js';

/**
 * Known trigger reasons that activate the fallback lane.
 * @readonly
 */
export const FallbackTrigger = Object.freeze({
  INTERSECTION_FAILURE: 'intersection_failure',
  INVALID_SPLIT_LOOPS: 'invalid_split_loops',
  NON_CLOSED_SHELL: 'non_closed_shell',
  INVARIANT_VALIDATION_FAILURE: 'invariant_validation_failure',
  PERSISTENT_HEALING_FAILURE: 'persistent_healing_failure',
  CLASSIFICATION_AMBIGUITY: 'classification_ambiguity',
  UNCAUGHT_EXCEPTION: 'uncaught_exception',
});

/**
 * Check whether discrete fallback is enabled via environment variable.
 * @returns {boolean}
 */
export function isFallbackEnabled() {
  try {
    // Works in Node.js; returns false in browsers where process is undefined
    return (typeof process !== 'undefined' &&
            process.env &&
            process.env.CAD_ALLOW_DISCRETE_FALLBACK === '1');
  } catch {
    return false;
  }
}

/**
 * Evaluate whether a given failure reason should trigger the fallback lane.
 *
 * @param {string} triggerReason - One of FallbackTrigger values
 * @param {Object} [opts]
 * @param {string[]} [opts.allowlist] - If provided, only these triggers are allowed
 * @returns {boolean}
 */
export function shouldTriggerFallback(triggerReason, opts = {}) {
  if (!isFallbackEnabled()) return false;
  const validTriggers = Object.values(FallbackTrigger);
  if (!validTriggers.includes(triggerReason)) return false;
  if (opts.allowlist && !opts.allowlist.includes(triggerReason)) return false;
  return true;
}

/**
 * Analyze exact-path diagnostics and determine whether fallback should activate.
 *
 * @param {Object} diagnostics - Diagnostics from the exact boolean pipeline
 * @returns {{ shouldFallback: boolean, trigger: string|null, stage: string|null }}
 */
export function evaluateExactResult(diagnostics) {
  if (!diagnostics) return { shouldFallback: false, trigger: null, stage: null };

  // Check intersection validation failures
  if (diagnostics.intersectionValidation) {
    const iv = diagnostics.intersectionValidation;
    if (iv.diagnostics && iv.diagnostics.length > 0 && !iv.isValid) {
      return {
        shouldFallback: true,
        trigger: FallbackTrigger.INTERSECTION_FAILURE,
        stage: 'intersection_validation',
      };
    }
  }

  // Check fragment validation failures
  for (const key of ['fragmentValidationA', 'fragmentValidationB']) {
    if (diagnostics[key]) {
      const fv = diagnostics[key];
      if (fv.diagnostics && fv.diagnostics.length > 0 && !fv.isValid) {
        return {
          shouldFallback: true,
          trigger: FallbackTrigger.INVALID_SPLIT_LOOPS,
          stage: `fragment_validation_${key.slice(-1)}`,
        };
      }
    }
  }

  // Check final body validation failures (non-closed shell, manifold issues)
  if (diagnostics.finalBodyValidation) {
    const fbv = diagnostics.finalBodyValidation;
    if (fbv.diagnostics && fbv.diagnostics.length > 0 && !fbv.isValid) {
      // Determine specific trigger
      const hasEdgeCount = fbv.diagnostics.some(d =>
        d.invariant && d.invariant.includes('edge-use-count'));
      const trigger = hasEdgeCount
        ? FallbackTrigger.NON_CLOSED_SHELL
        : FallbackTrigger.INVARIANT_VALIDATION_FAILURE;
      return {
        shouldFallback: true,
        trigger,
        stage: 'final_body_validation',
      };
    }
  }

  return { shouldFallback: false, trigger: null, stage: null };
}

/**
 * Wrap a boolean operation result with the appropriate grade and diagnostics.
 *
 * @param {Object} result - { body, mesh, diagnostics }
 * @param {string} grade - ResultGrade value
 * @param {FallbackDiagnostics} [fallbackDiagnostics]
 * @returns {Object} - { body, mesh, diagnostics, resultGrade, _isFallback }
 */
export function wrapResult(result, grade, fallbackDiagnostics = null) {
  return {
    ...result,
    resultGrade: grade,
    _isFallback: grade === ResultGrade.FALLBACK,
    fallbackDiagnostics: fallbackDiagnostics ? fallbackDiagnostics.toJSON() : null,
  };
}

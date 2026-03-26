// js/cad/fallback/FallbackPolicy.js — Policy hook for routing boolean operations
//
// Provides a conservative routing policy that decides whether to attempt
// the discrete fallback lane when the exact boolean pipeline fails.
//
// Controlled via the CAD_ALLOW_DISCRETE_FALLBACK feature flag (default: ON).
//
// Operation policy modes:
//   - 'exact-only':      Never fall back; throw on exact failure.
//   - 'allow-fallback':  Attempt exact first; fall back on failure (default when enabled).
//   - 'force-fallback':  Skip exact path; always use discrete fallback.

import { ResultGrade, FallbackDiagnostics } from './FallbackDiagnostics.js';
import { getFlag } from '../../featureFlags.js';

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
 * Operation policy modes that control fallback routing.
 * @readonly
 * @enum {string}
 */
export const OperationPolicy = Object.freeze({
  EXACT_ONLY: 'exact-only',
  ALLOW_FALLBACK: 'allow-fallback',
  FORCE_FALLBACK: 'force-fallback',
});

/**
 * Check whether discrete fallback is enabled via the feature flag module.
 * Uses the centralized getFlag() API so that programmatic overrides,
 * environment variables, and the new default (ON) are all respected.
 * @returns {boolean}
 */
export function isFallbackEnabled() {
  return !!getFlag('CAD_ALLOW_DISCRETE_FALLBACK');
}

/**
 * Resolve the effective operation policy.
 *
 * Priority: explicit policy parameter → environment variable → 'exact-only'.
 *
 * @param {string} [policy] - One of OperationPolicy values, or undefined
 * @returns {string} Resolved OperationPolicy value
 */
export function resolvePolicy(policy) {
  const validPolicies = Object.values(OperationPolicy);
  if (policy && validPolicies.includes(policy)) return policy;
  if (isFallbackEnabled()) return OperationPolicy.ALLOW_FALLBACK;
  return OperationPolicy.EXACT_ONLY;
}

/**
 * Evaluate whether a given failure reason should trigger the fallback lane.
 *
 * @param {string} triggerReason - One of FallbackTrigger values
 * @param {Object} [opts]
 * @param {string[]} [opts.allowlist] - If provided, only these triggers are allowed
 * @param {string}   [opts.policy]    - OperationPolicy value (overrides env check)
 * @returns {boolean}
 */
export function shouldTriggerFallback(triggerReason, opts = {}) {
  const policy = resolvePolicy(opts.policy);
  if (policy === OperationPolicy.EXACT_ONLY) return false;
  if (policy === OperationPolicy.FORCE_FALLBACK) return true;
  // allow-fallback: check env gate + valid trigger
  if (!isFallbackEnabled() && !opts.policy) return false;
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

  // Check BooleanInvariantValidator results
  if (diagnostics.invariantValidation) {
    const iv = diagnostics.invariantValidation;
    if (iv.diagnosticCount > 0 && !iv.valid) {
      // Determine specific trigger from invariant names
      const hasShellClosed = iv.diagnostics.some(d =>
        d.invariant === 'shell-closed');
      const trigger = hasShellClosed
        ? FallbackTrigger.NON_CLOSED_SHELL
        : FallbackTrigger.INVARIANT_VALIDATION_FAILURE;
      return {
        shouldFallback: true,
        trigger,
        stage: 'invariant_validation',
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

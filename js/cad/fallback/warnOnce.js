// js/cad/fallback/warnOnce.js — Centralized warn-once fallback logging
//
// Provides a session-deduplicated console.warn for approved fallback paths.
// Each distinct fallback id is warned exactly once per process/session lifetime.
//
// Usage:
//   import { warnOnceForFallback, _resetWarnOnce } from './warnOnce.js';
//   warnOnceForFallback({ id: 'tessellation:robust-retry', policy: 'allow-fallback',
//     reason: 'robust tessellator produced non-clean mesh', kind: 'new-stack-fallback' });

/**
 * Valid fallback classification kinds.
 * @readonly
 * @enum {string}
 */
export const FallbackKind = Object.freeze({
  NEW_STACK_FALLBACK: 'new-stack-fallback',
  COMPATIBILITY_SHIM: 'compatibility-shim',
  HARD_FAIL_AVOIDED: 'hard-fail-avoided',
  DEGRADED_RESULT: 'degraded-result',
});

/** @type {Set<string>} */
const _warned = new Set();

/**
 * Emit a structured console.warn exactly once per distinct fallback id
 * during the current session/process lifetime.
 *
 * Safe for repeated calls — subsequent calls with the same `id` are no-ops.
 *
 * @param {Object} opts
 * @param {string} opts.id       Stable fallback identifier (e.g. 'tessellation:robust-retry')
 * @param {string} opts.policy   Active policy or mode (e.g. 'allow-fallback')
 * @param {string} opts.reason   Short human-readable reason
 * @param {string} opts.kind     One of FallbackKind values
 * @returns {boolean} true if warning was emitted (first time), false if deduplicated
 */
export function warnOnceForFallback({ id, policy, reason, kind }) {
  if (_warned.has(id)) return false;
  _warned.add(id);
  console.warn(
    `[CAD-Fallback] id=${id} | policy=${policy} | kind=${kind} | ${reason}`
  );
  return true;
}

/**
 * Reset the warn-once deduplication state.
 * Intended for testing only — do not call in production code paths.
 */
export function _resetWarnOnce() {
  _warned.clear();
}

/**
 * Return the current set of warned fallback ids (read-only snapshot).
 * Useful for diagnostics and testing.
 * @returns {ReadonlyArray<string>}
 */
export function getWarnedFallbackIds() {
  return Object.freeze([..._warned]);
}

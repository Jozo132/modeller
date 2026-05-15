// js/featureFlags.js — Centralized feature-flag module
//
// All CAD-kernel feature flags live here. Flags that correspond to the
// integrated WASM/OCCT stack default to ON where applicable. Safety /
// diagnostics-only flags default to OFF, and failure-masking escape
// hatches stay opt-in.
//
// Flags can be set via:
//   1. Environment variables  (Node.js: process.env.CAD_*)
//   2. Programmatic overrides (setFlag / resetFlags)
//
// Boolean flags accept '1' / 'true' / 'yes' (case-insensitive) as truthy.
// String flags accept any non-empty value.
//
// Usage:
//   import { getFlag, setFlag, allFlags } from 'modeller/flags';

// ── Flag definitions ────────────────────────────────────────────────

/** @typedef {'boolean'|'string'} FlagType */

/**
 * @typedef {Object} FlagDef
 * @property {string}      name         Environment variable name
 * @property {FlagType}    type         'boolean' or 'string'
 * @property {*}           defaultValue Default when unset
 * @property {string}      description  Human-readable description
 */

/** @type {FlagDef[]} */
const FLAG_DEFS = [
  {
    name: 'CAD_USE_IR_CACHE',
    type: 'boolean',
    defaultValue: true,
    description: 'Enable CBREP IR cache embedding in .cmod files.',
  },
  {
    name: 'CAD_IR_CACHE_MODE',
    type: 'string',
    defaultValue: 'memory',
    description: "IR cache storage mode: 'none' | 'memory' | 'fs' | 'idb'.",
  },
  {
    name: 'CAD_USE_WASM_EVAL',
    type: 'boolean',
    defaultValue: true,
    description: 'Prefer WASM evaluator for NURBS curve/surface evaluation.',
  },
  {
    name: 'CAD_USE_GWN_CONTAINMENT',
    type: 'boolean',
    defaultValue: true,
    description: 'Use generalized winding number for containment classification.',
  },
  {
    name: 'CAD_USE_ROBUST_TESSELLATOR',
    type: 'boolean',
    defaultValue: true,
    description: 'Compatibility flag retained for older tests and tools; the live tessellation path no longer reads it.',
  },
  {
    name: 'CAD_REQUIRE_WASM_TESSELLATION',
    type: 'boolean',
    defaultValue: false,
    description: 'Disallow JS tessellation fallbacks and require the native WASM tessellator.',
  },
  {
    name: 'CAD_ALLOW_DISCRETE_FALLBACK',
    type: 'boolean',
    defaultValue: false,
    description: 'Allow discrete mesh fallback when exact boolean path fails (opt-in only).',
  },
  {
    name: 'CAD_STRICT_INVARIANTS',
    type: 'boolean',
    defaultValue: false,
    description: 'Throw on invariant violations instead of logging warnings.',
  },
  {
    name: 'CAD_DIAGNOSTICS_DIR',
    type: 'string',
    defaultValue: '',
    description: 'Directory path for writing diagnostic JSON files (empty = disabled).',
  },
  {
    name: 'CAD_USE_OCCT_STEP_SHADOW',
    type: 'boolean',
    defaultValue: false,
    description: 'Run the optional OCCT STEP import shadow path when the OCCT module has been preloaded.',
  },
  {
    name: 'CAD_USE_OCCT_BOOLEAN_SHADOW',
    type: 'boolean',
    defaultValue: false,
    description: 'Run the optional OCCT boolean shadow path when the OCCT module has been preloaded.',
  },
  {
    name: 'CAD_USE_OCCT_SKETCH_SOLIDS',
    type: 'boolean',
    defaultValue: false,
    description: 'Use OCCT residency for supported sketch solids, STEP imports, and direct booleans between resident shapes.',
  },
];

// ── Runtime state ───────────────────────────────────────────────────

/** @type {Map<string, *>} */
const _overrides = new Map();

/**
 * Parse a string as a boolean flag value.
 * Accepts '1', 'true', 'yes' (case-insensitive) → true, everything else → false.
 * @param {string|undefined} raw
 * @returns {boolean}
 */
function parseBool(raw) {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Read a raw environment variable value, safely.
 * Returns undefined when not in Node.js or the variable is unset.
 * @param {string} name
 * @returns {string|undefined}
 */
function readEnv(name) {
  try {
    if (typeof process !== 'undefined' && process.env) {
      return process.env[name];
    }
  } catch {
    // Silently ignored: browser or restricted env where `process` access throws
  }
  return undefined;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Get the resolved value of a feature flag.
 * Priority: programmatic override → environment variable → default.
 *
 * @param {string} name  Flag name (e.g. 'CAD_USE_IR_CACHE')
 * @returns {*}          Resolved value (boolean or string)
 */
export function getFlag(name) {
  // Programmatic override wins
  if (_overrides.has(name)) return _overrides.get(name);

  const def = FLAG_DEFS.find(d => d.name === name);
  if (!def) return undefined;

  const raw = readEnv(name);
  if (raw === undefined) return def.defaultValue;

  return def.type === 'boolean' ? parseBool(raw) : raw;
}

/**
 * Programmatically override a flag value (e.g. for tests).
 * Pass `undefined` to clear the override.
 *
 * @param {string} name
 * @param {*}      value
 */
export function setFlag(name, value) {
  if (value === undefined) {
    _overrides.delete(name);
  } else {
    _overrides.set(name, value);
  }
}

/**
 * Clear all programmatic overrides, reverting to env / defaults.
 */
export function resetFlags() {
  _overrides.clear();
}

/**
 * Return a frozen snapshot of all flag values.
 * @returns {Record<string, *>}
 */
export function allFlags() {
  const out = {};
  for (const def of FLAG_DEFS) {
    out[def.name] = getFlag(def.name);
  }
  return Object.freeze(out);
}

/**
 * Return the flag definition table (read-only).
 * @returns {ReadonlyArray<Readonly<FlagDef>>}
 */
export function flagDefinitions() {
  return Object.freeze(FLAG_DEFS.map(d => Object.freeze({ ...d })));
}

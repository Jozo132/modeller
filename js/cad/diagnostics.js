// js/cad/diagnostics.js — Result and diagnostic schemas
//
// Lightweight value objects for structured diagnostics emitted by the
// boolean, tessellation, and containment pipelines. These are pure data
// containers with toJSON() for serialisation — they carry no kernel logic.
//
// Adding this module does NOT change any runtime behaviour; existing
// pipeline modules continue to return their own ad-hoc objects. These
// schemas exist so that future integration code has stable contracts to
// target.

// ── Boolean result schema ───────────────────────────────────────────

/**
 * Outcome of a boolean operation (exact or fallback).
 */
export class BooleanResult {
  /**
   * @param {Object} opts
   * @param {'exact'|'fallback'|'failed'} [opts.grade='exact']
   * @param {boolean}  [opts.ok=true]
   * @param {string}   [opts.operation]     'union' | 'subtract' | 'intersect'
   * @param {Object}   [opts.body]          Resulting TopoBody (opaque)
   * @param {Object}   [opts.mesh]          Tessellated mesh (opaque)
   * @param {Object}   [opts.diagnostics]   Pipeline diagnostics (opaque)
   * @param {string[]} [opts.warnings]
   * @param {Object}   [opts.hashes]        Operand/result content hashes
   * @param {string}   [opts.hashes.operandA]
   * @param {string}   [opts.hashes.operandB]
   * @param {string}   [opts.hashes.result]
   */
  constructor(opts = {}) {
    /** @type {'exact'|'fallback'|'failed'} */
    this.grade = opts.grade ?? 'exact';
    /** @type {boolean} */
    this.ok = opts.ok ?? true;
    /** @type {string|undefined} */
    this.operation = opts.operation;
    /** @type {Object|null} */
    this.body = opts.body ?? null;
    /** @type {Object|null} */
    this.mesh = opts.mesh ?? null;
    /** @type {Object|null} */
    this.diagnostics = opts.diagnostics ?? null;
    /** @type {string[]} */
    this.warnings = opts.warnings ?? [];
    /** @type {{operandA?: string, operandB?: string, result?: string}|null} */
    this.hashes = opts.hashes ?? null;
  }

  toJSON() {
    return {
      grade: this.grade,
      ok: this.ok,
      operation: this.operation,
      warnings: this.warnings,
      diagnostics: this.diagnostics,
      hashes: this.hashes,
    };
  }
}

// ── Tessellation result schema ──────────────────────────────────────

/**
 * Outcome of a tessellation pass over a TopoBody or TopoFace.
 */
export class TessellationResult {
  /**
   * @param {Object} opts
   * @param {boolean}  [opts.ok=true]
   * @param {number}   [opts.vertexCount=0]
   * @param {number}   [opts.faceCount=0]
   * @param {number}   [opts.degenerateFaces=0]
   * @param {string[]} [opts.warnings]
   * @param {Object}   [opts.mesh]  Tessellated mesh (opaque)
   */
  constructor(opts = {}) {
    /** @type {boolean} */
    this.ok = opts.ok ?? true;
    /** @type {number} */
    this.vertexCount = opts.vertexCount ?? 0;
    /** @type {number} */
    this.faceCount = opts.faceCount ?? 0;
    /** @type {number} */
    this.degenerateFaces = opts.degenerateFaces ?? 0;
    /** @type {string[]} */
    this.warnings = opts.warnings ?? [];
    /** @type {Object|null} */
    this.mesh = opts.mesh ?? null;
  }

  toJSON() {
    return {
      ok: this.ok,
      vertexCount: this.vertexCount,
      faceCount: this.faceCount,
      degenerateFaces: this.degenerateFaces,
      warnings: this.warnings,
    };
  }
}

// ── Containment result schema ───────────────────────────────────────

/**
 * Outcome of a containment classification query.
 */
export class ContainmentResult {
  /**
   * @param {Object} opts
   * @param {'inside'|'outside'|'on'|'boundary'|'uncertain'} [opts.state='uncertain']
   * @param {number}   [opts.confidence=0]   0..1
   * @param {string}   [opts.detail]         Human-readable extra info
   * @param {string}   [opts.method]         'analytic' | 'gwn' | 'rayCast'
   */
  constructor(opts = {}) {
    /** @type {'inside'|'outside'|'on'|'boundary'|'uncertain'} */
    this.state = opts.state ?? 'uncertain';
    /** @type {number} */
    this.confidence = opts.confidence ?? 0;
    /** @type {string} */
    this.detail = opts.detail ?? '';
    /** @type {string} */
    this.method = opts.method ?? '';
  }

  toJSON() {
    return {
      state: this.state,
      confidence: this.confidence,
      detail: this.detail,
      method: this.method,
    };
  }
}

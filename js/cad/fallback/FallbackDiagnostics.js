// js/cad/fallback/FallbackDiagnostics.js — Compact diagnostic payload for fallback results
//
// Records the result grade, trigger reason, failing pipeline stage,
// model identifiers, and summary of validation results.

/**
 * Result quality grades for boolean operations.
 * @readonly
 * @enum {string}
 */
export const ResultGrade = Object.freeze({
  EXACT: 'exact',
  FALLBACK: 'fallback',
  FAILED: 'failed',
});

/**
 * Compact diagnostic payload attached to boolean operation results.
 */
export class FallbackDiagnostics {
  /**
   * @param {Object} opts
   * @param {string} opts.grade - One of ResultGrade values
   * @param {string} [opts.triggerReason] - Why fallback was triggered
   * @param {string} [opts.failingStage] - Pipeline stage that failed
   * @param {string} [opts.modelId] - Model/fixture identifier
   * @param {Object} [opts.validation] - Summary of fallback validation results
   * @param {Object} [opts.exactDiagnostics] - Original exact-path diagnostics if available
   */
  constructor(opts = {}) {
    this.grade = opts.grade || ResultGrade.EXACT;
    this.triggerReason = opts.triggerReason || null;
    this.failingStage = opts.failingStage || null;
    this.modelId = opts.modelId || null;
    this.validation = opts.validation || null;
    this.exactDiagnostics = opts.exactDiagnostics || null;
    this.timestamp = new Date().toISOString();
  }

  /** @returns {boolean} */
  get isFallback() {
    return this.grade === ResultGrade.FALLBACK;
  }

  /** @returns {boolean} */
  get isFailed() {
    return this.grade === ResultGrade.FAILED;
  }

  /** @returns {boolean} */
  get isExact() {
    return this.grade === ResultGrade.EXACT;
  }

  /**
   * Produce a compact JSON-serializable payload.
   * @returns {Object}
   */
  toJSON() {
    const obj = {
      grade: this.grade,
      timestamp: this.timestamp,
    };
    if (this.triggerReason) obj.triggerReason = this.triggerReason;
    if (this.failingStage) obj.failingStage = this.failingStage;
    if (this.modelId) obj.modelId = this.modelId;
    if (this.validation) obj.validation = this.validation;
    if (this.exactDiagnostics) obj.exactDiagnostics = this.exactDiagnostics;
    return obj;
  }

  /**
   * Create an exact-result diagnostic (no fallback triggered).
   * @param {Object} [exactDiagnostics] - Pipeline diagnostics from exact path
   * @returns {FallbackDiagnostics}
   */
  static exact(exactDiagnostics = null) {
    return new FallbackDiagnostics({
      grade: ResultGrade.EXACT,
      exactDiagnostics,
    });
  }

  /**
   * Create a fallback-result diagnostic.
   * @param {string} triggerReason
   * @param {string} failingStage
   * @param {Object} [validation]
   * @param {Object} [exactDiagnostics]
   * @param {string} [modelId]
   * @returns {FallbackDiagnostics}
   */
  static fallback(triggerReason, failingStage, validation = null, exactDiagnostics = null, modelId = null) {
    return new FallbackDiagnostics({
      grade: ResultGrade.FALLBACK,
      triggerReason,
      failingStage,
      validation,
      exactDiagnostics,
      modelId,
    });
  }

  /**
   * Create a failed-result diagnostic.
   * @param {string} triggerReason
   * @param {string} failingStage
   * @param {Object} [exactDiagnostics]
   * @param {string} [modelId]
   * @returns {FallbackDiagnostics}
   */
  static failed(triggerReason, failingStage, exactDiagnostics = null, modelId = null) {
    return new FallbackDiagnostics({
      grade: ResultGrade.FAILED,
      triggerReason,
      failingStage,
      exactDiagnostics,
      modelId,
    });
  }
}

// ui/diagnosticsPanel.js — Diagnostics panel for modelling UX
//
// Surfaces three classes of diagnostic:
//   1. Fallback status — whether any feature used the discrete mesh lane.
//   2. Invariant failures — strict-invariant violations from BooleanKernel.
//   3. Containment uncertainty — point-classification disagreements.
//
// Also shows per-feature replay diagnostics (selection remap outcomes)
// and the history cache hit/miss stats.

import { ReplayStatus, DiagnosticReason } from '../cad/history/FeatureReplay.js';

// -----------------------------------------------------------------------
// Severity levels for display
// -----------------------------------------------------------------------

const Severity = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
});

// -----------------------------------------------------------------------
// DiagnosticsPanel
// -----------------------------------------------------------------------

/**
 * DiagnosticsPanel — Renders actionable diagnostics beneath the feature tree.
 */
export class DiagnosticsPanel {
  /**
   * @param {HTMLElement} container - DOM element to render into.
   */
  constructor(container) {
    this.container = container;
    /** @type {Array<{severity:string, category:string, message:string, featureId?:string}>} */
    this._entries = [];
    this._collapsed = false;
    this._init();
  }

  // -------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------

  _init() {
    this.container.innerHTML = `
      <div class="diag-panel-header">
        <h3>Diagnostics</h3>
        <button class="diag-toggle" title="Collapse">▾</button>
      </div>
      <div class="diag-panel-body"></div>
    `;
    this.bodyEl = this.container.querySelector('.diag-panel-body');
    const toggleBtn = this.container.querySelector('.diag-toggle');
    toggleBtn.addEventListener('click', () => {
      this._collapsed = !this._collapsed;
      toggleBtn.textContent = this._collapsed ? '▸' : '▾';
      this.bodyEl.style.display = this._collapsed ? 'none' : '';
    });
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /**
   * Clear all diagnostic entries and re-render.
   */
  clear() {
    this._entries = [];
    this._render();
  }

  /**
   * Ingest a FeatureReplayResult and surface relevant diagnostics.
   * @param {Object} replayResult - From replayFeatureTree()
   */
  setReplayResult(replayResult) {
    // Remove old replay entries
    this._entries = this._entries.filter(e => e.category !== 'replay');

    if (!replayResult || !replayResult.diagnostics) {
      this._render();
      return;
    }

    for (const d of replayResult.diagnostics) {
      if (d.status === ReplayStatus.FAILED) {
        this._entries.push({
          severity: Severity.ERROR,
          category: 'replay',
          message: `Feature "${d.featureId}" (${d.featureType}): ${d.reason || 'selection resolution failed'}`,
          featureId: d.featureId,
        });
      } else if (d.status === ReplayStatus.NON_EXACT) {
        this._entries.push({
          severity: Severity.WARNING,
          category: 'replay',
          message: `Feature "${d.featureId}" (${d.featureType}): ${d.reason || 'remapped'}`,
          featureId: d.featureId,
        });
      }
    }

    // Cache stats
    if (replayResult.cacheHits > 0 || replayResult.cacheMisses > 0) {
      const total = replayResult.cacheHits + replayResult.cacheMisses;
      const rate = total > 0 ? ((replayResult.cacheHits / total) * 100).toFixed(0) : '0';
      this._entries.push({
        severity: Severity.INFO,
        category: 'replay',
        message: `Cache: ${replayResult.cacheHits}/${total} hits (${rate}%)`,
      });
    }

    this._render();
  }

  /**
   * Report a fallback boolean result.
   * @param {Object} opts
   * @param {string} opts.featureId
   * @param {string} opts.grade  - 'exact' | 'fallback' | 'failed'
   * @param {string} [opts.triggerReason]
   * @param {string} [opts.failingStage]
   */
  addFallbackStatus(opts) {
    if (opts.grade === 'exact') return; // nothing to report

    this._entries.push({
      severity: opts.grade === 'failed' ? Severity.ERROR : Severity.WARNING,
      category: 'fallback',
      message: `Feature "${opts.featureId}": ${opts.grade} — ${opts.triggerReason || 'exact path unavailable'}${opts.failingStage ? ` (stage: ${opts.failingStage})` : ''}`,
      featureId: opts.featureId,
    });
    this._render();
  }

  /**
   * Report an invariant violation.
   * @param {Object} opts
   * @param {string} opts.featureId
   * @param {string} opts.message
   * @param {Object} [opts.diagnostics] - BooleanKernel diagnostics payload
   */
  addInvariantFailure(opts) {
    this._entries.push({
      severity: Severity.ERROR,
      category: 'invariant',
      message: `Invariant: ${opts.message}${opts.featureId ? ` [${opts.featureId}]` : ''}`,
      featureId: opts.featureId,
    });
    this._render();
  }

  /**
   * Report a containment uncertainty (shadow disagreement).
   * @param {Object} opts
   * @param {string} [opts.featureId]
   * @param {string} opts.detail
   * @param {number} [opts.confidence]
   */
  addContainmentUncertainty(opts) {
    this._entries.push({
      severity: Severity.WARNING,
      category: 'containment',
      message: `Containment: ${opts.detail}${opts.confidence != null ? ` (confidence: ${(opts.confidence * 100).toFixed(0)}%)` : ''}`,
      featureId: opts.featureId,
    });
    this._render();
  }

  /**
   * Get all current entries (for testing / external consumption).
   * @returns {Array}
   */
  getEntries() {
    return [...this._entries];
  }

  // -------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------

  _render() {
    if (!this.bodyEl) return;

    if (this._entries.length === 0) {
      this.bodyEl.innerHTML = '<p class="hint diag-empty">No diagnostics.</p>';
      return;
    }

    const frag = document.createDocumentFragment();

    for (const entry of this._entries) {
      const row = document.createElement('div');
      row.className = `diag-entry diag-${entry.severity}`;
      if (entry.featureId) row.dataset.featureId = entry.featureId;

      const iconSpan = document.createElement('span');
      iconSpan.className = 'diag-icon';
      iconSpan.textContent = entry.severity === Severity.ERROR ? '✗'
        : entry.severity === Severity.WARNING ? '⚠'
        : 'ℹ';

      const msgSpan = document.createElement('span');
      msgSpan.className = 'diag-message';
      msgSpan.textContent = entry.message;

      const catSpan = document.createElement('span');
      catSpan.className = 'diag-category';
      catSpan.textContent = entry.category;

      row.appendChild(iconSpan);
      row.appendChild(msgSpan);
      row.appendChild(catSpan);
      frag.appendChild(row);
    }

    this.bodyEl.innerHTML = '';
    this.bodyEl.appendChild(frag);
  }
}

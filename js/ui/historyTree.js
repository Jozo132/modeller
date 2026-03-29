// ui/historyTree.js — Sidebar history tree with active feature editor mode
//
// Renders the parametric feature tree as a scrollable sidebar with:
//   - per-node status badges (exact / non-exact / error / suppressed)
//   - selection-driven editing mode toggle (double-click to enter edit)
//   - history pointer indicator showing the current undo/redo position
//   - stable selection key display per node
//
// Integrates with FeatureReplay diagnostics so each node can surface
// replay-level issues directly in the tree.

import { getFeatureIconSVG } from './featureIcons.js';

/**
 * Status badge constants matching ReplayStatus values.
 */
const STATUS = Object.freeze({
  OK: 'ok',
  EXACT: 'exact',
  NON_EXACT: 'non-exact',
  FAILED: 'failed',
  SUPPRESSED: 'suppressed',
  ERROR: 'error',
});

/**
 * HistoryTree — Sidebar history tree panel.
 *
 * Shows every feature in the parametric tree together with its execution
 * status.  The "history pointer" indicates which feature is the current
 * tip; features beyond the pointer are shown as rolled-back (greyed).
 *
 * @fires feature-select  When a feature is single-clicked.
 * @fires feature-edit    When a feature is double-clicked (enter edit session).
 * @fires pointer-move    When the user drags the history pointer.
 */
export class HistoryTree {
  /**
   * @param {HTMLElement} container - DOM element to render into.
   * @param {Object}      partManager - Application PartManager instance.
   */
  constructor(container, partManager) {
    this.container = container;
    this.partManager = partManager;

    /** Currently selected feature id */
    this.selectedFeatureId = null;

    /** Feature id currently being edited (edit-session) */
    this.editingFeatureId = null;

    /** History pointer index (0-based into feature array). -1 = before all. */
    this.historyPointer = -1;

    /** Per-feature diagnostic map (featureId → status string) */
    this._diagnostics = {};

    /** Per-feature stable selection keys (featureId → string[]) */
    this._selectionKeys = {};

    // Callbacks
    this.onFeatureSelect = null;
    this.onFeatureEdit = null;
    this.onPointerMove = null;
    this.isLocked = null;

    this._init();
  }

  // -------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------

  _init() {
    this.container.innerHTML = `
      <div class="history-tree-header">
        <h3>History</h3>
      </div>
      <div class="history-tree-list"></div>
    `;
    this.listEl = this.container.querySelector('.history-tree-list');

    // Mobile: click header to collapse/expand
    const header = this.container.querySelector('.history-tree-header');
    if (header) {
      header.addEventListener('click', () => {
        this.container.classList.toggle('collapsed');
      });
    }
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /**
   * Full re-render of the history tree.
   */
  update() {
    const features = this.partManager.getFeatures();

    if (features.length === 0) {
      this.listEl.innerHTML = '<p class="hint">No features yet.</p>';
      return;
    }

    // Normalise pointer to valid range
    if (this.historyPointer < 0 || this.historyPointer >= features.length) {
      this.historyPointer = features.length - 1;
    }

    this.listEl.innerHTML = '';

    features.forEach((feature, index) => {
      const node = this._createNode(feature, index);
      this.listEl.appendChild(node);
    });

    // History pointer bar
    const bar = document.createElement('div');
    bar.className = 'history-pointer-bar';
    bar.title = 'History pointer – drag to roll back';
    this.listEl.appendChild(bar);
  }

  /**
   * Inject replay diagnostics from a FeatureReplayResult.
   * @param {Object} replayResult — .diagnostics[]
   */
  setReplayDiagnostics(replayResult) {
    this._diagnostics = {};
    this._selectionKeys = {};
    if (!replayResult || !replayResult.diagnostics) return;

    for (const d of replayResult.diagnostics) {
      this._diagnostics[d.featureId] = d.status;
      if (d.selectionKeys && d.selectionKeys.length > 0) {
        this._selectionKeys[d.featureId] = d.selectionKeys;
      }
    }
    this.update();
  }

  /**
   * Move the history pointer to the given index.
   * @param {number} index
   */
  setPointer(index) {
    const features = this.partManager.getFeatures();
    this.historyPointer = Math.max(-1, Math.min(index, features.length - 1));
    this.update();
    if (this.onPointerMove) this.onPointerMove(this.historyPointer);
  }

  /**
   * Returns the feature at the current pointer, or null.
   */
  getPointerFeature() {
    if (this.historyPointer < 0) return null;
    const features = this.partManager.getFeatures();
    return features[this.historyPointer] || null;
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  _createNode(feature, index) {
    const div = document.createElement('div');
    div.className = 'history-node';
    div.dataset.featureId = feature.id;
    div.dataset.index = index;

    // Selected
    if (this.selectedFeatureId === feature.id) div.classList.add('selected');

    // Editing
    if (this.editingFeatureId === feature.id) div.classList.add('editing');

    // Beyond pointer → rolled-back
    if (index > this.historyPointer) div.classList.add('rolled-back');

    // Status
    const status = this._nodeStatus(feature);
    div.classList.add(`status-${status}`);

    const icon = getFeatureIconSVG(feature.type);
    const badge = this._statusBadge(status);

    // Stable selection key count
    const keyCount = (this._selectionKeys[feature.id] || []).length;
    const keyTag = keyCount > 0 ? `<span class="history-key-count" title="${keyCount} stable selection key(s)">🔑${keyCount}</span>` : '';

    div.innerHTML = `
      <span class="history-node-icon">${icon}</span>
      <span class="history-node-name">${feature.name}</span>
      ${keyTag}
      <span class="history-node-badge">${badge}</span>
    `;

    // Single click → select
    div.addEventListener('click', (e) => {
      if (this.isLocked && this.isLocked()) return;
      e.stopPropagation();
      this.selectedFeatureId = feature.id;
      this.update();
      if (this.onFeatureSelect) this.onFeatureSelect(feature);
    });

    // Double click → enter edit session
    div.addEventListener('dblclick', (e) => {
      if (this.isLocked && this.isLocked()) return;
      e.stopPropagation();
      this.editingFeatureId = feature.id;
      this.update();
      if (this.onFeatureEdit) this.onFeatureEdit(feature);
    });

    return div;
  }

  _nodeStatus(feature) {
    if (feature.suppressed) return STATUS.SUPPRESSED;
    // Check replay diagnostics first
    const diag = this._diagnostics[feature.id];
    if (diag === 'failed') return STATUS.FAILED;
    if (diag === 'non-exact') return STATUS.NON_EXACT;
    // Check execution result
    const part = this.partManager.getPart();
    const result = part ? part.featureTree.results[feature.id] : null;
    if (result && result.error) return STATUS.ERROR;
    if (diag === 'exact') return STATUS.EXACT;
    return STATUS.OK;
  }

  _statusBadge(status) {
    switch (status) {
      case STATUS.EXACT:      return '<span class="badge badge-exact" title="Exact">✓</span>';
      case STATUS.NON_EXACT:  return '<span class="badge badge-nonexact" title="Non-exact (remapped)">⚠</span>';
      case STATUS.FAILED:     return '<span class="badge badge-failed" title="Failed">✗</span>';
      case STATUS.SUPPRESSED: return '<span class="badge badge-suppressed" title="Suppressed">◌</span>';
      case STATUS.ERROR:      return '<span class="badge badge-error" title="Error">⚠</span>';
      default:                return '';
    }
  }
}

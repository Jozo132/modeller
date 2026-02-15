// ui/featurePanel.js - Feature tree panel UI component

/**
 * FeaturePanel - Displays and manages the feature tree
 */
export class FeaturePanel {
  constructor(container, partManager) {
    this.container = container;
    this.partManager = partManager;
    this.selectedFeatureId = null;
    this.onFeatureSelect = null;
    this.onFeatureToggle = null;
    this.onFeatureDelete = null;

    this.init();
  }

  init() {
    this.container.innerHTML = `
      <div class="feature-panel-header">
        <h3>Feature Tree</h3>
      </div>
      <div class="feature-list" id="feature-list">
        <p class="hint">No features yet. Create a sketch and add operations.</p>
      </div>
    `;

    this.listElement = this.container.querySelector('#feature-list');
  }

  /**
   * Update the feature tree display
   */
  update() {
    const features = this.partManager.getFeatures();
    
    if (features.length === 0) {
      this.listElement.innerHTML = '<p class="hint">No features yet. Create a sketch and add operations.</p>';
      return;
    }

    this.listElement.innerHTML = '';

    features.forEach((feature, index) => {
      const featureItem = this.createFeatureItem(feature, index);
      this.listElement.appendChild(featureItem);
    });
  }

  /**
   * Create a feature item element
   * @param {Feature} feature - The feature object
   * @param {number} index - Feature index
   */
  createFeatureItem(feature, index) {
    const div = document.createElement('div');
    div.className = 'feature-item';
    div.dataset.featureId = feature.id;

    if (this.selectedFeatureId === feature.id) {
      div.classList.add('selected');
    }

    if (feature.suppressed) {
      div.classList.add('suppressed');
    }

    // Get feature status
    const part = this.partManager.getPart();
    const result = part ? part.featureTree.results[feature.id] : null;
    const status = feature.suppressed ? 'suppressed' : (result && result.error ? 'error' : 'ok');
    
    // Get feature icon
    const icon = this.getFeatureIcon(feature.type);

    div.innerHTML = `
      <div class="feature-icon">${icon}</div>
      <div class="feature-info">
        <div class="feature-name">${feature.name}</div>
        <div class="feature-type">${feature.type}</div>
      </div>
      <div class="feature-actions">
        <button class="feature-btn" data-action="toggle" title="${feature.suppressed ? 'Unsuppress' : 'Suppress'}">
          ${feature.suppressed ? '👁️' : '🚫'}
        </button>
        <button class="feature-btn" data-action="delete" title="Delete">🗑️</button>
      </div>
    `;

    // Add event listeners
    div.addEventListener('click', (e) => {
      if (!e.target.classList.contains('feature-btn')) {
        this.selectFeature(feature.id);
      }
    });

    const toggleBtn = div.querySelector('[data-action="toggle"]');
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleFeature(feature.id);
    });

    const deleteBtn = div.querySelector('[data-action="delete"]');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteFeature(feature.id);
    });

    return div;
  }

  /**
   * Get icon for feature type
   * @param {string} type - Feature type
   */
  getFeatureIcon(type) {
    const icons = {
      'sketch': '📐',
      'extrude': '⬆️',
      'revolve': '🔄',
      'fillet': '🔘',
      'chamfer': '📐'
    };
    return icons[type] || '📦';
  }

  /**
   * Select a feature
   * @param {string} featureId - Feature ID
   */
  selectFeature(featureId) {
    this.selectedFeatureId = featureId;
    this.partManager.setActiveFeature(featureId);
    this.update();

    if (this.onFeatureSelect) {
      const feature = this.partManager.getFeatures().find(f => f.id === featureId);
      this.onFeatureSelect(feature);
    }
  }

  /**
   * Toggle feature suppression
   * @param {string} featureId - Feature ID
   */
  toggleFeature(featureId) {
    const feature = this.partManager.getFeatures().find(f => f.id === featureId);
    if (!feature) return;

    if (feature.suppressed) {
      this.partManager.unsuppressFeature(featureId);
    } else {
      this.partManager.suppressFeature(featureId);
    }

    this.update();

    if (this.onFeatureToggle) {
      this.onFeatureToggle(feature);
    }
  }

  /**
   * Delete a feature
   * @param {string} featureId - Feature ID
   */
  deleteFeature(featureId) {
    if (!confirm('Delete this feature? This cannot be undone.')) {
      return;
    }

    this.partManager.removeFeature(featureId);
    
    if (this.selectedFeatureId === featureId) {
      this.selectedFeatureId = null;
    }

    this.update();

    if (this.onFeatureDelete) {
      this.onFeatureDelete(featureId);
    }
  }

  /**
   * Set feature select callback
   * @param {Function} callback - Callback function
   */
  setOnFeatureSelect(callback) {
    this.onFeatureSelect = callback;
  }

  /**
   * Set feature toggle callback
   * @param {Function} callback - Callback function
   */
  setOnFeatureToggle(callback) {
    this.onFeatureToggle = callback;
  }

  /**
   * Set feature delete callback
   * @param {Function} callback - Callback function
   */
  setOnFeatureDelete(callback) {
    this.onFeatureDelete = callback;
  }
}

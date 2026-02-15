// js/cad/Feature.js — Base class for parametric features
// Features represent operations in the parametric history tree
// Each feature can depend on previous features and triggers recalculation when modified

let nextFeatureId = 1;

/**
 * Base class for all parametric features.
 * A feature represents a modeling operation that can be:
 * - Edited (changing parameters triggers recalculation)
 * - Reordered (with dependency validation)
 * - Suppressed (temporarily disabled)
 * - Deleted (removed from history)
 */
export class Feature {
  constructor(name = 'Feature') {
    this.id = `feature_${nextFeatureId++}`;
    this.name = name;
    this.type = 'base';
    this.suppressed = false;
    this.created = new Date();
    this.modified = new Date();
    
    // Dependencies - features this feature depends on
    this.dependencies = [];
    
    // Result - the geometry or data produced by this feature
    this.result = null;
    
    // Error state
    this.error = null;
  }

  /**
   * Execute this feature to produce geometry.
   * Must be implemented by subclasses.
   * @param {Object} context - Execution context with previous feature results
   * @returns {Object} Result object with geometry and metadata
   */
  execute(context) {
    throw new Error('Feature.execute() must be implemented by subclass');
  }

  /**
   * Check if this feature can be executed given the current context.
   * @param {Object} context - Execution context
   * @returns {boolean} True if the feature can execute
   */
  canExecute(context) {
    // Check all dependencies are satisfied
    for (const depId of this.dependencies) {
      if (!context.results[depId] || context.results[depId].error) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get all features this feature depends on (direct dependencies only).
   * @returns {string[]} Array of feature IDs
   */
  getDependencies() {
    return [...this.dependencies];
  }

  /**
   * Add a dependency to this feature.
   * @param {string} featureId - ID of the feature to depend on
   */
  addDependency(featureId) {
    if (!this.dependencies.includes(featureId)) {
      this.dependencies.push(featureId);
      this.modified = new Date();
    }
  }

  /**
   * Remove a dependency from this feature.
   * @param {string} featureId - ID of the feature to remove
   */
  removeDependency(featureId) {
    const idx = this.dependencies.indexOf(featureId);
    if (idx >= 0) {
      this.dependencies.splice(idx, 1);
      this.modified = new Date();
    }
  }

  /**
   * Suppress this feature (disable it temporarily).
   */
  suppress() {
    this.suppressed = true;
    this.modified = new Date();
  }

  /**
   * Unsuppress this feature (enable it).
   */
  unsuppress() {
    this.suppressed = false;
    this.modified = new Date();
  }

  /**
   * Serialize this feature to JSON.
   */
  serialize() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      suppressed: this.suppressed,
      created: this.created.toISOString(),
      modified: this.modified.toISOString(),
      dependencies: this.dependencies,
    };
  }

  /**
   * Deserialize a feature from JSON.
   * Must be implemented by subclasses to restore feature-specific data.
   */
  static deserialize(data) {
    const feature = new Feature();
    if (!data) return feature;
    
    feature.id = data.id || feature.id;
    feature.name = data.name || 'Feature';
    feature.type = data.type || 'base';
    feature.suppressed = data.suppressed || false;
    feature.created = data.created ? new Date(data.created) : new Date();
    feature.modified = data.modified ? new Date(data.modified) : new Date();
    feature.dependencies = data.dependencies || [];
    
    return feature;
  }
}

/**
 * Reset the feature ID counter (useful for testing).
 */
export function resetFeatureIds() {
  nextFeatureId = 1;
}

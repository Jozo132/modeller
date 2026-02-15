// js/cad/FeatureTree.js — Manages the parametric feature tree
// The feature tree maintains an ordered list of features and handles:
// - Feature execution in dependency order
// - Recursive recalculation when features change
// - Dependency validation
// - Feature reordering

import { Feature } from './Feature.js';

/**
 * FeatureTree manages the ordered list of parametric features.
 * When a feature is modified, all dependent features are automatically recalculated.
 */
export class FeatureTree {
  constructor() {
    // Ordered list of features
    this.features = [];
    
    // Map of feature ID to feature object for fast lookup
    this.featureMap = new Map();
    
    // Execution results cache
    this.results = {};
    
    // Recalculation state
    this.isRecalculating = false;
    this.needsRecalculation = false;
  }

  // -----------------------------------------------------------------------
  // Feature management
  // -----------------------------------------------------------------------

  /**
   * Add a feature to the tree.
   * @param {Feature} feature - The feature to add
   * @param {number} index - Optional index to insert at (default: append)
   * @returns {Feature} The added feature
   */
  addFeature(feature, index = -1) {
    if (!feature) return null;
    
    // Validate dependencies exist
    for (const depId of feature.getDependencies()) {
      if (!this.featureMap.has(depId)) {
        throw new Error(`Cannot add feature ${feature.name}: dependency ${depId} not found`);
      }
    }
    
    // Add to tree
    if (index >= 0 && index < this.features.length) {
      this.features.splice(index, 0, feature);
    } else {
      this.features.push(feature);
    }
    
    this.featureMap.set(feature.id, feature);
    
    // Recalculate from this feature onward
    this.recalculateFrom(feature.id);
    
    return feature;
  }

  /**
   * Remove a feature from the tree.
   * @param {string|Feature} featureOrId - Feature or feature ID to remove
   * @returns {boolean} True if removed
   */
  removeFeature(featureOrId) {
    const featureId = typeof featureOrId === 'string' ? featureOrId : featureOrId.id;
    const feature = this.featureMap.get(featureId);
    
    if (!feature) return false;
    
    // Check if any other features depend on this one
    const dependents = this.getDependents(featureId);
    if (dependents.length > 0) {
      const names = dependents.map(f => f.name).join(', ');
      throw new Error(`Cannot remove feature ${feature.name}: other features depend on it (${names})`);
    }
    
    // Remove from tree
    const idx = this.features.indexOf(feature);
    if (idx >= 0) {
      this.features.splice(idx, 1);
    }
    
    this.featureMap.delete(featureId);
    delete this.results[featureId];
    
    return true;
  }

  /**
   * Get a feature by ID.
   * @param {string} featureId - The feature ID
   * @returns {Feature|null} The feature or null if not found
   */
  getFeature(featureId) {
    return this.featureMap.get(featureId) || null;
  }

  /**
   * Get the index of a feature in the tree.
   * @param {string|Feature} featureOrId - Feature or feature ID
   * @returns {number} Index or -1 if not found
   */
  getFeatureIndex(featureOrId) {
    const featureId = typeof featureOrId === 'string' ? featureOrId : featureOrId.id;
    const feature = this.featureMap.get(featureId);
    return feature ? this.features.indexOf(feature) : -1;
  }

  /**
   * Reorder a feature in the tree.
   * @param {string|Feature} featureOrId - Feature or feature ID to move
   * @param {number} newIndex - New index position
   * @returns {boolean} True if reordered
   */
  reorderFeature(featureOrId, newIndex) {
    const featureId = typeof featureOrId === 'string' ? featureOrId : featureOrId.id;
    const feature = this.featureMap.get(featureId);
    
    if (!feature) return false;
    
    const oldIndex = this.features.indexOf(feature);
    if (oldIndex < 0 || newIndex < 0 || newIndex >= this.features.length) {
      return false;
    }
    
    // Validate reordering won't break dependencies
    if (!this.canReorder(featureId, newIndex)) {
      throw new Error(`Cannot reorder feature ${feature.name}: would break dependencies`);
    }
    
    // Perform reorder
    this.features.splice(oldIndex, 1);
    this.features.splice(newIndex, 0, feature);
    
    // Recalculate from the earlier of the two positions
    const recalcFrom = Math.min(oldIndex, newIndex);
    if (recalcFrom < this.features.length) {
      this.recalculateFrom(this.features[recalcFrom].id);
    }
    
    return true;
  }

  /**
   * Check if a feature can be reordered to a new position.
   * @param {string} featureId - Feature ID
   * @param {number} newIndex - Proposed new index
   * @returns {boolean} True if reordering is valid
   */
  canReorder(featureId, newIndex) {
    const feature = this.featureMap.get(featureId);
    if (!feature) return false;
    
    // Check all dependencies come before the new position
    for (const depId of feature.getDependencies()) {
      const depIndex = this.getFeatureIndex(depId);
      if (depIndex >= newIndex) {
        return false; // Dependency would be after this feature
      }
    }
    
    // Check all dependents come after the new position
    const dependents = this.getDependents(featureId);
    for (const dependent of dependents) {
      const depIndex = this.features.indexOf(dependent);
      if (depIndex <= newIndex) {
        return false; // Dependent would be before this feature
      }
    }
    
    return true;
  }

  // -----------------------------------------------------------------------
  // Dependency tracking
  // -----------------------------------------------------------------------

  /**
   * Get all features that depend on a given feature (direct dependents only).
   * @param {string} featureId - The feature ID
   * @returns {Feature[]} Array of dependent features
   */
  getDependents(featureId) {
    return this.features.filter(f => 
      f.getDependencies().includes(featureId)
    );
  }

  /**
   * Get all features that a given feature depends on (transitive closure).
   * @param {string} featureId - The feature ID
   * @returns {Feature[]} Array of dependency features in execution order
   */
  getAllDependencies(featureId) {
    const feature = this.featureMap.get(featureId);
    if (!feature) return [];
    
    const visited = new Set();
    const result = [];
    
    const visit = (f) => {
      if (visited.has(f.id)) return;
      visited.add(f.id);
      
      for (const depId of f.getDependencies()) {
        const dep = this.featureMap.get(depId);
        if (dep) {
          visit(dep);
        }
      }
      
      result.push(f);
    };
    
    visit(feature);
    
    // Remove the feature itself from the result
    return result.slice(0, -1);
  }

  /**
   * Get all features that depend on a given feature (transitive closure).
   * @param {string} featureId - The feature ID
   * @returns {Feature[]} Array of dependent features
   */
  getAllDependents(featureId) {
    const visited = new Set();
    const result = [];
    
    const visit = (fid) => {
      const dependents = this.getDependents(fid);
      for (const dep of dependents) {
        if (!visited.has(dep.id)) {
          visited.add(dep.id);
          result.push(dep);
          visit(dep.id);
        }
      }
    };
    
    visit(featureId);
    return result;
  }

  // -----------------------------------------------------------------------
  // Execution and recalculation
  // -----------------------------------------------------------------------

  /**
   * Execute all features in the tree.
   * @returns {Object} Execution results
   */
  executeAll() {
    this.results = {};
    
    for (const feature of this.features) {
      if (feature.suppressed) {
        this.results[feature.id] = { suppressed: true };
        continue;
      }
      
      try {
        const context = { results: this.results, tree: this };
        
        if (!feature.canExecute(context)) {
          feature.error = 'Dependencies not satisfied';
          this.results[feature.id] = { error: feature.error };
          continue;
        }
        
        const result = feature.execute(context);
        feature.result = result;
        feature.error = null;
        this.results[feature.id] = result;
      } catch (error) {
        feature.error = error.message;
        this.results[feature.id] = { error: error.message };
        console.error(`Error executing feature ${feature.name}:`, error);
      }
    }
    
    return this.results;
  }

  /**
   * Recalculate all features starting from a specific feature.
   * @param {string|Feature} featureOrId - Feature or feature ID to start from
   */
  recalculateFrom(featureOrId) {
    if (this.isRecalculating) {
      this.needsRecalculation = true;
      return;
    }
    
    this.isRecalculating = true;
    
    const featureId = typeof featureOrId === 'string' ? featureOrId : featureOrId.id;
    const startIndex = this.getFeatureIndex(featureId);
    
    if (startIndex < 0) {
      this.isRecalculating = false;
      return;
    }
    
    // Execute features from startIndex onward
    for (let i = startIndex; i < this.features.length; i++) {
      const feature = this.features[i];
      
      if (feature.suppressed) {
        this.results[feature.id] = { suppressed: true };
        continue;
      }
      
      try {
        const context = { results: this.results, tree: this };
        
        if (!feature.canExecute(context)) {
          feature.error = 'Dependencies not satisfied';
          this.results[feature.id] = { error: feature.error };
          continue;
        }
        
        const result = feature.execute(context);
        feature.result = result;
        feature.error = null;
        this.results[feature.id] = result;
      } catch (error) {
        feature.error = error.message;
        this.results[feature.id] = { error: error.message };
        console.error(`Error executing feature ${feature.name}:`, error);
      }
    }
    
    this.isRecalculating = false;
    
    // If recalculation was requested during execution, do it now
    if (this.needsRecalculation) {
      this.needsRecalculation = false;
      this.executeAll();
    }
  }

  /**
   * Mark a feature as modified and trigger recalculation.
   * @param {string|Feature} featureOrId - Feature or feature ID that changed
   */
  markModified(featureOrId) {
    const featureId = typeof featureOrId === 'string' ? featureOrId : featureOrId.id;
    const feature = this.featureMap.get(featureId);
    
    if (feature) {
      feature.modified = new Date();
      this.recalculateFrom(featureId);
    }
  }

  // -----------------------------------------------------------------------
  // Utility methods
  // -----------------------------------------------------------------------

  /**
   * Clear all features from the tree.
   */
  clear() {
    this.features = [];
    this.featureMap.clear();
    this.results = {};
  }

  /**
   * Get the final geometry result (last non-suppressed feature result).
   * @returns {Object|null} The final result or null
   */
  getFinalResult() {
    for (let i = this.features.length - 1; i >= 0; i--) {
      const feature = this.features[i];
      if (!feature.suppressed && this.results[feature.id] && !this.results[feature.id].error) {
        return this.results[feature.id];
      }
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  /**
   * Serialize the feature tree to JSON.
   */
  serialize() {
    return {
      features: this.features.map(f => f.serialize()),
    };
  }

  /**
   * Deserialize a feature tree from JSON.
   * Note: Features must be deserialized by their specific subclasses.
   */
  static deserialize(data, featureFactory) {
    const tree = new FeatureTree();
    if (!data || !data.features) return tree;
    
    // Deserialize features in order
    for (const featureData of data.features) {
      const feature = featureFactory(featureData);
      if (feature) {
        tree.features.push(feature);
        tree.featureMap.set(feature.id, feature);
      }
    }
    
    // Execute all features to rebuild results
    tree.executeAll();
    
    return tree;
  }
}

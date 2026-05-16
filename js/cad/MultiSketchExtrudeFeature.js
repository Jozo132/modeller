// js/cad/MultiSketchExtrudeFeature.js — Extrude multiple sketches on different planes and union
//
// Allows the user to reference two or more sketch features that may live on
// different planes (any orientation), extrude each one, and boolean-union the
// resulting bodies into a single solid.

import { Feature } from './Feature.js';
import { ExtrudeFeature } from './ExtrudeFeature.js';
import { booleanOp } from './BooleanDispatch.js';
import { computeFeatureEdges } from './EdgeAnalysis.js';
import { calculateMeshVolume, calculateBoundingBox } from './toolkit/MeshAnalysis.js';
import { getFlag } from '../featureFlags.js';

/**
 * MultiSketchExtrudeFeature extrudes multiple sketch profiles on independent
 * planes and unions the resulting bodies into a single solid.
 *
 * Each entry in `sketchEntries` looks like:
 *   { sketchFeatureId: string, distance: number, direction: 1 | -1 }
 *
 * The first entry's body forms the base; subsequent entries are unioned in.
 */
export class MultiSketchExtrudeFeature extends Feature {
  constructor(name = 'Multi-Sketch Extrude') {
    super(name);
    this.type = 'multi-sketch-extrude';

    /**
     * Array of extrude specs:
     *   { sketchFeatureId, distance, direction }
     */
    this.sketchEntries = [];

    /** Operation against the prior solid in the feature tree. */
    this.operation = 'new'; // 'new' | 'add' | 'subtract' | 'intersect'
  }

  // -----------------------------------------------------------------------
  // Entry management
  // -----------------------------------------------------------------------

  /**
   * Add a sketch entry to be extruded.
   * @param {string} sketchFeatureId
   * @param {number} [distance=10]
   * @param {number} [direction=1]
   */
  addSketchEntry(sketchFeatureId, distance = 10, direction = 1) {
    this.sketchEntries.push({ sketchFeatureId, distance, direction });
    this.addDependency(sketchFeatureId);
    this.modified = new Date();
  }

  /**
   * Remove a sketch entry by index.
   */
  removeSketchEntry(index) {
    if (index < 0 || index >= this.sketchEntries.length) return;
    const entry = this.sketchEntries[index];
    this.sketchEntries.splice(index, 1);
    // Remove dependency if no other entry uses the same sketch
    if (!this.sketchEntries.some(e => e.sketchFeatureId === entry.sketchFeatureId)) {
      this.removeDependency(entry.sketchFeatureId);
    }
    this.modified = new Date();
  }

  // -----------------------------------------------------------------------
  // Execute
  // -----------------------------------------------------------------------

  execute(context) {
    if (this.sketchEntries.length === 0) {
      throw new Error('No sketch entries defined for multi-sketch extrude');
    }

    let combinedSolid = null;

    for (const entry of this.sketchEntries) {
      const sketchResult = context.results[entry.sketchFeatureId];
      if (!sketchResult || sketchResult.type !== 'sketch') {
        throw new Error(`Sketch feature '${entry.sketchFeatureId}' not found or invalid`);
      }

      if (sketchResult.profiles.length === 0) continue;

      // Create a temporary extrude to generate geometry for this sketch
      const tempExtrude = new ExtrudeFeature('_temp', null, entry.distance);
      tempExtrude.direction = entry.direction;
      tempExtrude.operation = 'new'; // always 'new' — we union ourselves

      const bodyGeom = tempExtrude.generateGeometry(sketchResult.profiles, sketchResult.plane);
      if (!bodyGeom || !bodyGeom.faces || bodyGeom.faces.length === 0) continue;

      // Tag faces
      for (const f of bodyGeom.faces) {
        if (!f.shared) f.shared = { sourceFeatureId: this.id };
      }

      if (!combinedSolid) {
        const edgeResult = computeFeatureEdges(bodyGeom.faces);
        bodyGeom.edges = edgeResult.edges;
        bodyGeom.paths = edgeResult.paths;
        bodyGeom.visualEdges = edgeResult.visualEdges;
        combinedSolid = { geometry: bodyGeom };
      } else {
        try {
          const booleanOpts = getFlag('CAD_USE_OCCT_SKETCH_SOLIDS') === true
            ? { preferOcctPrimary: true }
            : null;
          const resultGeom = booleanOp(
            combinedSolid.geometry, bodyGeom, 'union',
            null, { sourceFeatureId: this.id }, booleanOpts);
          combinedSolid = { geometry: resultGeom };
        } catch (err) {
          console.warn('Multi-sketch extrude union failed:', err.message);
        }
      }
    }

    if (!combinedSolid) {
      throw new Error('No valid geometry produced from sketch entries');
    }

    // Apply operation against prior solid in the tree
    let solid = this._getPreviousSolid(context);
    if (solid && this.operation !== 'new') {
      try {
        const booleanOpts = getFlag('CAD_USE_OCCT_SKETCH_SOLIDS') === true
          ? { preferOcctPrimary: true }
          : null;
        const resultGeom = booleanOp(
          solid.geometry, combinedSolid.geometry, this.operation,
          null, { sourceFeatureId: this.id }, booleanOpts);
        combinedSolid = { geometry: resultGeom };
      } catch (err) {
        console.warn(`Multi-sketch boolean '${this.operation}' failed:`, err.message);
      }
    }

    const finalGeometry = combinedSolid.geometry;
    return {
      type: 'solid',
      geometry: finalGeometry,
      solid: combinedSolid,
      volume: calculateMeshVolume(finalGeometry),
      boundingBox: calculateBoundingBox(finalGeometry),
    };
  }

  _getPreviousSolid(context) {
    if (this.operation === 'new') return null;
    const thisIndex = context.tree.getFeatureIndex(this.id);
    for (let i = thisIndex - 1; i >= 0; i--) {
      const feature = context.tree.features[i];
      const result = context.results[feature.id];
      if (result && result.type === 'solid' && !result.error) {
        return result.solid;
      }
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  serialize() {
    return {
      ...super.serialize(),
      sketchEntries: this.sketchEntries.map(e => ({ ...e })),
      operation: this.operation,
    };
  }

  static deserialize(data) {
    const feature = new MultiSketchExtrudeFeature();
    if (!data) return feature;
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'multi-sketch-extrude';
    feature.operation = data.operation || 'new';
    feature.sketchEntries = (data.sketchEntries || []).map(e => ({
      sketchFeatureId: e.sketchFeatureId,
      distance: e.distance || 10,
      direction: e.direction || 1,
    }));
    // Rebuild dependency links
    for (const entry of feature.sketchEntries) {
      if (entry.sketchFeatureId && !feature.dependencies.includes(entry.sketchFeatureId)) {
        feature.dependencies.push(entry.sketchFeatureId);
      }
    }
    return feature;
  }
}

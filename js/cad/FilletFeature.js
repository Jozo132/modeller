// js/cad/FilletFeature.js — Fillet operation feature
// Applies a rounded edge to selected edges of a 3D solid

import { Feature } from './Feature.js';
import { applyFillet, calculateMeshVolume, calculateBoundingBox, expandPathEdgeKeys } from './CSG.js';

export class FilletFeature extends Feature {
  constructor(name = 'Fillet', radius = 1) {
    super(name);
    this.type = 'fillet';
    this.radius = radius;
    this.segments = 8; // Arc tessellation segments
    // Edge keys are vertex-position-based strings identifying the edges to fillet
    this.edgeKeys = [];
  }

  execute(context) {
    const solid = this._getPreviousSolid(context);
    if (!solid || !solid.geometry || !solid.geometry.faces) {
      throw new Error('No solid body found to fillet');
    }

    if (this.edgeKeys.length === 0) {
      throw new Error('No edges selected for fillet');
    }

    // Expand path-level keys to individual face-edge keys
    const resolvedKeys = expandPathEdgeKeys(solid.geometry, this.edgeKeys);
    const geometry = applyFillet(solid.geometry, resolvedKeys, this.radius, this.segments);

    // Tag faces with source feature
    for (const f of geometry.faces) {
      if (!f.shared) f.shared = {};
    }

    return {
      type: 'solid',
      geometry,
      solid: { geometry },
      volume: calculateMeshVolume(geometry),
      boundingBox: calculateBoundingBox(geometry),
      brep: geometry.brep || null,
    };
  }

  _getPreviousSolid(context) {
    const thisIndex = context.tree.getFeatureIndex(this.id);
    for (let i = thisIndex - 1; i >= 0; i--) {
      const feature = context.tree.features[i];
      if (feature.suppressed) continue;
      const result = context.results[feature.id];
      if (result && result.type === 'solid' && !result.error) {
        return result.solid;
      }
    }
    return null;
  }

  setRadius(radius) {
    this.radius = Math.max(0.01, radius);
    this.modified = new Date();
  }

  setSegments(segments) {
    this.segments = Math.max(2, Math.min(32, Math.round(segments)));
    this.modified = new Date();
  }

  setEdgeKeys(keys) {
    this.edgeKeys = [...keys];
    this.modified = new Date();
  }

  serialize() {
    return {
      ...super.serialize(),
      radius: this.radius,
      segments: this.segments,
      edgeKeys: [...this.edgeKeys],
    };
  }

  static deserialize(data) {
    const feature = new FilletFeature();
    if (!data) return feature;
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'fillet';
    feature.radius = data.radius || 1;
    feature.segments = data.segments || 8;
    feature.edgeKeys = Array.isArray(data.edgeKeys) ? [...data.edgeKeys] : [];
    return feature;
  }
}

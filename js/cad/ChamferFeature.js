// js/cad/ChamferFeature.js — Chamfer operation feature
// Applies a flat bevel to selected edges of a 3D solid

import { Feature } from './Feature.js';
import { applyChamfer, calculateMeshVolume, calculateBoundingBox, expandPathEdgeKeys } from './CSG.js';

export class ChamferFeature extends Feature {
  constructor(name = 'Chamfer', distance = 1) {
    super(name);
    this.type = 'chamfer';
    this.distance = distance;
    // Edge keys are vertex-position-based strings identifying the edges to chamfer
    this.edgeKeys = [];
  }

  execute(context) {
    const solid = this._getPreviousSolid(context);
    if (!solid || !solid.geometry || !solid.geometry.faces) {
      throw new Error('No solid body found to chamfer');
    }

    if (this.edgeKeys.length === 0) {
      throw new Error('No edges selected for chamfer');
    }

    // Expand path-level keys to individual face-edge keys
    const resolvedKeys = expandPathEdgeKeys(solid.geometry, this.edgeKeys);
    const geometry = applyChamfer(solid.geometry, resolvedKeys, this.distance);

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

  setDistance(distance) {
    this.distance = Math.max(0.01, distance);
    this.modified = new Date();
  }

  setEdgeKeys(keys) {
    this.edgeKeys = [...keys];
    this.modified = new Date();
  }

  serialize() {
    return {
      ...super.serialize(),
      distance: this.distance,
      edgeKeys: [...this.edgeKeys],
    };
  }

  static deserialize(data) {
    const feature = new ChamferFeature();
    if (!data) return feature;
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'chamfer';
    feature.distance = data.distance || 1;
    feature.edgeKeys = Array.isArray(data.edgeKeys) ? [...data.edgeKeys] : [];
    return feature;
  }
}

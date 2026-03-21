// js/cad/ExtrudeCutFeature.js — Extrude Cut operation feature
// Cuts geometry by extruding a 2D sketch profile (subtract)

import { Feature } from './Feature.js';
import { ExtrudeFeature } from './ExtrudeFeature.js';

/**
 * ExtrudeCutFeature is an extrude that defaults to subtract/reverse direction.
 */
export class ExtrudeCutFeature extends ExtrudeFeature {
  constructor(name = 'Extrude Cut', sketchFeatureId = null, distance = 10) {
    super(name, sketchFeatureId, distance);
    this.type = 'extrude-cut';
    this.direction = -1;
    this.operation = 'subtract';
  }

  /**
   * Serialize this extrude-cut feature.
   */
  serialize() {
    const data = super.serialize();
    data.type = 'extrude-cut';
    return data;
  }

  /**
   * Deserialize an extrude-cut feature from JSON.
   */
  static deserialize(data) {
    const feature = new ExtrudeCutFeature();
    if (!data) return feature;

    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'extrude-cut';

    feature.sketchFeatureId = data.sketchFeatureId || null;
    feature.distance = data.distance || 10;
    feature.direction = data.direction || -1;
    feature.symmetric = data.symmetric || false;
    feature.operation = data.operation || 'subtract';
    feature.extrudeType = data.extrudeType || 'distance';
    feature.taper = data.taper || false;
    feature.taperAngle = data.taperAngle != null ? data.taperAngle : 5;
    feature.taperInward = data.taperInward != null ? data.taperInward : true;

    return feature;
  }
}

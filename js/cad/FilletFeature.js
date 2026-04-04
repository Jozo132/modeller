// js/cad/FilletFeature.js — Fillet operation feature
// Applies a rounded edge to selected edges of a 3D solid.
//
// Topology-first: consumes the previous solid (TopoBody when available),
// outputs geometry that preserves the topology chain for downstream
// features. Selection uses stable entity keys when present.

import { Feature } from './Feature.js';
import { applyBRepFillet } from './BRepFillet.js';
import { expandPathEdgeKeys } from './EdgeAnalysis.js';
import { calculateMeshVolume, calculateBoundingBox } from './toolkit/MeshAnalysis.js';
import { isLegacyEdgeKey, legacyEdgeKeyToStable } from './history/StableEntityKey.js';

export class FilletFeature extends Feature {
  constructor(name = 'Fillet', radius = 1) {
    super(name);
    this.type = 'fillet';
    this.radius = radius;
    this.segments = 8; // Arc tessellation segments
    // Edge keys are vertex-position-based strings identifying the edges to fillet
    this.edgeKeys = [];
    // Stable entity keys (populated on new workflows, empty on legacy projects)
    this.stableEdgeKeys = [];
    // Whether this feature result was produced by the exact topology path
    this._resultExact = false;
  }

  execute(context) {
    const { solid, edgeKeys, edgeOwnerMap } = this._resolveFilletExecutionInput(context);
    if (!solid || !solid.geometry || !solid.geometry.faces) {
      throw new Error('No solid body found to fillet');
    }

    if (edgeKeys.length === 0) {
      throw new Error('No edges selected for fillet');
    }

    // BRep-only pipeline: require exact topology
    const inputTopoBody = solid.body || (solid.geometry && solid.geometry.topoBody) || null;
    if (!inputTopoBody) {
      throw new Error(
        '[BRep-only] FilletFeature requires exact topology (TopoBody) on the input solid. ' +
        'Legacy mesh-based fillet is no longer supported.'
      );
    }

    const exactInputGeometry = { ...solid.geometry, topoBody: inputTopoBody };
    const geometry = applyBRepFillet(exactInputGeometry, edgeKeys, this.radius, this.segments);
    if (!geometry) {
      throw new Error(
        '[BRep-only] applyBRepFillet returned null — the BRep fillet path failed. ' +
        'This must be fixed in the BRep kernel, not by falling back to mesh fillet.'
      );
    }

    // Tag faces with source feature
    for (const f of geometry.faces) {
      if (!f.shared) f.shared = {};
    }

    const resultTopoBody = geometry.topoBody || null;
    this._resultExact = !!resultTopoBody;

    return {
      type: 'solid',
      geometry,
      solid: { geometry, body: resultTopoBody },
      volume: calculateMeshVolume(geometry),
      boundingBox: calculateBoundingBox(geometry),
      brep: geometry.brep || null,
      _exactTopology: this._resultExact,
    };
  }

  _getPreviousSolid(context) {
    const thisIndex = context.tree.getFeatureIndex(this.id);
    return this._getPreviousSolidBeforeIndex(context, thisIndex);
  }

  _getPreviousSolidBeforeIndex(context, featureIndex) {
    for (let i = featureIndex - 1; i >= 0; i--) {
      const feature = context.tree.features[i];
      if (feature.suppressed) continue;
      const result = context.results[feature.id];
      if (result && result.type === 'solid' && !result.error) {
        return result.solid;
      }
    }
    return null;
  }

  _resolveFilletExecutionInput(context) {
    const thisIndex = context.tree.getFeatureIndex(this.id);
    const mergedKeys = [...this.edgeKeys];
    const edgeOwnerMap = {};
    for (const key of this.edgeKeys) edgeOwnerMap[key] = this.id;
    let earliestMergeIndex = thisIndex;
    let mergedAny = false;

    for (let i = thisIndex - 1; i >= 0; i--) {
      const feature = context.tree.features[i];
      if (!feature || feature.suppressed) continue;
      if (feature.type !== 'fillet') break;
      if (Math.abs((feature.radius || 0) - this.radius) > 1e-6) break;
      if ((feature.segments || 8) !== this.segments) break;
      if (!this._edgeSetsNearby(mergedKeys, feature.edgeKeys || [], this.radius * 1.5 + 1e-6)) break;
      mergedKeys.push(...feature.edgeKeys);
      for (const key of feature.edgeKeys || []) {
        if (!edgeOwnerMap[key]) edgeOwnerMap[key] = feature.id;
      }
      earliestMergeIndex = i;
      mergedAny = true;
    }

    const solid = mergedAny
      ? this._getPreviousSolidBeforeIndex(context, earliestMergeIndex)
      : this._getPreviousSolid(context);

    return {
      solid,
      edgeKeys: [...new Set(mergedKeys)],
      edgeOwnerMap,
    };
  }

  _edgeSetsNearby(edgeKeysA, edgeKeysB, tol) {
    const pointsA = this._collectEdgeKeyPoints(edgeKeysA);
    const pointsB = this._collectEdgeKeyPoints(edgeKeysB);
    for (const a of pointsA) {
      for (const b of pointsB) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        if ((dx * dx + dy * dy + dz * dz) <= tol * tol) return true;
      }
    }
    return false;
  }

  _collectEdgeKeyPoints(edgeKeys) {
    const points = [];
    for (const key of edgeKeys || []) {
      const sep = key.indexOf('|');
      if (sep < 0) continue;
      const parsePoint = (text) => {
        const coords = text.split(',').map(Number);
        if (coords.length !== 3 || coords.some((value) => Number.isNaN(value))) return null;
        return { x: coords[0], y: coords[1], z: coords[2] };
      };
      const pointA = parsePoint(key.slice(0, sep));
      const pointB = parsePoint(key.slice(sep + 1));
      if (pointA) points.push(pointA);
      if (pointB) points.push(pointB);
    }
    return points;
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
      stableEdgeKeys: [...this.stableEdgeKeys],
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
    feature.stableEdgeKeys = Array.isArray(data.stableEdgeKeys) ? [...data.stableEdgeKeys] : [];
    // Mark legacy projects (no stable keys) so downstream can detect non-exact provenance
    if (feature.stableEdgeKeys.length === 0 && feature.edgeKeys.length > 0) {
      feature._legacySelection = true;
      // Migration: convert legacy edge keys to stable keys on load
      feature.stableEdgeKeys = feature.edgeKeys
        .filter(k => isLegacyEdgeKey(k))
        .map(k => legacyEdgeKeyToStable(k, feature.id || ''))
        .filter(k => k !== null);
    }
    return feature;
  }
}

import { Feature } from './Feature.js';
import { booleanOp } from './BooleanDispatch.js';
import { computeFeatureEdges } from './EdgeAnalysis.js';
import { chainEdgePaths } from './toolkit/EdgePathUtils.js';
import { calculateMeshVolume, calculateBoundingBox } from './toolkit/MeshAnalysis.js';
import {
  disposeOcctSketchModelingShape,
  tryBuildOcctLoftGeometrySync,
} from './occt/OcctSketchModeling.js';

export class LoftFeature extends Feature {
  constructor(name = 'Loft', sectionSketchFeatureIds = []) {
    super(name);
    this.type = 'loft';
    this.sectionSketchFeatureIds = [];
    this.operation = 'new';
    this.makeSolid = true;
    this.ruled = false;
    this.continuity = 'C2';
    this.setSectionSketchFeatures(sectionSketchFeatureIds, false);
  }

  execute(context) {
    const sectionSketchResults = [];
    for (const featureId of this.sectionSketchFeatureIds) {
      const result = context.results[featureId];
      if (!result || result.error || result.type !== 'sketch') {
        throw new Error('Loft section sketch not found or has errors');
      }
      sectionSketchResults.push(result);
    }
    if (sectionSketchResults.length < 2) {
      throw new Error('Loft requires at least two section sketches');
    }

    const previousSolid = this.getPreviousSolid(context);
    const previousGeometry = previousSolid?.geometry || null;
    const useResidentOcctFeature = !!previousGeometry?.occtShapeHandle
      && (this.operation === 'add' || this.operation === 'subtract');

    const geometry = tryBuildOcctLoftGeometrySync({
      sectionSketchResults,
      shapeHandle: useResidentOcctFeature ? previousGeometry.occtShapeHandle : 0,
      spec: {
        makeSolid: this.makeSolid,
        ruled: this.ruled,
        continuity: this.continuity,
        cut: this.operation === 'subtract',
      },
    });
    if (!geometry) {
      throw new Error(useResidentOcctFeature
        ? 'Loft requires an OCCT kernel build that can compose loft features onto the current solid'
        : 'Loft requires the structured OCCT kernel and closed section sketches');
    }

    if (useResidentOcctFeature) {
      this._attachEdges(geometry);
      return {
        type: 'solid',
        geometry,
        solid: { geometry },
        volume: calculateMeshVolume(geometry),
        boundingBox: calculateBoundingBox(geometry),
      };
    }

    const solid = this.applyOperation(previousSolid, geometry);
    const finalGeometry = solid.geometry;
    return {
      type: 'solid',
      geometry: finalGeometry,
      solid,
      volume: calculateMeshVolume(finalGeometry),
      boundingBox: calculateBoundingBox(finalGeometry),
    };
  }

  getPreviousSolid(context) {
    if (this.operation === 'new') return null;
    const thisIndex = context.tree.getFeatureIndex(this.id);
    for (let index = thisIndex - 1; index >= 0; index--) {
      const feature = context.tree.features[index];
      const result = context.results[feature.id];
      if (result && result.type === 'solid' && !result.error) return result.solid;
    }
    return null;
  }

  applyOperation(solid, geometry) {
    if (this.operation === 'new' || !solid?.geometry) {
      this._attachEdges(geometry);
      return { geometry };
    }
    try {
      const resultGeom = booleanOp(solid.geometry, geometry, this.operation);
      this._disposeTemporaryOcctGeometry(geometry, resultGeom.occtShapeHandle || 0);
      return { geometry: resultGeom };
    } catch (error) {
      this._disposeTemporaryOcctGeometry(geometry);
      console.warn(`Loft boolean operation '${this.operation}' failed:`, error.message);
      return solid;
    }
  }

  _attachEdges(geometry) {
    if (!geometry?.faces) return;
    const edgeResult = computeFeatureEdges(geometry.faces);
    const useOcctEdges = geometry._occtModeling?.authoritative === true
      && Array.isArray(geometry.edges)
      && geometry.edges.length > 0;
    geometry.edges = useOcctEdges ? geometry.edges : edgeResult.edges;
    geometry.paths = useOcctEdges ? chainEdgePaths(geometry.edges) : edgeResult.paths;
    geometry.visualEdges = edgeResult.visualEdges;
  }

  _disposeTemporaryOcctGeometry(geometry, keepHandle = 0) {
    const handle = geometry?.occtShapeHandle || 0;
    if (!handle || handle === keepHandle) return;
    disposeOcctSketchModelingShape(handle);
    geometry.occtShapeHandle = 0;
    geometry.occtShapeResident = false;
  }

  setSectionSketchFeatures(featureIds, touchModified = true) {
    for (const featureId of this.sectionSketchFeatureIds || []) this.removeDependency(featureId);
    this.sectionSketchFeatureIds = [...new Set((featureIds || []).filter(Boolean))];
    for (const featureId of this.sectionSketchFeatureIds) this.addDependency(featureId);
    if (touchModified) this.modified = new Date();
  }

  setSectionSketchFeature(index, featureId) {
    const next = [...this.sectionSketchFeatureIds];
    next[index] = featureId || null;
    this.setSectionSketchFeatures(next.filter(Boolean));
  }

  serialize() {
    return {
      ...super.serialize(),
      sectionSketchFeatureIds: this.sectionSketchFeatureIds,
      operation: this.operation,
      makeSolid: this.makeSolid,
      ruled: this.ruled,
      continuity: this.continuity,
    };
  }

  static deserialize(data) {
    const feature = new LoftFeature();
    if (!data) return feature;
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'loft';
    feature.sectionSketchFeatureIds = Array.isArray(data.sectionSketchFeatureIds) ? data.sectionSketchFeatureIds : [];
    feature.operation = data.operation || 'new';
    feature.makeSolid = data.makeSolid !== false;
    feature.ruled = data.ruled === true;
    feature.continuity = data.continuity || 'C2';
    return feature;
  }
}
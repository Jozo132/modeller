import { Feature } from './Feature.js';
import { booleanOp } from './BooleanDispatch.js';
import { computeFeatureEdges } from './EdgeAnalysis.js';
import { chainEdgePaths } from './toolkit/EdgePathUtils.js';
import { calculateMeshVolume, calculateBoundingBox } from './toolkit/MeshAnalysis.js';
import {
  disposeOcctSketchModelingShape,
  tryBuildOcctSweepGeometrySync,
} from './occt/OcctSketchModeling.js';

export class SweepFeature extends Feature {
  constructor(name = 'Sweep', profileSketchFeatureId = null, pathSketchFeatureId = null) {
    super(name);
    this.type = 'sweep';
    this.profileSketchFeatureId = profileSketchFeatureId;
    this.pathSketchFeatureId = pathSketchFeatureId;
    this.operation = 'new';
    this.makeSolid = true;
    this.mode = 'frenet';
    if (profileSketchFeatureId) this.addDependency(profileSketchFeatureId);
    if (pathSketchFeatureId) this.addDependency(pathSketchFeatureId);
  }

  execute(context) {
    const profileSketchResult = context.results[this.profileSketchFeatureId];
    const pathSketchResult = context.results[this.pathSketchFeatureId];
    if (!profileSketchResult || profileSketchResult.error || profileSketchResult.type !== 'sketch') {
      throw new Error('Sweep profile sketch not found or has errors');
    }
    if (!pathSketchResult || pathSketchResult.error || pathSketchResult.type !== 'sketch') {
      throw new Error('Sweep path sketch not found or has errors');
    }

    const previousSolid = this.getPreviousSolid(context);
    const previousGeometry = previousSolid?.geometry || null;
    const useResidentOcctFeature = !!previousGeometry?.occtShapeHandle
      && (this.operation === 'add' || this.operation === 'subtract');

    const geometry = tryBuildOcctSweepGeometrySync({
      profileSketchResult,
      pathSketchResult,
      shapeHandle: useResidentOcctFeature ? previousGeometry.occtShapeHandle : 0,
      spec: {
        makeSolid: this.makeSolid,
        mode: this.mode,
        cut: this.operation === 'subtract',
      },
    });
    if (!geometry) {
      throw new Error(useResidentOcctFeature
        ? 'Sweep requires an OCCT kernel build that can compose sweep features onto the current solid'
        : 'Sweep requires the structured OCCT kernel and a closed profile plus a valid path sketch');
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
      console.warn(`Sweep boolean operation '${this.operation}' failed:`, error.message);
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

  setProfileSketchFeature(featureId) {
    if (this.profileSketchFeatureId) this.removeDependency(this.profileSketchFeatureId);
    this.profileSketchFeatureId = featureId || null;
    if (this.profileSketchFeatureId) this.addDependency(this.profileSketchFeatureId);
    this.modified = new Date();
  }

  setPathSketchFeature(featureId) {
    if (this.pathSketchFeatureId) this.removeDependency(this.pathSketchFeatureId);
    this.pathSketchFeatureId = featureId || null;
    if (this.pathSketchFeatureId) this.addDependency(this.pathSketchFeatureId);
    this.modified = new Date();
  }

  serialize() {
    return {
      ...super.serialize(),
      profileSketchFeatureId: this.profileSketchFeatureId,
      pathSketchFeatureId: this.pathSketchFeatureId,
      operation: this.operation,
      makeSolid: this.makeSolid,
      mode: this.mode,
    };
  }

  static deserialize(data) {
    const feature = new SweepFeature();
    if (!data) return feature;
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'sweep';
    feature.profileSketchFeatureId = data.profileSketchFeatureId || null;
    feature.pathSketchFeatureId = data.pathSketchFeatureId || null;
    feature.operation = data.operation || 'new';
    feature.makeSolid = data.makeSolid !== false;
    feature.mode = data.mode || 'frenet';
    return feature;
  }
}
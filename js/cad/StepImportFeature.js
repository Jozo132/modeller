// js/cad/StepImportFeature.js — Imported STEP solid feature
//
// Represents geometry imported from a STEP file as a parametric solid.
// The imported mesh has no internal feature tree, but can be used as a
// base body for subsequent parametric operations (extrude-cut, chamfer,
// fillet, boolean, etc.).

import { Feature, claimFeatureId } from './Feature.js';
import { importSTEP } from './StepImport.js';
import { computeFeatureEdges } from './CSG.js';

/**
 * StepImportFeature represents a solid body imported from a STEP file.
 * It produces a 'solid' result that subsequent features can operate on.
 */
export class StepImportFeature extends Feature {
  /**
   * @param {string} name - Feature name
   * @param {string} stepData - Raw STEP file contents
   * @param {Object} [options]
   * @param {number} [options.curveSegments=16] - Tessellation segments for curves
   */
  constructor(name = 'STEP Import', stepData = '', options = {}) {
    super(name);
    this.type = 'step-import';

    /** Raw STEP file string (stored for re-tessellation / serialization) */
    this.stepData = stepData;

    /** Tessellation quality */
    this.curveSegments = options.curveSegments ?? 16;

    /** Cached parsed mesh (set after first execute) */
    this._cachedMesh = null;
  }

  /**
   * Execute the feature: parse the STEP data and produce solid geometry.
   *
   * @param {Object} _context - Execution context (unused — no dependencies)
   * @returns {{ type:'solid', geometry:Object, solid:Object, volume:number, boundingBox:Object }}
   */
  execute(_context) {
    if (!this.stepData) {
      throw new Error('No STEP data provided');
    }

    // Re-use cached mesh unless segments changed
    if (!this._cachedMesh || this._cachedMesh.curveSegments !== this.curveSegments) {
      const mesh = importSTEP(this.stepData, { curveSegments: this.curveSegments });
      this._cachedMesh = { ...mesh, curveSegments: this.curveSegments };
    }

    const geometry = {
      vertices: this._cachedMesh.vertices,
      faces: this._cachedMesh.faces,
      edges: [],
      paths: [],
      visualEdges: [],
    };

    // Tag faces with this feature's id
    for (const f of geometry.faces) {
      if (!f.shared) f.shared = { sourceFeatureId: this.id };
    }

    // Compute feature edges and face groups for selection support
    const edgeResult = computeFeatureEdges(geometry.faces);
    geometry.edges = edgeResult.edges;
    geometry.paths = edgeResult.paths;
    geometry.visualEdges = edgeResult.visualEdges;

    const volume = this._estimateVolume(geometry);
    const boundingBox = this._computeBoundingBox(geometry);

    return {
      type: 'solid',
      geometry,
      solid: { geometry },
      volume,
      boundingBox,
    };
  }

  /**
   * Estimate volume from the mesh using the divergence theorem.
   */
  _estimateVolume(geometry) {
    let vol = 0;
    for (const face of geometry.faces) {
      const verts = face.vertices;
      if (verts.length < 3) continue;
      // Signed volume of tetrahedron formed with origin
      const a = verts[0], b = verts[1], c = verts[2];
      vol += (a.x * (b.y * c.z - b.z * c.y) +
              a.y * (b.z * c.x - b.x * c.z) +
              a.z * (b.x * c.y - b.y * c.x)) / 6;
    }
    return Math.abs(vol);
  }

  /**
   * Compute axis-aligned bounding box from geometry.
   */
  _computeBoundingBox(geometry) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const face of geometry.faces) {
      for (const v of face.vertices) {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.z < minZ) minZ = v.z;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
        if (v.z > maxZ) maxZ = v.z;
      }
    }

    if (!isFinite(minX)) {
      return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    }

    return {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    };
  }

  // -------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------

  serialize() {
    return {
      ...super.serialize(),
      stepData: this.stepData,
      curveSegments: this.curveSegments,
    };
  }

  static deserialize(data) {
    const feature = new StepImportFeature();
    if (!data) return feature;

    // Restore base feature properties
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'step-import';

    // Restore STEP-specific properties
    feature.stepData = data.stepData || '';
    feature.curveSegments = data.curveSegments ?? 16;

    return feature;
  }
}

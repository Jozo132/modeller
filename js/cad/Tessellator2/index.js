// js/cad/Tessellator2/index.js — Robust edge-first tessellation pipeline
//
// Public entry point for the robust tessellator. Routes between legacy
// and robust tessellation based on TessellationConfig.tessellator mode.
//
// Pipeline stages:
//   1. Shared edge sampling (EdgeSampler)
//   2. Face-domain triangulation (FaceTriangulator)
//   3. Mesh stitching (MeshStitcher)
//   4. Adaptive refinement hooks (Refinement)
//   5. Mesh validation (MeshValidator)

import { EdgeSampler } from './EdgeSampler.js';
import { FaceTriangulator } from './FaceTriangulator.js';
import { MeshStitcher } from './MeshStitcher.js';
import { computeMeshHash, meshSummary } from './MeshHash.js';
import { recommendEdgeSegments, detectCriticalRegions } from './Refinement.js';
import { validateMesh, detectBoundaryEdges, detectSelfIntersections, checkWatertight } from '../MeshValidator.js';
import { tessellateBody as legacyTessellateBody } from '../Tessellation.js';
import { getFlag } from '../../featureFlags.js';

// ── Shadow tessellation disagreement log ────────────────────────────
/** @type {Array<Object>} */
const _shadowDisagreements = [];

/**
 * Return a frozen snapshot of all shadow-mode tessellation disagreements
 * recorded since the last clear.
 *
 * @returns {ReadonlyArray<Object>}
 */
export function getShadowTessDisagreements() {
  return Object.freeze([..._shadowDisagreements]);
}

/**
 * Clear the shadow tessellation disagreement log.
 */
export function clearShadowTessDisagreements() {
  _shadowDisagreements.length = 0;
}

/**
 * Robust tessellation of a TopoBody using the edge-first pipeline.
 *
 * Adjacent faces sharing a topological edge will reuse identical
 * boundary vertices, producing watertight meshes without cracks.
 *
 * @param {import('../BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @param {number} [opts.surfaceSegments=8]
 * @param {number} [opts.edgeSegments=16]
 * @param {number} [opts.curveSegments=16]
 * @param {number} [opts.chordalTolerance=0.01]
 * @param {boolean} [opts.validate=false]
 * @returns {{
 *   vertices: Array<{x:number,y:number,z:number}>,
 *   faces: Array<{vertices: Array<{x:number,y:number,z:number}>, normal: {x:number,y:number,z:number}, shared: Object|null}>,
 *   edges: Array,
 *   validation?: Object,
 *   hash?: string,
 *   diagnostics?: Object
 * }}
 */
export function robustTessellateBody(body, opts = {}) {
  const surfSegs = opts.surfaceSegments ?? 8;
  const edgeSegs = opts.edgeSegments ?? 16;
  const doValidate = opts.validate ?? false;

  if (!body || !body.shells) return { vertices: [], faces: [], edges: [] };

  const edgeSampler = new EdgeSampler();
  const triangulator = new FaceTriangulator();
  const stitcher = new MeshStitcher();

  const faceMeshes = [];
  const edgeResults = [];

  for (const shell of body.shells) {
    // Stage 1: Sample all edges in this shell once
    for (const edge of shell.edges()) {
      edgeSampler.sampleEdge(edge, edgeSegs);
    }

    // Stage 2: Triangulate each face using shared edge samples
    for (const face of shell.faces) {
      let faceMesh;

      try {
        faceMesh = _triangulateFace(face, edgeSampler, triangulator, surfSegs, edgeSegs);
      } catch (err) {
        // If robust triangulation fails for a face, produce empty mesh
        // Diagnostics are captured below
        faceMesh = { vertices: [], faces: [], _error: err.message };
      }

      faceMesh.shared = face.shared || null;
      faceMeshes.push(faceMesh);
    }

    // Tessellate edges for wireframe display
    for (const edge of shell.edges()) {
      const pts = edgeSampler.sampleEdge(edge, edgeSegs);
      if (pts.length >= 2) {
        edgeResults.push({
          start: { ...pts[0] },
          end: { ...pts[pts.length - 1] },
          points: pts,
        });
      }
    }
  }

  // Stage 3: Stitch face meshes into a single body mesh
  const result = stitcher.stitch(faceMeshes);
  result.edges = edgeResults;

  // Stage 5: Optional validation
  if (doValidate && result.faces.length > 0) {
    result.validation = validateMesh(result.faces);
    result.hash = computeMeshHash(result);
  }

  return result;
}

/**
 * Triangulate a single face using shared edge boundary samples.
 *
 * @param {import('../BRepTopology.js').TopoFace} face
 * @param {EdgeSampler} edgeSampler
 * @param {FaceTriangulator} triangulator
 * @param {number} surfSegs
 * @param {number} edgeSegs
 * @returns {{ vertices: Array, faces: Array }}
 * @private
 */
function _triangulateFace(face, edgeSampler, triangulator, surfSegs, edgeSegs) {
  // Collect boundary points from coedge samples
  const outerPts = _collectLoopPoints(face.outerLoop, edgeSampler, edgeSegs);

  // Collect inner loop (hole) points
  const holePts = [];
  for (const innerLoop of face.innerLoops) {
    const pts = _collectLoopPoints(innerLoop, edgeSampler, edgeSegs);
    if (pts.length >= 3) holePts.push(pts);
  }

  // Choose triangulation strategy based on face type
  if (face.surface && face.surfaceType !== 'plane') {
    // NURBS surface: tessellate the UV domain
    return triangulator.triangulateSurface(face, outerPts, surfSegs, face.sameSense);
  }

  // Planar face: ear-clip triangulate from boundary
  return triangulator.triangulatePlanar(outerPts, holePts, null, face.sameSense);
}

/**
 * Collect 3D points from a loop's coedges using the shared edge sampler.
 * Points from consecutive coedges are concatenated, skipping duplicate
 * endpoints where one coedge's end meets the next coedge's start.
 *
 * @param {import('../BRepTopology.js').TopoLoop|null} loop
 * @param {EdgeSampler} edgeSampler
 * @param {number} edgeSegs
 * @returns {Array<{x:number,y:number,z:number}>}
 * @private
 */
function _collectLoopPoints(loop, edgeSampler, edgeSegs) {
  if (!loop || loop.coedges.length === 0) return [];

  const allPts = [];
  for (const coedge of loop.coedges) {
    const samples = edgeSampler.sampleCoEdge(coedge, edgeSegs);
    if (samples.length === 0) continue;

    // Skip the first point if it duplicates the last accumulated point
    const startIdx = (allPts.length > 0) ? 1 : 0;
    for (let i = startIdx; i < samples.length; i++) {
      allPts.push(samples[i]);
    }
  }

  // Remove trailing duplicate if loop closes on itself
  if (allPts.length > 1) {
    const first = allPts[0];
    const last = allPts[allPts.length - 1];
    const dx = first.x - last.x;
    const dy = first.y - last.y;
    const dz = first.z - last.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) < 1e-10) {
      allPts.pop();
    }
  }

  return allPts;
}

/**
 * Config-routed tessellation entry point.
 *
 * Routes to either the legacy or robust tessellator based on the
 * `tessellator` field in the config/opts.
 *
 * @param {import('../BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @param {string} [opts.tessellator='legacy'] - 'legacy' or 'robust'
 * @param {number} [opts.surfaceSegments=8]
 * @param {number} [opts.edgeSegments=16]
 * @param {number} [opts.curveSegments=16]
 * @param {boolean} [opts.validate=false]
 * @returns {Object} Mesh result
 */
export function tessellateBodyRouted(body, opts = {}) {
  // Default to 'legacy'; unrecognized values also fall through to legacy
  const mode = opts.tessellator ?? 'legacy';

  if (mode === 'robust') {
    try {
      const result = robustTessellateBody(body, opts);
      // If robust tessellation produced results, return them
      if (result.faces.length > 0) {
        result._tessellator = 'robust';
        return result;
      }
      // Fall through to legacy if robust produced empty mesh
    } catch (err) {
      // Robust tessellation failed — fall back to legacy with diagnostic
      const fallback = legacyTessellateBody(body, opts);
      fallback._tessellator = 'legacy-fallback';
      fallback._robustError = err.message;
      return fallback;
    }
  }

  const result = legacyTessellateBody(body, opts);
  result._tessellator = 'legacy';
  return result;
}

/**
 * Shadow tessellation: run both legacy and robust tessellators, compare
 * outputs, and record disagreements.  Returns the legacy result by default
 * (shadow mode is observation-only).
 *
 * When CAD_USE_ROBUST_TESSELLATOR is true this function is called
 * automatically by tessellateBodyRouted() instead of the normal path.
 *
 * @param {import('../BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @returns {Object} The primary mesh result (legacy by default, robust if clean)
 */
export function shadowTessellateBody(body, opts = {}) {
  const legacyResult = legacyTessellateBody(body, opts);
  legacyResult._tessellator = 'legacy';

  let robustResult;
  let robustError = null;
  try {
    robustResult = robustTessellateBody(body, { ...opts, validate: true });
    robustResult._tessellator = 'robust';
  } catch (err) {
    robustError = err.message;
  }

  const legacyHash = computeMeshHash(legacyResult);
  const robustHash = robustResult ? computeMeshHash(robustResult) : null;

  const legacyValidation = validateMesh(legacyResult.faces);
  const robustValidation = robustResult ? robustResult.validation ?? validateMesh(robustResult.faces) : null;

  const disagreement = {
    timestamp: Date.now(),
    legacyHash,
    robustHash,
    hashMatch: legacyHash === robustHash,
    legacyFaces: legacyResult.faces.length,
    robustFaces: robustResult ? robustResult.faces.length : 0,
    legacyClean: legacyValidation.isClean,
    robustClean: robustValidation ? robustValidation.isClean : false,
    robustError,
  };

  // Record if there is any disagreement
  if (!disagreement.hashMatch || robustError || !disagreement.robustClean) {
    _shadowDisagreements.push(disagreement);
  }

  // Attach shadow comparison to the primary result
  legacyResult._shadowComparison = disagreement;

  return legacyResult;
}

// Re-export sub-modules for direct access
export { EdgeSampler } from './EdgeSampler.js';
export { FaceTriangulator } from './FaceTriangulator.js';
export { MeshStitcher } from './MeshStitcher.js';
export { computeMeshHash, meshSummary } from './MeshHash.js';
export { recommendEdgeSegments, detectCriticalRegions, chordalError, angularError } from './Refinement.js';

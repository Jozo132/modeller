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
        console.error(`[robust-tessellate] face triangulation failed (type=${face.surfaceType}, sameSense=${face.sameSense}):`, err.message, err.stack);
        faceMesh = { vertices: [], faces: [], _error: err.message };
      }

      faceMesh.shared = face.shared || null;
      faceMesh.isFillet = !!(face.shared && face.shared.isFillet);
      faceMesh.isCorner = !!(face.shared && face.shared.isCorner);
      // Tag with B-Rep face index and surface type so assignCoplanarFaceGroups
      // can properly group all triangles from the same topological face and
      // mark curved surfaces for smooth-normal interpolation.
      faceMesh.topoFaceId = face.id;
      faceMesh.faceType = face.surfaceType === 'plane' ? 'planar'
        : face.surfaceType ? `curved-${face.surfaceType}` : 'unknown';
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

  // Log edge cache stats
  const es = edgeSampler.stats;
  console.log(`[robust-tessellate] edges: ${es.misses} sampled, ${es.hits} cache-hits (${es.cached} cached) | faces: ${result.faces.length} triangles from ${faceMeshes.length} B-Rep faces`);

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

  // Prefer exact analytic tessellation for supported STEP analytic faces.
  // Some imported faces also carry a NURBS support surface whose UV mapping
  // can collapse at periodic seams; other analytic faces (for example torii)
  // may not carry a support surface at all. The analytic path uses the exact
  // trimmed parameterization instead of falling back to projected planar CDT.
  const analyticType = face.surfaceInfo?.type;
  const hasAnalyticSurface = analyticType === 'cylinder'
    || analyticType === 'cone'
    || analyticType === 'sphere'
    || analyticType === 'torus';
  if (hasAnalyticSurface && face.surfaceType !== 'plane') {
    return triangulator.triangulateAnalyticSurface(face, outerPts, holePts, surfSegs);
  }

  // Choose triangulation strategy based on face type.
  if (face.surface && face.surfaceType !== 'plane') {
    // Check if this NURBS surface is effectively planar (e.g. a degree 1×1
    // patch with coplanar control points tagged as 'bspline').  Route flat
    // surfaces through the cheaper planar CDT path.
    if (_isEffectivelyPlanar(face.surface)) {
      return triangulator.triangulatePlanar(outerPts, holePts, null, face.sameSense);
    }
    // Generic NURBS surface: tessellate the UV domain.
    return triangulator.triangulateSurface(face, outerPts, surfSegs, face.sameSense);
  }

  // Planar face: CDT triangulate from boundary.
  // The boundary polygon winding already reflects the face outward direction
  // (FACE_OUTER_BOUND orientation was applied in _buildFaceTopology), so we
  // pass sameSense=true to avoid double-flipping the Newell boundary normal.
  return triangulator.triangulatePlanar(outerPts, holePts, null, true);
}

/**
 * Check if a NURBS surface is effectively planar — all control points lie
 * on a single plane within tolerance.  This catches flat surfaces that
 * carry a non-'plane' surfaceType (e.g. chamfer bevels tagged 'bspline').
 *
 * @param {import('../NurbsSurface.js').NurbsSurface} surface
 * @param {number} [tol=1e-6]
 * @returns {boolean}
 * @private
 */
function _isEffectivelyPlanar(surface, tol = 1e-6) {
  if (!surface || !surface.controlPoints || surface.controlPoints.length < 3) return false;
  const cp = surface.controlPoints;
  const p0 = cp[0];

  // Find first pair of non-collinear control points to define the plane.
  let normal = null;
  let planeD = 0;
  for (let i = 1; i < cp.length && !normal; i++) {
    for (let j = i + 1; j < cp.length && !normal; j++) {
      const v1x = cp[i].x - p0.x, v1y = cp[i].y - p0.y, v1z = cp[i].z - p0.z;
      const v2x = cp[j].x - p0.x, v2y = cp[j].y - p0.y, v2z = cp[j].z - p0.z;
      const nx = v1y * v2z - v1z * v2y;
      const ny = v1z * v2x - v1x * v2z;
      const nz = v1x * v2y - v1y * v2x;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 1e-10) {
        normal = { x: nx / len, y: ny / len, z: nz / len };
        planeD = normal.x * p0.x + normal.y * p0.y + normal.z * p0.z;
      }
    }
  }

  if (!normal) return true; // All collinear — degenerate but "flat"

  // Every control point must lie on the plane.
  for (const p of cp) {
    const dist = Math.abs(normal.x * p.x + normal.y * p.y + normal.z * p.z - planeD);
    if (dist > tol) return false;
  }
  return true;
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
  // BRep-only: always use robust tessellator, no legacy fallback
  const result = robustTessellateBody(body, opts);
  if (result.faces.length > 0) {
    result._tessellator = 'robust';
    return result;
  }
  throw new Error(
    '[BRep-only] tessellateBodyRouted: robust tessellator produced an empty mesh. ' +
    'Legacy ear-clipping fallback is no longer available.'
  );
}

/**
 * Shadow tessellation: run the robust tessellator and record diagnostics.
 * Legacy comparison has been removed — this now only validates the robust path.
 *
 * @param {import('../BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @returns {Object} The robust mesh result
 */
export function shadowTessellateBody(body, opts = {}) {
  const robustResult = robustTessellateBody(body, { ...opts, validate: true });
  robustResult._tessellator = 'robust';

  const robustHash = computeMeshHash(robustResult);
  const robustValidation = robustResult.validation ?? validateMesh(robustResult.faces);

  const diagnostics = {
    timestamp: new Date().toISOString(),
    robustHash,
    robustFaces: robustResult.faces.length,
    robustClean: robustValidation.isClean,
  };

  if (!diagnostics.robustClean) {
    _shadowDisagreements.push(diagnostics);
  }

  robustResult._shadowComparison = diagnostics;
  return robustResult;
}

// Re-export sub-modules for direct access
export { EdgeSampler } from './EdgeSampler.js';
export { FaceTriangulator } from './FaceTriangulator.js';
export { MeshStitcher } from './MeshStitcher.js';
export { computeMeshHash, meshSummary } from './MeshHash.js';
export { recommendEdgeSegments, detectCriticalRegions, chordalError, angularError } from './Refinement.js';

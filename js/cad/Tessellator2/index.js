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
import { GeometryEvaluator } from '../GeometryEvaluator.js';
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

  // Full-circle cylinder faces have self-loop arc edges whose boundary
  // polygon is self-touching at the seam vertices.  CDT cannot handle
  // self-touching boundaries, so use a grid-based tessellation instead.
  if (face.surface && face.surfaceType !== 'plane') {
    const seamMesh = _tessellateSeamFace(face, edgeSampler, edgeSegs, surfSegs);
    if (seamMesh) return seamMesh;
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
 * Grid-based tessellation for faces whose outer loop contains self-loop
 * (seam) edges — typically a full-circle cylinder produced by an extrude.
 *
 * The outer loop visits each seam vertex twice, creating a self-touching
 * boundary polygon that CDT cannot triangulate.  Instead, we identify the
 * two arc coedge sample arrays (bottom and top) and build a ruled grid
 * between them, using the shared edge samples as the grid's first and
 * last rows so the resulting mesh stitches perfectly with adjacent faces.
 *
 * Returns null if the face isn't eligible (no self-loop coedges or the
 * structure doesn't match the expected 4-coedge seam pattern).
 *
 * @param {import('../BRepTopology.js').TopoFace} face
 * @param {EdgeSampler} edgeSampler
 * @param {number} edgeSegs
 * @param {number} surfSegs
 * @returns {{ vertices: Array, faces: Array } | null}
 * @private
 */
function _tessellateSeamFace(face, edgeSampler, edgeSegs, surfSegs) {
  const coedges = face.outerLoop?.coedges;
  if (!coedges || coedges.length !== 4) return null;

  // Identify arc (self-loop) coedges and line (seam) coedges
  const arcCEs = [];
  const lineCEs = [];
  for (const ce of coedges) {
    if (ce.edge.startVertex === ce.edge.endVertex) {
      arcCEs.push(ce);
    } else {
      lineCEs.push(ce);
    }
  }
  if (arcCEs.length !== 2 || lineCEs.length !== 2) return null;

  // Verify line coedges share the same edge (seam used forward + reverse)
  if (lineCEs[0].edge !== lineCEs[1].edge) return null;

  // Get arc boundary samples (shared with adjacent cap faces)
  // The two arcs trace the full circle at two different heights.
  // Order them so row0 = first arc and rowN = second arc along the
  // extrusion direction.
  const arcSamples0 = edgeSampler.sampleCoEdge(arcCEs[0], edgeSegs);
  const arcSamples1 = edgeSampler.sampleCoEdge(arcCEs[1], edgeSegs);

  if (arcSamples0.length < 3 || arcSamples1.length < 3) return null;
  if (arcSamples0.length !== arcSamples1.length) return null;

  // Remove trailing duplicate point (full circle has first == last)
  const row0 = [...arcSamples0];
  const rowN = [...arcSamples1];
  const _dist = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
  if (row0.length > 1 && _dist(row0[0], row0[row0.length - 1]) < 1e-10) row0.pop();
  if (rowN.length > 1 && _dist(rowN[0], rowN[rowN.length - 1]) < 1e-10) rowN.pop();

  if (row0.length !== rowN.length || row0.length < 3) return null;

  const nCols = row0.length;
  // Determine intermediate height steps for the ruled grid
  const nRows = Math.max(2, Math.ceil(surfSegs / 2));

  // Build grid rows: row 0 = first arc, row nRows-1 = second arc,
  // intermediate rows are evaluated on the surface via linear interpolation
  // in parameter space.
  const surface = face.surface;
  const rows = [row0];

  if (surface && nRows > 2) {
    for (let ri = 1; ri < nRows - 1; ri++) {
      const t = ri / (nRows - 1);
      const row = [];
      for (let ci = 0; ci < nCols; ci++) {
        const p0 = row0[ci];
        const pN = rowN[ci];
        // Linearly interpolate in 3D, then project to surface
        const px = p0.x + t * (pN.x - p0.x);
        const py = p0.y + t * (pN.y - p0.y);
        const pz = p0.z + t * (pN.z - p0.z);
        try {
          const uv = surface.closestPointUV({ x: px, y: py, z: pz });
          const sp = surface.evaluate(uv.u, uv.v);
          row.push({ x: sp.x, y: sp.y, z: sp.z });
        } catch (_) {
          row.push({ x: px, y: py, z: pz });
        }
      }
      rows.push(row);
    }
  }
  rows.push(rowN);

  // Triangulate the grid into quads → 2 triangles each.
  // The winding direction must match the face's outward normal.
  const sameSense = face.sameSense !== false;
  const allVerts = [];
  const allFaces = [];

  for (const row of rows) {
    for (const pt of row) allVerts.push(pt);
  }

  for (let ri = 0; ri < rows.length - 1; ri++) {
    for (let ci = 0; ci < nCols; ci++) {
      const ci1 = (ci + 1) % nCols; // wrap around for full circle
      const v00 = allVerts[ri * nCols + ci];
      const v01 = allVerts[ri * nCols + ci1];
      const v10 = allVerts[(ri + 1) * nCols + ci];
      const v11 = allVerts[(ri + 1) * nCols + ci1];

      // For each triangle, compute its geometric winding normal, then
      // compare with the surface outward normal at the triangle centroid.
      // Flip the vertex order if they disagree so winding matches shading.
      const tris = [[v00, v01, v10], [v10, v01, v11]];
      for (const tri of tris) {
        const [a, b, c] = tri;
        // Geometric winding normal
        const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
        const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
        let gnx = e1y * e2z - e1z * e2y;
        let gny = e1z * e2x - e1x * e2z;
        let gnz = e1x * e2y - e1y * e2x;

        // Surface outward normal at triangle centroid
        const cx = (a.x + b.x + c.x) / 3;
        const cy = (a.y + b.y + c.y) / 3;
        const cz = (a.z + b.z + c.z) / 3;
        let snx = gnx, sny = gny, snz = gnz; // fallback
        try {
          const uv = surface.closestPointUV({ x: cx, y: cy, z: cz });
          const ev = GeometryEvaluator.evalSurface(surface, uv.u, uv.v);
          if (ev.n) {
            const flip = sameSense ? 1 : -1;
            snx = ev.n.x * flip; sny = ev.n.y * flip; snz = ev.n.z * flip;
          }
        } catch (_) { /* keep geometric normal */ }

        const dot = gnx * snx + gny * sny + gnz * snz;
        const faceNorm = { x: snx, y: sny, z: snz };
        if (dot < 0) {
          allFaces.push({ vertices: [a, c, b], normal: faceNorm });
        } else {
          allFaces.push({ vertices: [a, b, c], normal: faceNorm });
        }
      }
    }
  }

  return { vertices: allVerts, faces: allFaces };
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

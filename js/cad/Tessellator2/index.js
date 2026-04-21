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
import { constrainedTriangulate } from './CDT.js';
import { computeMeshHash, meshSummary } from './MeshHash.js';
import { recommendEdgeSegments, detectCriticalRegions } from './Refinement.js';
import { validateMesh, detectBoundaryEdges, detectSelfIntersections, checkWatertight } from '../MeshValidator.js';
import { GeometryEvaluator } from '../GeometryEvaluator.js';
import { getFlag } from '../../featureFlags.js';
import {
  buildEdgeTessellationKey,
  buildFaceTessellationKey,
  materializeFaceMesh,
  shouldReuseIncrementalCache,
} from './IncrementalTessellation.js';

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
 * @param {number} [opts.surfaceSegments=16]
 * @param {number} [opts.edgeSegments=64]
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
  const surfSegs = opts.surfaceSegments ?? 16;
  const edgeSegs = opts.edgeSegments ?? 64;
  const doValidate = opts.validate ?? false;
  const configKey = `${surfSegs}|${edgeSegs}`;

  if (!body || !body.shells) return { vertices: [], faces: [], edges: [] };

  const previousCache = shouldReuseIncrementalCache(opts.incrementalCache, configKey)
    ? opts.incrementalCache
    : null;
  const previousFaceMeshesByKey = previousCache ? previousCache.faceMeshesByKey : null;
  const previousFaceKeys = new Set(previousCache?.faceKeys || []);
  const previousEdgeKeys = new Set(previousCache?.edgeKeys || []);
  const nextFaceMeshesByKey = new Map();
  const currentFaceKeys = new Set();
  const currentEdgeKeys = new Set();
  const dirtyFaceKeys = [];
  const reusedFaceKeys = [];

  const edgeSampler = new EdgeSampler();
  const triangulator = new FaceTriangulator();
  const stitcher = new MeshStitcher();

  const faceMeshes = [];
  const edgeResults = [];

  for (const shell of body.shells) {
    // Stage 1: Sample all edges in this shell once
    for (const edge of shell.edges()) {
      edgeSampler.sampleEdge(edge, edgeSegs);
      currentEdgeKeys.add(buildEdgeTessellationKey(edge));
    }

    // Stage 2: Triangulate each face using shared edge samples
    for (const face of shell.faces) {
      const faceKey = buildFaceTessellationKey(face);
      currentFaceKeys.add(faceKey);

      let rawFaceMesh = previousFaceMeshesByKey ? previousFaceMeshesByKey.get(faceKey) : null;
      if (rawFaceMesh && rawFaceMesh._error) {
        rawFaceMesh = null;
      }

      if (!rawFaceMesh) {
        try {
          rawFaceMesh = _triangulateFace(face, edgeSampler, triangulator, surfSegs, edgeSegs);
        } catch (err) {
          // If robust triangulation fails for a face, produce empty mesh
          console.error(`[robust-tessellate] face triangulation failed (type=${face.surfaceType}, sameSense=${face.sameSense}):`, err.message, err.stack);
          rawFaceMesh = { vertices: [], faces: [], _error: err.message };
        }
        dirtyFaceKeys.push(faceKey);
      } else {
        reusedFaceKeys.push(faceKey);
      }

      nextFaceMeshesByKey.set(faceKey, {
        vertices: rawFaceMesh.vertices || [],
        faces: rawFaceMesh.faces || [],
        _error: rawFaceMesh._error || null,
      });

      faceMeshes.push(materializeFaceMesh(rawFaceMesh, face, faceKey));
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

  const removedFaceKeys = [...previousFaceKeys].filter((key) => !currentFaceKeys.has(key)).sort();
  const removedEdgeKeys = [...previousEdgeKeys].filter((key) => !currentEdgeKeys.has(key)).sort();
  const dirtyEdgeKeys = [...currentEdgeKeys].filter((key) => !previousEdgeKeys.has(key)).sort();
  const reusedEdgeKeys = [...currentEdgeKeys].filter((key) => previousEdgeKeys.has(key)).sort();

  result.incrementalTessellation = {
    dirtyFaceKeys: [...dirtyFaceKeys].sort(),
    reusedFaceKeys: [...reusedFaceKeys].sort(),
    removedFaceKeys,
    dirtyEdgeKeys,
    reusedEdgeKeys,
    removedEdgeKeys,
  };
  result._incrementalTessellationCache = {
    configKey,
    faceKeys: [...currentFaceKeys],
    edgeKeys: [...currentEdgeKeys],
    faceMeshesByKey: nextFaceMeshesByKey,
  };

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
  const sphereLoopMesh = _tessellateSphereLoopFace(face, edgeSampler, edgeSegs, surfSegs);
  if (sphereLoopMesh) return sphereLoopMesh;

  const singularCapMesh = _tessellateSingularAnalyticCapFace(face, edgeSampler, edgeSegs);
  if (singularCapMesh) return singularCapMesh;

  const singularWedgeMesh = _tessellateSingularAnalyticWedgeFace(face, edgeSampler, edgeSegs);
  if (singularWedgeMesh) return singularWedgeMesh;

  const ruledQuadMesh = _tessellateAnalyticRuledQuadFace(face, edgeSampler, edgeSegs);
  if (ruledQuadMesh) return ruledQuadMesh;

  const periodicStripMesh = _tessellatePeriodicStripFace(face, edgeSampler, edgeSegs, surfSegs);
  if (periodicStripMesh) return periodicStripMesh;

  const periodicSlotMesh = _tessellatePeriodicSlotFace(face, edgeSampler, edgeSegs, surfSegs);
  if (periodicSlotMesh) return periodicSlotMesh;

  const selfLoopRingMesh = _tessellateSelfLoopRingFace(face, edgeSampler, edgeSegs, surfSegs);
  if (selfLoopRingMesh) return selfLoopRingMesh;

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

function _tessellateSphereLoopFace(face, edgeSampler, edgeSegs, surfSegs) {
  if (face.surfaceInfo?.type !== 'sphere') return null;
  if (!face.outerLoop || (face.innerLoops?.length || 0) !== 0) return null;

  const boundary = _collectLoopPoints(face.outerLoop, edgeSampler, edgeSegs);
  if (boundary.length < 3) return null;

  const surfaceInfo = face.surfaceInfo;
  if (!surfaceInfo?.origin || !Number.isFinite(surfaceInfo.radius)) return null;
  const centerDir = _spherePatchCenterDirection(surfaceInfo, boundary, face.sameSense !== false);
  if (!centerDir) return null;

  const nCols = boundary.length;
  const ringCount = Math.max(2, Math.ceil(surfSegs / 2));
  const rows = [];
  const centerPoint = {
    x: surfaceInfo.origin.x + centerDir.x * surfaceInfo.radius,
    y: surfaceInfo.origin.y + centerDir.y * surfaceInfo.radius,
    z: surfaceInfo.origin.z + centerDir.z * surfaceInfo.radius,
  };

  for (let ri = 1; ri < ringCount; ri++) {
    const t = ri / ringCount;
    rows.push(boundary.map((point) => {
      const boundaryDir = _spherePointDirection(surfaceInfo, point);
      const dir = _slerpUnit(centerDir, boundaryDir, t);
      return {
        x: surfaceInfo.origin.x + dir.x * surfaceInfo.radius,
        y: surfaceInfo.origin.y + dir.y * surfaceInfo.radius,
        z: surfaceInfo.origin.z + dir.z * surfaceInfo.radius,
      };
    }));
  }
  rows.push(boundary);

  const vertices = [centerPoint, ...rows.flat()];
  const faces = [];
  const pushTri = (a, b, c) => {
    const oriented = _orientTriangleToFace(face, a, b, c);
    if (_triangleArea3(oriented[0], oriented[1], oriented[2]) < 1e-12) return;
    faces.push({
      vertices: oriented,
      normal: _faceOutwardNormal(face, {
        x: (oriented[0].x + oriented[1].x + oriented[2].x) / 3,
        y: (oriented[0].y + oriented[1].y + oriented[2].y) / 3,
        z: (oriented[0].z + oriented[1].z + oriented[2].z) / 3,
      }),
    });
  };

  const firstRing = rows[0];
  for (let ci = 0; ci < nCols; ci++) {
    pushTri(centerPoint, firstRing[ci], firstRing[(ci + 1) % nCols]);
  }

  for (let ri = 0; ri < rows.length - 1; ri++) {
    const rowA = rows[ri];
    const rowB = rows[ri + 1];
    for (let ci = 0; ci < nCols; ci++) {
      const ci1 = (ci + 1) % nCols;
      pushTri(rowA[ci], rowB[ci], rowA[ci1]);
      pushTri(rowA[ci1], rowB[ci], rowB[ci1]);
    }
  }

  return faces.length > 0 ? { vertices, faces } : null;
}

function _spherePatchCenterDirection(surfaceInfo, boundary, sameSense = true) {
  const origin = surfaceInfo.origin;
  let sx = 0, sy = 0, sz = 0;
  for (const point of boundary) {
    const dir = _spherePointDirection(surfaceInfo, point);
    sx += dir.x;
    sy += dir.y;
    sz += dir.z;
  }

  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < boundary.length; i++) {
    const a = {
      x: boundary[i].x - origin.x,
      y: boundary[i].y - origin.y,
      z: boundary[i].z - origin.z,
    };
    const b = {
      x: boundary[(i + 1) % boundary.length].x - origin.x,
      y: boundary[(i + 1) % boundary.length].y - origin.y,
      z: boundary[(i + 1) % boundary.length].z - origin.z,
    };
    nx += a.y * b.z - a.z * b.y;
    ny += a.z * b.x - a.x * b.z;
    nz += a.x * b.y - a.y * b.x;
  }

  const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (nLen > 1e-12) {
    const loopNormal = { x: nx / nLen, y: ny / nLen, z: nz / nLen };
    return sameSense
      ? loopNormal
      : { x: -loopNormal.x, y: -loopNormal.y, z: -loopNormal.z };
  }

  const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (len > boundary.length * 1e-5) {
    return { x: sx / len, y: sy / len, z: sz / len };
  }

  return null;
}

function _spherePointDirection(surfaceInfo, point) {
  return _normalize({
    x: point.x - surfaceInfo.origin.x,
    y: point.y - surfaceInfo.origin.y,
    z: point.z - surfaceInfo.origin.z,
  });
}

function _slerpUnit(a, b, t) {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  if (dot > 0.9995) {
    return _normalize({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    });
  }
  if (dot < -0.9995) {
    return _normalize({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    });
  }

  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return _normalize({
    x: a.x * wa + b.x * wb,
    y: a.y * wa + b.y * wb,
    z: a.z * wa + b.z * wb,
  });
}

function _tessellateSelfLoopRingFace(face, edgeSampler, edgeSegs, surfSegs) {
  const analyticType = face.surfaceInfo?.type;
  if (analyticType !== 'cylinder' && analyticType !== 'cone' && analyticType !== 'torus') return null;

  const outerCoedges = face.outerLoop?.coedges;
  if (!outerCoedges || outerCoedges.length !== 1) return null;
  if (!outerCoedges[0]?.edge || outerCoedges[0].edge.startVertex !== outerCoedges[0].edge.endVertex) return null;
  if (!Array.isArray(face.innerLoops) || face.innerLoops.length !== 1) return null;

  const innerCoedges = face.innerLoops[0]?.coedges;
  if (!innerCoedges || innerCoedges.length !== 1) return null;
  if (!innerCoedges[0]?.edge || innerCoedges[0].edge.startVertex !== innerCoedges[0].edge.endVertex) return null;

  const outerSamples = edgeSampler.sampleCoEdge(outerCoedges[0], edgeSegs);
  const innerSamples = edgeSampler.sampleCoEdge(innerCoedges[0], edgeSegs);
  const outerRow = _trimClosedLoopSamples(outerSamples);
  const innerRowRaw = _trimClosedLoopSamples(innerSamples);

  if (outerRow.length < 3 || innerRowRaw.length < 3) return null;
  if (outerRow.length !== innerRowRaw.length) return null;

  const analyticAlignment = _alignAnalyticRingRows(face.surfaceInfo, outerRow, innerRowRaw);
  const alignedOuterRow = analyticAlignment?.outerRow || outerRow;
  const outerUv = analyticAlignment?.outerUv || null;
  const innerRow = analyticAlignment?.innerRow || _alignClosedLoopSamples(alignedOuterRow, innerRowRaw);
  const innerUv = analyticAlignment?.innerUv || null;
  const nCols = outerRow.length;
  const nRows = Math.max(2, Math.ceil(surfSegs / 2));
  const rows = [alignedOuterRow];

  for (let ri = 1; ri < nRows - 1; ri++) {
    const t = ri / (nRows - 1);
    const row = [];
    for (let ci = 0; ci < nCols; ci++) {
      if (outerUv && innerUv) {
        const u0 = outerUv[ci].u;
        const u1 = _wrapNearValue(innerUv[ci].u, u0, 2 * Math.PI);
        const v0 = outerUv[ci].v;
        const v1 = innerUv[ci].v;
        row.push(_evaluateAnalyticSurface(face.surfaceInfo, u0 + t * (u1 - u0), v0 + t * (v1 - v0)));
        continue;
      }

      const p0 = alignedOuterRow[ci];
      const p1 = innerRow[ci];
      row.push(_projectFacePoint(face, {
        x: p0.x + t * (p1.x - p0.x),
        y: p0.y + t * (p1.y - p0.y),
        z: p0.z + t * (p1.z - p0.z),
      }));
    }
    rows.push(row);
  }
  rows.push(innerRow);

  const allVerts = [];
  const allFaces = [];
  for (const row of rows) {
    for (const pt of row) allVerts.push(pt);
  }

  for (let ri = 0; ri < rows.length - 1; ri++) {
    for (let ci = 0; ci < nCols; ci++) {
      const ci1 = (ci + 1) % nCols;
      const v00 = allVerts[ri * nCols + ci];
      const v01 = allVerts[ri * nCols + ci1];
      const v10 = allVerts[(ri + 1) * nCols + ci];
      const v11 = allVerts[(ri + 1) * nCols + ci1];

      const tris = [[v00, v01, v10], [v10, v01, v11]];
      for (const tri of tris) {
        const oriented = _orientTriangleToFace(face, tri[0], tri[1], tri[2]);
        if (_triangleArea3(oriented[0], oriented[1], oriented[2]) < 1e-12) continue;
        const centroid = {
          x: (oriented[0].x + oriented[1].x + oriented[2].x) / 3,
          y: (oriented[0].y + oriented[1].y + oriented[2].y) / 3,
          z: (oriented[0].z + oriented[1].z + oriented[2].z) / 3,
        };
        allFaces.push({
          vertices: oriented,
          normal: _faceOutwardNormal(face, centroid),
        });
      }
    }
  }

  return { vertices: allVerts, faces: allFaces };
}

function _tessellatePeriodicSlotFace(face, edgeSampler, edgeSegs, surfSegs) {
  const analyticType = face.surfaceInfo?.type;
  if (analyticType !== 'cylinder' && analyticType !== 'cone') return null;

  const outerCoedges = face.outerLoop?.coedges;
  if (!outerCoedges || outerCoedges.length !== 1) return null;
  if (!outerCoedges[0]?.edge || outerCoedges[0].edge.startVertex !== outerCoedges[0].edge.endVertex) return null;
  if (!Array.isArray(face.innerLoops) || face.innerLoops.length !== 1) return null;

  const innerLoop = face.innerLoops[0];
  if (!innerLoop?.coedges || innerLoop.coedges.length < 1) return null;
  if (innerLoop.coedges.every((coedge) => coedge?.edge?.startVertex === coedge?.edge?.endVertex)) return null;

  const periodU = 2 * Math.PI;
  const outerPts = _trimClosedLoopSamples(edgeSampler.sampleCoEdge(outerCoedges[0], edgeSegs));
  const innerPts = _collectLoopPoints(innerLoop, edgeSampler, edgeSegs);
  const outerUv = _collectAnalyticLoopUv(face.surfaceInfo, outerPts, periodU);
  const innerUv = _collectAnalyticLoopUv(face.surfaceInfo, innerPts, periodU);

  if (outerUv.length < 3 || innerUv.length < 4) return null;

  const outerV = outerUv.reduce((sum, point) => sum + point.v, 0) / outerUv.length;
  const innerSpan = innerUv[innerUv.length - 1].u - innerUv[0].u;
  if (!Number.isFinite(innerSpan) || innerSpan <= periodU * 0.5 || innerSpan >= periodU - 1e-4) return null;

  const gapSpan = periodU - innerSpan;
  const vMin = innerUv.reduce((min, point) => Math.min(min, point.v), Infinity);
  if (!Number.isFinite(vMin) || outerV - vMin < 1e-6) return null;

  const uA = innerUv[0].u;
  const uB = innerUv[innerUv.length - 1].u;
  const outerSplit = _splitPeriodicBoundaryLoopAtArc(outerUv, uB, gapSpan, periodU);
  const outerLongArc = outerSplit.longArc;
  const outerShortArc = outerSplit.shortArc;
  if (outerLongArc.length < 2 || outerShortArc.length < 2) return null;

  const innerReversed = [...innerUv]
    .reverse()
    .map((point) => ({
      ...point,
      u: point.u + periodU,
      x: point.u + periodU,
      y: point.v,
    }));
  const mainPatch = _triangulateAnalyticUvPatch(face, [
    ...outerLongArc,
    ...innerReversed,
  ], [], surfSegs);
  if (!mainPatch || !mainPatch.faces.length) return null;

  const aWrapped = {
    ...innerUv[0],
    u: innerUv[0].u + periodU,
    x: innerUv[0].u + periodU,
    y: innerUv[0].v,
  };
  const bottomShortArc = _buildAnalyticStripArc(
    face.surfaceInfo,
    uB,
    uB + gapSpan,
    vMin,
    Math.max(1, Math.ceil((edgeSegs * gapSpan) / periodU)),
  ).slice(1, -1).reverse();
  const webPatch = _triangulateAnalyticUvPatch(face, [
    ...outerShortArc,
    aWrapped,
    ...bottomShortArc,
    { ...innerUv[innerUv.length - 1] },
  ], [], Math.max(3, Math.ceil(surfSegs / 2)));
  if (!webPatch || !webPatch.faces.length) return mainPatch;

  return {
    vertices: [...mainPatch.vertices, ...webPatch.vertices],
    faces: [...mainPatch.faces, ...webPatch.faces],
  };
}

function _alignAnalyticRingRows(surfaceInfo, outerRow, innerRowRaw) {
  const analyticType = surfaceInfo?.type;
  if (analyticType !== 'cylinder' && analyticType !== 'cone') return null;
  if (!Array.isArray(outerRow) || !Array.isArray(innerRowRaw) || outerRow.length !== innerRowRaw.length) return null;

  const periodU = 2 * Math.PI;
  const mapRowToUv = (row) => {
    const uvLoop = _normalizePeriodicUvLoop(
      row.map((point, rowIndex) => {
        const uv = _analyticClosestPointUV(surfaceInfo, point);
        return uv ? { u: uv.u, v: uv.v, x: uv.u, y: uv.v, rowIndex } : null;
      }).filter(Boolean),
      periodU,
    );
    return uvLoop.length === row.length ? uvLoop : null;
  };

  const outerUv = mapRowToUv(outerRow);
  if (!outerUv) return null;
  const alignedOuterRow = outerUv.map((entry) => outerRow[entry.rowIndex]);

  const candidates = [
    { reverse: false, row: innerRowRaw },
    { reverse: true, row: [...innerRowRaw].reverse() },
  ].map((candidate) => {
    const uv = mapRowToUv(candidate.row);
    if (!uv) return null;
    return {
      ...candidate,
      uv,
      normalizedRow: uv.map((entry) => candidate.row[entry.rowIndex]),
    };
  }).filter(Boolean);
  if (!candidates.length) return null;

  let bestCandidate = null;
  let bestShift = 0;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    for (let shift = 0; shift < candidate.row.length; shift++) {
      let score = 0;
      for (let i = 0; i < outerUv.length; i++) {
        const outerPoint = outerUv[i];
        const innerPoint = candidate.uv[(i + shift) % candidate.uv.length];
        const du = _wrapNearValue(innerPoint.u, outerPoint.u, periodU) - outerPoint.u;
        const a = alignedOuterRow[i];
        const b = candidate.normalizedRow[(i + shift) % candidate.normalizedRow.length];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        score += du * du * 16 + dx * dx + dy * dy + dz * dz;
      }
      if (score < bestScore) {
        bestScore = score;
        bestCandidate = candidate;
        bestShift = shift;
      }
    }
  }
  if (!bestCandidate) return null;

  const alignedInnerRow = alignedOuterRow.map((_, i) => bestCandidate.normalizedRow[(i + bestShift) % bestCandidate.normalizedRow.length]);
  const alignedInnerUv = alignedOuterRow.map((_, i) => {
    const outerPoint = outerUv[i];
    const innerPoint = bestCandidate.uv[(i + bestShift) % bestCandidate.uv.length];
    const u = _wrapNearValue(innerPoint.u, outerPoint.u, periodU);
    return { ...innerPoint, u, x: u, y: innerPoint.v };
  });

  return {
    outerRow: alignedOuterRow,
    outerUv: outerUv.map((point) => ({ ...point })),
    innerRow: alignedInnerRow,
    innerUv: alignedInnerUv,
  };
}

function _collectAnalyticLoopUv(surfaceInfo, loopPts, periodU) {
  if (!surfaceInfo || !Array.isArray(loopPts) || loopPts.length < 3) return [];
  const uvLoop = _normalizePeriodicUvLoop(
    loopPts.map((point) => {
      const uv = _analyticClosestPointUV(surfaceInfo, point);
      return uv ? {
        u: uv.u,
        v: uv.v,
        x: uv.u,
        y: uv.v,
        _orig3D: point,
      } : null;
    }).filter(Boolean),
    periodU,
  );
  return _dedupeUvPolyline(uvLoop);
}

function _splitPeriodicBoundaryLoopAtArc(loopUv, startU, spanU, periodU) {
  if (!Array.isArray(loopUv) || loopUv.length < 2 || !Number.isFinite(spanU) || spanU <= 1e-8) {
    return { shortArc: [], longArc: [] };
  }

  const endU = startU + spanU;
  const entries = loopUv
    .map((point, index) => {
      let u = _wrapNearValue(point.u, startU, periodU);
      while (u < startU - periodU * 0.5) u += periodU;
      while (u > startU + periodU * 1.5) u -= periodU;
      return { ...point, u, x: u, y: point.v, _loopIndex: index };
    })
    .sort((a, b) => a.u - b.u);

  if (entries.length < 2) return { shortArc: [], longArc: [] };

  let startIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].u <= startU + 1e-10) startIdx = i;
  }
  if (startIdx < 0) {
    const last = { ...entries[entries.length - 1], u: entries[entries.length - 1].u - periodU };
    entries.unshift(last);
    startIdx = 0;
  }

  let endIdx = -1;
  for (let i = startIdx; i < entries.length; i++) {
    if (entries[i].u >= endU - 1e-10) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) {
    entries.push({ ...entries[0], u: entries[0].u + periodU });
    endIdx = entries.length - 1;
  }

  const shortArc = _dedupeUvPolyline(entries.slice(startIdx, endIdx + 1).map((point) => ({ ...point })));
  const longArcRaw = [
    ...entries.slice(endIdx),
    ...entries.slice(0, startIdx + 1).map((point) => ({ ...point, u: point.u + periodU })),
  ];
  const longArc = _dedupeUvPolyline(longArcRaw.map((point) => ({ ...point, x: point.u, y: point.v })));

  return { shortArc, longArc };
}

function _buildAnalyticStripArc(surfaceInfo, startU, endU, v, steps) {
  const count = Math.max(1, steps);
  const arc = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const u = startU + (endU - startU) * t;
    arc.push({
      u,
      v,
      x: u,
      y: v,
      _orig3D: _evaluateAnalyticSurface(surfaceInfo, u, v),
    });
  }
  return _dedupeUvPolyline(arc);
}

function _triangulateAnalyticUvPatch(face, outerUv, holeUvs = [], surfSegs = 8) {
  if (!Array.isArray(outerUv) || outerUv.length < 3) return null;

  let outer = _dedupeUvPolyline(outerUv.map((point) => ({ ...point })));
  if (outer.length < 3) return null;
  if (_signedArea2D(outer) < 0) outer = [...outer].reverse();

  const holes = holeUvs
    .map((loop) => _dedupeUvPolyline(loop.map((point) => ({ ...point }))))
    .filter((loop) => loop.length >= 3)
    .map((loop) => (_signedArea2D(loop) > 0 ? [...loop].reverse() : loop));

  const bbox = _bbox2([...outer, ...holes.flat()]);
  const steiner = [];
  const gridResU = Math.max(2, Math.ceil(surfSegs / 3));
  const gridResV = Math.max(2, Math.ceil(surfSegs / 3));
  for (let ui = 1; ui <= gridResU; ui++) {
    for (let vi = 1; vi <= gridResV; vi++) {
      const u = bbox.minX + (bbox.maxX - bbox.minX) * (ui / (gridResU + 1));
      const v = bbox.minY + (bbox.maxY - bbox.minY) * (vi / (gridResV + 1));
      if (!_pointInPoly2D(u, v, outer)) continue;
      if (holes.some((loop) => _pointInPoly2D(u, v, loop))) continue;
      steiner.push({ u, v, x: u, y: v });
    }
  }

  const allUv = [...outer];
  for (const hole of holes) allUv.push(...hole);
  allUv.push(...steiner);

  const triIndices = constrainedTriangulate(
    outer.map((point) => ({ x: point.u, y: point.v })),
    holes.map((loop) => loop.map((point) => ({ x: point.u, y: point.v }))),
    steiner.map((point) => ({ x: point.u, y: point.v })),
  );
  if (!triIndices.length) return null;

  const pointCache = new Map();
  const evalPoint = (uv) => {
    const key = `${Math.round(uv.u * 1e9)},${Math.round(uv.v * 1e9)}`;
    if (pointCache.has(key)) return pointCache.get(key);
    const point = uv._orig3D
      ? { x: uv._orig3D.x, y: uv._orig3D.y, z: uv._orig3D.z }
      : _evaluateAnalyticSurface(face.surfaceInfo, uv.u, uv.v);
    pointCache.set(key, point);
    return point;
  };

  const faces = [];
  for (const [ia, ib, ic] of triIndices) {
    const ua = allUv[ia];
    const ub = allUv[ib];
    const uc = allUv[ic];
    if (!ua || !ub || !uc) continue;
    const pa = evalPoint(ua);
    const pb = evalPoint(ub);
    const pc = evalPoint(uc);
    const oriented = _orientTriangleToFace(face, pa, pb, pc);
    if (_triangleArea3(oriented[0], oriented[1], oriented[2]) < 1e-12) continue;
    faces.push({
      vertices: oriented,
      normal: _faceOutwardNormal(face, {
        x: (oriented[0].x + oriented[1].x + oriented[2].x) / 3,
        y: (oriented[0].y + oriented[1].y + oriented[2].y) / 3,
        z: (oriented[0].z + oriented[1].z + oriented[2].z) / 3,
      }),
    });
  }

  return faces.length > 0
    ? { vertices: [...pointCache.values()].map((point) => ({ ...point })), faces }
    : null;
}

function _dedupeUvPolyline(points) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const deduped = [];
  for (const point of points) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.u - point.u) < 1e-10 && Math.abs(prev.v - point.v) < 1e-10) continue;
    deduped.push(point);
  }
  if (deduped.length > 1) {
    const first = deduped[0];
    const last = deduped[deduped.length - 1];
    if (Math.abs(first.u - last.u) < 1e-10 && Math.abs(first.v - last.v) < 1e-10) {
      deduped.pop();
    }
  }
  return deduped;
}

function _tessellateSingularAnalyticCapFace(face, edgeSampler, edgeSegs) {
  const analyticType = face.surfaceInfo?.type;
  if (analyticType !== 'cone' && analyticType !== 'sphere') return null;
  if (!face.outerLoop || face.outerLoop.coedges.length !== 1) return null;
  if (Array.isArray(face.innerLoops) && face.innerLoops.length > 0) return null;

  const coedge = face.outerLoop.coedges[0];
  if (!coedge?.edge || coedge.edge.startVertex !== coedge.edge.endVertex) return null;

  const boundary = _trimClosedLoopSamples(edgeSampler.sampleCoEdge(coedge, edgeSegs));
  if (boundary.length < 3) return null;

  const singular = analyticType === 'cone'
    ? _coneSingularPoint(face.surfaceInfo, boundary)
    : _sphereCapPole(face.surfaceInfo, boundary);
  if (!singular) return null;

  const vertices = [...boundary, singular];
  const faces = [];
  for (let i = 0; i < boundary.length; i++) {
    const a = singular;
    const b = boundary[i];
    const c = boundary[(i + 1) % boundary.length];
    const oriented = _orientTriangleToFace(face, a, b, c);
    if (_triangleArea3(oriented[0], oriented[1], oriented[2]) < 1e-12) continue;
    faces.push({
      vertices: oriented,
      normal: _faceOutwardNormal(face, {
        x: (oriented[0].x + oriented[1].x + oriented[2].x) / 3,
        y: (oriented[0].y + oriented[1].y + oriented[2].y) / 3,
        z: (oriented[0].z + oriented[1].z + oriented[2].z) / 3,
      }),
    });
  }

  return faces.length > 0 ? { vertices, faces } : null;
}

function _tessellateSingularAnalyticWedgeFace(face, edgeSampler, edgeSegs) {
  const analyticType = face.surfaceInfo?.type;
  if (analyticType !== 'cone' && analyticType !== 'sphere') return null;
  if (!face.outerLoop || face.outerLoop.coedges.length < 3) return null;
  if (Array.isArray(face.innerLoops) && face.innerLoops.length > 0) return null;

  const boundary = _collectLoopPoints(face.outerLoop, edgeSampler, edgeSegs);
  if (boundary.length < 3) return null;

  const singularPoint = analyticType === 'cone'
    ? _coneApexPoint(face.surfaceInfo)
    : _spherePoleOnBoundary(face.surfaceInfo, boundary);
  if (!singularPoint) return null;

  const faceDiag = _bbox3(boundary).diag;
  const singularTol = Math.max(1e-6, faceDiag * 1e-4);
  const singularIndices = [];
  for (let i = 0; i < boundary.length; i++) {
    if (_dist3(boundary[i], singularPoint) <= singularTol) singularIndices.push(i);
  }
  if (singularIndices.length !== 1) return null;

  const singularIndex = singularIndices[0];
  const rotated = [...boundary.slice(singularIndex), ...boundary.slice(0, singularIndex)];
  if (_dist3(rotated[0], singularPoint) > singularTol) return null;

  const arcRow = rotated.slice(1);
  if (arcRow.length < 2) return null;
  if (_dist3(arcRow[0], arcRow[arcRow.length - 1]) < 1e-8) return null;

  const vertices = [...rotated];
  const faces = [];
  for (let i = 0; i < arcRow.length - 1; i++) {
    const oriented = _orientTriangleToFace(face, rotated[0], arcRow[i], arcRow[i + 1]);
    if (_triangleArea3(oriented[0], oriented[1], oriented[2]) < 1e-12) continue;
    faces.push({
      vertices: oriented,
      normal: _faceOutwardNormal(face, {
        x: (oriented[0].x + oriented[1].x + oriented[2].x) / 3,
        y: (oriented[0].y + oriented[1].y + oriented[2].y) / 3,
        z: (oriented[0].z + oriented[1].z + oriented[2].z) / 3,
      }),
    });
  }

  return faces.length > 0 ? { vertices, faces } : null;
}

function _tessellateAnalyticRuledQuadFace(face, edgeSampler, edgeSegs) {
  const analyticType = face.surfaceInfo?.type;
  if (analyticType !== 'cylinder' && analyticType !== 'cone') return null;
  if (!face.outerLoop || face.outerLoop.coedges.length !== 4) return null;
  if (Array.isArray(face.innerLoops) && face.innerLoops.length > 0) return null;

  const coedgeEntries = face.outerLoop.coedges.map((coedge, idx) => ({
    idx,
    coedge,
    samples: edgeSampler.sampleCoEdge(coedge, edgeSegs),
  }));
  if (coedgeEntries.some((entry) => entry.samples.length < 2)) return null;
  if (coedgeEntries.some((entry) => entry.coedge.edge.startVertex === entry.coedge.edge.endVertex)) return null;

  const railEntries = coedgeEntries.filter((entry) => entry.samples.length > 2);
  if (railEntries.length !== 2) return null;
  if (((railEntries[0].idx - railEntries[1].idx + 4) % 4) !== 2) return null;
  if (railEntries[0].samples.length !== railEntries[1].samples.length) return null;

  const sideEntries = coedgeEntries.filter((entry) => entry.samples.length === 2);
  if (sideEntries.length !== 2) return null;

  const railA = railEntries[0].samples.map((point) => ({ ...point }));
  const railB = _alignOpenSampleRow(
    railA,
    railEntries[1].samples.map((point) => ({ ...point })),
  );

  const vertices = [...railA, ...railB];
  const faces = [];
  for (let i = 0; i < railA.length - 1; i++) {
    const a0 = railA[i];
    const a1 = railA[i + 1];
    const b0 = railB[i];
    const b1 = railB[i + 1];
    const tris = [
      [a0, a1, b0],
      [b0, a1, b1],
    ];
    for (const tri of tris) {
      const oriented = _orientTriangleToFace(face, tri[0], tri[1], tri[2]);
      if (_triangleArea3(oriented[0], oriented[1], oriented[2]) < 1e-12) continue;
      faces.push({
        vertices: oriented,
        normal: _faceOutwardNormal(face, {
          x: (oriented[0].x + oriented[1].x + oriented[2].x) / 3,
          y: (oriented[0].y + oriented[1].y + oriented[2].y) / 3,
          z: (oriented[0].z + oriented[1].z + oriented[2].z) / 3,
        }),
      });
    }
  }

  return faces.length > 0 ? { vertices, faces } : null;
}

function _tessellatePeriodicStripFace(face, edgeSampler, edgeSegs, surfSegs) {
  const analyticType = face.surfaceInfo?.type;
  if (analyticType !== 'cylinder' && analyticType !== 'cone') return null;

  const loops = [face.outerLoop, ...(face.innerLoops || [])].filter(Boolean);
  if (loops.length < 3) return null;
  if (loops.some((loop) => loop.coedges.length !== 1)) return null;
  if (loops.some((loop) => !loop.coedges[0]?.edge || loop.coedges[0].edge.startVertex !== loop.coedges[0].edge.endVertex)) return null;

  const periodU = 2 * Math.PI;
  const loopEntries = [];
  let faceDiag = 0;

  for (const loop of loops) {
    const pts = _trimClosedLoopSamples(edgeSampler.sampleCoEdge(loop.coedges[0], edgeSegs));
    if (pts.length < 3) return null;
    const uv = _normalizePeriodicUvLoop(
      pts.map((pt) => {
        const uvPoint = _analyticClosestPointUV(face.surfaceInfo, pt);
        return uvPoint ? { x: uvPoint.u, y: uvPoint.v, u: uvPoint.u, v: uvPoint.v, _orig3D: pt } : null;
      }).filter(Boolean),
      periodU,
    );
    if (uv.length !== pts.length) return null;

    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    let avgV = 0;
    for (const p of uv) {
      minU = Math.min(minU, p.u);
      maxU = Math.max(maxU, p.u);
      minV = Math.min(minV, p.v);
      maxV = Math.max(maxV, p.v);
      avgV += p.v;
    }
    avgV /= uv.length;

    const bbox = _bbox3(pts);
    faceDiag = Math.max(faceDiag, bbox.diag);
    loopEntries.push({
      loop,
      pts,
      uv,
      avgV,
      uSpan: maxU - minU,
      vSpan: maxV - minV,
    });
  }

  const ringToleranceV = Math.max(1e-5, faceDiag * 1e-3);
  const ringEntries = loopEntries.filter((entry) => entry.uSpan >= periodU * 0.75 && entry.vSpan <= ringToleranceV);
  if (ringEntries.length !== 2) return null;

  ringEntries.sort((a, b) => a.avgV - b.avgV);
  const lower = ringEntries[0];
  const upper = ringEntries[1];
  const otherEntries = loopEntries.filter((entry) => entry !== lower && entry !== upper);
  if (otherEntries.length === 0) return null;

  const alignment = _bestClosedLoopAlignment(lower.pts, upper.pts, (a, b) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
  });
  const upperUv = _applyClosedLoopAlignment(upper.uv, alignment, (point, i, base) => {
    const ref = base[i];
    const u = _wrapNearValue(point.u, ref.u, periodU);
    return { ...point, u, v: point.v, x: u, y: point.v };
  }, lower.uv);
  const lowerUv = lower.uv.map((point) => ({ ...point }));
  let outerUv = [...lowerUv, ...[...upperUv].reverse()];
  if (_signedArea2D(outerUv) < 0) outerUv = [...outerUv].reverse();

  const holeUvs = otherEntries
    .map((entry) => {
      const loop = entry.uv.map((point) => ({ ...point }));
      return _signedArea2D(loop) > 0 ? [...loop].reverse() : loop;
    })
    .filter((loop) => loop.length >= 3);

  const bbox = _bbox2([...outerUv, ...holeUvs.flat()]);
  const steiner = [];
  const gridResU = Math.max(4, Math.ceil(edgeSegs / 3));
  const gridResV = Math.max(3, Math.ceil(surfSegs / 2));
  for (let ui = 1; ui <= gridResU; ui++) {
    for (let vi = 1; vi <= gridResV; vi++) {
      const u = bbox.minX + (bbox.maxX - bbox.minX) * (ui / (gridResU + 1));
      const v = bbox.minY + (bbox.maxY - bbox.minY) * (vi / (gridResV + 1));
      if (!_pointInPoly2D(u, v, outerUv)) continue;
      if (holeUvs.some((loop) => _pointInPoly2D(u, v, loop))) continue;
      steiner.push({ x: u, y: v, u, v });
    }
  }

  const allUv = [...outerUv];
  for (const hole of holeUvs) allUv.push(...hole);
  allUv.push(...steiner);

  const triIndices = constrainedTriangulate(
    outerUv.map((point) => ({ x: point.u, y: point.v })),
    holeUvs.map((loop) => loop.map((point) => ({ x: point.u, y: point.v }))),
    steiner.map((point) => ({ x: point.u, y: point.v })),
  );
  if (!triIndices.length) return null;

  const pointCache = new Map();
  const evalPoint = (uv) => {
    const key = `${Math.round(_wrapNearValue(uv.u, 0, periodU) * 1e9)},${Math.round(uv.v * 1e9)}`;
    if (pointCache.has(key)) return pointCache.get(key);
    let out;
    if (uv._orig3D) {
      out = { x: uv._orig3D.x, y: uv._orig3D.y, z: uv._orig3D.z };
    } else {
      out = _evaluateAnalyticSurface(face.surfaceInfo, uv.u, uv.v);
    }
    pointCache.set(key, out);
    return out;
  };

  const faces = [];
  for (const [ia, ib, ic] of triIndices) {
    const ua = allUv[ia];
    const ub = allUv[ib];
    const uc = allUv[ic];
    if (!ua || !ub || !uc) continue;
    const pa = evalPoint(ua);
    const pb = evalPoint(ub);
    const pc = evalPoint(uc);
    const oriented = _orientTriangleToFace(face, pa, pb, pc);
    if (_triangleArea3(oriented[0], oriented[1], oriented[2]) < 1e-12) continue;
    faces.push({
      vertices: oriented,
      normal: _faceOutwardNormal(face, {
        x: (oriented[0].x + oriented[1].x + oriented[2].x) / 3,
        y: (oriented[0].y + oriented[1].y + oriented[2].y) / 3,
        z: (oriented[0].z + oriented[1].z + oriented[2].z) / 3,
      }),
    });
  }

  // The UV strip is cut open at one meridian.  Add the missing wrap panel
  // between the last and first ring samples so the artificial seam is not an
  // exposed mesh boundary.  The panel uses original EdgeSampler points, so the
  // circular edges still stitch to adjacent cap faces.
  if (lowerUv.length >= 2 && upperUv.length === lowerUv.length) {
    const lowerFirst = evalPoint(lowerUv[0]);
    const lowerLast = evalPoint(lowerUv[lowerUv.length - 1]);
    const upperFirst = evalPoint(upperUv[0]);
    const upperLast = evalPoint(upperUv[upperUv.length - 1]);
    const wrapTris = [
      [lowerLast, lowerFirst, upperLast],
      [upperLast, lowerFirst, upperFirst],
    ];
    for (const tri of wrapTris) {
      const oriented = _orientTriangleToFace(face, tri[0], tri[1], tri[2]);
      if (_triangleArea3(oriented[0], oriented[1], oriented[2]) < 1e-12) continue;
      faces.push({
        vertices: oriented,
        normal: _faceOutwardNormal(face, {
          x: (oriented[0].x + oriented[1].x + oriented[2].x) / 3,
          y: (oriented[0].y + oriented[1].y + oriented[2].y) / 3,
          z: (oriented[0].z + oriented[1].z + oriented[2].z) / 3,
        }),
      });
    }
  }

  return faces.length > 0
    ? { vertices: [...pointCache.values()].map((point) => ({ ...point })), faces }
    : null;
}

function _coneSingularPoint(surfaceInfo, boundary) {
  if (!surfaceInfo?.axis || !surfaceInfo?.origin) return null;
  const angle = _coneAngleRadians(surfaceInfo.semiAngle);
  const tanAngle = Math.tan(angle);
  if (!Number.isFinite(tanAngle) || Math.abs(tanAngle) < 1e-8) return null;

  let avgAxial = 0;
  let avgRadial = 0;
  for (const point of boundary) {
    const dx = point.x - surfaceInfo.origin.x;
    const dy = point.y - surfaceInfo.origin.y;
    const dz = point.z - surfaceInfo.origin.z;
    const axial = dx * surfaceInfo.axis.x + dy * surfaceInfo.axis.y + dz * surfaceInfo.axis.z;
    const rx = dx - axial * surfaceInfo.axis.x;
    const ry = dy - axial * surfaceInfo.axis.y;
    const rz = dz - axial * surfaceInfo.axis.z;
    avgAxial += axial;
    avgRadial += Math.sqrt(rx * rx + ry * ry + rz * rz);
  }
  avgAxial /= boundary.length;
  avgRadial /= boundary.length;

  const apexAxial = avgAxial - avgRadial / tanAngle;
  return {
    x: surfaceInfo.origin.x + surfaceInfo.axis.x * apexAxial,
    y: surfaceInfo.origin.y + surfaceInfo.axis.y * apexAxial,
    z: surfaceInfo.origin.z + surfaceInfo.axis.z * apexAxial,
  };
}

function _coneApexPoint(surfaceInfo) {
  if (!surfaceInfo?.axis || !surfaceInfo?.origin) return null;
  const angle = _coneAngleRadians(surfaceInfo.semiAngle);
  const tanAngle = Math.tan(angle);
  if (!Number.isFinite(tanAngle) || Math.abs(tanAngle) < 1e-8) return null;
  const axial = -(surfaceInfo.radius || 0) / tanAngle;
  return {
    x: surfaceInfo.origin.x + surfaceInfo.axis.x * axial,
    y: surfaceInfo.origin.y + surfaceInfo.axis.y * axial,
    z: surfaceInfo.origin.z + surfaceInfo.axis.z * axial,
  };
}

function _sphereCapPole(surfaceInfo, boundary) {
  if (!surfaceInfo?.origin || !surfaceInfo?.axis || !Number.isFinite(surfaceInfo.radius)) return null;

  const candidates = [
    {
      x: surfaceInfo.origin.x + surfaceInfo.axis.x * surfaceInfo.radius,
      y: surfaceInfo.origin.y + surfaceInfo.axis.y * surfaceInfo.radius,
      z: surfaceInfo.origin.z + surfaceInfo.axis.z * surfaceInfo.radius,
    },
    {
      x: surfaceInfo.origin.x - surfaceInfo.axis.x * surfaceInfo.radius,
      y: surfaceInfo.origin.y - surfaceInfo.axis.y * surfaceInfo.radius,
      z: surfaceInfo.origin.z - surfaceInfo.axis.z * surfaceInfo.radius,
    },
  ];

  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    let score = 0;
    for (const point of boundary) {
      const dx = point.x - candidate.x;
      const dy = point.y - candidate.y;
      const dz = point.z - candidate.z;
      score += dx * dx + dy * dy + dz * dz;
    }
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function _spherePoleOnBoundary(surfaceInfo, boundary) {
  if (!surfaceInfo?.origin || !surfaceInfo?.axis || !Number.isFinite(surfaceInfo.radius) || !Array.isArray(boundary) || boundary.length === 0) {
    return null;
  }

  const candidates = [
    {
      x: surfaceInfo.origin.x + surfaceInfo.axis.x * surfaceInfo.radius,
      y: surfaceInfo.origin.y + surfaceInfo.axis.y * surfaceInfo.radius,
      z: surfaceInfo.origin.z + surfaceInfo.axis.z * surfaceInfo.radius,
    },
    {
      x: surfaceInfo.origin.x - surfaceInfo.axis.x * surfaceInfo.radius,
      y: surfaceInfo.origin.y - surfaceInfo.axis.y * surfaceInfo.radius,
      z: surfaceInfo.origin.z - surfaceInfo.axis.z * surfaceInfo.radius,
    },
  ];

  let best = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    for (const point of boundary) {
      const dist = _dist3(candidate, point);
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
  }

  const faceDiag = _bbox3(boundary).diag;
  const tol = Math.max(1e-6, faceDiag * 1e-4);
  return bestDist <= tol ? best : null;
}

function _coneAngleRadians(angle) {
  if (!Number.isFinite(angle)) return 0;
  return Math.abs(angle) > Math.PI * 2 ? (angle * Math.PI) / 180 : angle;
}

function _trimClosedLoopSamples(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return [];
  const row = [...samples];
  if (_dist3(row[0], row[row.length - 1]) < 1e-10) row.pop();
  return row;
}

function _alignOpenSampleRow(baseRow, candidateRow) {
  if (!Array.isArray(baseRow) || !Array.isArray(candidateRow) || baseRow.length !== candidateRow.length) return candidateRow;
  const directScore = _dist3(baseRow[0], candidateRow[0]) + _dist3(baseRow[baseRow.length - 1], candidateRow[candidateRow.length - 1]);
  const reversed = [...candidateRow].reverse();
  const reversedScore = _dist3(baseRow[0], reversed[0]) + _dist3(baseRow[baseRow.length - 1], reversed[reversed.length - 1]);
  return reversedScore < directScore ? reversed : candidateRow;
}

function _alignClosedLoopSamples(baseRow, candidateRow) {
  const alignment = _bestClosedLoopAlignment(baseRow, candidateRow, (a, b) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
  });
  return _applyClosedLoopAlignment(candidateRow, alignment);
}

function _bestClosedLoopAlignment(baseRow, candidateRow, distanceFn) {
  const orientations = [
    { reverse: false, row: candidateRow },
    { reverse: true, row: [...candidateRow].reverse() },
  ];
  let best = { reverse: false, shift: 0 };
  let bestScore = Infinity;

  for (const orientation of orientations) {
    for (let shift = 0; shift < orientation.row.length; shift++) {
      let score = 0;
      for (let i = 0; i < baseRow.length; i++) {
        score += distanceFn(baseRow[i], orientation.row[(i + shift) % orientation.row.length]);
      }
      if (score < bestScore) {
        bestScore = score;
        best = { reverse: orientation.reverse, shift };
      }
    }
  }

  return best;
}

function _applyClosedLoopAlignment(candidateRow, alignment, mapper = (point) => ({ ...point }), baseRow = null) {
  const oriented = alignment.reverse ? [...candidateRow].reverse() : [...candidateRow];
  return oriented.map((_, i) => mapper(oriented[(i + alignment.shift) % oriented.length], i, baseRow));
}

function _normalizePeriodicUvLoop(loop, periodU) {
  if (!Array.isArray(loop) || loop.length < 2) return loop;

  let cutAfter = -1;
  let maxJump = -Infinity;
  for (let i = 0; i < loop.length; i++) {
    const curr = loop[i];
    const next = loop[(i + 1) % loop.length];
    const jump = Math.abs(next.u - curr.u);
    if (jump > maxJump) {
      maxJump = jump;
      cutAfter = i;
    }
  }

  const ordered = cutAfter >= 0
    ? [...loop.slice(cutAfter + 1), ...loop.slice(0, cutAfter + 1)].map((point) => ({ ...point }))
    : loop.map((point) => ({ ...point }));

  for (let i = 1; i < ordered.length; i++) {
    ordered[i].u = _wrapNearValue(ordered[i].u, ordered[i - 1].u, periodU);
    ordered[i].x = ordered[i].u;
    ordered[i].y = ordered[i].v;
  }
  ordered[0].x = ordered[0].u;
  ordered[0].y = ordered[0].v;
  return ordered;
}

function _wrapNearValue(value, reference, period) {
  if (!Number.isFinite(value) || !Number.isFinite(reference) || !Number.isFinite(period) || period <= 0) {
    return value;
  }
  return value + Math.round((reference - value) / period) * period;
}

function _analyticClosestPointUV(surfaceInfo, point) {
  if (!surfaceInfo) return null;

  const ox = surfaceInfo.origin.x;
  const oy = surfaceInfo.origin.y;
  const oz = surfaceInfo.origin.z;
  const ax = surfaceInfo.axis?.x ?? 0;
  const ay = surfaceInfo.axis?.y ?? 0;
  const az = surfaceInfo.axis?.z ?? 1;
  const dx = point.x - ox;
  const dy = point.y - oy;
  const dz = point.z - oz;

  switch (surfaceInfo.type) {
    case 'cylinder':
    case 'cone': {
      const axial = dx * ax + dy * ay + dz * az;
      const rx = dx - axial * ax;
      const ry = dy - axial * ay;
      const rz = dz - axial * az;
      const ux = rx * surfaceInfo.xDir.x + ry * surfaceInfo.xDir.y + rz * surfaceInfo.xDir.z;
      const uy = rx * surfaceInfo.yDir.x + ry * surfaceInfo.yDir.y + rz * surfaceInfo.yDir.z;
      return { u: Math.atan2(uy, ux), v: axial };
    }
    case 'sphere': {
      const dir = _normalize({ x: dx, y: dy, z: dz });
      const ux = dir.x * surfaceInfo.xDir.x + dir.y * surfaceInfo.xDir.y + dir.z * surfaceInfo.xDir.z;
      const uy = dir.x * surfaceInfo.yDir.x + dir.y * surfaceInfo.yDir.y + dir.z * surfaceInfo.yDir.z;
      const uz = dir.x * ax + dir.y * ay + dir.z * az;
      return { u: Math.atan2(uy, ux), v: Math.atan2(uz, Math.sqrt(ux * ux + uy * uy)) };
    }
    default:
      return null;
  }
}

function _evaluateAnalyticSurface(surfaceInfo, u, v) {
  if (!surfaceInfo) return { x: 0, y: 0, z: 0 };

  const cu = Math.cos(u);
  const su = Math.sin(u);
  const radial = {
    x: surfaceInfo.xDir.x * cu + surfaceInfo.yDir.x * su,
    y: surfaceInfo.xDir.y * cu + surfaceInfo.yDir.y * su,
    z: surfaceInfo.xDir.z * cu + surfaceInfo.yDir.z * su,
  };

  switch (surfaceInfo.type) {
    case 'cylinder':
      return {
        x: surfaceInfo.origin.x + surfaceInfo.axis.x * v + radial.x * surfaceInfo.radius,
        y: surfaceInfo.origin.y + surfaceInfo.axis.y * v + radial.y * surfaceInfo.radius,
        z: surfaceInfo.origin.z + surfaceInfo.axis.z * v + radial.z * surfaceInfo.radius,
      };
    case 'cone': {
      const angle = _coneAngleRadians(surfaceInfo.semiAngle);
      const radius = surfaceInfo.radius + v * Math.tan(angle);
      return {
        x: surfaceInfo.origin.x + surfaceInfo.axis.x * v + radial.x * radius,
        y: surfaceInfo.origin.y + surfaceInfo.axis.y * v + radial.y * radius,
        z: surfaceInfo.origin.z + surfaceInfo.axis.z * v + radial.z * radius,
      };
    }
    case 'sphere': {
      const cv = Math.cos(v);
      const sv = Math.sin(v);
      return {
        x: surfaceInfo.origin.x + (radial.x * cv + surfaceInfo.axis.x * sv) * surfaceInfo.radius,
        y: surfaceInfo.origin.y + (radial.y * cv + surfaceInfo.axis.y * sv) * surfaceInfo.radius,
        z: surfaceInfo.origin.z + (radial.z * cv + surfaceInfo.axis.z * sv) * surfaceInfo.radius,
      };
    }
    default:
      return { x: 0, y: 0, z: 0 };
  }
}

function _signedArea2D(loop) {
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const curr = loop[i];
    const next = loop[(i + 1) % loop.length];
    area += curr.u * next.v - next.u * curr.v;
  }
  return area * 0.5;
}

function _pointInPoly2D(x, y, loop) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const xi = loop[i].u, yi = loop[i].v;
    const xj = loop[j].u, yj = loop[j].v;
    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-16) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function _bbox2(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.u);
    minY = Math.min(minY, point.v);
    maxX = Math.max(maxX, point.u);
    maxY = Math.max(maxY, point.v);
  }
  return { minX, minY, maxX, maxY };
}

function _bbox3(points) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    minZ = Math.min(minZ, point.z);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    maxZ = Math.max(maxZ, point.z);
  }
  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    diag: Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2),
  };
}

function _projectFacePoint(face, point) {
  if (face.surface) {
    try {
      const uv = face.surface.closestPointUV(point);
      const sp = face.surface.evaluate(uv.u, uv.v);
      return { x: sp.x, y: sp.y, z: sp.z };
    } catch (_) {
      // Fall through to analytic projection or raw point.
    }
  }

  return _projectOntoAnalyticSurface(point, face.surfaceInfo) || point;
}

function _projectOntoAnalyticSurface(point, surfaceInfo) {
  if (!surfaceInfo) return null;

  if (surfaceInfo.type === 'sphere') {
    const ox = surfaceInfo.origin.x, oy = surfaceInfo.origin.y, oz = surfaceInfo.origin.z;
    const dx = point.x - ox, dy = point.y - oy, dz = point.z - oz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-14) return { x: ox + surfaceInfo.radius, y: oy, z: oz };
    const s = surfaceInfo.radius / len;
    return { x: ox + dx * s, y: oy + dy * s, z: oz + dz * s };
  }

  if (surfaceInfo.type === 'cylinder') {
    const ox = surfaceInfo.origin.x, oy = surfaceInfo.origin.y, oz = surfaceInfo.origin.z;
    const ax = surfaceInfo.axis.x, ay = surfaceInfo.axis.y, az = surfaceInfo.axis.z;
    const dx = point.x - ox, dy = point.y - oy, dz = point.z - oz;
    const axial = dx * ax + dy * ay + dz * az;
    const rx = dx - axial * ax, ry = dy - axial * ay, rz = dz - axial * az;
    const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (rLen < 1e-14) return point;
    const s = surfaceInfo.radius / rLen;
    return { x: ox + axial * ax + rx * s, y: oy + axial * ay + ry * s, z: oz + axial * az + rz * s };
  }

  if (surfaceInfo.type === 'cone') {
    const ox = surfaceInfo.origin.x, oy = surfaceInfo.origin.y, oz = surfaceInfo.origin.z;
    const ax = surfaceInfo.axis.x, ay = surfaceInfo.axis.y, az = surfaceInfo.axis.z;
    const dx = point.x - ox, dy = point.y - oy, dz = point.z - oz;
    const axial = dx * ax + dy * ay + dz * az;
    const rx = dx - axial * ax, ry = dy - axial * ay, rz = dz - axial * az;
    const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const targetR = surfaceInfo.radius + axial * Math.tan(surfaceInfo.semiAngle);
    if (rLen < 1e-14) return point;
    const s = targetR / rLen;
    return { x: ox + axial * ax + rx * s, y: oy + axial * ay + ry * s, z: oz + axial * az + rz * s };
  }

  if (surfaceInfo.type === 'torus') {
    const ox = surfaceInfo.origin.x, oy = surfaceInfo.origin.y, oz = surfaceInfo.origin.z;
    const ax = surfaceInfo.axis.x, ay = surfaceInfo.axis.y, az = surfaceInfo.axis.z;
    const dx = point.x - ox, dy = point.y - oy, dz = point.z - oz;
    const axial = dx * ax + dy * ay + dz * az;
    const rx = dx - axial * ax, ry = dy - axial * ay, rz = dz - axial * az;
    const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (rLen < 1e-14) return point;
    const mcx = ox + (rx / rLen) * surfaceInfo.majorR;
    const mcy = oy + (ry / rLen) * surfaceInfo.majorR;
    const mcz = oz + (rz / rLen) * surfaceInfo.majorR;
    const mx = point.x - mcx, my = point.y - mcy, mz = point.z - mcz;
    const mLen = Math.sqrt(mx * mx + my * my + mz * mz);
    if (mLen < 1e-14) return point;
    const s = surfaceInfo.minorR / mLen;
    return { x: mcx + mx * s, y: mcy + my * s, z: mcz + mz * s };
  }

  return null;
}

function _faceOutwardNormal(face, point) {
  if (face.surface) {
    try {
      const uv = face.surface.closestPointUV(point);
      const ev = GeometryEvaluator.evalSurface(face.surface, uv.u, uv.v);
      if (ev.n) {
        return _normalize(face.sameSense === false
          ? { x: -ev.n.x, y: -ev.n.y, z: -ev.n.z }
          : ev.n);
      }
    } catch (_) {
      // Fall through.
    }
  }

  const normal = _analyticNormal(face.surfaceInfo, point);
  if (!normal) return { x: 0, y: 0, z: 1 };
  return face.sameSense === false
    ? { x: -normal.x, y: -normal.y, z: -normal.z }
    : normal;
}

function _analyticNormal(surfaceInfo, point) {
  if (!surfaceInfo) return null;

  switch (surfaceInfo.type) {
    case 'plane':
      return _normalize({ ...surfaceInfo.normal });
    case 'cylinder': {
      const dx = point.x - surfaceInfo.origin.x;
      const dy = point.y - surfaceInfo.origin.y;
      const dz = point.z - surfaceInfo.origin.z;
      const ax = surfaceInfo.axis.x, ay = surfaceInfo.axis.y, az = surfaceInfo.axis.z;
      const dot = dx * ax + dy * ay + dz * az;
      return _normalize({ x: dx - dot * ax, y: dy - dot * ay, z: dz - dot * az });
    }
    case 'sphere':
      return _normalize({ x: point.x - surfaceInfo.origin.x, y: point.y - surfaceInfo.origin.y, z: point.z - surfaceInfo.origin.z });
    case 'cone': {
      const dx = point.x - surfaceInfo.origin.x;
      const dy = point.y - surfaceInfo.origin.y;
      const dz = point.z - surfaceInfo.origin.z;
      const ax = surfaceInfo.axis.x, ay = surfaceInfo.axis.y, az = surfaceInfo.axis.z;
      const axial = dx * ax + dy * ay + dz * az;
      const rx = dx - axial * ax, ry = dy - axial * ay, rz = dz - axial * az;
      const radialLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (radialLen < 1e-14) return _normalize({ x: ax, y: ay, z: az });
      const cosA = Math.cos(surfaceInfo.semiAngle);
      const sinA = Math.sin(surfaceInfo.semiAngle);
      return _normalize({
        x: (rx / radialLen) * cosA - ax * sinA,
        y: (ry / radialLen) * cosA - ay * sinA,
        z: (rz / radialLen) * cosA - az * sinA,
      });
    }
    case 'torus': {
      const dx = point.x - surfaceInfo.origin.x;
      const dy = point.y - surfaceInfo.origin.y;
      const dz = point.z - surfaceInfo.origin.z;
      const ax = surfaceInfo.axis.x, ay = surfaceInfo.axis.y, az = surfaceInfo.axis.z;
      const axial = dx * ax + dy * ay + dz * az;
      const rx = dx - axial * ax, ry = dy - axial * ay, rz = dz - axial * az;
      const radialLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (radialLen < 1e-14) return _normalize({ x: ax, y: ay, z: az });
      const cx = surfaceInfo.origin.x + (rx / radialLen) * surfaceInfo.majorR;
      const cy = surfaceInfo.origin.y + (ry / radialLen) * surfaceInfo.majorR;
      const cz = surfaceInfo.origin.z + (rz / radialLen) * surfaceInfo.majorR;
      return _normalize({ x: point.x - cx, y: point.y - cy, z: point.z - cz });
    }
    default:
      return null;
  }
}

function _orientTriangleToFace(face, a, b, c) {
  const normal = _faceOutwardNormal(face, {
    x: (a.x + b.x + c.x) / 3,
    y: (a.y + b.y + c.y) / 3,
    z: (a.z + b.z + c.z) / 3,
  });
  const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
  const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
  const gx = e1y * e2z - e1z * e2y;
  const gy = e1z * e2x - e1x * e2z;
  const gz = e1x * e2y - e1y * e2x;
  return (gx * normal.x + gy * normal.y + gz * normal.z) < 0
    ? [a, c, b]
    : [a, b, c];
}

function _dist3(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function _triangleArea3(a, b, c) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

function _normalize(v) {
  if (!v) return { x: 0, y: 0, z: 1 };
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len < 1e-14) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
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
 * Routes B-Rep bodies through the robust tessellator only.
 * Legacy ear-clipping fallback has been removed from this router.
 *
 * @param {import('../BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @param {string} [opts.tessellator] - Ignored for B-Rep bodies; robust only
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

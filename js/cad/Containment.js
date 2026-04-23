// js/cad/Containment.js — Authoritative point containment engine for exact B-Rep solids
//
// Provides a single API for point / fragment classification against solid bodies.
// Three strategies behind one API:
//
//   0. WASM path — native ray-cast against WASM kernel topology when the body
//      has only supported surface types (plane, sphere). Loaded on demand,
//      cached per body for repeated queries.
//
//   1. Fast path — parity ray-cast classification for clean solids with
//      deterministic ray selection, AABB face filtering, and vertex/edge
//      tie-breaking.
//
//   2. Robust path — generalized winding-number style containment for
//      near-boundary, trimmed NURBS, and ambiguous cases.
//
// Used by:  BooleanKernel, FaceSplitter, picking, feature selection, validation

import { DEFAULT_TOLERANCE } from './Tolerance.js';
import { GeometryEvaluator } from './GeometryEvaluator.js';
import { getFlag } from '../featureFlags.js';
import { warnOnceForFallback } from './fallback/warnOnce.js';
import { SurfaceType } from './BRepTopology.js';

// ---------------------------------------------------------------------------
// WASM native containment — trimmed-face via tessellation-based ray-cast
// ---------------------------------------------------------------------------
// The kernel's `classifyPointVsTriangles` counts ray-triangle crossings
// against the triangle buffer populated by `tessBuildAllFaces`. Because
// the tessellator already respects face boundaries (cylinders clipped at
// loop edges, planes cut to their polygon, NURBS surfaces trimmed by
// coedges), the resulting triangle soup is a true closed manifold of the
// bounded solid. Ray-casting against triangles therefore produces correct
// inside/outside for non-convex solids — unlike the older analytic
// `classifyPointVsShell` which treated every face as an infinite surface.
//
// Gated surface types mirror what `_wasmLoadBody` currently serializes
// (PLANE + SPHERE). Extending to cylinder/cone/torus/NURBS requires
// adding the corresponding geomStore calls in the loader below; once
// present the WASM path will handle those bodies too without needing any
// change to `classifyPointVsTriangles`.

const _WASM_CONTAINMENT_ENABLED = true;

let _wasm = null;
let _wasmMem = null;
async function _ensureWasm() {
  if (_wasm) return true;
  try {
    const mod = await import('../../build/release.js');
    _wasm = mod;
    _wasmMem = mod.memory;
    return true;
  } catch { return false; }
}
function _wasmReady() { return _WASM_CONTAINMENT_ENABLED && _wasm != null; }

/**
 * Cache for the most recently loaded body in WASM kernel buffers.
 * Avoids reloading the same body for multiple point queries (e.g. during
 * boolean fragment classification which checks many points against one body).
 * @type {{ bodyId: number|null, faceCount: number }}
 */
const _wasmBodyCache = { bodyId: null, bodyRev: null, faceCount: 0, tessellated: false };

/**
 * Surface types supported by WASM containment — currently limited by the
 * `_wasmLoadBody` serializer (PLANE, SPHERE, CYLINDER, CONE, TORUS).
 * Triangle-based classifier itself is surface-agnostic; extend this set
 * once the loader stores NURBS geometry.
 */
const _WASM_SUPPORTED_TYPES = new Set([
  SurfaceType.PLANE,
  SurfaceType.SPHERE,
  SurfaceType.CYLINDER,
  SurfaceType.CONE,
  SurfaceType.TORUS,
]);

/**
 * Check if a body can be classified entirely in WASM.
 */
function _wasmCanClassify(body) {
  if (!_wasmReady()) return false;
  if (!body || !body.shells || body.shells.length === 0) return false;
  // Multi-shell bodies (voids) cannot be flattened into a single WASM shell
  if (body.shells.length > 1) return false;
  for (const shell of body.shells) {
    for (const face of shell.faces) {
      if (!_WASM_SUPPORTED_TYPES.has(face.surfaceType)) return false;
    }
  }
  return true;
}

/**
 * Load a body into the WASM kernel topology/geometry buffers.
 * Uses body._id as a cache key to avoid redundant loads.
 * @returns {number} face count, or 0 on failure
 */
function _wasmLoadBody(body) {
  const bodyId = body._id ?? body.id ?? null;
  const bodyRev = body.exactBodyRevisionId ?? null;
  if (bodyId != null && bodyId === _wasmBodyCache.bodyId &&
      bodyRev != null && bodyRev === _wasmBodyCache.bodyRev) {
    return _wasmBodyCache.faceCount;
  }

  const w = _wasm;
  if (!w) return 0;

  // New body: invalidate tessellation cache as well
  _wasmBodyCache.tessellated = false;

  w.bodyBegin();
  w.geomPoolReset();

  const allFaces = body.faces();
  const vertexMap = new Map();

  // Load vertices
  for (const face of allFaces) {
    for (const loop of [face.outerLoop, ...(face.innerLoops || [])]) {
      if (!loop) continue;
      for (const ce of loop.coedges || []) {
        const edge = ce.edge;
        if (!edge) continue;
        if (edge.startVertex && !vertexMap.has(edge.startVertex)) {
          const v = edge.startVertex.point || edge.startVertex;
          vertexMap.set(edge.startVertex, w.vertexAdd(v.x, v.y, v.z));
        }
        if (edge.endVertex && !vertexMap.has(edge.endVertex)) {
          const v = edge.endVertex.point || edge.endVertex;
          vertexMap.set(edge.endVertex, w.vertexAdd(v.x, v.y, v.z));
        }
      }
    }
  }

  // Load edges
  const edgeMap = new Map();
  for (const face of allFaces) {
    for (const loop of [face.outerLoop, ...(face.innerLoops || [])]) {
      if (!loop) continue;
      for (const ce of loop.coedges || []) {
        const edge = ce.edge;
        if (!edge || edgeMap.has(edge)) continue;
        const sv = vertexMap.get(edge.startVertex);
        const ev = vertexMap.get(edge.endVertex);
        if (sv === undefined || ev === undefined) continue; // skip incomplete edges
        edgeMap.set(edge, w.edgeAdd(sv, ev, w.GEOM_LINE, 0));
      }
    }
  }

  // Load faces with geometry
  let wasmFaceId = 0;
  for (const face of allFaces) {
    const loops = [face.outerLoop, ...(face.innerLoops || [])].filter(Boolean);
    if (loops.length === 0) continue;

    // Store surface geometry
    let geomType = w.GEOM_PLANE;
    let geomOffset = 0;

    if (face.surfaceType === SurfaceType.PLANE && face.surface) {
      const s = face.surface;
      const si = s.surfaceInfo || s._analyticParams;
      if (si && si.origin && si.normal) {
        const rd = si.refDir || si.xDir || _computeRefDir(si.normal);
        geomOffset = w.planeStore(
          si.origin.x, si.origin.y, si.origin.z,
          si.normal.x, si.normal.y, si.normal.z,
          rd.x, rd.y, rd.z,
        );
      } else if (face.outerLoop) {
        // Derive plane from boundary vertices
        const pts = face.outerLoop.points();
        if (pts.length >= 3) {
          const n = _polyNormal(pts);
          const rd = _computeRefDir(n);
          geomOffset = w.planeStore(pts[0].x, pts[0].y, pts[0].z, n.x, n.y, n.z, rd.x, rd.y, rd.z);
        }
      }
      geomType = w.GEOM_PLANE;
    } else if (face.surfaceType === SurfaceType.SPHERE && face.surface) {
      const si = face.surface.surfaceInfo || face.surface._analyticParams;
      // surfaceInfo shape varies across producers: StepImportWasm + RevolveFeature
      // emit {origin,axis,xDir,radius}; earlier code used {center,axis,refDir,radius}.
      const ctr = si && (si.origin || si.center);
      if (si && ctr && si.radius != null) {
        const ax = si.axis || { x: 0, y: 0, z: 1 };
        const rd = si.xDir || si.refDir || _computeRefDir(ax);
        geomOffset = w.sphereStore(
          ctr.x, ctr.y, ctr.z,
          ax.x, ax.y, ax.z,
          rd.x, rd.y, rd.z,
          si.radius,
        );
        geomType = w.GEOM_SPHERE;
      }
    } else if (face.surfaceType === SurfaceType.CYLINDER && face.surface) {
      const si = face.surface.surfaceInfo || face.surface._analyticParams;
      if (si && si.origin && si.axis && si.radius != null) {
        const rd = si.xDir || si.refDir || _computeRefDir(si.axis);
        geomOffset = w.cylinderStore(
          si.origin.x, si.origin.y, si.origin.z,
          si.axis.x, si.axis.y, si.axis.z,
          rd.x, rd.y, rd.z,
          si.radius,
        );
        geomType = w.GEOM_CYLINDER;
      }
    } else if (face.surfaceType === SurfaceType.CONE && face.surface) {
      const si = face.surface.surfaceInfo || face.surface._analyticParams;
      if (si && si.origin && si.axis && si.radius != null && si.semiAngle != null) {
        const rd = si.xDir || si.refDir || _computeRefDir(si.axis);
        geomOffset = w.coneStore(
          si.origin.x, si.origin.y, si.origin.z,
          si.axis.x, si.axis.y, si.axis.z,
          rd.x, rd.y, rd.z,
          si.radius, si.semiAngle,
        );
        geomType = w.GEOM_CONE;
      }
    } else if (face.surfaceType === SurfaceType.TORUS && face.surface) {
      const si = face.surface.surfaceInfo || face.surface._analyticParams;
      // Support both {majorR,minorR} (StepImportWasm) and {majorRadius,minorRadius}
      const majorR = si && (si.majorR ?? si.majorRadius);
      const minorR = si && (si.minorR ?? si.minorRadius);
      if (si && si.origin && si.axis && majorR != null && minorR != null) {
        const rd = si.xDir || si.refDir || _computeRefDir(si.axis);
        geomOffset = w.torusStore(
          si.origin.x, si.origin.y, si.origin.z,
          si.axis.x, si.axis.y, si.axis.z,
          rd.x, rd.y, rd.z,
          majorR, minorR,
        );
        geomType = w.GEOM_TORUS;
      }
    }

    const orient = face.sameSense !== false ? w.ORIENT_FORWARD : w.ORIENT_REVERSED;

    // Build coedge loops
    let firstLoopId = -1;
    let numLoops = 0;
    for (let li = 0; li < loops.length; li++) {
      const loop = loops[li];
      const coedges = loop.coedges || [];
      if (coedges.length === 0) continue;

      const isOuter = li === 0 ? 1 : 0;
      const ceIds = [];
      const predictedLoopId = w.coedgeGetCount ? w.loopGetCount() : 0;
      for (const ce of coedges) {
        const eid = edgeMap.get(ce.edge);
        if (eid === undefined) continue; // skip missing edges
        const ceOrient = ce.sameSense ? w.ORIENT_FORWARD : w.ORIENT_REVERSED;
        ceIds.push(w.coedgeAdd(eid, ceOrient, 0, predictedLoopId + numLoops));
      }
      for (let i = 0; i < ceIds.length; i++) {
        w.coedgeSetNext(ceIds[i], ceIds[(i + 1) % ceIds.length]);
      }
      const loopId = w.loopAdd(ceIds[0], wasmFaceId, isOuter);
      if (firstLoopId < 0) firstLoopId = loopId;
      numLoops++;
    }

    if (firstLoopId < 0) continue;
    w.faceAdd(firstLoopId, 0, geomType, geomOffset, orient, numLoops);
    wasmFaceId++;
  }

  if (wasmFaceId > 0) {
    w.shellAdd(0, wasmFaceId, 1);
    w.bodyEnd();
  }

  _wasmBodyCache.bodyId = bodyId;
  _wasmBodyCache.bodyRev = bodyRev;
  _wasmBodyCache.faceCount = wasmFaceId;
  return wasmFaceId;
}

/**
 * Compute a reference direction perpendicular to a given normal.
 * Used to fill the refDir parameter for planeStore/sphereStore.
 */
function _computeRefDir(n) {
  // Pick the axis least-aligned with n for a stable cross product
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  let up;
  if (ax <= ay && ax <= az) up = { x: 1, y: 0, z: 0 };
  else if (ay <= az) up = { x: 0, y: 1, z: 0 };
  else up = { x: 0, y: 0, z: 1 };
  // cross(n, up)
  const rx = n.y * up.z - n.z * up.y;
  const ry = n.z * up.x - n.x * up.z;
  const rz = n.x * up.y - n.y * up.x;
  const len = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (len < 1e-14) return { x: 1, y: 0, z: 0 };
  return { x: rx / len, y: ry / len, z: rz / len };
}

/**
 * Classify a point using WASM ray-cast containment against the tessellated
 * triangle buffer (trimmed-face correct for non-convex solids).
 * @returns {{ state: string, confidence: number, detail: string }|null}
 *          null if WASM path is not applicable
 */
function _wasmClassifyPoint(body, p) {
  if (!_wasmCanClassify(body)) return null;
  const nFaces = _wasmLoadBody(body);
  if (nFaces === 0) return null;

  // Populate the tessellation triangle buffer once per body revision.
  // Segment counts (segsU=24, segsV=16) are tuned for broadphase-quality
  // containment — finer for spheres (curvature), coarser budget overall.
  if (!_wasmBodyCache.tessellated) {
    _wasm.tessReset();
    const nTris = _wasm.tessBuildAllFaces(24, 16);
    if (nTris <= 0) {
      // Tessellation failed — cannot use triangle-based classifier.
      return null;
    }
    _wasmBodyCache.tessellated = true;
  }

  const cls = _wasm.classifyPointVsTriangles(p.x, p.y, p.z);
  if (cls === _wasm.CLASSIFY_INSIDE) {
    return { state: 'inside', confidence: 0.95, detail: 'wasm-tri-ray' };
  }
  if (cls === _wasm.CLASSIFY_OUTSIDE) {
    return { state: 'outside', confidence: 0.95, detail: 'wasm-tri-ray' };
  }
  // UNKNOWN or ON_BOUNDARY — fall through to JS
  return null;
}

// ---------------------------------------------------------------------------
// Shadow-mode disagreement log (cleared only via explicit clearShadowDisagreements() call)
// ---------------------------------------------------------------------------

/** @type {Array<{point: Object, fast: Object, robust: Object, chosen: Object}>} */
const _shadowDisagreements = [];

// ---------------------------------------------------------------------------
// Tolerance constants — centralized for determinism
// ---------------------------------------------------------------------------

/** Near-boundary distance threshold (multiplied with classification tol) */
const NEAR_FIELD_FACTOR = 5.0;

/** Number of deterministic ray directions to attempt before giving up */
const MAX_RAY_ATTEMPTS = 6;

/** Minimum confidence to accept a fast-path result */
const MIN_FAST_CONFIDENCE = 0.6;

/** Minimum solid angle (as fraction of 4π) to accept a winding result */
const WINDING_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Pre-computed deterministic ray directions (unit vectors, well-separated)
// ---------------------------------------------------------------------------

const _RAY_DIRS = _buildDeterministicRays();

function _buildDeterministicRays() {
  // Six well-separated directions that avoid axis-alignment
  const raw = [
    { x: 0.577350269, y: 0.577350269, z: 0.577350269 },   // (1,1,1)/√3
    { x: -0.577350269, y: 0.577350269, z: -0.577350269 },  // (-1,1,-1)/√3
    { x: 0.577350269, y: -0.577350269, z: -0.577350269 },  // (1,-1,-1)/√3
    { x: 0.137, y: 0.271, z: 0.953 },                      // quasi-random
    { x: -0.421, y: 0.637, z: 0.647 },                     // quasi-random
    { x: 0.816, y: -0.333, z: 0.471 },                     // quasi-random
  ];
  // Normalize
  return raw.map(r => {
    const len = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
    return { x: r.x / len, y: r.y / len, z: r.z / len };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a single point against a solid body.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {{x:number,y:number,z:number}} p
 * @param {Object} [opts]
 * @param {import('./Tolerance.js').Tolerance} [opts.tolerance]
 * @param {boolean} [opts.robustFallback=true]  Whether to try robust path on ambiguity
 * @returns {{ state: 'inside'|'outside'|'on'|'uncertain', confidence: number, detail: string }}
 */
export function classifyPoint(body, p, opts = {}) {
  const tol = opts.tolerance || DEFAULT_TOLERANCE;
  const robustFallback = opts.robustFallback !== false;

  if (!body || !body.shells || body.shells.length === 0) {
    return { state: 'outside', confidence: 1.0, detail: 'empty-body' };
  }

  // --- Check on-boundary first ---
  const bnd = _nearestBoundaryDistance(body, p, tol);
  if (bnd.distance <= tol.pointCoincidence) {
    return { state: 'on', confidence: 1.0, detail: 'on-boundary-vertex' };
  }
  if (bnd.distance <= tol.classification) {
    return { state: 'on', confidence: 0.9, detail: 'on-boundary-within-tolerance' };
  }

  // --- WASM fast path (plane + sphere bodies only) ---
  const wasmResult = _wasmClassifyPoint(body, p);
  if (wasmResult) return wasmResult;

  // --- Fast path: multi-ray parity vote ---
  const nearField = bnd.distance < tol.classification * NEAR_FIELD_FACTOR;
  const fastResult = _fastPathClassify(body, p, tol);

  // --- Shadow mode: always run robust path and record disagreements ---
  const shadowMode = getFlag('CAD_USE_GWN_CONTAINMENT');
  if (shadowMode) {
    const robustResult = _robustPathClassify(body, p, tol);
    const chosen = (robustResult.confidence > fastResult.confidence)
      ? robustResult : fastResult;
    if (fastResult.state !== robustResult.state &&
        fastResult.state !== 'uncertain' &&
        robustResult.state !== 'uncertain') {
      _shadowDisagreements.push({
        point: { x: p.x, y: p.y, z: p.z },
        fast: { ...fastResult },
        robust: { ...robustResult },
        chosen: { ...chosen },
      });
    }
    if (chosen.state !== 'uncertain') return chosen;
    warnOnceForFallback({
      id: 'containment:uncertain',
      policy: 'allow-fallback',
      reason: 'GWN and ray-cast containment both uncertain; returning ambiguous result',
      kind: 'degraded-result',
    });
    return { state: 'uncertain', confidence: chosen.confidence, detail: 'shadow-ambiguous' };
  }

  if (fastResult.confidence >= MIN_FAST_CONFIDENCE && !nearField) {
    return fastResult;
  }

  // --- Robust path (only when fast path is uncertain or near-field) ---
  if (robustFallback) {
    const robustResult = _robustPathClassify(body, p, tol);
    if (robustResult.confidence > fastResult.confidence) {
      return robustResult;
    }
  }

  // --- If still uncertain, return best result ---
  if (fastResult.confidence >= MIN_FAST_CONFIDENCE) {
    return fastResult;
  }

  warnOnceForFallback({
    id: 'containment:uncertain',
    policy: 'allow-fallback',
    reason: 'all containment paths returned low confidence; returning ambiguous result',
    kind: 'degraded-result',
  });
  return {
    state: 'uncertain',
    confidence: fastResult.confidence,
    detail: 'ambiguous-all-paths',
  };
}

/**
 * Classify multiple points against a body (batch).
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {Array<{x:number,y:number,z:number}>} points
 * @param {Object} [opts]
 * @returns {Array<{ state: string, confidence: number, detail: string }>}
 */
export function classifyPoints(body, points, opts = {}) {
  return points.map(p => classifyPoint(body, p, opts));
}

/**
 * Classify a face fragment as inside, outside, or coincident relative to a body.
 * Delegates to classifyPoint with an interior sample.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {import('./BRepTopology.js').TopoFace} fragment
 * @param {Object} [opts]
 * @param {import('./Tolerance.js').Tolerance} [opts.tolerance]
 * @returns {{ state: 'inside'|'outside'|'on'|'uncertain', confidence: number, detail: string }}
 */
export function classifyFragment(body, fragment, opts = {}) {
  const tol = opts.tolerance || DEFAULT_TOLERANCE;
  const testPoint = _sampleInteriorPoint(fragment);
  if (!testPoint) {
    return { state: 'outside', confidence: 0.5, detail: 'no-sample-point' };
  }

  return classifyPoint(body, testPoint, { ...opts, tolerance: tol });
}

/**
 * Check whether a 3D point lies on a face (within tolerance).
 *
 * @param {import('./BRepTopology.js').TopoFace} face
 * @param {{x:number,y:number,z:number}} p
 * @param {Object} [opts]
 * @param {import('./Tolerance.js').Tolerance} [opts.tolerance]
 * @returns {{ on: boolean, distance: number, detail: string }}
 */
export function isPointOnFace(face, p, opts = {}) {
  const tol = opts.tolerance || DEFAULT_TOLERANCE;
  if (!face.outerLoop) return { on: false, distance: Infinity, detail: 'no-outer-loop' };

  const boundary = face.outerLoop.points();
  if (boundary.length < 3) return { on: false, distance: Infinity, detail: 'degenerate-loop' };

  // Check proximity to boundary vertices
  for (const bp of boundary) {
    if (tol.pointsCoincident(p, bp)) {
      return { on: true, distance: 0, detail: 'on-vertex' };
    }
  }

  // Check proximity to boundary edges
  const edgeDist = _distanceToPolygonEdges(p, boundary);
  if (edgeDist <= tol.classification) {
    return { on: true, distance: edgeDist, detail: 'on-edge' };
  }

  // Check containment in face boundary (2D projection)
  const normal = _faceNormal(face, boundary);
  const { pts2D, pt2D } = _project3Dto2D(boundary, p, normal);
  const inside = _pointInPolygon2D(pt2D, pts2D);

  // Check inner loops (holes)
  if (inside && face.innerLoops) {
    for (const innerLoop of face.innerLoops) {
      const holeBoundary = innerLoop.points();
      if (holeBoundary.length < 3) continue;

      // Check if in a hole
      const holeDist = _distanceToPolygonEdges(p, holeBoundary);
      if (holeDist <= tol.classification) {
        return { on: true, distance: holeDist, detail: 'on-hole-edge' };
      }

      const { pts2D: hPts2D, pt2D: hPt2D } = _project3Dto2D(holeBoundary, p, normal);
      if (_pointInPolygon2D(hPt2D, hPts2D)) {
        return { on: false, distance: holeDist, detail: 'inside-hole' };
      }
    }
  }

  // Compute distance to face plane for surface proximity
  const facePlaneDist = _distanceToFacePlane(p, boundary, normal);

  return {
    on: inside && facePlaneDist <= tol.classification,
    distance: inside ? facePlaneDist : edgeDist,
    detail: inside ? 'inside-face-boundary' : 'outside-face-boundary',
  };
}

/**
 * Attempt to resolve an uncertain prior result with more expensive strategies.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {{x:number,y:number,z:number}} p
 * @param {{ state: string, confidence: number, detail: string }} priorResult
 * @param {Object} [opts]
 * @returns {{ state: string, confidence: number, detail: string }}
 */
export function maybeResolveUncertain(body, p, priorResult, opts = {}) {
  if (priorResult.state !== 'uncertain') return priorResult;

  const tol = (opts && opts.tolerance) || DEFAULT_TOLERANCE;

  // Try robust path with tighter tolerance
  const tightTol = tol.clone({ classification: tol.classification * 0.1 });
  const robustResult = _robustPathClassify(body, p, tightTol);

  if (robustResult.confidence > priorResult.confidence) {
    return robustResult;
  }

  // Try additional ray directions
  const extraResult = _extendedRayCast(body, p, tol);
  if (extraResult.confidence > priorResult.confidence) {
    return extraResult;
  }

  return priorResult;
}

// ---------------------------------------------------------------------------
// Fast path — multi-ray parity vote
// ---------------------------------------------------------------------------

/**
 * Cast multiple deterministic rays and vote on inside/outside.
 * Returns the consensus result with a confidence score.
 */
function _fastPathClassify(body, p, tol) {
  let insideVotes = 0;
  let outsideVotes = 0;
  let ambiguousRays = 0;

  const candidateFaces = _getCandidateFaces(body);

  for (let ri = 0; ri < MAX_RAY_ATTEMPTS; ri++) {
    const dir = _RAY_DIRS[ri % _RAY_DIRS.length];
    const result = _singleRayCast(p, dir, candidateFaces, tol);

    if (result.ambiguous) {
      ambiguousRays++;
      continue;
    }

    if (result.crossings % 2 === 1) {
      insideVotes++;
    } else {
      outsideVotes++;
    }
  }

  const totalValid = insideVotes + outsideVotes;
  if (totalValid === 0) {
    return { state: 'uncertain', confidence: 0, detail: 'all-rays-ambiguous' };
  }

  const majority = Math.max(insideVotes, outsideVotes);
  const confidence = majority / (totalValid + ambiguousRays);
  const state = insideVotes > outsideVotes ? 'inside' : 'outside';

  return {
    state,
    confidence,
    detail: `fast-parity(${insideVotes}i/${outsideVotes}o/${ambiguousRays}a)`,
  };
}

/**
 * Cast a single ray and count crossings. Returns { crossings, ambiguous }.
 */
function _singleRayCast(origin, dir, faces, tol) {
  let crossings = 0;
  let ambiguous = false;
  const eps = tol.modelingEpsilon;
  const classEps = tol.classification;

  for (const face of faces) {
    if (!face.outerLoop) continue;
    const pts = face.outerLoop.points();
    if (pts.length < 3) continue;

    // Fan-triangulate the face boundary
    for (let i = 1; i < pts.length - 1; i++) {
      const hit = _rayTriangleIntersect(origin, dir, pts[0], pts[i], pts[i + 1], eps);
      if (hit === null) continue;

      if (hit.nearEdge) {
        // Hit is close to a triangle edge — could be double-counted
        ambiguous = true;
        break;
      }

      if (hit.t > classEps) {
        crossings++;
      }
    }

    if (ambiguous) break;

    // Also check inner-loop triangles (holes subtract from face area)
    // For faces with inner loops, the outer-loop fan already covers the full
    // untrimmed region; inner loops would need trimming. For now, we rely on
    // the outer-loop parity which is correct for solid boundary faces.
  }

  return { crossings, ambiguous };
}

// ---------------------------------------------------------------------------
// Robust path — solid-angle winding number
// ---------------------------------------------------------------------------

/**
 * Compute a simplified solid-angle winding number for the query point.
 * Sums the signed solid angle subtended by each boundary face triangle.
 */
function _robustPathClassify(body, p, tol) {
  let totalSolidAngle = 0;
  const faces = _getCandidateFaces(body);

  for (const face of faces) {
    if (!face.outerLoop) continue;
    const pts = face.outerLoop.points();
    if (pts.length < 3) continue;

    const flipSign = face.sameSense === false ? -1 : 1;

    for (let i = 1; i < pts.length - 1; i++) {
      const omega = _triangleSolidAngle(p, pts[0], pts[i], pts[i + 1]);
      totalSolidAngle += omega * flipSign;
    }
  }

  // Normalize: a point inside a closed surface has winding ≈ ±4π
  const windingNumber = totalSolidAngle / (4 * Math.PI);
  const absWinding = Math.abs(windingNumber);

  if (absWinding > WINDING_THRESHOLD) {
    return {
      state: 'inside',
      confidence: Math.min(absWinding, 1.0),
      detail: `robust-winding(${windingNumber.toFixed(4)})`,
    };
  }

  if (absWinding < (1 - WINDING_THRESHOLD)) {
    return {
      state: 'outside',
      confidence: Math.min(1 - absWinding, 1.0),
      detail: `robust-winding(${windingNumber.toFixed(4)})`,
    };
  }

  return {
    state: 'uncertain',
    confidence: 0.3,
    detail: `robust-winding-ambiguous(${windingNumber.toFixed(4)})`,
  };
}

/**
 * Compute the signed solid angle subtended by a triangle as seen from point p.
 * Uses the Van Oosterom & Strackee formula.
 */
function _triangleSolidAngle(p, a, b, c) {
  const ra = { x: a.x - p.x, y: a.y - p.y, z: a.z - p.z };
  const rb = { x: b.x - p.x, y: b.y - p.y, z: b.z - p.z };
  const rc = { x: c.x - p.x, y: c.y - p.y, z: c.z - p.z };

  const la = Math.sqrt(ra.x * ra.x + ra.y * ra.y + ra.z * ra.z);
  const lb = Math.sqrt(rb.x * rb.x + rb.y * rb.y + rb.z * rb.z);
  const lc = Math.sqrt(rc.x * rc.x + rc.y * rc.y + rc.z * rc.z);

  if (la < 1e-15 || lb < 1e-15 || lc < 1e-15) return 0;

  // Triple product: ra · (rb × rc)
  const crossBC = {
    x: rb.y * rc.z - rb.z * rc.y,
    y: rb.z * rc.x - rb.x * rc.z,
    z: rb.x * rc.y - rb.y * rc.x,
  };
  const numerator = ra.x * crossBC.x + ra.y * crossBC.y + ra.z * crossBC.z;

  // Denominator: la*lb*lc + (ra·rb)*lc + (ra·rc)*lb + (rb·rc)*la
  const dotAB = ra.x * rb.x + ra.y * rb.y + ra.z * rb.z;
  const dotAC = ra.x * rc.x + ra.y * rc.y + ra.z * rc.z;
  const dotBC = rb.x * rc.x + rb.y * rc.y + rb.z * rc.z;
  const denominator = la * lb * lc + dotAB * lc + dotAC * lb + dotBC * la;

  return 2 * Math.atan2(numerator, denominator);
}

// ---------------------------------------------------------------------------
// Extended ray-cast (for resolving uncertain)
// ---------------------------------------------------------------------------

function _extendedRayCast(body, p, tol) {
  // Try additional quasi-random directions
  const extraDirs = [
    { x: 0.301, y: 0.904, z: 0.301 },
    { x: -0.707, y: 0.000, z: 0.707 },
    { x: 0.000, y: -0.707, z: 0.707 },
    { x: 0.408, y: 0.408, z: -0.816 },
  ];

  let insideVotes = 0;
  let outsideVotes = 0;
  const candidateFaces = _getCandidateFaces(body);

  for (const dir of extraDirs) {
    const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    const normDir = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
    const result = _singleRayCast(p, normDir, candidateFaces, tol);
    if (result.ambiguous) continue;
    if (result.crossings % 2 === 1) insideVotes++;
    else outsideVotes++;
  }

  const total = insideVotes + outsideVotes;
  if (total === 0) {
    return { state: 'uncertain', confidence: 0, detail: 'extended-all-ambiguous' };
  }

  const majority = Math.max(insideVotes, outsideVotes);
  const state = insideVotes > outsideVotes ? 'inside' : 'outside';
  return {
    state,
    confidence: majority / total * 0.8, // slightly discounted
    detail: `extended-parity(${insideVotes}i/${outsideVotes}o)`,
  };
}

// ---------------------------------------------------------------------------
// AABB face candidate filtering
// ---------------------------------------------------------------------------

/**
 * Get all faces from a body.
 * Future optimization: build an AABB tree and filter by ray bounding box.
 */
function _getCandidateFaces(body) {
  const faces = [];
  for (const shell of body.shells) {
    for (const face of shell.faces) {
      faces.push(face);
    }
  }
  return faces;
}

// ---------------------------------------------------------------------------
// Boundary distance computation
// ---------------------------------------------------------------------------

/**
 * Compute the distance from a point to the nearest boundary element of a body.
 * Checks: face surfaces (plane distance), boundary vertices, boundary edges, inner loops.
 */
function _nearestBoundaryDistance(body, p, tol) {
  let minDist = Infinity;
  let detail = 'no-faces';

  for (const shell of body.shells) {
    for (const face of shell.faces) {
      if (!face.outerLoop) continue;
      const pts = face.outerLoop.points();
      if (pts.length < 3) continue;

      const normal = _faceNormal(face, pts);

      // Check if point is close to the face plane AND inside the face boundary
      const planeDist = _distanceToFacePlane(p, pts, normal);
      if (planeDist < minDist) {
        // Also check if point projects inside the face boundary
        const { pts2D, pt2D } = _project3Dto2D(pts, p, normal);
        if (_pointInPolygon2D(pt2D, pts2D)) {
          // Check inner loops — if inside a hole, it's not on the face
          let inHole = false;
          if (face.innerLoops) {
            for (const innerLoop of face.innerLoops) {
              const hPts = innerLoop.points();
              if (hPts.length < 3) continue;
              const { pts2D: hPts2D, pt2D: hPt2D } = _project3Dto2D(hPts, p, normal);
              if (_pointInPolygon2D(hPt2D, hPts2D)) { inHole = true; break; }
            }
          }
          if (!inHole) {
            minDist = planeDist;
            detail = 'near-face-surface';
          }
        }
      }

      // Distance to boundary vertices
      for (const bp of pts) {
        const d = _dist3(p, bp);
        if (d < minDist) {
          minDist = d;
          detail = 'near-vertex';
        }
      }

      // Distance to boundary edges
      const d = _distanceToPolygonEdges(p, pts);
      if (d < minDist) {
        minDist = d;
        detail = 'near-edge';
      }

      // Check inner loops too
      if (face.innerLoops) {
        for (const innerLoop of face.innerLoops) {
          const hPts = innerLoop.points();
          for (const bp of hPts) {
            const d2 = _dist3(p, bp);
            if (d2 < minDist) { minDist = d2; detail = 'near-hole-vertex'; }
          }
          const d3 = _distanceToPolygonEdges(p, hPts);
          if (d3 < minDist) { minDist = d3; detail = 'near-hole-edge'; }
        }
      }
    }
  }

  return { distance: minDist, detail };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Möller–Trumbore ray-triangle intersection with edge-proximity detection.
 * Returns { t, nearEdge } on hit, null on miss.
 */
function _rayTriangleIntersect(origin, dir, v0, v1, v2, eps) {
  const e1 = { x: v1.x - v0.x, y: v1.y - v0.y, z: v1.z - v0.z };
  const e2 = { x: v2.x - v0.x, y: v2.y - v0.y, z: v2.z - v0.z };

  const h = {
    x: dir.y * e2.z - dir.z * e2.y,
    y: dir.z * e2.x - dir.x * e2.z,
    z: dir.x * e2.y - dir.y * e2.x,
  };

  const a = e1.x * h.x + e1.y * h.y + e1.z * h.z;
  if (Math.abs(a) < eps) return null;

  const f = 1.0 / a;
  const s = { x: origin.x - v0.x, y: origin.y - v0.y, z: origin.z - v0.z };
  const u = f * (s.x * h.x + s.y * h.y + s.z * h.z);
  if (u < -eps || u > 1.0 + eps) return null;

  const q = {
    x: s.y * e1.z - s.z * e1.y,
    y: s.z * e1.x - s.x * e1.z,
    z: s.x * e1.y - s.y * e1.x,
  };
  const v = f * (dir.x * q.x + dir.y * q.y + dir.z * q.z);
  if (v < -eps || u + v > 1.0 + eps) return null;

  const t = f * (e2.x * q.x + e2.y * q.y + e2.z * q.z);
  if (t <= eps) return null;

  // Detect near-edge hits: u ≈ 0, v ≈ 0, or u+v ≈ 1
  const edgeThreshold = 1e-4;
  const nearEdge = u < edgeThreshold || v < edgeThreshold ||
                   (u + v) > (1.0 - edgeThreshold);

  return { t, nearEdge };
}

/**
 * Compute the distance from a point to the edge-segments of a polygon.
 */
function _distanceToPolygonEdges(p, pts) {
  let minDist = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const d = _distPointSegment(p, a, b);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/**
 * Distance from a 3D point to a line segment [a, b].
 */
function _distPointSegment(p, a, b) {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
  const dot = ap.x * ab.x + ap.y * ab.y + ap.z * ab.z;
  const lenSq = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;

  if (lenSq < 1e-30) return _dist3(p, a);

  const t = Math.max(0, Math.min(1, dot / lenSq));
  const proj = {
    x: a.x + ab.x * t,
    y: a.y + ab.y * t,
    z: a.z + ab.z * t,
  };
  return _dist3(p, proj);
}

/**
 * Distance between two 3D points.
 */
function _dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Distance from a point to a face plane.
 */
function _distanceToFacePlane(p, boundaryPts, normal) {
  // Use first boundary point as plane origin
  const d = (p.x - boundaryPts[0].x) * normal.x +
            (p.y - boundaryPts[0].y) * normal.y +
            (p.z - boundaryPts[0].z) * normal.z;
  return Math.abs(d);
}

/**
 * Project 3D points to 2D along a normal (same approach as FaceSplitter).
 */
function _project3Dto2D(pts3D, point3D, normal) {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);

  let u, v;
  if (az >= ax && az >= ay) {
    u = (p) => p.x; v = (p) => p.y;
  } else if (ay >= ax) {
    u = (p) => p.x; v = (p) => p.z;
  } else {
    u = (p) => p.y; v = (p) => p.z;
  }

  return {
    pts2D: pts3D.map(p => ({ u: u(p), v: v(p) })),
    pt2D: { u: u(point3D), v: v(point3D) },
  };
}

/**
 * 2D point-in-polygon using ray casting.
 */
function _pointInPolygon2D(pt, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = polygon[i], pj = polygon[j];
    if ((pi.v > pt.v) !== (pj.v > pt.v) &&
        pt.u < (pj.u - pi.u) * (pt.v - pi.v) / (pj.v - pi.v) + pi.u) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Compute the face normal, respecting sameSense.
 */
function _faceNormal(face, boundaryPts) {
  let n = null;
  if (boundaryPts && boundaryPts.length >= 3) {
    n = _polyNormal(boundaryPts);
  }
  if (!n && face.surface) {
    n = GeometryEvaluator.evalSurface(face.surface,
      (face.surface.uMin + face.surface.uMax) / 2,
      (face.surface.vMin + face.surface.vMax) / 2,
    ).n;
  }
  if (!n) n = { x: 0, y: 0, z: 1 };
  if (face.sameSense === false) {
    return { x: -n.x, y: -n.y, z: -n.z };
  }
  return n;
}

/**
 * Compute polygon normal from Newell's method.
 */
function _polyNormal(pts) {
  if (pts.length < 3) return { x: 0, y: 0, z: 1 };
  // Newell method: robust for polygons whose first 3 vertices are collinear
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const c = pts[i];
    const n = pts[(i + 1) % pts.length];
    nx += (c.y - n.y) * (c.z + n.z);
    ny += (c.z - n.z) * (c.x + n.x);
    nz += (c.x - n.x) * (c.y + n.y);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-14) return { x: 0, y: 0, z: 1 };
  return { x: nx / len, y: ny / len, z: nz / len };
}

/**
 * Sample an interior point of a face, offset slightly along the face normal.
 */
function _sampleInteriorPoint(face) {
  if (face.outerLoop) {
    const pts = face.outerLoop.points();
    if (pts.length >= 3) {
      // Use full polygon centroid (robust for collinear first-3-vertex cases)
      let cx = 0, cy = 0, cz = 0;
      for (const p of pts) { cx += p.x; cy += p.y; cz += p.z; }
      const centroid = { x: cx / pts.length, y: cy / pts.length, z: cz / pts.length };
      const n = _faceNormal(face, pts);
      return {
        x: centroid.x + n.x * 1e-5,
        y: centroid.y + n.y * 1e-5,
        z: centroid.z + n.z * 1e-5,
      };
    }
  }

  if (face.surface) {
    const uMid = (face.surface.uMin + face.surface.uMax) / 2;
    const vMid = (face.surface.vMin + face.surface.vMax) / 2;
    const point = GeometryEvaluator.evalSurface(face.surface, uMid, vMid).p;
    const n = _faceNormal(face, null);
    return {
      x: point.x + n.x * 1e-5,
      y: point.y + n.y * 1e-5,
      z: point.z + n.z * 1e-5,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Shadow-mode diagnostics API
// ---------------------------------------------------------------------------

/**
 * Return a snapshot of shadow-mode disagreements recorded so far.
 * Each entry records the query point, fast-path result, robust-path result,
 * and which one was ultimately chosen.
 *
 * @returns {ReadonlyArray<{point: Object, fast: Object, robust: Object, chosen: Object}>}
 */
export function getShadowDisagreements() {
  return Object.freeze([..._shadowDisagreements]);
}

/**
 * Clear the accumulated shadow disagreement log.
 */
export function clearShadowDisagreements() {
  _shadowDisagreements.length = 0;
}

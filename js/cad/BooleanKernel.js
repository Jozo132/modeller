// js/cad/BooleanKernel.js — Exact B-Rep boolean operations
//
// Provides union, subtract, and intersect on exact B-Rep topology.
// Replaces mesh BSP with exact surface/surface intersection pipeline.
//
// Pipeline:
//   1. Intersect every candidate face pair
//   2. Compute exact intersection curves
//   3. Split support faces by intersection curves
//   4. Build trimmed face fragments in parameter space
//   5. Classify each fragment as inside, outside, or coincident
//   6. Keep or discard fragments according to boolean type
//   7. Stitch kept fragments into shells
//   8. Sew vertices and edges within tolerance
//   9. Validate shell orientation and closure
//  10. Tessellate the result for rendering
//
// When CAD_ALLOW_DISCRETE_FALLBACK=1, a discrete fallback lane activates
// on exact-path failure.  Fallback results are always explicitly flagged.

import { intersectBodies } from './Intersections.js';
import { splitFace, classifyFragment } from './FaceSplitter.js';
import { classifyPoint as containmentClassifyPoint } from './Containment.js';
import { buildBody } from './ShellBuilder.js';
import { tessellateBody } from './Tessellation.js';
import { DEFAULT_TOLERANCE, Tolerance } from './Tolerance.js';
import { SurfaceType, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex } from './BRepTopology.js';
import { NurbsSurface } from './NurbsSurface.js';
import { NurbsCurve } from './NurbsCurve.js';
import { validateIntersections, validateFragments, validateFinalBody } from './IntersectionValidator.js';
import { healFragments } from './Healing.js';
import { ResultGrade, FallbackDiagnostics } from './fallback/FallbackDiagnostics.js';
import {
  isFallbackEnabled, shouldTriggerFallback, evaluateExactResult,
  wrapResult, FallbackTrigger,
} from './fallback/FallbackPolicy.js';
import { meshBooleanOp } from './fallback/MeshBoolean.js';
import { validateBooleanResult } from './BooleanInvariantValidator.js';
import { getFlag } from '../featureFlags.js';

/**
 * Perform an exact boolean operation on two TopoBody operands.
 *
 * When CAD_ALLOW_DISCRETE_FALLBACK=1 and the exact path fails invariants,
 * the discrete fallback lane activates automatically.  Fallback results
 * carry resultGrade === 'fallback' and _isFallback === true.
 *
 * @param {import('./BRepTopology.js').TopoBody} bodyA
 * @param {import('./BRepTopology.js').TopoBody} bodyB
 * @param {'union'|'subtract'|'intersect'} operation
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {{
 *   body: import('./BRepTopology.js').TopoBody|null,
 *   mesh: {vertices: Array, faces: Array, edges: Array},
 *   diagnostics: Object,
 *   resultGrade?: string,
 *   _isFallback?: boolean,
 *   fallbackDiagnostics?: Object,
 * }}
 */
export function exactBooleanOp(bodyA, bodyB, operation, tol = DEFAULT_TOLERANCE) {
  // Try exact path first; catch unexpected errors to route to fallback
  try {
    const result = _exactBooleanOpInner(bodyA, bodyB, operation, tol);

    // Evaluate whether exact result has concerning diagnostics
    const evaluation = evaluateExactResult(result.diagnostics);
    if (evaluation.shouldFallback && shouldTriggerFallback(evaluation.trigger)) {
      return _runFallback(bodyA, bodyB, operation, evaluation.trigger, evaluation.stage, result.diagnostics);
    }

    // Exact path succeeded — return with explicit grade
    return wrapResult(result, ResultGrade.EXACT, FallbackDiagnostics.exact(result.diagnostics));
  } catch (err) {
    // Uncaught exception in exact path — route to fallback if enabled
    if (shouldTriggerFallback(FallbackTrigger.UNCAUGHT_EXCEPTION)) {
      return _runFallback(bodyA, bodyB, operation, FallbackTrigger.UNCAUGHT_EXCEPTION, 'exact_pipeline', { error: err.message });
    }
    // Fallback not enabled — rethrow
    throw err;
  }
}

/**
 * Run the discrete fallback lane.
 * @private
 */
function _runFallback(bodyA, bodyB, operation, trigger, stage, exactDiagnostics) {
  _writeDiagnosticArtifact(operation, { trigger, stage, exactDiagnostics, path: 'fallback' });
  try {
    const fbResult = meshBooleanOp(bodyA, bodyB, operation);
    const diag = FallbackDiagnostics.fallback(
      trigger, stage,
      {
        meshValidation: fbResult.validation,
        adjacency: {
          boundaryEdgeCount: fbResult.adjacency.boundaryEdgeCount,
          nonManifoldEdgeCount: fbResult.adjacency.nonManifoldEdgeCount,
          isManifold: fbResult.adjacency.isManifold,
          isClosed: fbResult.adjacency.isClosed,
          eulerCharacteristic: fbResult.adjacency.eulerCharacteristic,
        },
        manifoldRepairAttempted: fbResult.manifoldRepairAttempted,
      },
      exactDiagnostics,
    );
    return wrapResult(
      { body: null, mesh: fbResult.mesh, diagnostics: exactDiagnostics },
      ResultGrade.FALLBACK,
      diag,
    );
  } catch (fbErr) {
    // Both exact and fallback failed
    _writeDiagnosticArtifact(operation, { trigger, stage, exactDiagnostics, path: 'failed', error: fbErr.message });
    const diag = FallbackDiagnostics.failed(
      trigger, stage, exactDiagnostics,
    );
    return wrapResult(
      { body: null, mesh: { vertices: [], faces: [], edges: [] }, diagnostics: exactDiagnostics },
      ResultGrade.FAILED,
      diag,
    );
  }
}

/**
 * Inner exact boolean pipeline (original logic, extracted for fallback wrapping).
 * @private
 */
function _exactBooleanOpInner(bodyA, bodyB, operation, tol) {
  if (_isPlanarBody(bodyA) && _isPlanarBody(bodyB)) {
    const planar = _exactPlanarBoolean(bodyA, bodyB, operation, tol);
    if (planar) return { ...planar, diagnostics: planar.diagnostics || {} };
  }

  // Step 1-2: Intersect candidate face pairs and compute intersection curves
  const intersections = intersectBodies(bodyA, bodyB, tol);

  // Step 2b: Validate intersections — fail fast with diagnostics
  const ixValidation = validateIntersections(intersections, tol);
  const diagnostics = { intersectionValidation: ixValidation.toJSON() };
  if (!ixValidation.isValid) {
    // Route to discrete fallback: skip invalid exact intersections and
    // proceed with only the valid subset (non-empty-curves entries that passed).
    // Attach diagnostic report for downstream inspection.
    const validIx = intersections.filter((ix, i) => {
      // Keep entries that didn't produce diagnostics referencing their index
      return !ixValidation.diagnostics.some(d => d.detail.startsWith(`intersection[${i}]`));
    });
    if (validIx.length === 0 && intersections.length > 0) {
      // All intersections invalid — return bodies unmodified via fallback
      const fallbackBody = buildBody([...bodyA.faces(), ...bodyB.faces()], tol);
      const mesh = tessellateBody(fallbackBody);
      return { body: fallbackBody, mesh, diagnostics };
    }
    // Use only valid intersections
    intersections.length = 0;
    intersections.push(...validIx);
    diagnostics.filteredIntersections = true;
  }

  // Step 3-4: Split faces by intersection curves
  const fragmentsA = _splitAllFaces(bodyA, intersections, 'A', tol);
  const fragmentsB = _splitAllFaces(bodyB, intersections, 'B', tol);

  // Step 4b: Validate split fragments
  const fragValidationA = validateFragments(fragmentsA, tol);
  const fragValidationB = validateFragments(fragmentsB, tol);
  diagnostics.fragmentValidationA = fragValidationA.toJSON();
  diagnostics.fragmentValidationB = fragValidationB.toJSON();

  // Step 4c: Heal fragments before classification
  const healedA = healFragments(fragmentsA, tol);
  const healedB = healFragments(fragmentsB, tol);
  diagnostics.healingA = healedA.report.toJSON();
  diagnostics.healingB = healedB.report.toJSON();

  // Step 5-6: Classify and select fragments
  const keptFragments = _classifyAndSelect(
    healedA.fragments, healedB.fragments, bodyA, bodyB, operation, tol,
  );

  // Step 7-8: Stitch fragments into a result body (includes sewing)
  const resultBody = buildBody(keptFragments, tol);

  // Step 9: Validate final body — attach diagnostics
  const bodyValidation = validateFinalBody(resultBody, tol);
  diagnostics.finalBodyValidation = bodyValidation.toJSON();

  // Step 9b: Run BooleanInvariantValidator — comprehensive post-condition check
  const invariantValidation = validateBooleanResult(resultBody, {
    operation,
    tolerance: tol,
    expectClosed: true,
  });
  diagnostics.invariantValidation = invariantValidation.toJSON();

  // Step 9c: Fail closed when strict invariants are enabled
  if (getFlag('CAD_STRICT_INVARIANTS') && !invariantValidation.isValid) {
    _writeDiagnosticArtifact(operation, diagnostics);
    const err = new Error(
      `Boolean invariant violation (strict mode): ${invariantValidation.diagnostics.length} issue(s) detected`
    );
    err.diagnostics = diagnostics;
    throw err;
  }

  // Step 10: Tessellate for rendering
  const mesh = tessellateBody(resultBody);

  // Step 11: Compute content hashes for auditability
  const hashes = _computeBodyHashes(bodyA, bodyB, resultBody);
  diagnostics.hashes = hashes;

  return { body: resultBody, mesh, diagnostics };
}

function _isPlanarBody(body) {
  if (!body || !Array.isArray(body.shells) || body.shells.length === 0) return false;
  return body.faces().every(face =>
    face &&
    face.surfaceType === SurfaceType.PLANE &&
    face.surface &&
    face.outerLoop &&
    face.innerLoops.length === 0
  );
}

function _exactPlanarBoolean(bodyA, bodyB, operation, tol) {
  const polysA = _splitPolygonsByBody(_bodyToPolygons(bodyA), bodyB, tol);
  const polysB = _splitPolygonsByBody(_bodyToPolygons(bodyB), bodyA, tol);

  const kept = [];
  for (const poly of polysA) {
    const cls = _classifyPlanarPolygon(poly, bodyB, tol);
    if (_shouldKeep(cls, operation, 'A')) kept.push(poly);
  }
  for (const poly of polysB) {
    const cls = _classifyPlanarPolygon(poly, bodyA, tol);
    if (_shouldKeep(cls, operation, 'B')) {
      kept.push(operation === 'subtract' ? _reversePolygon(poly) : poly);
    }
  }

  const cleaned = _dedupePlanarPolygons(kept, tol);
  if (cleaned.length === 0) return null;
  _fixPolygonTJunctions(cleaned, tol);
  const stitchedPolys = _dedupePlanarPolygons(cleaned, tol);

  const faces = stitchedPolys.map(poly => _polygonToTopoFace(poly, tol)).filter(Boolean);
  const resultBody = buildBody(faces, tol);
  const mesh = tessellateBody(resultBody);
  return { body: resultBody, mesh };
}

/**
 * Split all faces of a body by intersection curves.
 */
function _splitAllFaces(body, intersections, side, tol) {
  const fragments = [];
  const faceIntersectionMap = new Map();

  // Organize intersections by face
  for (const ix of intersections) {
    const face = side === 'A' ? ix.faceA : ix.faceB;
    if (!faceIntersectionMap.has(face.id)) {
      faceIntersectionMap.set(face.id, []);
    }

    for (const c of ix.curves) {
      faceIntersectionMap.get(face.id).push({
        curve: c.curve,
        paramsOnFace: side === 'A' ? c.paramsA : c.paramsB,
      });
    }
  }

  // Split each face
  for (const face of body.faces()) {
    const curves = faceIntersectionMap.get(face.id);
    if (curves && curves.length > 0) {
      const frags = splitFace(face, curves, tol);
      fragments.push(...frags);
    } else {
      fragments.push(face);
    }
  }

  return fragments;
}

/**
 * Classify fragments and select which to keep based on boolean operation.
 */
function _classifyAndSelect(fragmentsA, fragmentsB, bodyA, bodyB, operation, tol) {
  const kept = [];

  // Classify A fragments against B
  for (const frag of fragmentsA) {
    const cls = classifyFragment(frag, bodyB, tol);
    const keep = _shouldKeep(cls, operation, 'A');
    if (keep) kept.push(frag);
  }

  // Classify B fragments against A
  for (const frag of fragmentsB) {
    const cls = classifyFragment(frag, bodyA, tol);
    const keep = _shouldKeep(cls, operation, 'B');
    if (keep) {
      // For subtract, reverse face orientation for B fragments kept inside A
      if (operation === 'subtract' && cls === 'inside') {
        frag.sameSense = !frag.sameSense;
      }
      kept.push(frag);
    }
  }

  return kept;
}

/**
 * Determine whether to keep a fragment based on classification and operation.
 *
 * @param {'inside'|'outside'|'coincident'} classification
 * @param {'union'|'subtract'|'intersect'} operation
 * @param {'A'|'B'} operand
 * @returns {boolean}
 */
function _shouldKeep(classification, operation, operand) {
  switch (operation) {
    case 'union':
      // Keep outside fragments from both operands
      return classification === 'outside' || classification === 'coincident';

    case 'subtract':
      if (operand === 'A') {
        // Keep A outside B
        return classification === 'outside';
      } else {
        // Keep B inside A (reversed)
        return classification === 'inside';
      }

    case 'intersect':
      // Keep inside fragments from both operands
      return classification === 'inside' || classification === 'coincident';

    default:
      return false;
  }
}

function _bodyToPolygons(body) {
  return body.faces().map(face => {
    const verts = face.outerLoop.points();
    const oriented = face.sameSense === false ? [...verts].reverse() : verts;
    const normal = _polygonNormal(oriented);
    return {
      vertices: oriented.map(v => ({ ...v })),
      normal,
      shared: face.shared ? { ...face.shared } : null,
      surfaceType: face.surfaceType,
    };
  }).filter(poly => poly.vertices.length >= 3 && _vecLen(poly.normal) > 1e-10);
}

function _splitPolygonsByBody(polygons, body, tol) {
  let fragments = polygons;
  for (const splitter of _bodyToPolygons(body)) {
    const plane = {
      normal: splitter.normal,
      w: _dot(splitter.normal, splitter.vertices[0]),
    };
    const next = [];
    for (const poly of fragments) {
      next.push(..._splitPolygonByPlane(poly, plane, tol));
    }
    fragments = next;
  }
  return fragments;
}

function _splitPolygonByPlane(poly, plane, tol) {
  const verts = poly.vertices;
  const front = [];
  const back = [];
  const side = [];
  for (const v of verts) {
    const d = _dot(plane.normal, v) - plane.w;
    side.push(Math.abs(d) <= tol.intersection ? 0 : d > 0 ? 1 : -1);
  }
  let hasFront = false, hasBack = false;
  for (const s of side) { if (s > 0) hasFront = true; if (s < 0) hasBack = true; }
  if (!hasFront || !hasBack) return [poly];

  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const sa = side[i];
    const sb = side[(i + 1) % verts.length];

    if (sa >= 0) front.push({ ...a });
    if (sa <= 0) back.push({ ...a });

    if ((sa > 0 && sb < 0) || (sa < 0 && sb > 0)) {
      const da = _dot(plane.normal, a) - plane.w;
      const db = _dot(plane.normal, b) - plane.w;
      const t = da / (da - db);
      const p = {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
      };
      front.push(p);
      back.push({ ...p });
    }
  }

  const out = [];
  const frontPoly = _cleanPolygon({ ...poly, vertices: front }, tol);
  const backPoly = _cleanPolygon({ ...poly, vertices: back }, tol);
  if (frontPoly) out.push(frontPoly);
  if (backPoly) out.push(backPoly);
  return out.length > 0 ? out : [poly];
}

function _classifyPlanarPolygon(poly, body, tol) {
  const c = _polygonCentroid(poly.vertices);
  const n = _normalize(poly.normal);
  const p = {
    x: c.x + n.x * (tol.pointCoincidence * 10),
    y: c.y + n.y * (tol.pointCoincidence * 10),
    z: c.z + n.z * (tol.pointCoincidence * 10),
  };
  const result = containmentClassifyPoint(body, p, { tolerance: tol });
  // Map Containment state to legacy classification strings
  switch (result.state) {
    case 'inside': return 'inside';
    case 'on': return 'inside'; // on-boundary treated as inside for planar classification
    case 'uncertain': return _rayCastClassifyPoint(p, body, tol); // fallback
    default: return 'outside';
  }
}

function _rayCastClassifyPoint(point, body, tol) {
  let crossings = 0;
  const dir = { x: 0.137, y: 0.271, z: 1 };
  for (const face of body.faces()) {
    if (!face.outerLoop) continue;
    const pts = face.outerLoop.points();
    for (let i = 1; i < pts.length - 1; i++) {
      if (_rayTriangleIntersect(point, dir, pts[0], pts[i], pts[i + 1], tol)) crossings++;
    }
  }
  return crossings % 2 === 1 ? 'inside' : 'outside';
}

function _rayTriangleIntersect(origin, dir, v0, v1, v2, tol) {
  const eps = tol.modelingEpsilon;
  const e1 = _sub(v1, v0);
  const e2 = _sub(v2, v0);
  const h = _cross(dir, e2);
  const a = _dot(e1, h);
  if (Math.abs(a) < eps) return false;
  const f = 1 / a;
  const s = _sub(origin, v0);
  const u = f * _dot(s, h);
  if (u < -eps || u > 1 + eps) return false;
  const q = _cross(s, e1);
  const v = f * _dot(dir, q);
  if (v < -eps || u + v > 1 + eps) return false;
  const t = f * _dot(e2, q);
  return t > eps;
}

function _reversePolygon(poly) {
  return {
    ...poly,
    vertices: [...poly.vertices].reverse(),
    normal: { x: -poly.normal.x, y: -poly.normal.y, z: -poly.normal.z },
  };
}

function _dedupePlanarPolygons(polygons, tol) {
  const seen = new Set();
  const out = [];
  for (const poly of polygons) {
    const clean = _cleanPolygon(poly, tol);
    if (!clean) continue;
    const key = _polygonKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function _fixPolygonTJunctions(polygons, tol) {
  const uniqueVerts = [];
  for (const poly of polygons) {
    for (const v of poly.vertices) {
      if (!uniqueVerts.some(u => _pointsCoincident(u, v, tol))) uniqueVerts.push({ ...v });
    }
  }

  for (const poly of polygons) {
    const nextVerts = [];
    const verts = poly.vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      nextVerts.push({ ...a });

      const ab = _sub(b, a);
      const lenSq = _dot(ab, ab);
      if (lenSq <= 1e-14) continue;

      const onEdge = [];
      for (const p of uniqueVerts) {
        if (_pointsCoincident(p, a, tol) || _pointsCoincident(p, b, tol)) continue;
        const ap = _sub(p, a);
        const cross = _cross(ab, ap);
        if (_vecLen(cross) > tol.intersection * 10) continue;
        const t = _dot(ap, ab) / lenSq;
        if (t <= tol.intersection || t >= 1 - tol.intersection) continue;
        const proj = {
          x: a.x + ab.x * t,
          y: a.y + ab.y * t,
          z: a.z + ab.z * t,
        };
        if (!_pointsCoincident(proj, p, tol)) continue;
        onEdge.push({ t, point: { ...p } });
      }

      onEdge.sort((m, n) => m.t - n.t);
      for (const hit of onEdge) nextVerts.push(hit.point);
    }
    poly.vertices = _cleanPolygon({ ...poly, vertices: nextVerts }, tol)?.vertices || poly.vertices;
    poly.normal = _polygonNormal(poly.vertices);
  }
}

function _cleanPolygon(poly, tol) {
  const verts = [];
  for (const v of poly.vertices) {
    if (verts.length === 0 || !_pointsCoincident(verts[verts.length - 1], v, tol)) {
      verts.push({ ...v });
    }
  }
  if (verts.length > 1 && _pointsCoincident(verts[0], verts[verts.length - 1], tol)) verts.pop();
  if (verts.length < 3) return null;
  const normal = _polygonNormal(verts);
  if (_vecLen(normal) <= 1e-10) return null;
  return { ...poly, vertices: verts, normal };
}

function _polygonToTopoFace(poly, tol) {
  const cleaned = _cleanPolygon(poly, tol);
  if (!cleaned) return null;
  const verts = cleaned.vertices.map(v => new TopoVertex(v, tol.pointCoincidence));
  const coedges = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const edge = new TopoEdge(a, b, NurbsCurve.createLine(a.point, b.point), tol.edgeOverlap);
    coedges.push(new TopoCoEdge(edge, true, null));
  }
  const face = new TopoFace(
    NurbsSurface.createPlane(
      cleaned.vertices[0],
      _sub(cleaned.vertices[1], cleaned.vertices[0]),
      _sub(cleaned.vertices[cleaned.vertices.length - 1], cleaned.vertices[0]),
    ),
    SurfaceType.PLANE,
    true,
  );
  face.shared = cleaned.shared ? { ...cleaned.shared } : null;
  face.setOuterLoop(new TopoLoop(coedges));
  return face;
}

function _polygonCentroid(vertices) {
  let x = 0, y = 0, z = 0;
  for (const v of vertices) { x += v.x; y += v.y; z += v.z; }
  const n = vertices.length || 1;
  return { x: x / n, y: y / n, z: z / n };
}

function _polygonNormal(vertices) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < vertices.length; i++) {
    const curr = vertices[i];
    const next = vertices[(i + 1) % vertices.length];
    nx += (curr.y - next.y) * (curr.z + next.z);
    ny += (curr.z - next.z) * (curr.x + next.x);
    nz += (curr.x - next.x) * (curr.y + next.y);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return len > 1e-10 ? { x: nx / len, y: ny / len, z: nz / len } : { x: 0, y: 0, z: 0 };
}

function _polygonKey(poly) {
  const keys = poly.vertices.map(v => `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`);
  const rotations = [];
  for (let i = 0; i < keys.length; i++) rotations.push(keys.slice(i).concat(keys.slice(0, i)).join('|'));
  const reversed = [...keys].reverse();
  for (let i = 0; i < reversed.length; i++) rotations.push(reversed.slice(i).concat(reversed.slice(0, i)).join('|'));
  rotations.sort();
  return rotations[0];
}

function _pointsCoincident(a, b, tol) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= tol.pointCoincidence * 10;
}

function _normalize(v) {
  const len = _vecLen(v);
  return len > 1e-10 ? { x: v.x / len, y: v.y / len, z: v.z / len } : { x: 0, y: 0, z: 1 };
}

function _vecLen(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function _dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function _cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function _sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/**
 * Check if two bodies have exact B-Rep topology.
 *
 * @param {import('./BRepTopology.js').TopoBody|null} body
 * @returns {boolean}
 */
export function hasExactTopology(body) {
  if (!body) return false;
  if (body.shells.length === 0) return false;
  for (const shell of body.shells) {
    if (shell.faces.length === 0) return false;
    for (const face of shell.faces) {
      if (!face.outerLoop) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Content hashing for auditability
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic content hash for a TopoBody.
 * Uses face/edge/vertex counts and vertex coordinate sums for a lightweight
 * fingerprint (not cryptographic — just for deduplication / auditing).
 *
 * @param {import('./BRepTopology.js').TopoBody|null} body
 * @returns {string} hex hash string
 */
function _hashBody(body) {
  if (!body || !body.shells) return '0';
  let h = 0x811c9dc5; // FNV-1a offset
  const faces = body.faces();
  h = _fnv1aStep(h, faces.length);
  for (const face of faces) {
    if (!face.outerLoop) continue;
    const pts = face.outerLoop.points();
    h = _fnv1aStep(h, pts.length);
    for (const p of pts) {
      h = _fnv1aStep(h, _quantize(p.x));
      h = _fnv1aStep(h, _quantize(p.y));
      h = _fnv1aStep(h, _quantize(p.z));
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function _fnv1aStep(h, val) {
  h ^= (val & 0xffff);
  h = Math.imul(h, 0x01000193);
  h ^= ((val >>> 16) & 0xffff);
  h = Math.imul(h, 0x01000193);
  return h;
}

function _quantize(v) {
  // Quantize to 6 decimal places for determinism
  return Math.round(v * 1e6) | 0;
}

function _computeBodyHashes(bodyA, bodyB, resultBody) {
  return {
    operandA: _hashBody(bodyA),
    operandB: _hashBody(bodyB),
    result: _hashBody(resultBody),
  };
}

// ---------------------------------------------------------------------------
// Diagnostic JSON artifact writer
// ---------------------------------------------------------------------------

/**
 * Write a diagnostic JSON artifact to CAD_DIAGNOSTICS_DIR when configured.
 * Fire-and-forget — never throws.
 *
 * @param {string} operation
 * @param {Object} diagnostics
 */
function _writeDiagnosticArtifact(operation, diagnostics) {
  try {
    const dir = getFlag('CAD_DIAGNOSTICS_DIR');
    if (!dir) return;
    // Dynamic import to avoid hard dependency in browser bundles
    const fs = _requireFs();
    if (!fs) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `boolean-${operation}-${timestamp}.json`;
    const filepath = dir.endsWith('/') ? dir + filename : dir + '/' + filename;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filepath, JSON.stringify(diagnostics, null, 2));
  } catch {
    // Silently ignored: browser or restricted environment
  }
}

function _requireFs() {
  try {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      // eslint-disable-next-line no-eval
      return eval("require('fs')");
    }
  } catch {
    // Not available
  }
  return null;
}

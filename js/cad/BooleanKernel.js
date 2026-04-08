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
import { mergeCoplanarFaces, removeCollinearEdgeVertices } from './CoplanarMerge.js';
import { DEFAULT_TOLERANCE, Tolerance } from './Tolerance.js';
import { SurfaceType, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex } from './BRepTopology.js';
import { NurbsSurface } from './NurbsSurface.js';
import { NurbsCurve } from './NurbsCurve.js';
import { constrainedTriangulate } from './Tessellator2/CDT.js';
import { validateIntersections, validateFragments, validateFinalBody } from './IntersectionValidator.js';
import { healFragments } from './Healing.js';
import { ResultGrade, FallbackDiagnostics } from './fallback/FallbackDiagnostics.js';
import { wrapResult } from './fallback/FallbackPolicy.js';
import { validateBooleanResult } from './BooleanInvariantValidator.js';
import { getFlag } from '../featureFlags.js';

/**
 * Perform an exact boolean operation on two TopoBody operands.
 *
 * When CAD_ALLOW_DISCRETE_FALLBACK=1 and the exact path fails invariants,
 * the discrete fallback lane activates automatically.  Fallback results
 * carry resultGrade === 'fallback' and _isFallback === true.
 *
 * The optional `opts.policy` parameter controls fallback routing:
 *   - 'exact-only':      Never fall back; throw on exact failure.
 *   - 'allow-fallback':  Attempt exact first; fall back on failure (default when enabled).
 *   - 'force-fallback':  Skip exact path; always use discrete fallback.
 *
 * @param {import('./BRepTopology.js').TopoBody} bodyA
 * @param {import('./BRepTopology.js').TopoBody} bodyB
 * @param {'union'|'subtract'|'intersect'} operation
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @param {Object} [opts]
 * @param {string} [opts.policy] - One of OperationPolicy values
 * @returns {{
 *   body: import('./BRepTopology.js').TopoBody|null,
 *   mesh: {vertices: Array, faces: Array, edges: Array},
 *   diagnostics: Object,
 *   resultGrade?: string,
 *   _isFallback?: boolean,
 *   fallbackDiagnostics?: Object,
 * }}
 */
export function exactBooleanOp(bodyA, bodyB, operation, tol = DEFAULT_TOLERANCE, opts = {}) {
  // BRep-only pipeline: no fallback to mesh boolean.
  // The exact path must succeed or throw.
  const result = _exactBooleanOpInner(bodyA, bodyB, operation, tol);
  return wrapResult(result, ResultGrade.EXACT, FallbackDiagnostics.exact(result.diagnostics));
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
      // All intersections failed validation.  Rather than discarding the
      // entire boolean result (which produces a union-like merge of all
      // faces), proceed with the original intersections.  The 3D curves
      // are typically still correct even when surface UV parameters are
      // inaccurate, and the downstream face splitter for planar faces
      // only uses the 3D curve geometry, not the UV params.
      diagnostics.allIntersectionsInvalid = true;
    } else {
      // Use only valid intersections
      intersections.length = 0;
      intersections.push(...validIx);
      diagnostics.filteredIntersections = true;
    }
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

  // Step 8b: Merge adjacent coplanar face fragments back together.
  // Boolean face splitting can create many small planar quads from a
  // single original face. This consolidation step reduces face count
  // and downstream triangle output.
  mergeCoplanarFaces(resultBody, tol);
  removeCollinearEdgeVertices(resultBody, tol);

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
    face.outerLoop
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
  mergeCoplanarFaces(resultBody, tol);
  removeCollinearEdgeVertices(resultBody, tol);
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
      // Faces with inner loops must be decomposed into simple (hole-free)
      // sub-faces first, because the planar face splitter only operates
      // on the outer loop.  CDT gives us triangles that respect both the
      // outer boundary and hole boundaries; each triangle is then split
      // individually by the intersection curves.
      if (face.innerLoops && face.innerLoops.length > 0 && face.surfaceType === SurfaceType.PLANE) {
        const subFaces = _decomposeFaceWithHoles(face, tol);
        for (const sub of subFaces) {
          const frags = splitFace(sub, curves, tol);
          fragments.push(...frags);
        }
      } else {
        const frags = splitFace(face, curves, tol);
        fragments.push(...frags);
      }
    } else {
      fragments.push(face);
    }
  }

  return fragments;
}

/**
 * Decompose a planar face with inner loops into simple (hole-free) triangle
 * faces via CDT.  The resulting triangles share the same surface / sameSense
 * and can be split individually by intersection curves.
 */
function _decomposeFaceWithHoles(face, tol) {
  const outerPts = face.outerLoop ? face.outerLoop.points() : [];
  if (outerPts.length < 3) return [face];

  // Project to 2D along the face normal
  const normal = _fragmentFaceNormal(face);
  const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
  let toU, toV;
  if (az >= ax && az >= ay) { toU = p => p.x; toV = p => p.y; }
  else if (ay >= ax) { toU = p => p.x; toV = p => p.z; }
  else { toU = p => p.y; toV = p => p.z; }

  const outer2D = outerPts.map(p => ({ x: toU(p), y: toV(p) }));
  const holes2D = face.innerLoops.map(il => il.points().map(p => ({ x: toU(p), y: toV(p) })));

  // All 3D points in one flat array: outer + holes
  const all3D = [...outerPts];
  for (const il of face.innerLoops) all3D.push(...il.points());

  const triIndices = constrainedTriangulate(outer2D, holes2D);
  if (triIndices.length === 0) return [face];

  const results = [];
  for (const [i0, i1, i2] of triIndices) {
    const p0 = all3D[i0], p1 = all3D[i1], p2 = all3D[i2];
    if (!p0 || !p1 || !p2) continue;

    const triPts = [{ ...p0 }, { ...p1 }, { ...p2 }];
    const sub = new TopoFace(
      face.surface ? face.surface.clone() : null,
      face.surfaceType,
      face.sameSense,
    );
    sub.shared = face.shared ? { ...face.shared } : null;
    sub.tolerance = face.tolerance;

    const vertices = triPts.map(pt => new TopoVertex(pt, tol.pointCoincidence));
    const coedges = [];
    for (let k = 0; k < 3; k++) {
      const v0 = vertices[k], v1 = vertices[(k + 1) % 3];
      const edge = new TopoEdge(v0, v1, NurbsCurve.createLine(v0.point, v1.point), tol.edgeOverlap);
      coedges.push(new TopoCoEdge(edge, true, null));
    }
    sub.setOuterLoop(new TopoLoop(coedges));
    results.push(sub);
  }

  return results.length > 0 ? results : [face];
}

/**
 * Classify fragments and select which to keep based on boolean operation.
 */
function _classifyAndSelect(fragmentsA, fragmentsB, bodyA, bodyB, operation, tol) {
  const kept = [];

  // Classify A fragments against B
  for (const frag of fragmentsA) {
    let cls = classifyFragment(frag, bodyB, tol);
    // Refine coincident classification for coplanar faces
    if (cls === 'coincident') {
      cls = _refineCoincidentClassification(frag, bodyB, tol);
    }
    const keep = _shouldKeep(cls, operation, 'A');
    if (keep) kept.push(frag);
  }

  // Classify B fragments against A
  for (const frag of fragmentsB) {
    let cls = classifyFragment(frag, bodyA, tol);
    // Refine coincident classification for coplanar faces
    if (cls === 'coincident') {
      cls = _refineCoincidentClassification(frag, bodyA, tol);
    }
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
 * Refine a 'coincident' classification by checking whether the fragment
 * truly overlaps a coplanar face of the other body.
 *
 * When a fragment face is coplanar with a face of `body`, the standard
 * point-containment sample lands on the boundary, yielding 'coincident'.
 * This function distinguishes:
 *   - 'coincident'          → fragment centroid projects inside a same-sense coplanar face
 *   - 'coincident-opposite' → fragment centroid projects inside an opposite-sense coplanar face
 *   - 'outside'             → fragment is near the boundary but not truly coplanar-overlapping
 *
 * @param {import('./BRepTopology.js').TopoFace} fragment
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {import('./Tolerance.js').Tolerance} tol
 * @returns {'coincident'|'coincident-opposite'|'outside'}
 */
function _refineCoincidentClassification(fragment, body, tol) {
  if (!fragment.outerLoop) return 'outside';
  const fragPts = fragment.outerLoop.points();
  if (fragPts.length < 3) return 'outside';

  // Fragment centroid (full polygon centroid, not first-3 centroid)
  let cx = 0, cy = 0, cz = 0;
  for (const v of fragPts) { cx += v.x; cy += v.y; cz += v.z; }
  cx /= fragPts.length; cy /= fragPts.length; cz /= fragPts.length;
  const fragCentroid = { x: cx, y: cy, z: cz };

  // Fragment face normal (respecting sameSense)
  const fragN = _fragmentFaceNormal(fragment);

  // Use generous threshold to accommodate subtract-overshoot (see ExtrudeFeature)
  const coplanarThreshold = Math.max(tol.sewing * 10, 1e-3);

  for (const face of body.faces()) {
    if (!face.outerLoop) continue;
    const facePts = face.outerLoop.points();
    if (facePts.length < 3) continue;

    // Face normal (respecting sameSense)
    const faceN = _fragmentFaceNormal(face);

    // Normals must be parallel (same or opposite direction)
    const dotN = _dot(fragN, faceN);
    if (Math.abs(Math.abs(dotN) - 1) > 0.01) continue;

    // Centroid must lie on the face's plane (within overshoot tolerance)
    const faceW = _dot(faceN, facePts[0]);
    const dist = Math.abs(_dot(faceN, fragCentroid) - faceW);
    if (dist > coplanarThreshold) continue;

    // Centroid must project inside the face polygon
    if (!_pointInPolygon3D(fragCentroid, facePts, faceN)) continue;

    // Coplanar overlap detected.  Probe the interior side.
    const probeOffset = 0.01;
    const probePt = {
      x: fragCentroid.x - fragN.x * probeOffset,
      y: fragCentroid.y - fragN.y * probeOffset,
      z: fragCentroid.z - fragN.z * probeOffset,
    };
    const probeResult = containmentClassifyPoint(body, probePt, { tolerance: tol });
    if (probeResult.state === 'inside') return 'coincident';

    // Interior side is outside: for opposite-sense normals, probe the
    // exterior side to detect touching solids (see _classifyPlanarPolygon).
    if (dotN < 0) {
      const extProbePt = {
        x: fragCentroid.x + fragN.x * probeOffset,
        y: fragCentroid.y + fragN.y * probeOffset,
        z: fragCentroid.z + fragN.z * probeOffset,
      };
      const extResult = containmentClassifyPoint(body, extProbePt, { tolerance: tol });
      if (extResult.state === 'inside') return 'coincident-opposite';
    }

    return 'outside';
  }

  // No coplanar overlap found — the fragment was near the boundary but
  // not actually on a coplanar face of body.  Re-classify with a larger
  // offset to get a definitive inside/outside answer.
  const nx2 = fragN.x, ny2 = fragN.y, nz2 = fragN.z;
  const offsetMag = Math.max(tol.classification * 10, 1e-4);
  const testPt = {
    x: fragCentroid.x + nx2 * offsetMag,
    y: fragCentroid.y + ny2 * offsetMag,
    z: fragCentroid.z + nz2 * offsetMag,
  };
  const result = containmentClassifyPoint(body, testPt, { tolerance: tol });
  if (result.state === 'inside') return 'inside';
  return 'outside';
}

/**
 * Compute the outward face normal for a topo face, respecting sameSense.
 */
function _fragmentFaceNormal(face) {
  const pts = face.outerLoop.points();
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const curr = pts[i];
    const next = pts[(i + 1) % pts.length];
    nx += (curr.y - next.y) * (curr.z + next.z);
    ny += (curr.z - next.z) * (curr.x + next.x);
    nz += (curr.x - next.x) * (curr.y + next.y);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-10) { nx /= len; ny /= len; nz /= len; }
  if (face.sameSense === false) { nx = -nx; ny = -ny; nz = -nz; }
  return { x: nx, y: ny, z: nz };
}

/**
 * Determine whether to keep a fragment based on classification and operation.
 *
 * @param {'inside'|'outside'|'coincident'|'coincident-opposite'} classification
 * @param {'union'|'subtract'|'intersect'} operation
 * @param {'A'|'B'} operand
 * @returns {boolean}
 */
function _shouldKeep(classification, operation, operand) {
  // Coincident-opposite faces are always internal boundaries where two
  // solids touch at a shared face with opposite normals.  They must be
  // discarded in every boolean operation to avoid leaving double-faced
  // internal surfaces in the result.
  if (classification === 'coincident-opposite') return false;

  switch (operation) {
    case 'union':
      // Keep outside fragments from both operands
      // coincident: keep from A only (B copy is a duplicate)
      if (operand === 'A') {
        return classification === 'outside' || classification === 'coincident';
      }
      return classification === 'outside';

    case 'subtract':
      if (operand === 'A') {
        // Keep A outside B; discard A coincident (shared boundary being cut)
        return classification === 'outside';
      } else {
        // Keep B inside A (reversed); discard B coincident (shared boundary = opening)
        return classification === 'inside';
      }

    case 'intersect':
      // Keep inside fragments from both operands
      // coincident: keep (shared boundary of intersection)
      return classification === 'inside' || classification === 'coincident';

    default:
      return false;
  }
}

function _bodyToPolygons(body) {
  const result = [];
  for (const face of body.faces()) {
    // Faces with inner loops must be decomposed into simple polygons via CDT
    if (face.innerLoops && face.innerLoops.length > 0) {
      const outerPts = face.outerLoop.points();
      if (outerPts.length < 3) continue;
      const oriented = face.sameSense === false ? [...outerPts].reverse() : outerPts;
      const normal = _polygonNormal(oriented);
      if (_vecLen(normal) < 1e-10) continue;

      // Project to 2D for CDT
      const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
      let toU, toV;
      if (az >= ax && az >= ay) { toU = p => p.x; toV = p => p.y; }
      else if (ay >= ax) { toU = p => p.x; toV = p => p.z; }
      else { toU = p => p.y; toV = p => p.z; }

      const outer2D = oriented.map(p => ({ x: toU(p), y: toV(p) }));
      const holePts = face.innerLoops.map(il => {
        const pts = il.points();
        return face.sameSense === false ? [...pts].reverse() : pts;
      });
      const holes2D = holePts.map(hpts => hpts.map(p => ({ x: toU(p), y: toV(p) })));

      // All 3D points in one flat array: outer + holes
      const all3D = [...oriented];
      for (const hpts of holePts) all3D.push(...hpts);

      const triIndices = constrainedTriangulate(outer2D, holes2D);
      for (const [i0, i1, i2] of triIndices) {
        const p0 = all3D[i0], p1 = all3D[i1], p2 = all3D[i2];
        if (!p0 || !p1 || !p2) continue;
        const triVerts = [{ ...p0 }, { ...p1 }, { ...p2 }];
        const triNormal = _polygonNormal(triVerts);
        if (_vecLen(triNormal) < 1e-10) continue;
        result.push({
          vertices: triVerts,
          normal: triNormal,
          shared: face.shared ? { ...face.shared } : null,
          surfaceType: face.surfaceType,
        });
      }
    } else {
      const verts = face.outerLoop.points();
      const oriented = face.sameSense === false ? [...verts].reverse() : verts;
      const normal = _polygonNormal(oriented);
      if (oriented.length >= 3 && _vecLen(normal) > 1e-10) {
        result.push({
          vertices: oriented.map(v => ({ ...v })),
          normal,
          shared: face.shared ? { ...face.shared } : null,
          surfaceType: face.surfaceType,
        });
      }
    }
  }
  return result;
}

function _splitPolygonsByBody(polygons, body, tol) {
  let fragments = polygons;
  for (const splitter of _bodyToPolygons(body)) {
    const plane = {
      normal: splitter.normal,
      w: _dot(splitter.normal, splitter.vertices[0]),
    };
    // Only split fragments whose bounding box overlaps the splitter face's
    // bounding box.  Planes of distant faces cannot represent actual body
    // boundaries in the region of the fragment, so splitting by them is
    // unnecessary and produces excess fragments / triangles.
    const sBounds = _polygonBounds(splitter.vertices);
    const next = [];
    for (const poly of fragments) {
      const pBounds = _polygonBounds(poly.vertices);
      if (_boundsOverlap(pBounds, sBounds, tol)) {
        next.push(..._splitPolygonByPlane(poly, plane, tol));
      } else {
        next.push(poly);
      }
    }
    fragments = next;
  }
  return fragments;
}

/**
 * Compute axis-aligned bounding box for a set of vertices.
 * @param {Array<{x:number,y:number,z:number}>} verts
 * @returns {{minX:number,maxX:number,minY:number,maxY:number,minZ:number,maxZ:number}}
 */
function _polygonBounds(verts) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const v of verts) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
    if (v.z < minZ) minZ = v.z;
    if (v.z > maxZ) maxZ = v.z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * Check if two 3D bounding boxes overlap (within tolerance).
 * @param {{minX:number,maxX:number,minY:number,maxY:number,minZ:number,maxZ:number}} a
 * @param {{minX:number,maxX:number,minY:number,maxY:number,minZ:number,maxZ:number}} b
 * @param {Object} tol
 * @returns {boolean}
 */
function _boundsOverlap(a, b, tol) {
  const eps = tol.intersection ?? 1e-6;
  if (a.maxX < b.minX - eps || a.minX > b.maxX + eps) return false;
  if (a.maxY < b.minY - eps || a.minY > b.maxY + eps) return false;
  if (a.maxZ < b.minZ - eps || a.minZ > b.maxZ + eps) return false;
  return true;
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

  // Detect coplanar coincidence: if this polygon lies on (or very near)
  // a face of `body` and the centroid projects inside that face, the polygon
  // shares a boundary plane with the body.  Standard offset-based
  // classification fails here because the test point lands within the
  // classification tolerance of the body surface, yielding an ambiguous
  // 'on-boundary' result.
  //
  // The distance threshold must be generous enough to accommodate the
  // subtract-overshoot applied by ExtrudeFeature (max(1e-4, dist*1e-5))
  // which shifts cut-body faces slightly past the target body's boundary.
  const coplanarThreshold = Math.max(tol.sewing * 10, 1e-3);

  for (const face of body.faces()) {
    if (!face.outerLoop) continue;
    const faceVerts = face.outerLoop.points();
    if (faceVerts.length < 3) continue;
    const oriented = face.sameSense === false ? [...faceVerts].reverse() : faceVerts;
    const faceN = _normalize(_polygonNormal(oriented));

    // Normals must be parallel (same or opposite direction)
    const dotN = _dot(n, faceN);
    if (Math.abs(Math.abs(dotN) - 1) > 0.01) continue;

    // Centroid must lie on the face's plane (within overshoot tolerance)
    const faceW = _dot(faceN, oriented[0]);
    const dist = Math.abs(_dot(faceN, c) - faceW);
    if (dist > coplanarThreshold) continue;

    // Centroid must project inside the face polygon
    if (!_pointInPolygon3D(c, oriented, faceN)) continue;

    // Coplanar overlap detected.  Probe the interior side of the polygon
    // (opposite to the outward normal) to determine whether the other body
    // actually overlaps here or merely touches.
    // The offset must be large enough (≥0.01) for the containment engine's
    // ray-cast to give confident results even when the body has faces with
    // imperfect winding (e.g. extrude-cut overshoot caps).
    const probeOffset = 0.01;
    const probePt = {
      x: c.x - n.x * probeOffset,
      y: c.y - n.y * probeOffset,
      z: c.z - n.z * probeOffset,
    };
    const probeResult = containmentClassifyPoint(body, probePt, { tolerance: tol });
    if (probeResult.state === 'inside') {
      // The polygon's interior side is inside the other body → bodies overlap
      // at this face.  The face is an internal boundary → 'coincident'.
      return 'coincident';
    }

    // Interior side is outside the other body.  For opposite-sense coplanar
    // faces (dotN < 0) this may indicate two solids touching at a shared
    // boundary.  Probe the exterior side: if the exterior is inside the
    // other body, this face is an internal interface between touching solids
    // and must be classified as 'coincident-opposite' so it gets discarded.
    if (dotN < 0) {
      const extProbePt = {
        x: c.x + n.x * probeOffset,
        y: c.y + n.y * probeOffset,
        z: c.z + n.z * probeOffset,
      };
      const extResult = containmentClassifyPoint(body, extProbePt, { tolerance: tol });
      if (extResult.state === 'inside') {
        return 'coincident-opposite';
      }
    }

    // The interior side is outside the other body → bodies merely touch.
    // The face sits on the exterior of the other body → 'outside'.
    return 'outside';
  }

  // Non-coplanar: offset along normal to sample containment.
  // Use an offset well above tol.classification to avoid ambiguous
  // 'on-boundary' results from the containment engine.
  const offsetMag = Math.max(tol.classification * 10, 1e-4);
  const p = {
    x: c.x + n.x * offsetMag,
    y: c.y + n.y * offsetMag,
    z: c.z + n.z * offsetMag,
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

/**
 * Test whether a 3D point projects inside a planar polygon using
 * a 2D ray-casting (even-odd) test on the dominant-axis projection.
 *
 * @param {{x:number,y:number,z:number}} p - Point to test (must be coplanar)
 * @param {Array<{x:number,y:number,z:number}>} verts - Polygon vertices
 * @param {{x:number,y:number,z:number}} normal - Polygon face normal (unit)
 * @returns {boolean}
 */
function _pointInPolygon3D(p, verts, normal) {
  // Choose the dominant axis to drop for 2D projection
  const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
  let u, v; // property names for the 2D axes
  if (ax >= ay && ax >= az) { u = 'y'; v = 'z'; }
  else if (ay >= ax && ay >= az) { u = 'x'; v = 'z'; }
  else { u = 'x'; v = 'y'; }

  const pu = p[u], pv = p[v];
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const iu = verts[i][u], iv = verts[i][v];
    const ju = verts[j][u], jv = verts[j][v];
    if (((iv > pv) !== (jv > pv)) &&
        (pu < (ju - iu) * (pv - iv) / (jv - iv) + iu)) {
      inside = !inside;
    }
  }
  return inside;
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
 * Fire-and-forget — never throws. Uses async dynamic import for browser safety.
 *
 * @param {string} operation
 * @param {Object} diagnostics
 */
function _writeDiagnosticArtifact(operation, diagnostics) {
  const dir = getFlag('CAD_DIAGNOSTICS_DIR');
  if (!dir) return;
  // Fire-and-forget async write — must never break the boolean path
  (async () => {
    const fs = await import('fs');
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const filename = `boolean-${operation}-${timestamp}.json`;
    const filepath = dir.endsWith('/') ? dir + filename : dir + '/' + filename;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filepath, JSON.stringify(diagnostics, null, 2));
  })().catch(() => {
    // Silently ignored: browser or restricted environment
  });
}

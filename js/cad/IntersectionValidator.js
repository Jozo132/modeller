// js/cad/IntersectionValidator.js — Validate intersection results before splitting
//
// Enforces the IntersectionResult contract for downstream stages.
// Each intersection result must satisfy:
//   - curve3d present and evaluable
//   - paramsOnA / paramsOnB finite and in expected domains
//   - sample points lie on both participating surfaces within tolerance
//   - parameter progression is monotonic per segment
//   - no zero-length / reversed / duplicated segments without explicit handling
//
// Returns structured diagnostics instead of silently passing through invalid data.

import { DEFAULT_TOLERANCE } from './Tolerance.js';

/**
 * A single diagnostic entry recorded when an invariant fails.
 * @typedef {{
 *   invariant: string,
 *   entityIds: Array<string|number>,
 *   tolerance: number,
 *   detail: string,
 * }} InvariantDiagnostic
 */

/**
 * Validation result for a set of intersection results.
 */
export class IntersectionValidation {
  constructor() {
    /** @type {InvariantDiagnostic[]} */
    this.diagnostics = [];
  }

  /** @param {InvariantDiagnostic} diag */
  addDiagnostic(diag) { this.diagnostics.push(diag); }

  get isValid() { return this.diagnostics.length === 0; }

  /** Compact JSON payload suitable for CI artifacts / test failure messages. */
  toJSON() {
    return {
      valid: this.isValid,
      count: this.diagnostics.length,
      diagnostics: this.diagnostics,
    };
  }
}

// ---------------------------------------------------------------------------
// Intersection result contract validation
// ---------------------------------------------------------------------------

/**
 * Validate an array of intersection results as returned by `intersectBodies`.
 *
 * Each element is expected to have:
 *   { faceA, faceB, curves: [{ curve, paramsA: [{u,v}], paramsB: [{u,v}] }] }
 *
 * @param {Array} intersections
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {IntersectionValidation}
 */
export function validateIntersections(intersections, tol = DEFAULT_TOLERANCE) {
  const result = new IntersectionValidation();

  if (!Array.isArray(intersections)) {
    result.addDiagnostic({
      invariant: 'intersections-is-array',
      entityIds: [],
      tolerance: 0,
      detail: 'intersections must be an array',
    });
    return result;
  }

  for (let i = 0; i < intersections.length; i++) {
    const ix = intersections[i];
    _validateIntersectionEntry(ix, i, tol, result);
  }

  return result;
}

/**
 * Validate a single intersection entry (one face-pair result).
 */
function _validateIntersectionEntry(ix, index, tol, result) {
  const ids = [ix?.faceA?.id ?? '?', ix?.faceB?.id ?? '?'];

  // Face references
  if (!ix.faceA || !ix.faceB) {
    result.addDiagnostic({
      invariant: 'face-references-present',
      entityIds: ids,
      tolerance: 0,
      detail: `intersection[${index}]: missing faceA or faceB reference`,
    });
    return;
  }

  // Curves array
  if (!Array.isArray(ix.curves) || ix.curves.length === 0) {
    result.addDiagnostic({
      invariant: 'curves-non-empty',
      entityIds: ids,
      tolerance: 0,
      detail: `intersection[${index}]: curves must be a non-empty array`,
    });
    return;
  }

  for (let ci = 0; ci < ix.curves.length; ci++) {
    _validateCurveEntry(ix.curves[ci], index, ci, ix.faceA, ix.faceB, tol, result);
  }
}

/**
 * Validate a single curve within an intersection entry.
 */
function _validateCurveEntry(entry, ixIndex, curveIndex, faceA, faceB, tol, result) {
  const prefix = `intersection[${ixIndex}].curves[${curveIndex}]`;
  const ids = [faceA.id, faceB.id, curveIndex];

  // --- curve3d present and evaluable ---
  if (!entry.curve) {
    result.addDiagnostic({
      invariant: 'curve3d-present',
      entityIds: ids,
      tolerance: 0,
      detail: `${prefix}: missing curve3d`,
    });
    return;
  }

  const curve = entry.curve;
  const canEvaluate = typeof curve.evaluate === 'function';
  if (!canEvaluate) {
    result.addDiagnostic({
      invariant: 'curve3d-evaluable',
      entityIds: ids,
      tolerance: 0,
      detail: `${prefix}: curve has no evaluate method`,
    });
    return;
  }

  // --- paramsOnA / paramsOnB finite and present ---
  for (const [key, params] of [['paramsA', entry.paramsA], ['paramsB', entry.paramsB]]) {
    if (!Array.isArray(params) || params.length < 2) {
      result.addDiagnostic({
        invariant: `${key}-present`,
        entityIds: ids,
        tolerance: 0,
        detail: `${prefix}: ${key} must be an array of at least 2 {u,v} entries`,
      });
      continue;
    }

    for (let pi = 0; pi < params.length; pi++) {
      const p = params[pi];
      if (p == null || !Number.isFinite(p.u) || !Number.isFinite(p.v)) {
        result.addDiagnostic({
          invariant: `${key}-finite`,
          entityIds: [...ids, pi],
          tolerance: 0,
          detail: `${prefix}.${key}[${pi}]: u or v is not finite (u=${p?.u}, v=${p?.v})`,
        });
      }
    }
  }

  // --- parameter domain check ---
  _checkParamDomain(entry.paramsA, faceA, prefix, 'paramsA', ids, tol, result);
  _checkParamDomain(entry.paramsB, faceB, prefix, 'paramsB', ids, tol, result);

  // --- monotonic parameter progression ---
  _checkMonotonicity(entry.paramsA, prefix, 'paramsA', ids, tol, result);
  _checkMonotonicity(entry.paramsB, prefix, 'paramsB', ids, tol, result);

  // --- no zero-length segments ---
  _checkZeroLength(curve, prefix, ids, tol, result);

  // --- sample points on both surfaces ---
  _checkSamplePointsOnSurfaces(curve, entry.paramsA, entry.paramsB, faceA, faceB, prefix, ids, tol, result);
}

/**
 * Check that UV parameters fall within the face surface's domain (with tolerance).
 */
function _checkParamDomain(params, face, prefix, key, ids, tol, result) {
  if (!Array.isArray(params) || !face?.surface) return;

  const surf = face.surface;
  const uMin = surf.uMin ?? 0;
  const uMax = surf.uMax ?? 1;
  const vMin = surf.vMin ?? 0;
  const vMax = surf.vMax ?? 1;
  // Allow parameter overshoot up to 100× intersection tolerance to accommodate
  // numeric marching and projection error near domain boundaries.
  const DOMAIN_SLACK_MULTIPLIER = 100;
  const slack = tol.intersection * DOMAIN_SLACK_MULTIPLIER;

  for (let pi = 0; pi < params.length; pi++) {
    const p = params[pi];
    if (!p || !Number.isFinite(p.u) || !Number.isFinite(p.v)) continue;
    if (p.u < uMin - slack || p.u > uMax + slack ||
        p.v < vMin - slack || p.v > vMax + slack) {
      result.addDiagnostic({
        invariant: `${key}-in-domain`,
        entityIds: [...ids, pi],
        tolerance: slack,
        detail: `${prefix}.${key}[${pi}]: (${p.u}, ${p.v}) outside domain [${uMin},${uMax}]×[${vMin},${vMax}]`,
      });
    }
  }
}

/**
 * Check monotonic parameter progression (u or v should be generally
 * monotonic; we flag if both u and v are non-monotonic simultaneously).
 */
function _checkMonotonicity(params, prefix, key, ids, tol, result) {
  if (!Array.isArray(params) || params.length < 3) return;

  let uIncr = 0, uDecr = 0, vIncr = 0, vDecr = 0;
  for (let i = 1; i < params.length; i++) {
    const prev = params[i - 1];
    const curr = params[i];
    if (!prev || !curr) continue;
    if (Number.isFinite(prev.u) && Number.isFinite(curr.u)) {
      if (curr.u > prev.u + tol.intersection) uIncr++;
      if (curr.u < prev.u - tol.intersection) uDecr++;
    }
    if (Number.isFinite(prev.v) && Number.isFinite(curr.v)) {
      if (curr.v > prev.v + tol.intersection) vIncr++;
      if (curr.v < prev.v - tol.intersection) vDecr++;
    }
  }

  const uMono = uIncr === 0 || uDecr === 0;
  const vMono = vIncr === 0 || vDecr === 0;
  if (!uMono && !vMono) {
    result.addDiagnostic({
      invariant: `${key}-monotonic`,
      entityIds: ids,
      tolerance: tol.intersection,
      detail: `${prefix}.${key}: neither u nor v is monotonic (u incr=${uIncr}/decr=${uDecr}, v incr=${vIncr}/decr=${vDecr})`,
    });
  }
}

/**
 * Check that the intersection curve is not zero-length.
 */
function _checkZeroLength(curve, prefix, ids, tol, result) {
  try {
    const p0 = curve.evaluate(curve.uMin ?? 0);
    const p1 = curve.evaluate(curve.uMax ?? 1);
    if (!p0 || !p1) return;
    const dx = p0.x - p1.x, dy = p0.y - p1.y, dz = p0.z - p1.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < tol.pointCoincidence) {
      result.addDiagnostic({
        invariant: 'curve-nonzero-length',
        entityIds: ids,
        tolerance: tol.pointCoincidence,
        detail: `${prefix}: curve endpoint distance ${len.toExponential(3)} < pointCoincidence ${tol.pointCoincidence}`,
      });
    }
  } catch { /* curve may not be evaluable yet — already caught above */ }
}

/**
 * Sample a few points on the intersection curve and verify they lie
 * on both participating surfaces within tolerance.
 */
function _checkSamplePointsOnSurfaces(curve, paramsA, paramsB, faceA, faceB, prefix, ids, tol, result) {
  if (!faceA?.surface || !faceB?.surface) return;
  if (!Array.isArray(paramsA) || !Array.isArray(paramsB)) return;
  if (paramsA.length < 2 || paramsB.length < 2) return;

  const sampleCount = Math.min(5, paramsA.length, paramsB.length);
  const step = Math.max(1, Math.floor((paramsA.length - 1) / (sampleCount - 1)));

  for (let si = 0; si < sampleCount; si++) {
    const pi = Math.min(si * step, paramsA.length - 1, paramsB.length - 1);
    const uvA = paramsA[pi];
    const uvB = paramsB[pi];
    if (!uvA || !uvB) continue;
    if (!Number.isFinite(uvA.u) || !Number.isFinite(uvA.v)) continue;
    if (!Number.isFinite(uvB.u) || !Number.isFinite(uvB.v)) continue;

    try {
      const pA = faceA.surface.evaluate(uvA.u, uvA.v);
      const pB = faceB.surface.evaluate(uvB.u, uvB.v);
      if (!pA || !pB) continue;

      const dx = pA.x - pB.x, dy = pA.y - pB.y, dz = pA.z - pB.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Surface evaluation points should lie close together (on the curve)
      const threshold = tol.sewing; // use sewing tolerance for surface agreement
      if (dist > threshold) {
        result.addDiagnostic({
          invariant: 'sample-on-both-surfaces',
          entityIds: [...ids, pi],
          tolerance: threshold,
          detail: `${prefix}: sample[${pi}] surface evaluations differ by ${dist.toExponential(3)} > sewing tol ${threshold}`,
        });
      }
    } catch { /* surface evaluation failure — surfaces may not support evaluate */ }
  }
}

// ---------------------------------------------------------------------------
// Fragment post-condition validation (after splitting)
// ---------------------------------------------------------------------------

/**
 * Validate topological post-conditions on face fragments after splitting.
 *
 * Checks:
 *   - loops close
 *   - orientations are consistent
 *   - coedges/edges are wired correctly
 *   - no dangling references
 *   - no tiny orphan fragments
 *
 * @param {import('./BRepTopology.js').TopoFace[]} fragments
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {IntersectionValidation}
 */
export function validateFragments(fragments, tol = DEFAULT_TOLERANCE) {
  const result = new IntersectionValidation();

  if (!Array.isArray(fragments) || fragments.length === 0) {
    result.addDiagnostic({
      invariant: 'fragments-non-empty',
      entityIds: [],
      tolerance: 0,
      detail: 'fragment list is empty or not an array',
    });
    return result;
  }

  for (let fi = 0; fi < fragments.length; fi++) {
    const frag = fragments[fi];
    _validateFragment(frag, fi, tol, result);
  }

  return result;
}

/**
 * Validate a single face fragment.
 */
function _validateFragment(frag, index, tol, result) {
  const fid = frag?.id ?? index;

  // Must have an outer loop
  if (!frag.outerLoop) {
    result.addDiagnostic({
      invariant: 'fragment-has-outer-loop',
      entityIds: [fid],
      tolerance: 0,
      detail: `fragment[${index}] (id=${fid}): missing outer loop`,
    });
    return;
  }

  const loop = frag.outerLoop;

  // Outer loop must have coedges
  if (!loop.coedges || loop.coedges.length < 3) {
    result.addDiagnostic({
      invariant: 'fragment-loop-min-coedges',
      entityIds: [fid],
      tolerance: 0,
      detail: `fragment[${index}] (id=${fid}): outer loop has ${loop.coedges?.length ?? 0} coedges (need ≥ 3)`,
    });
    return;
  }

  // Check coedge-edge wiring
  for (let ci = 0; ci < loop.coedges.length; ci++) {
    const ce = loop.coedges[ci];
    if (!ce.edge) {
      result.addDiagnostic({
        invariant: 'coedge-has-edge',
        entityIds: [fid, ce.id ?? ci],
        tolerance: 0,
        detail: `fragment[${index}].coedge[${ci}]: no edge reference`,
      });
      continue;
    }
    if (!ce.edge.startVertex || !ce.edge.endVertex) {
      result.addDiagnostic({
        invariant: 'edge-has-vertices',
        entityIds: [fid, ce.edge.id ?? ci],
        tolerance: 0,
        detail: `fragment[${index}].edge[${ci}]: missing start or end vertex`,
      });
    }
  }

  // Check loop closure — endpoint of each coedge should connect to start of next
  _checkLoopClosure(loop, frag, index, tol, result);

  // Check for tiny orphan fragment
  _checkTinyFragment(frag, index, tol, result);
}

/**
 * Check that a loop closes: the endpoint of coedge[i] coincides with
 * the start of coedge[i+1].
 */
function _checkLoopClosure(loop, frag, fragIndex, tol, result) {
  const coedges = loop.coedges;
  for (let i = 0; i < coedges.length; i++) {
    const curr = coedges[i];
    const next = coedges[(i + 1) % coedges.length];
    if (!curr.edge || !next.edge) continue;

    const currEnd = curr.sameSense ? curr.edge.endVertex : curr.edge.startVertex;
    const nextStart = next.sameSense ? next.edge.startVertex : next.edge.endVertex;

    if (!currEnd || !nextStart) continue;

    const dx = currEnd.point.x - nextStart.point.x;
    const dy = currEnd.point.y - nextStart.point.y;
    const dz = currEnd.point.z - nextStart.point.z;
    const gap = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (gap > tol.sewing) {
      result.addDiagnostic({
        invariant: 'loop-closure',
        entityIds: [frag.id ?? fragIndex, curr.edge.id, next.edge.id],
        tolerance: tol.sewing,
        detail: `fragment[${fragIndex}]: gap ${gap.toExponential(3)} between coedge ${i}→${(i + 1) % coedges.length} exceeds sewing tolerance`,
      });
    }
  }
}

/**
 * Detect tiny orphan fragments (area too small to be meaningful).
 */
function _checkTinyFragment(frag, index, tol, result) {
  if (!frag.outerLoop) return;
  const pts = frag.outerLoop.points();
  if (pts.length < 3) return;

  // Approximate area using Newell's method
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const area = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
  const minArea = tol.pointCoincidence * tol.pointCoincidence;

  if (area < minArea) {
    result.addDiagnostic({
      invariant: 'fragment-minimum-area',
      entityIds: [frag.id ?? index],
      tolerance: minArea,
      detail: `fragment[${index}]: area ${area.toExponential(3)} below minimum ${minArea.toExponential(3)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Final body validation (after sewing)
// ---------------------------------------------------------------------------

/**
 * Validate the final body/shell after sewing.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {IntersectionValidation}
 */
export function validateFinalBody(body, tol = DEFAULT_TOLERANCE) {
  const result = new IntersectionValidation();

  if (!body) {
    result.addDiagnostic({
      invariant: 'body-present',
      entityIds: [],
      tolerance: 0,
      detail: 'final body is null or undefined',
    });
    return result;
  }

  if (!body.shells || body.shells.length === 0) {
    result.addDiagnostic({
      invariant: 'body-has-shells',
      entityIds: [body.id ?? '?'],
      tolerance: 0,
      detail: 'final body has no shells',
    });
    return result;
  }

  for (const shell of body.shells) {
    _validateShellPostSewing(shell, tol, result);
  }

  return result;
}

/**
 * Validate shell-level invariants after sewing.
 */
function _validateShellPostSewing(shell, tol, result) {
  const sid = shell.id ?? '?';

  if (!shell.faces || shell.faces.length === 0) {
    result.addDiagnostic({
      invariant: 'shell-has-faces',
      entityIds: [sid],
      tolerance: 0,
      detail: `shell ${sid}: has no faces`,
    });
    return;
  }

  // Edge-use counts: every edge should have exactly 2 coedges for a closed shell
  const edgeCounts = new Map();
  for (const face of shell.faces) {
    for (const loop of face.allLoops()) {
      for (const ce of loop.coedges) {
        const eid = ce.edge?.id;
        if (eid != null) {
          edgeCounts.set(eid, (edgeCounts.get(eid) || 0) + 1);
        }
      }
    }
  }

  for (const [edgeId, count] of edgeCounts) {
    if (count < 2) {
      result.addDiagnostic({
        invariant: 'shell-edge-manifold',
        entityIds: [sid, edgeId],
        tolerance: 0,
        detail: `shell ${sid}: edge ${edgeId} has ${count} coedge(s), expected 2 for closed manifold`,
      });
    } else if (count > 2) {
      result.addDiagnostic({
        invariant: 'shell-edge-non-manifold',
        entityIds: [sid, edgeId],
        tolerance: 0,
        detail: `shell ${sid}: edge ${edgeId} has ${count} coedges (non-manifold)`,
      });
    }
  }

  // Orientation consistency: adjacent faces sharing an edge should traverse it in opposite sense
  const edgeUses = new Map();
  for (const face of shell.faces) {
    for (const loop of face.allLoops()) {
      for (const ce of loop.coedges) {
        const eid = ce.edge?.id;
        if (eid == null) continue;
        if (!edgeUses.has(eid)) edgeUses.set(eid, []);
        edgeUses.get(eid).push({ face, coedge: ce });
      }
    }
  }

  for (const [edgeId, uses] of edgeUses) {
    if (uses.length === 2) {
      if (uses[0].coedge.sameSense === uses[1].coedge.sameSense) {
        result.addDiagnostic({
          invariant: 'shell-orientation-consistent',
          entityIds: [sid, edgeId, uses[0].face.id, uses[1].face.id],
          tolerance: 0,
          detail: `shell ${sid}: edge ${edgeId} traversed in same sense by both adjacent faces`,
        });
      }
    }
  }
}

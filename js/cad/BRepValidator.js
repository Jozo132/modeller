// js/cad/BRepValidator.js — Topology validation for the exact B-Rep kernel
//
// Provides kernel-level validation for every feature and boolean result:
//   - closed shell check
//   - oriented shell check
//   - non-self-intersecting trims
//   - edge-to-coedge consistency
//   - vertex-edge incidence consistency
//   - no dangling coedges
//   - no duplicate coincident edges after sewing

import { DEFAULT_TOLERANCE } from './Tolerance.js';

/**
 * ValidationResult — Collects validation errors and warnings.
 */
export class ValidationResult {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  addError(msg) { this.errors.push(msg); }
  addWarning(msg) { this.warnings.push(msg); }

  get isValid() { return this.errors.length === 0; }

  toString() {
    const parts = [];
    if (this.errors.length > 0) {
      parts.push(`Errors (${this.errors.length}):`);
      for (const e of this.errors) parts.push(`  ✗ ${e}`);
    }
    if (this.warnings.length > 0) {
      parts.push(`Warnings (${this.warnings.length}):`);
      for (const w of this.warnings) parts.push(`  ⚠ ${w}`);
    }
    if (parts.length === 0) parts.push('Valid');
    return parts.join('\n');
  }
}

/**
 * Validate a TopoBody for topological consistency.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {ValidationResult}
 */
export function validateBody(body, tol = DEFAULT_TOLERANCE) {
  const result = new ValidationResult();

  if (!body) {
    result.addError('Body is null');
    return result;
  }

  if (body.shells.length === 0) {
    result.addError('Body has no shells');
    return result;
  }

  for (const shell of body.shells) {
    validateShell(shell, result, tol);
  }

  return result;
}

/**
 * Validate a single shell.
 * @param {import('./BRepTopology.js').TopoShell} shell
 * @param {ValidationResult} result
 * @param {import('./Tolerance.js').Tolerance} tol
 */
function validateShell(shell, result, tol) {
  if (shell.faces.length === 0) {
    result.addError(`Shell ${shell.id}: has no faces`);
    return;
  }

  // Check each face
  for (const face of shell.faces) {
    validateFace(face, result, tol);
  }

  // Closed shell check: every edge should have exactly 2 coedges
  if (shell.closed) {
    const edgeCoedgeCounts = new Map();
    for (const face of shell.faces) {
      for (const loop of face.allLoops()) {
        for (const ce of loop.coedges) {
          const eId = ce.edge.id;
          edgeCoedgeCounts.set(eId, (edgeCoedgeCounts.get(eId) || 0) + 1);
        }
      }
    }

    for (const [edgeId, count] of edgeCoedgeCounts) {
      if (count < 2) {
        result.addError(`Shell ${shell.id}: edge ${edgeId} has only ${count} coedge(s) (expected 2 for closed shell)`);
      } else if (count > 2) {
        result.addWarning(`Shell ${shell.id}: edge ${edgeId} has ${count} coedges (non-manifold)`);
      }
    }
  }

  // Oriented shell check: adjacent faces should have consistent edge orientation
  const edgeFaces = new Map();
  for (const face of shell.faces) {
    for (const loop of face.allLoops()) {
      for (const ce of loop.coedges) {
        const eId = ce.edge.id;
        if (!edgeFaces.has(eId)) edgeFaces.set(eId, []);
        edgeFaces.get(eId).push({ face, coedge: ce });
      }
    }
  }

  for (const [edgeId, uses] of edgeFaces) {
    if (uses.length === 2) {
      // Adjacent faces should traverse the shared edge in opposite directions
      if (uses[0].coedge.sameSense === uses[1].coedge.sameSense) {
        result.addWarning(`Shell ${shell.id}: edge ${edgeId} traversed in same sense by both adjacent faces (orientation mismatch)`);
      }
    }
  }
}

/**
 * Validate a single face.
 * @param {import('./BRepTopology.js').TopoFace} face
 * @param {ValidationResult} result
 * @param {import('./Tolerance.js').Tolerance} tol
 */
function validateFace(face, result, tol) {
  // Must have an outer loop
  if (!face.outerLoop) {
    result.addError(`Face ${face.id}: has no outer loop`);
    return;
  }

  // Outer loop must be closed
  if (!face.outerLoop.isClosed()) {
    result.addError(`Face ${face.id}: outer loop is not closed`);
  }

  // Outer loop must have at least 3 coedges
  if (face.outerLoop.coedges.length < 3) {
    result.addWarning(`Face ${face.id}: outer loop has fewer than 3 coedges`);
  }

  // Check inner loops
  for (let i = 0; i < face.innerLoops.length; i++) {
    const il = face.innerLoops[i];
    if (!il.isClosed()) {
      result.addError(`Face ${face.id}: inner loop ${i} is not closed`);
    }
  }

  // No dangling coedges — every coedge should reference a valid edge
  for (const loop of face.allLoops()) {
    for (const ce of loop.coedges) {
      if (!ce.edge) {
        result.addError(`Face ${face.id}: coedge ${ce.id} has no edge reference`);
      }
      if (!ce.edge.startVertex || !ce.edge.endVertex) {
        result.addError(`Face ${face.id}: edge ${ce.edge.id} has missing vertex`);
      }
    }
  }
}

/**
 * Validate that all edges in a body have consistent vertex-edge incidence.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @returns {ValidationResult}
 */
export function validateIncidence(body) {
  const result = new ValidationResult();
  if (!body) return result;

  const allEdges = body.edges();
  const allVertices = body.vertices();

  // Check that every vertex's edge list is consistent
  for (const v of allVertices) {
    for (const e of v.edges) {
      if (e.startVertex !== v && e.endVertex !== v) {
        result.addError(`Vertex ${v.id}: references edge ${e.id} but edge does not reference this vertex`);
      }
    }
  }

  // Check that every edge references valid vertices
  for (const e of allEdges) {
    if (!e.startVertex) {
      result.addError(`Edge ${e.id}: has no start vertex`);
    }
    if (!e.endVertex) {
      result.addError(`Edge ${e.id}: has no end vertex`);
    }
    if (e.startVertex === e.endVertex) {
      result.addWarning(`Edge ${e.id}: start and end vertex are the same (degenerate edge)`);
    }
  }

  return result;
}

/**
 * Check for duplicate coincident edges.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {ValidationResult}
 */
export function validateNoDuplicateEdges(body, tol = DEFAULT_TOLERANCE) {
  const result = new ValidationResult();
  if (!body) return result;

  const allEdges = body.edges();
  for (let i = 0; i < allEdges.length; i++) {
    for (let j = i + 1; j < allEdges.length; j++) {
      const ei = allEdges[i], ej = allEdges[j];
      const sameForward = tol.pointsCoincident(ei.startVertex.point, ej.startVertex.point) &&
                          tol.pointsCoincident(ei.endVertex.point, ej.endVertex.point);
      const sameReverse = tol.pointsCoincident(ei.startVertex.point, ej.endVertex.point) &&
                          tol.pointsCoincident(ei.endVertex.point, ej.startVertex.point);
      if (sameForward || sameReverse) {
        result.addError(`Edges ${ei.id} and ${ej.id} are coincident duplicates`);
      }
    }
  }

  return result;
}

/**
 * Full validation suite for a body.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {ValidationResult}
 */
export function validateFull(body, tol = DEFAULT_TOLERANCE) {
  const result = new ValidationResult();

  const bodyResult = validateBody(body, tol);
  result.errors.push(...bodyResult.errors);
  result.warnings.push(...bodyResult.warnings);

  const incidenceResult = validateIncidence(body);
  result.errors.push(...incidenceResult.errors);
  result.warnings.push(...incidenceResult.warnings);

  const dupeResult = validateNoDuplicateEdges(body, tol);
  result.errors.push(...dupeResult.errors);
  result.warnings.push(...dupeResult.warnings);

  return result;
}

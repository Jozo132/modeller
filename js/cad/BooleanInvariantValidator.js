// js/cad/BooleanInvariantValidator.js — Post-condition invariant validator for boolean results
//
// Runs after every boolean operation to verify the result body satisfies
// topological and geometric invariants.  Returns structured diagnostics
// so that failures are surfaced explicitly, never silently ignored.
//
// Invariants checked:
//   1. Shells are closed (every edge used exactly 2×) when expected
//   2. Loop orientation consistency (adjacent faces traverse shared edge in opposite sense)
//   3. Coedge → edge → vertex reference chain is intact (no nulls)
//   4. No dangling topology references (every edge referenced by ≥1 coedge)
//   5. No duplicate or zero-length residual edges/fragments
//   6. Face/edge adjacency consistency (edge connects exactly 2 faces in manifold)
//   7. Tolerance-policy violations recorded with numeric context

import { DEFAULT_TOLERANCE } from './Tolerance.js';

// ---------------------------------------------------------------------------
// Diagnostic container
// ---------------------------------------------------------------------------

/**
 * A single invariant violation diagnostic.
 * @typedef {{
 *   invariant: string,
 *   entityIds: Array<string|number>,
 *   tolerance: number,
 *   detail: string,
 * }} InvariantDiagnostic
 */

/**
 * Result of running the invariant validator on a boolean output body.
 */
export class BooleanInvariantResult {
  /**
   * @param {string} operation  The boolean operation that produced the body.
   */
  constructor(operation = 'unknown') {
    /** @type {string} */
    this.operation = operation;
    /** @type {InvariantDiagnostic[]} */
    this.diagnostics = [];
    /** @type {number} */
    this.shellCount = 0;
    /** @type {number} */
    this.faceCount = 0;
    /** @type {number} */
    this.edgeCount = 0;
    /** @type {number} */
    this.vertexCount = 0;
  }

  /** @param {InvariantDiagnostic} diag */
  addDiagnostic(diag) { this.diagnostics.push(diag); }

  get isValid() { return this.diagnostics.length === 0; }

  /** Compact JSON payload for CI / diagnostics. */
  toJSON() {
    return {
      valid: this.isValid,
      operation: this.operation,
      counts: {
        shells: this.shellCount,
        faces: this.faceCount,
        edges: this.edgeCount,
        vertices: this.vertexCount,
      },
      diagnosticCount: this.diagnostics.length,
      diagnostics: this.diagnostics,
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate post-condition invariants on a boolean result body.
 *
 * @param {import('./BRepTopology.js').TopoBody|null} body
 * @param {Object} [opts]
 * @param {'union'|'subtract'|'intersect'|string} [opts.operation='unknown']
 * @param {import('./Tolerance.js').Tolerance} [opts.tolerance]
 * @param {boolean} [opts.expectClosed=true]  Whether the result shell is expected to be closed.
 * @returns {BooleanInvariantResult}
 */
export function validateBooleanResult(body, opts = {}) {
  const operation = opts.operation || 'unknown';
  const tol = opts.tolerance || DEFAULT_TOLERANCE;
  const expectClosed = opts.expectClosed !== false;
  const result = new BooleanInvariantResult(operation);

  // --- Null / empty body ---
  if (!body) {
    result.addDiagnostic({
      invariant: 'body-present',
      entityIds: [],
      tolerance: 0,
      detail: 'boolean result body is null or undefined',
    });
    return result;
  }

  if (!body.shells || body.shells.length === 0) {
    result.addDiagnostic({
      invariant: 'body-has-shells',
      entityIds: [body.id ?? '?'],
      tolerance: 0,
      detail: 'boolean result body has no shells',
    });
    return result;
  }

  result.shellCount = body.shells.length;

  // Collect global counts
  const allFaces = [];
  const allEdgeIds = new Set();
  const allVertexIds = new Set();

  for (const shell of body.shells) {
    if (!shell.faces) continue;
    for (const face of shell.faces) {
      allFaces.push(face);
      for (const loop of _allLoops(face)) {
        for (const ce of loop.coedges) {
          if (ce.edge) {
            allEdgeIds.add(ce.edge.id);
            if (ce.edge.startVertex) allVertexIds.add(ce.edge.startVertex.id);
            if (ce.edge.endVertex) allVertexIds.add(ce.edge.endVertex.id);
          }
        }
      }
    }
  }

  result.faceCount = allFaces.length;
  result.edgeCount = allEdgeIds.size;
  result.vertexCount = allVertexIds.size;

  // --- Per-shell checks ---
  for (const shell of body.shells) {
    _checkReferenceConsistency(shell, result);
    _checkNoDanglingReferences(shell, result);
    _checkEdgeManifold(shell, expectClosed, result);
    _checkOrientationConsistency(shell, result);
    _checkZeroLengthEdges(shell, tol, result);
    _checkDuplicateEdges(shell, tol, result);
    _checkLoopClosure(shell, tol, result);
    _checkFaceEdgeAdjacency(shell, result);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Invariant 3: Coedge → edge → vertex reference chain (no nulls)
// ---------------------------------------------------------------------------

function _checkReferenceConsistency(shell, result) {
  const sid = shell.id ?? '?';
  if (!shell.faces) return;

  for (const face of shell.faces) {
    const fid = face.id ?? '?';
    for (const loop of _allLoops(face)) {
      if (!loop.coedges || !Array.isArray(loop.coedges)) {
        result.addDiagnostic({
          invariant: 'loop-has-coedges',
          entityIds: [sid, fid],
          tolerance: 0,
          detail: `shell ${sid}, face ${fid}: loop has no coedges array`,
        });
        continue;
      }

      for (let ci = 0; ci < loop.coedges.length; ci++) {
        const ce = loop.coedges[ci];
        if (!ce) {
          result.addDiagnostic({
            invariant: 'coedge-not-null',
            entityIds: [sid, fid, ci],
            tolerance: 0,
            detail: `shell ${sid}, face ${fid}, coedge[${ci}]: coedge is null`,
          });
          continue;
        }
        if (!ce.edge) {
          result.addDiagnostic({
            invariant: 'coedge-has-edge',
            entityIds: [sid, fid, ce.id ?? ci],
            tolerance: 0,
            detail: `shell ${sid}, face ${fid}, coedge ${ce.id ?? ci}: no edge reference`,
          });
          continue;
        }
        if (!ce.edge.startVertex) {
          result.addDiagnostic({
            invariant: 'edge-has-start-vertex',
            entityIds: [sid, fid, ce.edge.id ?? ci],
            tolerance: 0,
            detail: `shell ${sid}, face ${fid}, edge ${ce.edge.id ?? ci}: missing startVertex`,
          });
        }
        if (!ce.edge.endVertex) {
          result.addDiagnostic({
            invariant: 'edge-has-end-vertex',
            entityIds: [sid, fid, ce.edge.id ?? ci],
            tolerance: 0,
            detail: `shell ${sid}, face ${fid}, edge ${ce.edge.id ?? ci}: missing endVertex`,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Invariant 4: No dangling topology references
// ---------------------------------------------------------------------------

function _checkNoDanglingReferences(shell, result) {
  const sid = shell.id ?? '?';
  if (!shell.faces) return;

  // Collect all edge objects actually referenced by coedges
  const referencedEdges = new Set();
  const edgeToFaces = new Map();

  for (const face of shell.faces) {
    for (const loop of _allLoops(face)) {
      for (const ce of loop.coedges) {
        if (!ce || !ce.edge) continue;
        referencedEdges.add(ce.edge);
        if (!edgeToFaces.has(ce.edge.id)) edgeToFaces.set(ce.edge.id, new Set());
        edgeToFaces.get(ce.edge.id).add(face.id ?? '?');
      }
    }
  }

  // Check for edges with vertices that don't appear in any other edge
  // (i.e. truly dangling vertices not connected to the mesh)
  const vertexUseCounts = new Map();
  for (const edge of referencedEdges) {
    if (edge.startVertex) {
      const vid = edge.startVertex.id;
      vertexUseCounts.set(vid, (vertexUseCounts.get(vid) || 0) + 1);
    }
    if (edge.endVertex) {
      const vid = edge.endVertex.id;
      vertexUseCounts.set(vid, (vertexUseCounts.get(vid) || 0) + 1);
    }
  }

  for (const [vid, count] of vertexUseCounts) {
    if (count < 2) {
      result.addDiagnostic({
        invariant: 'vertex-not-dangling',
        entityIds: [sid, vid],
        tolerance: 0,
        detail: `shell ${sid}: vertex ${vid} referenced by only ${count} edge(s) — may be dangling`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Invariant 1: Shells are closed (edge-use count = 2 for closed manifold)
// ---------------------------------------------------------------------------

function _checkEdgeManifold(shell, expectClosed, result) {
  const sid = shell.id ?? '?';
  if (!shell.faces) return;

  const edgeCounts = new Map();
  for (const face of shell.faces) {
    for (const loop of _allLoops(face)) {
      for (const ce of loop.coedges) {
        if (!ce || !ce.edge) continue;
        const eid = ce.edge.id;
        if (eid != null) {
          edgeCounts.set(eid, (edgeCounts.get(eid) || 0) + 1);
        }
      }
    }
  }

  let openEdgeCount = 0;
  let nonManifoldEdgeCount = 0;

  for (const [edgeId, count] of edgeCounts) {
    if (count < 2) {
      openEdgeCount++;
    } else if (count > 2) {
      nonManifoldEdgeCount++;
      result.addDiagnostic({
        invariant: 'edge-manifold',
        entityIds: [sid, edgeId],
        tolerance: 0,
        detail: `shell ${sid}: edge ${edgeId} has ${count} coedges (non-manifold, expected ≤2)`,
      });
    }
  }

  if (expectClosed && openEdgeCount > 0) {
    result.addDiagnostic({
      invariant: 'shell-closed',
      entityIds: [sid],
      tolerance: 0,
      detail: `shell ${sid}: ${openEdgeCount} open edge(s) (shell expected to be closed)`,
    });
  }
}

// ---------------------------------------------------------------------------
// Invariant 2: Loop orientation consistency
// ---------------------------------------------------------------------------

function _checkOrientationConsistency(shell, result) {
  const sid = shell.id ?? '?';
  if (!shell.faces) return;

  const edgeUses = new Map();
  for (const face of shell.faces) {
    for (const loop of _allLoops(face)) {
      for (const ce of loop.coedges) {
        if (!ce || !ce.edge) continue;
        const eid = ce.edge.id;
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
          invariant: 'orientation-consistent',
          entityIds: [sid, edgeId, uses[0].face.id ?? '?', uses[1].face.id ?? '?'],
          tolerance: 0,
          detail: `shell ${sid}: edge ${edgeId} traversed in same sense by adjacent faces ${uses[0].face.id ?? '?'} and ${uses[1].face.id ?? '?'}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Invariant 5a: Zero-length edges
// ---------------------------------------------------------------------------

function _checkZeroLengthEdges(shell, tol, result) {
  const sid = shell.id ?? '?';
  if (!shell.faces) return;

  const seen = new Set();
  for (const face of shell.faces) {
    for (const loop of _allLoops(face)) {
      for (const ce of loop.coedges) {
        if (!ce || !ce.edge) continue;
        if (seen.has(ce.edge.id)) continue;
        seen.add(ce.edge.id);

        const sv = ce.edge.startVertex;
        const ev = ce.edge.endVertex;
        if (!sv || !ev) continue;
        if (sv === ev) {
          result.addDiagnostic({
            invariant: 'no-degenerate-edge',
            entityIds: [sid, ce.edge.id],
            tolerance: tol.pointCoincidence,
            detail: `shell ${sid}: edge ${ce.edge.id} has startVertex === endVertex (degenerate)`,
          });
          continue;
        }

        const dx = sv.point.x - ev.point.x;
        const dy = sv.point.y - ev.point.y;
        const dz = sv.point.z - ev.point.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < tol.pointCoincidence) {
          result.addDiagnostic({
            invariant: 'no-zero-length-edge',
            entityIds: [sid, ce.edge.id],
            tolerance: tol.pointCoincidence,
            detail: `shell ${sid}: edge ${ce.edge.id} length ${len.toExponential(3)} < pointCoincidence ${tol.pointCoincidence}`,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Invariant 5b: Duplicate edges (same start/end vertices)
// ---------------------------------------------------------------------------

function _checkDuplicateEdges(shell, tol, result) {
  const sid = shell.id ?? '?';
  if (!shell.faces) return;

  const edgesByKey = new Map();
  const seen = new Set();

  for (const face of shell.faces) {
    for (const loop of _allLoops(face)) {
      for (const ce of loop.coedges) {
        if (!ce || !ce.edge) continue;
        if (seen.has(ce.edge.id)) continue;
        seen.add(ce.edge.id);

        const sv = ce.edge.startVertex;
        const ev = ce.edge.endVertex;
        if (!sv || !ev) continue;

        // Canonical key: sorted vertex ids
        const a = Math.min(sv.id, ev.id);
        const b = Math.max(sv.id, ev.id);
        const key = `${a}-${b}`;

        if (edgesByKey.has(key)) {
          // Only report as duplicate if they are distinct edge objects
          const existing = edgesByKey.get(key);
          if (existing !== ce.edge.id) {
            result.addDiagnostic({
              invariant: 'no-duplicate-edge',
              entityIds: [sid, ce.edge.id, existing],
              tolerance: tol.edgeOverlap,
              detail: `shell ${sid}: edges ${ce.edge.id} and ${existing} share the same vertices (${a}, ${b})`,
            });
          }
        } else {
          edgesByKey.set(key, ce.edge.id);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Loop closure check (gap between consecutive coedges)
// ---------------------------------------------------------------------------

function _checkLoopClosure(shell, tol, result) {
  const sid = shell.id ?? '?';
  if (!shell.faces) return;

  for (const face of shell.faces) {
    const fid = face.id ?? '?';
    for (const loop of _allLoops(face)) {
      const coedges = loop.coedges;
      if (!coedges || coedges.length < 2) continue;

      for (let i = 0; i < coedges.length; i++) {
        const curr = coedges[i];
        const next = coedges[(i + 1) % coedges.length];
        if (!curr || !next || !curr.edge || !next.edge) continue;

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
            entityIds: [sid, fid, curr.edge.id, next.edge.id],
            tolerance: tol.sewing,
            detail: `shell ${sid}, face ${fid}: gap ${gap.toExponential(3)} between coedge ${i}→${(i + 1) % coedges.length} exceeds sewing tolerance`,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Invariant 6: Face/edge adjacency consistency
// ---------------------------------------------------------------------------

function _checkFaceEdgeAdjacency(shell, result) {
  const sid = shell.id ?? '?';
  if (!shell.faces) return;

  // Build edge → [face ids] map
  const edgeToFaces = new Map();
  for (const face of shell.faces) {
    const fid = face.id ?? '?';
    for (const loop of _allLoops(face)) {
      for (const ce of loop.coedges) {
        if (!ce || !ce.edge) continue;
        const eid = ce.edge.id;
        if (eid == null) continue;
        if (!edgeToFaces.has(eid)) edgeToFaces.set(eid, new Set());
        edgeToFaces.get(eid).add(fid);
      }
    }
  }

  // For a valid manifold, each edge should connect exactly 2 distinct faces
  // (this is related to edge-manifold but checks face-level adjacency)
  for (const [edgeId, faces] of edgeToFaces) {
    if (faces.size > 2) {
      result.addDiagnostic({
        invariant: 'face-edge-adjacency',
        entityIds: [sid, edgeId, ...faces],
        tolerance: 0,
        detail: `shell ${sid}: edge ${edgeId} connects ${faces.size} faces (expected ≤2 for manifold)`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function _allLoops(face) {
  const loops = [];
  if (face.outerLoop) loops.push(face.outerLoop);
  if (face.innerLoops) {
    for (const il of face.innerLoops) loops.push(il);
  }
  return loops;
}

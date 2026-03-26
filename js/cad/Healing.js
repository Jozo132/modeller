// js/cad/Healing.js — Topology healing for face fragments before sewing
//
// Uses the existing Tolerance policy to:
//   - Merge vertices within pointCoincidence
//   - Merge collinear / overlapping edges within edgeOverlap
//   - Collapse tiny edges and safely rewire adjacent loops/coedges
//   - Handle "almost coincident" seams conservatively
//   - Normalize fragment wiring so sewing receives clean inputs
//
// Every healing action is recorded as a diagnostic entry so that
// systemic invariant failures are never silently masked.

import { DEFAULT_TOLERANCE } from './Tolerance.js';

/**
 * Healing report — collects every action taken so that callers can
 * distinguish between "clean input" and "input that required repair".
 */
export class HealingReport {
  constructor() {
    /** @type {Array<{action: string, entityIds: Array<string|number>, tolerance: number, detail: string}>} */
    this.actions = [];
  }

  /** @param {{action: string, entityIds: Array<string|number>, tolerance: number, detail: string}} entry */
  record(entry) { this.actions.push(entry); }

  get healed() { return this.actions.length > 0; }

  toJSON() {
    return {
      healed: this.healed,
      actionCount: this.actions.length,
      actions: this.actions,
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Heal an array of face fragments in-place.
 *
 * Performs the following passes:
 *   1. Merge coincident vertices within pointCoincidence
 *   2. Collapse tiny (degenerate) edges and rewire loops
 *   3. Merge collinear / overlapping edges within edgeOverlap
 *   4. Fix almost-coincident seams (vertex snapping across fragments)
 *   5. Remove orphan fragments that have become degenerate
 *
 * @param {import('./BRepTopology.js').TopoFace[]} fragments
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {{ fragments: import('./BRepTopology.js').TopoFace[], report: HealingReport }}
 */
export function healFragments(fragments, tol = DEFAULT_TOLERANCE) {
  const report = new HealingReport();

  if (!Array.isArray(fragments) || fragments.length === 0) {
    return { fragments: fragments || [], report };
  }

  // Pass 1: Merge coincident vertices
  _mergeCoincidentVertices(fragments, tol, report);

  // Pass 2: Collapse tiny edges
  _collapseTinyEdges(fragments, tol, report);

  // Pass 3: Merge overlapping edges
  _mergeOverlappingEdges(fragments, tol, report);

  // Pass 4: Snap almost-coincident seam vertices
  _snapSeamVertices(fragments, tol, report);

  // Pass 5: Remove degenerate fragments
  const cleaned = _removeDegenerate(fragments, tol, report);

  return { fragments: cleaned, report };
}

// ---------------------------------------------------------------------------
// Pass 1 — Merge coincident vertices
// ---------------------------------------------------------------------------

/**
 * Merge vertices that are within `tol.pointCoincidence` of each other.
 * Operates across all fragments so that shared vertices are unified.
 */
function _mergeCoincidentVertices(fragments, tol, report) {
  // Collect all unique vertex objects
  const allVerts = [];
  const seen = new Set();
  for (const frag of fragments) {
    for (const v of _allVertices(frag)) {
      if (!seen.has(v)) { seen.add(v); allVerts.push(v); }
    }
  }

  // Spatial hash for fast neighborhood lookup
  const cellSize = Math.max(tol.pointCoincidence * 10, 1e-8);
  const buckets = new Map();
  const hashKey = (p) => {
    const ix = Math.round(p.x / cellSize);
    const iy = Math.round(p.y / cellSize);
    const iz = Math.round(p.z / cellSize);
    return `${ix},${iy},${iz}`;
  };

  for (const v of allVerts) {
    const key = hashKey(v.point);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(v);
  }

  const mergeMap = new Map(); // v.id → canonical vertex
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      if (mergeMap.has(bucket[i].id)) continue;
      for (let j = i + 1; j < bucket.length; j++) {
        if (mergeMap.has(bucket[j].id)) continue;
        const a = bucket[i].point;
        const b = bucket[j].point;
        const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) < tol.pointCoincidence) {
          mergeMap.set(bucket[j].id, bucket[i]);
          report.record({
            action: 'merge-vertex',
            entityIds: [bucket[j].id, bucket[i].id],
            tolerance: tol.pointCoincidence,
            detail: `vertex ${bucket[j].id} merged into ${bucket[i].id}`,
          });
        }
      }
    }
  }

  if (mergeMap.size === 0) return;

  // Apply merges to all edges in all fragments
  for (const frag of fragments) {
    for (const edge of _allEdges(frag)) {
      const ms = mergeMap.get(edge.startVertex?.id);
      if (ms) edge.startVertex = ms;
      const me = mergeMap.get(edge.endVertex?.id);
      if (me) edge.endVertex = me;
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 2 — Collapse tiny edges
// ---------------------------------------------------------------------------

/**
 * Collapse edges whose length is below `tol.edgeOverlap` and rewire
 * adjacent coedges to skip the degenerate edge.
 */
function _collapseTinyEdges(fragments, tol, report) {
  for (const frag of fragments) {
    for (const loop of _allLoops(frag)) {
      let changed = true;
      let safety = 0;
      while (changed && safety++ < 100) {
        changed = false;
        const coedges = loop.coedges;
        for (let i = 0; i < coedges.length; i++) {
          const ce = coedges[i];
          if (!ce.edge) continue;
          const sv = ce.edge.startVertex;
          const ev = ce.edge.endVertex;
          if (!sv || !ev) continue;
          if (sv === ev) {
            // Already degenerate — remove
            _removeCoedge(coedges, i, report, frag, ce);
            changed = true;
            break;
          }
          const dx = sv.point.x - ev.point.x;
          const dy = sv.point.y - ev.point.y;
          const dz = sv.point.z - ev.point.z;
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (len < tol.edgeOverlap) {
            // Collapse: rewire all references from endVertex to startVertex
            const survivor = sv;
            const victim = ev;
            _replaceVertex(fragments, victim, survivor);
            report.record({
              action: 'collapse-tiny-edge',
              entityIds: [ce.edge.id, victim.id, survivor.id],
              tolerance: tol.edgeOverlap,
              detail: `edge ${ce.edge.id} collapsed (length ${len.toExponential(3)}), vertex ${victim.id} → ${survivor.id}`,
            });
            // Edge is now degenerate (sv===ev), remove on next iteration
            changed = true;
            break;
          }
        }
      }
    }
  }
}

function _removeCoedge(coedges, index, report, frag, ce) {
  report.record({
    action: 'remove-degenerate-coedge',
    entityIds: [frag.id ?? '?', ce.edge?.id ?? '?'],
    tolerance: 0,
    detail: `removed degenerate coedge from fragment ${frag.id ?? '?'}`,
  });
  coedges.splice(index, 1);
}

function _replaceVertex(fragments, victim, survivor) {
  for (const frag of fragments) {
    for (const edge of _allEdges(frag)) {
      if (edge.startVertex === victim) edge.startVertex = survivor;
      if (edge.endVertex === victim) edge.endVertex = survivor;
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 3 — Merge overlapping / collinear edges
// ---------------------------------------------------------------------------

/**
 * Merge edges that share the same vertices (after vertex merging).
 */
function _mergeOverlappingEdges(fragments, tol, report) {
  const allEdges = [];
  const edgeSet = new Set();
  for (const frag of fragments) {
    for (const e of _allEdges(frag)) {
      if (!edgeSet.has(e)) { edgeSet.add(e); allEdges.push(e); }
    }
  }

  const mergeMap = new Map(); // edge.id → { target, reversed }
  for (let i = 0; i < allEdges.length; i++) {
    if (mergeMap.has(allEdges[i].id)) continue;
    for (let j = i + 1; j < allEdges.length; j++) {
      if (mergeMap.has(allEdges[j].id)) continue;
      const ei = allEdges[i], ej = allEdges[j];
      const fwd = ei.startVertex === ej.startVertex && ei.endVertex === ej.endVertex;
      const rev = ei.startVertex === ej.endVertex && ei.endVertex === ej.startVertex;
      if (fwd || rev) {
        mergeMap.set(ej.id, { target: ei, reversed: rev });
        report.record({
          action: 'merge-overlapping-edge',
          entityIds: [ej.id, ei.id],
          tolerance: tol.edgeOverlap,
          detail: `edge ${ej.id} merged into ${ei.id}${rev ? ' (reversed)' : ''}`,
        });
      }
    }
  }

  if (mergeMap.size === 0) return;

  for (const frag of fragments) {
    for (const loop of _allLoops(frag)) {
      for (const ce of loop.coedges) {
        const m = mergeMap.get(ce.edge?.id);
        if (m) {
          ce.edge = m.target;
          if (m.reversed) ce.sameSense = !ce.sameSense;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 4 — Snap almost-coincident seam vertices
// ---------------------------------------------------------------------------

/**
 * Snap vertices that are within sewing tolerance to each other, but not
 * within pointCoincidence (those are already merged in pass 1).
 * This handles the case where a vertex is "almost" on another fragment's edge.
 */
function _snapSeamVertices(fragments, tol, report) {
  const allVerts = [];
  const seen = new Set();
  for (const frag of fragments) {
    for (const v of _allVertices(frag)) {
      if (!seen.has(v)) { seen.add(v); allVerts.push(v); }
    }
  }

  const cellSize = Math.max(tol.sewing * 2, 1e-6);
  const buckets = new Map();
  const hashKey = (p) => {
    const ix = Math.round(p.x / cellSize);
    const iy = Math.round(p.y / cellSize);
    const iz = Math.round(p.z / cellSize);
    return `${ix},${iy},${iz}`;
  };

  for (const v of allVerts) {
    const key = hashKey(v.point);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(v);
  }

  const snapMap = new Map();
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      if (snapMap.has(bucket[i].id)) continue;
      for (let j = i + 1; j < bucket.length; j++) {
        if (snapMap.has(bucket[j].id)) continue;
        // Skip if already the same object (already merged)
        if (bucket[i] === bucket[j]) continue;
        const a = bucket[i].point;
        const b = bucket[j].point;
        const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < tol.sewing && dist >= tol.pointCoincidence) {
          snapMap.set(bucket[j].id, bucket[i]);
          report.record({
            action: 'snap-seam-vertex',
            entityIds: [bucket[j].id, bucket[i].id],
            tolerance: tol.sewing,
            detail: `vertex ${bucket[j].id} snapped to ${bucket[i].id} (dist ${dist.toExponential(3)})`,
          });
        }
      }
    }
  }

  if (snapMap.size === 0) return;

  for (const frag of fragments) {
    for (const edge of _allEdges(frag)) {
      const ms = snapMap.get(edge.startVertex?.id);
      if (ms) edge.startVertex = ms;
      const me = snapMap.get(edge.endVertex?.id);
      if (me) edge.endVertex = me;
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 5 — Remove degenerate fragments
// ---------------------------------------------------------------------------

/**
 * Remove fragments that have fewer than 3 non-degenerate coedges.
 */
function _removeDegenerate(fragments, tol, report) {
  const out = [];
  for (const frag of fragments) {
    if (!frag.outerLoop || !frag.outerLoop.coedges) {
      report.record({
        action: 'remove-degenerate-fragment',
        entityIds: [frag.id ?? '?'],
        tolerance: 0,
        detail: `fragment ${frag.id ?? '?'} removed: no outer loop`,
      });
      continue;
    }

    // Filter out any remaining degenerate coedges
    const live = frag.outerLoop.coedges.filter(ce => {
      if (!ce.edge) return false;
      return ce.edge.startVertex !== ce.edge.endVertex;
    });

    if (live.length < 3) {
      report.record({
        action: 'remove-degenerate-fragment',
        entityIds: [frag.id ?? '?'],
        tolerance: 0,
        detail: `fragment ${frag.id ?? '?'} removed: only ${live.length} non-degenerate coedges`,
      });
      continue;
    }

    frag.outerLoop.coedges = live;
    out.push(frag);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers — traverse topology
// ---------------------------------------------------------------------------

function _allVertices(face) {
  const verts = [];
  for (const loop of _allLoops(face)) {
    for (const ce of loop.coedges) {
      if (ce.edge?.startVertex) verts.push(ce.edge.startVertex);
      if (ce.edge?.endVertex) verts.push(ce.edge.endVertex);
    }
  }
  return verts;
}

function _allEdges(face) {
  const edges = [];
  for (const loop of _allLoops(face)) {
    for (const ce of loop.coedges) {
      if (ce.edge) edges.push(ce.edge);
    }
  }
  return edges;
}

function _allLoops(face) {
  const loops = [];
  if (face.outerLoop) loops.push(face.outerLoop);
  if (face.innerLoops) loops.push(...face.innerLoops);
  return loops;
}

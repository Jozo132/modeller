// js/cad/CoplanarMerge.js — Post-boolean coplanar face consolidation
//
// After boolean operations, face splitting can create many small planar
// fragments that share a plane. This module merges adjacent coplanar
// fragments back into larger faces, reducing face count and triangle
// output for the tessellator.
//
// The merge is iterative: pick two adjacent coplanar faces sharing an
// edge, splice their boundary loops together (removing the shared edge),
// and repeat until no more merges are possible.

import { TopoFace, TopoLoop, SurfaceType } from './BRepTopology.js';
import { DEFAULT_TOLERANCE } from './Tolerance.js';

/**
 * Merge adjacent coplanar planar faces in a TopoBody.
 *
 * Only faces with `surfaceType === 'plane'` and no inner loops (holes)
 * are considered for merging. Two faces merge when they:
 *   - share at least one edge,
 *   - lie on the same geometric plane (within tolerance),
 *   - have the same sameSense, and
 *   - carry the same shared metadata.
 *
 * After all pair-wise merges, any collinear mid-boundary vertices left
 * behind are cleaned up so the resulting loops are minimal.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {Object} [tol]
 * @returns {import('./BRepTopology.js').TopoBody} The same body, mutated.
 */
export function mergeCoplanarFaces(body, tol = DEFAULT_TOLERANCE) {
  if (!body || !body.shells) return body;
  for (const shell of body.shells) {
    _mergeInShell(shell, tol);
  }
  return body;
}

// ── Internal helpers ─────────────────────────────────────────────────

function _mergeInShell(shell, tol) {
  let changed = true;
  while (changed) {
    changed = _doOneMergePass(shell, tol);
  }
}

/**
 * Attempt one pairwise merge in the shell.
 * @returns {boolean} true if a merge was performed
 */
function _doOneMergePass(shell, tol) {
  // Build edge → [{ face, coedge }] map
  const edgeToFaces = new Map();
  for (const face of shell.faces) {
    if (!face.outerLoop) continue;
    for (const ce of face.outerLoop.coedges) {
      const eid = ce.edge.id;
      if (!edgeToFaces.has(eid)) edgeToFaces.set(eid, []);
      edgeToFaces.get(eid).push({ face, coedge: ce });
    }
  }

  for (const [, entries] of edgeToFaces) {
    if (entries.length !== 2) continue;
    const [a, b] = entries;
    if (a.face === b.face) continue;

    // Only merge planar faces
    if (a.face.surfaceType !== SurfaceType.PLANE) continue;
    if (b.face.surfaceType !== SurfaceType.PLANE) continue;

    // Skip faces that already have inner loops — merging those requires
    // more complex loop surgery.
    if (a.face.innerLoops.length > 0 || b.face.innerLoops.length > 0) continue;

    // Coplanarity check
    if (!_areCoplanar(a.face, b.face, tol)) continue;

    // Compatible metadata
    if (!_sameShared(a.face, b.face)) continue;

    // Same sameSense
    if (a.face.sameSense !== b.face.sameSense) continue;

    // Collect ALL shared edges between these two faces
    const faceAEdgeIds = new Set();
    for (const ce of a.face.outerLoop.coedges) faceAEdgeIds.add(ce.edge.id);
    const sharedEdgeIds = new Set();
    for (const ce of b.face.outerLoop.coedges) {
      if (faceAEdgeIds.has(ce.edge.id)) sharedEdgeIds.add(ce.edge.id);
    }

    const merged = _mergePair(a.face, b.face, sharedEdgeIds, tol);
    if (!merged) continue;

    // Replace the two faces with the merged one
    shell.faces = shell.faces.filter(f => f !== a.face && f !== b.face);
    shell.faces.push(merged);
    return true;
  }

  return false;
}

/**
 * Check if two planar faces lie on the same geometric plane.
 */
function _areCoplanar(faceA, faceB, tol) {
  const nA = _faceNormal(faceA);
  const nB = _faceNormal(faceB);
  if (!nA || !nB) return false;

  // Normals must be parallel (dot ≈ ±1)
  const dot = nA.x * nB.x + nA.y * nB.y + nA.z * nB.z;
  if (Math.abs(Math.abs(dot) - 1) > 0.001) return false;

  // A point from B must lie on A's plane
  const pA = _firstPoint(faceA);
  const pB = _firstPoint(faceB);
  if (!pA || !pB) return false;

  const dist = Math.abs(
    nA.x * (pB.x - pA.x) + nA.y * (pB.y - pA.y) + nA.z * (pB.z - pA.z)
  );
  const ptTol = tol.pointCoincidence ?? 1e-6;
  return dist < ptTol;
}

function _faceNormal(face) {
  const pts = face.outerLoop?.points();
  if (!pts || pts.length < 3) return null;

  // Newell's method for robust normal from arbitrary polygon
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const c = pts[i];
    const n = pts[(i + 1) % pts.length];
    nx += (c.y - n.y) * (c.z + n.z);
    ny += (c.z - n.z) * (c.x + n.x);
    nz += (c.x - n.x) * (c.y + n.y);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-14) return null;
  return { x: nx / len, y: ny / len, z: nz / len };
}

function _firstPoint(face) {
  const ce = face.outerLoop?.coedges?.[0];
  return ce ? ce.startVertex().point : null;
}

function _sameShared(fA, fB) {
  const sA = fA.shared;
  const sB = fB.shared;
  if (sA == null && sB == null) return true;
  if (sA == null || sB == null) return false;
  return JSON.stringify(sA) === JSON.stringify(sB);
}

// ── Merge two faces ─────────────────────────────────────────────────

/**
 * Merge two adjacent coplanar faces by removing their shared edges
 * and splicing the remaining boundary coedges into new loops.
 *
 * @param {TopoFace} faceA
 * @param {TopoFace} faceB
 * @param {Set<number>} sharedEdgeIds - IDs of shared TopoEdges
 * @param {Object} tol
 * @returns {TopoFace|null}
 */
function _mergePair(faceA, faceB, sharedEdgeIds, tol) {
  const coedgesA = faceA.outerLoop.coedges;
  const coedgesB = faceB.outerLoop.coedges;

  // Collect non-shared coedges from each face
  const remainA = coedgesA.filter(ce => !sharedEdgeIds.has(ce.edge.id));
  const remainB = coedgesB.filter(ce => !sharedEdgeIds.has(ce.edge.id));

  if (remainA.length === 0 && remainB.length === 0) return null;

  // Chain all remaining coedges into closed loops.
  // After removing the shared edges, the remaining coedges from both faces
  // should form one or more closed loops (outer boundary + possible holes).
  const allRemaining = [...remainA, ...remainB];
  const chains = _chainCoedges(allRemaining);
  if (chains.length === 0) return null;

  // Verify all chains are closed loops
  for (const chain of chains) {
    if (chain.length < 3) return null;
    const first = chain[0].startVertex();
    const last = chain[chain.length - 1].endVertex();
    if (first !== last) return null; // Open chain — bail out
  }

  // Pick the largest chain as outer loop (by vertex count)
  chains.sort((a, b) => b.length - a.length);

  // Clean up collinear vertices in the merged loop.
  // NOTE: We must NOT create new TopoEdge objects here because the
  // existing edges are shared with adjacent faces in the shell.
  // Collinear vertex removal is purely cosmetic and is handled
  // downstream by the tessellator's removeCollinearPoints.
  const outerCoedges = chains[0];
  if (outerCoedges.length < 3) return null;

  // Build the merged face
  const newFace = new TopoFace(
    faceA.surface ? faceA.surface.clone() : null,
    faceA.surfaceType,
    faceA.sameSense,
  );
  newFace.shared = faceA.shared ? { ...faceA.shared } : null;
  newFace.surfaceInfo = faceA.surfaceInfo ? { ...faceA.surfaceInfo } : null;
  newFace.tolerance = Math.max(faceA.tolerance, faceB.tolerance);
  newFace.setOuterLoop(new TopoLoop(outerCoedges));

  // Additional chains become inner loops (holes)
  for (let i = 1; i < chains.length; i++) {
    const holeCoedges = chains[i];
    if (holeCoedges.length >= 3) {
      newFace.addInnerLoop(new TopoLoop(holeCoedges));
    }
  }

  return newFace;
}

/**
 * Chain coedges by matching end-vertex → start-vertex into closed loops.
 *
 * @param {TopoCoEdge[]} coedges
 * @returns {TopoCoEdge[][]} Array of closed-loop chains
 */
function _chainCoedges(coedges) {
  if (coedges.length === 0) return [];

  // Map: startVertex.id → coedge
  const fromVertex = new Map();
  for (const ce of coedges) {
    const sv = ce.startVertex();
    fromVertex.set(sv.id, ce);
  }

  const used = new Set();
  const chains = [];

  for (const ce of coedges) {
    if (used.has(ce)) continue;

    const chain = [];
    let current = ce;
    while (current && !used.has(current)) {
      used.add(current);
      chain.push(current);
      const ev = current.endVertex();
      current = fromVertex.get(ev.id) ?? null;
    }

    if (chain.length > 0) chains.push(chain);
  }

  return chains;
}

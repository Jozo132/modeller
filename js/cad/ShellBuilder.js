// js/cad/ShellBuilder.js — Shell stitching and sewing
//
// Stitches face fragments into valid shells after boolean operations.
// Handles:
//   - Sew vertices within tolerance
//   - Merge coincident edges
//   - Validate shell orientation and closure

import { TopoShell, TopoBody, TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace } from './BRepTopology.js';
import { DEFAULT_TOLERANCE } from './Tolerance.js';

/**
 * Stitch face fragments into one or more closed shells.
 *
 * @param {import('./BRepTopology.js').TopoFace[]} fragments
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {import('./BRepTopology.js').TopoShell[]}
 */
export function stitchFaces(fragments, tol = DEFAULT_TOLERANCE) {
  if (fragments.length === 0) return [];

  // Step 1: Sew coincident vertices
  _sewVertices(fragments, tol);

  // Step 2: Merge coincident edges
  _mergeEdges(fragments, tol);

  // Step 3: Group connected faces into shells
  const shells = _groupIntoShells(fragments);

  // Step 4: Validate and orient each shell
  for (const shell of shells) {
    shell.closed = _isShellClosed(shell);
    _orientShell(shell);
  }

  return shells;
}

/**
 * Build a body from stitched face fragments.
 *
 * @param {import('./BRepTopology.js').TopoFace[]} fragments
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {import('./BRepTopology.js').TopoBody}
 */
export function buildBody(fragments, tol = DEFAULT_TOLERANCE) {
  const shells = stitchFaces(fragments, tol);
  return new TopoBody(shells);
}

/**
 * Sew coincident vertices across fragments.
 */
function _sewVertices(fragments, tol) {
  // Collect all unique vertices
  const allVerts = [];
  for (const f of fragments) {
    for (const v of f.vertices()) {
      if (!allVerts.includes(v)) allVerts.push(v);
    }
  }

  // Build spatial hash for fast lookup
  const merged = new Map();
  const cellSize = tol.sewing * 10;
  const hashKey = (p) => {
    const ix = Math.round(p.x / cellSize);
    const iy = Math.round(p.y / cellSize);
    const iz = Math.round(p.z / cellSize);
    return `${ix},${iy},${iz}`;
  };

  const buckets = new Map();
  for (const v of allVerts) {
    const key = hashKey(v.point);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(v);
  }

  // Merge vertices within tolerance
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      if (merged.has(bucket[i].id)) continue;
      for (let j = i + 1; j < bucket.length; j++) {
        if (merged.has(bucket[j].id)) continue;
        if (tol.pointsCoincident(bucket[i].point, bucket[j].point)) {
          merged.set(bucket[j].id, bucket[i]);
        }
      }
    }
  }

  // Replace merged vertices in all edges
  for (const f of fragments) {
    for (const e of f.edges()) {
      if (merged.has(e.startVertex.id)) {
        e.startVertex = merged.get(e.startVertex.id);
      }
      if (merged.has(e.endVertex.id)) {
        e.endVertex = merged.get(e.endVertex.id);
      }
    }
  }
}

/**
 * Merge coincident edges across fragments.
 */
function _mergeEdges(fragments, tol) {
  const allEdges = [];
  for (const f of fragments) {
    for (const e of f.edges()) {
      if (!allEdges.includes(e)) allEdges.push(e);
    }
  }

  const merged = new Map();
  for (let i = 0; i < allEdges.length; i++) {
    if (merged.has(allEdges[i].id)) continue;
    for (let j = i + 1; j < allEdges.length; j++) {
      if (merged.has(allEdges[j].id)) continue;
      const ei = allEdges[i], ej = allEdges[j];

      // Check if edges share the same vertices (in either order)
      const sameForward = ei.startVertex === ej.startVertex && ei.endVertex === ej.endVertex;
      const sameReverse = ei.startVertex === ej.endVertex && ei.endVertex === ej.startVertex;

      if (sameForward || sameReverse) {
        merged.set(ej.id, { target: ei, reversed: sameReverse });
      }
    }
  }

  // Replace merged edges in coedges
  for (const f of fragments) {
    for (const loop of f.allLoops()) {
      for (const ce of loop.coedges) {
        const m = merged.get(ce.edge.id);
        if (m) {
          ce.edge = m.target;
          if (m.reversed) ce.sameSense = !ce.sameSense;
          if (!m.target.coedges.includes(ce)) m.target.coedges.push(ce);
        }
      }
    }
  }
}

/**
 * Group connected faces into shells using flood fill.
 */
function _groupIntoShells(fragments) {
  const visited = new Set();
  const shells = [];

  // Build edge-to-face adjacency
  const edgeFaces = new Map();
  for (const f of fragments) {
    for (const e of f.edges()) {
      if (!edgeFaces.has(e.id)) edgeFaces.set(e.id, []);
      edgeFaces.get(e.id).push(f);
    }
  }

  for (const startFace of fragments) {
    if (visited.has(startFace.id)) continue;

    const shellFaces = [];
    const queue = [startFace];

    while (queue.length > 0) {
      const face = queue.pop();
      if (visited.has(face.id)) continue;
      visited.add(face.id);
      shellFaces.push(face);

      // Find adjacent faces through shared edges
      for (const e of face.edges()) {
        const adj = edgeFaces.get(e.id) || [];
        for (const af of adj) {
          if (!visited.has(af.id)) queue.push(af);
        }
      }
    }

    shells.push(new TopoShell(shellFaces));
  }

  return shells;
}

/**
 * Check if a shell is topologically closed (every edge has exactly 2 coedges).
 */
function _isShellClosed(shell) {
  const edgeCounts = new Map();
  for (const f of shell.faces) {
    for (const loop of f.allLoops()) {
      for (const ce of loop.coedges) {
        edgeCounts.set(ce.edge.id, (edgeCounts.get(ce.edge.id) || 0) + 1);
      }
    }
  }

  for (const count of edgeCounts.values()) {
    if (count !== 2) return false;
  }
  return true;
}

/**
 * Orient shell faces consistently (outward-pointing normals).
 */
function _orientShell(shell) {
  // Simple heuristic: check that the first face's normal points outward
  // by comparing with the centroid direction
  if (shell.faces.length === 0) return;

  // Compute centroid
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (const f of shell.faces) {
    const pts = f.outerLoop ? f.outerLoop.points() : [];
    for (const p of pts) {
      cx += p.x; cy += p.y; cz += p.z;
      count++;
    }
  }
  if (count > 0) {
    cx /= count; cy /= count; cz /= count;
  }

  // Check and flip face orientations if needed
  for (const face of shell.faces) {
    if (!face.surface || !face.outerLoop) continue;
    const pts = face.outerLoop.points();
    if (pts.length === 0) continue;

    const facePt = pts[0];
    const normal = face.surface.normal(
      (face.surface.uMin + face.surface.uMax) / 2,
      (face.surface.vMin + face.surface.vMax) / 2,
    );

    // Direction from centroid to face point
    const toCentroid = {
      x: facePt.x - cx,
      y: facePt.y - cy,
      z: facePt.z - cz,
    };

    const dot = normal.x * toCentroid.x + normal.y * toCentroid.y + normal.z * toCentroid.z;
    if (dot < 0) {
      face.sameSense = !face.sameSense;
    }
  }
}

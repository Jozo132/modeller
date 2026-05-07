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
  const hashCoords = (p) => ({
    ix: Math.round(p.x / cellSize),
    iy: Math.round(p.y / cellSize),
    iz: Math.round(p.z / cellSize),
  });
  const hashKey = ({ ix, iy, iz }) => {
    return `${ix},${iy},${iz}`;
  };

  const buckets = new Map();
  const vertexOrder = new Map();
  allVerts.forEach((v, index) => {
    vertexOrder.set(v.id, index);
  });
  for (const v of allVerts) {
    const key = hashKey(hashCoords(v.point));
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(v);
  }

  // Merge vertices within tolerance
  for (const vertex of allVerts) {
    if (merged.has(vertex.id)) continue;
    const { ix, iy, iz } = hashCoords(vertex.point);
    const currentOrder = vertexOrder.get(vertex.id) ?? 0;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = buckets.get(hashKey({ ix: ix + dx, iy: iy + dy, iz: iz + dz }));
          if (!bucket) continue;

          for (const candidate of bucket) {
            const candidateOrder = vertexOrder.get(candidate.id) ?? 0;
            if (candidate === vertex || candidateOrder <= currentOrder || merged.has(candidate.id)) continue;
            if (tol.distance(vertex.point, candidate.point) <= tol.sewing) {
              merged.set(candidate.id, vertex);
            }
          }
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

      if ((sameForward || sameReverse) && _edgeCurvesCompatible(ei, ej, tol)) {
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

function _edgeCurvesCompatible(edgeA, edgeB, tol) {
  const sampleTol = Math.max(tol?.sewing ?? 0, tol?.edgeOverlap ?? 0, 1e-6);
  let directOk = true;
  let reverseOk = true;

  for (const t of [0.25, 0.5, 0.75]) {
    const a = _edgePointAtFraction(edgeA, t);
    const bDirect = _edgePointAtFraction(edgeB, t);
    const bReverse = _edgePointAtFraction(edgeB, 1 - t);
    if (!a || !bDirect || !bReverse) return false;
    if (_pointDistance(a, bDirect) > sampleTol) directOk = false;
    if (_pointDistance(a, bReverse) > sampleTol) reverseOk = false;
    if (!directOk && !reverseOk) return false;
  }

  return true;
}

function _edgePointAtFraction(edge, t) {
  if (!edge) return null;
  if (edge.curve && typeof edge.curve.evaluate === 'function') {
    try {
      const uMin = Number.isFinite(edge.curve.uMin) ? edge.curve.uMin : 0;
      const uMax = Number.isFinite(edge.curve.uMax) ? edge.curve.uMax : 1;
      const p = edge.curve.evaluate(uMin + (uMax - uMin) * t);
      if (p?.p) return p.p;
      if (Number.isFinite(p?.x) && Number.isFinite(p?.y) && Number.isFinite(p?.z)) return p;
    } catch (_) {
      // Fall through to straight endpoint interpolation.
    }
  }

  const start = edge.startVertex?.point;
  const end = edge.endVertex?.point;
  if (!start || !end) return null;
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    z: start.z + (end.z - start.z) * t,
  };
}

function _pointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
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
  if (shell.faces.length === 0) return;
  const baseDirections = shell.faces.map(face => _faceEdgeDirections(face));
  const edgeUses = new Map();

  for (let fi = 0; fi < shell.faces.length; fi++) {
    for (const dir of baseDirections[fi]) {
      if (!edgeUses.has(dir.key)) edgeUses.set(dir.key, []);
      edgeUses.get(dir.key).push({ fi, fwd: dir.fwd });
    }
  }

  const flip = new Array(shell.faces.length).fill(false);
  const visited = new Array(shell.faces.length).fill(false);

  for (let start = 0; start < shell.faces.length; start++) {
    if (visited[start]) continue;
    visited[start] = true;
    const queue = [start];

    while (queue.length > 0) {
      const fi = queue.shift();
      const dirs = baseDirections[fi];
      for (const dir of dirs) {
        const uses = edgeUses.get(dir.key) || [];
        if (uses.length !== 2) continue;
        const other = uses[0].fi === fi ? uses[1] : uses[0];
        const relationFlip = dir.fwd === other.fwd;
        const expected = relationFlip ? !flip[fi] : flip[fi];
        if (!visited[other.fi]) {
          visited[other.fi] = true;
          flip[other.fi] = expected;
          queue.push(other.fi);
        }
      }
    }
  }

  for (let fi = 0; fi < shell.faces.length; fi++) {
    if (flip[fi]) _flipFaceOrientation(shell.faces[fi]);
  }

  const signedVolume = _approximateShellVolume(shell);
  if (signedVolume < -1e-8) {
    for (const face of shell.faces) {
      _flipFaceOrientation(face);
    }
  }
}

function _flipFaceOrientation(face) {
  face.sameSense = !face.sameSense;
  for (const loop of face.allLoops()) {
    loop.coedges.reverse();
    for (const ce of loop.coedges) ce.sameSense = !ce.sameSense;
  }
}

function _faceEdgeDirections(face) {
  const pts = _orientedFacePoints(face);
  const dirs = [];
  if (pts.length < 2) return dirs;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const ka = _pointKey(a);
    const kb = _pointKey(b);
    dirs.push({
      key: ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`,
      fwd: ka < kb,
    });
  }
  return dirs;
}

function _orientedFacePoints(face) {
  const pts = face.outerLoop ? face.outerLoop.points() : [];
  if (pts.length < 3) return pts;
  const polyNormal = _polygonNormal(pts);
  if (!polyNormal) return pts;
  const desired = _desiredFaceNormal(face);
  if (!desired) return pts;
  const dot = polyNormal.x * desired.x + polyNormal.y * desired.y + polyNormal.z * desired.z;
  return dot < 0 ? [...pts].reverse() : pts;
}

function _desiredFaceNormal(face) {
  if (!face.surface) return null;
  const normal = face.surface.normal(
    (face.surface.uMin + face.surface.uMax) / 2,
    (face.surface.vMin + face.surface.vMax) / 2,
  );
  if (!normal) return null;
  return face.sameSense === false
    ? { x: -normal.x, y: -normal.y, z: -normal.z }
    : normal;
}

function _approximateShellVolume(shell) {
  let volume = 0;
  for (const face of shell.faces || []) {
    for (const loop of face.allLoops()) {
      const verts = _orientedLoopPoints(face, loop);
      if (verts.length < 3) continue;
      for (let i = 1; i < verts.length - 1; i++) {
        volume += _signedTetraVolume(verts[0], verts[i], verts[i + 1]);
      }
    }
  }
  return volume;
}

function _orientedLoopPoints(face, loop) {
  const pts = loop?.points?.() || [];
  if (pts.length < 3) return pts;
  const polyNormal = _polygonNormal(pts);
  if (!polyNormal) return pts;
  const desired = _desiredFaceNormal(face);
  if (!desired) return pts;
  const dot = polyNormal.x * desired.x + polyNormal.y * desired.y + polyNormal.z * desired.z;
  return dot < 0 ? [...pts].reverse() : pts;
}
function _signedTetraVolume(a, b, c) {
  return (
    a.x * (b.y * c.z - b.z * c.y) -
    a.y * (b.x * c.z - b.z * c.x) +
    a.z * (b.x * c.y - b.y * c.x)
  ) / 6;
}

function _polygonNormal(points) {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const len = Math.hypot(nx, ny, nz);
  if (len <= 1e-10) return null;
  return { x: nx / len, y: ny / len, z: nz / len };
}

function _pointKey(p) {
  return `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`;
}

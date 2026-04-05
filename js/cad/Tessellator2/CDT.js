// js/cad/Tessellator2/CDT.js — Constrained Delaunay Triangulation
//
// Robust 2D triangulation supporting outer boundaries and holes via
// constraint edge insertion.  Used by FaceTriangulator for both planar
// and curved B-Rep faces.
//
// Algorithm:
//   1. Bowyer-Watson incremental Delaunay insertion
//   2. Constraint edge enforcement (edge flipping)
//   3. Flood-fill removal of exterior / hole triangles
//
// References:
//   - Bowyer (1981), Watson (1981) — incremental insertion
//   - Sloan (1993) — constraint edge insertion via flipping
//   - de Berg et al., "Computational Geometry" ch. 9

const EPSILON = 1e-10;

/**
 * Constrained Delaunay Triangulation of a 2D point set with boundary
 * constraints.
 *
 * @param {Array<{x:number,y:number}>} outerLoop - CCW outer boundary
 * @param {Array<Array<{x:number,y:number}>>} [holes=[]] - CW inner boundaries
 * @param {Array<{x:number,y:number}>} [steinerPoints=[]] - Optional interior points (no constraint edges)
 * @returns {Array<[number,number,number]>} Triangle index triples into outerLoop+holes+steiner concatenation
 */
export function constrainedTriangulate(outerLoop, holes = [], steinerPoints = []) {
  if (outerLoop.length < 3) return [];
  if (outerLoop.length === 3 && holes.length === 0 && steinerPoints.length === 0) return [[0, 1, 2]];

  // Flatten all points into a single array and track constraint edges
  const points = [];
  const constraintEdges = [];

  // Add outer loop points and constraint edges
  const outerStart = 0;
  for (let i = 0; i < outerLoop.length; i++) {
    points.push({ x: outerLoop[i].x, y: outerLoop[i].y });
  }
  for (let i = 0; i < outerLoop.length; i++) {
    constraintEdges.push([outerStart + i, outerStart + (i + 1) % outerLoop.length]);
  }

  // Add hole points and constraint edges
  for (const hole of holes) {
    if (hole.length < 3) continue;
    const holeStart = points.length;
    for (let i = 0; i < hole.length; i++) {
      points.push({ x: hole[i].x, y: hole[i].y });
    }
    for (let i = 0; i < hole.length; i++) {
      constraintEdges.push([holeStart + i, holeStart + (i + 1) % hole.length]);
    }
  }

  // Add Steiner (interior) points — no constraint edges for these
  for (const sp of steinerPoints) {
    points.push({ x: sp.x, y: sp.y });
  }

  const n = points.length;
  if (n < 3) return [];

  // --- Step 1: Create super-triangle encompassing all points ---
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;
  const dmax = Math.max(dx, dy);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  // Super-triangle vertices (indices n, n+1, n+2)
  const margin = 20;
  points.push(
    { x: midX - margin * dmax, y: midY - margin * dmax },
    { x: midX + margin * dmax, y: midY - margin * dmax },
    { x: midX, y: midY + margin * dmax },
  );

  // --- Step 2: Bowyer-Watson incremental insertion ---
  // Triangle: [i, j, k] with adjacency info
  // Using half-edge-free approach: store triangles as index triples + adjacency

  // Working triangle list — each entry: { v: [i,j,k], adj: [t_opposite_v0, t_opposite_v1, t_opposite_v2] }
  // adj[i] = index of triangle sharing edge opposite vertex i, or -1
  let triangles = [{ v: [n, n + 1, n + 2], adj: [-1, -1, -1] }];

  // Build a mapping for adjacency updates
  function _findAdjacentTriangle(triIdx, edgeA, edgeB) {
    // Find the triangle adjacent to triIdx across edge (edgeA, edgeB)
    for (let t = 0; t < triangles.length; t++) {
      if (t === triIdx || !triangles[t]) continue;
      const tv = triangles[t].v;
      let hasA = false, hasB = false;
      for (let k = 0; k < 3; k++) {
        if (tv[k] === edgeA) hasA = true;
        if (tv[k] === edgeB) hasB = true;
      }
      if (hasA && hasB) return t;
    }
    return -1;
  }

  function _inCircumcircle(px, py, ax, ay, bx, by, cx, cy) {
    const dxA = ax - px, dyA = ay - py;
    const dxB = bx - px, dyB = by - py;
    const dxC = cx - px, dyC = cy - py;
    return (dxA * (dyB * (dxC * dxC + dyC * dyC) - dyC * (dxB * dxB + dyB * dyB))
      - dyA * (dxB * (dxC * dxC + dyC * dyC) - dxC * (dxB * dxB + dyB * dyB))
      + (dxA * dxA + dyA * dyA) * (dxB * dyC - dxC * dyB)) > EPSILON;
  }

  function _orient2D(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  }

  // Insert each point using Bowyer-Watson
  for (let pi = 0; pi < n; pi++) {
    const px = points[pi].x, py = points[pi].y;

    // Find all triangles whose circumcircle contains the point
    const badTriangles = new Set();
    for (let t = 0; t < triangles.length; t++) {
      if (!triangles[t]) continue;
      const [a, b, c] = triangles[t].v;
      const pa = points[a], pb = points[b], pc = points[c];
      // Ensure CCW for circumcircle test
      const orient = _orient2D(pa.x, pa.y, pb.x, pb.y, pc.x, pc.y);
      if (orient > EPSILON) {
        if (_inCircumcircle(px, py, pa.x, pa.y, pb.x, pb.y, pc.x, pc.y)) {
          badTriangles.add(t);
        }
      } else if (orient < -EPSILON) {
        if (_inCircumcircle(px, py, pa.x, pa.y, pc.x, pc.y, pb.x, pb.y)) {
          badTriangles.add(t);
        }
      } else {
        // Degenerate triangle — remove it
        badTriangles.add(t);
      }
    }

    // Find boundary polygon of the hole left by removing bad triangles
    const boundary = []; // Array of [edgeA, edgeB]
    for (const t of badTriangles) {
      const [a, b, c] = triangles[t].v;
      const edges = [[a, b], [b, c], [c, a]];
      for (const [ea, eb] of edges) {
        // An edge is boundary if it's not shared with another bad triangle
        let shared = false;
        for (const t2 of badTriangles) {
          if (t2 === t) continue;
          const v2 = triangles[t2].v;
          let hasA = false, hasB = false;
          for (let k = 0; k < 3; k++) {
            if (v2[k] === ea) hasA = true;
            if (v2[k] === eb) hasB = true;
          }
          if (hasA && hasB) { shared = true; break; }
        }
        if (!shared) boundary.push([ea, eb]);
      }
    }

    // Remove bad triangles (null them out)
    for (const t of badTriangles) triangles[t] = null;

    // Create new triangles from each boundary edge to the inserted point
    for (const [ea, eb] of boundary) {
      triangles.push({ v: [ea, eb, pi], adj: [-1, -1, -1] });
    }
  }

  // Remove super-triangle vertices and any triangles referencing them
  const result = [];
  for (let t = 0; t < triangles.length; t++) {
    if (!triangles[t]) continue;
    const [a, b, c] = triangles[t].v;
    if (a >= n || b >= n || c >= n) continue;
    result.push([a, b, c]);
  }

  // --- Step 3: Enforce constraint edges ---
  // Build an edge→triangle lookup for efficient flipping
  const triList = result;
  _enforceConstraints(points, triList, constraintEdges);

  // --- Step 4: Remove exterior and hole triangles via flood fill ---
  const interior = _removeExteriorTriangles(points, triList, outerLoop.length, constraintEdges, holes);

  // --- Step 5: Recover unused boundary vertices ---
  // The Bowyer-Watson algorithm can fail to include nearly-collinear
  // boundary points (e.g. curve samples projected onto a planar face).
  // When a constraint vertex is missing from all triangles, find the
  // constraint edge it lies on and split the adjacent triangle.
  _recoverMissingBoundaryVertices(points, interior, outerLoop.length, holes);

  return interior;
}

/**
 * Enforce constraint edges by flipping crossing edges.
 * Uses the incremental edge-flipping approach from Sloan (1993).
 */
function _enforceConstraints(points, triList, constraintEdges) {
  // Build edge → triangle indices map
  function edgeKey(a, b) { return a < b ? `${a},${b}` : `${b},${a}`; }

  for (const [ca, cb] of constraintEdges) {
    // Check if the constraint edge already exists in the triangulation
    if (_edgeExists(triList, ca, cb)) continue;

    // Find and flip edges that cross this constraint
    // Simple approach: repeatedly find crossing edges and flip them
    let maxIter = triList.length * 4;
    while (!_edgeExists(triList, ca, cb) && maxIter-- > 0) {
      let flipped = false;
      for (let t = 0; t < triList.length; t++) {
        const tri = triList[t];
        if (!tri) continue;
        const [a, b, c] = tri;

        // Check each edge of this triangle for crossing with constraint
        const edges = [[a, b, c], [b, c, a], [c, a, b]];
        for (const [e0, e1, eOpp] of edges) {
          if (!_edgesCross(points, ca, cb, e0, e1)) continue;
          if (e0 === ca || e0 === cb || e1 === ca || e1 === cb) continue;

          // Find the adjacent triangle sharing edge (e0, e1)
          const adjIdx = _findAdjacentTri(triList, t, e0, e1);
          if (adjIdx === -1) continue;

          const adjTri = triList[adjIdx];
          if (!adjTri) continue;

          // Find the opposite vertex in the adjacent triangle
          const adjOpp = adjTri.find(v => v !== e0 && v !== e1);
          if (adjOpp === undefined) continue;

          // Flip: replace (e0,e1) with (eOpp, adjOpp)
          // Check that the flip produces valid (non-degenerate) triangles
          const o1 = _orient(points, eOpp, adjOpp, e0);
          const o2 = _orient(points, eOpp, adjOpp, e1);
          if (o1 * o2 >= 0) continue; // Flip would create degenerate/overlapping triangles

          triList[t] = [eOpp, adjOpp, e1];
          triList[adjIdx] = [eOpp, e0, adjOpp];
          flipped = true;
          break;
        }
        if (flipped) break;
      }
      if (!flipped) break;  // No more flips possible
    }
  }
}

function _edgeExists(triList, a, b) {
  for (const tri of triList) {
    if (!tri) continue;
    const ia = tri.indexOf(a);
    if (ia === -1) continue;
    if (tri[(ia + 1) % 3] === b || tri[(ia + 2) % 3] === b) return true;
  }
  return false;
}

function _findAdjacentTri(triList, excludeIdx, e0, e1) {
  for (let t = 0; t < triList.length; t++) {
    if (t === excludeIdx || !triList[t]) continue;
    const tri = triList[t];
    let has0 = false, has1 = false;
    for (let k = 0; k < 3; k++) {
      if (tri[k] === e0) has0 = true;
      if (tri[k] === e1) has1 = true;
    }
    if (has0 && has1) return t;
  }
  return -1;
}

function _orient(points, a, b, c) {
  const pa = points[a], pb = points[b], pc = points[c];
  return (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
}

function _edgesCross(points, a, b, c, d) {
  // Do segments (a,b) and (c,d) properly cross (not just touch)?
  const pa = points[a], pb = points[b], pc = points[c], pd = points[d];
  const d1 = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
  const d2 = (pb.x - pa.x) * (pd.y - pa.y) - (pb.y - pa.y) * (pd.x - pa.x);
  const d3 = (pd.x - pc.x) * (pa.y - pc.y) - (pd.y - pc.y) * (pa.x - pc.x);
  const d4 = (pd.x - pc.x) * (pb.y - pc.y) - (pd.y - pc.y) * (pb.x - pc.x);
  if (d1 * d2 < -EPSILON && d3 * d4 < -EPSILON) return true;
  return false;
}

/**
 * Remove triangles outside the outer boundary and inside holes.
 * Uses constraint-edge-aware flood fill from a known exterior seed.
 */
function _removeExteriorTriangles(points, triList, outerCount, constraintEdges, holes) {
  const n = triList.length;

  // Build adjacency: for each triangle, find its 3 neighbours
  function edgeKey(a, b) { return a < b ? `${a},${b}` : `${b},${a}`; }
  const edgeToTris = new Map();
  for (let t = 0; t < n; t++) {
    if (!triList[t]) continue;
    const [a, b, c] = triList[t];
    for (const [e0, e1] of [[a, b], [b, c], [c, a]]) {
      const key = edgeKey(e0, e1);
      if (!edgeToTris.has(key)) edgeToTris.set(key, []);
      edgeToTris.get(key).push(t);
    }
  }

  // Build the set of constraint edges for quick lookup
  const constraintSet = new Set();
  for (const [a, b] of constraintEdges) {
    constraintSet.add(edgeKey(a, b));
  }

  function getNeighbours(t) {
    const [a, b, c] = triList[t];
    const neighbours = [];
    for (const [e0, e1] of [[a, b], [b, c], [c, a]]) {
      const key = edgeKey(e0, e1);
      // Cannot flood across constraint edges
      if (constraintSet.has(key)) continue;
      const tris = edgeToTris.get(key);
      if (tris) {
        for (const t2 of tris) {
          if (t2 !== t && triList[t2]) neighbours.push(t2);
        }
      }
    }
    return neighbours;
  }

  // Determine which triangles are "inside" using centroid-in-polygon test.
  // Classify each connected region (separated by constraint edges).
  const visited = new Uint8Array(n);
  const keep = new Uint8Array(n);

  // Build outer polygon for point-in-polygon test
  const outerPoly = [];
  for (let i = 0; i < outerCount; i++) outerPoly.push(points[i]);

  const holePols = [];
  let holeOffset = outerCount;
  for (const hole of holes) {
    const pol = [];
    for (let i = 0; i < hole.length; i++) pol.push(points[holeOffset + i]);
    holePols.push(pol);
    holeOffset += hole.length;
  }

  function pointInPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  for (let t = 0; t < n; t++) {
    if (visited[t] || !triList[t]) continue;

    // BFS flood fill from this triangle across non-constraint edges
    const region = [t];
    const queue = [t];
    visited[t] = 1;
    while (queue.length > 0) {
      const curr = queue.shift();
      const neighbours = getNeighbours(curr);
      for (const nb of neighbours) {
        if (visited[nb]) continue;
        visited[nb] = 1;
        region.push(nb);
        queue.push(nb);
      }
    }

    // Test region membership: use the centroid of the first triangle
    const [a, b, c] = triList[region[0]];
    const cx = (points[a].x + points[b].x + points[c].x) / 3;
    const cy = (points[a].y + points[b].y + points[c].y) / 3;

    // Must be inside outer polygon and outside all holes
    let inside = pointInPolygon(cx, cy, outerPoly);
    if (inside) {
      for (const holePol of holePols) {
        if (pointInPolygon(cx, cy, holePol)) { inside = false; break; }
      }
    }

    if (inside) {
      for (const ti of region) keep[ti] = 1;
    }
  }

  // Collect kept triangles
  const output = [];
  for (let t = 0; t < n; t++) {
    if (keep[t] && triList[t]) {
      output.push(triList[t]);
    }
  }

  return output;
}

/**
 * Recover boundary vertices that are missing from the triangulation.
 *
 * After Bowyer-Watson + constraint enforcement + exterior removal, some
 * nearly-collinear boundary points may not appear in any triangle.  This
 * happens when the circumcircle test creates degenerate slivers that get
 * collapsed.
 *
 * Strategy: for each missing boundary vertex, locate the triangle
 * containing it (or closest to it) and split that triangle to include the
 * missing point.  Then enforce the constraint edges through the new
 * point.
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {Array<[number,number,number]>} triList - Mutable triangle list
 * @param {number} outerCount - Number of outer loop points
 * @param {Array<Array<{x:number,y:number}>>} holes
 */
function _recoverMissingBoundaryVertices(points, triList, outerCount, holes) {
  // Collect all boundary vertex indices
  const boundaryIndices = [];
  for (let i = 0; i < outerCount; i++) boundaryIndices.push(i);
  let offset = outerCount;
  for (const hole of holes) {
    for (let i = 0; i < hole.length; i++) boundaryIndices.push(offset + i);
    offset += hole.length;
  }

  // Find which boundary vertices are used in at least one triangle
  const usedSet = new Set();
  for (const tri of triList) {
    if (!tri) continue;
    usedSet.add(tri[0]);
    usedSet.add(tri[1]);
    usedSet.add(tri[2]);
  }

  // Collect missing boundary vertices
  const missing = [];
  for (const idx of boundaryIndices) {
    if (!usedSet.has(idx)) missing.push(idx);
  }
  if (missing.length === 0) return;

  // Insert each missing vertex into the triangulation by splitting
  // the triangle it falls on (or the nearest triangle edge).
  for (const midx of missing) {
    const px = points[midx].x;
    const py = points[midx].y;

    // Find triangle containing point or closest triangle edge
    let bestTri = -1;
    let bestType = ''; // 'inside', 'edge', 'nearest'
    let bestEdge = null; // [v0, v1] for edge insertion
    let bestDist = Infinity;

    for (let t = 0; t < triList.length; t++) {
      const tri = triList[t];
      if (!tri) continue;
      const [a, b, c] = tri;
      const pa = points[a], pb = points[b], pc = points[c];

      // Barycentric coordinates
      const v0x = pc.x - pa.x, v0y = pc.y - pa.y;
      const v1x = pb.x - pa.x, v1y = pb.y - pa.y;
      const v2x = px - pa.x, v2y = py - pa.y;
      const dot00 = v0x * v0x + v0y * v0y;
      const dot01 = v0x * v1x + v0y * v1y;
      const dot02 = v0x * v2x + v0y * v2y;
      const dot11 = v1x * v1x + v1y * v1y;
      const dot12 = v1x * v2x + v1y * v2y;
      const invDenom = dot00 * dot11 - dot01 * dot01;

      if (Math.abs(invDenom) < 1e-20) {
        // Degenerate triangle — check distance to edges
        for (const [e0, e1] of [[a, b], [b, c], [c, a]]) {
          const d = _pointToSegmentDist2D(points, midx, e0, e1);
          if (d < bestDist) { bestDist = d; bestTri = t; bestType = 'edge'; bestEdge = [e0, e1]; }
        }
        continue;
      }

      const u = (dot11 * dot02 - dot01 * dot12) / invDenom;
      const v = (dot00 * dot12 - dot01 * dot02) / invDenom;

      if (u >= -EPSILON && v >= -EPSILON && u + v <= 1 + EPSILON) {
        // Point is inside or on the boundary of this triangle
        bestTri = t;
        bestType = 'inside';
        bestDist = 0;
        bestEdge = null;

        // Check if point is on an edge (one barycentric coord ≈ 0)
        const w = 1 - u - v;
        const edgeTol = 1e-6;
        if (w < edgeTol) { bestType = 'edge'; bestEdge = [b, c]; }
        else if (v < edgeTol) { bestType = 'edge'; bestEdge = [a, c]; }
        else if (u < edgeTol) { bestType = 'edge'; bestEdge = [a, b]; }
        break;
      }

      // Point is outside — compute distance to nearest edge
      for (const [e0, e1] of [[a, b], [b, c], [c, a]]) {
        const d = _pointToSegmentDist2D(points, midx, e0, e1);
        if (d < bestDist) { bestDist = d; bestTri = t; bestType = 'edge'; bestEdge = [e0, e1]; }
      }
    }

    if (bestTri === -1) continue;

    if (bestType === 'inside') {
      // Split triangle into 3 sub-triangles
      const [a, b, c] = triList[bestTri];
      triList[bestTri] = [a, b, midx];
      triList.push([b, c, midx]);
      triList.push([c, a, midx]);
    } else if (bestType === 'edge' && bestEdge) {
      // Split edge: find both triangles sharing this edge and split them
      const [e0, e1] = bestEdge;
      const edgeKey = e0 < e1 ? `${e0},${e1}` : `${e1},${e0}`;
      const sharers = [];
      for (let t = 0; t < triList.length; t++) {
        const tri = triList[t];
        if (!tri) continue;
        const has0 = tri.indexOf(e0) !== -1;
        const has1 = tri.indexOf(e1) !== -1;
        if (has0 && has1) sharers.push(t);
      }

      for (const t of sharers) {
        const tri = triList[t];
        if (!tri) continue;
        const opp = tri.find(v => v !== e0 && v !== e1);
        if (opp === undefined) continue;
        // Replace this triangle with two: (opp, e0, midx) and (opp, midx, e1)
        triList[t] = [opp, e0, midx];
        triList.push([opp, midx, e1]);
      }
    }

    usedSet.add(midx);
  }

  // Compact: remove null entries
  let write = 0;
  for (let read = 0; read < triList.length; read++) {
    if (triList[read]) {
      triList[write++] = triList[read];
    }
  }
  triList.length = write;
}

/**
 * Distance from point at index `pidx` to segment (a, b) in 2D.
 */
function _pointToSegmentDist2D(points, pidx, a, b) {
  const px = points[pidx].x, py = points[pidx].y;
  const ax = points[a].x, ay = points[a].y;
  const bx = points[b].x, by = points[b].y;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-20) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * dx, projY = ay + t * dy;
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

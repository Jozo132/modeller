// @ts-check
/**
 * @module toolkit/EdgePathUtils
 *
 * Graph-based edge chaining: groups connected edges into open/closed
 * paths. Extracted from CSG.js for reuse.
 */

/**
 * Chain a set of edges into connected paths.
 *
 * Each edge is `{start, end}` with 3D vertex positions.  The algorithm
 * builds vertex adjacency, then walks from each unvisited edge forward
 * and backward collecting chains.  Paths that loop back to the start
 * are marked `isClosed`.
 *
 * @param {Array<{start:{x:number,y:number,z:number}, end:{x:number,y:number,z:number}}>} edges
 * @returns {Array<{edgeIndices: number[], isClosed: boolean}>}
 */
export function chainEdgePaths(edges) {
  if (edges.length === 0) return [];

  const vKey = (v) => `${Math.round(v.x * 1e5)},${Math.round(v.y * 1e5)},${Math.round(v.z * 1e5)}`;

  // Build vertex → [edge index] adjacency
  const vertexEdges = new Map();
  const addVE = (v, idx) => {
    const k = vKey(v);
    if (!vertexEdges.has(k)) vertexEdges.set(k, []);
    vertexEdges.get(k).push(idx);
  };
  for (let i = 0; i < edges.length; i++) {
    addVE(edges[i].start, i);
    addVE(edges[i].end, i);
  }

  const visited = new Set();
  const paths = [];

  for (let seed = 0; seed < edges.length; seed++) {
    if (visited.has(seed)) continue;

    // Walk backward from seed to find the start of the chain
    let startEdge = seed;
    let startVert = vKey(edges[seed].start);
    {
      let cur = seed;
      let prevVert = vKey(edges[seed].end);
      let curVert = vKey(edges[seed].start);
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const neighbors = vertexEdges.get(curVert) || [];
        if (neighbors.length !== 2) break;
        const next = neighbors[0] === cur ? neighbors[1] : neighbors[0];
        if (next === seed) break;
        const ne = edges[next];
        const nextVert = vKey(ne.start) === curVert ? vKey(ne.end) : vKey(ne.start);
        if (nextVert === prevVert) break;
        prevVert = curVert;
        curVert = nextVert;
        cur = next;
      }
      startEdge = cur;
      startVert = curVert;
    }

    // Walk forward from startEdge/startVert collecting the chain
    const chain = [startEdge];
    visited.add(startEdge);
    const se = edges[startEdge];
    let walkVert = vKey(se.start) === startVert ? vKey(se.end) : vKey(se.start);

    let isClosed = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const neighbors = vertexEdges.get(walkVert) || [];
      if (neighbors.length !== 2) break;
      const next = neighbors[0] === chain[chain.length - 1] ? neighbors[1] : neighbors[0];
      if (visited.has(next)) {
        isClosed = true;
        break;
      }
      chain.push(next);
      visited.add(next);
      const ne = edges[next];
      walkVert = vKey(ne.start) === walkVert ? vKey(ne.end) : vKey(ne.start);
    }

    paths.push({ edgeIndices: chain, isClosed });
  }

  return paths;
}

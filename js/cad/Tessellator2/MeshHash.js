// js/cad/Tessellator2/MeshHash.js — Deterministic mesh hashing
//
// Produces a stable hash string for a tessellated mesh result.
// Used for regression testing: identical model + config must produce
// identical hashes across runs.

/**
 * Format a number to fixed precision for hashing.
 * Avoids -0 by adding 0.
 *
 * @param {number} n
 * @param {number} [decimals=8]
 * @returns {string}
 */
function fmt(n, decimals = 8) {
  return (+(+n).toFixed(decimals) || 0).toFixed(decimals);
}

/**
 * Compute a deterministic hash for a mesh.
 *
 * The hash is computed from:
 * 1. Number of vertices
 * 2. Number of faces
 * 3. All vertex positions (sorted by vertex key for determinism)
 * 4. All face vertex positions in order
 *
 * @param {{
 *   vertices: Array<{x:number,y:number,z:number}>,
 *   faces: Array<{vertices: Array<{x:number,y:number,z:number}>, normal?: {x:number,y:number,z:number}}>
 * }} mesh
 * @param {number} [precision=8] - Decimal precision for coordinate formatting
 * @returns {string} Hex hash string
 */
export function computeMeshHash(mesh, precision = 8) {
  const parts = [];

  // Header: counts
  parts.push(`V${mesh.vertices.length}F${mesh.faces.length}`);

  // Vertices sorted by canonical key for order independence
  const sortedVerts = [...mesh.vertices].sort((a, b) => {
    const ka = `${fmt(a.x, precision)},${fmt(a.y, precision)},${fmt(a.z, precision)}`;
    const kb = `${fmt(b.x, precision)},${fmt(b.y, precision)},${fmt(b.z, precision)}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  for (const v of sortedVerts) {
    parts.push(`${fmt(v.x, precision)},${fmt(v.y, precision)},${fmt(v.z, precision)}`);
  }

  // Faces: vertex positions in face order
  for (const f of mesh.faces) {
    const fp = f.vertices.map(v =>
      `${fmt(v.x, precision)},${fmt(v.y, precision)},${fmt(v.z, precision)}`
    ).join(';');
    parts.push(fp);
  }

  // Simple FNV-1a 32-bit hash of the concatenated string
  const str = parts.join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert to unsigned 32-bit hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Quick summary of mesh topology for diagnostics.
 *
 * @param {{
 *   vertices: Array<{x:number,y:number,z:number}>,
 *   faces: Array<{vertices: Array<{x:number,y:number,z:number}>}>
 * }} mesh
 * @returns {{ vertexCount: number, faceCount: number, triangleCount: number }}
 */
export function meshSummary(mesh) {
  let triangleCount = 0;
  for (const f of mesh.faces) {
    if (f.vertices.length === 3) triangleCount++;
  }
  return {
    vertexCount: mesh.vertices.length,
    faceCount: mesh.faces.length,
    triangleCount,
  };
}

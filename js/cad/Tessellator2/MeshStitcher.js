// js/cad/Tessellator2/MeshStitcher.js — Stitch per-face meshes into a watertight body mesh
//
// Merges per-face tessellation results into a single mesh structure,
// ensuring that shared edge vertices are not duplicated and boundaries
// are consistent across adjacent faces.

/**
 * Vertex key for deduplication. Uses fixed precision to merge
 * nearly-coincident vertices.
 *
 * @param {{x:number,y:number,z:number}} v
 * @param {number} [precision=10]
 * @returns {string}
 */
function vertexKey(v, precision = 10) {
  const fmt = c => (+c.toFixed(precision) || 0).toFixed(precision);
  return `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`;
}

/**
 * MeshStitcher — combines per-face mesh results into a single body mesh.
 *
 * Deduplicates vertices at shared edges so the final mesh is watertight
 * when all faces share boundary vertices produced by EdgeSampler.
 */
export class MeshStitcher {
  /**
   * Stitch multiple face meshes into a single body mesh.
   *
   * @param {Array<{
   *   vertices: Array<{x:number,y:number,z:number}>,
   *   faces: Array<{vertices: Array<{x:number,y:number,z:number}>, normal: {x:number,y:number,z:number}}>,
   *   shared?: Object
   * }>} faceMeshes
   * @returns {{
   *   vertices: Array<{x:number,y:number,z:number}>,
   *   faces: Array<{vertices: Array<{x:number,y:number,z:number}>, normal: {x:number,y:number,z:number}, shared: Object|null}>,
   *   edges: Array
   * }}
   */
  stitch(faceMeshes) {
    const allVertices = [];
    const allFaces = [];
    const vertexMap = new Map();

    /**
     * Deduplicate a vertex: return the canonical vertex object.
     * @param {{x:number,y:number,z:number}} v
     * @returns {{x:number,y:number,z:number}}
     */
    function dedup(v) {
      const key = vertexKey(v);
      if (vertexMap.has(key)) return vertexMap.get(key);
      const canonical = { x: v.x, y: v.y, z: v.z };
      vertexMap.set(key, canonical);
      allVertices.push(canonical);
      return canonical;
    }

    for (const fm of faceMeshes) {
      const shared = fm.shared || null;
      const topoFaceId = fm.topoFaceId;
      const faceType = fm.faceType;
      for (const face of fm.faces) {
        const dedupedVerts = face.vertices.map(v => dedup(v));
        const out = {
          vertices: dedupedVerts,
          normal: face.normal ? { ...face.normal } : { x: 0, y: 0, z: 1 },
          shared,
        };
        if (topoFaceId !== undefined) out.topoFaceId = topoFaceId;
        if (faceType) out.faceType = faceType;
        allFaces.push(out);
      }
    }

    return {
      vertices: allVertices,
      faces: allFaces,
      edges: [],
    };
  }
}

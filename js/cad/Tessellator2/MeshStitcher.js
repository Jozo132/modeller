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

function triangleNormal(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3) return null;
  const a = vertices[0];
  const b = vertices[1];
  const c = vertices[2];
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-14) return null;
  return { x: nx / len, y: ny / len, z: nz / len };
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
      const fusedGroupId = fm.fusedGroupId || null;
      const faceType = fm.faceType;
      const isFillet = !!fm.isFillet;
      const isCorner = !!fm.isCorner;
      const tessellationFaceKey = fm.tessellationFaceKey || null;
      for (const face of fm.faces) {
        const dedupedVerts = face.vertices.map(v => dedup(v));
        const geometricNormal = triangleNormal(dedupedVerts);
        let normal = face.normal ? { ...face.normal } : geometricNormal;
        if (geometricNormal && normal) {
          const dot = normal.x * geometricNormal.x + normal.y * geometricNormal.y + normal.z * geometricNormal.z;
          if (dot < 0.2) normal = geometricNormal;
        }
        const out = {
          vertices: dedupedVerts,
          normal: normal || { x: 0, y: 0, z: 1 },
          shared,
        };
        if (Array.isArray(face.vertexNormals) && face.vertexNormals.length === face.vertices.length) {
          out.vertexNormals = face.vertexNormals.map((normal) => ({ ...normal }));
        }
        if (topoFaceId !== undefined) {
          out.topoFaceId = topoFaceId;
          out.faceGroup = topoFaceId;
        }
        if (tessellationFaceKey) {
          out.tessellationFaceKey = tessellationFaceKey;
        }
        if (fusedGroupId) {
          out.fusedGroupId = fusedGroupId;
        }
        if (faceType) {
          out.faceType = faceType;
          out.isCurved = faceType !== 'planar';
        }
        if (isFillet) out.isFillet = true;
        if (isCorner) {
          out.isCorner = true;
          out.isFillet = true;
        }
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

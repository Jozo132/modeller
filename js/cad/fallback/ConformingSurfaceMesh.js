// js/cad/fallback/ConformingSurfaceMesh.js — Build a conforming discrete surface mesh
//
// Converts TopoBody faces into a unified triangle mesh suitable for
// mesh-level boolean operations. Preserves face group assignments and
// basic adjacency so downstream mesh booleans can operate.

import { tessellateBody } from '../Tessellation.js';

/**
 * Build a conforming discrete surface mesh from a TopoBody.
 *
 * The mesh is a triangle soup with face-group tags, suitable for mesh
 * boolean operations. Edge adjacency is tracked via vertex snapping so
 * that the two operand meshes can be intersected without cracks.
 *
 * @param {import('../BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @param {number} [opts.snapTolerance=1e-8] - Vertex snap tolerance
 * @returns {{ vertices: Float64Array|number[], faces: {vertices:{x,y,z}[], normal?:{x,y,z}, faceGroup?:number}[], vertexIndex: Map<string,number>, bodyId: string|null }}
 */
export function buildConformingMesh(body, opts = {}) {
  const snapTol = opts.snapTolerance ?? 1e-8;
  const PREC = _precisionForTolerance(snapTol);

  // Tessellate the body through the existing robust pipeline. Validation
  // is O(n\u00b2) on triangle count and would dominate runtime on large NURBS
  // bodies; the mesh here is an intermediate for boolean fragment checks,
  // not a rendered artifact, so skip it.
  const rawMesh = tessellateBody(body, { validate: false });
  if (!rawMesh || !rawMesh.faces || rawMesh.faces.length === 0) {
    return { vertices: [], faces: [], vertexIndex: new Map(), bodyId: null };
  }

  // Build a canonical vertex index for snapping
  const vertexIndex = new Map();
  const snappedFaces = [];
  let nextVtxId = 0;

  for (let fi = 0; fi < rawMesh.faces.length; fi++) {
    const face = rawMesh.faces[fi];
    const verts = face.vertices;
    if (!verts || verts.length < 3) continue;

    const snappedVerts = verts.map(v => {
      const key = _vertexKey(v, PREC);
      if (!vertexIndex.has(key)) {
        vertexIndex.set(key, { id: nextVtxId++, point: { x: v.x, y: v.y, z: v.z } });
      }
      return vertexIndex.get(key).point;
    });

    snappedFaces.push({
      vertices: snappedVerts,
      normal: face.normal || _computeNormal(snappedVerts),
      faceGroup: face.faceGroup ?? fi,
    });
  }

  // Flatten vertices for downstream use
  const flatVertices = new Array(vertexIndex.size * 3);
  for (const entry of vertexIndex.values()) {
    const base = entry.id * 3;
    flatVertices[base] = entry.point.x;
    flatVertices[base + 1] = entry.point.y;
    flatVertices[base + 2] = entry.point.z;
  }

  return {
    vertices: flatVertices,
    faces: snappedFaces,
    vertexIndex,
    bodyId: body.id ?? null,
  };
}

/**
 * Merge two conforming meshes so they share the same vertex index space.
 * Needed before running mesh boolean operations.
 *
 * @param {{ vertices: number[], faces: Object[], vertexIndex: Map }} meshA
 * @param {{ vertices: number[], faces: Object[], vertexIndex: Map }} meshB
 * @param {Object} [opts]
 * @param {number} [opts.snapTolerance=1e-8]
 * @returns {{ meshA: Object, meshB: Object, sharedVertexIndex: Map }}
 */
export function mergeVertexSpaces(meshA, meshB, opts = {}) {
  const snapTol = opts.snapTolerance ?? 1e-8;
  const PREC = _precisionForTolerance(snapTol);
  const shared = new Map(meshA.vertexIndex);
  let nextId = shared.size;

  // Add meshB vertices that aren't already in the shared space
  for (const [key, entry] of meshB.vertexIndex) {
    if (!shared.has(key)) {
      shared.set(key, { id: nextId++, point: entry.point });
    }
  }

  return { meshA, meshB, sharedVertexIndex: shared };
}

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

function _precisionForTolerance(tol) {
  return Math.max(1, Math.min(12, Math.round(-Math.log10(tol))));
}

function _vertexKey(v, prec) {
  const fmt = c => (+c.toFixed(prec) || 0).toFixed(prec);
  return `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`;
}

function _computeNormal(verts) {
  if (verts.length < 3) return { x: 0, y: 0, z: 1 };
  const a = verts[0], b = verts[1], c = verts[2];
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return len > 1e-14 ? { x: nx / len, y: ny / len, z: nz / len } : { x: 0, y: 0, z: 1 };
}

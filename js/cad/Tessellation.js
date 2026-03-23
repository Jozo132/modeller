// js/cad/Tessellation.js — Mesh generation from exact B-Rep topology
//
// Generates renderable triangle/quad meshes from exact B-Rep data.
// Supports tolerance-controlled tessellation for both display and STL export.

import { DEFAULT_TOLERANCE } from './Tolerance.js';

/**
 * Tessellate a TopoBody into a mesh geometry object compatible with the
 * existing rendering pipeline.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @param {number} [opts.chordalDeviation=0.01] - Max chordal deviation for curved surfaces
 * @param {number} [opts.angularTolerance=15] - Max angle (degrees) between adjacent normals
 * @param {number} [opts.surfaceSegments=8] - Default segments for NURBS surface tessellation
 * @param {number} [opts.edgeSegments=16] - Default segments for NURBS edge tessellation
 * @returns {{ vertices: Array<{x,y,z}>, faces: Array<{vertices: Array<{x,y,z}>, normal: {x,y,z}, shared: Object}>, edges: Array }}
 */
export function tessellateBody(body, opts = {}) {
  const surfSegs = opts.surfaceSegments ?? 8;
  const edgeSegs = opts.edgeSegments ?? 16;

  const vertices = [];
  const faces = [];
  const edges = [];

  if (!body || !body.shells) return { vertices, faces, edges };

  for (const shell of body.shells) {
    for (const face of shell.faces) {
      const faceMesh = tessellateFace(face, surfSegs);
      for (const f of faceMesh.faces) {
        f.shared = face.shared || null;
        faces.push(f);
      }
      vertices.push(...faceMesh.vertices);
    }

    // Tessellate edges
    for (const edge of shell.edges()) {
      const pts = edge.tessellate(edgeSegs);
      if (pts.length >= 2) {
        edges.push({
          start: { ...pts[0] },
          end: { ...pts[pts.length - 1] },
          points: pts,
        });
      }
    }
  }

  return { vertices, faces, edges };
}

/**
 * Tessellate a single TopoFace.
 *
 * If the face has a NURBS surface, tessellates from the surface.
 * Otherwise, creates a polygon fan from the outer loop vertices.
 *
 * @param {import('./BRepTopology.js').TopoFace} face
 * @param {number} [segments=8]
 * @returns {{ vertices: Array<{x,y,z}>, faces: Array<{vertices: Array<{x,y,z}>, normal: {x,y,z}}> }}
 */
export function tessellateFace(face, segments = 8) {
  // If we have a NURBS surface, use it
  if (face.surface) {
    const tess = face.surface.tessellate(segments, segments);
    // If face is reversed, flip normals and winding
    if (!face.sameSense) {
      for (const f of tess.faces) {
        f.vertices.reverse();
        f.normal = { x: -f.normal.x, y: -f.normal.y, z: -f.normal.z };
      }
    }
    return tess;
  }

  // Fallback: tessellate from loop vertices as a polygon
  if (!face.outerLoop) return { vertices: [], faces: [] };

  const pts = face.outerLoop.points();
  if (pts.length < 3) return { vertices: [], faces: [] };

  // Calculate face normal from first 3 vertices
  const normal = calculateNormal(pts[0], pts[1], pts[2]);

  // Fan triangulation for convex-ish polygons
  const meshFaces = [];
  for (let i = 1; i < pts.length - 1; i++) {
    meshFaces.push({
      vertices: [
        { ...pts[0] },
        { ...pts[i] },
        { ...pts[i + 1] },
      ],
      normal: { ...normal },
    });
  }

  return { vertices: pts.map(p => ({ ...p })), faces: meshFaces };
}

/**
 * Tessellate a TopoBody for STL export with controlled tolerance.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @param {number} [opts.chordalDeviation=0.01] - Max chord deviation
 * @param {number} [opts.angularTolerance=15] - Max angle deviation (degrees)
 * @returns {Array<{vertices: [{x,y,z},{x,y,z},{x,y,z}], normal: {x,y,z}}>} Triangle array
 */
export function tessellateForSTL(body, opts = {}) {
  const chordalDev = opts.chordalDeviation ?? 0.01;
  const angularTol = opts.angularTolerance ?? 15;

  // Determine segment count based on tolerance
  // Higher precision → more segments
  const segments = Math.max(4, Math.min(64, Math.ceil(1.0 / chordalDev)));

  const mesh = tessellateBody(body, { surfaceSegments: segments });

  // Convert to triangles
  const triangles = [];
  for (const f of mesh.faces) {
    const verts = f.vertices;
    if (verts.length === 3) {
      triangles.push({
        vertices: [{ ...verts[0] }, { ...verts[1] }, { ...verts[2] }],
        normal: f.normal ? { ...f.normal } : calculateNormal(verts[0], verts[1], verts[2]),
      });
    } else if (verts.length === 4) {
      // Split quad into 2 triangles
      triangles.push({
        vertices: [{ ...verts[0] }, { ...verts[1] }, { ...verts[2] }],
        normal: f.normal ? { ...f.normal } : calculateNormal(verts[0], verts[1], verts[2]),
      });
      triangles.push({
        vertices: [{ ...verts[0] }, { ...verts[2] }, { ...verts[3] }],
        normal: f.normal ? { ...f.normal } : calculateNormal(verts[0], verts[2], verts[3]),
      });
    } else if (verts.length > 4) {
      // Fan triangulation
      for (let i = 1; i < verts.length - 1; i++) {
        triangles.push({
          vertices: [{ ...verts[0] }, { ...verts[i] }, { ...verts[i + 1] }],
          normal: f.normal ? { ...f.normal } : calculateNormal(verts[0], verts[i], verts[i + 1]),
        });
      }
    }
  }

  return triangles;
}

/**
 * Calculate normal from three points.
 * @param {{x,y,z}} p0
 * @param {{x,y,z}} p1
 * @param {{x,y,z}} p2
 * @returns {{x:number,y:number,z:number}}
 */
function calculateNormal(p0, p1, p2) {
  const v1x = p1.x - p0.x, v1y = p1.y - p0.y, v1z = p1.z - p0.z;
  const v2x = p2.x - p0.x, v2y = p2.y - p0.y, v2z = p2.z - p0.z;
  const nx = v1y * v2z - v1z * v2y;
  const ny = v1z * v2x - v1x * v2z;
  const nz = v1x * v2y - v1y * v2x;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-14) return { x: 0, y: 0, z: 1 };
  return { x: nx / len, y: ny / len, z: nz / len };
}

// js/cad/Tessellation.js — Mesh generation from exact B-Rep topology
//
// Generates renderable triangle/quad meshes from exact B-Rep data.
// Supports tolerance-controlled tessellation for both display and STL export.
//
// The default tessellation path now uses the robust Tessellator2 pipeline
// when CAD_USE_ROBUST_TESSELLATOR is enabled (the new default).  The legacy
// ear-clipping path is retained as _legacyTessellateBody() for fallback and
// backward compatibility but should not be used directly by new code.

import { robustTessellateBody } from './Tessellator2/index.js';

function projectPolygon2D(verts, normal) {
  const an = {
    x: Math.abs(normal?.x || 0),
    y: Math.abs(normal?.y || 0),
    z: Math.abs(normal?.z || 0),
  };
  if (an.z >= an.x && an.z >= an.y) {
    return verts.map((v) => ({ x: v.x, y: v.y }));
  }
  if (an.y >= an.x) {
    return verts.map((v) => ({ x: v.x, y: v.z }));
  }
  return verts.map((v) => ({ x: v.y, y: v.z }));
}

function triangulatePolygonIndices(verts, normal) {
  if (!verts || verts.length < 3) return [];
  if (verts.length === 3) return [[0, 1, 2]];

  const pts2d = projectPolygon2D(verts, normal);
  let signedArea = 0;
  for (let i = 0; i < pts2d.length; i++) {
    const a = pts2d[i];
    const b = pts2d[(i + 1) % pts2d.length];
    signedArea += a.x * b.y - b.x * a.y;
  }
  const winding = signedArea >= 0 ? 1 : -1;

  function cross2(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function pointInTri(p, a, b, c) {
    const c1 = cross2(a, b, p) * winding;
    const c2 = cross2(b, c, p) * winding;
    const c3 = cross2(c, a, p) * winding;
    return c1 >= -1e-8 && c2 >= -1e-8 && c3 >= -1e-8;
  }

  const remaining = verts.map((_, i) => i);
  const triangles = [];
  let guard = 0;
  const maxGuard = verts.length * verts.length;

  while (remaining.length > 3 && guard < maxGuard) {
    let earFound = false;
    for (let ri = 0; ri < remaining.length; ri++) {
      const prev = remaining[(ri - 1 + remaining.length) % remaining.length];
      const curr = remaining[ri];
      const next = remaining[(ri + 1) % remaining.length];
      const a = pts2d[prev];
      const b = pts2d[curr];
      const c = pts2d[next];
      if (cross2(a, b, c) * winding <= 1e-8) continue;

      let containsPoint = false;
      for (const other of remaining) {
        if (other === prev || other === curr || other === next) continue;
        if (pointInTri(pts2d[other], a, b, c)) {
          containsPoint = true;
          break;
        }
      }
      if (containsPoint) continue;

      triangles.push([prev, curr, next]);
      remaining.splice(ri, 1);
      earFound = true;
      break;
    }

    if (!earFound) break;
    guard++;
  }

  if (remaining.length === 3) {
    triangles.push([remaining[0], remaining[1], remaining[2]]);
  }

  if (triangles.length !== Math.max(0, verts.length - 2)) {
    const fan = [];
    for (let i = 1; i < verts.length - 1; i++) fan.push([0, i, i + 1]);
    return fan;
  }
  return triangles;
}

/**
 * Tessellate a TopoBody into a mesh geometry object compatible with the
 * existing rendering pipeline.
 *
 * When CAD_USE_ROBUST_TESSELLATOR is enabled (the default), this delegates
 * to the robust Tessellator2 pipeline.  If the robust path fails or
 * produces an empty mesh, the legacy ear-clipping path is used as a
 * fallback and the result is tagged with `_tessellator = 'legacy-fallback'`.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @param {number} [opts.chordalDeviation=0.01] - Max chordal deviation for curved surfaces
 * @param {number} [opts.angularTolerance=15] - Max angle (degrees) between adjacent normals
 * @param {number} [opts.surfaceSegments=16] - Default segments for NURBS surface tessellation
 * @param {number} [opts.edgeSegments=64] - Default segments for NURBS edge tessellation
 * @returns {{ vertices: Array<{x,y,z}>, faces: Array<{vertices: Array<{x,y,z}>, normal: {x,y,z}, shared: Object}>, edges: Array }}
 */
export function tessellateBody(body, opts = {}) {
  // BRep-only pipeline: always use the robust Tessellator2 pipeline.
  // Legacy ear-clipping fallback has been removed.
  const result = robustTessellateBody(body, { ...opts, validate: true });
  if (result.faces.length > 0) {
    result._tessellator = 'robust';
    return result;
  }
  throw new Error(
    '[BRep-only] tessellateBody: robust tessellator produced an empty mesh. ' +
    'Legacy ear-clipping fallback is no longer available. ' +
    'Fix the TopoBody input or the Tessellator2 pipeline.'
  );
}

/**
 * Quick check for inverted face normals in a tessellated mesh.
 * Returns true if more than 10% of faces have normals that disagree
 * with the winding order of their vertices (cross-product test).
 *
 * @param {Array<{vertices: Array<{x,y,z}>, normal?: {x,y,z}}>} faces
 * @returns {boolean}
 */
function _hasInvertedNormals(faces) {
  if (faces.length === 0) return false;
  let checked = 0;
  let inverted = 0;
  for (const f of faces) {
    const v = f.vertices;
    const n = f.normal;
    if (!n || !v || v.length < 3) continue;
    checked++;
    const ux = v[1].x - v[0].x, uy = v[1].y - v[0].y, uz = v[1].z - v[0].z;
    const wx = v[2].x - v[0].x, wy = v[2].y - v[0].y, wz = v[2].z - v[0].z;
    const cx = uy * wz - uz * wy;
    const cy = uz * wx - ux * wz;
    const cz = ux * wy - uy * wx;
    if (cx * n.x + cy * n.y + cz * n.z < 0) inverted++;
  }
  return checked > 0 && inverted / checked > 0.1;
}

/**
 * Legacy ear-clipping tessellation path.
 *
 * @deprecated Prefer the robust Tessellator2 pipeline via tessellateBody()
 *             with CAD_USE_ROBUST_TESSELLATOR enabled (now the default).
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @returns {{ vertices: Array, faces: Array, edges: Array }}
 */
export function _legacyTessellateBody(body, opts = {}) {
  const surfSegs = opts.surfaceSegments ?? 16;
  const edgeSegs = opts.edgeSegments ?? 64;

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
  // Planar faces should tessellate from their trim loops, not from the full
  // support surface patch. Otherwise boolean-trimmed planar faces render as
  // their original untrimmed rectangles.
  if (face.surface && face.surfaceType !== 'plane') {
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

  // If we have a NURBS surface, use it
  // Fallback: tessellate from loop vertices as a polygon
  if (!face.outerLoop) return { vertices: [], faces: [] };

  const pts = face.outerLoop.points();
  if (pts.length < 3) return { vertices: [], faces: [] };

  // Calculate face normal from first 3 vertices
  let orderedPts = pts;
  let normal = calculateNormal(orderedPts[0], orderedPts[1], orderedPts[2]);
  if (face.surface) {
    const surfNormal = face.surface.normal(
      (face.surface.uMin + face.surface.uMax) / 2,
      (face.surface.vMin + face.surface.vMax) / 2,
    );
    const desired = face.sameSense
      ? surfNormal
      : { x: -surfNormal.x, y: -surfNormal.y, z: -surfNormal.z };
    const dot = normal.x * desired.x + normal.y * desired.y + normal.z * desired.z;
    if (dot < 0) {
      orderedPts = [...pts].reverse();
      normal = { x: -normal.x, y: -normal.y, z: -normal.z };
    }
  }

  // Ear-clip planar polygons so non-convex exact-result faces render correctly.
  const meshFaces = [];
  for (const [a, b, c] of triangulatePolygonIndices(orderedPts, normal)) {
    meshFaces.push({
      vertices: [
        { ...orderedPts[a] },
        { ...orderedPts[b] },
        { ...orderedPts[c] },
      ],
      normal: { ...normal },
    });
  }

  return { vertices: orderedPts.map(p => ({ ...p })), faces: meshFaces };
}

/**
 * Tessellate a TopoBody for STL export with controlled tolerance.
 *
 * When CAD_USE_ROBUST_TESSELLATOR is enabled (the default), the robust
 * tessellator runs first with validation.  If its mesh passes validation
 * it is used; otherwise the legacy tessellator provides the fallback.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @param {number} [opts.chordalDeviation=0.01] - Max chord deviation
 * @param {number} [opts.angularTolerance=15] - Max angle deviation (degrees)
 * @returns {Array<{vertices: [{x,y,z},{x,y,z},{x,y,z}], normal: {x,y,z}}>} Triangle array
 */
export function tessellateForSTL(body, opts = {}) {
  const chordalDev = opts.chordalDeviation ?? 0.01;

  // Determine segment count based on tolerance
  const segments = Math.max(4, Math.min(64, Math.ceil(1.0 / chordalDev)));

  // BRep-only: use robust tessellator, no legacy fallback
  const robustMesh = robustTessellateBody(body, {
    surfaceSegments: segments,
    validate: true,
  });
  if (robustMesh.faces.length > 0) {
    const triangles = _meshToTriangles(robustMesh);
    if (triangles.length > 0) {
      triangles._tessellator = 'robust';
      return triangles;
    }
  }
  throw new Error(
    '[BRep-only] tessellateForSTL: robust tessellator produced an empty mesh. ' +
    'Legacy ear-clipping fallback is no longer available.'
  );
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

/**
 * Convert a mesh result (vertices + faces) to an array of triangles.
 * @param {{ faces: Array<{vertices: Array<{x:number,y:number,z:number}>, normal?: {x:number,y:number,z:number}}> }} mesh
 * @returns {Array<{vertices: Array<{x:number,y:number,z:number}>, normal: {x:number,y:number,z:number}}>}
 */
function _meshToTriangles(mesh) {
  const triangles = [];
  for (const f of mesh.faces) {
    const verts = f.vertices;
    if (verts.length === 3) {
      triangles.push({
        vertices: [{ ...verts[0] }, { ...verts[1] }, { ...verts[2] }],
        normal: f.normal ? { ...f.normal } : calculateNormal(verts[0], verts[1], verts[2]),
      });
    } else if (verts.length === 4) {
      triangles.push({
        vertices: [{ ...verts[0] }, { ...verts[1] }, { ...verts[2] }],
        normal: f.normal ? { ...f.normal } : calculateNormal(verts[0], verts[1], verts[2]),
      });
      triangles.push({
        vertices: [{ ...verts[0] }, { ...verts[2] }, { ...verts[3] }],
        normal: f.normal ? { ...f.normal } : calculateNormal(verts[0], verts[2], verts[3]),
      });
    } else if (verts.length > 4) {
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

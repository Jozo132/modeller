// assembly/tessellation.ts — Tessellation utilities for WebAssembly
//
// Provides ear-clipping polygon triangulation and helper functions for
// mesh generation from exact B-Rep topology. Operates on flat typed arrays.

// ─── Ear-clipping polygon triangulation ──────────────────────────────

/**
 * Triangulate a planar polygon using the ear-clipping method.
 *
 * The polygon is defined by 2D coordinates (projected from 3D by the JS caller).
 * Vertices should be in consistent winding order (CCW or CW).
 *
 * @param coords   - Flat 2D coords [x0,y0, x1,y1, ...] (length = nVerts * 2)
 * @param nVerts   - Number of vertices
 * @param outTris  - Output triangle indices [a,b,c, a,b,c, ...] (length >= (nVerts-2) * 3)
 * @returns number of triangles written
 */
export function earClipTriangulate(
  coords: Float64Array,
  nVerts: i32,
  outTris: Uint32Array
): i32 {
  if (nVerts < 3) return 0;
  if (nVerts == 3) {
    unchecked(outTris[0] = 0);
    unchecked(outTris[1] = 1);
    unchecked(outTris[2] = 2);
    return 1;
  }

  // Compute signed area to determine winding
  let signedArea: f64 = 0;
  for (let i: i32 = 0; i < nVerts; i++) {
    const ax: f64 = unchecked(coords[i * 2]);
    const ay: f64 = unchecked(coords[i * 2 + 1]);
    const ni: i32 = ((i + 1) % nVerts) * 2;
    const bx: f64 = unchecked(coords[ni]);
    const by: f64 = unchecked(coords[ni + 1]);
    signedArea += ax * by - bx * ay;
  }
  const winding: f64 = signedArea >= 0 ? 1.0 : -1.0;

  // Build index list
  const remaining = new Array<i32>(nVerts);
  for (let i: i32 = 0; i < nVerts; i++) {
    unchecked(remaining[i] = i);
  }

  let triCount: i32 = 0;
  let guard: i32 = 0;
  const maxGuard: i32 = nVerts * nVerts;

  while (remaining.length > 3 && guard < maxGuard) {
    let earFound: bool = false;
    const rLen: i32 = remaining.length;

    for (let ri: i32 = 0; ri < rLen; ri++) {
      const prev: i32 = unchecked(remaining[(ri - 1 + rLen) % rLen]);
      const curr: i32 = unchecked(remaining[ri]);
      const next: i32 = unchecked(remaining[(ri + 1) % rLen]);

      const ax: f64 = unchecked(coords[prev * 2]);
      const ay: f64 = unchecked(coords[prev * 2 + 1]);
      const bx: f64 = unchecked(coords[curr * 2]);
      const by: f64 = unchecked(coords[curr * 2 + 1]);
      const cx: f64 = unchecked(coords[next * 2]);
      const cy: f64 = unchecked(coords[next * 2 + 1]);

      // Cross product check for ear
      const cross: f64 = ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) * winding;
      if (cross <= 1e-8) continue;

      // Point-in-triangle test for all other vertices
      let containsPoint: bool = false;
      for (let k: i32 = 0; k < rLen; k++) {
        const other: i32 = unchecked(remaining[k]);
        if (other == prev || other == curr || other == next) continue;

        const px: f64 = unchecked(coords[other * 2]);
        const py: f64 = unchecked(coords[other * 2 + 1]);

        const c1: f64 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * winding;
        const c2: f64 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * winding;
        const c3: f64 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * winding;

        if (c1 >= -1e-8 && c2 >= -1e-8 && c3 >= -1e-8) {
          containsPoint = true;
          break;
        }
      }
      if (containsPoint) continue;

      // Found an ear — output triangle
      const ti: i32 = triCount * 3;
      unchecked(outTris[ti] = prev);
      unchecked(outTris[ti + 1] = curr);
      unchecked(outTris[ti + 2] = next);
      triCount++;

      // Remove the ear vertex
      remaining.splice(ri, 1);
      earFound = true;
      break;
    }

    if (!earFound) break;
    guard++;
  }

  // Final triangle
  if (remaining.length == 3) {
    const ti: i32 = triCount * 3;
    unchecked(outTris[ti] = remaining[0]);
    unchecked(outTris[ti + 1] = remaining[1]);
    unchecked(outTris[ti + 2] = remaining[2]);
    triCount++;
  }

  // If ear-clipping failed, fall back to fan triangulation
  if (triCount != nVerts - 2) {
    triCount = 0;
    for (let i: i32 = 1; i < nVerts - 1; i++) {
      const ti: i32 = triCount * 3;
      unchecked(outTris[ti] = 0);
      unchecked(outTris[ti + 1] = i);
      unchecked(outTris[ti + 2] = i + 1);
      triCount++;
    }
  }

  return triCount;
}

// ─── Normal computation ──────────────────────────────────────────────

/**
 * Compute a triangle normal from three 3D points.
 *
 * @param verts  - Flat vertex array [x,y,z, ...]
 * @param i0, i1, i2 - Vertex indices
 * @param outNormal - Output [nx, ny, nz] (length >= 3)
 */
export function computeTriangleNormal(
  verts: Float64Array,
  i0: i32, i1: i32, i2: i32,
  outNormal: Float64Array
): void {
  const c0: i32 = i0 * 3;
  const c1: i32 = i1 * 3;
  const c2: i32 = i2 * 3;

  const v1x: f64 = unchecked(verts[c1]) - unchecked(verts[c0]);
  const v1y: f64 = unchecked(verts[c1 + 1]) - unchecked(verts[c0 + 1]);
  const v1z: f64 = unchecked(verts[c1 + 2]) - unchecked(verts[c0 + 2]);
  const v2x: f64 = unchecked(verts[c2]) - unchecked(verts[c0]);
  const v2y: f64 = unchecked(verts[c2 + 1]) - unchecked(verts[c0 + 1]);
  const v2z: f64 = unchecked(verts[c2 + 2]) - unchecked(verts[c0 + 2]);

  const nx: f64 = v1y * v2z - v1z * v2y;
  const ny: f64 = v1z * v2x - v1x * v2z;
  const nz: f64 = v1x * v2y - v1y * v2x;
  const len: f64 = sqrt(nx * nx + ny * ny + nz * nz);

  if (len < 1e-14) {
    unchecked(outNormal[0] = 0);
    unchecked(outNormal[1] = 0);
    unchecked(outNormal[2] = 1);
  } else {
    const invLen: f64 = 1.0 / len;
    unchecked(outNormal[0] = nx * invLen);
    unchecked(outNormal[1] = ny * invLen);
    unchecked(outNormal[2] = nz * invLen);
  }
}

/**
 * Compute the bounding box of a set of 3D points.
 *
 * @param verts  - Flat [x,y,z, ...] (length = nVerts * 3)
 * @param nVerts - Number of vertices
 * @param outBox - Output [minX, minY, minZ, maxX, maxY, maxZ] (length >= 6)
 */
export function computeBoundingBox(
  verts: Float64Array,
  nVerts: i32,
  outBox: Float64Array
): void {
  let minX: f64 = Infinity, minY: f64 = Infinity, minZ: f64 = Infinity;
  let maxX: f64 = -Infinity, maxY: f64 = -Infinity, maxZ: f64 = -Infinity;

  for (let i: i32 = 0; i < nVerts; i++) {
    const ci: i32 = i * 3;
    const x: f64 = unchecked(verts[ci]);
    const y: f64 = unchecked(verts[ci + 1]);
    const z: f64 = unchecked(verts[ci + 2]);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  unchecked(outBox[0] = minX);
  unchecked(outBox[1] = minY);
  unchecked(outBox[2] = minZ);
  unchecked(outBox[3] = maxX);
  unchecked(outBox[4] = maxY);
  unchecked(outBox[5] = maxZ);
}

/**
 * Compute mesh volume using the divergence theorem (signed tetrahedron volumes).
 *
 * @param verts  - Flat vertex positions [x,y,z, ...] (length = nVerts * 3)
 * @param faces  - Flat triangle indices [i0,i1,i2, ...] (length = nTris * 3)
 * @param nTris  - Number of triangles
 * @returns absolute volume
 */
export function computeMeshVolume(
  verts: Float64Array,
  faces: Uint32Array,
  nTris: i32
): f64 {
  let vol: f64 = 0;
  for (let t: i32 = 0; t < nTris; t++) {
    const fi: i32 = t * 3;
    const i0: i32 = unchecked(faces[fi]) * 3;
    const i1: i32 = unchecked(faces[fi + 1]) * 3;
    const i2: i32 = unchecked(faces[fi + 2]) * 3;

    const ax: f64 = unchecked(verts[i0]);
    const ay: f64 = unchecked(verts[i0 + 1]);
    const az: f64 = unchecked(verts[i0 + 2]);
    const bx: f64 = unchecked(verts[i1]);
    const by: f64 = unchecked(verts[i1 + 1]);
    const bz: f64 = unchecked(verts[i1 + 2]);
    const cx: f64 = unchecked(verts[i2]);
    const cy: f64 = unchecked(verts[i2 + 1]);
    const cz: f64 = unchecked(verts[i2 + 2]);

    vol += (ax * (by * cz - bz * cy) +
            ay * (bz * cx - bx * cz) +
            az * (bx * cy - by * cx)) / 6.0;
  }
  return abs<f64>(vol);
}

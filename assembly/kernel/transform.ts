// kernel/transform — rigid body transforms in WASM
//
// Operates on f64 4×4 column-major matrices for exact-kernel precision.
// These transforms are applied to native B-Rep bodies without round-tripping
// through JS. The existing assembly/math.ts uses f32 (for rendering); this
// module uses f64 for exact geometry work.

// ---------- output buffer ----------

/** Shared output buffer for transform results (16 f64 = one 4×4 matrix). */
const outMat = new StaticArray<f64>(16);

/** Shared output buffer for transformed point (3 f64). */
const outPt = new StaticArray<f64>(3);

/** Shared output buffer for bounding box (6 f64: minX,minY,minZ,maxX,maxY,maxZ). */
const outBox = new StaticArray<f64>(6);

// ---------- matrix operations (f64, column-major) ----------

/** Write an identity matrix to outMat. */
export function transformIdentity(): void {
  for (let i: u32 = 0; i < 16; i++) unchecked(outMat[i] = 0.0);
  unchecked(outMat[0] = 1.0);
  unchecked(outMat[5] = 1.0);
  unchecked(outMat[10] = 1.0);
  unchecked(outMat[15] = 1.0);
}

/**
 * Build a translation matrix in outMat.
 */
export function transformTranslation(tx: f64, ty: f64, tz: f64): void {
  transformIdentity();
  unchecked(outMat[12] = tx);
  unchecked(outMat[13] = ty);
  unchecked(outMat[14] = tz);
}

/**
 * Build a rotation matrix around an arbitrary axis (angle in radians).
 * Rodrigues' rotation formula, written to outMat.
 */
export function transformRotation(
  axisX: f64, axisY: f64, axisZ: f64, angle: f64
): void {
  // Normalize axis
  const len = Math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ);
  if (len < 1e-15) {
    transformIdentity();
    return;
  }
  const inv = 1.0 / len;
  const x = axisX * inv;
  const y = axisY * inv;
  const z = axisZ * inv;

  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1.0 - c;

  // Column-major
  unchecked(outMat[0]  = t * x * x + c);
  unchecked(outMat[1]  = t * x * y + s * z);
  unchecked(outMat[2]  = t * x * z - s * y);
  unchecked(outMat[3]  = 0.0);
  unchecked(outMat[4]  = t * x * y - s * z);
  unchecked(outMat[5]  = t * y * y + c);
  unchecked(outMat[6]  = t * y * z + s * x);
  unchecked(outMat[7]  = 0.0);
  unchecked(outMat[8]  = t * x * z + s * y);
  unchecked(outMat[9]  = t * y * z - s * x);
  unchecked(outMat[10] = t * z * z + c);
  unchecked(outMat[11] = 0.0);
  unchecked(outMat[12] = 0.0);
  unchecked(outMat[13] = 0.0);
  unchecked(outMat[14] = 0.0);
  unchecked(outMat[15] = 1.0);
}

/**
 * Build a uniform scale matrix in outMat.
 */
export function transformScale(sx: f64, sy: f64, sz: f64): void {
  for (let i: u32 = 0; i < 16; i++) unchecked(outMat[i] = 0.0);
  unchecked(outMat[0] = sx);
  unchecked(outMat[5] = sy);
  unchecked(outMat[10] = sz);
  unchecked(outMat[15] = 1.0);
}

/**
 * Multiply two 4×4 column-major f64 matrices: result = A * B.
 * A and B are flat StaticArray<f64>(16). Result written to outMat.
 */
export function transformMultiply(a: StaticArray<f64>, b: StaticArray<f64>): void {
  for (let col: i32 = 0; col < 4; col++) {
    for (let row: i32 = 0; row < 4; row++) {
      let sum: f64 = 0.0;
      for (let k: i32 = 0; k < 4; k++) {
        sum += unchecked(a[k * 4 + row]) * unchecked(b[col * 4 + k]);
      }
      unchecked(outMat[col * 4 + row] = sum);
    }
  }
}

/**
 * Transform a 3D point by a 4×4 matrix. Result written to outPt.
 */
export function transformPoint(
  mat: StaticArray<f64>, px: f64, py: f64, pz: f64
): void {
  unchecked(outPt[0] = unchecked(mat[0]) * px + unchecked(mat[4]) * py + unchecked(mat[8])  * pz + unchecked(mat[12]));
  unchecked(outPt[1] = unchecked(mat[1]) * px + unchecked(mat[5]) * py + unchecked(mat[9])  * pz + unchecked(mat[13]));
  unchecked(outPt[2] = unchecked(mat[2]) * px + unchecked(mat[6]) * py + unchecked(mat[10]) * pz + unchecked(mat[14]));
}

/**
 * Transform a 3D point using the matrix currently in outMat. Result written to outPt.
 * Convenience function to avoid passing the matrix through the JS boundary.
 */
export function transformPointByOutMat(px: f64, py: f64, pz: f64): void {
  unchecked(outPt[0] = unchecked(outMat[0]) * px + unchecked(outMat[4]) * py + unchecked(outMat[8])  * pz + unchecked(outMat[12]));
  unchecked(outPt[1] = unchecked(outMat[1]) * px + unchecked(outMat[5]) * py + unchecked(outMat[9])  * pz + unchecked(outMat[13]));
  unchecked(outPt[2] = unchecked(outMat[2]) * px + unchecked(outMat[6]) * py + unchecked(outMat[10]) * pz + unchecked(outMat[14]));
}

/**
 * Transform a 3D direction (no translation) using outMat. Result written to outPt.
 */
export function transformDirectionByOutMat(dx: f64, dy: f64, dz: f64): void {
  unchecked(outPt[0] = unchecked(outMat[0]) * dx + unchecked(outMat[4]) * dy + unchecked(outMat[8])  * dz);
  unchecked(outPt[1] = unchecked(outMat[1]) * dx + unchecked(outMat[5]) * dy + unchecked(outMat[9])  * dz);
  unchecked(outPt[2] = unchecked(outMat[2]) * dx + unchecked(outMat[6]) * dy + unchecked(outMat[10]) * dz);
}

/**
 * Transform a 3D direction (no translation). Result written to outPt.
 */
export function transformDirection(
  mat: StaticArray<f64>, dx: f64, dy: f64, dz: f64
): void {
  unchecked(outPt[0] = unchecked(mat[0]) * dx + unchecked(mat[4]) * dy + unchecked(mat[8])  * dz);
  unchecked(outPt[1] = unchecked(mat[1]) * dx + unchecked(mat[5]) * dy + unchecked(mat[9])  * dz);
  unchecked(outPt[2] = unchecked(mat[2]) * dx + unchecked(mat[6]) * dy + unchecked(mat[10]) * dz);
}

/**
 * Compute the transformed AABB of a set of vertices.
 * Reads vertex coords from a flat f64 array (x,y,z triples).
 * Result written to outBox.
 */
export function transformBoundingBox(
  mat: StaticArray<f64>,
  verts: StaticArray<f64>,
  nVerts: u32
): void {
  if (nVerts == 0) {
    for (let i: u32 = 0; i < 6; i++) unchecked(outBox[i] = 0.0);
    return;
  }

  let minX: f64 = Infinity;
  let minY: f64 = Infinity;
  let minZ: f64 = Infinity;
  let maxX: f64 = -Infinity;
  let maxY: f64 = -Infinity;
  let maxZ: f64 = -Infinity;

  for (let i: u32 = 0; i < nVerts; i++) {
    const off = i * 3;
    const px = unchecked(verts[off]);
    const py = unchecked(verts[off + 1]);
    const pz = unchecked(verts[off + 2]);

    const tx = unchecked(mat[0]) * px + unchecked(mat[4]) * py + unchecked(mat[8])  * pz + unchecked(mat[12]);
    const ty = unchecked(mat[1]) * px + unchecked(mat[5]) * py + unchecked(mat[9])  * pz + unchecked(mat[13]);
    const tz = unchecked(mat[2]) * px + unchecked(mat[6]) * py + unchecked(mat[10]) * pz + unchecked(mat[14]);

    if (tx < minX) minX = tx;
    if (ty < minY) minY = ty;
    if (tz < minZ) minZ = tz;
    if (tx > maxX) maxX = tx;
    if (ty > maxY) maxY = ty;
    if (tz > maxZ) maxZ = tz;
  }

  unchecked(outBox[0] = minX);
  unchecked(outBox[1] = minY);
  unchecked(outBox[2] = minZ);
  unchecked(outBox[3] = maxX);
  unchecked(outBox[4] = maxY);
  unchecked(outBox[5] = maxZ);
}

// ---------- buffer access ----------

export function getTransformOutMatPtr(): usize { return changetype<usize>(outMat); }
export function getTransformOutPtPtr(): usize { return changetype<usize>(outPt); }
export function getTransformOutBoxPtr(): usize { return changetype<usize>(outBox); }

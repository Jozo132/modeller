export function mat4TransformVec4(m, x, y, z, w) {
  return {
    x: m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    y: m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    z: m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    w: m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  };
}

export function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

export function mat4Perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

export function mat4Ortho(left, right, bottom, top, near, far) {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  return new Float32Array([
    -2 * lr, 0, 0, 0,
    0, -2 * bt, 0, 0,
    0, 0, 2 * nf, 0,
    (left + right) * lr,
    (top + bottom) * bt,
    (far + near) * nf,
    1,
  ]);
}

export function mat4LookAt(ex, ey, ez, cx, cy, cz, ux, uy, uz) {
  let fx = cx - ex;
  let fy = cy - ey;
  let fz = cz - ez;
  let len = Math.sqrt(fx * fx + fy * fy + fz * fz);
  if (len < 1e-10) return null;
  fx /= len;
  fy /= len;
  fz /= len;

  let sx = fy * uz - fz * uy;
  let sy = fz * ux - fx * uz;
  let sz = fx * uy - fy * ux;
  len = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (len < 1e-10) {
    const ax = Math.abs(fx) < 0.9 ? 1 : 0;
    const ay = Math.abs(fx) < 0.9 ? 0 : 1;
    sx = fy * 0 - fz * ay;
    sy = fz * ax - fx * 0;
    sz = fx * ay - fy * ax;
    len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (len < 1e-10) return null;
  }
  sx /= len;
  sy /= len;
  sz /= len;

  const ux2 = sy * fz - sz * fy;
  const uy2 = sz * fx - sx * fz;
  const uz2 = sx * fy - sy * fx;

  return new Float32Array([
    sx, ux2, -fx, 0,
    sy, uy2, -fy, 0,
    sz, uz2, -fz, 0,
    -(sx * ex + sy * ey + sz * ez),
    -(ux2 * ex + uy2 * ey + uz2 * ez),
    fx * ex + fy * ey + fz * ez,
    1,
  ]);
}

export function projectClipToScreen(clip, width, height) {
  if (!clip || Math.abs(clip.w) < 1e-8 || clip.w <= 0) return null;
  const invW = 1 / clip.w;
  const ndcX = clip.x * invW;
  const ndcY = clip.y * invW;
  const ndcZ = clip.z * invW;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (-ndcY * 0.5 + 0.5) * height,
    z: ndcZ,
  };
}
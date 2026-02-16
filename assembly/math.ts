// Core math types for 3D rendering

export class Vec3 {
  x: f32;
  y: f32;
  z: f32;

  constructor(x: f32 = 0, y: f32 = 0, z: f32 = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x: f32, y: f32, z: f32): Vec3 {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  @inline
  add(b: Vec3): Vec3 {
    return new Vec3(this.x + b.x, this.y + b.y, this.z + b.z);
  }

  @inline
  sub(b: Vec3): Vec3 {
    return new Vec3(this.x - b.x, this.y - b.y, this.z - b.z);
  }

  @inline
  scale(s: f32): Vec3 {
    return new Vec3(this.x * s, this.y * s, this.z * s);
  }

  @inline
  dot(b: Vec3): f32 {
    return this.x * b.x + this.y * b.y + this.z * b.z;
  }

  @inline
  cross(b: Vec3): Vec3 {
    return new Vec3(
      this.y * b.z - this.z * b.y,
      this.z * b.x - this.x * b.z,
      this.x * b.y - this.y * b.x
    );
  }

  @inline
  length(): f32 {
    return <f32>Math.sqrt(<f64>(this.x * this.x + this.y * this.y + this.z * this.z));
  }

  normalize(): Vec3 {
    const len = this.length();
    if (len > 0) {
      const inv: f32 = 1.0 / len;
      return new Vec3(this.x * inv, this.y * inv, this.z * inv);
    }
    return new Vec3(0, 0, 0);
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }
}

export class Vec4 {
  x: f32;
  y: f32;
  z: f32;
  w: f32;

  constructor(x: f32 = 0, y: f32 = 0, z: f32 = 0, w: f32 = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }
}

export class Mat4 {
  data: StaticArray<f32>;

  constructor() {
    this.data = new StaticArray<f32>(16);
    this.setIdentity();
  }

  static identity(): Mat4 {
    const m = new Mat4();
    return m;
  }

  static fromValues(
    m00: f32, m01: f32, m02: f32, m03: f32,
    m10: f32, m11: f32, m12: f32, m13: f32,
    m20: f32, m21: f32, m22: f32, m23: f32,
    m30: f32, m31: f32, m32: f32, m33: f32
  ): Mat4 {
    const m = new Mat4();
    const d = m.data;
    // Column-major order
    unchecked(d[0]  = m00); unchecked(d[1]  = m01); unchecked(d[2]  = m02); unchecked(d[3]  = m03);
    unchecked(d[4]  = m10); unchecked(d[5]  = m11); unchecked(d[6]  = m12); unchecked(d[7]  = m13);
    unchecked(d[8]  = m20); unchecked(d[9]  = m21); unchecked(d[10] = m22); unchecked(d[11] = m23);
    unchecked(d[12] = m30); unchecked(d[13] = m31); unchecked(d[14] = m32); unchecked(d[15] = m33);
    return m;
  }

  setIdentity(): Mat4 {
    const d = this.data;
    unchecked(d[0]  = 1); unchecked(d[1]  = 0); unchecked(d[2]  = 0); unchecked(d[3]  = 0);
    unchecked(d[4]  = 0); unchecked(d[5]  = 1); unchecked(d[6]  = 0); unchecked(d[7]  = 0);
    unchecked(d[8]  = 0); unchecked(d[9]  = 0); unchecked(d[10] = 1); unchecked(d[11] = 0);
    unchecked(d[12] = 0); unchecked(d[13] = 0); unchecked(d[14] = 0); unchecked(d[15] = 1);
    return this;
  }

  // Column-major multiply: result = this * b
  multiply(b: Mat4): Mat4 {
    const out = new Mat4();
    const a = this.data;
    const bd = b.data;
    const o = out.data;
    for (let col: i32 = 0; col < 4; col++) {
      for (let row: i32 = 0; row < 4; row++) {
        let sum: f32 = 0;
        for (let k: i32 = 0; k < 4; k++) {
          sum += unchecked(a[k * 4 + row]) * unchecked(bd[col * 4 + k]);
        }
        unchecked(o[col * 4 + row] = sum);
      }
    }
    return out;
  }

  static perspective(fovRadians: f32, aspect: f32, near: f32, far: f32): Mat4 {
    const m = new Mat4();
    const d = m.data;
    const f: f32 = <f32>(1.0 / Math.tan(<f64>(fovRadians * 0.5)));
    const nf: f32 = 1.0 / (near - far);

    unchecked(d[0]  = f / aspect);
    unchecked(d[1]  = 0);
    unchecked(d[2]  = 0);
    unchecked(d[3]  = 0);
    unchecked(d[4]  = 0);
    unchecked(d[5]  = f);
    unchecked(d[6]  = 0);
    unchecked(d[7]  = 0);
    unchecked(d[8]  = 0);
    unchecked(d[9]  = 0);
    unchecked(d[10] = (far + near) * nf);
    unchecked(d[11] = -1);
    unchecked(d[12] = 0);
    unchecked(d[13] = 0);
    unchecked(d[14] = 2.0 * far * near * nf);
    unchecked(d[15] = 0);
    return m;
  }

  static ortho(left: f32, right: f32, bottom: f32, top: f32, near: f32, far: f32): Mat4 {
    const m = new Mat4();
    const d = m.data;
    const lr: f32 = 1.0 / (left - right);
    const bt: f32 = 1.0 / (bottom - top);
    const nf: f32 = 1.0 / (near - far);

    unchecked(d[0]  = -2.0 * lr);
    unchecked(d[1]  = 0);
    unchecked(d[2]  = 0);
    unchecked(d[3]  = 0);
    unchecked(d[4]  = 0);
    unchecked(d[5]  = -2.0 * bt);
    unchecked(d[6]  = 0);
    unchecked(d[7]  = 0);
    unchecked(d[8]  = 0);
    unchecked(d[9]  = 0);
    unchecked(d[10] = 2.0 * nf);
    unchecked(d[11] = 0);
    unchecked(d[12] = (left + right) * lr);
    unchecked(d[13] = (top + bottom) * bt);
    unchecked(d[14] = (far + near) * nf);
    unchecked(d[15] = 1);
    return m;
  }

  static lookAt(
    eyeX: f32, eyeY: f32, eyeZ: f32,
    targetX: f32, targetY: f32, targetZ: f32,
    upX: f32, upY: f32, upZ: f32
  ): Mat4 {
    const m = new Mat4();
    const d = m.data;

    let zx: f32 = eyeX - targetX;
    let zy: f32 = eyeY - targetY;
    let zz: f32 = eyeZ - targetZ;
    let len: f32 = <f32>(1.0 / Math.sqrt(<f64>(zx * zx + zy * zy + zz * zz)));
    zx *= len; zy *= len; zz *= len;

    // cross(up, z)
    let xx: f32 = upY * zz - upZ * zy;
    let xy: f32 = upZ * zx - upX * zz;
    let xz: f32 = upX * zy - upY * zx;
    len = <f32>(1.0 / Math.sqrt(<f64>(xx * xx + xy * xy + xz * xz)));
    xx *= len; xy *= len; xz *= len;

    // cross(z, x)
    let yx: f32 = zy * xz - zz * xy;
    let yy: f32 = zz * xx - zx * xz;
    let yz: f32 = zx * xy - zy * xx;

    unchecked(d[0]  = xx);
    unchecked(d[1]  = yx);
    unchecked(d[2]  = zx);
    unchecked(d[3]  = 0);
    unchecked(d[4]  = xy);
    unchecked(d[5]  = yy);
    unchecked(d[6]  = zy);
    unchecked(d[7]  = 0);
    unchecked(d[8]  = xz);
    unchecked(d[9]  = yz);
    unchecked(d[10] = zz);
    unchecked(d[11] = 0);
    unchecked(d[12] = -(xx * eyeX + xy * eyeY + xz * eyeZ));
    unchecked(d[13] = -(yx * eyeX + yy * eyeY + yz * eyeZ));
    unchecked(d[14] = -(zx * eyeX + zy * eyeY + zz * eyeZ));
    unchecked(d[15] = 1);
    return m;
  }

  static translation(tx: f32, ty: f32, tz: f32): Mat4 {
    const m = new Mat4();
    const d = m.data;
    unchecked(d[12] = tx);
    unchecked(d[13] = ty);
    unchecked(d[14] = tz);
    return m;
  }

  static scaling(sx: f32, sy: f32, sz: f32): Mat4 {
    const m = new Mat4();
    const d = m.data;
    unchecked(d[0]  = sx);
    unchecked(d[5]  = sy);
    unchecked(d[10] = sz);
    return m;
  }

  static rotationX(rad: f32): Mat4 {
    const m = new Mat4();
    const d = m.data;
    const s: f32 = <f32>Math.sin(<f64>rad);
    const c: f32 = <f32>Math.cos(<f64>rad);
    unchecked(d[5]  = c);
    unchecked(d[6]  = s);
    unchecked(d[9]  = -s);
    unchecked(d[10] = c);
    return m;
  }

  static rotationY(rad: f32): Mat4 {
    const m = new Mat4();
    const d = m.data;
    const s: f32 = <f32>Math.sin(<f64>rad);
    const c: f32 = <f32>Math.cos(<f64>rad);
    unchecked(d[0]  = c);
    unchecked(d[2]  = -s);
    unchecked(d[8]  = s);
    unchecked(d[10] = c);
    return m;
  }

  static rotationZ(rad: f32): Mat4 {
    const m = new Mat4();
    const d = m.data;
    const s: f32 = <f32>Math.sin(<f64>rad);
    const c: f32 = <f32>Math.cos(<f64>rad);
    unchecked(d[0]  = c);
    unchecked(d[1]  = s);
    unchecked(d[4]  = -s);
    unchecked(d[5]  = c);
    return m;
  }

  // Write 16 floats to a target array at offset
  @inline
  writeTo(target: StaticArray<f32>, offset: i32): void {
    const d = this.data;
    for (let i: i32 = 0; i < 16; i++) {
      unchecked(target[offset + i] = d[i]);
    }
  }

  clone(): Mat4 {
    const m = new Mat4();
    const d = m.data;
    const s = this.data;
    for (let i: i32 = 0; i < 16; i++) {
      unchecked(d[i] = s[i]);
    }
    return m;
  }
}

export class Color {
  r: f32;
  g: f32;
  b: f32;
  a: f32;

  constructor(r: f32 = 1, g: f32 = 1, b: f32 = 1, a: f32 = 1) {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
  }

  set(r: f32, g: f32, b: f32, a: f32): Color {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
    return this;
  }

  clone(): Color {
    return new Color(this.r, this.g, this.b, this.a);
  }
}

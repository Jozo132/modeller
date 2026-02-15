import { Vec3, Mat4 } from "./math";

export class Camera {
  position: Vec3;
  target: Vec3;
  up: Vec3;

  projectionMatrix: Mat4;
  viewMatrix: Mat4;

  // Perspective params
  fov: f32;
  aspect: f32;
  near: f32;
  far: f32;

  // Ortho params
  orthoLeft: f32;
  orthoRight: f32;
  orthoBottom: f32;
  orthoTop: f32;

  isPerspective: bool;

  constructor() {
    this.position = new Vec3(10, 10, 10);
    this.target = new Vec3(0, 0, 0);
    this.up = new Vec3(0, 0, 1);

    this.projectionMatrix = new Mat4();
    this.viewMatrix = new Mat4();

    this.fov = <f32>(Math.PI / 4.0);
    this.aspect = 1.0;
    this.near = 0.1;
    this.far = 10000.0;

    this.orthoLeft = -10;
    this.orthoRight = 10;
    this.orthoBottom = -10;
    this.orthoTop = 10;

    this.isPerspective = true;
  }

  setPerspective(fov: f32, aspect: f32, near: f32, far: f32): void {
    this.fov = fov;
    this.aspect = aspect;
    this.near = near;
    this.far = far;
    this.isPerspective = true;
    this.updateProjection();
  }

  setOrthographic(left: f32, right: f32, bottom: f32, top: f32, near: f32, far: f32): void {
    this.orthoLeft = left;
    this.orthoRight = right;
    this.orthoBottom = bottom;
    this.orthoTop = top;
    this.near = near;
    this.far = far;
    this.isPerspective = false;
    this.updateProjection();
  }

  lookAt(
    eyeX: f32, eyeY: f32, eyeZ: f32,
    targetX: f32, targetY: f32, targetZ: f32,
    upX: f32, upY: f32, upZ: f32
  ): void {
    this.position.set(eyeX, eyeY, eyeZ);
    this.target.set(targetX, targetY, targetZ);
    this.up.set(upX, upY, upZ);
    this.updateView();
  }

  updateProjection(): void {
    if (this.isPerspective) {
      this.projectionMatrix = Mat4.perspective(this.fov, this.aspect, this.near, this.far);
    } else {
      this.projectionMatrix = Mat4.ortho(
        this.orthoLeft, this.orthoRight,
        this.orthoBottom, this.orthoTop,
        this.near, this.far
      );
    }
  }

  updateView(): void {
    this.viewMatrix = Mat4.lookAt(
      this.position.x, this.position.y, this.position.z,
      this.target.x, this.target.y, this.target.z,
      this.up.x, this.up.y, this.up.z
    );
  }

  getViewProjectionMatrix(): Mat4 {
    this.updateView();
    this.updateProjection();
    return this.projectionMatrix.multiply(this.viewMatrix);
  }
}

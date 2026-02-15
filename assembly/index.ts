import { Color } from "./math";
import { CommandBuffer } from "./commands";
import { Scene, SceneNode } from "./scene";

// Global state — initialized in init()
let scene: Scene = new Scene();
let cmd: CommandBuffer = new CommandBuffer();

// Mouse state
let mouseX: f32 = 0;
let mouseY: f32 = 0;

// === Initialization ===

export function init(canvasWidth: i32, canvasHeight: i32): void {
  cmd = new CommandBuffer();
  scene = new Scene();
  scene.canvasWidth = canvasWidth;
  scene.canvasHeight = canvasHeight;

  const aspect: f32 = <f32>canvasWidth / <f32>canvasHeight;
  scene.camera.setPerspective(
    <f32>(Math.PI / 4.0),
    aspect,
    0.1,
    1000.0
  );
  scene.camera.lookAt(
    10, 10, 10,
    0, 0, 0,
    0, 0, 1
  );
}

// === Canvas resize ===

export function resize(width: i32, height: i32): void {
  scene.canvasWidth = width;
  scene.canvasHeight = height;
  const aspect: f32 = <f32>width / <f32>height;

  if (scene.camera.isPerspective) {
    scene.camera.setPerspective(scene.camera.fov, aspect, scene.camera.near, scene.camera.far);
  } else {
    // Maintain ortho bounds aspect ratio
    const halfW: f32 = (scene.camera.orthoRight - scene.camera.orthoLeft) * 0.5;
    const halfH: f32 = halfW / aspect;
    const cx: f32 = (scene.camera.orthoLeft + scene.camera.orthoRight) * 0.5;
    const cy: f32 = (scene.camera.orthoBottom + scene.camera.orthoTop) * 0.5;
    scene.camera.setOrthographic(
      cx - halfW, cx + halfW,
      cy - halfH, cy + halfH,
      scene.camera.near, scene.camera.far
    );
  }
}

// === Camera ===

export function setCameraMode(mode: i32): void {
  const aspect: f32 = <f32>scene.canvasWidth / <f32>scene.canvasHeight;
  if (mode == 1) {
    scene.camera.setPerspective(scene.camera.fov, aspect, scene.camera.near, scene.camera.far);
  } else {
    scene.camera.setOrthographic(
      -10 * aspect, 10 * aspect,
      -10, 10,
      scene.camera.near, scene.camera.far
    );
  }
}

export function setCameraPosition(x: f32, y: f32, z: f32): void {
  scene.camera.position.set(x, y, z);
}

export function setCameraTarget(x: f32, y: f32, z: f32): void {
  scene.camera.target.set(x, y, z);
}

export function setOrthoBounds(left: f32, right: f32, bottom: f32, top: f32): void {
  scene.camera.setOrthographic(left, right, bottom, top, scene.camera.near, scene.camera.far);
}

// === Scene management ===

export function clearScene(): void {
  scene.clear();
}

export function addBox(
  sizeX: f32, sizeY: f32, sizeZ: f32,
  posX: f32, posY: f32, posZ: f32,
  r: f32, g: f32, b: f32, a: f32
): i32 {
  const node = scene.addNode();
  node.sizeX = sizeX;
  node.sizeY = sizeY;
  node.sizeZ = sizeZ;
  node.position.set(posX, posY, posZ);
  node.color.set(r, g, b, a);
  return node.id;
}

export function removeNode(id: i32): void {
  scene.removeNode(id);
}

export function setNodeVisible(id: i32, visible: i32): void {
  const node = scene.getNode(id);
  if (node !== null) {
    node.visible = visible != 0;
  }
}

export function setNodePosition(id: i32, x: f32, y: f32, z: f32): void {
  const node = scene.getNode(id);
  if (node !== null) {
    node.position.set(x, y, z);
  }
}

export function setNodeColor(id: i32, r: f32, g: f32, b: f32, a: f32): void {
  const node = scene.getNode(id);
  if (node !== null) {
    node.color.set(r, g, b, a);
  }
}

// === Grid/axes visibility ===

export function setGridVisible(visible: i32): void {
  scene.gridVisible = visible != 0;
}

export function setAxesVisible(visible: i32): void {
  scene.axesVisible = visible != 0;
}

// === Mouse/Input ===

export function setMousePosition(x: f32, y: f32): void {
  mouseX = x;
  mouseY = y;
}

export function mouseAction(action: i32): void {
  // 0=none, 1=down, 2=up, 3=move
  // Reserved for orbit/pan controls implementation
}

// === Render ===

export function render(): void {
  scene.renderScene(cmd);
}

// === Command buffer access ===

export function getCommandBufferPtr(): usize {
  return cmd.getBufferPtr();
}

export function getCommandBufferLen(): i32 {
  return cmd.getBufferLength();
}

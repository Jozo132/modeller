import { Color } from "./math";
import { CommandBuffer } from "./commands";
import { Scene, SceneNode } from "./scene";
import { EntityStore, FLAG_VISIBLE, FLAG_SELECTED, FLAG_CONSTRUCTION, FLAG_HOVER, FLAG_FIXED, FLAG_PREVIEW } from "./entities";
import { ConstraintSolver, CONSTRAINT_COINCIDENT, CONSTRAINT_HORIZONTAL, CONSTRAINT_VERTICAL, CONSTRAINT_DISTANCE, CONSTRAINT_FIXED, CONSTRAINT_PARALLEL, CONSTRAINT_PERPENDICULAR, CONSTRAINT_EQUAL_LENGTH, CONSTRAINT_TANGENT, CONSTRAINT_ANGLE } from "./solver";
import { render2DEntities, renderOriginPlanes, setEntityModelMatrix, resetEntityModelMatrix } from "./render2d";

// Global state — initialized in init()
let scene: Scene = new Scene();
let cmd: CommandBuffer = new CommandBuffer();
let entities: EntityStore = new EntityStore();
let solver: ConstraintSolver = new ConstraintSolver();

// Mouse state
let mouseX: f32 = 0;
let mouseY: f32 = 0;
let mouseButton: i32 = -1; // -1=none, 0=left, 1=middle, 2=right
let mouseActionState: i32 = 0;  // 0=none, 1=down, 2=up, 3=move

// Render mode: 0=2D (ortho XY projection), 1=3D (perspective)
let renderMode: i32 = 0;

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
  renderMode = mode;
  const aspect: f32 = <f32>scene.canvasWidth / <f32>scene.canvasHeight;
  if (mode == 1) {
    scene.camera.setPerspective(scene.camera.fov, aspect, scene.camera.near, scene.camera.far);
  } else {
    // 2D mode: orthographic projection onto XY plane
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

export function setCameraUp(x: f32, y: f32, z: f32): void {
  scene.camera.up.set(x, y, z);
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

export function setGridSize(size: f32, divisions: i32): void {
  scene.gridSize = size;
  scene.gridDivisions = divisions;
}

export function setAxesSize(size: f32): void {
  scene.axesSize = size;
}

export function setOriginPlanesVisible(mask: i32): void {
  originPlanesVisible = mask;
}

export function setOriginPlaneHovered(mask: i32): void {
  originPlaneHovered = mask;
}

export function setOriginPlaneSelected(mask: i32): void {
  originPlaneSelected = mask;
}

// === Mouse/Input ===

export function setMousePosition(x: f32, y: f32): void {
  mouseX = x;
  mouseY = y;
}

export function mouseAction(action: i32): void {
  mouseActionState = action;
  // 0=none, 1=down, 2=up, 3=move
}

export function setMouseButton(button: i32): void {
  mouseButton = button;
}

// === 2D Entity Management ===

export function clearEntities(): void {
  entities.clear();
}

export function addEntitySegment(
  x1: f32, y1: f32, x2: f32, y2: f32,
  flags: i32, r: f32, g: f32, b: f32, a: f32
): i32 {
  return entities.addSegment(x1, y1, x2, y2, flags, r, g, b, a);
}

export function addEntityCircle(
  cx: f32, cy: f32, radius: f32,
  flags: i32, r: f32, g: f32, b: f32, a: f32
): i32 {
  return entities.addCircle(cx, cy, radius, flags, r, g, b, a);
}

export function addEntityArc(
  cx: f32, cy: f32, radius: f32,
  startAngle: f32, endAngle: f32,
  flags: i32, r: f32, g: f32, b: f32, a: f32
): i32 {
  return entities.addArc(cx, cy, radius, startAngle, endAngle, flags, r, g, b, a);
}

export function addEntityPoint(
  x: f32, y: f32, size: f32,
  flags: i32, r: f32, g: f32, b: f32, a: f32
): i32 {
  return entities.addPoint(x, y, size, flags, r, g, b, a);
}

export function addEntityDimension(
  x1: f32, y1: f32, x2: f32, y2: f32,
  offset: f32, dimType: i32,
  angleStart: f32, angleSweep: f32,
  flags: i32, r: f32, g: f32, b: f32, a: f32
): i32 {
  return entities.addDimension(x1, y1, x2, y2, offset, dimType, angleStart, angleSweep, flags, r, g, b, a);
}

export function setSnapPosition(x: f32, y: f32, visible: i32): void {
  entities.snapX = x;
  entities.snapY = y;
  entities.snapVisible = visible != 0;
}

export function setCursorPosition(x: f32, y: f32, visible: i32): void {
  entities.cursorX = x;
  entities.cursorY = y;
  entities.cursorVisible = visible != 0;
}

// === Constraint Solver ===

export function clearSolver(): void {
  solver.clear();
}

export function addSolverPoint(x: f32, y: f32, fixed: i32): i32 {
  return solver.addPoint(x, y, fixed != 0);
}

export function addSolverConstraint(
  type: i32, p1: i32, p2: i32, p3: i32, p4: i32, value: f32
): i32 {
  return solver.addConstraint(type, p1, p2, p3, p4, value);
}

export function solveSolver(): i32 {
  return solver.solve() ? 1 : 0;
}

export function getSolverPointX(index: i32): f32 {
  return solver.getPointX(index);
}

export function getSolverPointY(index: i32): f32 {
  return solver.getPointY(index);
}

export function getSolverConverged(): i32 {
  return solver.converged ? 1 : 0;
}

export function getSolverIterations(): i32 {
  return solver.iterations;
}

export function getSolverMaxError(): f32 {
  return solver.maxError;
}

// Origin planes visibility bitmask (bit 0=XY, bit 1=XZ, bit 2=YZ)
let originPlanesVisible: i32 = 7; // all visible by default
let originPlaneHovered: i32 = 0;  // hover highlight mask
let originPlaneSelected: i32 = 0; // selection highlight mask

// === Render ===

export function render(): void {
  cmd.reset();

  // Clear
  cmd.emitClear(0.15, 0.15, 0.15, 1.0);
  cmd.emitSetDepthTest(true);

  // View-projection matrix
  const vp = scene.camera.getViewProjectionMatrix();

  // Grid
  if (scene.gridVisible) {
    scene.renderGrid(cmd, vp);
  }

  // Axes
  if (scene.axesVisible) {
    scene.renderAxes(cmd, vp);
  }

  // 3D scene nodes (boxes, geometry)
  scene.renderNodes(cmd, vp);

  // Origin planes overlay (visible in 3D mode).
  // Draw after solids so they don't clip or cut into body geometry.
  if (renderMode == 1) {
    renderOriginPlanes(cmd, vp, originPlanesVisible, originPlaneHovered, originPlaneSelected);
  }

  // 2D entities on XY plane
  render2DEntities(cmd, vp, entities);

  cmd.emitEnd();
}

// === Command buffer access ===

export function getCommandBufferPtr(): usize {
  return cmd.getBufferPtr();
}

export function getCommandBufferLen(): i32 {
  return cmd.getBufferLength();
}

// Re-export entity model matrix functions
export { setEntityModelMatrix, resetEntityModelMatrix };

// Re-export constants for JS side
export const ENTITY_FLAG_VISIBLE: i32 = FLAG_VISIBLE;
export const ENTITY_FLAG_SELECTED: i32 = FLAG_SELECTED;
export const ENTITY_FLAG_CONSTRUCTION: i32 = FLAG_CONSTRUCTION;
export const ENTITY_FLAG_HOVER: i32 = FLAG_HOVER;
export const ENTITY_FLAG_FIXED: i32 = FLAG_FIXED;
export const ENTITY_FLAG_PREVIEW: i32 = FLAG_PREVIEW;

export const SOLVER_COINCIDENT: i32 = CONSTRAINT_COINCIDENT;
export const SOLVER_HORIZONTAL: i32 = CONSTRAINT_HORIZONTAL;
export const SOLVER_VERTICAL: i32 = CONSTRAINT_VERTICAL;
export const SOLVER_DISTANCE: i32 = CONSTRAINT_DISTANCE;
export const SOLVER_FIXED: i32 = CONSTRAINT_FIXED;
export const SOLVER_PARALLEL: i32 = CONSTRAINT_PARALLEL;
export const SOLVER_PERPENDICULAR: i32 = CONSTRAINT_PERPENDICULAR;
export const SOLVER_EQUAL_LENGTH: i32 = CONSTRAINT_EQUAL_LENGTH;
export const SOLVER_TANGENT: i32 = CONSTRAINT_TANGENT;
export const SOLVER_ANGLE: i32 = CONSTRAINT_ANGLE;

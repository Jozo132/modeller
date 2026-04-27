import { Color } from "./math";
import { CommandBuffer } from "./commands";
import { Scene, SceneNode } from "./scene";
import { EntityStore, FLAG_VISIBLE, FLAG_SELECTED, FLAG_CONSTRUCTION, FLAG_HOVER, FLAG_FIXED, FLAG_PREVIEW } from "./entities";
import { ConstraintSolver, CONSTRAINT_COINCIDENT, CONSTRAINT_HORIZONTAL, CONSTRAINT_VERTICAL, CONSTRAINT_DISTANCE, CONSTRAINT_FIXED, CONSTRAINT_PARALLEL, CONSTRAINT_PERPENDICULAR, CONSTRAINT_EQUAL_LENGTH, CONSTRAINT_TANGENT, CONSTRAINT_ANGLE } from "./solver";
import { render2DEntities, renderOriginPlanes, setEntityModelMatrix, resetEntityModelMatrix } from "./render2d";
import {
  getResultPtr,
  getTessVertsPtr, getTessNormalsPtr, getTessFacesPtr, getCurvePtsPtr,
  nurbsCurveEvaluate, nurbsCurveTessellate,
  nurbsSurfaceEvaluate, nurbsSurfaceNormal, nurbsSurfaceTessellate,
  getDerivBufPtr,
  getBatchBufPtr, getBatchBufLen,
  getMaxTessSegs, getMaxCurveSegs,
  nurbsCurveDerivEval, nurbsCurveBatchDerivEval,
  nurbsSurfaceDerivEval, nurbsSurfaceBatchDerivEval,
  ssxSetSurfaceA, ssxSetSurfaceB,
  ssxRefinePair, getSsxRefineOutPtr,
  ssxFindSeeds, getSsxSeedsOutPtr, getSsxMaxSeeds,
} from "./nurbs";
import {
  earClipTriangulate,
  computeTriangleNormal, computeBoundingBox, computeMeshVolume,
} from "./tessellation";

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

export function setFov(fov: f32): void {
  scene.camera.fov = fov;
  if (scene.camera.isPerspective) {
    const aspect: f32 = <f32>scene.canvasWidth / <f32>scene.canvasHeight;
    scene.camera.setPerspective(fov, aspect, scene.camera.near, scene.camera.far);
  }
}

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

// ─── Re-export NURBS tessellation API ─────────────────────────────────
export {
  getResultPtr,
  getTessVertsPtr, getTessNormalsPtr, getTessFacesPtr, getCurvePtsPtr,
  nurbsCurveEvaluate, nurbsCurveTessellate,
  nurbsSurfaceEvaluate, nurbsSurfaceNormal, nurbsSurfaceTessellate,
};

// ─── Re-export NURBS derivative evaluator API ──────────────────────────
export {
  getDerivBufPtr,
  getBatchBufPtr, getBatchBufLen,
  getMaxTessSegs, getMaxCurveSegs,
  nurbsCurveDerivEval, nurbsCurveBatchDerivEval,
  nurbsSurfaceDerivEval, nurbsSurfaceBatchDerivEval,
};

// ─── Re-export surface-surface Newton refiner / seed finder ───────────
export {
  ssxSetSurfaceA, ssxSetSurfaceB,
  ssxRefinePair, getSsxRefineOutPtr,
  ssxFindSeeds, getSsxSeedsOutPtr, getSsxMaxSeeds,
};

export {
  earClipTriangulate,
  computeTriangleNormal, computeBoundingBox, computeMeshVolume,
};

// ─── Re-export WASM B-Rep kernel API ──────────────────────────────────
export {
  // core: handle registry
  HANDLE_NONE,
  RESIDENCY_UNMATERIALIZED, RESIDENCY_HYDRATING, RESIDENCY_RESIDENT, RESIDENCY_STALE, RESIDENCY_DISPOSED,
  handleAlloc, handleRelease, handleAddRef,
  handleIsValid, handleGetResidency, handleSetResidency,
  handleGetRevision, handleBumpRevision,
  handleSetFeatureId, handleGetFeatureId,
  handleSetIrHash, handleGetIrHash,
  handleGetRefCount, handleLiveCount, handleGlobalRevision,
  handleReleaseAll,
  handleSetBodyStart, handleSetBodyEnd,
  handleGetFaceStart, handleGetFaceEnd,
  handleGetVertexStart, handleGetVertexEnd,
  handleGetShellStart, handleGetShellEnd,
  handleGetGeomStart, handleGetGeomEnd,
  // topology: B-Rep entities
  MAX_VERTICES, MAX_EDGES, MAX_COEDGES, MAX_LOOPS, MAX_FACES, MAX_SHELLS,
  GEOM_NONE, GEOM_PLANE, GEOM_CYLINDER, GEOM_CONE, GEOM_SPHERE, GEOM_TORUS,
  GEOM_NURBS_SURFACE, GEOM_LINE, GEOM_CIRCLE, GEOM_ELLIPSE, GEOM_NURBS_CURVE,
  ORIENT_FORWARD, ORIENT_REVERSED,
  vertexAdd, vertexGetX, vertexGetY, vertexGetZ, vertexGetCount,
  edgeAdd, edgeGetStartVertex, edgeGetEndVertex, edgeGetGeomType, edgeGetGeomOffset, edgeGetCount,
  coedgeAdd, coedgeGetEdge, coedgeGetOrient, coedgeGetNext, coedgeGetLoop, coedgeSetNext, coedgeGetCount,
  loopAdd, loopGetFirstCoedge, loopGetFace, loopIsOuterLoop, loopGetCount,
  faceAdd, faceGetFirstLoop, faceGetShell, faceGetGeomType, faceGetGeomOffset, faceGetOrient, faceGetLoopCount, faceGetCount,
  shellAdd, shellGetFirstFace, shellGetFaceCount, shellIsClosed_, shellGetCount,
  bodyBegin, bodyEnd, bodyBeginForHandle, bodyEndForHandle, topologyResetAll,
  bodyGetShellCount, bodyGetFirstShell,
  getVertexCoordsPtr, getVertexCoordsLen,
  getEdgeStartVertexPtr, getEdgeEndVertexPtr,
  topoGetSummary,
  // geometry: NURBS + analytic
  nurbsSurfaceStore, nurbsCurveStore,
  circleStore, planeStore, cylinderStore, sphereStore, coneStore, torusStore,
  geomPoolRead, getGeomPoolPtr, geomPoolUsed, geomPoolReset, geomPoolSetUsed,
  geomStagingPtr, geomStagingCapacity,
  nurbsSurfaceStoreFromStaging, nurbsCurveStoreFromStaging,
  // transform
  transformIdentity, transformTranslation, transformRotation, transformScale,
  transformMultiply, transformPoint, transformPointByOutMat,
  transformDirection, transformDirectionByOutMat, transformBoundingBox,
  getTransformOutMatPtr, getTransformOutPtPtr, getTransformOutBoxPtr,
  // spatial: octree
  octreeReset, octreeAddFaceAABB, octreeBuild,
  octreeQueryPairs, getOctreePairsPtr, octreeGetPairCount, octreeGetNodeCount,
  // gpu: std430 buffer batching
  gpuBatchReset, gpuBatchAddSurface,
  getGpuHeaderBufPtr, getGpuHeaderBufLen,
  getGpuCtrlBufPtr, getGpuCtrlBufLen,
  getGpuKnotBufPtr, getGpuKnotBufLen,
  getGpuSurfaceCount,
  // tessellation: native face-level mesh extraction
  tessBuildAllFaces, tessBuildHandleFaces, tessBuildFace, tessReset,
  getTessOutVertsPtr, getTessOutNormalsPtr, getTessOutIndicesPtr, getTessOutFaceMapPtr,
  getTessOutVertCount, getTessOutTriCount,
  getEdgeSamplePtsPtr, getEdgeSampleCount, getEdgeSampleStart,
  // ops: topology-driven boolean classification
  CLASSIFY_OUTSIDE, CLASSIFY_INSIDE, CLASSIFY_ON_BOUNDARY, CLASSIFY_UNKNOWN,
  classifyPointVsShell, classifyPointVsTriangles, classifyFacesViaOctree,
  planePlaneIntersect, getPlanePlaneIntersectPtr,
  planeSphereIntersect, getPlaneSphereIntersectPtr,
  planeCylinderIntersect, getPlaneCylinderIntersectPtr,
  planeConeIntersect, getPlaneConeIntersectPtr,
  cylinderCylinderIntersect, getCylinderCylinderIntersectPtr,
  sphereSphereIntersect, getSphereSphereIntersectPtr,
  getFaceClassification, setFaceClassification,
  pointToPlaneDistance, pointToSphereDistance, pointToCylinderDistance,
  getFaceClassificationPtr,
  isxReset, isxRecord, isxGetErrorBound, isxGetCount,
  isxGetMaxErrorBound, isxAreDistinct, isxRayFace,
  // interop: CBREP serialization
  cbrepDehydrate, cbrepHydrate, cbrepHydrateForHandle,
  getCbrepOutPtr, getCbrepOutLen,
  // step_lexer: native ISO 10303-21 tokenizer
  TOKEN_EOF, TOKEN_HASH_ID, TOKEN_HASH_REF, TOKEN_KEYWORD, TOKEN_NUMBER,
  TOKEN_STRING, TOKEN_ENUM, TOKEN_DOLLAR, TOKEN_STAR,
  TOKEN_LPAREN, TOKEN_RPAREN, TOKEN_COMMA, TOKEN_EQUALS, TOKEN_SEMICOLON,
  STEP_LEX_OK, STEP_LEX_ERR_BAD_CHAR, STEP_LEX_ERR_UNTERMINATED_STRING,
  STEP_LEX_ERR_INPUT_TOO_LARGE, STEP_LEX_ERR_TOKEN_OVERFLOW, STEP_LEX_ERR_STRPOOL_OVERFLOW,
  stepLexReset, stepLexRun,
  stepLexGetInputPtr, stepLexGetInputCapacity,
  stepLexGetTokenBufPtr, stepLexGetTokenCount, stepLexGetTokenStride,
  stepLexGetStringPoolPtr, stepLexGetStringPoolLen,
  stepLexGetErrorOffset, stepLexGetErrorCode,
  // step_parser: native entity parser
  ARG_NULL, ARG_REF, ARG_NUMBER, ARG_STRING, ARG_ENUM, ARG_LIST,
  STEP_PARSE_OK, STEP_PARSE_ERR_UNEXPECTED_TOKEN, STEP_PARSE_ERR_ENTITY_OVERFLOW,
  STEP_PARSE_ERR_ARG_OVERFLOW, STEP_PARSE_ERR_MISSING_DATA_SECTION, STEP_PARSE_ERR_BAD_COMPLEX_ENTITY,
  stepParseReset, stepParseRun,
  stepParseGetEntityBufPtr, stepParseGetEntityStride, stepParseGetEntityCount,
  stepParseGetArgBufPtr, stepParseGetArgStride, stepParseGetArgCount,
  stepParseGetErrorCode, stepParseGetErrorTokenIdx,
  // step_topology: native STEP→WASM topology builder (Phase 1)
  STEP_BUILD_OK, STEP_BUILD_ERR_NO_SHELL, STEP_BUILD_ERR_STEP_ID_OVERFLOW,
  STEP_BUILD_ERR_MISSING_ENTITY, STEP_BUILD_ERR_UNSUPPORTED_SURFACE,
  STEP_BUILD_ERR_UNSUPPORTED_CURVE, STEP_BUILD_ERR_BAD_ARGS, STEP_BUILD_ERR_TOPOLOGY_OVERFLOW,
  stepBuildInit, stepBuildRun,
  stepBuildGetSkippedFaceCount, stepBuildGetLastError, stepBuildGetLastErrorStepId,
} from './kernel/index';

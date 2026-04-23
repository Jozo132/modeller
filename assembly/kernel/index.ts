// kernel/index.ts — barrel export for all kernel modules
//
// Re-exports the public API of each kernel sub-module so the main
// assembly/index.ts can import and re-export a single flat namespace.

// ---- core: handle registry ----
export {
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
} from './core';

// ---- topology: B-Rep entities ----
export {
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
  topoGetSummary
} from './topology';

// ---- geometry: NURBS + analytic surface storage ----
export {
  nurbsSurfaceStore, nurbsCurveStore,
  planeStore, cylinderStore, sphereStore, coneStore, torusStore,
  geomPoolRead, getGeomPoolPtr, geomPoolUsed, geomPoolReset, geomPoolSetUsed,
  geomStagingPtr, geomStagingCapacity,
  nurbsSurfaceStoreFromStaging, nurbsCurveStoreFromStaging
} from './geometry';

// ---- transform: f64 rigid body transforms ----
export {
  transformIdentity, transformTranslation, transformRotation, transformScale,
  transformMultiply, transformPoint, transformPointByOutMat,
  transformDirection, transformDirectionByOutMat, transformBoundingBox,
  getTransformOutMatPtr, getTransformOutPtPtr, getTransformOutBoxPtr
} from './transform';

// ---- spatial: octree broadphase ----
export {
  octreeReset, octreeAddFaceAABB, octreeBuild,
  octreeQueryPairs, getOctreePairsPtr, octreeGetPairCount, octreeGetNodeCount
} from './spatial';

// ---- gpu: @unmanaged std430 buffer management ----
export {
  gpuBatchReset, gpuBatchAddSurface,
  getGpuHeaderBufPtr, getGpuHeaderBufLen,
  getGpuCtrlBufPtr, getGpuCtrlBufLen,
  getGpuKnotBufPtr, getGpuKnotBufLen,
  getGpuSurfaceCount
} from './gpu';

// ---- tessellation: native face-level mesh extraction ----
export {
  tessBuildAllFaces, tessBuildFace, tessReset,
  getTessOutVertsPtr, getTessOutNormalsPtr, getTessOutIndicesPtr, getTessOutFaceMapPtr,
  getTessOutVertCount, getTessOutTriCount,
  getEdgeSamplePtsPtr, getEdgeSampleCount, getEdgeSampleStart
} from './tessellation';

// ---- ops: topology-driven boolean classification ----
export {
  CLASSIFY_OUTSIDE, CLASSIFY_INSIDE, CLASSIFY_ON_BOUNDARY, CLASSIFY_UNKNOWN,
  classifyPointVsShell, classifyPointVsTriangles, classifyFacesViaOctree,
  planePlaneIntersect, getPlanePlaneIntersectPtr,
  planeSphereIntersect, getPlaneSphereIntersectPtr,
  planeCylinderIntersect, getPlaneCylinderIntersectPtr,
  planeConeIntersect, getPlaneConeIntersectPtr,
  sphereSphereIntersect, getSphereSphereIntersectPtr,
  getFaceClassification, setFaceClassification,
  pointToPlaneDistance, pointToSphereDistance, pointToCylinderDistance,
  getFaceClassificationPtr,
  isxReset, isxRecord, isxGetErrorBound, isxGetCount,
  isxGetMaxErrorBound, isxAreDistinct, isxRayFace
} from './ops';

// ---- interop: CBREP serialization ----
export {
  cbrepDehydrate, cbrepHydrate, cbrepHydrateForHandle,
  getCbrepOutPtr, getCbrepOutLen
} from './interop';

// ---- step_lexer: native ISO 10303-21 tokenizer ----
export {
  TOKEN_EOF, TOKEN_HASH_ID, TOKEN_HASH_REF, TOKEN_KEYWORD, TOKEN_NUMBER,
  TOKEN_STRING, TOKEN_ENUM, TOKEN_DOLLAR, TOKEN_STAR,
  TOKEN_LPAREN, TOKEN_RPAREN, TOKEN_COMMA, TOKEN_EQUALS, TOKEN_SEMICOLON,
  STEP_LEX_OK, STEP_LEX_ERR_BAD_CHAR, STEP_LEX_ERR_UNTERMINATED_STRING,
  STEP_LEX_ERR_INPUT_TOO_LARGE, STEP_LEX_ERR_TOKEN_OVERFLOW, STEP_LEX_ERR_STRPOOL_OVERFLOW,
  stepLexReset, stepLexRun,
  stepLexGetInputPtr, stepLexGetInputCapacity,
  stepLexGetTokenBufPtr, stepLexGetTokenCount, stepLexGetTokenStride,
  stepLexGetStringPoolPtr, stepLexGetStringPoolLen,
  stepLexGetErrorOffset, stepLexGetErrorCode
} from './step_lexer';

// ---- step_parser: native STEP entity parser (consumes step_lexer tokens) ----
export {
  ARG_NULL, ARG_REF, ARG_NUMBER, ARG_STRING, ARG_ENUM, ARG_LIST,
  STEP_PARSE_OK, STEP_PARSE_ERR_UNEXPECTED_TOKEN, STEP_PARSE_ERR_ENTITY_OVERFLOW,
  STEP_PARSE_ERR_ARG_OVERFLOW, STEP_PARSE_ERR_MISSING_DATA_SECTION, STEP_PARSE_ERR_BAD_COMPLEX_ENTITY,
  stepParseReset, stepParseRun,
  stepParseGetEntityBufPtr, stepParseGetEntityStride, stepParseGetEntityCount,
  stepParseGetArgBufPtr, stepParseGetArgStride, stepParseGetArgCount,
  stepParseGetErrorCode, stepParseGetErrorTokenIdx
} from './step_parser';

// ---- step_topology: native STEP→WASM topology builder (Phase 1) ----
export {
  STEP_BUILD_OK, STEP_BUILD_ERR_NO_SHELL, STEP_BUILD_ERR_STEP_ID_OVERFLOW,
  STEP_BUILD_ERR_MISSING_ENTITY, STEP_BUILD_ERR_UNSUPPORTED_SURFACE,
  STEP_BUILD_ERR_UNSUPPORTED_CURVE, STEP_BUILD_ERR_BAD_ARGS, STEP_BUILD_ERR_TOPOLOGY_OVERFLOW,
  stepBuildInit, stepBuildRun,
  stepBuildGetSkippedFaceCount, stepBuildGetLastError, stepBuildGetLastErrorStepId
} from './step_topology';

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
  handleReleaseAll
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
  bodyBegin, bodyEnd, bodyGetShellCount, bodyGetFirstShell,
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
  classifyPointVsShell, classifyFacesViaOctree,
  getFaceClassification, setFaceClassification,
  pointToPlaneDistance, pointToSphereDistance, pointToCylinderDistance,
  getFaceClassificationPtr,
  isxReset, isxRecord, isxGetErrorBound, isxGetCount,
  isxGetMaxErrorBound, isxAreDistinct, isxRayFace
} from './ops';

// ---- interop: CBREP serialization ----
export {
  cbrepDehydrate, cbrepHydrate,
  getCbrepOutPtr, getCbrepOutLen
} from './interop';

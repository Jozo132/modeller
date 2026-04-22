/** Exported memory */
export declare const memory: WebAssembly.Memory;
/**
 * assembly/index/init
 * @param canvasWidth `i32`
 * @param canvasHeight `i32`
 */
export declare function init(canvasWidth: number, canvasHeight: number): void;
/**
 * assembly/index/resize
 * @param width `i32`
 * @param height `i32`
 */
export declare function resize(width: number, height: number): void;
/**
 * assembly/index/setFov
 * @param fov `f32`
 */
export declare function setFov(fov: number): void;
/**
 * assembly/index/setCameraMode
 * @param mode `i32`
 */
export declare function setCameraMode(mode: number): void;
/**
 * assembly/index/setCameraPosition
 * @param x `f32`
 * @param y `f32`
 * @param z `f32`
 */
export declare function setCameraPosition(x: number, y: number, z: number): void;
/**
 * assembly/index/setCameraTarget
 * @param x `f32`
 * @param y `f32`
 * @param z `f32`
 */
export declare function setCameraTarget(x: number, y: number, z: number): void;
/**
 * assembly/index/setCameraUp
 * @param x `f32`
 * @param y `f32`
 * @param z `f32`
 */
export declare function setCameraUp(x: number, y: number, z: number): void;
/**
 * assembly/index/setOrthoBounds
 * @param left `f32`
 * @param right `f32`
 * @param bottom `f32`
 * @param top `f32`
 */
export declare function setOrthoBounds(left: number, right: number, bottom: number, top: number): void;
/**
 * assembly/index/clearScene
 */
export declare function clearScene(): void;
/**
 * assembly/index/addBox
 * @param sizeX `f32`
 * @param sizeY `f32`
 * @param sizeZ `f32`
 * @param posX `f32`
 * @param posY `f32`
 * @param posZ `f32`
 * @param r `f32`
 * @param g `f32`
 * @param b `f32`
 * @param a `f32`
 * @returns `i32`
 */
export declare function addBox(sizeX: number, sizeY: number, sizeZ: number, posX: number, posY: number, posZ: number, r: number, g: number, b: number, a: number): number;
/**
 * assembly/index/removeNode
 * @param id `i32`
 */
export declare function removeNode(id: number): void;
/**
 * assembly/index/setNodeVisible
 * @param id `i32`
 * @param visible `i32`
 */
export declare function setNodeVisible(id: number, visible: number): void;
/**
 * assembly/index/setNodePosition
 * @param id `i32`
 * @param x `f32`
 * @param y `f32`
 * @param z `f32`
 */
export declare function setNodePosition(id: number, x: number, y: number, z: number): void;
/**
 * assembly/index/setNodeColor
 * @param id `i32`
 * @param r `f32`
 * @param g `f32`
 * @param b `f32`
 * @param a `f32`
 */
export declare function setNodeColor(id: number, r: number, g: number, b: number, a: number): void;
/**
 * assembly/index/setGridVisible
 * @param visible `i32`
 */
export declare function setGridVisible(visible: number): void;
/**
 * assembly/index/setAxesVisible
 * @param visible `i32`
 */
export declare function setAxesVisible(visible: number): void;
/**
 * assembly/index/setGridSize
 * @param size `f32`
 * @param divisions `i32`
 */
export declare function setGridSize(size: number, divisions: number): void;
/**
 * assembly/index/setAxesSize
 * @param size `f32`
 */
export declare function setAxesSize(size: number): void;
/**
 * assembly/index/setOriginPlanesVisible
 * @param mask `i32`
 */
export declare function setOriginPlanesVisible(mask: number): void;
/**
 * assembly/index/setOriginPlaneHovered
 * @param mask `i32`
 */
export declare function setOriginPlaneHovered(mask: number): void;
/**
 * assembly/index/setOriginPlaneSelected
 * @param mask `i32`
 */
export declare function setOriginPlaneSelected(mask: number): void;
/**
 * assembly/index/setMousePosition
 * @param x `f32`
 * @param y `f32`
 */
export declare function setMousePosition(x: number, y: number): void;
/**
 * assembly/index/mouseAction
 * @param action `i32`
 */
export declare function mouseAction(action: number): void;
/**
 * assembly/index/setMouseButton
 * @param button `i32`
 */
export declare function setMouseButton(button: number): void;
/**
 * assembly/index/clearEntities
 */
export declare function clearEntities(): void;
/**
 * assembly/index/addEntitySegment
 * @param x1 `f32`
 * @param y1 `f32`
 * @param x2 `f32`
 * @param y2 `f32`
 * @param flags `i32`
 * @param r `f32`
 * @param g `f32`
 * @param b `f32`
 * @param a `f32`
 * @returns `i32`
 */
export declare function addEntitySegment(x1: number, y1: number, x2: number, y2: number, flags: number, r: number, g: number, b: number, a: number): number;
/**
 * assembly/index/addEntityCircle
 * @param cx `f32`
 * @param cy `f32`
 * @param radius `f32`
 * @param flags `i32`
 * @param r `f32`
 * @param g `f32`
 * @param b `f32`
 * @param a `f32`
 * @returns `i32`
 */
export declare function addEntityCircle(cx: number, cy: number, radius: number, flags: number, r: number, g: number, b: number, a: number): number;
/**
 * assembly/index/addEntityArc
 * @param cx `f32`
 * @param cy `f32`
 * @param radius `f32`
 * @param startAngle `f32`
 * @param endAngle `f32`
 * @param flags `i32`
 * @param r `f32`
 * @param g `f32`
 * @param b `f32`
 * @param a `f32`
 * @returns `i32`
 */
export declare function addEntityArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number, flags: number, r: number, g: number, b: number, a: number): number;
/**
 * assembly/index/addEntityPoint
 * @param x `f32`
 * @param y `f32`
 * @param size `f32`
 * @param flags `i32`
 * @param r `f32`
 * @param g `f32`
 * @param b `f32`
 * @param a `f32`
 * @returns `i32`
 */
export declare function addEntityPoint(x: number, y: number, size: number, flags: number, r: number, g: number, b: number, a: number): number;
/**
 * assembly/index/addEntityDimension
 * @param x1 `f32`
 * @param y1 `f32`
 * @param x2 `f32`
 * @param y2 `f32`
 * @param offset `f32`
 * @param dimType `i32`
 * @param angleStart `f32`
 * @param angleSweep `f32`
 * @param flags `i32`
 * @param r `f32`
 * @param g `f32`
 * @param b `f32`
 * @param a `f32`
 * @returns `i32`
 */
export declare function addEntityDimension(x1: number, y1: number, x2: number, y2: number, offset: number, dimType: number, angleStart: number, angleSweep: number, flags: number, r: number, g: number, b: number, a: number): number;
/**
 * assembly/index/setSnapPosition
 * @param x `f32`
 * @param y `f32`
 * @param visible `i32`
 */
export declare function setSnapPosition(x: number, y: number, visible: number): void;
/**
 * assembly/index/setCursorPosition
 * @param x `f32`
 * @param y `f32`
 * @param visible `i32`
 */
export declare function setCursorPosition(x: number, y: number, visible: number): void;
/**
 * assembly/index/clearSolver
 */
export declare function clearSolver(): void;
/**
 * assembly/index/addSolverPoint
 * @param x `f32`
 * @param y `f32`
 * @param fixed `i32`
 * @returns `i32`
 */
export declare function addSolverPoint(x: number, y: number, fixed: number): number;
/**
 * assembly/index/addSolverConstraint
 * @param type `i32`
 * @param p1 `i32`
 * @param p2 `i32`
 * @param p3 `i32`
 * @param p4 `i32`
 * @param value `f32`
 * @returns `i32`
 */
export declare function addSolverConstraint(type: number, p1: number, p2: number, p3: number, p4: number, value: number): number;
/**
 * assembly/index/solveSolver
 * @returns `i32`
 */
export declare function solveSolver(): number;
/**
 * assembly/index/getSolverPointX
 * @param index `i32`
 * @returns `f32`
 */
export declare function getSolverPointX(index: number): number;
/**
 * assembly/index/getSolverPointY
 * @param index `i32`
 * @returns `f32`
 */
export declare function getSolverPointY(index: number): number;
/**
 * assembly/index/getSolverConverged
 * @returns `i32`
 */
export declare function getSolverConverged(): number;
/**
 * assembly/index/getSolverIterations
 * @returns `i32`
 */
export declare function getSolverIterations(): number;
/**
 * assembly/index/getSolverMaxError
 * @returns `f32`
 */
export declare function getSolverMaxError(): number;
/**
 * assembly/index/render
 */
export declare function render(): void;
/**
 * assembly/index/getCommandBufferPtr
 * @returns `usize`
 */
export declare function getCommandBufferPtr(): number;
/**
 * assembly/index/getCommandBufferLen
 * @returns `i32`
 */
export declare function getCommandBufferLen(): number;
/** assembly/index/ENTITY_FLAG_VISIBLE */
export declare const ENTITY_FLAG_VISIBLE: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/ENTITY_FLAG_SELECTED */
export declare const ENTITY_FLAG_SELECTED: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/ENTITY_FLAG_CONSTRUCTION */
export declare const ENTITY_FLAG_CONSTRUCTION: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/ENTITY_FLAG_HOVER */
export declare const ENTITY_FLAG_HOVER: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/ENTITY_FLAG_FIXED */
export declare const ENTITY_FLAG_FIXED: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/ENTITY_FLAG_PREVIEW */
export declare const ENTITY_FLAG_PREVIEW: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/SOLVER_COINCIDENT */
export declare const SOLVER_COINCIDENT: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/SOLVER_HORIZONTAL */
export declare const SOLVER_HORIZONTAL: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/SOLVER_VERTICAL */
export declare const SOLVER_VERTICAL: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/SOLVER_DISTANCE */
export declare const SOLVER_DISTANCE: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/SOLVER_FIXED */
export declare const SOLVER_FIXED: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/SOLVER_PARALLEL */
export declare const SOLVER_PARALLEL: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/SOLVER_PERPENDICULAR */
export declare const SOLVER_PERPENDICULAR: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/SOLVER_EQUAL_LENGTH */
export declare const SOLVER_EQUAL_LENGTH: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/SOLVER_TANGENT */
export declare const SOLVER_TANGENT: {
  /** @type `i32` */
  get value(): number
};
/** assembly/index/SOLVER_ANGLE */
export declare const SOLVER_ANGLE: {
  /** @type `i32` */
  get value(): number
};
/**
 * assembly/render2d/setEntityModelMatrix
 * @param m00 `f32`
 * @param m01 `f32`
 * @param m02 `f32`
 * @param m03 `f32`
 * @param m10 `f32`
 * @param m11 `f32`
 * @param m12 `f32`
 * @param m13 `f32`
 * @param m20 `f32`
 * @param m21 `f32`
 * @param m22 `f32`
 * @param m23 `f32`
 * @param m30 `f32`
 * @param m31 `f32`
 * @param m32 `f32`
 * @param m33 `f32`
 */
export declare function setEntityModelMatrix(m00: number, m01: number, m02: number, m03: number, m10: number, m11: number, m12: number, m13: number, m20: number, m21: number, m22: number, m23: number, m30: number, m31: number, m32: number, m33: number): void;
/**
 * assembly/render2d/resetEntityModelMatrix
 */
export declare function resetEntityModelMatrix(): void;
/**
 * assembly/nurbs/getResultPtr
 * @returns `usize`
 */
export declare function getResultPtr(): number;
/**
 * assembly/nurbs/getTessVertsPtr
 * @returns `usize`
 */
export declare function getTessVertsPtr(): number;
/**
 * assembly/nurbs/getTessNormalsPtr
 * @returns `usize`
 */
export declare function getTessNormalsPtr(): number;
/**
 * assembly/nurbs/getTessFacesPtr
 * @returns `usize`
 */
export declare function getTessFacesPtr(): number;
/**
 * assembly/nurbs/getCurvePtsPtr
 * @returns `usize`
 */
export declare function getCurvePtsPtr(): number;
/**
 * assembly/nurbs/nurbsCurveEvaluate
 * @param degree `i32`
 * @param nCtrl `i32`
 * @param ctrlPts `~lib/typedarray/Float64Array`
 * @param knots `~lib/typedarray/Float64Array`
 * @param weights `~lib/typedarray/Float64Array`
 * @param t `f64`
 */
export declare function nurbsCurveEvaluate(degree: number, nCtrl: number, ctrlPts: Float64Array, knots: Float64Array, weights: Float64Array, t: number): void;
/**
 * assembly/nurbs/nurbsCurveTessellate
 * @param degree `i32`
 * @param nCtrl `i32`
 * @param ctrlPts `~lib/typedarray/Float64Array`
 * @param knots `~lib/typedarray/Float64Array`
 * @param weights `~lib/typedarray/Float64Array`
 * @param segments `i32`
 * @returns `i32`
 */
export declare function nurbsCurveTessellate(degree: number, nCtrl: number, ctrlPts: Float64Array, knots: Float64Array, weights: Float64Array, segments: number): number;
/**
 * assembly/nurbs/nurbsSurfaceEvaluate
 * @param degU `i32`
 * @param degV `i32`
 * @param nRowsU `i32`
 * @param nColsV `i32`
 * @param ctrlPts `~lib/typedarray/Float64Array`
 * @param knotsU `~lib/typedarray/Float64Array`
 * @param knotsV `~lib/typedarray/Float64Array`
 * @param weights `~lib/typedarray/Float64Array`
 * @param u `f64`
 * @param v `f64`
 */
export declare function nurbsSurfaceEvaluate(degU: number, degV: number, nRowsU: number, nColsV: number, ctrlPts: Float64Array, knotsU: Float64Array, knotsV: Float64Array, weights: Float64Array, u: number, v: number): void;
/**
 * assembly/nurbs/nurbsSurfaceNormal
 * @param degU `i32`
 * @param degV `i32`
 * @param nRowsU `i32`
 * @param nColsV `i32`
 * @param ctrlPts `~lib/typedarray/Float64Array`
 * @param knotsU `~lib/typedarray/Float64Array`
 * @param knotsV `~lib/typedarray/Float64Array`
 * @param weights `~lib/typedarray/Float64Array`
 * @param u `f64`
 * @param v `f64`
 */
export declare function nurbsSurfaceNormal(degU: number, degV: number, nRowsU: number, nColsV: number, ctrlPts: Float64Array, knotsU: Float64Array, knotsV: Float64Array, weights: Float64Array, u: number, v: number): void;
/**
 * assembly/nurbs/nurbsSurfaceTessellate
 * @param degU `i32`
 * @param degV `i32`
 * @param nRowsU `i32`
 * @param nColsV `i32`
 * @param ctrlPts `~lib/typedarray/Float64Array`
 * @param knotsU `~lib/typedarray/Float64Array`
 * @param knotsV `~lib/typedarray/Float64Array`
 * @param weights `~lib/typedarray/Float64Array`
 * @param segsU `i32`
 * @param segsV `i32`
 * @returns `i32`
 */
export declare function nurbsSurfaceTessellate(degU: number, degV: number, nRowsU: number, nColsV: number, ctrlPts: Float64Array, knotsU: Float64Array, knotsV: Float64Array, weights: Float64Array, segsU: number, segsV: number): number;
/**
 * assembly/nurbs/getDerivBufPtr
 * @returns `usize`
 */
export declare function getDerivBufPtr(): number;
/**
 * assembly/nurbs/getBatchBufPtr
 * @returns `usize`
 */
export declare function getBatchBufPtr(): number;
/**
 * assembly/nurbs/getBatchBufLen
 * @returns `i32`
 */
export declare function getBatchBufLen(): number;
/**
 * assembly/nurbs/getMaxTessSegs
 * @returns `i32`
 */
export declare function getMaxTessSegs(): number;
/**
 * assembly/nurbs/getMaxCurveSegs
 * @returns `i32`
 */
export declare function getMaxCurveSegs(): number;
/**
 * assembly/nurbs/nurbsCurveDerivEval
 * @param degree `i32`
 * @param nCtrl `i32`
 * @param ctrlPts `~lib/typedarray/Float64Array`
 * @param knots `~lib/typedarray/Float64Array`
 * @param weights `~lib/typedarray/Float64Array`
 * @param t `f64`
 */
export declare function nurbsCurveDerivEval(degree: number, nCtrl: number, ctrlPts: Float64Array, knots: Float64Array, weights: Float64Array, t: number): void;
/**
 * assembly/nurbs/nurbsCurveBatchDerivEval
 * @param degree `i32`
 * @param nCtrl `i32`
 * @param ctrlPts `~lib/typedarray/Float64Array`
 * @param knots `~lib/typedarray/Float64Array`
 * @param weights `~lib/typedarray/Float64Array`
 * @param params `~lib/typedarray/Float64Array`
 * @param count `i32`
 * @returns `i32`
 */
export declare function nurbsCurveBatchDerivEval(degree: number, nCtrl: number, ctrlPts: Float64Array, knots: Float64Array, weights: Float64Array, params: Float64Array, count: number): number;
/**
 * assembly/nurbs/nurbsSurfaceDerivEval
 * @param degU `i32`
 * @param degV `i32`
 * @param nRowsU `i32`
 * @param nColsV `i32`
 * @param ctrlPts `~lib/typedarray/Float64Array`
 * @param knotsU `~lib/typedarray/Float64Array`
 * @param knotsV `~lib/typedarray/Float64Array`
 * @param weights `~lib/typedarray/Float64Array`
 * @param u `f64`
 * @param v `f64`
 */
export declare function nurbsSurfaceDerivEval(degU: number, degV: number, nRowsU: number, nColsV: number, ctrlPts: Float64Array, knotsU: Float64Array, knotsV: Float64Array, weights: Float64Array, u: number, v: number): void;
/**
 * assembly/nurbs/nurbsSurfaceBatchDerivEval
 * @param degU `i32`
 * @param degV `i32`
 * @param nRowsU `i32`
 * @param nColsV `i32`
 * @param ctrlPts `~lib/typedarray/Float64Array`
 * @param knotsU `~lib/typedarray/Float64Array`
 * @param knotsV `~lib/typedarray/Float64Array`
 * @param weights `~lib/typedarray/Float64Array`
 * @param params `~lib/typedarray/Float64Array`
 * @param count `i32`
 * @returns `i32`
 */
export declare function nurbsSurfaceBatchDerivEval(degU: number, degV: number, nRowsU: number, nColsV: number, ctrlPts: Float64Array, knotsU: Float64Array, knotsV: Float64Array, weights: Float64Array, params: Float64Array, count: number): number;
/**
 * assembly/tessellation/earClipTriangulate
 * @param coords `~lib/typedarray/Float64Array`
 * @param nVerts `i32`
 * @param outTris `~lib/typedarray/Uint32Array`
 * @returns `i32`
 */
export declare function earClipTriangulate(coords: Float64Array, nVerts: number, outTris: Uint32Array): number;
/**
 * assembly/tessellation/computeTriangleNormal
 * @param verts `~lib/typedarray/Float64Array`
 * @param i0 `i32`
 * @param i1 `i32`
 * @param i2 `i32`
 * @param outNormal `~lib/typedarray/Float64Array`
 */
export declare function computeTriangleNormal(verts: Float64Array, i0: number, i1: number, i2: number, outNormal: Float64Array): void;
/**
 * assembly/tessellation/computeBoundingBox
 * @param verts `~lib/typedarray/Float64Array`
 * @param nVerts `i32`
 * @param outBox `~lib/typedarray/Float64Array`
 */
export declare function computeBoundingBox(verts: Float64Array, nVerts: number, outBox: Float64Array): void;
/**
 * assembly/tessellation/computeMeshVolume
 * @param verts `~lib/typedarray/Float64Array`
 * @param faces `~lib/typedarray/Uint32Array`
 * @param nTris `i32`
 * @returns `f64`
 */
export declare function computeMeshVolume(verts: Float64Array, faces: Uint32Array, nTris: number): number;
/** assembly/kernel/core/HANDLE_NONE */
export declare const HANDLE_NONE: {
  /** @type `u32` */
  get value(): number
};
/** assembly/kernel/core/RESIDENCY_UNMATERIALIZED */
export declare const RESIDENCY_UNMATERIALIZED: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/core/RESIDENCY_HYDRATING */
export declare const RESIDENCY_HYDRATING: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/core/RESIDENCY_RESIDENT */
export declare const RESIDENCY_RESIDENT: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/core/RESIDENCY_STALE */
export declare const RESIDENCY_STALE: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/core/RESIDENCY_DISPOSED */
export declare const RESIDENCY_DISPOSED: {
  /** @type `u8` */
  get value(): number
};
/**
 * assembly/kernel/core/handleAlloc
 * @returns `u32`
 */
export declare function handleAlloc(): number;
/**
 * assembly/kernel/core/handleRelease
 * @param id `u32`
 */
export declare function handleRelease(id: number): void;
/**
 * assembly/kernel/core/handleAddRef
 * @param id `u32`
 */
export declare function handleAddRef(id: number): void;
/**
 * assembly/kernel/core/handleIsValid
 * @param id `u32`
 * @returns `bool`
 */
export declare function handleIsValid(id: number): boolean;
/**
 * assembly/kernel/core/handleGetResidency
 * @param id `u32`
 * @returns `u8`
 */
export declare function handleGetResidency(id: number): number;
/**
 * assembly/kernel/core/handleSetResidency
 * @param id `u32`
 * @param state `u8`
 */
export declare function handleSetResidency(id: number, state: number): void;
/**
 * assembly/kernel/core/handleGetRevision
 * @param id `u32`
 * @returns `u32`
 */
export declare function handleGetRevision(id: number): number;
/**
 * assembly/kernel/core/handleBumpRevision
 * @param id `u32`
 * @returns `u32`
 */
export declare function handleBumpRevision(id: number): number;
/**
 * assembly/kernel/core/handleSetFeatureId
 * @param id `u32`
 * @param fid `u32`
 */
export declare function handleSetFeatureId(id: number, fid: number): void;
/**
 * assembly/kernel/core/handleGetFeatureId
 * @param id `u32`
 * @returns `u32`
 */
export declare function handleGetFeatureId(id: number): number;
/**
 * assembly/kernel/core/handleSetIrHash
 * @param id `u32`
 * @param hash `u32`
 */
export declare function handleSetIrHash(id: number, hash: number): void;
/**
 * assembly/kernel/core/handleGetIrHash
 * @param id `u32`
 * @returns `u32`
 */
export declare function handleGetIrHash(id: number): number;
/**
 * assembly/kernel/core/handleGetRefCount
 * @param id `u32`
 * @returns `u32`
 */
export declare function handleGetRefCount(id: number): number;
/**
 * assembly/kernel/core/handleLiveCount
 * @returns `u32`
 */
export declare function handleLiveCount(): number;
/**
 * assembly/kernel/core/handleGlobalRevision
 * @returns `u32`
 */
export declare function handleGlobalRevision(): number;
/**
 * assembly/kernel/core/handleReleaseAll
 */
export declare function handleReleaseAll(): void;
/**
 * assembly/kernel/core/handleSetBodyStart
 * @param id `u32`
 * @param vStart `u32`
 * @param eStart `u32`
 * @param ceStart `u32`
 * @param lStart `u32`
 * @param fStart `u32`
 * @param sStart `u32`
 * @param gStart `u32`
 */
export declare function handleSetBodyStart(id: number, vStart: number, eStart: number, ceStart: number, lStart: number, fStart: number, sStart: number, gStart: number): void;
/**
 * assembly/kernel/core/handleSetBodyEnd
 * @param id `u32`
 * @param vEnd `u32`
 * @param eEnd `u32`
 * @param ceEnd `u32`
 * @param lEnd `u32`
 * @param fEnd `u32`
 * @param sEnd `u32`
 * @param gEnd `u32`
 */
export declare function handleSetBodyEnd(id: number, vEnd: number, eEnd: number, ceEnd: number, lEnd: number, fEnd: number, sEnd: number, gEnd: number): void;
/**
 * assembly/kernel/core/handleGetFaceStart
 * @param id `u32`
 * @returns `u32`
 */
export declare function handleGetFaceStart(id: number): number;
/**
 * assembly/kernel/core/handleGetFaceEnd
 * @param id `u32`
 * @returns `u32`
 */
export declare function handleGetFaceEnd(id: number): number;
/**
 * assembly/kernel/core/handleGetVertexStart
 * @param id `u32`
 * @returns `u32`
 */
export declare function handleGetVertexStart(id: number): number;
/**
 * assembly/kernel/core/handleGetVertexEnd
 * @param id `u32`
 * @returns `u32`
 */
export declare function handleGetVertexEnd(id: number): number;
/**
 * assembly/kernel/core/handleGetShellStart
 * @param id `u32`
 * @returns `u32`
 */
export declare function handleGetShellStart(id: number): number;
/**
 * assembly/kernel/core/handleGetShellEnd
 * @param id `u32`
 * @returns `u32`
 */
export declare function handleGetShellEnd(id: number): number;
/**
 * assembly/kernel/core/handleGetGeomStart
 * @param id `u32`
 * @returns `u32`
 */
export declare function handleGetGeomStart(id: number): number;
/**
 * assembly/kernel/core/handleGetGeomEnd
 * @param id `u32`
 * @returns `u32`
 */
export declare function handleGetGeomEnd(id: number): number;
/** assembly/kernel/topology/MAX_VERTICES */
export declare const MAX_VERTICES: {
  /** @type `u32` */
  get value(): number
};
/** assembly/kernel/topology/MAX_EDGES */
export declare const MAX_EDGES: {
  /** @type `u32` */
  get value(): number
};
/** assembly/kernel/topology/MAX_COEDGES */
export declare const MAX_COEDGES: {
  /** @type `u32` */
  get value(): number
};
/** assembly/kernel/topology/MAX_LOOPS */
export declare const MAX_LOOPS: {
  /** @type `u32` */
  get value(): number
};
/** assembly/kernel/topology/MAX_FACES */
export declare const MAX_FACES: {
  /** @type `u32` */
  get value(): number
};
/** assembly/kernel/topology/MAX_SHELLS */
export declare const MAX_SHELLS: {
  /** @type `u32` */
  get value(): number
};
/** assembly/kernel/topology/GEOM_NONE */
export declare const GEOM_NONE: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/topology/GEOM_PLANE */
export declare const GEOM_PLANE: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/topology/GEOM_CYLINDER */
export declare const GEOM_CYLINDER: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/topology/GEOM_CONE */
export declare const GEOM_CONE: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/topology/GEOM_SPHERE */
export declare const GEOM_SPHERE: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/topology/GEOM_TORUS */
export declare const GEOM_TORUS: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/topology/GEOM_NURBS_SURFACE */
export declare const GEOM_NURBS_SURFACE: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/topology/GEOM_LINE */
export declare const GEOM_LINE: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/topology/GEOM_CIRCLE */
export declare const GEOM_CIRCLE: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/topology/GEOM_ELLIPSE */
export declare const GEOM_ELLIPSE: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/topology/GEOM_NURBS_CURVE */
export declare const GEOM_NURBS_CURVE: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/topology/ORIENT_FORWARD */
export declare const ORIENT_FORWARD: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/topology/ORIENT_REVERSED */
export declare const ORIENT_REVERSED: {
  /** @type `u8` */
  get value(): number
};
/**
 * assembly/kernel/topology/vertexAdd
 * @param x `f64`
 * @param y `f64`
 * @param z `f64`
 * @returns `u32`
 */
export declare function vertexAdd(x: number, y: number, z: number): number;
/**
 * assembly/kernel/topology/vertexGetX
 * @param id `u32`
 * @returns `f64`
 */
export declare function vertexGetX(id: number): number;
/**
 * assembly/kernel/topology/vertexGetY
 * @param id `u32`
 * @returns `f64`
 */
export declare function vertexGetY(id: number): number;
/**
 * assembly/kernel/topology/vertexGetZ
 * @param id `u32`
 * @returns `f64`
 */
export declare function vertexGetZ(id: number): number;
/**
 * assembly/kernel/topology/vertexGetCount
 * @returns `u32`
 */
export declare function vertexGetCount(): number;
/**
 * assembly/kernel/topology/edgeAdd
 * @param startV `u32`
 * @param endV `u32`
 * @param geomType `u8`
 * @param geomOffset `u32`
 * @returns `u32`
 */
export declare function edgeAdd(startV: number, endV: number, geomType: number, geomOffset: number): number;
/**
 * assembly/kernel/topology/edgeGetStartVertex
 * @param id `u32`
 * @returns `u32`
 */
export declare function edgeGetStartVertex(id: number): number;
/**
 * assembly/kernel/topology/edgeGetEndVertex
 * @param id `u32`
 * @returns `u32`
 */
export declare function edgeGetEndVertex(id: number): number;
/**
 * assembly/kernel/topology/edgeGetGeomType
 * @param id `u32`
 * @returns `u8`
 */
export declare function edgeGetGeomType(id: number): number;
/**
 * assembly/kernel/topology/edgeGetGeomOffset
 * @param id `u32`
 * @returns `u32`
 */
export declare function edgeGetGeomOffset(id: number): number;
/**
 * assembly/kernel/topology/edgeGetCount
 * @returns `u32`
 */
export declare function edgeGetCount(): number;
/**
 * assembly/kernel/topology/coedgeAdd
 * @param edgeId `u32`
 * @param orient `u8`
 * @param nextCoedge `u32`
 * @param loopId `u32`
 * @returns `u32`
 */
export declare function coedgeAdd(edgeId: number, orient: number, nextCoedge: number, loopId: number): number;
/**
 * assembly/kernel/topology/coedgeGetEdge
 * @param id `u32`
 * @returns `u32`
 */
export declare function coedgeGetEdge(id: number): number;
/**
 * assembly/kernel/topology/coedgeGetOrient
 * @param id `u32`
 * @returns `u8`
 */
export declare function coedgeGetOrient(id: number): number;
/**
 * assembly/kernel/topology/coedgeGetNext
 * @param id `u32`
 * @returns `u32`
 */
export declare function coedgeGetNext(id: number): number;
/**
 * assembly/kernel/topology/coedgeGetLoop
 * @param id `u32`
 * @returns `u32`
 */
export declare function coedgeGetLoop(id: number): number;
/**
 * assembly/kernel/topology/coedgeSetNext
 * @param id `u32`
 * @param nextId `u32`
 */
export declare function coedgeSetNext(id: number, nextId: number): void;
/**
 * assembly/kernel/topology/coedgeGetCount
 * @returns `u32`
 */
export declare function coedgeGetCount(): number;
/**
 * assembly/kernel/topology/loopAdd
 * @param firstCoedge `u32`
 * @param faceId `u32`
 * @param isOuter `u8`
 * @returns `u32`
 */
export declare function loopAdd(firstCoedge: number, faceId: number, isOuter: number): number;
/**
 * assembly/kernel/topology/loopGetFirstCoedge
 * @param id `u32`
 * @returns `u32`
 */
export declare function loopGetFirstCoedge(id: number): number;
/**
 * assembly/kernel/topology/loopGetFace
 * @param id `u32`
 * @returns `u32`
 */
export declare function loopGetFace(id: number): number;
/**
 * assembly/kernel/topology/loopIsOuterLoop
 * @param id `u32`
 * @returns `u8`
 */
export declare function loopIsOuterLoop(id: number): number;
/**
 * assembly/kernel/topology/loopGetCount
 * @returns `u32`
 */
export declare function loopGetCount(): number;
/**
 * assembly/kernel/topology/faceAdd
 * @param firstLoop `u32`
 * @param shellId `u32`
 * @param geomType `u8`
 * @param geomOffset `u32`
 * @param orient `u8`
 * @param numLoops `u32`
 * @returns `u32`
 */
export declare function faceAdd(firstLoop: number, shellId: number, geomType: number, geomOffset: number, orient: number, numLoops: number): number;
/**
 * assembly/kernel/topology/faceGetFirstLoop
 * @param id `u32`
 * @returns `u32`
 */
export declare function faceGetFirstLoop(id: number): number;
/**
 * assembly/kernel/topology/faceGetShell
 * @param id `u32`
 * @returns `u32`
 */
export declare function faceGetShell(id: number): number;
/**
 * assembly/kernel/topology/faceGetGeomType
 * @param id `u32`
 * @returns `u8`
 */
export declare function faceGetGeomType(id: number): number;
/**
 * assembly/kernel/topology/faceGetGeomOffset
 * @param id `u32`
 * @returns `u32`
 */
export declare function faceGetGeomOffset(id: number): number;
/**
 * assembly/kernel/topology/faceGetOrient
 * @param id `u32`
 * @returns `u8`
 */
export declare function faceGetOrient(id: number): number;
/**
 * assembly/kernel/topology/faceGetLoopCount
 * @param id `u32`
 * @returns `u32`
 */
export declare function faceGetLoopCount(id: number): number;
/**
 * assembly/kernel/topology/faceGetCount
 * @returns `u32`
 */
export declare function faceGetCount(): number;
/**
 * assembly/kernel/topology/shellAdd
 * @param firstFace `u32`
 * @param numFaces `u32`
 * @param isClosed `u8`
 * @returns `u32`
 */
export declare function shellAdd(firstFace: number, numFaces: number, isClosed: number): number;
/**
 * assembly/kernel/topology/shellGetFirstFace
 * @param id `u32`
 * @returns `u32`
 */
export declare function shellGetFirstFace(id: number): number;
/**
 * assembly/kernel/topology/shellGetFaceCount
 * @param id `u32`
 * @returns `u32`
 */
export declare function shellGetFaceCount(id: number): number;
/**
 * assembly/kernel/topology/shellIsClosed_
 * @param id `u32`
 * @returns `u8`
 */
export declare function shellIsClosed_(id: number): number;
/**
 * assembly/kernel/topology/shellGetCount
 * @returns `u32`
 */
export declare function shellGetCount(): number;
/**
 * assembly/kernel/topology/bodyBegin
 */
export declare function bodyBegin(): void;
/**
 * assembly/kernel/topology/bodyEnd
 * @returns `u32`
 */
export declare function bodyEnd(): number;
/**
 * assembly/kernel/topology/bodyBeginForHandle
 * @param handleId `u32`
 */
export declare function bodyBeginForHandle(handleId: number): void;
/**
 * assembly/kernel/topology/bodyEndForHandle
 * @returns `u32`
 */
export declare function bodyEndForHandle(): number;
/**
 * assembly/kernel/topology/topologyResetAll
 */
export declare function topologyResetAll(): void;
/**
 * assembly/kernel/topology/bodyGetShellCount
 * @returns `u32`
 */
export declare function bodyGetShellCount(): number;
/**
 * assembly/kernel/topology/bodyGetFirstShell
 * @returns `u32`
 */
export declare function bodyGetFirstShell(): number;
/**
 * assembly/kernel/topology/getVertexCoordsPtr
 * @returns `usize`
 */
export declare function getVertexCoordsPtr(): number;
/**
 * assembly/kernel/topology/getVertexCoordsLen
 * @returns `u32`
 */
export declare function getVertexCoordsLen(): number;
/**
 * assembly/kernel/topology/getEdgeStartVertexPtr
 * @returns `usize`
 */
export declare function getEdgeStartVertexPtr(): number;
/**
 * assembly/kernel/topology/getEdgeEndVertexPtr
 * @returns `usize`
 */
export declare function getEdgeEndVertexPtr(): number;
/**
 * assembly/kernel/topology/topoGetSummary
 * @param outBuf `~lib/staticarray/StaticArray<u32>`
 */
export declare function topoGetSummary(outBuf: ArrayLike<number>): void;
/**
 * assembly/kernel/geometry/nurbsSurfaceStore
 * @param degreeU `u32`
 * @param degreeV `u32`
 * @param numCtrlU `u32`
 * @param numCtrlV `u32`
 * @param knotsU `~lib/staticarray/StaticArray<f64>`
 * @param knotsV `~lib/staticarray/StaticArray<f64>`
 * @param ctrlPts `~lib/staticarray/StaticArray<f64>`
 * @param weights `~lib/staticarray/StaticArray<f64>`
 * @returns `u32`
 */
export declare function nurbsSurfaceStore(degreeU: number, degreeV: number, numCtrlU: number, numCtrlV: number, knotsU: ArrayLike<number>, knotsV: ArrayLike<number>, ctrlPts: ArrayLike<number>, weights: ArrayLike<number>): number;
/**
 * assembly/kernel/geometry/nurbsCurveStore
 * @param degree `u32`
 * @param numCtrl `u32`
 * @param knots `~lib/staticarray/StaticArray<f64>`
 * @param ctrlPts `~lib/staticarray/StaticArray<f64>`
 * @param weights `~lib/staticarray/StaticArray<f64>`
 * @returns `u32`
 */
export declare function nurbsCurveStore(degree: number, numCtrl: number, knots: ArrayLike<number>, ctrlPts: ArrayLike<number>, weights: ArrayLike<number>): number;
/**
 * assembly/kernel/geometry/planeStore
 * @param ox `f64`
 * @param oy `f64`
 * @param oz `f64`
 * @param nx `f64`
 * @param ny `f64`
 * @param nz `f64`
 * @param rx `f64`
 * @param ry `f64`
 * @param rz `f64`
 * @returns `u32`
 */
export declare function planeStore(ox: number, oy: number, oz: number, nx: number, ny: number, nz: number, rx: number, ry: number, rz: number): number;
/**
 * assembly/kernel/geometry/cylinderStore
 * @param ox `f64`
 * @param oy `f64`
 * @param oz `f64`
 * @param ax `f64`
 * @param ay `f64`
 * @param az `f64`
 * @param rx `f64`
 * @param ry `f64`
 * @param rz `f64`
 * @param radius `f64`
 * @returns `u32`
 */
export declare function cylinderStore(ox: number, oy: number, oz: number, ax: number, ay: number, az: number, rx: number, ry: number, rz: number, radius: number): number;
/**
 * assembly/kernel/geometry/sphereStore
 * @param cx `f64`
 * @param cy `f64`
 * @param cz `f64`
 * @param ax `f64`
 * @param ay `f64`
 * @param az `f64`
 * @param rx `f64`
 * @param ry `f64`
 * @param rz `f64`
 * @param radius `f64`
 * @returns `u32`
 */
export declare function sphereStore(cx: number, cy: number, cz: number, ax: number, ay: number, az: number, rx: number, ry: number, rz: number, radius: number): number;
/**
 * assembly/kernel/geometry/coneStore
 * @param ox `f64`
 * @param oy `f64`
 * @param oz `f64`
 * @param ax `f64`
 * @param ay `f64`
 * @param az `f64`
 * @param rx `f64`
 * @param ry `f64`
 * @param rz `f64`
 * @param radius `f64`
 * @param semiAngle `f64`
 * @returns `u32`
 */
export declare function coneStore(ox: number, oy: number, oz: number, ax: number, ay: number, az: number, rx: number, ry: number, rz: number, radius: number, semiAngle: number): number;
/**
 * assembly/kernel/geometry/torusStore
 * @param cx `f64`
 * @param cy `f64`
 * @param cz `f64`
 * @param ax `f64`
 * @param ay `f64`
 * @param az `f64`
 * @param rx `f64`
 * @param ry `f64`
 * @param rz `f64`
 * @param majorRadius `f64`
 * @param minorRadius `f64`
 * @returns `u32`
 */
export declare function torusStore(cx: number, cy: number, cz: number, ax: number, ay: number, az: number, rx: number, ry: number, rz: number, majorRadius: number, minorRadius: number): number;
/**
 * assembly/kernel/geometry/geomPoolRead
 * @param offset `u32`
 * @returns `f64`
 */
export declare function geomPoolRead(offset: number): number;
/**
 * assembly/kernel/geometry/getGeomPoolPtr
 * @returns `usize`
 */
export declare function getGeomPoolPtr(): number;
/**
 * assembly/kernel/geometry/geomPoolUsed
 * @returns `u32`
 */
export declare function geomPoolUsed(): number;
/**
 * assembly/kernel/geometry/geomPoolReset
 */
export declare function geomPoolReset(): void;
/**
 * assembly/kernel/geometry/geomPoolSetUsed
 * @param count `u32`
 */
export declare function geomPoolSetUsed(count: number): void;
/**
 * assembly/kernel/geometry/geomStagingPtr
 * @returns `usize`
 */
export declare function geomStagingPtr(): number;
/**
 * assembly/kernel/geometry/geomStagingCapacity
 * @returns `u32`
 */
export declare function geomStagingCapacity(): number;
/**
 * assembly/kernel/geometry/nurbsSurfaceStoreFromStaging
 * @param degreeU `u32`
 * @param degreeV `u32`
 * @param numCtrlU `u32`
 * @param numCtrlV `u32`
 * @param nKnotsU `u32`
 * @param nKnotsV `u32`
 * @returns `u32`
 */
export declare function nurbsSurfaceStoreFromStaging(degreeU: number, degreeV: number, numCtrlU: number, numCtrlV: number, nKnotsU: number, nKnotsV: number): number;
/**
 * assembly/kernel/geometry/nurbsCurveStoreFromStaging
 * @param degree `u32`
 * @param numCtrl `u32`
 * @param nKnots `u32`
 * @returns `u32`
 */
export declare function nurbsCurveStoreFromStaging(degree: number, numCtrl: number, nKnots: number): number;
/**
 * assembly/kernel/transform/transformIdentity
 */
export declare function transformIdentity(): void;
/**
 * assembly/kernel/transform/transformTranslation
 * @param tx `f64`
 * @param ty `f64`
 * @param tz `f64`
 */
export declare function transformTranslation(tx: number, ty: number, tz: number): void;
/**
 * assembly/kernel/transform/transformRotation
 * @param axisX `f64`
 * @param axisY `f64`
 * @param axisZ `f64`
 * @param angle `f64`
 */
export declare function transformRotation(axisX: number, axisY: number, axisZ: number, angle: number): void;
/**
 * assembly/kernel/transform/transformScale
 * @param sx `f64`
 * @param sy `f64`
 * @param sz `f64`
 */
export declare function transformScale(sx: number, sy: number, sz: number): void;
/**
 * assembly/kernel/transform/transformMultiply
 * @param a `~lib/staticarray/StaticArray<f64>`
 * @param b `~lib/staticarray/StaticArray<f64>`
 */
export declare function transformMultiply(a: ArrayLike<number>, b: ArrayLike<number>): void;
/**
 * assembly/kernel/transform/transformPoint
 * @param mat `~lib/staticarray/StaticArray<f64>`
 * @param px `f64`
 * @param py `f64`
 * @param pz `f64`
 */
export declare function transformPoint(mat: ArrayLike<number>, px: number, py: number, pz: number): void;
/**
 * assembly/kernel/transform/transformPointByOutMat
 * @param px `f64`
 * @param py `f64`
 * @param pz `f64`
 */
export declare function transformPointByOutMat(px: number, py: number, pz: number): void;
/**
 * assembly/kernel/transform/transformDirection
 * @param mat `~lib/staticarray/StaticArray<f64>`
 * @param dx `f64`
 * @param dy `f64`
 * @param dz `f64`
 */
export declare function transformDirection(mat: ArrayLike<number>, dx: number, dy: number, dz: number): void;
/**
 * assembly/kernel/transform/transformDirectionByOutMat
 * @param dx `f64`
 * @param dy `f64`
 * @param dz `f64`
 */
export declare function transformDirectionByOutMat(dx: number, dy: number, dz: number): void;
/**
 * assembly/kernel/transform/transformBoundingBox
 * @param mat `~lib/staticarray/StaticArray<f64>`
 * @param verts `~lib/staticarray/StaticArray<f64>`
 * @param nVerts `u32`
 */
export declare function transformBoundingBox(mat: ArrayLike<number>, verts: ArrayLike<number>, nVerts: number): void;
/**
 * assembly/kernel/transform/getTransformOutMatPtr
 * @returns `usize`
 */
export declare function getTransformOutMatPtr(): number;
/**
 * assembly/kernel/transform/getTransformOutPtPtr
 * @returns `usize`
 */
export declare function getTransformOutPtPtr(): number;
/**
 * assembly/kernel/transform/getTransformOutBoxPtr
 * @returns `usize`
 */
export declare function getTransformOutBoxPtr(): number;
/**
 * assembly/kernel/spatial/octreeReset
 */
export declare function octreeReset(): void;
/**
 * assembly/kernel/spatial/octreeAddFaceAABB
 * @param faceId `u32`
 * @param minX `f64`
 * @param minY `f64`
 * @param minZ `f64`
 * @param maxX `f64`
 * @param maxY `f64`
 * @param maxZ `f64`
 */
export declare function octreeAddFaceAABB(faceId: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void;
/**
 * assembly/kernel/spatial/octreeBuild
 */
export declare function octreeBuild(): void;
/**
 * assembly/kernel/spatial/octreeQueryPairs
 * @param aFaceStart `u32`
 * @param aFaceEnd `u32`
 * @param bFaceStart `u32`
 * @param bFaceEnd `u32`
 * @returns `u32`
 */
export declare function octreeQueryPairs(aFaceStart: number, aFaceEnd: number, bFaceStart: number, bFaceEnd: number): number;
/**
 * assembly/kernel/spatial/getOctreePairsPtr
 * @returns `usize`
 */
export declare function getOctreePairsPtr(): number;
/**
 * assembly/kernel/spatial/octreeGetPairCount
 * @returns `u32`
 */
export declare function octreeGetPairCount(): number;
/**
 * assembly/kernel/spatial/octreeGetNodeCount
 * @returns `u32`
 */
export declare function octreeGetNodeCount(): number;
/**
 * assembly/kernel/gpu/gpuBatchReset
 */
export declare function gpuBatchReset(): void;
/**
 * assembly/kernel/gpu/gpuBatchAddSurface
 * @param degreeU `u32`
 * @param degreeV `u32`
 * @param numCtrlU `u32`
 * @param numCtrlV `u32`
 * @param knotsU `~lib/staticarray/StaticArray<f32>`
 * @param knotsV `~lib/staticarray/StaticArray<f32>`
 * @param ctrlPts `~lib/staticarray/StaticArray<f32>`
 * @param tessSegsU `u32`
 * @param tessSegsV `u32`
 * @returns `u32`
 */
export declare function gpuBatchAddSurface(degreeU: number, degreeV: number, numCtrlU: number, numCtrlV: number, knotsU: ArrayLike<number>, knotsV: ArrayLike<number>, ctrlPts: ArrayLike<number>, tessSegsU: number, tessSegsV: number): number;
/**
 * assembly/kernel/gpu/getGpuHeaderBufPtr
 * @returns `usize`
 */
export declare function getGpuHeaderBufPtr(): number;
/**
 * assembly/kernel/gpu/getGpuHeaderBufLen
 * @returns `u32`
 */
export declare function getGpuHeaderBufLen(): number;
/**
 * assembly/kernel/gpu/getGpuCtrlBufPtr
 * @returns `usize`
 */
export declare function getGpuCtrlBufPtr(): number;
/**
 * assembly/kernel/gpu/getGpuCtrlBufLen
 * @returns `u32`
 */
export declare function getGpuCtrlBufLen(): number;
/**
 * assembly/kernel/gpu/getGpuKnotBufPtr
 * @returns `usize`
 */
export declare function getGpuKnotBufPtr(): number;
/**
 * assembly/kernel/gpu/getGpuKnotBufLen
 * @returns `u32`
 */
export declare function getGpuKnotBufLen(): number;
/**
 * assembly/kernel/gpu/getGpuSurfaceCount
 * @returns `u32`
 */
export declare function getGpuSurfaceCount(): number;
/**
 * assembly/kernel/tessellation/tessBuildAllFaces
 * @param segsU `i32`
 * @param segsV `i32`
 * @returns `i32`
 */
export declare function tessBuildAllFaces(segsU: number, segsV: number): number;
/**
 * assembly/kernel/tessellation/tessBuildFace
 * @param faceId `u32`
 * @param segsU `i32`
 * @param segsV `i32`
 * @returns `i32`
 */
export declare function tessBuildFace(faceId: number, segsU: number, segsV: number): number;
/**
 * assembly/kernel/tessellation/tessReset
 */
export declare function tessReset(): void;
/**
 * assembly/kernel/tessellation/getTessOutVertsPtr
 * @returns `usize`
 */
export declare function getTessOutVertsPtr(): number;
/**
 * assembly/kernel/tessellation/getTessOutNormalsPtr
 * @returns `usize`
 */
export declare function getTessOutNormalsPtr(): number;
/**
 * assembly/kernel/tessellation/getTessOutIndicesPtr
 * @returns `usize`
 */
export declare function getTessOutIndicesPtr(): number;
/**
 * assembly/kernel/tessellation/getTessOutFaceMapPtr
 * @returns `usize`
 */
export declare function getTessOutFaceMapPtr(): number;
/**
 * assembly/kernel/tessellation/getTessOutVertCount
 * @returns `u32`
 */
export declare function getTessOutVertCount(): number;
/**
 * assembly/kernel/tessellation/getTessOutTriCount
 * @returns `u32`
 */
export declare function getTessOutTriCount(): number;
/**
 * assembly/kernel/tessellation/getEdgeSamplePtsPtr
 * @returns `usize`
 */
export declare function getEdgeSamplePtsPtr(): number;
/**
 * assembly/kernel/tessellation/getEdgeSampleCount
 * @param edgeId `u32`
 * @returns `u32`
 */
export declare function getEdgeSampleCount(edgeId: number): number;
/**
 * assembly/kernel/tessellation/getEdgeSampleStart
 * @param edgeId `u32`
 * @returns `u32`
 */
export declare function getEdgeSampleStart(edgeId: number): number;
/** assembly/kernel/ops/CLASSIFY_OUTSIDE */
export declare const CLASSIFY_OUTSIDE: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/ops/CLASSIFY_INSIDE */
export declare const CLASSIFY_INSIDE: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/ops/CLASSIFY_ON_BOUNDARY */
export declare const CLASSIFY_ON_BOUNDARY: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/ops/CLASSIFY_UNKNOWN */
export declare const CLASSIFY_UNKNOWN: {
  /** @type `u8` */
  get value(): number
};
/**
 * assembly/kernel/ops/classifyPointVsShell
 * @param px `f64`
 * @param py `f64`
 * @param pz `f64`
 * @param faceStart `u32`
 * @param faceEnd `u32`
 * @returns `u8`
 */
export declare function classifyPointVsShell(px: number, py: number, pz: number, faceStart: number, faceEnd: number): number;
/**
 * assembly/kernel/ops/classifyFacesViaOctree
 * @param faceStartA `u32`
 * @param faceEndA `u32`
 * @param faceStartB `u32`
 * @param faceEndB `u32`
 * @returns `u32`
 */
export declare function classifyFacesViaOctree(faceStartA: number, faceEndA: number, faceStartB: number, faceEndB: number): number;
/**
 * assembly/kernel/ops/getFaceClassification
 * @param faceId `u32`
 * @returns `u8`
 */
export declare function getFaceClassification(faceId: number): number;
/**
 * assembly/kernel/ops/setFaceClassification
 * @param faceId `u32`
 * @param cls `u8`
 */
export declare function setFaceClassification(faceId: number, cls: number): void;
/**
 * assembly/kernel/ops/pointToPlaneDistance
 * @param px `f64`
 * @param py `f64`
 * @param pz `f64`
 * @param gOff `u32`
 * @param reversed `bool`
 * @returns `f64`
 */
export declare function pointToPlaneDistance(px: number, py: number, pz: number, gOff: number, reversed: boolean): number;
/**
 * assembly/kernel/ops/pointToSphereDistance
 * @param px `f64`
 * @param py `f64`
 * @param pz `f64`
 * @param gOff `u32`
 * @returns `f64`
 */
export declare function pointToSphereDistance(px: number, py: number, pz: number, gOff: number): number;
/**
 * assembly/kernel/ops/pointToCylinderDistance
 * @param px `f64`
 * @param py `f64`
 * @param pz `f64`
 * @param gOff `u32`
 * @returns `f64`
 */
export declare function pointToCylinderDistance(px: number, py: number, pz: number, gOff: number): number;
/**
 * assembly/kernel/ops/getFaceClassificationPtr
 * @returns `usize`
 */
export declare function getFaceClassificationPtr(): number;
/**
 * assembly/kernel/ops/isxReset
 */
export declare function isxReset(): void;
/**
 * assembly/kernel/ops/isxRecord
 * @param faceA `u32`
 * @param faceB `u32`
 * @param px `f64`
 * @param py `f64`
 * @param pz `f64`
 * @param nx `f64`
 * @param ny `f64`
 * @param nz `f64`
 * @param rdx `f64`
 * @param rdy `f64`
 * @param rdz `f64`
 * @param curvature `f64`
 * @returns `i32`
 */
export declare function isxRecord(faceA: number, faceB: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number, rdx: number, rdy: number, rdz: number, curvature: number): number;
/**
 * assembly/kernel/ops/isxGetErrorBound
 * @param i `u32`
 * @returns `f64`
 */
export declare function isxGetErrorBound(i: number): number;
/**
 * assembly/kernel/ops/isxGetCount
 * @returns `u32`
 */
export declare function isxGetCount(): number;
/**
 * assembly/kernel/ops/isxGetMaxErrorBound
 * @returns `f64`
 */
export declare function isxGetMaxErrorBound(): number;
/**
 * assembly/kernel/ops/isxAreDistinct
 * @param a `u32`
 * @param b `u32`
 * @returns `bool`
 */
export declare function isxAreDistinct(a: number, b: number): boolean;
/**
 * assembly/kernel/ops/isxRayFace
 * @param faceId `u32`
 * @param partnerFaceId `u32`
 * @param ox `f64`
 * @param oy `f64`
 * @param oz `f64`
 * @param dx `f64`
 * @param dy `f64`
 * @param dz `f64`
 * @returns `f64`
 */
export declare function isxRayFace(faceId: number, partnerFaceId: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number;
/**
 * assembly/kernel/interop/cbrepDehydrate
 * @returns `u32`
 */
export declare function cbrepDehydrate(): number;
/**
 * assembly/kernel/interop/cbrepHydrate
 * @param input `~lib/staticarray/StaticArray<u8>`
 * @param inputLen `u32`
 * @returns `u32`
 */
export declare function cbrepHydrate(input: ArrayLike<number>, inputLen: number): number;
/**
 * assembly/kernel/interop/cbrepHydrateForHandle
 * @param handleId `u32`
 * @param input `~lib/staticarray/StaticArray<u8>`
 * @param inputLen `u32`
 * @returns `u32`
 */
export declare function cbrepHydrateForHandle(handleId: number, input: ArrayLike<number>, inputLen: number): number;
/**
 * assembly/kernel/interop/getCbrepOutPtr
 * @returns `usize`
 */
export declare function getCbrepOutPtr(): number;
/**
 * assembly/kernel/interop/getCbrepOutLen
 * @returns `u32`
 */
export declare function getCbrepOutLen(): number;
/** assembly/kernel/step_lexer/TOKEN_EOF */
export declare const TOKEN_EOF: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/step_lexer/TOKEN_HASH_ID */
export declare const TOKEN_HASH_ID: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/step_lexer/TOKEN_HASH_REF */
export declare const TOKEN_HASH_REF: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/step_lexer/TOKEN_KEYWORD */
export declare const TOKEN_KEYWORD: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/step_lexer/TOKEN_NUMBER */
export declare const TOKEN_NUMBER: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/step_lexer/TOKEN_STRING */
export declare const TOKEN_STRING: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/step_lexer/TOKEN_ENUM */
export declare const TOKEN_ENUM: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/step_lexer/TOKEN_DOLLAR */
export declare const TOKEN_DOLLAR: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/step_lexer/TOKEN_STAR */
export declare const TOKEN_STAR: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/step_lexer/TOKEN_LPAREN */
export declare const TOKEN_LPAREN: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/step_lexer/TOKEN_RPAREN */
export declare const TOKEN_RPAREN: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/step_lexer/TOKEN_COMMA */
export declare const TOKEN_COMMA: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/step_lexer/TOKEN_EQUALS */
export declare const TOKEN_EQUALS: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/step_lexer/TOKEN_SEMICOLON */
export declare const TOKEN_SEMICOLON: {
  /** @type `u8` */
  get value(): number
};
/** assembly/kernel/step_lexer/STEP_LEX_OK */
export declare const STEP_LEX_OK: {
  /** @type `i32` */
  get value(): number
};
/** assembly/kernel/step_lexer/STEP_LEX_ERR_BAD_CHAR */
export declare const STEP_LEX_ERR_BAD_CHAR: {
  /** @type `i32` */
  get value(): number
};
/** assembly/kernel/step_lexer/STEP_LEX_ERR_UNTERMINATED_STRING */
export declare const STEP_LEX_ERR_UNTERMINATED_STRING: {
  /** @type `i32` */
  get value(): number
};
/** assembly/kernel/step_lexer/STEP_LEX_ERR_INPUT_TOO_LARGE */
export declare const STEP_LEX_ERR_INPUT_TOO_LARGE: {
  /** @type `i32` */
  get value(): number
};
/** assembly/kernel/step_lexer/STEP_LEX_ERR_TOKEN_OVERFLOW */
export declare const STEP_LEX_ERR_TOKEN_OVERFLOW: {
  /** @type `i32` */
  get value(): number
};
/** assembly/kernel/step_lexer/STEP_LEX_ERR_STRPOOL_OVERFLOW */
export declare const STEP_LEX_ERR_STRPOOL_OVERFLOW: {
  /** @type `i32` */
  get value(): number
};
/**
 * assembly/kernel/step_lexer/stepLexReset
 */
export declare function stepLexReset(): void;
/**
 * assembly/kernel/step_lexer/stepLexRun
 * @param inputLen `u32`
 * @returns `i32`
 */
export declare function stepLexRun(inputLen: number): number;
/**
 * assembly/kernel/step_lexer/stepLexGetInputPtr
 * @returns `usize`
 */
export declare function stepLexGetInputPtr(): number;
/**
 * assembly/kernel/step_lexer/stepLexGetInputCapacity
 * @returns `u32`
 */
export declare function stepLexGetInputCapacity(): number;
/**
 * assembly/kernel/step_lexer/stepLexGetTokenBufPtr
 * @returns `usize`
 */
export declare function stepLexGetTokenBufPtr(): number;
/**
 * assembly/kernel/step_lexer/stepLexGetTokenCount
 * @returns `u32`
 */
export declare function stepLexGetTokenCount(): number;
/**
 * assembly/kernel/step_lexer/stepLexGetTokenStride
 * @returns `u32`
 */
export declare function stepLexGetTokenStride(): number;
/**
 * assembly/kernel/step_lexer/stepLexGetStringPoolPtr
 * @returns `usize`
 */
export declare function stepLexGetStringPoolPtr(): number;
/**
 * assembly/kernel/step_lexer/stepLexGetStringPoolLen
 * @returns `u32`
 */
export declare function stepLexGetStringPoolLen(): number;
/**
 * assembly/kernel/step_lexer/stepLexGetErrorOffset
 * @returns `u32`
 */
export declare function stepLexGetErrorOffset(): number;
/**
 * assembly/kernel/step_lexer/stepLexGetErrorCode
 * @returns `i32`
 */
export declare function stepLexGetErrorCode(): number;

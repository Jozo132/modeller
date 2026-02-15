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

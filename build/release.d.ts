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

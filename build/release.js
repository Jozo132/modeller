async function instantiate(module, imports = {}) {
  const adaptedImports = {
    env: Object.setPrototypeOf({
      abort(message, fileName, lineNumber, columnNumber) {
        // ~lib/builtins/abort(~lib/string/String | null?, ~lib/string/String | null?, u32?, u32?) => void
        message = __liftString(message >>> 0);
        fileName = __liftString(fileName >>> 0);
        lineNumber = lineNumber >>> 0;
        columnNumber = columnNumber >>> 0;
        (() => {
          // @external.js
          throw Error(`${message} in ${fileName}:${lineNumber}:${columnNumber}`);
        })();
      },
    }, Object.assign(Object.create(globalThis), imports.env || {})),
  };
  const { exports } = await WebAssembly.instantiate(module, adaptedImports);
  const memory = exports.memory || imports.env.memory;
  const adaptedExports = Object.setPrototypeOf({
    getCommandBufferPtr() {
      // assembly/index/getCommandBufferPtr() => usize
      return exports.getCommandBufferPtr() >>> 0;
    },
  }, exports);
  function __liftString(pointer) {
    if (!pointer) return null;
    const
      end = pointer + new Uint32Array(memory.buffer)[pointer - 4 >>> 2] >>> 1,
      memoryU16 = new Uint16Array(memory.buffer);
    let
      start = pointer >>> 1,
      string = "";
    while (end - start > 1024) string += String.fromCharCode(...memoryU16.subarray(start, start += 1024));
    return string + String.fromCharCode(...memoryU16.subarray(start, end));
  }
  return adaptedExports;
}
export const {
  memory,
  init,
  resize,
  setCameraMode,
  setCameraPosition,
  setCameraTarget,
  setCameraUp,
  setOrthoBounds,
  clearScene,
  addBox,
  removeNode,
  setNodeVisible,
  setNodePosition,
  setNodeColor,
  setGridVisible,
  setAxesVisible,
  setGridSize,
  setAxesSize,
  setMousePosition,
  mouseAction,
  setMouseButton,
  clearEntities,
  addEntitySegment,
  addEntityCircle,
  addEntityArc,
  addEntityPoint,
  setSnapPosition,
  setCursorPosition,
  clearSolver,
  addSolverPoint,
  addSolverConstraint,
  solveSolver,
  getSolverPointX,
  getSolverPointY,
  getSolverConverged,
  getSolverIterations,
  getSolverMaxError,
  render,
  getCommandBufferPtr,
  getCommandBufferLen,
  ENTITY_FLAG_VISIBLE,
  ENTITY_FLAG_SELECTED,
  ENTITY_FLAG_CONSTRUCTION,
  ENTITY_FLAG_HOVER,
  ENTITY_FLAG_FIXED,
  ENTITY_FLAG_PREVIEW,
  SOLVER_COINCIDENT,
  SOLVER_HORIZONTAL,
  SOLVER_VERTICAL,
  SOLVER_DISTANCE,
  SOLVER_FIXED,
  SOLVER_PARALLEL,
  SOLVER_PERPENDICULAR,
  SOLVER_EQUAL_LENGTH,
  SOLVER_TANGENT,
  SOLVER_ANGLE,
  setEntityModelMatrix,
  resetEntityModelMatrix,
} = await (async url => instantiate(
  await (async () => {
    const isNodeOrBun = typeof process != "undefined" && process.versions != null && (process.versions.node != null || process.versions.bun != null);
    if (isNodeOrBun) { return globalThis.WebAssembly.compile(await (await import("node:fs/promises")).readFile(url)); }
    else { return await globalThis.WebAssembly.compileStreaming(globalThis.fetch(url)); }
  })(), {
  }
))(new URL("release.wasm", import.meta.url));

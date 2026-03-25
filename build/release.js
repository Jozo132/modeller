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
    getResultPtr() {
      // assembly/nurbs/getResultPtr() => usize
      return exports.getResultPtr() >>> 0;
    },
    nurbsCurveEvaluate(degree, nCtrl, ctrlPts, knots, weights, t) {
      // assembly/nurbs/nurbsCurveEvaluate(i32, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, f64) => void
      ctrlPts = __retain(__lowerTypedArray(Float64Array, 31, 3, ctrlPts) || __notnull());
      knots = __retain(__lowerTypedArray(Float64Array, 31, 3, knots) || __notnull());
      weights = __lowerTypedArray(Float64Array, 31, 3, weights) || __notnull();
      try {
        exports.nurbsCurveEvaluate(degree, nCtrl, ctrlPts, knots, weights, t);
      } finally {
        __release(ctrlPts);
        __release(knots);
      }
    },
    nurbsCurveTessellate(degree, nCtrl, ctrlPts, knots, weights, segments, outPts) {
      // assembly/nurbs/nurbsCurveTessellate(i32, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, ~lib/typedarray/Float64Array) => void
      ctrlPts = __retain(__lowerTypedArray(Float64Array, 31, 3, ctrlPts) || __notnull());
      knots = __retain(__lowerTypedArray(Float64Array, 31, 3, knots) || __notnull());
      weights = __retain(__lowerTypedArray(Float64Array, 31, 3, weights) || __notnull());
      outPts = __lowerTypedArray(Float64Array, 31, 3, outPts) || __notnull();
      try {
        exports.nurbsCurveTessellate(degree, nCtrl, ctrlPts, knots, weights, segments, outPts);
      } finally {
        __release(ctrlPts);
        __release(knots);
        __release(weights);
      }
    },
    nurbsSurfaceEvaluate(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, v) {
      // assembly/nurbs/nurbsSurfaceEvaluate(i32, i32, i32, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, f64, f64) => void
      ctrlPts = __retain(__lowerTypedArray(Float64Array, 31, 3, ctrlPts) || __notnull());
      knotsU = __retain(__lowerTypedArray(Float64Array, 31, 3, knotsU) || __notnull());
      knotsV = __retain(__lowerTypedArray(Float64Array, 31, 3, knotsV) || __notnull());
      weights = __lowerTypedArray(Float64Array, 31, 3, weights) || __notnull();
      try {
        exports.nurbsSurfaceEvaluate(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, v);
      } finally {
        __release(ctrlPts);
        __release(knotsU);
        __release(knotsV);
      }
    },
    nurbsSurfaceNormal(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, v) {
      // assembly/nurbs/nurbsSurfaceNormal(i32, i32, i32, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, f64, f64) => void
      ctrlPts = __retain(__lowerTypedArray(Float64Array, 31, 3, ctrlPts) || __notnull());
      knotsU = __retain(__lowerTypedArray(Float64Array, 31, 3, knotsU) || __notnull());
      knotsV = __retain(__lowerTypedArray(Float64Array, 31, 3, knotsV) || __notnull());
      weights = __lowerTypedArray(Float64Array, 31, 3, weights) || __notnull();
      try {
        exports.nurbsSurfaceNormal(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, v);
      } finally {
        __release(ctrlPts);
        __release(knotsU);
        __release(knotsV);
      }
    },
    nurbsSurfaceTessellate(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, segsU, segsV, outVerts, outNormals, outFaces) {
      // assembly/nurbs/nurbsSurfaceTessellate(i32, i32, i32, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint32Array) => i32
      ctrlPts = __retain(__lowerTypedArray(Float64Array, 31, 3, ctrlPts) || __notnull());
      knotsU = __retain(__lowerTypedArray(Float64Array, 31, 3, knotsU) || __notnull());
      knotsV = __retain(__lowerTypedArray(Float64Array, 31, 3, knotsV) || __notnull());
      weights = __retain(__lowerTypedArray(Float64Array, 31, 3, weights) || __notnull());
      outVerts = __retain(__lowerTypedArray(Float64Array, 31, 3, outVerts) || __notnull());
      outNormals = __retain(__lowerTypedArray(Float64Array, 31, 3, outNormals) || __notnull());
      outFaces = __lowerTypedArray(Uint32Array, 32, 2, outFaces) || __notnull();
      try {
        return exports.nurbsSurfaceTessellate(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, segsU, segsV, outVerts, outNormals, outFaces);
      } finally {
        __release(ctrlPts);
        __release(knotsU);
        __release(knotsV);
        __release(weights);
        __release(outVerts);
        __release(outNormals);
      }
    },
    earClipTriangulate(coords, nVerts, outTris) {
      // assembly/tessellation/earClipTriangulate(~lib/typedarray/Float64Array, i32, ~lib/typedarray/Uint32Array) => i32
      coords = __retain(__lowerTypedArray(Float64Array, 31, 3, coords) || __notnull());
      outTris = __lowerTypedArray(Uint32Array, 32, 2, outTris) || __notnull();
      try {
        return exports.earClipTriangulate(coords, nVerts, outTris);
      } finally {
        __release(coords);
      }
    },
    computeTriangleNormal(verts, i0, i1, i2, outNormal) {
      // assembly/tessellation/computeTriangleNormal(~lib/typedarray/Float64Array, i32, i32, i32, ~lib/typedarray/Float64Array) => void
      verts = __retain(__lowerTypedArray(Float64Array, 31, 3, verts) || __notnull());
      outNormal = __lowerTypedArray(Float64Array, 31, 3, outNormal) || __notnull();
      try {
        exports.computeTriangleNormal(verts, i0, i1, i2, outNormal);
      } finally {
        __release(verts);
      }
    },
    computeBoundingBox(verts, nVerts, outBox) {
      // assembly/tessellation/computeBoundingBox(~lib/typedarray/Float64Array, i32, ~lib/typedarray/Float64Array) => void
      verts = __retain(__lowerTypedArray(Float64Array, 31, 3, verts) || __notnull());
      outBox = __lowerTypedArray(Float64Array, 31, 3, outBox) || __notnull();
      try {
        exports.computeBoundingBox(verts, nVerts, outBox);
      } finally {
        __release(verts);
      }
    },
    computeMeshVolume(verts, faces, nTris) {
      // assembly/tessellation/computeMeshVolume(~lib/typedarray/Float64Array, ~lib/typedarray/Uint32Array, i32) => f64
      verts = __retain(__lowerTypedArray(Float64Array, 31, 3, verts) || __notnull());
      faces = __lowerTypedArray(Uint32Array, 32, 2, faces) || __notnull();
      try {
        return exports.computeMeshVolume(verts, faces, nTris);
      } finally {
        __release(verts);
      }
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
  function __lowerTypedArray(constructor, id, align, values) {
    if (values == null) return 0;
    const
      length = values.length,
      buffer = exports.__pin(exports.__new(length << align, 1)) >>> 0,
      header = exports.__new(12, id) >>> 0;
    __setU32(header + 0, buffer);
    __dataview.setUint32(header + 4, buffer, true);
    __dataview.setUint32(header + 8, length << align, true);
    new constructor(memory.buffer, buffer, length).set(values);
    exports.__unpin(buffer);
    return header;
  }
  const refcounts = new Map();
  function __retain(pointer) {
    if (pointer) {
      const refcount = refcounts.get(pointer);
      if (refcount) refcounts.set(pointer, refcount + 1);
      else refcounts.set(exports.__pin(pointer), 1);
    }
    return pointer;
  }
  function __release(pointer) {
    if (pointer) {
      const refcount = refcounts.get(pointer);
      if (refcount === 1) exports.__unpin(pointer), refcounts.delete(pointer);
      else if (refcount) refcounts.set(pointer, refcount - 1);
      else throw Error(`invalid refcount '${refcount}' for reference '${pointer}'`);
    }
  }
  function __notnull() {
    throw TypeError("value must not be null");
  }
  let __dataview = new DataView(memory.buffer);
  function __setU32(pointer, value) {
    try {
      __dataview.setUint32(pointer, value, true);
    } catch {
      __dataview = new DataView(memory.buffer);
      __dataview.setUint32(pointer, value, true);
    }
  }
  return adaptedExports;
}
export const {
  memory,
  init,
  resize,
  setFov,
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
  setOriginPlanesVisible,
  setOriginPlaneHovered,
  setOriginPlaneSelected,
  setMousePosition,
  mouseAction,
  setMouseButton,
  clearEntities,
  addEntitySegment,
  addEntityCircle,
  addEntityArc,
  addEntityPoint,
  addEntityDimension,
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
  getResultPtr,
  nurbsCurveEvaluate,
  nurbsCurveTessellate,
  nurbsSurfaceEvaluate,
  nurbsSurfaceNormal,
  nurbsSurfaceTessellate,
  earClipTriangulate,
  computeTriangleNormal,
  computeBoundingBox,
  computeMeshVolume,
} = await (async url => instantiate(
  await (async () => {
    const isNodeOrBun = typeof process != "undefined" && process.versions != null && (process.versions.node != null || process.versions.bun != null);
    if (isNodeOrBun) { return globalThis.WebAssembly.compile(await (await import("node:fs/promises")).readFile(url)); }
    else { return await globalThis.WebAssembly.compileStreaming(globalThis.fetch(url)); }
  })(), {
  }
))(new URL("release.wasm", import.meta.url));

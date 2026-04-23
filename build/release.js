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
    getTessVertsPtr() {
      // assembly/nurbs/getTessVertsPtr() => usize
      return exports.getTessVertsPtr() >>> 0;
    },
    getTessNormalsPtr() {
      // assembly/nurbs/getTessNormalsPtr() => usize
      return exports.getTessNormalsPtr() >>> 0;
    },
    getTessFacesPtr() {
      // assembly/nurbs/getTessFacesPtr() => usize
      return exports.getTessFacesPtr() >>> 0;
    },
    getCurvePtsPtr() {
      // assembly/nurbs/getCurvePtsPtr() => usize
      return exports.getCurvePtsPtr() >>> 0;
    },
    nurbsCurveEvaluate(degree, nCtrl, ctrlPts, knots, weights, t) {
      // assembly/nurbs/nurbsCurveEvaluate(i32, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, f64) => void
      ctrlPts = __retain(__lowerTypedArray(Float64Array, 32, 3, ctrlPts) || __notnull());
      knots = __retain(__lowerTypedArray(Float64Array, 32, 3, knots) || __notnull());
      weights = __lowerTypedArray(Float64Array, 32, 3, weights) || __notnull();
      try {
        exports.nurbsCurveEvaluate(degree, nCtrl, ctrlPts, knots, weights, t);
      } finally {
        __release(ctrlPts);
        __release(knots);
      }
    },
    nurbsCurveTessellate(degree, nCtrl, ctrlPts, knots, weights, segments) {
      // assembly/nurbs/nurbsCurveTessellate(i32, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32) => i32
      ctrlPts = __retain(__lowerTypedArray(Float64Array, 32, 3, ctrlPts) || __notnull());
      knots = __retain(__lowerTypedArray(Float64Array, 32, 3, knots) || __notnull());
      weights = __lowerTypedArray(Float64Array, 32, 3, weights) || __notnull();
      try {
        return exports.nurbsCurveTessellate(degree, nCtrl, ctrlPts, knots, weights, segments);
      } finally {
        __release(ctrlPts);
        __release(knots);
      }
    },
    nurbsSurfaceEvaluate(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, v) {
      // assembly/nurbs/nurbsSurfaceEvaluate(i32, i32, i32, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, f64, f64) => void
      ctrlPts = __retain(__lowerTypedArray(Float64Array, 32, 3, ctrlPts) || __notnull());
      knotsU = __retain(__lowerTypedArray(Float64Array, 32, 3, knotsU) || __notnull());
      knotsV = __retain(__lowerTypedArray(Float64Array, 32, 3, knotsV) || __notnull());
      weights = __lowerTypedArray(Float64Array, 32, 3, weights) || __notnull();
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
      ctrlPts = __retain(__lowerTypedArray(Float64Array, 32, 3, ctrlPts) || __notnull());
      knotsU = __retain(__lowerTypedArray(Float64Array, 32, 3, knotsU) || __notnull());
      knotsV = __retain(__lowerTypedArray(Float64Array, 32, 3, knotsV) || __notnull());
      weights = __lowerTypedArray(Float64Array, 32, 3, weights) || __notnull();
      try {
        exports.nurbsSurfaceNormal(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, v);
      } finally {
        __release(ctrlPts);
        __release(knotsU);
        __release(knotsV);
      }
    },
    nurbsSurfaceTessellate(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, segsU, segsV) {
      // assembly/nurbs/nurbsSurfaceTessellate(i32, i32, i32, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, i32) => i32
      ctrlPts = __retain(__lowerTypedArray(Float64Array, 32, 3, ctrlPts) || __notnull());
      knotsU = __retain(__lowerTypedArray(Float64Array, 32, 3, knotsU) || __notnull());
      knotsV = __retain(__lowerTypedArray(Float64Array, 32, 3, knotsV) || __notnull());
      weights = __lowerTypedArray(Float64Array, 32, 3, weights) || __notnull();
      try {
        return exports.nurbsSurfaceTessellate(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, segsU, segsV);
      } finally {
        __release(ctrlPts);
        __release(knotsU);
        __release(knotsV);
      }
    },
    getDerivBufPtr() {
      // assembly/nurbs/getDerivBufPtr() => usize
      return exports.getDerivBufPtr() >>> 0;
    },
    getBatchBufPtr() {
      // assembly/nurbs/getBatchBufPtr() => usize
      return exports.getBatchBufPtr() >>> 0;
    },
    nurbsCurveDerivEval(degree, nCtrl, ctrlPts, knots, weights, t) {
      // assembly/nurbs/nurbsCurveDerivEval(i32, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, f64) => void
      ctrlPts = __retain(__lowerTypedArray(Float64Array, 32, 3, ctrlPts) || __notnull());
      knots = __retain(__lowerTypedArray(Float64Array, 32, 3, knots) || __notnull());
      weights = __lowerTypedArray(Float64Array, 32, 3, weights) || __notnull();
      try {
        exports.nurbsCurveDerivEval(degree, nCtrl, ctrlPts, knots, weights, t);
      } finally {
        __release(ctrlPts);
        __release(knots);
      }
    },
    nurbsCurveBatchDerivEval(degree, nCtrl, ctrlPts, knots, weights, params, count) {
      // assembly/nurbs/nurbsCurveBatchDerivEval(i32, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32) => i32
      ctrlPts = __retain(__lowerTypedArray(Float64Array, 32, 3, ctrlPts) || __notnull());
      knots = __retain(__lowerTypedArray(Float64Array, 32, 3, knots) || __notnull());
      weights = __retain(__lowerTypedArray(Float64Array, 32, 3, weights) || __notnull());
      params = __lowerTypedArray(Float64Array, 32, 3, params) || __notnull();
      try {
        return exports.nurbsCurveBatchDerivEval(degree, nCtrl, ctrlPts, knots, weights, params, count);
      } finally {
        __release(ctrlPts);
        __release(knots);
        __release(weights);
      }
    },
    nurbsSurfaceDerivEval(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, v) {
      // assembly/nurbs/nurbsSurfaceDerivEval(i32, i32, i32, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, f64, f64) => void
      ctrlPts = __retain(__lowerTypedArray(Float64Array, 32, 3, ctrlPts) || __notnull());
      knotsU = __retain(__lowerTypedArray(Float64Array, 32, 3, knotsU) || __notnull());
      knotsV = __retain(__lowerTypedArray(Float64Array, 32, 3, knotsV) || __notnull());
      weights = __lowerTypedArray(Float64Array, 32, 3, weights) || __notnull();
      try {
        exports.nurbsSurfaceDerivEval(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, v);
      } finally {
        __release(ctrlPts);
        __release(knotsU);
        __release(knotsV);
      }
    },
    nurbsSurfaceBatchDerivEval(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, params, count) {
      // assembly/nurbs/nurbsSurfaceBatchDerivEval(i32, i32, i32, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32) => i32
      ctrlPts = __retain(__lowerTypedArray(Float64Array, 32, 3, ctrlPts) || __notnull());
      knotsU = __retain(__lowerTypedArray(Float64Array, 32, 3, knotsU) || __notnull());
      knotsV = __retain(__lowerTypedArray(Float64Array, 32, 3, knotsV) || __notnull());
      weights = __retain(__lowerTypedArray(Float64Array, 32, 3, weights) || __notnull());
      params = __lowerTypedArray(Float64Array, 32, 3, params) || __notnull();
      try {
        return exports.nurbsSurfaceBatchDerivEval(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, params, count);
      } finally {
        __release(ctrlPts);
        __release(knotsU);
        __release(knotsV);
        __release(weights);
      }
    },
    earClipTriangulate(coords, nVerts, outTris) {
      // assembly/tessellation/earClipTriangulate(~lib/typedarray/Float64Array, i32, ~lib/typedarray/Uint32Array) => i32
      coords = __retain(__lowerTypedArray(Float64Array, 32, 3, coords) || __notnull());
      outTris = __lowerTypedArray(Uint32Array, 34, 2, outTris) || __notnull();
      try {
        return exports.earClipTriangulate(coords, nVerts, outTris);
      } finally {
        __release(coords);
      }
    },
    computeTriangleNormal(verts, i0, i1, i2, outNormal) {
      // assembly/tessellation/computeTriangleNormal(~lib/typedarray/Float64Array, i32, i32, i32, ~lib/typedarray/Float64Array) => void
      verts = __retain(__lowerTypedArray(Float64Array, 32, 3, verts) || __notnull());
      outNormal = __lowerTypedArray(Float64Array, 32, 3, outNormal) || __notnull();
      try {
        exports.computeTriangleNormal(verts, i0, i1, i2, outNormal);
      } finally {
        __release(verts);
      }
    },
    computeBoundingBox(verts, nVerts, outBox) {
      // assembly/tessellation/computeBoundingBox(~lib/typedarray/Float64Array, i32, ~lib/typedarray/Float64Array) => void
      verts = __retain(__lowerTypedArray(Float64Array, 32, 3, verts) || __notnull());
      outBox = __lowerTypedArray(Float64Array, 32, 3, outBox) || __notnull();
      try {
        exports.computeBoundingBox(verts, nVerts, outBox);
      } finally {
        __release(verts);
      }
    },
    computeMeshVolume(verts, faces, nTris) {
      // assembly/tessellation/computeMeshVolume(~lib/typedarray/Float64Array, ~lib/typedarray/Uint32Array, i32) => f64
      verts = __retain(__lowerTypedArray(Float64Array, 32, 3, verts) || __notnull());
      faces = __lowerTypedArray(Uint32Array, 34, 2, faces) || __notnull();
      try {
        return exports.computeMeshVolume(verts, faces, nTris);
      } finally {
        __release(verts);
      }
    },
    HANDLE_NONE: {
      // assembly/kernel/core/HANDLE_NONE: u32
      valueOf() { return this.value; },
      get value() {
        return exports.HANDLE_NONE.value >>> 0;
      }
    },
    handleAlloc() {
      // assembly/kernel/core/handleAlloc() => u32
      return exports.handleAlloc() >>> 0;
    },
    handleIsValid(id) {
      // assembly/kernel/core/handleIsValid(u32) => bool
      return exports.handleIsValid(id) != 0;
    },
    handleGetRevision(id) {
      // assembly/kernel/core/handleGetRevision(u32) => u32
      return exports.handleGetRevision(id) >>> 0;
    },
    handleBumpRevision(id) {
      // assembly/kernel/core/handleBumpRevision(u32) => u32
      return exports.handleBumpRevision(id) >>> 0;
    },
    handleGetFeatureId(id) {
      // assembly/kernel/core/handleGetFeatureId(u32) => u32
      return exports.handleGetFeatureId(id) >>> 0;
    },
    handleGetIrHash(id) {
      // assembly/kernel/core/handleGetIrHash(u32) => u32
      return exports.handleGetIrHash(id) >>> 0;
    },
    handleGetRefCount(id) {
      // assembly/kernel/core/handleGetRefCount(u32) => u32
      return exports.handleGetRefCount(id) >>> 0;
    },
    handleLiveCount() {
      // assembly/kernel/core/handleLiveCount() => u32
      return exports.handleLiveCount() >>> 0;
    },
    handleGlobalRevision() {
      // assembly/kernel/core/handleGlobalRevision() => u32
      return exports.handleGlobalRevision() >>> 0;
    },
    handleGetFaceStart(id) {
      // assembly/kernel/core/handleGetFaceStart(u32) => u32
      return exports.handleGetFaceStart(id) >>> 0;
    },
    handleGetFaceEnd(id) {
      // assembly/kernel/core/handleGetFaceEnd(u32) => u32
      return exports.handleGetFaceEnd(id) >>> 0;
    },
    handleGetVertexStart(id) {
      // assembly/kernel/core/handleGetVertexStart(u32) => u32
      return exports.handleGetVertexStart(id) >>> 0;
    },
    handleGetVertexEnd(id) {
      // assembly/kernel/core/handleGetVertexEnd(u32) => u32
      return exports.handleGetVertexEnd(id) >>> 0;
    },
    handleGetShellStart(id) {
      // assembly/kernel/core/handleGetShellStart(u32) => u32
      return exports.handleGetShellStart(id) >>> 0;
    },
    handleGetShellEnd(id) {
      // assembly/kernel/core/handleGetShellEnd(u32) => u32
      return exports.handleGetShellEnd(id) >>> 0;
    },
    handleGetGeomStart(id) {
      // assembly/kernel/core/handleGetGeomStart(u32) => u32
      return exports.handleGetGeomStart(id) >>> 0;
    },
    handleGetGeomEnd(id) {
      // assembly/kernel/core/handleGetGeomEnd(u32) => u32
      return exports.handleGetGeomEnd(id) >>> 0;
    },
    MAX_VERTICES: {
      // assembly/kernel/topology/MAX_VERTICES: u32
      valueOf() { return this.value; },
      get value() {
        return exports.MAX_VERTICES.value >>> 0;
      }
    },
    MAX_EDGES: {
      // assembly/kernel/topology/MAX_EDGES: u32
      valueOf() { return this.value; },
      get value() {
        return exports.MAX_EDGES.value >>> 0;
      }
    },
    MAX_COEDGES: {
      // assembly/kernel/topology/MAX_COEDGES: u32
      valueOf() { return this.value; },
      get value() {
        return exports.MAX_COEDGES.value >>> 0;
      }
    },
    MAX_LOOPS: {
      // assembly/kernel/topology/MAX_LOOPS: u32
      valueOf() { return this.value; },
      get value() {
        return exports.MAX_LOOPS.value >>> 0;
      }
    },
    MAX_FACES: {
      // assembly/kernel/topology/MAX_FACES: u32
      valueOf() { return this.value; },
      get value() {
        return exports.MAX_FACES.value >>> 0;
      }
    },
    MAX_SHELLS: {
      // assembly/kernel/topology/MAX_SHELLS: u32
      valueOf() { return this.value; },
      get value() {
        return exports.MAX_SHELLS.value >>> 0;
      }
    },
    vertexAdd(x, y, z) {
      // assembly/kernel/topology/vertexAdd(f64, f64, f64) => u32
      return exports.vertexAdd(x, y, z) >>> 0;
    },
    vertexGetCount() {
      // assembly/kernel/topology/vertexGetCount() => u32
      return exports.vertexGetCount() >>> 0;
    },
    edgeAdd(startV, endV, geomType, geomOffset) {
      // assembly/kernel/topology/edgeAdd(u32, u32, u8, u32) => u32
      return exports.edgeAdd(startV, endV, geomType, geomOffset) >>> 0;
    },
    edgeGetStartVertex(id) {
      // assembly/kernel/topology/edgeGetStartVertex(u32) => u32
      return exports.edgeGetStartVertex(id) >>> 0;
    },
    edgeGetEndVertex(id) {
      // assembly/kernel/topology/edgeGetEndVertex(u32) => u32
      return exports.edgeGetEndVertex(id) >>> 0;
    },
    edgeGetGeomOffset(id) {
      // assembly/kernel/topology/edgeGetGeomOffset(u32) => u32
      return exports.edgeGetGeomOffset(id) >>> 0;
    },
    edgeGetCount() {
      // assembly/kernel/topology/edgeGetCount() => u32
      return exports.edgeGetCount() >>> 0;
    },
    coedgeAdd(edgeId, orient, nextCoedge, loopId) {
      // assembly/kernel/topology/coedgeAdd(u32, u8, u32, u32) => u32
      return exports.coedgeAdd(edgeId, orient, nextCoedge, loopId) >>> 0;
    },
    coedgeGetEdge(id) {
      // assembly/kernel/topology/coedgeGetEdge(u32) => u32
      return exports.coedgeGetEdge(id) >>> 0;
    },
    coedgeGetNext(id) {
      // assembly/kernel/topology/coedgeGetNext(u32) => u32
      return exports.coedgeGetNext(id) >>> 0;
    },
    coedgeGetLoop(id) {
      // assembly/kernel/topology/coedgeGetLoop(u32) => u32
      return exports.coedgeGetLoop(id) >>> 0;
    },
    coedgeGetCount() {
      // assembly/kernel/topology/coedgeGetCount() => u32
      return exports.coedgeGetCount() >>> 0;
    },
    loopAdd(firstCoedge, faceId, isOuter) {
      // assembly/kernel/topology/loopAdd(u32, u32, u8) => u32
      return exports.loopAdd(firstCoedge, faceId, isOuter) >>> 0;
    },
    loopGetFirstCoedge(id) {
      // assembly/kernel/topology/loopGetFirstCoedge(u32) => u32
      return exports.loopGetFirstCoedge(id) >>> 0;
    },
    loopGetFace(id) {
      // assembly/kernel/topology/loopGetFace(u32) => u32
      return exports.loopGetFace(id) >>> 0;
    },
    loopGetCount() {
      // assembly/kernel/topology/loopGetCount() => u32
      return exports.loopGetCount() >>> 0;
    },
    faceAdd(firstLoop, shellId, geomType, geomOffset, orient, numLoops) {
      // assembly/kernel/topology/faceAdd(u32, u32, u8, u32, u8, u32) => u32
      return exports.faceAdd(firstLoop, shellId, geomType, geomOffset, orient, numLoops) >>> 0;
    },
    faceGetFirstLoop(id) {
      // assembly/kernel/topology/faceGetFirstLoop(u32) => u32
      return exports.faceGetFirstLoop(id) >>> 0;
    },
    faceGetShell(id) {
      // assembly/kernel/topology/faceGetShell(u32) => u32
      return exports.faceGetShell(id) >>> 0;
    },
    faceGetGeomOffset(id) {
      // assembly/kernel/topology/faceGetGeomOffset(u32) => u32
      return exports.faceGetGeomOffset(id) >>> 0;
    },
    faceGetLoopCount(id) {
      // assembly/kernel/topology/faceGetLoopCount(u32) => u32
      return exports.faceGetLoopCount(id) >>> 0;
    },
    faceGetCount() {
      // assembly/kernel/topology/faceGetCount() => u32
      return exports.faceGetCount() >>> 0;
    },
    shellAdd(firstFace, numFaces, isClosed) {
      // assembly/kernel/topology/shellAdd(u32, u32, u8) => u32
      return exports.shellAdd(firstFace, numFaces, isClosed) >>> 0;
    },
    shellGetFirstFace(id) {
      // assembly/kernel/topology/shellGetFirstFace(u32) => u32
      return exports.shellGetFirstFace(id) >>> 0;
    },
    shellGetFaceCount(id) {
      // assembly/kernel/topology/shellGetFaceCount(u32) => u32
      return exports.shellGetFaceCount(id) >>> 0;
    },
    shellGetCount() {
      // assembly/kernel/topology/shellGetCount() => u32
      return exports.shellGetCount() >>> 0;
    },
    bodyEnd() {
      // assembly/kernel/topology/bodyEnd() => u32
      return exports.bodyEnd() >>> 0;
    },
    bodyEndForHandle() {
      // assembly/kernel/topology/bodyEndForHandle() => u32
      return exports.bodyEndForHandle() >>> 0;
    },
    bodyGetShellCount() {
      // assembly/kernel/topology/bodyGetShellCount() => u32
      return exports.bodyGetShellCount() >>> 0;
    },
    bodyGetFirstShell() {
      // assembly/kernel/topology/bodyGetFirstShell() => u32
      return exports.bodyGetFirstShell() >>> 0;
    },
    getVertexCoordsPtr() {
      // assembly/kernel/topology/getVertexCoordsPtr() => usize
      return exports.getVertexCoordsPtr() >>> 0;
    },
    getVertexCoordsLen() {
      // assembly/kernel/topology/getVertexCoordsLen() => u32
      return exports.getVertexCoordsLen() >>> 0;
    },
    getEdgeStartVertexPtr() {
      // assembly/kernel/topology/getEdgeStartVertexPtr() => usize
      return exports.getEdgeStartVertexPtr() >>> 0;
    },
    getEdgeEndVertexPtr() {
      // assembly/kernel/topology/getEdgeEndVertexPtr() => usize
      return exports.getEdgeEndVertexPtr() >>> 0;
    },
    topoGetSummary(outBuf) {
      // assembly/kernel/topology/topoGetSummary(~lib/staticarray/StaticArray<u32>) => void
      outBuf = __lowerStaticArray(__setU32, 7, 2, outBuf, Uint32Array) || __notnull();
      exports.topoGetSummary(outBuf);
    },
    nurbsSurfaceStore(degreeU, degreeV, numCtrlU, numCtrlV, knotsU, knotsV, ctrlPts, weights) {
      // assembly/kernel/geometry/nurbsSurfaceStore(u32, u32, u32, u32, ~lib/staticarray/StaticArray<f64>, ~lib/staticarray/StaticArray<f64>, ~lib/staticarray/StaticArray<f64>, ~lib/staticarray/StaticArray<f64>) => u32
      knotsU = __retain(__lowerStaticArray(__setF64, 6, 3, knotsU, Float64Array) || __notnull());
      knotsV = __retain(__lowerStaticArray(__setF64, 6, 3, knotsV, Float64Array) || __notnull());
      ctrlPts = __retain(__lowerStaticArray(__setF64, 6, 3, ctrlPts, Float64Array) || __notnull());
      weights = __lowerStaticArray(__setF64, 6, 3, weights, Float64Array) || __notnull();
      try {
        return exports.nurbsSurfaceStore(degreeU, degreeV, numCtrlU, numCtrlV, knotsU, knotsV, ctrlPts, weights) >>> 0;
      } finally {
        __release(knotsU);
        __release(knotsV);
        __release(ctrlPts);
      }
    },
    nurbsCurveStore(degree, numCtrl, knots, ctrlPts, weights) {
      // assembly/kernel/geometry/nurbsCurveStore(u32, u32, ~lib/staticarray/StaticArray<f64>, ~lib/staticarray/StaticArray<f64>, ~lib/staticarray/StaticArray<f64>) => u32
      knots = __retain(__lowerStaticArray(__setF64, 6, 3, knots, Float64Array) || __notnull());
      ctrlPts = __retain(__lowerStaticArray(__setF64, 6, 3, ctrlPts, Float64Array) || __notnull());
      weights = __lowerStaticArray(__setF64, 6, 3, weights, Float64Array) || __notnull();
      try {
        return exports.nurbsCurveStore(degree, numCtrl, knots, ctrlPts, weights) >>> 0;
      } finally {
        __release(knots);
        __release(ctrlPts);
      }
    },
    planeStore(ox, oy, oz, nx, ny, nz, rx, ry, rz) {
      // assembly/kernel/geometry/planeStore(f64, f64, f64, f64, f64, f64, f64, f64, f64) => u32
      return exports.planeStore(ox, oy, oz, nx, ny, nz, rx, ry, rz) >>> 0;
    },
    cylinderStore(ox, oy, oz, ax, ay, az, rx, ry, rz, radius) {
      // assembly/kernel/geometry/cylinderStore(f64, f64, f64, f64, f64, f64, f64, f64, f64, f64) => u32
      return exports.cylinderStore(ox, oy, oz, ax, ay, az, rx, ry, rz, radius) >>> 0;
    },
    sphereStore(cx, cy, cz, ax, ay, az, rx, ry, rz, radius) {
      // assembly/kernel/geometry/sphereStore(f64, f64, f64, f64, f64, f64, f64, f64, f64, f64) => u32
      return exports.sphereStore(cx, cy, cz, ax, ay, az, rx, ry, rz, radius) >>> 0;
    },
    coneStore(ox, oy, oz, ax, ay, az, rx, ry, rz, radius, semiAngle) {
      // assembly/kernel/geometry/coneStore(f64, f64, f64, f64, f64, f64, f64, f64, f64, f64, f64) => u32
      return exports.coneStore(ox, oy, oz, ax, ay, az, rx, ry, rz, radius, semiAngle) >>> 0;
    },
    torusStore(cx, cy, cz, ax, ay, az, rx, ry, rz, majorRadius, minorRadius) {
      // assembly/kernel/geometry/torusStore(f64, f64, f64, f64, f64, f64, f64, f64, f64, f64, f64) => u32
      return exports.torusStore(cx, cy, cz, ax, ay, az, rx, ry, rz, majorRadius, minorRadius) >>> 0;
    },
    getGeomPoolPtr() {
      // assembly/kernel/geometry/getGeomPoolPtr() => usize
      return exports.getGeomPoolPtr() >>> 0;
    },
    geomPoolUsed() {
      // assembly/kernel/geometry/geomPoolUsed() => u32
      return exports.geomPoolUsed() >>> 0;
    },
    geomStagingPtr() {
      // assembly/kernel/geometry/geomStagingPtr() => usize
      return exports.geomStagingPtr() >>> 0;
    },
    geomStagingCapacity() {
      // assembly/kernel/geometry/geomStagingCapacity() => u32
      return exports.geomStagingCapacity() >>> 0;
    },
    nurbsSurfaceStoreFromStaging(degreeU, degreeV, numCtrlU, numCtrlV, nKnotsU, nKnotsV) {
      // assembly/kernel/geometry/nurbsSurfaceStoreFromStaging(u32, u32, u32, u32, u32, u32) => u32
      return exports.nurbsSurfaceStoreFromStaging(degreeU, degreeV, numCtrlU, numCtrlV, nKnotsU, nKnotsV) >>> 0;
    },
    nurbsCurveStoreFromStaging(degree, numCtrl, nKnots) {
      // assembly/kernel/geometry/nurbsCurveStoreFromStaging(u32, u32, u32) => u32
      return exports.nurbsCurveStoreFromStaging(degree, numCtrl, nKnots) >>> 0;
    },
    transformMultiply(a, b) {
      // assembly/kernel/transform/transformMultiply(~lib/staticarray/StaticArray<f64>, ~lib/staticarray/StaticArray<f64>) => void
      a = __retain(__lowerStaticArray(__setF64, 6, 3, a, Float64Array) || __notnull());
      b = __lowerStaticArray(__setF64, 6, 3, b, Float64Array) || __notnull();
      try {
        exports.transformMultiply(a, b);
      } finally {
        __release(a);
      }
    },
    transformPoint(mat, px, py, pz) {
      // assembly/kernel/transform/transformPoint(~lib/staticarray/StaticArray<f64>, f64, f64, f64) => void
      mat = __lowerStaticArray(__setF64, 6, 3, mat, Float64Array) || __notnull();
      exports.transformPoint(mat, px, py, pz);
    },
    transformDirection(mat, dx, dy, dz) {
      // assembly/kernel/transform/transformDirection(~lib/staticarray/StaticArray<f64>, f64, f64, f64) => void
      mat = __lowerStaticArray(__setF64, 6, 3, mat, Float64Array) || __notnull();
      exports.transformDirection(mat, dx, dy, dz);
    },
    transformBoundingBox(mat, verts, nVerts) {
      // assembly/kernel/transform/transformBoundingBox(~lib/staticarray/StaticArray<f64>, ~lib/staticarray/StaticArray<f64>, u32) => void
      mat = __retain(__lowerStaticArray(__setF64, 6, 3, mat, Float64Array) || __notnull());
      verts = __lowerStaticArray(__setF64, 6, 3, verts, Float64Array) || __notnull();
      try {
        exports.transformBoundingBox(mat, verts, nVerts);
      } finally {
        __release(mat);
      }
    },
    getTransformOutMatPtr() {
      // assembly/kernel/transform/getTransformOutMatPtr() => usize
      return exports.getTransformOutMatPtr() >>> 0;
    },
    getTransformOutPtPtr() {
      // assembly/kernel/transform/getTransformOutPtPtr() => usize
      return exports.getTransformOutPtPtr() >>> 0;
    },
    getTransformOutBoxPtr() {
      // assembly/kernel/transform/getTransformOutBoxPtr() => usize
      return exports.getTransformOutBoxPtr() >>> 0;
    },
    octreeQueryPairs(aFaceStart, aFaceEnd, bFaceStart, bFaceEnd) {
      // assembly/kernel/spatial/octreeQueryPairs(u32, u32, u32, u32) => u32
      return exports.octreeQueryPairs(aFaceStart, aFaceEnd, bFaceStart, bFaceEnd) >>> 0;
    },
    getOctreePairsPtr() {
      // assembly/kernel/spatial/getOctreePairsPtr() => usize
      return exports.getOctreePairsPtr() >>> 0;
    },
    octreeGetPairCount() {
      // assembly/kernel/spatial/octreeGetPairCount() => u32
      return exports.octreeGetPairCount() >>> 0;
    },
    octreeGetNodeCount() {
      // assembly/kernel/spatial/octreeGetNodeCount() => u32
      return exports.octreeGetNodeCount() >>> 0;
    },
    gpuBatchAddSurface(degreeU, degreeV, numCtrlU, numCtrlV, knotsU, knotsV, ctrlPts, tessSegsU, tessSegsV) {
      // assembly/kernel/gpu/gpuBatchAddSurface(u32, u32, u32, u32, ~lib/staticarray/StaticArray<f32>, ~lib/staticarray/StaticArray<f32>, ~lib/staticarray/StaticArray<f32>, u32, u32) => u32
      knotsU = __retain(__lowerStaticArray(__setF32, 5, 2, knotsU, Float32Array) || __notnull());
      knotsV = __retain(__lowerStaticArray(__setF32, 5, 2, knotsV, Float32Array) || __notnull());
      ctrlPts = __lowerStaticArray(__setF32, 5, 2, ctrlPts, Float32Array) || __notnull();
      try {
        return exports.gpuBatchAddSurface(degreeU, degreeV, numCtrlU, numCtrlV, knotsU, knotsV, ctrlPts, tessSegsU, tessSegsV) >>> 0;
      } finally {
        __release(knotsU);
        __release(knotsV);
      }
    },
    getGpuHeaderBufPtr() {
      // assembly/kernel/gpu/getGpuHeaderBufPtr() => usize
      return exports.getGpuHeaderBufPtr() >>> 0;
    },
    getGpuHeaderBufLen() {
      // assembly/kernel/gpu/getGpuHeaderBufLen() => u32
      return exports.getGpuHeaderBufLen() >>> 0;
    },
    getGpuCtrlBufPtr() {
      // assembly/kernel/gpu/getGpuCtrlBufPtr() => usize
      return exports.getGpuCtrlBufPtr() >>> 0;
    },
    getGpuCtrlBufLen() {
      // assembly/kernel/gpu/getGpuCtrlBufLen() => u32
      return exports.getGpuCtrlBufLen() >>> 0;
    },
    getGpuKnotBufPtr() {
      // assembly/kernel/gpu/getGpuKnotBufPtr() => usize
      return exports.getGpuKnotBufPtr() >>> 0;
    },
    getGpuKnotBufLen() {
      // assembly/kernel/gpu/getGpuKnotBufLen() => u32
      return exports.getGpuKnotBufLen() >>> 0;
    },
    getGpuSurfaceCount() {
      // assembly/kernel/gpu/getGpuSurfaceCount() => u32
      return exports.getGpuSurfaceCount() >>> 0;
    },
    getTessOutVertsPtr() {
      // assembly/kernel/tessellation/getTessOutVertsPtr() => usize
      return exports.getTessOutVertsPtr() >>> 0;
    },
    getTessOutNormalsPtr() {
      // assembly/kernel/tessellation/getTessOutNormalsPtr() => usize
      return exports.getTessOutNormalsPtr() >>> 0;
    },
    getTessOutIndicesPtr() {
      // assembly/kernel/tessellation/getTessOutIndicesPtr() => usize
      return exports.getTessOutIndicesPtr() >>> 0;
    },
    getTessOutFaceMapPtr() {
      // assembly/kernel/tessellation/getTessOutFaceMapPtr() => usize
      return exports.getTessOutFaceMapPtr() >>> 0;
    },
    getTessOutVertCount() {
      // assembly/kernel/tessellation/getTessOutVertCount() => u32
      return exports.getTessOutVertCount() >>> 0;
    },
    getTessOutTriCount() {
      // assembly/kernel/tessellation/getTessOutTriCount() => u32
      return exports.getTessOutTriCount() >>> 0;
    },
    getEdgeSamplePtsPtr() {
      // assembly/kernel/tessellation/getEdgeSamplePtsPtr() => usize
      return exports.getEdgeSamplePtsPtr() >>> 0;
    },
    getEdgeSampleCount(edgeId) {
      // assembly/kernel/tessellation/getEdgeSampleCount(u32) => u32
      return exports.getEdgeSampleCount(edgeId) >>> 0;
    },
    getEdgeSampleStart(edgeId) {
      // assembly/kernel/tessellation/getEdgeSampleStart(u32) => u32
      return exports.getEdgeSampleStart(edgeId) >>> 0;
    },
    classifyFacesViaOctree(faceStartA, faceEndA, faceStartB, faceEndB) {
      // assembly/kernel/ops/classifyFacesViaOctree(u32, u32, u32, u32) => u32
      return exports.classifyFacesViaOctree(faceStartA, faceEndA, faceStartB, faceEndB) >>> 0;
    },
    planePlaneIntersect(pAx, pAy, pAz, nAx, nAy, nAz, pBx, pBy, pBz, nBx, nBy, nBz, angularTol) {
      // assembly/kernel/ops/planePlaneIntersect(f64, f64, f64, f64, f64, f64, f64, f64, f64, f64, f64, f64, f64) => u32
      return exports.planePlaneIntersect(pAx, pAy, pAz, nAx, nAy, nAz, pBx, pBy, pBz, nBx, nBy, nBz, angularTol) >>> 0;
    },
    getPlanePlaneIntersectPtr() {
      // assembly/kernel/ops/getPlanePlaneIntersectPtr() => usize
      return exports.getPlanePlaneIntersectPtr() >>> 0;
    },
    planeSphereIntersect(pPx, pPy, pPz, pNx, pNy, pNz, sCx, sCy, sCz, sR, distTol) {
      // assembly/kernel/ops/planeSphereIntersect(f64, f64, f64, f64, f64, f64, f64, f64, f64, f64, f64) => u32
      return exports.planeSphereIntersect(pPx, pPy, pPz, pNx, pNy, pNz, sCx, sCy, sCz, sR, distTol) >>> 0;
    },
    getPlaneSphereIntersectPtr() {
      // assembly/kernel/ops/getPlaneSphereIntersectPtr() => usize
      return exports.getPlaneSphereIntersectPtr() >>> 0;
    },
    planeCylinderIntersect(pPx, pPy, pPz, pNx, pNy, pNz, cOx, cOy, cOz, cAx, cAy, cAz, cR, angularTol, distTol) {
      // assembly/kernel/ops/planeCylinderIntersect(f64, f64, f64, f64, f64, f64, f64, f64, f64, f64, f64, f64, f64, f64, f64) => u32
      return exports.planeCylinderIntersect(pPx, pPy, pPz, pNx, pNy, pNz, cOx, cOy, cOz, cAx, cAy, cAz, cR, angularTol, distTol) >>> 0;
    },
    getPlaneCylinderIntersectPtr() {
      // assembly/kernel/ops/getPlaneCylinderIntersectPtr() => usize
      return exports.getPlaneCylinderIntersectPtr() >>> 0;
    },
    pointToPlaneDistance(px, py, pz, gOff, reversed) {
      // assembly/kernel/ops/pointToPlaneDistance(f64, f64, f64, u32, bool) => f64
      reversed = reversed ? 1 : 0;
      return exports.pointToPlaneDistance(px, py, pz, gOff, reversed);
    },
    getFaceClassificationPtr() {
      // assembly/kernel/ops/getFaceClassificationPtr() => usize
      return exports.getFaceClassificationPtr() >>> 0;
    },
    isxGetCount() {
      // assembly/kernel/ops/isxGetCount() => u32
      return exports.isxGetCount() >>> 0;
    },
    isxAreDistinct(a, b) {
      // assembly/kernel/ops/isxAreDistinct(u32, u32) => bool
      return exports.isxAreDistinct(a, b) != 0;
    },
    cbrepDehydrate() {
      // assembly/kernel/interop/cbrepDehydrate() => u32
      return exports.cbrepDehydrate() >>> 0;
    },
    cbrepHydrate(input, inputLen) {
      // assembly/kernel/interop/cbrepHydrate(~lib/staticarray/StaticArray<u8>, u32) => u32
      input = __lowerStaticArray(__setU8, 31, 0, input, Uint8Array) || __notnull();
      return exports.cbrepHydrate(input, inputLen) >>> 0;
    },
    cbrepHydrateForHandle(handleId, input, inputLen) {
      // assembly/kernel/interop/cbrepHydrateForHandle(u32, ~lib/staticarray/StaticArray<u8>, u32) => u32
      input = __lowerStaticArray(__setU8, 31, 0, input, Uint8Array) || __notnull();
      return exports.cbrepHydrateForHandle(handleId, input, inputLen) >>> 0;
    },
    getCbrepOutPtr() {
      // assembly/kernel/interop/getCbrepOutPtr() => usize
      return exports.getCbrepOutPtr() >>> 0;
    },
    getCbrepOutLen() {
      // assembly/kernel/interop/getCbrepOutLen() => u32
      return exports.getCbrepOutLen() >>> 0;
    },
    stepLexGetInputPtr() {
      // assembly/kernel/step_lexer/stepLexGetInputPtr() => usize
      return exports.stepLexGetInputPtr() >>> 0;
    },
    stepLexGetInputCapacity() {
      // assembly/kernel/step_lexer/stepLexGetInputCapacity() => u32
      return exports.stepLexGetInputCapacity() >>> 0;
    },
    stepLexGetTokenBufPtr() {
      // assembly/kernel/step_lexer/stepLexGetTokenBufPtr() => usize
      return exports.stepLexGetTokenBufPtr() >>> 0;
    },
    stepLexGetTokenCount() {
      // assembly/kernel/step_lexer/stepLexGetTokenCount() => u32
      return exports.stepLexGetTokenCount() >>> 0;
    },
    stepLexGetTokenStride() {
      // assembly/kernel/step_lexer/stepLexGetTokenStride() => u32
      return exports.stepLexGetTokenStride() >>> 0;
    },
    stepLexGetStringPoolPtr() {
      // assembly/kernel/step_lexer/stepLexGetStringPoolPtr() => usize
      return exports.stepLexGetStringPoolPtr() >>> 0;
    },
    stepLexGetStringPoolLen() {
      // assembly/kernel/step_lexer/stepLexGetStringPoolLen() => u32
      return exports.stepLexGetStringPoolLen() >>> 0;
    },
    stepLexGetErrorOffset() {
      // assembly/kernel/step_lexer/stepLexGetErrorOffset() => u32
      return exports.stepLexGetErrorOffset() >>> 0;
    },
    stepParseGetEntityBufPtr() {
      // assembly/kernel/step_parser/stepParseGetEntityBufPtr() => usize
      return exports.stepParseGetEntityBufPtr() >>> 0;
    },
    stepParseGetEntityStride() {
      // assembly/kernel/step_parser/stepParseGetEntityStride() => u32
      return exports.stepParseGetEntityStride() >>> 0;
    },
    stepParseGetEntityCount() {
      // assembly/kernel/step_parser/stepParseGetEntityCount() => u32
      return exports.stepParseGetEntityCount() >>> 0;
    },
    stepParseGetArgBufPtr() {
      // assembly/kernel/step_parser/stepParseGetArgBufPtr() => usize
      return exports.stepParseGetArgBufPtr() >>> 0;
    },
    stepParseGetArgStride() {
      // assembly/kernel/step_parser/stepParseGetArgStride() => u32
      return exports.stepParseGetArgStride() >>> 0;
    },
    stepParseGetArgCount() {
      // assembly/kernel/step_parser/stepParseGetArgCount() => u32
      return exports.stepParseGetArgCount() >>> 0;
    },
    stepParseGetErrorTokenIdx() {
      // assembly/kernel/step_parser/stepParseGetErrorTokenIdx() => u32
      return exports.stepParseGetErrorTokenIdx() >>> 0;
    },
    stepBuildGetSkippedFaceCount() {
      // assembly/kernel/step_topology/stepBuildGetSkippedFaceCount() => u32
      return exports.stepBuildGetSkippedFaceCount() >>> 0;
    },
    stepBuildGetLastErrorStepId() {
      // assembly/kernel/step_topology/stepBuildGetLastErrorStepId() => u32
      return exports.stepBuildGetLastErrorStepId() >>> 0;
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
  function __lowerStaticArray(lowerElement, id, align, values, typedConstructor) {
    if (values == null) return 0;
    const
      length = values.length,
      buffer = exports.__pin(exports.__new(length << align, id)) >>> 0;
    if (typedConstructor) {
      new typedConstructor(memory.buffer, buffer, length).set(values);
    } else {
      for (let i = 0; i < length; i++) lowerElement(buffer + (i << align >>> 0), values[i]);
    }
    exports.__unpin(buffer);
    return buffer;
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
  function __setU8(pointer, value) {
    try {
      __dataview.setUint8(pointer, value, true);
    } catch {
      __dataview = new DataView(memory.buffer);
      __dataview.setUint8(pointer, value, true);
    }
  }
  function __setU32(pointer, value) {
    try {
      __dataview.setUint32(pointer, value, true);
    } catch {
      __dataview = new DataView(memory.buffer);
      __dataview.setUint32(pointer, value, true);
    }
  }
  function __setF32(pointer, value) {
    try {
      __dataview.setFloat32(pointer, value, true);
    } catch {
      __dataview = new DataView(memory.buffer);
      __dataview.setFloat32(pointer, value, true);
    }
  }
  function __setF64(pointer, value) {
    try {
      __dataview.setFloat64(pointer, value, true);
    } catch {
      __dataview = new DataView(memory.buffer);
      __dataview.setFloat64(pointer, value, true);
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
  getTessVertsPtr,
  getTessNormalsPtr,
  getTessFacesPtr,
  getCurvePtsPtr,
  nurbsCurveEvaluate,
  nurbsCurveTessellate,
  nurbsSurfaceEvaluate,
  nurbsSurfaceNormal,
  nurbsSurfaceTessellate,
  getDerivBufPtr,
  getBatchBufPtr,
  getBatchBufLen,
  getMaxTessSegs,
  getMaxCurveSegs,
  nurbsCurveDerivEval,
  nurbsCurveBatchDerivEval,
  nurbsSurfaceDerivEval,
  nurbsSurfaceBatchDerivEval,
  earClipTriangulate,
  computeTriangleNormal,
  computeBoundingBox,
  computeMeshVolume,
  HANDLE_NONE,
  RESIDENCY_UNMATERIALIZED,
  RESIDENCY_HYDRATING,
  RESIDENCY_RESIDENT,
  RESIDENCY_STALE,
  RESIDENCY_DISPOSED,
  handleAlloc,
  handleRelease,
  handleAddRef,
  handleIsValid,
  handleGetResidency,
  handleSetResidency,
  handleGetRevision,
  handleBumpRevision,
  handleSetFeatureId,
  handleGetFeatureId,
  handleSetIrHash,
  handleGetIrHash,
  handleGetRefCount,
  handleLiveCount,
  handleGlobalRevision,
  handleReleaseAll,
  handleSetBodyStart,
  handleSetBodyEnd,
  handleGetFaceStart,
  handleGetFaceEnd,
  handleGetVertexStart,
  handleGetVertexEnd,
  handleGetShellStart,
  handleGetShellEnd,
  handleGetGeomStart,
  handleGetGeomEnd,
  MAX_VERTICES,
  MAX_EDGES,
  MAX_COEDGES,
  MAX_LOOPS,
  MAX_FACES,
  MAX_SHELLS,
  GEOM_NONE,
  GEOM_PLANE,
  GEOM_CYLINDER,
  GEOM_CONE,
  GEOM_SPHERE,
  GEOM_TORUS,
  GEOM_NURBS_SURFACE,
  GEOM_LINE,
  GEOM_CIRCLE,
  GEOM_ELLIPSE,
  GEOM_NURBS_CURVE,
  ORIENT_FORWARD,
  ORIENT_REVERSED,
  vertexAdd,
  vertexGetX,
  vertexGetY,
  vertexGetZ,
  vertexGetCount,
  edgeAdd,
  edgeGetStartVertex,
  edgeGetEndVertex,
  edgeGetGeomType,
  edgeGetGeomOffset,
  edgeGetCount,
  coedgeAdd,
  coedgeGetEdge,
  coedgeGetOrient,
  coedgeGetNext,
  coedgeGetLoop,
  coedgeSetNext,
  coedgeGetCount,
  loopAdd,
  loopGetFirstCoedge,
  loopGetFace,
  loopIsOuterLoop,
  loopGetCount,
  faceAdd,
  faceGetFirstLoop,
  faceGetShell,
  faceGetGeomType,
  faceGetGeomOffset,
  faceGetOrient,
  faceGetLoopCount,
  faceGetCount,
  shellAdd,
  shellGetFirstFace,
  shellGetFaceCount,
  shellIsClosed_,
  shellGetCount,
  bodyBegin,
  bodyEnd,
  bodyBeginForHandle,
  bodyEndForHandle,
  topologyResetAll,
  bodyGetShellCount,
  bodyGetFirstShell,
  getVertexCoordsPtr,
  getVertexCoordsLen,
  getEdgeStartVertexPtr,
  getEdgeEndVertexPtr,
  topoGetSummary,
  nurbsSurfaceStore,
  nurbsCurveStore,
  planeStore,
  cylinderStore,
  sphereStore,
  coneStore,
  torusStore,
  geomPoolRead,
  getGeomPoolPtr,
  geomPoolUsed,
  geomPoolReset,
  geomPoolSetUsed,
  geomStagingPtr,
  geomStagingCapacity,
  nurbsSurfaceStoreFromStaging,
  nurbsCurveStoreFromStaging,
  transformIdentity,
  transformTranslation,
  transformRotation,
  transformScale,
  transformMultiply,
  transformPoint,
  transformPointByOutMat,
  transformDirection,
  transformDirectionByOutMat,
  transformBoundingBox,
  getTransformOutMatPtr,
  getTransformOutPtPtr,
  getTransformOutBoxPtr,
  octreeReset,
  octreeAddFaceAABB,
  octreeBuild,
  octreeQueryPairs,
  getOctreePairsPtr,
  octreeGetPairCount,
  octreeGetNodeCount,
  gpuBatchReset,
  gpuBatchAddSurface,
  getGpuHeaderBufPtr,
  getGpuHeaderBufLen,
  getGpuCtrlBufPtr,
  getGpuCtrlBufLen,
  getGpuKnotBufPtr,
  getGpuKnotBufLen,
  getGpuSurfaceCount,
  tessBuildAllFaces,
  tessBuildFace,
  tessReset,
  getTessOutVertsPtr,
  getTessOutNormalsPtr,
  getTessOutIndicesPtr,
  getTessOutFaceMapPtr,
  getTessOutVertCount,
  getTessOutTriCount,
  getEdgeSamplePtsPtr,
  getEdgeSampleCount,
  getEdgeSampleStart,
  CLASSIFY_OUTSIDE,
  CLASSIFY_INSIDE,
  CLASSIFY_ON_BOUNDARY,
  CLASSIFY_UNKNOWN,
  classifyPointVsShell,
  classifyPointVsTriangles,
  classifyFacesViaOctree,
  planePlaneIntersect,
  getPlanePlaneIntersectPtr,
  planeSphereIntersect,
  getPlaneSphereIntersectPtr,
  planeCylinderIntersect,
  getPlaneCylinderIntersectPtr,
  getFaceClassification,
  setFaceClassification,
  pointToPlaneDistance,
  pointToSphereDistance,
  pointToCylinderDistance,
  getFaceClassificationPtr,
  isxReset,
  isxRecord,
  isxGetErrorBound,
  isxGetCount,
  isxGetMaxErrorBound,
  isxAreDistinct,
  isxRayFace,
  cbrepDehydrate,
  cbrepHydrate,
  cbrepHydrateForHandle,
  getCbrepOutPtr,
  getCbrepOutLen,
  TOKEN_EOF,
  TOKEN_HASH_ID,
  TOKEN_HASH_REF,
  TOKEN_KEYWORD,
  TOKEN_NUMBER,
  TOKEN_STRING,
  TOKEN_ENUM,
  TOKEN_DOLLAR,
  TOKEN_STAR,
  TOKEN_LPAREN,
  TOKEN_RPAREN,
  TOKEN_COMMA,
  TOKEN_EQUALS,
  TOKEN_SEMICOLON,
  STEP_LEX_OK,
  STEP_LEX_ERR_BAD_CHAR,
  STEP_LEX_ERR_UNTERMINATED_STRING,
  STEP_LEX_ERR_INPUT_TOO_LARGE,
  STEP_LEX_ERR_TOKEN_OVERFLOW,
  STEP_LEX_ERR_STRPOOL_OVERFLOW,
  stepLexReset,
  stepLexRun,
  stepLexGetInputPtr,
  stepLexGetInputCapacity,
  stepLexGetTokenBufPtr,
  stepLexGetTokenCount,
  stepLexGetTokenStride,
  stepLexGetStringPoolPtr,
  stepLexGetStringPoolLen,
  stepLexGetErrorOffset,
  stepLexGetErrorCode,
  ARG_NULL,
  ARG_REF,
  ARG_NUMBER,
  ARG_STRING,
  ARG_ENUM,
  ARG_LIST,
  STEP_PARSE_OK,
  STEP_PARSE_ERR_UNEXPECTED_TOKEN,
  STEP_PARSE_ERR_ENTITY_OVERFLOW,
  STEP_PARSE_ERR_ARG_OVERFLOW,
  STEP_PARSE_ERR_MISSING_DATA_SECTION,
  STEP_PARSE_ERR_BAD_COMPLEX_ENTITY,
  stepParseReset,
  stepParseRun,
  stepParseGetEntityBufPtr,
  stepParseGetEntityStride,
  stepParseGetEntityCount,
  stepParseGetArgBufPtr,
  stepParseGetArgStride,
  stepParseGetArgCount,
  stepParseGetErrorCode,
  stepParseGetErrorTokenIdx,
  STEP_BUILD_OK,
  STEP_BUILD_ERR_NO_SHELL,
  STEP_BUILD_ERR_STEP_ID_OVERFLOW,
  STEP_BUILD_ERR_MISSING_ENTITY,
  STEP_BUILD_ERR_UNSUPPORTED_SURFACE,
  STEP_BUILD_ERR_UNSUPPORTED_CURVE,
  STEP_BUILD_ERR_BAD_ARGS,
  STEP_BUILD_ERR_TOPOLOGY_OVERFLOW,
  stepBuildInit,
  stepBuildRun,
  stepBuildGetSkippedFaceCount,
  stepBuildGetLastError,
  stepBuildGetLastErrorStepId,
} = await (async url => instantiate(
  await (async () => {
    const isNodeOrBun = typeof process != "undefined" && process.versions != null && (process.versions.node != null || process.versions.bun != null);
    if (isNodeOrBun) { return globalThis.WebAssembly.compile(await (await import("node:fs/promises")).readFile(url)); }
    else { return await globalThis.WebAssembly.compileStreaming(globalThis.fetch(url)); }
  })(), {
  }
))(new URL("release.wasm", import.meta.url));

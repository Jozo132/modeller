// js/cad/CSG.js — Thin re-export facade (H10 transitional shim)
//
// All modelling operations now live in dedicated BRep modules. This file
// exists ONLY for backward compatibility of import paths and will be removed
// once every caller updates to the direct import. Legacy mesh-based
// chamfer/fillet throwing stubs have been removed.

// --- Edge analysis ---
export { computeFeatureEdges, makeEdgeKey, expandPathEdgeKeys } from './EdgeAnalysis.js';

// --- BRep chamfer ---
export { applyBRepChamfer } from './BRepChamfer.js';

// --- Boolean operations ---
export { booleanOp } from './BooleanDispatch.js';

// --- Mesh analysis (for visualization / STL export) ---
export {
  countInvertedFaces,
  calculateMeshVolume,
  calculateBoundingBox,
  calculateSurfaceArea,
  detectDisconnectedBodies,
  calculateWallThickness,
} from './toolkit/MeshAnalysis.js';

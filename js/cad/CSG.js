// js/cad/CSG.js — Thin re-export facade
//
// All modelling operations now live in dedicated BRep modules.
// This file exists ONLY for backward compatibility of import paths.
// Legacy mesh-based chamfer/fillet have been removed.

// --- Edge analysis ---
export { computeFeatureEdges, makeEdgeKey, expandPathEdgeKeys } from './EdgeAnalysis.js';

// --- BRep chamfer ---
export { applyBRepChamfer } from './BRepChamfer.js';

// --- Boolean operations ---
export { booleanOp } from './CSGLegacy.js';

// --- Mesh analysis (for visualization / STL export) ---
export {
  countInvertedFaces,
  calculateMeshVolume,
  calculateBoundingBox,
  calculateSurfaceArea,
  detectDisconnectedBodies,
  calculateWallThickness,
} from './toolkit/MeshAnalysis.js';

// --- Legacy stubs that throw (removed mesh-based implementations) ---

/**
 * @deprecated Use applyBRepChamfer from BRepChamfer.js instead.
 * Legacy mesh-based chamfer has been removed.
 */
export function applyChamfer(/* geometry, edgeKeys, distance */) {
  throw new Error(
    '[BRep-only] applyChamfer (legacy mesh chamfer) has been removed. ' +
    'Use applyBRepChamfer from BRepChamfer.js instead. ' +
    'The input solid must have a TopoBody.'
  );
}

/**
 * @deprecated BRep fillet is not yet implemented.
 * Legacy mesh-based fillet has been removed.
 */
export function applyFillet(/* geometry, edgeKeys, radius, segments, edgeOwnerMap */) {
  throw new Error(
    '[BRep-only] applyFillet (legacy mesh fillet) has been removed. ' +
    'BRep fillet (applyBRepFillet) is not yet implemented. ' +
    'Implement rolling-ball offset surfaces on TopoBody.'
  );
}

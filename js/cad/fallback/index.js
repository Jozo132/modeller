// js/cad/fallback/index.js — Fallback pipeline entrypoints
//
// Single barrel re-export for the discrete fallback lane.
// Consumers that only need fallback facilities can import from here
// instead of pulling the entire CAD kernel.

export { ResultGrade, FallbackDiagnostics } from './FallbackDiagnostics.js';
export {
  FallbackTrigger,
  OperationPolicy,
  isFallbackEnabled,
  resolvePolicy,
  shouldTriggerFallback,
  evaluateExactResult,
  wrapResult,
} from './FallbackPolicy.js';
export { buildConformingMesh, mergeVertexSpaces } from './ConformingSurfaceMesh.js';
export { meshBooleanOp } from './MeshBoolean.js';
export { reconstructAdjacency, extractFeatureEdges } from './AdjacencyReconstruction.js';
export { FallbackKind, warnOnceForFallback, _resetWarnOnce, getWarnedFallbackIds } from './warnOnce.js';

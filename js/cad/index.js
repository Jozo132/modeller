// js/cad/index.js — Barrel re-exports
export { Primitive, resetPrimitiveIds, peekNextPrimitiveId } from './Primitive.js';
export { PPoint } from './Point.js';
export { PSegment } from './Segment.js';
export { PArc } from './ArcPrimitive.js';
export { PCircle } from './CirclePrimitive.js';
export { PSpline } from './SplinePrimitive.js';
export { PBezier } from './BezierPrimitive.js';
export { ImagePrimitive } from './ImagePrimitive.js';
export { GroupPrimitive } from './GroupPrimitive.js';
export { TextPrimitive } from './TextPrimitive.js';
export { DimensionPrimitive, detectDimensionType, detectAllDimensionTypes, DIM_TYPES, DISPLAY_MODES } from './DimensionPrimitive.js';
export { Scene } from './Scene.js';
export { Sketch } from './Sketch.js';
export { Part } from './Part.js';
export { Assembly } from './Assembly.js';

// --- Assembly design ---
export {
  PartDefinition, resetPartDefinitionIds,
  PartInstance, resetPartInstanceIds,
  Mate, MateType, resetMateIds,
  pointFeature, axisFeature, planeFeature,
  solveMate, mateResidual, solveAssembly,
  computeWorldAABB, aabbOverlap, aabbClearance,
  broadphaseCollisions, clearanceQuery,
  generateBOM, bomSummary,
  identity as mat4Identity, fromTranslation as mat4FromTranslation,
  fromRotationX, fromRotationY, fromRotationZ,
  fromAxisAngle, compose as mat4Compose, multiply as mat4Multiply,
  invertRigid, transformPoint as mat4TransformPoint,
  transformDirection as mat4TransformDirection,
  extractPosition, transformsEqual,
} from './assembly/index.js';
export { Feature, resetFeatureIds } from './Feature.js';
export { FeatureTree } from './FeatureTree.js';
export { SketchFeature } from './SketchFeature.js';
export { ExtrudeFeature } from './ExtrudeFeature.js';
export { ExtrudeCutFeature } from './ExtrudeCutFeature.js';
export { MultiSketchExtrudeFeature } from './MultiSketchExtrudeFeature.js';
export { RevolveFeature } from './RevolveFeature.js';
export { ChamferFeature } from './ChamferFeature.js';
export { FilletFeature } from './FilletFeature.js';
export { StepImportFeature } from './StepImportFeature.js';
export { solve } from './Solver.js';
export {
  Constraint, resetConstraintIds,
  Coincident, Distance, Fixed,
  Horizontal, Vertical,
  Parallel, Perpendicular, Angle,
  EqualLength, Length,
  RadiusConstraint, Tangent,
  OnLine, OnCircle, Midpoint,
  resolveValue,
  setVariable, getVariable, removeVariable, getAllVariables,
  clearVariables, serializeVariables, deserializeVariables,
} from './Constraint.js';
export {
  disconnect, union, trim, split, movePoint, moveShape,
  chamferSketchCorner, filletSketchCorner, resolveSketchCorner,
} from './Operations.js';
export { booleanOp } from './BooleanDispatch.js';
export { computeFeatureEdges, makeEdgeKey, expandPathEdgeKeys } from './EdgeAnalysis.js';
export { applyBRepChamfer } from './BRepChamfer.js';
export {
  calculateMeshVolume, calculateBoundingBox, calculateSurfaceArea,
  detectDisconnectedBodies, calculateWallThickness, countInvertedFaces,
} from './toolkit/MeshAnalysis.js';
// Back-compat aliases — applyChamfer / applyFillet now point at the live
// BRep kernel implementations. Mesh-based stubs were removed by H10.
export { applyBRepChamfer as applyChamfer } from './BRepChamfer.js';
export { applyBRepFillet as applyFillet } from './BRepFillet.js';
export { NurbsCurve } from './NurbsCurve.js';
export { NurbsSurface } from './NurbsSurface.js';
export { BRep, BRepVertex, BRepEdge, BRepFace, tessellateNurbsFaces } from './BRep.js';

// --- New exact-geometry modules ---
export { Tolerance, DEFAULT_TOLERANCE } from './Tolerance.js';
export {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody, resetTopoIds, deriveEdgeAndVertexHashes,
} from './BRepTopology.js';
export { ValidationResult, validateBody, validateIncidence, validateNoDuplicateEdges, validateFull } from './BRepValidator.js';
export { tessellateBody, tessellateFace, tessellateForSTL } from './Tessellation.js';
export { curveCurveIntersect } from './CurveCurveIntersect.js';
export { curveSurfaceIntersect } from './CurveSurfaceIntersect.js';
export { surfaceSurfaceIntersect } from './SurfaceSurfaceIntersect.js';
export { intersectCurves, intersectCurveSurface, intersectSurfaces, intersectBodies } from './Intersections.js';
export { splitFace, classifyPointOnFace, classifyFragment } from './FaceSplitter.js';
export {
  classifyPoint, classifyPoints, classifyFragment as containmentClassifyFragment,
  isPointOnFace, maybeResolveUncertain,
  getShadowDisagreements, clearShadowDisagreements,
} from './Containment.js';
export { stitchFaces, buildBody } from './ShellBuilder.js';
export { exactBooleanOp, hasExactTopology } from './BooleanKernel.js';
export { exportSTEP, exportSTEPDetailed } from './StepExport.js';
export { importSTEP, parseSTEPTopology } from './StepImport.js';
export { TessellationConfig } from './TessellationConfig.js';
export { wasmTessellation } from './WasmTessellation.js';
export { GeometryEvaluator } from './GeometryEvaluator.js';
export {
  validateMesh, detectBoundaryEdges, detectSelfIntersections,
  detectDegenerateFaces, checkWatertight,
} from './MeshValidator.js';
export {
  IntersectionValidation, validateIntersections, validateFragments, validateFinalBody,
} from './IntersectionValidator.js';
export { HealingReport, healFragments } from './Healing.js';
export { BooleanInvariantResult, validateBooleanResult } from './BooleanInvariantValidator.js';

// --- Fallback lane ---
export { ResultGrade, FallbackDiagnostics } from './fallback/FallbackDiagnostics.js';
export {
  FallbackTrigger, OperationPolicy,
  isFallbackEnabled, resolvePolicy, shouldTriggerFallback,
  evaluateExactResult, wrapResult,
} from './fallback/FallbackPolicy.js';
export { buildConformingMesh, mergeVertexSpaces } from './fallback/ConformingSurfaceMesh.js';
export { meshBooleanOp } from './fallback/MeshBoolean.js';
export { reconstructAdjacency, extractFeatureEdges } from './fallback/AdjacencyReconstruction.js';

// --- Diagnostic / result schemas ---
export { BooleanResult, TessellationResult, ContainmentResult } from './diagnostics.js';

// --- History / replay / stable keys ---
export {
  EntityType, RemapStatus,
  vertexKey, edgeKey, faceKey,
  parseKey, isStableKey, isLegacyEdgeKey,
  legacyEdgeKeyToStable,
  keyBody, resolveKey,
  serializeKeys, deserializeKeys,
} from './history/StableEntityKey.js';
export { buildCacheKey, HistoryCache } from './history/HistoryCache.js';
export {
  ReplayStatus, DiagnosticReason,
  FeatureReplayDiagnostic, FeatureReplayResult,
  resolveEdgeSelections, replayFeatureTree,
} from './history/FeatureReplay.js';


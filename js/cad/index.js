// js/cad/index.js — Barrel re-exports
export { Primitive, resetPrimitiveIds, peekNextPrimitiveId } from './Primitive.js';
export { PPoint } from './Point.js';
export { PSegment } from './Segment.js';
export { PArc } from './ArcPrimitive.js';
export { PCircle } from './CirclePrimitive.js';
export { PSpline } from './SplinePrimitive.js';
export { TextPrimitive } from './TextPrimitive.js';
export { DimensionPrimitive, detectDimensionType, detectAllDimensionTypes, DIM_TYPES, DISPLAY_MODES } from './DimensionPrimitive.js';
export { Scene } from './Scene.js';
export { Sketch } from './Sketch.js';
export { Part } from './Part.js';
export { Assembly } from './Assembly.js';
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
export { disconnect, union, trim, split, movePoint, moveShape } from './Operations.js';
export { booleanOp, calculateMeshVolume, calculateBoundingBox, applyChamfer, applyFillet, makeEdgeKey, expandPathEdgeKeys } from './CSG.js';
export { NurbsCurve } from './NurbsCurve.js';
export { NurbsSurface } from './NurbsSurface.js';
export { BRep, BRepVertex, BRepEdge, BRepFace, tessellateNurbsFaces } from './BRep.js';

// --- New exact-geometry modules ---
export { Tolerance, DEFAULT_TOLERANCE } from './Tolerance.js';
export {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody, resetTopoIds,
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
} from './Containment.js';
export { stitchFaces, buildBody } from './ShellBuilder.js';
export { exactBooleanOp, hasExactTopology } from './BooleanKernel.js';
export { exportSTEP } from './StepExport.js';
export { importSTEP, parseSTEPTopology } from './StepImport.js';
export { TessellationConfig } from './TessellationConfig.js';
export { wasmTessellation } from './WasmTessellation.js';
export { GeometryEvaluator } from './GeometryEvaluator.js';
export {
  robustTessellateBody, tessellateBodyRouted,
  EdgeSampler, FaceTriangulator, MeshStitcher,
  computeMeshHash, meshSummary,
} from './Tessellator2/index.js';
export {
  IntersectionValidation, validateIntersections, validateFragments, validateFinalBody,
} from './IntersectionValidator.js';
export { HealingReport, healFragments } from './Healing.js';
export { BooleanInvariantResult, validateBooleanResult } from './BooleanInvariantValidator.js';

// --- Fallback lane ---
export { ResultGrade, FallbackDiagnostics } from './fallback/FallbackDiagnostics.js';
export {
  FallbackTrigger, isFallbackEnabled, shouldTriggerFallback,
  evaluateExactResult, wrapResult,
} from './fallback/FallbackPolicy.js';
export { buildConformingMesh, mergeVertexSpaces } from './fallback/ConformingSurfaceMesh.js';
export { meshBooleanOp } from './fallback/MeshBoolean.js';
export { reconstructAdjacency, extractFeatureEdges } from './fallback/AdjacencyReconstruction.js';


// js/index.js — Main library entry point for modeller NPM package
//
// This file re-exports all public, environment-agnostic APIs so the package
// can be consumed both in Node.js (backend meshing, conversion, testing) and
// in browser environments (3D viewer, 2D viewer, parametric modelling).
//
// Usage (Node / bundler):
//   import { Part, Sketch, buildCMOD, parseCMOD } from 'modeller';
//   import { renderCmodToPngBuffer } from 'modeller/render';
//   import * as cad from 'modeller/cad';

// --- Core CAD (geometry, constraints, features, NURBS, B-Rep, CSG) ---
export {
  // Primitives / sketch entities
  Primitive, resetPrimitiveIds, peekNextPrimitiveId,
  PPoint, PSegment, PArc, PCircle,
  TextPrimitive,
  DimensionPrimitive, detectDimensionType, detectAllDimensionTypes, DIM_TYPES, DISPLAY_MODES,

  // High-level model objects
  Scene, Sketch, Part, Assembly,

  // Feature system
  Feature, resetFeatureIds, FeatureTree,
  SketchFeature, ExtrudeFeature, ExtrudeCutFeature, RevolveFeature,
  ChamferFeature, FilletFeature,
  StepImportFeature,

  // Constraint solver
  solve,
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

  // 2D sketch operations
  disconnect, union, trim, split, movePoint, moveShape,

  // CSG / mesh operations
  booleanOp, calculateMeshVolume, calculateBoundingBox,
  applyChamfer, applyFillet, makeEdgeKey, expandPathEdgeKeys,

  // NURBS
  NurbsCurve, NurbsSurface,

  // B-Rep
  BRep, BRepVertex, BRepEdge, BRepFace, tessellateNurbsFaces,

  // Exact B-Rep topology
  Tolerance, DEFAULT_TOLERANCE,
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody, resetTopoIds,

  // Validation
  ValidationResult, validateBody, validateIncidence, validateNoDuplicateEdges, validateFull,

  // Tessellation
  tessellateBody, tessellateFace, tessellateForSTL,

  // Intersection
  curveCurveIntersect, curveSurfaceIntersect, surfaceSurfaceIntersect,
  intersectCurves, intersectCurveSurface, intersectSurfaces, intersectBodies,

  // Face splitting / shell building / Boolean kernel
  splitFace, classifyPointOnFace, classifyFragment,
  stitchFaces, buildBody,
  exactBooleanOp, hasExactTopology,

  // STEP export & import
  exportSTEP,
  importSTEP,
  parseSTEPTopology,
} from './cad/index.js';

// --- CMOD project file (headless, no DOM required) ---
export {
  buildCMOD,
  parseCMOD,
  getScenesFromCMOD,
} from './cmod.js';

// --- Part manager (high-level part workflow helper) ---
export { PartManager } from './part-manager.js';

// --- Logger utility ---
export { setLogEnabled, setLogLevel, debug, info, warn, error } from './logger.js';

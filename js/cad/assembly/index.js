// js/cad/assembly/index.js — Barrel re-exports for the assembly module

export { PartDefinition, resetPartDefinitionIds } from './PartDefinition.js';
export { PartInstance, resetPartInstanceIds } from './PartInstance.js';
export {
  Mate, MateType, resetMateIds,
  pointFeature, axisFeature, planeFeature,
  solveMate, mateResidual,
} from './Mate.js';
export { solveAssembly } from './AssemblySolver.js';
export {
  computeWorldAABB, aabbOverlap, aabbClearance,
  broadphaseCollisions, clearanceQuery,
} from './CollisionDetection.js';
export { generateBOM, bomSummary } from './BOM.js';
export {
  identity, fromTranslation, fromRotationX, fromRotationY, fromRotationZ,
  fromAxisAngle, compose, multiply, invertRigid,
  transformPoint, transformDirection, extractPosition, transformsEqual,
  vec3Dot, vec3Cross, vec3Length, vec3Normalize, vec3Sub, vec3Add, vec3Scale, vec3Dist,
} from './Transform3D.js';

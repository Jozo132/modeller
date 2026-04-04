// js/cad/toolkit/index.js — Unified CAD toolkit barrel export
// Consolidates commonly-used helpers so consumers can import from a single path.

export {
  vec3Sub, vec3Add, vec3Scale, vec3Dot, vec3Cross,
  vec3Len, vec3Normalize, vec3Lerp,
  circumsphereCenter, circumCenter3D,
  projectOntoAxis, pointsCoincident3D,
  pointOnFacePlane, rayTriangleIntersect,
  canonicalCoord, canonicalPoint,
  fmtCoord, edgeVKey, edgeKeyFromVerts,
} from './Vec3Utils.js';

export {
  countInvertedFaces, calculateMeshVolume,
  calculateBoundingBox, calculateSurfaceArea,
  detectDisconnectedBodies, calculateWallThickness,
} from './MeshAnalysis.js';

export {
  computePolygonNormal, faceCentroid,
  edgeKey, collectFaceEdgeKeys,
  findEdgeNormals, trimFaceEdge,
  pointOnSegmentStrict,
} from './GeometryUtils.js';

export {
  weldVertices, deduplicatePolygon,
  removeDegenerateFaces, recomputeFaceNormals,
  fixWindingConsistency, countMeshEdgeUsage,
} from './MeshRepair.js';

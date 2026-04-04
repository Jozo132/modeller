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
  distancePointToLineSegment, openPolylineNormal,
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
  cloneMeshFace,
} from './MeshRepair.js';

export {
  isConvexPlanarPolygon, projectPolygon2D,
  triangulatePlanarPolygon, classifyFaceType,
} from './PlanarMath.js';

export { chainEdgePaths } from './EdgePathUtils.js';

export {
  measureMeshTopology, countTopoBodyBoundaryEdges,
  findAdjacentFaces, buildVertexEdgeMap,
} from './TopologyUtils.js';

export {
  polygonArea, collinearSegmentsOverlap,
  coplanarFacesTouch, facesSharePlane,
  sameNormalPair, coplanarFaceClusterKey,
  sharedMetadataSignature,
} from './CoplanarUtils.js';

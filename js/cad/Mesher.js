// js/cad/Mesher.js — Unified mesh generation entry point
//
// The Mesher is responsible for converting exact B-Rep topology (TopoBody)
// into triangle meshes for:
//   1. Display / rendering (WebGL, WebGPU)
//   2. STL export (3D printing)
//   3. Mesh analysis (volume, bounding box, surface area, etc.)
//
// This module delegates to the robust Tessellator2 pipeline for all
// tessellation. Legacy ear-clipping has been removed.
//
// Architecture:
//   BRep (TopoBody) → Mesher → { faces[], edges[], vertices[] }
//                                 ↓
//                         Renderer / STL Export / Analysis

// --- Tessellation ---
export { tessellateBody, tessellateFace, tessellateForSTL } from './Tessellation.js';

// --- Mesh analysis (post-tessellation) ---
export {
  countInvertedFaces,
  calculateMeshVolume,
  calculateBoundingBox,
  calculateSurfaceArea,
  detectDisconnectedBodies,
  calculateWallThickness,
} from './toolkit/MeshAnalysis.js';

// --- Mesh validation ---
export {
  validateMesh,
  detectBoundaryEdges,
  detectSelfIntersections,
  detectDegenerateFaces,
  checkWatertight,
} from './MeshValidator.js';

// --- Mesh repair (for tessellated output) ---
export {
  weldVertices,
  removeDegenerateFaces,
  fixWindingConsistency,
  recomputeFaceNormals,
  cloneMeshFace,
} from './toolkit/MeshRepair.js';

// --- Edge analysis (feature edges from tessellated mesh) ---
export { computeFeatureEdges } from './EdgeAnalysis.js';

// --- Tessellation configuration ---
export { TessellationConfig } from './TessellationConfig.js';

// --- WASM-accelerated tessellation ---
export { wasmTessellation } from './WasmTessellation.js';

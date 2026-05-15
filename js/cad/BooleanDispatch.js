// js/cad/BooleanDispatch.js — Boolean operation dispatcher
//
// Routes boolean operations through the exact B-Rep kernel.
// Legacy mesh BSP booleans have been removed — operands MUST carry
// exact topology (TopoBody).
//
// Renamed from CSGLegacy.js (H10 retire CSG.js/CSGLegacy.js). The file is
// not legacy in behavior — it is the live dispatcher for every boolean
// op in the feature pipeline.

import { exactBooleanOp, hasExactTopology } from './BooleanKernel.js';
import { computeFeatureEdges } from './EdgeAnalysis.js';
import { tryBuildOcctBooleanMetadataSync } from './occt/OcctSketchModeling.js';
import { chainEdgePaths } from './toolkit/EdgePathUtils.js';

import {
  vec3Sub as _vec3Sub,
  vec3Dot as _vec3Dot,
  vec3Cross as _vec3Cross,
  vec3Len as _vec3Len,
  vec3Normalize as _vec3Normalize,
  edgeVKey as _edgeVKey,
  edgeKeyFromVerts as _edgeKeyFromVerts,
} from './toolkit/Vec3Utils.js';

import {
  computePolygonNormal as _computePolygonNormal,
} from './toolkit/GeometryUtils.js';

import {
  removeDegenerateFaces as _removeDegenerateFaces,
  fixWindingConsistency as _fixWindingConsistency,
} from './toolkit/MeshRepair.js';

import {
  classifyFaceType,
  triangulatePlanarPolygon as _triangulatePlanarPolygon,
} from './toolkit/PlanarMath.js';

import {
  polygonArea as _polygonArea,
  facesSharePlane as _facesSharePlane,
} from './toolkit/CoplanarUtils.js';

import { measureMeshTopology } from './toolkit/TopologyUtils.js';

// -----------------------------------------------------------------------
// _compactExactPlanarDisplayFaces — merges coplanar display faces after
// exact boolean for cleaner wireframe presentation.
// -----------------------------------------------------------------------

function _compactExactPlanarDisplayFaces(inputFaces) {
  if (!inputFaces || inputFaces.length === 0) return inputFaces;

  // Build adjacency by shared edge keys
  const edgeToFaces = new Map();
  for (let fi = 0; fi < inputFaces.length; fi++) {
    const verts = inputFaces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const key = _edgeKeyFromVerts(a, b);
      if (!edgeToFaces.has(key)) edgeToFaces.set(key, []);
      edgeToFaces.get(key).push(fi);
    }
  }

  // Union-Find for merging coplanar adjacent faces
  const parent = inputFaces.map((_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function unite(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

  for (const [, fis] of edgeToFaces) {
    if (fis.length !== 2) continue;
    const [a, b] = fis;
    const fA = inputFaces[a], fB = inputFaces[b];
    if (_facesSharePlane(fA, fB) &&
        JSON.stringify(fA.shared || null) === JSON.stringify(fB.shared || null)) {
      unite(a, b);
    }
  }

  // Group faces by root
  const groups = new Map();
  for (let i = 0; i < inputFaces.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const result = [];
  for (const [, fis] of groups) {
    if (fis.length === 1) {
      result.push(inputFaces[fis[0]]);
      continue;
    }

    // Merge faces in the group: collect all boundary edges
    const edgeCount = new Map();
    const allVerts = [];
    let shared = null;
    for (const fi of fis) {
      const f = inputFaces[fi];
      if (!shared) shared = f.shared;
      const verts = f.vertices;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i], b = verts[(i + 1) % verts.length];
        const key = _edgeKeyFromVerts(a, b);
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
        allVerts.push(a);
      }
    }

    // Boundary edges: used exactly once
    const boundaryEdges = [];
    for (const fi of fis) {
      const verts = inputFaces[fi].vertices;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i], b = verts[(i + 1) % verts.length];
        const key = _edgeKeyFromVerts(a, b);
        if (edgeCount.get(key) === 1) {
          boundaryEdges.push({ start: a, end: b });
        }
      }
    }

    if (boundaryEdges.length === 0) {
      // No boundary — degenerate, keep originals
      for (const fi of fis) result.push(inputFaces[fi]);
      continue;
    }

    // Chain boundary edges into a loop
    const vKey = (v) => _edgeVKey(v);
    const adj = new Map();
    for (const e of boundaryEdges) {
      adj.set(vKey(e.start), e);
    }

    const loop = [];
    let cur = boundaryEdges[0];
    const visited = new Set();
    while (cur && !visited.has(vKey(cur.start))) {
      visited.add(vKey(cur.start));
      loop.push(cur.start);
      cur = adj.get(vKey(cur.end));
    }

    if (loop.length < 3) {
      for (const fi of fis) result.push(inputFaces[fi]);
      continue;
    }

    // Re-compute normal from merged loop
    const normal = _computePolygonNormal(loop);
    const area = _polygonArea(loop, normal);
    if (Math.abs(area) < 1e-12) {
      for (const fi of fis) result.push(inputFaces[fi]);
      continue;
    }

    // Triangulate the merged face
    const tris = _triangulatePlanarPolygon(loop, normal);
    if (!tris || tris.length === 0) {
      for (const fi of fis) result.push(inputFaces[fi]);
      continue;
    }

    // Propagate metadata
    const refFace = inputFaces[fis[0]];
    for (const tri of tris) {
      result.push({
        vertices: tri,
        normal,
        shared: shared || null,
        faceType: refFace.faceType,
        topoFaceId: refFace.topoFaceId,
      });
    }
  }

  return result;
}

// -----------------------------------------------------------------------
// booleanOp — Dispatches to exact B-Rep boolean kernel
// -----------------------------------------------------------------------

/**
 * Perform a boolean operation between two geometries.
 * Both operands MUST carry exact B-Rep topology (topoBody).
 *
 * @param {Object} geomA - First geometry with .topoBody
 * @param {Object} geomB - Second geometry with .topoBody
 * @param {string} operation - 'union', 'subtract', or 'intersect'
 * @returns {Object} Resulting geometry with topoBody, faces, edges, paths
 */
export function booleanOp(geomA, geomB, operation, sharedA = null, sharedB = null) {
  // --- Exact B-Rep dispatch ---
  if (geomA && geomA.topoBody && geomB && geomB.topoBody &&
      hasExactTopology(geomA.topoBody) && hasExactTopology(geomB.topoBody)) {
    const opName = (operation === 'add') ? 'union' : operation;
    const result = exactBooleanOp(geomA.topoBody, geomB.topoBody, opName);
    const {
      body,
      mesh,
      diagnostics,
      resultGrade,
      _isFallback,
      fallbackDiagnostics,
      _occtShadow,
    } = result;
    const occtModeling = tryBuildOcctBooleanMetadataSync({
      handleA: geomA.occtShapeHandle || 0,
      handleB: geomB.occtShapeHandle || 0,
      operation: opName,
    });
    const useOcctDisplay = Array.isArray(occtModeling?.faces) && occtModeling.faces.length > 0;
    const exactDisplayFaces = _compactExactPlanarDisplayFaces(mesh.faces || []);
    const displayFaces = useOcctDisplay ? occtModeling.faces : exactDisplayFaces;
    const displayMesh = useOcctDisplay
      ? occtModeling
      : {
        ...mesh,
        faces: displayFaces,
      };
    const edgeResult = computeFeatureEdges(displayFaces);
    const useOcctEdges = useOcctDisplay
      && Array.isArray(displayMesh.edges)
      && displayMesh.edges.length > 0;
    return {
      ...displayMesh,
      edges: useOcctEdges ? displayMesh.edges : edgeResult.edges,
      paths: useOcctEdges ? chainEdgePaths(displayMesh.edges) : edgeResult.paths,
      visualEdges: edgeResult.visualEdges,
      topoBody: body,
      diagnostics,
      resultGrade,
      _isFallback,
      fallbackDiagnostics,
      _occtShadow,
      ...(occtModeling || {}),
    };
  }

  // --- BRep-only: no fallback to legacy mesh BSP ---
  const missingA = !geomA?.topoBody ? 'operand A' : null;
  const missingB = !geomB?.topoBody ? 'operand B' : null;
  const missing = [missingA, missingB].filter(Boolean).join(' and ');
  throw new Error(
    `[BRep-only] booleanOp('${operation}') requires exact topology on both operands, ` +
    `but ${missing} lack(s) a TopoBody. Legacy CSG/BSP mesh boolean is no longer supported.`
  );
}

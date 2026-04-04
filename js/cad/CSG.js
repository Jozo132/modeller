// js/cad/CSG.js — Facade module
// Re-exports from extracted modules + contains mesh-level chamfer/fillet operations.
//
// Chamfer and fillet operations now produce NURBS surface definitions alongside
// tessellated mesh data, enabling mathematically exact B-Rep representation.

// Re-exports for backward compatibility
export { computeFeatureEdges, makeEdgeKey, expandPathEdgeKeys } from './EdgeAnalysis.js';
export { applyBRepChamfer } from './BRepChamfer.js';
export { booleanOp } from './CSGLegacy.js';
export {
  countInvertedFaces,
  calculateMeshVolume,
  calculateBoundingBox,
  calculateSurfaceArea,
  detectDisconnectedBodies,
  calculateWallThickness,
} from './toolkit/MeshAnalysis.js';

// Internal imports from extracted modules (used by remaining code)
import { computeFeatureEdges, assignCoplanarFaceGroups } from './EdgeAnalysis.js';
import {
  _precomputeChamferEdge,
  _computeOffsetDirs,
  _extractFeatureFacesFromTopoBody,
  _buildExactEdgeAdjacencyLookupFromTopoBody,
  _buildExactChamferTopoBody,
  _sampleExactEdgePoints,
} from './BRepChamfer.js';
import {
  _precomputeFilletEdge,
  _buildExactFilletTopoBody,
  _mergeSharedVertexPositions,
  _applyTwoEdgeFilletSharedTrims,
  _buildExactCornerFaceDescs,
  _createExactCylinderPlaneTrimCurve,
  _samplePolyline,
} from './BRepFillet.js';
import { _fixTJunctions } from './CSGLegacy.js';

// Direct library imports
import { NurbsSurface } from './NurbsSurface.js';
import { BRep, BRepVertex, BRepEdge, BRepFace } from './BRep.js';
import { NurbsCurve } from './NurbsCurve.js';
import { SurfaceType } from './BRepTopology.js';
import { tessellateBody } from './Tessellation.js';
import { constrainedTriangulate } from './Tessellator2/CDT.js';

// Toolkit imports
import {
  vec3Sub as _vec3Sub,
  vec3Add as _vec3Add,
  vec3Scale as _vec3Scale,
  vec3Dot as _vec3Dot,
  vec3Cross as _vec3Cross,
  vec3Len as _vec3Len,
  vec3Normalize as _vec3Normalize,
  vec3Lerp as _vec3Lerp,
  circumsphereCenter as _circumsphereCenter,
  pointOnFacePlane as _pointOnFacePlane,
  canonicalPoint as _canonicalPoint,
  edgeVKey as _edgeVKey,
  edgeKeyFromVerts as _edgeKeyFromVerts,
  distancePointToLineSegment as _distancePointToLineSegment_toolkit,
} from './toolkit/Vec3Utils.js';

import {
  computePolygonNormal as _computePolygonNormal_toolkit,
  faceCentroid as _faceCentroid_toolkit,
  collectFaceEdgeKeys as _collectFaceEdgeKeys_toolkit,
  findEdgeNormals as _findEdgeNormals_toolkit,
  trimFaceEdge as _trimFaceEdge_toolkit,
  pointOnSegmentStrict as pointOnSegmentStrict_toolkit,
} from './toolkit/GeometryUtils.js';

import {
  weldVertices as _weldVertices_toolkit,
  removeDegenerateFaces as _removeDegenerateFaces_toolkit,
  recomputeFaceNormals as _recomputeFaceNormals_toolkit,
  fixWindingConsistency as _fixWindingConsistency_toolkit,
  cloneMeshFace as _cloneMeshFace_toolkit,
} from './toolkit/MeshRepair.js';

import {
  isConvexPlanarPolygon as _isConvexPlanarPolygon_toolkit,
  projectPolygon2D as _projectPolygon2D_toolkit,
  triangulatePlanarPolygon as _triangulatePlanarPolygon_toolkit,
} from './toolkit/PlanarMath.js';

import {
  chainEdgePaths as _chainEdgePaths_toolkit,
} from './toolkit/EdgePathUtils.js';

import {
  findAdjacentFaces as _findAdjacentFaces_toolkit,
  buildVertexEdgeMap as _buildVertexEdgeMap_toolkit,
} from './toolkit/TopologyUtils.js';

import {
  polygonArea as _polygonArea_toolkit,
  facesSharePlane as _facesSharePlane_toolkit,
  sameNormalPair as _sameNormalPair_toolkit,
  coplanarFaceClusterKey as _coplanarFaceClusterKey_toolkit,
  sharedMetadataSignature as _sharedMetadataSignature_toolkit,
} from './toolkit/CoplanarUtils.js';

// Aliases for toolkit functions used in removed sections but needed by remaining code
const _chainEdgePaths = _chainEdgePaths_toolkit;
const pointOnSegmentStrict = pointOnSegmentStrict_toolkit;

// _computePolygonNormal now delegates to toolkit/GeometryUtils.js
const _computePolygonNormal = _computePolygonNormal_toolkit;

// -----------------------------------------------------------------------
// Mesh analysis functions — re-exported from toolkit/MeshAnalysis.js
// (countInvertedFaces, calculateMeshVolume, calculateBoundingBox,
//  calculateSurfaceArea, detectDisconnectedBodies, calculateWallThickness)
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// Edge key & vec3 helpers — imported from toolkit/Vec3Utils.js
// -----------------------------------------------------------------------

// vec3 helpers imported from toolkit/Vec3Utils.js (aliased as _vec3* for compatibility)

// circumsphereCenter imported from toolkit/Vec3Utils.js

// pointOnFacePlane imported from toolkit/Vec3Utils.js

// _findEdgeNormals now delegates to toolkit/GeometryUtils.js
const _findEdgeNormals = _findEdgeNormals_toolkit;

// -----------------------------------------------------------------------
// Chamfer / Fillet shared helpers
// -----------------------------------------------------------------------

// _faceCentroid now delegates to toolkit/GeometryUtils.js
const _faceCentroid = _faceCentroid_toolkit;

// _trimFaceEdge now delegates to toolkit/GeometryUtils.js
const _trimFaceEdge = _trimFaceEdge_toolkit;

// _collectFaceEdgeKeys now delegates to toolkit/GeometryUtils.js
const _collectFaceEdgeKeys = _collectFaceEdgeKeys_toolkit;

/**
 * At an edge endpoint, split the vertex in every face OTHER THAN face0/face1.
 *
 * Bridge faces (connecting face0-side to face1-side around the vertex ring) get
 * TWO replacement vertices so they span the bevel/arc gap.  Faces that live
 * entirely on one side get a SINGLE replacement vertex (p0 or p1) so the
 * fan topology stays intact.
 */
function _splitVertexAtEndpoint(faces, fi0, fi1, oldVertex, p0, p1, face0Keys, face1Keys) {
  const vk = _edgeVKey(oldVertex);

  for (let fi = 0; fi < faces.length; fi++) {
    if (fi === fi0 || fi === fi1) continue;
    const face = faces[fi];
    const verts = face.vertices;

    let vidx = -1;
    for (let i = 0; i < verts.length; i++) {
      if (_edgeVKey(verts[i]) === vk) { vidx = i; break; }
    }
    if (vidx < 0) continue;

    const prevIdx = (vidx - 1 + verts.length) % verts.length;
    const nextIdx = (vidx + 1) % verts.length;
    const prevEdge = _edgeKeyFromVerts(verts[prevIdx], verts[vidx]);
    const nextEdge = _edgeKeyFromVerts(verts[vidx], verts[nextIdx]);

    const prevInF0 = face0Keys.has(prevEdge);
    const prevInF1 = face1Keys.has(prevEdge);
    const nextInF0 = face0Keys.has(nextEdge);
    const nextInF1 = face1Keys.has(nextEdge);

    const touchesF0 = prevInF0 || nextInF0;
    const touchesF1 = prevInF1 || nextInF1;

    let newPts;
    if (touchesF0 && touchesF1) {
      // Bridge / cap face — shares edges with both sides → two vertices
      newPts = prevInF0 ? [{ ...p0 }, { ...p1 }] : [{ ...p1 }, { ...p0 }];
    } else if (touchesF0) {
      // Adjacent to face0 but not face1 — bridge into the chain → two vertices
      newPts = nextInF0 ? [{ ...p1 }, { ...p0 }] : [{ ...p0 }, { ...p1 }];
    } else if (touchesF1) {
      // Adjacent to face1 only — entirely on face1 side → single vertex
      newPts = [{ ...p1 }];
    } else {
      // No direct edge connection to either face — pick side by normal alignment
      const fn = _vec3Normalize(face.normal);
      const n0 = _vec3Normalize(faces[fi0].normal);
      const n1 = _vec3Normalize(faces[fi1].normal);
      const dot0 = Math.abs(_vec3Dot(fn, n0));
      const dot1 = Math.abs(_vec3Dot(fn, n1));
      newPts = [dot0 > dot1 ? { ...p0 } : { ...p1 }];
    }

    const newVerts = [];
    for (let i = 0; i < verts.length; i++) {
      if (i === vidx) {
        newVerts.push(...newPts);
      } else {
        newVerts.push(verts[i]);
      }
    }
    face.vertices = newVerts;
  }
}

/**
 * Extend edge keys through existing fillet boundaries.
 * When an edge endpoint sits on a fillet face boundary (not at a sharp corner),
 * extend the edge along its direction to pass through the fillet surface.
 * This enables sequential fillets to cut through existing fillet surfaces.
 */
function _extendEdgesThroughFilletBoundaries(faces, edgeKeys) {
  const result = [];
  
  // Build a lookup of which vertices belong to fillet faces
  const filletBoundaryVertices = new Map(); // vertex key → { filletFaceIndices, originalVertex }
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (!face.isFillet) continue;
    for (const v of face.vertices) {
      const vk = _edgeVKey(v);
      if (!filletBoundaryVertices.has(vk)) {
        filletBoundaryVertices.set(vk, { filletFaceIndices: [], pos: { ...v } });
      }
      filletBoundaryVertices.get(vk).filletFaceIndices.push(fi);
    }
  }

  // Build lookup of sharp edges (from non-fillet faces) that could be the
  // "original" edge before filleting
  const sharpEdgeLines = []; // Array of {start, end, dir}
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (face.isFillet || face.isCorner) continue;
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const delta = _vec3Sub(b, a);
      const len = _vec3Len(delta);
      if (len < 1e-10) continue;
      sharpEdgeLines.push({
        start: { ...a },
        end: { ...b },
        dir: _vec3Normalize(delta),
        len,
      });
    }
  }

  for (const ek of edgeKeys) {
    const sep = ek.indexOf('|');
    if (sep < 0) {
      result.push(ek);
      continue;
    }
    
    const parseV = (s) => {
      const c = s.split(',').map(Number);
      return { x: c[0], y: c[1], z: c[2] };
    };
    
    let ptA = parseV(ek.slice(0, sep));
    let ptB = parseV(ek.slice(sep + 1));
    const edgeDir = _vec3Normalize(_vec3Sub(ptB, ptA));
    const edgeLen = _vec3Len(_vec3Sub(ptB, ptA));
    
    // Check if endpoint A is on a fillet boundary
    const vkA = _edgeVKey(ptA);
    const filletInfoA = filletBoundaryVertices.get(vkA);
    if (filletInfoA) {
      // Endpoint A is on a fillet boundary - extend backward along edge direction
      // Look for sharp edges that are collinear and could be the original untrimmed edge
      for (const line of sharpEdgeLines) {
        // Check if this edge line is collinear with our edge direction
        const dotDir = Math.abs(_vec3Dot(line.dir, edgeDir));
        if (dotDir < 0.99) continue;
        
        // Check if extending our edge backward would reach this line
        // Project ptA onto the line
        const toLineStart = _vec3Sub(ptA, line.start);
        const projOnLine = _vec3Dot(toLineStart, line.dir);
        const closestOnLine = _vec3Add(line.start, _vec3Scale(line.dir, projOnLine));
        const lateralDist = _vec3Len(_vec3Sub(ptA, closestOnLine));
        
        // If ptA is close to this line, find the extension point
        if (lateralDist < edgeLen * 0.15 + 0.1) {
          // Compute intersection of our edge ray with the line's plane perpendicular to edge direction
          // The extension point is where backtracking along edgeDir reaches the line's endpoint
          const toStart = _vec3Sub(line.start, ptA);
          const toEnd = _vec3Sub(line.end, ptA);
          const projStart = _vec3Dot(toStart, edgeDir);
          const projEnd = _vec3Dot(toEnd, edgeDir);
          
          // Find the point that's in the backward direction
          if (projStart < -1e-6 && projStart < projEnd) {
            ptA = { ...line.start };
            break;
          } else if (projEnd < -1e-6) {
            ptA = { ...line.end };
            break;
          }
        }
      }
    }
    
    // Check if endpoint B is on a fillet boundary  
    const vkB = _edgeVKey(ptB);
    const filletInfoB = filletBoundaryVertices.get(vkB);
    if (filletInfoB) {
      // Endpoint B is on a fillet boundary - extend forward along edge direction
      for (const line of sharpEdgeLines) {
        const dotDir = Math.abs(_vec3Dot(line.dir, edgeDir));
        if (dotDir < 0.99) continue;
        
        const toLineStart = _vec3Sub(ptB, line.start);
        const projOnLine = _vec3Dot(toLineStart, line.dir);
        const closestOnLine = _vec3Add(line.start, _vec3Scale(line.dir, projOnLine));
        const lateralDist = _vec3Len(_vec3Sub(ptB, closestOnLine));
        
        if (lateralDist < edgeLen * 0.15 + 0.1) {
          const toStart = _vec3Sub(line.start, ptB);
          const toEnd = _vec3Sub(line.end, ptB);
          const projStart = _vec3Dot(toStart, edgeDir);
          const projEnd = _vec3Dot(toEnd, edgeDir);
          
          if (projStart > 1e-6 && projStart > projEnd) {
            ptB = { ...line.start };
            break;
          } else if (projEnd > 1e-6) {
            ptB = { ...line.end };
            break;
          }
        }
      }
    }
    
    // Rebuild the edge key with potentially extended endpoints
    const fmt = (n) => n.toFixed(5);
    const newKey = `${fmt(ptA.x)},${fmt(ptA.y)},${fmt(ptA.z)}|${fmt(ptB.x)},${fmt(ptB.y)},${fmt(ptB.z)}`;
    result.push(newKey);
  }
  
  return result;
}

/**
 * Compute intersection trim curves between new fillet cylinders and existing fillet cylinders.
 * When a new fillet edge passes through an existing fillet surface, compute the intersection
 * curve between the two rolling-ball cylinders. This curve becomes the shared trim boundary.
 */
function _computeFilletFilletIntersections(faces, edgeDataList, radius, segments) {
  // Find existing fillet faces with their cylinder geometry
  const existingFilletCylinders = [];
  let filletFaceCount = 0;
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (!face.isFillet) continue;
    filletFaceCount++;
    // Extract cylinder axis and radius from fillet face metadata if available
    if (face._exactAxisStart && face._exactAxisEnd && face._exactRadius) {
      existingFilletCylinders.push({
        fi,
        axisStart: face._exactAxisStart,
        axisEnd: face._exactAxisEnd,
        radius: face._exactRadius,
      });
    }
  }
  
  if (existingFilletCylinders.length === 0) return;
  
  // For each new fillet edge, check if it intersects any existing fillet cylinder
  for (const data of edgeDataList) {
    if (!data) continue;
    
    // The new fillet cylinder axis needs to be computed from the edge and adjacent face normals
    // First, get the adjacent faces to compute the bisector direction
    const face0 = faces[data.fi0];
    const face1 = faces[data.fi1];
    
    // Compute offset directions from edge toward each adjacent face's interior
    const { offsDir0, offsDir1 } = _computeOffsetDirs(face0, face1, data.edgeA, data.edgeB);
    
    // Bisector and centerDist computation
    const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));
    const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
    const centerDist = alpha > 1e-6 ? radius / Math.sin(alpha / 2) : radius;
    
    // The new fillet cylinder axis runs parallel to the edge, offset by centerDist along bisector
    const newAxisStart = _vec3Add(data.edgeA, _vec3Scale(bisector, centerDist));
    const newAxisEnd = _vec3Add(data.edgeB, _vec3Scale(bisector, centerDist));
    const newAxisDir = _vec3Normalize(_vec3Sub(newAxisEnd, newAxisStart));
    

    
    for (const oldCyl of existingFilletCylinders) {
      // Check if the new fillet edge passes near the old cylinder
      const oldAxisDir = _vec3Normalize(_vec3Sub(oldCyl.axisEnd, oldCyl.axisStart));
      
      // Skip if axes are nearly parallel (no intersection)
      const axisDot = Math.abs(_vec3Dot(newAxisDir, oldAxisDir));

      if (axisDot > 0.99) continue;
      
      // Compute closest approach between the two axis lines
      const d = _vec3Sub(data.edgeA, oldCyl.axisStart);
      const n = _vec3Cross(newAxisDir, oldAxisDir);
      const nLen = _vec3Len(n);
      if (nLen < 1e-10) continue;
      
      const dist = Math.abs(_vec3Dot(d, n)) / nLen;
      const sumRadii = radius + oldCyl.radius;
      

      
      // If axes are close enough, the cylinders might intersect
      if (dist < sumRadii * 1.5) {

        // Mark this edge data as having a fillet-fillet intersection
        data._intersectsOldFillet = true;
        data._oldFilletCylinder = oldCyl;
        
        // Check which edge endpoint (A or B) is near the old fillet cylinder axis
        // by testing distance from the edge endpoint to the old cylinder's axis line
        const distEdgeAToOldAxis = _distancePointToLineSegment(data.edgeA, oldCyl.axisStart, oldCyl.axisEnd);
        const distEdgeBToOldAxis = _distancePointToLineSegment(data.edgeB, oldCyl.axisStart, oldCyl.axisEnd);
        

        
        // If an edge endpoint is within the interaction zone of the old fillet, compute the trim curve
        // The trim curve is the 3D cylinder-cylinder intersection: each arc point is translated
        // along the edge direction until it lies on the old cylinder surface.
        const edgeDir = _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA));
        if (distEdgeAToOldAxis < sumRadii && distEdgeAToOldAxis < distEdgeBToOldAxis) {
          // Compute intersection of arcA with old cylinder
          const intersectionCurve = _computeArcCylinderIntersection(
            data.arcA, edgeDir, oldCyl.axisStart, oldCyl.axisEnd, oldCyl.radius
          );
          if (intersectionCurve && intersectionCurve.length > 0) {
            data.sharedTrimA = intersectionCurve;
            // Don't set plane origin/normal — the intersection is a 3D space curve, not planar
            data._sharedTrimPlaneAOrigin = null;
            data._sharedTrimPlaneANormal = null;
            data._filletJunctionSideA = true;
          }
        } else if (distEdgeBToOldAxis < sumRadii) {
          // Compute intersection of arcB with old cylinder
          const negEdgeDir = _vec3Scale(edgeDir, -1);
          const intersectionCurve = _computeArcCylinderIntersection(
            data.arcB, negEdgeDir, oldCyl.axisStart, oldCyl.axisEnd, oldCyl.radius
          );
          if (intersectionCurve && intersectionCurve.length > 0) {
            data.sharedTrimB = intersectionCurve;
            data._sharedTrimPlaneBOrigin = null;
            data._sharedTrimPlaneBNormal = null;
            data._filletJunctionSideB = true;
          }
        }
      }
    }
  }
}

// _distancePointToLineSegment → delegates to toolkit/Vec3Utils.js
const _distancePointToLineSegment = _distancePointToLineSegment_toolkit;

/**
 * Compute the 3D intersection curve between a new fillet arc and an old fillet cylinder.
 * For each arc point P, translates it along edgeDir by t so the point lies on the old
 * cylinder surface.  Solves:  |P + t·edgeDir − oldAxis|_perp = oldRadius  (quadratic in t).
 * Returns the intersection curve as an array of 3D points, or null.
 */
function _computeArcCylinderIntersection(arc, edgeDir, oldCylAxisStart, oldCylAxisEnd, oldCylRadius) {
  if (!arc || arc.length < 2) return null;

  const D_old = _vec3Normalize(_vec3Sub(oldCylAxisEnd, oldCylAxisStart));
  // B = edgeDir × D_old  (shared across all points)
  const B = _vec3Cross(edgeDir, D_old);
  const a_coeff = _vec3Dot(B, B);          // |edgeDir × D_old|²
  if (a_coeff < 1e-12) return null;        // edge ∥ old axis → no intersection

  const result = [];
  for (const p of arc) {
    const Q0 = _vec3Sub(p, oldCylAxisStart);
    const A  = _vec3Cross(Q0, D_old);       // Q0 × D_old

    const b_half = _vec3Dot(A, B);          // (Q0×D_old)·(edgeDir×D_old)
    const c_coeff = _vec3Dot(A, A) - oldCylRadius * oldCylRadius;

    const disc = b_half * b_half - a_coeff * c_coeff;
    if (disc < 0) {
      // Arc point can't reach old cylinder – keep original position
      result.push({ ...p });
      continue;
    }

    const sqrtDisc = Math.sqrt(disc);
    const t1 = (-b_half - sqrtDisc) / a_coeff;   // more-negative root
    const t2 = (-b_half + sqrtDisc) / a_coeff;

    // We want the root that moves the point toward the old fillet surface
    // (typically backward from edgeA, i.e. t ≤ 0).  Among the two roots pick
    // the one with t ≤ 0 that is closest to 0; fall back to smaller |t|.
    let t;
    if (Math.abs(c_coeff) < 1e-8) {
      // Already on the cylinder surface
      t = 0;
    } else if (t1 <= 0 && t2 <= 0) {
      t = t2;                               // less negative (closer to 0)
    } else if (t1 <= 0) {
      t = t1;                               // only negative root
    } else if (t2 <= 0) {
      t = t2;                               // only negative root
    } else {
      t = Math.abs(t1) < Math.abs(t2) ? t1 : t2;  // both positive – pick smaller
    }

    result.push(_vec3Add(p, _vec3Scale(edgeDir, t)));
  }

  return result.length > 0 ? result : null;
}

/**
 * Compute the intersection curve between two cylinders.
 * Returns an array of points approximating the intersection curve.
 */
function _computeCylinderCylinderIntersection(
  axis1Start, axis1End, radius1,
  axis2Start, axis2End, radius2,
  segments
) {
  const axis1Dir = _vec3Normalize(_vec3Sub(axis1End, axis1Start));
  const axis2Dir = _vec3Normalize(_vec3Sub(axis2End, axis2Start));
  
  // Find the intersection plane (perpendicular to the line joining closest points)
  const cross = _vec3Cross(axis1Dir, axis2Dir);
  const crossLen = _vec3Len(cross);
  if (crossLen < 1e-10) return null; // Parallel axes
  
  const planeNormal = _vec3Normalize(cross);
  
  // Find closest points on the two axis lines
  const d = _vec3Sub(axis2Start, axis1Start);
  const a = _vec3Dot(axis1Dir, axis1Dir);
  const b = _vec3Dot(axis1Dir, axis2Dir);
  const c = _vec3Dot(axis2Dir, axis2Dir);
  const e = _vec3Dot(axis1Dir, d);
  const f = _vec3Dot(axis2Dir, d);
  
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-10) return null;
  
  const t1 = (b * f - c * e) / denom;
  const t2 = (a * f - b * e) / denom;
  
  const closest1 = _vec3Add(axis1Start, _vec3Scale(axis1Dir, t1));
  const closest2 = _vec3Add(axis2Start, _vec3Scale(axis2Dir, t2));
  
  // The intersection curve lies on a plane through the midpoint
  const midpoint = _vec3Lerp(closest1, closest2, 0.5);
  
  // Create a local coordinate system on the intersection plane
  const localX = _vec3Normalize(_vec3Sub(closest1, midpoint));
  const localY = _vec3Normalize(_vec3Cross(planeNormal, localX));
  
  // Sample points on both cylinder surfaces in this plane
  const points = [];
  const sumRadii = radius1 + radius2;
  const arcRadius = Math.min(radius1, radius2);
  
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI;
    const x = arcRadius * Math.cos(theta);
    const y = arcRadius * Math.sin(theta);
    const pt = _vec3Add(midpoint, _vec3Add(
      _vec3Scale(localX, x),
      _vec3Scale(localY, y)
    ));
    points.push(pt);
  }
  
  return points;
}

/**
 * Clip old fillet faces that overlap with new fillet regions.
 * When a new fillet passes through an existing fillet surface, the old fillet
 * strip quads in the overlap zone need to be removed or trimmed to avoid
 * creating non-manifold geometry.
 */
function _clipOldFilletFacesInOverlapZone(faces, edgeDataList, radius) {
  if (edgeDataList.length === 0) return;
  
  // Collect new fillet endpoints with tolerance-based proximity checking
  const newFilletEndpoints = [];
  const newFilletEdgeRays = [];
  
  for (const data of edgeDataList) {
    if (!data) continue;
    newFilletEndpoints.push({ ...data.edgeA });
    newFilletEndpoints.push({ ...data.edgeB });
    
    // Store the edge ray for proximity testing
    const dir = _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA));
    const len = _vec3Len(_vec3Sub(data.edgeB, data.edgeA));
    newFilletEdgeRays.push({
      start: data.edgeA,
      end: data.edgeB,
      dir,
      len,
      radius,
    });
  }
  
  const proximityTol = radius * 1.5; // Tolerance for vertex proximity
  
  // Helper to check if a point is near any new fillet endpoint
  const isNearNewFilletEndpoint = (pt) => {
    for (const ep of newFilletEndpoints) {
      if (_vec3Len(_vec3Sub(pt, ep)) < proximityTol) return true;
    }
    return false;
  };
  
  // For each existing fillet face, check if it overlaps with any new fillet edge's
  // cylindrical extent. If so, mark for removal.
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (!face || !face.isFillet) continue;
    
    // Check if any vertex of this face is near a new fillet endpoint
    let hasVertexNearEndpoint = false;
    for (const v of face.vertices) {
      if (isNearNewFilletEndpoint(v)) {
        hasVertexNearEndpoint = true;
        break;
      }
    }
    
    if (!hasVertexNearEndpoint) continue;
    
    // This face has a vertex near a new fillet endpoint
    // Check if the face's centroid is within the new fillet's cylindrical extent
    const centroid = _faceCentroid(face);
    
    for (const ray of newFilletEdgeRays) {
      // Project centroid onto the new fillet edge line
      const toCenter = _vec3Sub(centroid, ray.start);
      const projDist = _vec3Dot(toCenter, ray.dir);
      
      // Clamp to edge bounds
      const clampedProj = Math.max(0, Math.min(ray.len, projDist));
      
      // Compute lateral distance from the edge line
      const projPoint = _vec3Add(ray.start, _vec3Scale(ray.dir, clampedProj));
      const lateral = _vec3Len(_vec3Sub(centroid, projPoint));
      
      // If within the new fillet's cylindrical extent, mark for removal
      if (lateral < ray.radius * 3) {
        face._markedForRemoval = true;
        break;
      }
    }
  }
  
  // Remove marked faces
  for (let fi = faces.length - 1; fi >= 0; fi--) {
    if (faces[fi] && faces[fi]._markedForRemoval) {
      faces.splice(fi, 1);
    }
  }
}

/**
 * Compute offset directions perpendicular to edge, lying on each face plane,
 * pointing into the face interior.
 */

// _findAdjacentFaces → delegates to toolkit/TopologyUtils.js
const _findAdjacentFaces = _findAdjacentFaces_toolkit;

// -----------------------------------------------------------------------
// Chamfer geometry operation
// -----------------------------------------------------------------------

/**
 * Close small boundary-edge loops left by sequential fillet interactions.
 * Detects edges shared by only one face, traces them into closed loops,
 * and triangulates each loop to heal the hole.
 */
function _healBoundaryLoops(faces) {
  // Step 1: Collect all boundary edges with the face that owns them.
  const edgeCounts = new Map(); // edgeKey → count
  const edgeInfo = new Map();   // edgeKey → {fi, a, b}
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const ek = _edgeKeyFromVerts(a, b);
      edgeCounts.set(ek, (edgeCounts.get(ek) || 0) + 1);
      edgeInfo.set(ek + ':' + fi, { fi, a: { ...a }, b: { ...b } });
    }
  }

  const boundaryEdges = [];
  for (const [ek, count] of edgeCounts) {
    if (count !== 1) continue;
    let info = null;
    for (const [key, val] of edgeInfo) {
      if (key.startsWith(ek + ':')) {
        const testEk = _edgeKeyFromVerts(val.a, val.b);
        if (testEk === ek) { info = val; break; }
      }
    }
    if (!info) continue;
    boundaryEdges.push({
      fi: info.fi,
      a: { ...info.a },
      b: { ...info.b },
      vkA: _edgeVKey(info.a),
      vkB: _edgeVKey(info.b),
    });
  }

  if (boundaryEdges.length === 0) return;

  // Step 2: Build an undirected boundary graph so loops still trace when
  // multiple boundary edges leave the same vertex after local rewinding.
  const vertexEdges = new Map();
  for (let ei = 0; ei < boundaryEdges.length; ei++) {
    const edge = boundaryEdges[ei];
    if (!vertexEdges.has(edge.vkA)) vertexEdges.set(edge.vkA, []);
    if (!vertexEdges.has(edge.vkB)) vertexEdges.set(edge.vkB, []);
    vertexEdges.get(edge.vkA).push(ei);
    vertexEdges.get(edge.vkB).push(ei);
  }

  const usedEdges = new Uint8Array(boundaryEdges.length);

  function faceArea(face) {
    const verts = face.vertices || [];
    let area = 0;
    for (let i = 1; i < verts.length - 1; i++) {
      const ab = _vec3Sub(verts[i], verts[0]);
      const ac = _vec3Sub(verts[i + 1], verts[0]);
      area += 0.5 * _vec3Len(_vec3Cross(ab, ac));
    }
    return area;
  }

  function chooseNextEdge(currentVk, previousVk, candidateIndices, localUsed, startVk) {
    let best = -1;
    for (const ei of candidateIndices) {
      if (localUsed.has(ei)) continue;
      const edge = boundaryEdges[ei];
      const otherVk = edge.vkA === currentVk ? edge.vkB : edge.vkA;
      if (otherVk === previousVk && candidateIndices.length > 1) continue;
      if (otherVk === startVk) return ei;
      if (best < 0) best = ei;
    }
    return best;
  }

  // Step 3: Trace closed loops
  for (let startEi = 0; startEi < boundaryEdges.length; startEi++) {
    if (usedEdges[startEi]) continue;

    const startEdge = boundaryEdges[startEi];
    const startVk = startEdge.vkA;
    const loopVerts = [{ ...startEdge.a }];
    const loopEdgeIndices = [startEi];
    const localUsed = new Set([startEi]);
    let previousVk = startEdge.vkA;
    let currentVk = startEdge.vkB;
    let currentPos = { ...startEdge.b };
    let closed = false;

    while (true) {
      loopVerts.push({ ...currentPos });
      if (currentVk === startVk) {
        closed = true;
        break;
      }

      const candidates = vertexEdges.get(currentVk) || [];
      const nextEi = chooseNextEdge(currentVk, previousVk, candidates, localUsed, startVk);
      if (nextEi < 0) break;
      localUsed.add(nextEi);
      loopEdgeIndices.push(nextEi);
      const nextEdge = boundaryEdges[nextEi];
      const nextVk = nextEdge.vkA === currentVk ? nextEdge.vkB : nextEdge.vkA;
      const nextPos = nextEdge.vkA === currentVk ? nextEdge.b : nextEdge.a;
      previousVk = currentVk;
      currentVk = nextVk;
      currentPos = { ...nextPos };
    }

    if (!closed || loopVerts.length < 4) continue;

    loopVerts.pop(); // duplicated start vertex
    for (const ei of loopEdgeIndices) usedEdges[ei] = 1;

    let sameDirCount = 0;
    for (let i = 0; i < loopVerts.length; i++) {
      const edge = boundaryEdges[loopEdgeIndices[i]];
      const fromVk = _edgeVKey(loopVerts[i]);
      const toVk = _edgeVKey(loopVerts[(i + 1) % loopVerts.length]);
      if (edge.vkA === fromVk && edge.vkB === toVk) sameDirCount++;
    }

    let loopNormal = _computePolygonNormal(loopVerts);
    if (!loopNormal) continue;

    // The healing face must run each shared boundary edge in the opposite
    // direction from the existing face that owns it.
    if (sameDirCount > loopVerts.length / 2) {
      loopVerts.reverse();
      loopNormal = _computePolygonNormal(loopVerts);
      if (!loopNormal) continue;
    }

    // Fallback: if the loop walk was ambiguous, align with the dominant
    // coplanar neighboring faces.
    if (sameDirCount * 2 === loopVerts.length) {
      let avgNormal = { x: 0, y: 0, z: 0 };
      for (const ei of loopEdgeIndices) {
        const face = faces[boundaryEdges[ei].fi];
        if (!face || !face.normal) continue;
        const fn = _vec3Normalize(face.normal);
        if (Math.abs(_vec3Dot(fn, loopNormal)) < 0.5) continue;
        const weight = Math.max(1e-6, faceArea(face));
        avgNormal.x += fn.x * weight;
        avgNormal.y += fn.y * weight;
        avgNormal.z += fn.z * weight;
      }
      if (_vec3Len(avgNormal) > 1e-10 && _vec3Dot(loopNormal, avgNormal) < 0) {
        loopVerts.reverse();
        loopNormal = _computePolygonNormal(loopVerts);
        if (!loopNormal) continue;
      }
    }

    // Step 4: Triangulate the loop as a fan from vertex 0
    for (let i = 1; i < loopVerts.length - 1; i++) {
      const triVerts = [{ ...loopVerts[0] }, { ...loopVerts[i] }, { ...loopVerts[i + 1] }];
      const triNormal = _computePolygonNormal(triVerts);
      if (triNormal) {
        faces.push({
          vertices: triVerts,
          normal: triNormal,
          shared: null,
        });
      }
    }
  }
}

// _polygonArea → delegates to toolkit/CoplanarUtils.js
const _polygonArea = _polygonArea_toolkit;

// _coplanarFaceClusterKey → delegates to toolkit/CoplanarUtils.js
const _coplanarFaceClusterKey = _coplanarFaceClusterKey_toolkit;

function _fixOpposedCoplanarFacesInGroups(faces) {
  if (!Array.isArray(faces) || faces.length === 0) return;

  const clusters = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const key = _coplanarFaceClusterKey(faces[fi], fi);
    if (!key) continue;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(fi);
  }

  for (const faceIndices of clusters.values()) {
    if (faceIndices.length < 2) continue;

    let referenceFace = null;
    let referenceArea = -Infinity;
    for (const fi of faceIndices) {
      const area = _polygonArea(faces[fi]);
      if (area > referenceArea) {
        referenceArea = area;
        referenceFace = faces[fi];
      }
    }
    if (!referenceFace || !referenceFace.normal) continue;

    const referenceNormal = _vec3Normalize(referenceFace.normal);
    if (_vec3Len(referenceNormal) < 1e-10) continue;

    for (const fi of faceIndices) {
      const face = faces[fi];
      if (!face || !face.normal) continue;
      if (_vec3Dot(referenceNormal, face.normal) >= 0) continue;
      face.vertices.reverse();
      face.normal = {
        x: -face.normal.x,
        y: -face.normal.y,
        z: -face.normal.z,
      };
    }
  }
}

// _isConvexPlanarPolygon now delegates to toolkit/PlanarMath.js
const _isConvexPlanarPolygon = _isConvexPlanarPolygon_toolkit;

// _projectPolygon2D now delegates to toolkit/PlanarMath.js
const _projectPolygon2D = _projectPolygon2D_toolkit;

// _triangulatePlanarPolygon now delegates to toolkit/PlanarMath.js
const _triangulatePlanarPolygon = _triangulatePlanarPolygon_toolkit;

function _mergeMixedSharedPlanarComponents(faces, includeUniformShared = false) {
  const quantize = (value, digits = 5) => {
    const clamped = Math.abs(value) < 1e-10 ? 0 : value;
    const text = clamped.toFixed(digits);
    return text === '-0.00000' ? '0.00000' : text;
  };

  function planeKey(face) {
    const n = _vec3Normalize(face.normal || { x: 0, y: 0, z: 0 });
    if (_vec3Len(n) < 1e-10 || !face.vertices || face.vertices.length < 3) return null;
    let sign = 1;
    if (Math.abs(n.z) > Math.abs(n.x) && Math.abs(n.z) > Math.abs(n.y)) {
      sign = n.z < 0 ? -1 : 1;
    } else if (Math.abs(n.y) > Math.abs(n.x)) {
      sign = n.y < 0 ? -1 : 1;
    } else {
      sign = n.x < 0 ? -1 : 1;
    }
    const d = _vec3Dot(face.vertices[0], n) * sign;
    return `${quantize(n.x * sign)},${quantize(n.y * sign)},${quantize(n.z * sign)}|${quantize(d)}`;
  }

  const buckets = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (!face || !face.vertices || face.vertices.length < 3) continue;
    if (face.isFillet || face.isCorner) continue;
    const key = planeKey(face);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(fi);
  }

  const replacements = [];
  const removeIndices = new Set();

  for (const indices of buckets.values()) {
    if (indices.length < 2) continue;

    const edgeToFaces = new Map();
    for (const fi of indices) {
      const verts = faces[fi].vertices;
      for (let i = 0; i < verts.length; i++) {
        const ek = _edgeKeyFromVerts(verts[i], verts[(i + 1) % verts.length]);
        if (!edgeToFaces.has(ek)) edgeToFaces.set(ek, []);
        edgeToFaces.get(ek).push(fi);
      }
    }

    const adjacency = new Map();
    for (const fi of indices) adjacency.set(fi, new Set());
    for (const fis of edgeToFaces.values()) {
      if (fis.length < 2) continue;
      for (let i = 0; i < fis.length - 1; i++) {
        for (let j = i + 1; j < fis.length; j++) {
          adjacency.get(fis[i]).add(fis[j]);
          adjacency.get(fis[j]).add(fis[i]);
        }
      }
    }

    const seen = new Set();
    for (const startFi of indices) {
      if (seen.has(startFi)) continue;
      const stack = [startFi];
      const component = [];
      while (stack.length > 0) {
        const fi = stack.pop();
        if (seen.has(fi)) continue;
        seen.add(fi);
        component.push(fi);
        for (const other of adjacency.get(fi) || []) {
          if (!seen.has(other)) stack.push(other);
        }
      }

      if (component.length < 2) continue;

      const sharedValues = new Set(component.map((fi) => faces[fi].shared || null));
      const refFace = faces[component[0]];
      const refNormal = _vec3Normalize(refFace.normal || { x: 0, y: 0, z: 0 });
      const mixedNormals = component.some((fi) => {
        const fn = _vec3Normalize(faces[fi].normal || { x: 0, y: 0, z: 0 });
        return _vec3Len(fn) < 1e-10 || _vec3Dot(fn, refNormal) < 0.999;
      });
      if (!includeUniformShared && sharedValues.size < 2 && !mixedNormals) continue;

      const boundaryEdges = [];
      const componentSet = new Set(component);
      for (const fi of component) {
        const verts = faces[fi].vertices;
        for (let i = 0; i < verts.length; i++) {
          const a = verts[i];
          const b = verts[(i + 1) % verts.length];
          const ek = _edgeKeyFromVerts(a, b);
          const owners = edgeToFaces.get(ek) || [];
          const insideCount = owners.filter((owner) => componentSet.has(owner)).length;
          if (insideCount === 1) {
            boundaryEdges.push({
              fi,
              a: { ...a },
              b: { ...b },
              startKey: _edgeVKey(a),
              endKey: _edgeVKey(b),
            });
          }
        }
      }

      if (boundaryEdges.length < 3) continue;

      const outgoing = new Map();
      const incoming = new Map();
      for (const edge of boundaryEdges) {
        if (outgoing.has(edge.startKey) || incoming.has(edge.endKey)) {
          outgoing.set('__invalid__', true);
          break;
        }
        outgoing.set(edge.startKey, edge);
        incoming.set(edge.endKey, edge);
      }
      if (outgoing.has('__invalid__')) continue;

      let startEdge = boundaryEdges[0];
      for (const edge of boundaryEdges) {
        if (!incoming.has(edge.startKey)) {
          startEdge = edge;
          break;
        }
      }

      const loop = [{ ...startEdge.a }];
      const used = new Set();
      let current = startEdge;
      while (current && !used.has(current.startKey + '|' + current.endKey)) {
        used.add(current.startKey + '|' + current.endKey);
        loop.push({ ...current.b });
        const next = outgoing.get(current.endKey);
        current = next;
        if (current && current.startKey === startEdge.startKey) break;
      }

      if (_edgeVKey(loop[0]) !== _edgeVKey(loop[loop.length - 1])) continue;
      loop.pop();
      if (used.size !== boundaryEdges.length) continue;

      const mergedVerts = _deduplicatePolygon(loop);
      if (mergedVerts.length < 3) continue;

      let mergedNormal = _computePolygonNormal(mergedVerts);
      if (!mergedNormal) continue;
      const template = [...component]
        .map((fi) => faces[fi])
        .sort((a, b) => _polygonArea(b) - _polygonArea(a))[0];
      if (!mixedNormals && _vec3Dot(mergedNormal, refNormal) < 0) {
        mergedVerts.reverse();
        mergedNormal = _computePolygonNormal(mergedVerts);
        if (!mergedNormal) continue;
      }
      if (!_isConvexPlanarPolygon(mergedVerts, mergedNormal)) continue;

      replacements.push({
        component,
        face: {
          ...template,
          vertices: mergedVerts.map((v) => ({ ...v })),
          normal: mergedNormal,
          shared: null,
        },
      });
      for (const fi of component) removeIndices.add(fi);
    }
  }

  if (replacements.length === 0) return;

  const kept = [];
  for (let fi = 0; fi < faces.length; fi++) {
    if (!removeIndices.has(fi)) kept.push(faces[fi]);
  }
  for (const replacement of replacements) kept.push(replacement.face);
  faces.length = 0;
  faces.push(...kept);
}

// _facesSharePlane → delegates to toolkit/CoplanarUtils.js
const _facesSharePlane = _facesSharePlane_toolkit;

function _traceMergedPairLoop(faceA, faceB) {
  const directedEdges = [];
  for (const face of [faceA, faceB]) {
    const verts = face.vertices || [];
    for (let i = 0; i < verts.length; i++) {
      directedEdges.push({
        a: { ...verts[i] },
        b: { ...verts[(i + 1) % verts.length] },
      });
    }
  }

  const counts = new Map();
  for (const edge of directedEdges) {
    const ek = _edgeKeyFromVerts(edge.a, edge.b);
    counts.set(ek, (counts.get(ek) || 0) + 1);
  }

  const boundary = directedEdges
    .filter((edge) => counts.get(_edgeKeyFromVerts(edge.a, edge.b)) === 1)
    .map((edge) => ({
      ...edge,
      startKey: _edgeVKey(edge.a),
      endKey: _edgeVKey(edge.b),
    }));

  if (boundary.length < 3) return null;

  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of boundary) {
    if (outgoing.has(edge.startKey) || incoming.has(edge.endKey)) return null;
    outgoing.set(edge.startKey, edge);
    incoming.set(edge.endKey, edge);
  }

  let start = boundary[0];
  for (const edge of boundary) {
    if (!incoming.has(edge.startKey)) {
      start = edge;
      break;
    }
  }

  const loop = [{ ...start.a }];
  const used = new Set();
  let current = start;
  while (current && !used.has(current.startKey + '|' + current.endKey)) {
    used.add(current.startKey + '|' + current.endKey);
    loop.push({ ...current.b });
    current = outgoing.get(current.endKey);
    if (current && current.startKey === start.startKey) break;
  }

  if (_edgeVKey(loop[0]) !== _edgeVKey(loop[loop.length - 1])) return null;
  loop.pop();
  if (used.size !== boundary.length) return null;

  return _deduplicatePolygon(loop);
}

function _mergeAdjacentCoplanarFacePairs(faces) {
  let changed = true;
  let iterations = 0;
  const maxIterations = Math.max(32, faces.length * 4);
  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;

    const edgeFaces = new Map();
    for (let fi = 0; fi < faces.length; fi++) {
      const face = faces[fi];
      if (!face || !face.vertices || face.vertices.length < 3) continue;
      if (face.isFillet || face.isCorner) continue;
      const verts = face.vertices;
      for (let i = 0; i < verts.length; i++) {
        const ek = _edgeKeyFromVerts(verts[i], verts[(i + 1) % verts.length]);
        if (!edgeFaces.has(ek)) edgeFaces.set(ek, []);
        edgeFaces.get(ek).push(fi);
      }
    }

    outer:
    for (const fis of edgeFaces.values()) {
      if (fis.length !== 2) continue;
      const [fi, fj] = fis;
      const faceA = faces[fi];
      const faceB = faces[fj];
      if (!faceA || !faceB) continue;
      if (!_facesSharePlane(faceA, faceB)) continue;

      const mergedVerts = _traceMergedPairLoop(faceA, faceB);
      if (!mergedVerts || mergedVerts.length < 3) continue;

      let mergedNormal = _computePolygonNormal(mergedVerts);
      if (!mergedNormal) continue;

      const na = _vec3Normalize(faceA.normal || { x: 0, y: 0, z: 0 });
      const nb = _vec3Normalize(faceB.normal || { x: 0, y: 0, z: 0 });
      const sameSense = _vec3Dot(na, nb) > 0.999;
      if (sameSense && _vec3Dot(mergedNormal, na) < 0) {
        mergedVerts.reverse();
        mergedNormal = _computePolygonNormal(mergedVerts);
        if (!mergedNormal) continue;
      }

      const template = _polygonArea(faceA) >= _polygonArea(faceB) ? faceA : faceB;
      const shared = faceA.shared === faceB.shared ? faceA.shared : null;
      let replacementFaces = null;
      if (_isConvexPlanarPolygon(mergedVerts, mergedNormal)) {
        replacementFaces = [{
          ...template,
          vertices: mergedVerts.map((v) => ({ ...v })),
          normal: mergedNormal,
          shared,
        }];
      } else {
        // Only resolve opposite-facing leftovers here. Re-triangulating
        // same-sense concave regions can cause the pass to merge/split forever.
        if (sameSense) continue;
        const tris = _triangulatePlanarPolygon(mergedVerts, mergedNormal);
        if (!tris || tris.length === 0) continue;
        replacementFaces = tris.map((tri) => ({
          ...template,
          vertices: tri,
          normal: mergedNormal,
          shared,
        }));
      }

      faces.splice(Math.max(fi, fj), 1);
      faces.splice(Math.min(fi, fj), 1);
      faces.push(...replacementFaces);
      changed = true;
      break outer;
    }
  }
}

function _collectFaceTopoFaceIds(face) {
  const ids = [];
  if (!face) return ids;
  if (face.topoFaceId !== undefined) ids.push(face.topoFaceId);
  if (Array.isArray(face.topoFaceIds)) {
    for (const topoFaceId of face.topoFaceIds) {
      if (topoFaceId !== undefined) ids.push(topoFaceId);
    }
  }
  return [...new Set(ids)];
}

function _buildRepFaceIndexByTopoFaceId(faces) {
  const repFaceIndexByTopoFaceId = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const topoFaceIds = _collectFaceTopoFaceIds(faces[fi]);
    for (const topoFaceId of topoFaceIds) {
      if (!repFaceIndexByTopoFaceId.has(topoFaceId)) {
        repFaceIndexByTopoFaceId.set(topoFaceId, fi);
      }
    }
  }
  return repFaceIndexByTopoFaceId;
}

function _tracePlanarFaceGroupLoop(faces, faceIndices) {
  const componentVertices = [];
  const seenVertices = new Set();
  for (const fi of faceIndices) {
    const face = faces[fi];
    const verts = face && Array.isArray(face.vertices) ? face.vertices : [];
    for (const vertex of verts) {
      const key = _edgeVKey(vertex);
      if (seenVertices.has(key)) continue;
      seenVertices.add(key);
      componentVertices.push({ ...vertex });
    }
  }

  const directedEdges = [];
  const edgeCounts = new Map();

  for (const fi of faceIndices) {
    const face = faces[fi];
    const verts = face && Array.isArray(face.vertices) ? face.vertices : [];
    if (verts.length < 3) continue;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const splitPoints = [{ ...a }, { ...b }];
      for (const vertex of componentVertices) {
        const key = _edgeVKey(vertex);
        if (key === _edgeVKey(a) || key === _edgeVKey(b)) continue;
        if (pointOnSegmentStrict(vertex, a, b)) splitPoints.push({ ...vertex });
      }

      const edgeDir = _vec3Sub(b, a);
      const edgeLenSq = _vec3Dot(edgeDir, edgeDir);
      if (edgeLenSq < 1e-12) continue;
      splitPoints.sort((p0, p1) => {
        const t0 = _vec3Dot(_vec3Sub(p0, a), edgeDir) / edgeLenSq;
        const t1 = _vec3Dot(_vec3Sub(p1, a), edgeDir) / edgeLenSq;
        return t0 - t1;
      });

      const uniquePoints = [];
      for (const point of splitPoints) {
        if (uniquePoints.length === 0 || _edgeVKey(uniquePoints[uniquePoints.length - 1]) !== _edgeVKey(point)) {
          uniquePoints.push(point);
        }
      }

      for (let pi = 1; pi < uniquePoints.length; pi++) {
        const start = uniquePoints[pi - 1];
        const end = uniquePoints[pi];
        if (_edgeVKey(start) === _edgeVKey(end)) continue;
        const key = _edgeKeyFromVerts(start, end);
        edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
        directedEdges.push({
          a: { ...start },
          b: { ...end },
          key,
          startKey: _edgeVKey(start),
          endKey: _edgeVKey(end),
        });
      }
    }
  }

  const boundaryEdges = directedEdges.filter((edge) => edgeCounts.get(edge.key) === 1);
  if (boundaryEdges.length < 3) return null;

  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of boundaryEdges) {
    if (outgoing.has(edge.startKey) || incoming.has(edge.endKey)) return null;
    outgoing.set(edge.startKey, edge);
    incoming.set(edge.endKey, edge);
  }

  let startEdge = boundaryEdges[0];
  for (const edge of boundaryEdges) {
    if (!incoming.has(edge.startKey)) {
      startEdge = edge;
      break;
    }
  }

  const loop = [{ ...startEdge.a }];
  const used = new Set();
  let current = startEdge;
  while (current && !used.has(`${current.startKey}|${current.endKey}`)) {
    used.add(`${current.startKey}|${current.endKey}`);
    loop.push({ ...current.b });
    current = outgoing.get(current.endKey);
    if (current && current.startKey === startEdge.startKey) break;
  }

  if (_edgeVKey(loop[0]) !== _edgeVKey(loop[loop.length - 1])) return null;
  loop.pop();
  if (used.size !== boundaryEdges.length) return null;

  const mergedVerts = _deduplicatePolygon(loop);
  return mergedVerts.length >= 3 ? mergedVerts : null;
}

function _mergeCoplanarNonManifoldComponents(faces) {
  if (!Array.isArray(faces) || faces.length === 0) return;

  assignCoplanarFaceGroups(faces);

  const edgeToFaces = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    const verts = face && Array.isArray(face.vertices) ? face.vertices : [];
    if (verts.length < 3) continue;
    for (let vi = 0; vi < verts.length; vi++) {
      const key = _edgeKeyFromVerts(verts[vi], verts[(vi + 1) % verts.length]);
      if (!edgeToFaces.has(key)) edgeToFaces.set(key, []);
      edgeToFaces.get(key).push(fi);
    }
  }

  const candidateGroups = new Map();
  for (const faceIndices of edgeToFaces.values()) {
    if (faceIndices.length <= 2) continue;
    for (const fi of faceIndices) {
      const face = faces[fi];
      if (!face || face.isFillet || face.isCorner) continue;
      if (face.surfaceType !== SurfaceType.PLANE) continue;
      const groupKey = face.faceGroup != null ? face.faceGroup : fi;
      if (!candidateGroups.has(groupKey)) candidateGroups.set(groupKey, new Set());
      candidateGroups.get(groupKey).add(fi);
    }
  }

  if (candidateGroups.size === 0) return;

  const removeIndices = new Set();
  const replacements = [];
  for (const groupFaceSet of candidateGroups.values()) {
    const faceIndices = [...groupFaceSet].sort((a, b) => a - b);
    if (faceIndices.length < 2) continue;

    const mergedVerts = _tracePlanarFaceGroupLoop(faces, faceIndices);
    if (!mergedVerts || mergedVerts.length < 3) continue;

    let mergedNormal = _computePolygonNormal(mergedVerts);
    if (!mergedNormal) continue;

    const componentFaces = faceIndices.map((fi) => faces[fi]).filter(Boolean);
    const template = [...componentFaces].sort((a, b) => _polygonArea(b) - _polygonArea(a))[0];
    if (!template) continue;

    const templateNormal = _vec3Normalize(template.normal || { x: 0, y: 0, z: 0 });
    if (_vec3Len(templateNormal) >= 1e-10 && _vec3Dot(mergedNormal, templateNormal) < 0) {
      mergedVerts.reverse();
      mergedNormal = _computePolygonNormal(mergedVerts);
      if (!mergedNormal) continue;
    }

    const topoFaceIds = [...new Set(faceIndices.flatMap((fi) => _collectFaceTopoFaceIds(faces[fi])))];
    const sharedSignatures = new Set(faceIndices.map((fi) => _sharedMetadataSignature(faces[fi].shared)));
    const buildReplacement = (vertices) => {
      const replacement = {
        ...template,
        vertices: vertices.map((vertex) => ({ ...vertex })),
        normal: mergedNormal,
        shared: sharedSignatures.size === 1 && template.shared ? { ...template.shared } : null,
        topoFaceId: topoFaceIds.length === 1 ? topoFaceIds[0] : undefined,
      };
      if (topoFaceIds.length > 1) replacement.topoFaceIds = topoFaceIds;
      else if (topoFaceIds.length === 1) replacement.topoFaceIds = [topoFaceIds[0]];
      return replacement;
    };

    const replacementFaces = _isConvexPlanarPolygon(mergedVerts, mergedNormal)
      ? [buildReplacement(mergedVerts)]
      : (_triangulatePlanarPolygon(mergedVerts, mergedNormal) || []).map((tri) => buildReplacement(tri));
    if (replacementFaces.length === 0) continue;

    for (const fi of faceIndices) removeIndices.add(fi);
    replacements.push(...replacementFaces);
  }

  if (replacements.length === 0) return;

  const keptFaces = [];
  for (let fi = 0; fi < faces.length; fi++) {
    if (!removeIndices.has(fi)) keptFaces.push(faces[fi]);
  }
  keptFaces.push(...replacements);
  faces.length = 0;
  faces.push(...keptFaces);
}

// _sharedMetadataSignature → delegates to toolkit/CoplanarUtils.js
const _sharedMetadataSignature = _sharedMetadataSignature_toolkit;

function _compactExactPlanarDisplayFaces(inputFaces) {
  if (!Array.isArray(inputFaces) || inputFaces.length < 2) {
    return Array.isArray(inputFaces) ? inputFaces : [];
  }

  const faces = inputFaces.map((face) => ({
    ...face,
    vertices: Array.isArray(face.vertices) ? face.vertices.map((vertex) => ({ ...vertex })) : [],
    normal: face.normal ? { ...face.normal } : face.normal,
    shared: face.shared ? { ...face.shared } : null,
    topoFaceIds: Array.isArray(face.topoFaceIds) ? [...face.topoFaceIds] : face.topoFaceIds,
    vertexNormals: Array.isArray(face.vertexNormals)
      ? face.vertexNormals.map((normal) => (normal ? { ...normal } : normal))
      : face.vertexNormals,
  }));

  _fixTJunctions(faces);
  _weldVertices(faces);
  _removeDegenerateFaces(faces);
  _mergeAdjacentCoplanarFacePairs(faces);
  computeFeatureEdges(faces);

  const groups = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (!face || !Array.isArray(face.vertices) || face.vertices.length < 3) continue;
    if (face.isCurved || face.isFillet || face.isCorner) continue;
    if (face.faceType && !face.faceType.startsWith('planar')) continue;
    const groupKey = face.faceGroup != null ? face.faceGroup : fi;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(fi);
  }

  const removeIndices = new Set();
  const replacements = [];
  for (const faceIndices of groups.values()) {
    if (faceIndices.length < 2) continue;

    const mergedVerts = _tracePlanarFaceGroupLoop(faces, faceIndices);
    if (!mergedVerts) continue;

    let mergedNormal = _computePolygonNormal(mergedVerts);
    if (!mergedNormal) continue;

    const componentFaces = faceIndices.map((fi) => faces[fi]).filter(Boolean);
    const template = [...componentFaces].sort((a, b) => _polygonArea(b) - _polygonArea(a))[0];
    if (!template) continue;

    const templateNormal = _vec3Normalize(template.normal || { x: 0, y: 0, z: 0 });
    if (_vec3Len(templateNormal) >= 1e-10 && _vec3Dot(mergedNormal, templateNormal) < 0) {
      mergedVerts.reverse();
      mergedNormal = _computePolygonNormal(mergedVerts);
      if (!mergedNormal) continue;
    }

    const topoFaceIds = [...new Set(faceIndices.flatMap((fi) => _collectFaceTopoFaceIds(faces[fi])))];
    const sharedSignatures = new Set(faceIndices.map((fi) => _sharedMetadataSignature(faces[fi].shared)));
    const replacement = {
      ...template,
      vertices: mergedVerts.map((vertex) => ({ ...vertex })),
      normal: mergedNormal,
      shared: sharedSignatures.size === 1 && template.shared ? { ...template.shared } : null,
      topoFaceId: topoFaceIds.length === 1 ? topoFaceIds[0] : undefined,
    };
    if (topoFaceIds.length > 1) replacement.topoFaceIds = topoFaceIds;
    else if (topoFaceIds.length === 1) replacement.topoFaceIds = [topoFaceIds[0]];

    replacements.push(replacement);
    for (const fi of faceIndices) removeIndices.add(fi);
  }

  if (replacements.length === 0) {
    return faces;
  }

  const compactedFaces = [];
  for (let fi = 0; fi < faces.length; fi++) {
    if (!removeIndices.has(fi)) compactedFaces.push(faces[fi]);
  }
  compactedFaces.push(...replacements);

  _weldVertices(compactedFaces);
  _removeDegenerateFaces(compactedFaces);
  _recomputeFaceNormals(compactedFaces);
  return compactedFaces;
}

// Mesh repair functions now delegate to toolkit/MeshRepair.js
const _weldVertices = _weldVertices_toolkit;
const _removeDegenerateFaces = _removeDegenerateFaces_toolkit;
const _recomputeFaceNormals = _recomputeFaceNormals_toolkit;

/**
 * Triangulate concave polygon faces (>4 vertices) using CDT so that
 * renderers don't produce self-intersecting fan triangulations.
 * Operates in-place on the faces array by splicing N-gons into triangles.
 */
function _triangulateConcaveFaces(faces) {
  for (let fi = faces.length - 1; fi >= 0; fi--) {
    const face = faces[fi];
    if (face.vertices.length <= 4) continue;
    const norm = face.normal;
    if (!norm || _vec3Len(norm) < 1e-10) continue;
    // Build 2D projection frame
    let ax;
    if (Math.abs(norm.x) < 0.9) ax = { x: 1, y: 0, z: 0 };
    else ax = { x: 0, y: 1, z: 0 };
    const uAxis = _vec3Normalize(_vec3Cross(norm, ax));
    const vAxis = _vec3Cross(norm, uAxis);
    const origin = face.vertices[0];
    const pts2D = face.vertices.map(v => ({
      x: _vec3Dot(_vec3Sub(v, origin), uAxis),
      y: _vec3Dot(_vec3Sub(v, origin), vAxis),
    }));
    // Ensure CCW winding for CDT
    let area2 = 0;
    for (let i = 0; i < pts2D.length; i++) {
      const j = (i + 1) % pts2D.length;
      area2 += pts2D[i].x * pts2D[j].y - pts2D[j].x * pts2D[i].y;
    }
    if (area2 < 0) { pts2D.reverse(); face.vertices.reverse(); }
    try {
      const tris = constrainedTriangulate(pts2D);
      if (tris.length === 0) continue;
      const newFaces = tris.map(([a, b, c]) => ({
        vertices: [{ ...face.vertices[a] }, { ...face.vertices[b] }, { ...face.vertices[c] }],
        normal: { ...face.normal },
        shared: face.shared ? { ...face.shared } : null,
        isFillet: face.isFillet || false,
        isCorner: face.isCorner || false,
        faceGroup: face.faceGroup,
        topoFaceId: face.topoFaceId,
      }));
      faces.splice(fi, 1, ...newFaces);
    } catch (_e) {
      // CDT failed — keep original face
    }
  }
}

/**
 * Fix winding consistency across all faces using BFS propagation from a seed
 * face, then verify outward orientation via signed volume.  When 3+ chamfer/
 * fillet edges meet at a vertex, the independently-generated bevel faces may
 * have winding that conflicts with the trimmed original faces.  This function
 * detects and corrects such conflicts.
 */
const _fixWindingConsistency = _fixWindingConsistency_toolkit;

export function applyChamfer(geometry, edgeKeys, distance) {
  if (!geometry || !geometry.faces || edgeKeys.length === 0 || distance <= 0) {
    return geometry;
  }

  const baseFaces = _extractFeatureFacesFromTopoBody(geometry);
  const exactAdjacencyByKey = _buildExactEdgeAdjacencyLookupFromTopoBody(
    geometry.topoBody,
    baseFaces,
  );
  let faces = baseFaces.map(f => ({
    vertices: f.vertices.map(v => ({ ...v })),
    normal: { ...f.normal },
    shared: f.shared ? { ...f.shared } : null,
    isFillet: f.isFillet || false,
    faceGroup: f.faceGroup,
    topoFaceId: f.topoFaceId,
  }));

  // Save original face vertices for corner-face generation
  const origFaces = faces.map(f => ({
    vertices: f.vertices.map(v => ({ ...v })),
    normal: { ...f.normal },
  }));

  // --- Phase 1: Pre-compute all edge data on the ORIGINAL geometry ---
  const uniqueKeys = [...new Set(edgeKeys)];
  const edgeDataList = [];
  for (const ek of uniqueKeys) {
    const data = _precomputeChamferEdge(faces, ek, distance, exactAdjacencyByKey);
    if (data) edgeDataList.push(data);
  }

  if (edgeDataList.length === 0) return geometry;

  // --- Phase 2: Build vertex-sharing map ---
  const vertexEdgeMap = _buildVertexEdgeMap(edgeDataList);

  // --- Phase 2.5: Merge shared-vertex positions on common faces ---
  // When 2+ chamfer edges meet at a vertex and share a common face, combine
  // their independent offsets into a single merged position that lies at the
  // intersection of the bevel planes on the face, eliminating the gap that
  // would otherwise require a corner face.
  _mergeSharedVertexPositions(edgeDataList, vertexEdgeMap);

  // --- Phase 3: Apply batch face trimming ---
  _batchTrimFaces(faces, edgeDataList);

  // --- Phase 4: Batch split vertices at endpoints ---
  _batchSplitVertices(faces, edgeDataList, vertexEdgeMap);

  // --- Phase 5: Generate all bevel faces + NURBS definitions ---
  const brep = new BRep();

  // Add BRep faces for existing trimmed faces (no NURBS — they are planar)
  for (const face of faces) {
    const brepFace = new BRepFace(null, 'planar', face.shared);
    brep.addFace(brepFace);
  }

  for (const data of edgeDataList) {
    const chamferNormal = _vec3Normalize(_vec3Cross(
      _vec3Sub(data.p1a, data.p0a), _vec3Sub(data.p1b, data.p0a)
    ));

    const meshFace = {
      vertices: [{ ...data.p0a }, { ...data.p1a }, { ...data.p1b }, { ...data.p0b }],
      normal: chamferNormal,
      shared: data.shared,
      _isChamferBevel: true,
    };
    faces.push(meshFace);

    // Create NURBS surface for the chamfer bevel (bilinear planar patch)
    const nurbsSurface = NurbsSurface.createChamferSurface(
      data.p0a, data.p0b, data.p1a, data.p1b
    );
    const brepFace = new BRepFace(nurbsSurface, 'chamfer', data.shared);

    // Add BRep edge curves (straight lines for chamfer trim edges)
    const edge0 = new BRepEdge(
      new BRepVertex(data.p0a), new BRepVertex(data.p0b),
      NurbsCurve.createLine(data.p0a, data.p0b)
    );
    const edge1 = new BRepEdge(
      new BRepVertex(data.p1a), new BRepVertex(data.p1b),
      NurbsCurve.createLine(data.p1a, data.p1b)
    );
    brep.addEdge(edge0);
    brep.addEdge(edge1);
    brep.addFace(brepFace);
  }

  // --- Phase 6: Generate corner faces at shared vertices ---
  _generateCornerFaces(faces, origFaces, edgeDataList, vertexEdgeMap);

  _fixTJunctions(faces);
  _healBoundaryLoops(faces);
  _weldVertices(faces);
  _removeDegenerateFaces(faces);
  _mergeMixedSharedPlanarComponents(faces);
  _mergeAdjacentCoplanarFacePairs(faces);
  _fixTJunctions(faces);
  _healBoundaryLoops(faces);
  _weldVertices(faces);
  _removeDegenerateFaces(faces);
  _recomputeFaceNormals(faces);
  _triangulateConcaveFaces(faces);

  // --- Phase 7: Attempt exact topology promotion ---
  try {
    const topoBody = _buildExactChamferTopoBody(faces, edgeDataList);
    if (topoBody) {
      const exactGeometry = tessellateBody(topoBody);
      exactGeometry.topoBody = topoBody;
      exactGeometry.brep = brep;
      const edgeResult = computeFeatureEdges(exactGeometry.faces || []);
      exactGeometry.edges = edgeResult.edges;
      exactGeometry.paths = edgeResult.paths;
      exactGeometry.visualEdges = edgeResult.visualEdges;
      const meshUsage = _countMeshEdgeUsage(exactGeometry.faces || []);
      if (meshUsage.boundaryCount === 0 && meshUsage.nonManifoldCount === 0) {
        return exactGeometry;
      }
    }
  } catch (exactErr) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('Exact chamfer topology promotion skipped:', exactErr.message);
    }
  }

  const newGeom = { vertices: [], faces, brep };
  const edgeResult = computeFeatureEdges(faces);
  newGeom.edges = edgeResult.edges;
  newGeom.paths = edgeResult.paths;
  newGeom.visualEdges = edgeResult.visualEdges;
  return newGeom;
}


// -----------------------------------------------------------------------
// Fillet geometry operation
// -----------------------------------------------------------------------

export function applyFillet(geometry, edgeKeys, radius, segments = 8, edgeOwnerMap = null) {
  if (!geometry || !geometry.faces || edgeKeys.length === 0 || radius <= 0) {
    return geometry;
  }

  const baseFaces = _extractFeatureFacesFromTopoBody(geometry);
  const exactAdjacencyByKey = _buildExactEdgeAdjacencyLookupFromTopoBody(
    geometry.topoBody,
    baseFaces,
  );
  let faces = baseFaces.map(f => ({
    vertices: f.vertices.map(v => ({ ...v })),
    normal: { ...f.normal },
    shared: f.shared ? { ...f.shared } : null,
    isFillet: f.isFillet || false,
    isCorner: f.isCorner || false,
    faceGroup: f.faceGroup,
    topoFaceId: f.topoFaceId,
    // Preserve cylinder metadata for fillet-fillet intersection detection
    _exactAxisStart: f._exactAxisStart ? { ...f._exactAxisStart } : null,
    _exactAxisEnd: f._exactAxisEnd ? { ...f._exactAxisEnd } : null,
    _exactRadius: f._exactRadius || null,
  }));

  // Save original face vertices for corner-face generation
  const origFaces = faces.map(f => ({
    vertices: f.vertices.map(v => ({ ...v })),
    normal: { ...f.normal },
  }));

  // --- Phase 0: Extend edge keys through fillet boundaries ---
  // When an edge endpoint sits on an existing fillet boundary (not a sharp corner),
  // extend the edge along its direction to pass through the fillet surface.
  // This enables fillet-through-fillet operations where the new fillet cuts through old fillets.
  const extendedEdgeKeys = _extendEdgesThroughFilletBoundaries(faces, edgeKeys);

  // --- Phase 1: Pre-compute all edge data on the ORIGINAL geometry ---
  const uniqueKeys = [...new Set(extendedEdgeKeys)];
  const edgeDataList = [];
  for (const ek of uniqueKeys) {
    const data = _precomputeFilletEdge(faces, ek, radius, segments, exactAdjacencyByKey);
    if (!data) continue;
    const ownerId = edgeOwnerMap && edgeOwnerMap[ek];
    if (ownerId) {
      data.shared = { ...(data.shared || {}), sourceFeatureId: ownerId };
    }
    edgeDataList.push(data);
  }

  if (edgeDataList.length === 0) return geometry;

  // --- Phase 1b: Compute fillet-fillet intersection trims ---
  // For edges that pass through existing fillet surfaces, compute the intersection
  // curve between the new fillet cylinder and the old fillet cylinder.
  _computeFilletFilletIntersections(faces, edgeDataList, radius, segments);

  // --- Phase 1c: Clip old fillet faces in the overlap zone ---
  // When a new fillet passes through an existing fillet surface, remove or trim
  // the old fillet strip quads that would overlap with the new fillet.
  _clipOldFilletFacesInOverlapZone(faces, edgeDataList, radius);

  // --- Phase 2: Build vertex-sharing map ---
  const vertexEdgeMap = _buildVertexEdgeMap(edgeDataList);

  // Merge common-face trim vertices before face trimming so the shared planar
  // face uses the real fillet/fillet breakpoint instead of a legacy diagonal.
  _mergeSharedVertexPositions(edgeDataList, vertexEdgeMap);

  // --- Phase 3: Apply batch face trimming ---
  _batchTrimFaces(faces, edgeDataList);

  _batchSplitVertices(faces, edgeDataList, vertexEdgeMap);
  _applyTwoEdgeFilletSharedTrims(edgeDataList, origFaces, vertexEdgeMap);

  // --- Phase 4: Generate all fillet strip quads, endpoint fans, + NURBS ---
  const brep = new BRep();

  // Add BRep faces for existing trimmed faces (planar or previously defined)
  for (const face of faces) {
    const brepFace = new BRepFace(null, face.isFillet ? 'fillet' : 'planar', face.shared);
    brep.addFace(brepFace);
  }

  const sharedEndpoints = new Set();
  for (const [vk, edgeIndices] of vertexEdgeMap) {
    if (edgeIndices.length >= 2) sharedEndpoints.add(vk);
  }

  function trySpliceEndpointArcIntoFace(arc, desiredNormal) {
    if (!desiredNormal || _vec3Len(desiredNormal) < 1e-10 || arc.length < 3) return false;

    // Check if arc is actually curved or nearly collinear.
    // If the arc points deviate from the straight line between endpoints,
    // we should NOT splice them into a planar face - use fan triangles instead.
    const startPt = arc[0];
    const endPt = arc[arc.length - 1];
    const chordDir = _vec3Sub(endPt, startPt);
    const chordLen = _vec3Len(chordDir);
    if (chordLen > 1e-10) {
      const chordNorm = _vec3Normalize(chordDir);
      // Check deviation of interior points from the chord line
      for (let i = 1; i < arc.length - 1; i++) {
        const pt = arc[i];
        const toPoint = _vec3Sub(pt, startPt);
        const projLen = _vec3Dot(toPoint, chordNorm);
        const projected = _vec3Add(startPt, _vec3Scale(chordNorm, projLen));
        const deviation = _vec3Len(_vec3Sub(pt, projected));
        // If any interior point deviates from the chord line by more than 1% of chord length,
        // this is a curved arc - don't splice it into planar faces
        if (deviation > chordLen * 0.01) {
          return false;
        }
      }
    }

    const startKey = _edgeVKey(arc[0]);
    const endKey = _edgeVKey(arc[arc.length - 1]);
    const arcKeys = new Set(arc.map((v) => _edgeVKey(v)));
    const arcInterior = arc.slice(1, -1);

    for (const face of faces) {
      if (!face || !face.vertices || face.vertices.length < 3 || face.isFillet) continue;
      if (face.vertices.every((v) => arcKeys.has(_edgeVKey(v)))) continue;
      const fn = _vec3Normalize(face.normal || { x: 0, y: 0, z: 0 });
      if (_vec3Len(fn) < 1e-10) continue;
      if (Math.abs(_vec3Dot(fn, desiredNormal)) < 0.999) continue;
      if (!arc.every((p) => _pointOnFacePlane(p, face.vertices))) continue;

      const verts = face.vertices;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        const aKey = _edgeVKey(a);
        const bKey = _edgeVKey(b);
        if ((aKey !== startKey || bKey !== endKey) && (aKey !== endKey || bKey !== startKey)) continue;

        const insert = aKey === startKey ? arcInterior : [...arcInterior].reverse();
        const newVerts = [];
        for (let vi = 0; vi < verts.length; vi++) {
          newVerts.push({ ...verts[vi] });
          if (vi === i) {
            for (const p of insert) newVerts.push({ ...p });
          }
        }

        face.vertices = _deduplicatePolygon(newVerts);
        let newNormal = _computePolygonNormal(face.vertices);
        if (newNormal && _vec3Dot(newNormal, desiredNormal) < 0) {
          face.vertices.reverse();
          newNormal = _computePolygonNormal(face.vertices);
        }
        if (newNormal) face.normal = newNormal;
        return true;
      }
    }

    return false;
  }

  function pushFallbackEndpointFan(arc, atStart, shared) {
    for (let s = 1; s < arc.length - 1; s++) {
      const triVerts = atStart
        ? [{ ...arc[0] }, { ...arc[s + 1] }, { ...arc[s] }]
        : [{ ...arc[0] }, { ...arc[s] }, { ...arc[s + 1] }];
      const triNormal = _computePolygonNormal(triVerts);
      if (!triNormal || _vec3Len(triNormal) < 1e-10) continue;
      faces.push({
        vertices: triVerts,
        normal: triNormal,
        shared,
      });
    }
  }

  for (let dataIndex = 0; dataIndex < edgeDataList.length; dataIndex++) {
    const data = edgeDataList[dataIndex];
    const shared = data.shared;
    const arcA = data.arcA;
    const arcB = data.arcB;
    const edgeDir = _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA));

    // Create NURBS fillet surface for this edge
    // The fillet is a rolling-ball blend: circular arc cross-section swept along the edge.
    // Rail curves are the tangent lines on each adjacent face.
    const rail0 = [{ ...arcA[0] }, { ...arcB[0] }];
    const rail1 = [{ ...arcA[segments] }, { ...arcB[segments] }];

    // Compute arc centers at each endpoint for the NURBS definition
    const { offsDir0, offsDir1, isConcave: _nc } = _computeOffsetDirs(
      faces[data.fi0], faces[data.fi1], data.edgeA, data.edgeB
    );
    const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));
    const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
    const centerDist = alpha > 1e-6 ? radius / Math.sin(alpha / 2) : radius;
    const centerA = _vec3Add(data.edgeA, _vec3Scale(bisector, centerDist));
    const centerB = _vec3Add(data.edgeB, _vec3Scale(bisector, centerDist));
    data._exactAxisStart = { ...centerA };
    data._exactAxisEnd = { ...centerB };
    data._exactRadius = radius;
    data._exactArcCurveA = null;
    data._exactArcCurveB = null;
    data._exactSharedTrimCurveA = null;
    data._exactSharedTrimCurveB = null;

    const rebuildSharedTrim = (side) => {
      const points = side === 'A' ? data.sharedTrimA : data.sharedTrimB;
      const planeOrigin = side === 'A'
        ? data._sharedTrimPlaneAOrigin
        : data._sharedTrimPlaneBOrigin;
      const planeNormal = side === 'A'
        ? data._sharedTrimPlaneANormal
        : data._sharedTrimPlaneBNormal;
      if (!points || !planeOrigin || !planeNormal) return;
      const curve = _createExactCylinderPlaneTrimCurve(
        points,
        data._exactAxisStart,
        data._exactAxisEnd,
        radius,
        planeOrigin,
        planeNormal,
      );
      if (!curve) return;
      const rebuiltPoints = curve.tessellate(segments).map((point) => ({ x: point.x, y: point.y, z: point.z }));
      rebuiltPoints[0] = { ...points[0] };
      rebuiltPoints[rebuiltPoints.length - 1] = { ...points[points.length - 1] };
      if (side === 'A') {
        data._exactSharedTrimCurveA = curve.clone();
        data.sharedTrimA = rebuiltPoints;
      } else {
        data._exactSharedTrimCurveB = curve.clone();
        data.sharedTrimB = rebuiltPoints;
      }
    };
    rebuildSharedTrim('A');
    rebuildSharedTrim('B');
    const trimA = data.sharedTrimA || arcA;
    const trimB = data.sharedTrimB || arcB;

    // Create NURBS fillet surface using the rolling-ball factory
    try {
      const nurbsSurface = NurbsSurface.createFilletSurface(
        rail0, rail1, [centerA, centerB], radius, _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA))
      );
      data._exactSurface = nurbsSurface;
      const brepFace = new BRepFace(nurbsSurface, 'fillet', shared);

      // Add BRep edge curves for the trim lines
      const trimCurve0 = NurbsCurve.createLine(arcA[0], arcB[0]);
      const trimCurve1 = NurbsCurve.createLine(arcA[segments], arcB[segments]);
      brep.addEdge(new BRepEdge(new BRepVertex(arcA[0]), new BRepVertex(arcB[0]), trimCurve0));
      brep.addEdge(new BRepEdge(new BRepVertex(arcA[segments]), new BRepVertex(arcB[segments]), trimCurve1));

      // Add NURBS arc curves at each cross-section
      // These represent the exact circular profile of the fillet
      const xAxisA = _vec3Normalize(_vec3Sub(arcA[0], centerA));
      const crossA = _vec3Cross(edgeDir, xAxisA);
      const yAxisA = _vec3Normalize(crossA);
      const sweep = Math.PI - alpha;

      if (sweep > 1e-6) {
        const arcCurveA = NurbsCurve.createArc(centerA, radius, xAxisA, yAxisA, 0, sweep);
        const arcCurveB = NurbsCurve.createArc(centerB, radius,
          _vec3Normalize(_vec3Sub(arcB[0], centerB)),
          _vec3Normalize(_vec3Cross(edgeDir, _vec3Normalize(_vec3Sub(arcB[0], centerB)))),
          0, sweep
        );
        data._exactArcCurveA = arcCurveA.clone();
        data._exactArcCurveB = arcCurveB.clone();
        brep.addEdge(new BRepEdge(new BRepVertex(arcA[0]), new BRepVertex(arcA[segments]), arcCurveA));
        brep.addEdge(new BRepEdge(new BRepVertex(arcB[0]), new BRepVertex(arcB[segments]), arcCurveB));
      }

      brep.addFace(brepFace);
    } catch (nurbsErr) {
      // NURBS construction may fail for degenerate edge geometries (e.g.
      // near-zero sweep angle or coincident rails); mesh data still valid.
      // Log for debugging but don't block the operation.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('NURBS fillet surface construction skipped:', nurbsErr.message);
      }
    }

    // Create fillet strip quads (mesh tessellation)
    for (let s = 0; s < segments; s++) {
      const faceNormal = _vec3Normalize(_vec3Cross(
        _vec3Sub(trimA[s + 1], trimA[s]),
        _vec3Sub(trimB[s + 1], trimA[s])
      ));
      faces.push({
        vertices: [{ ...trimA[s] }, { ...trimA[s + 1] }, { ...trimB[s + 1] }, { ...trimB[s] }],
        normal: faceNormal,
        shared,
        isFillet: true,
        _exactFilletFaceOrdinal: dataIndex,
        // Store cylinder metadata for fillet-fillet intersection detection in sequential operations
        _exactAxisStart: data._exactAxisStart ? { ...data._exactAxisStart } : null,
        _exactAxisEnd: data._exactAxisEnd ? { ...data._exactAxisEnd } : null,
        _exactRadius: data._exactRadius || null,
      });
    }

    // Fan triangles at endpoint A — only if NOT a shared internal vertex
    // and NOT a fillet-fillet junction (where the strip extends to the old cylinder surface)
    // For concave edges, skip splice (arc bows inward, would create ear) and use fan
    const vkA = _edgeVKey(data.edgeA);
    if (!sharedEndpoints.has(vkA) && !data._filletJunctionSideA) {
      let merged = false;
      if (!data.isConcave) {
        merged = trySpliceEndpointArcIntoFace(arcA, _vec3Scale(edgeDir, -1));
      }
      if (!merged) pushFallbackEndpointFan(arcA, true, shared);
    }

    // Fan triangles at endpoint B — only if NOT a shared internal vertex
    // and NOT a fillet-fillet junction
    const vkB = _edgeVKey(data.edgeB);
    if (!sharedEndpoints.has(vkB) && !data._filletJunctionSideB) {
      let merged = false;
      if (!data.isConcave) {
        merged = trySpliceEndpointArcIntoFace(arcB, edgeDir);
      }
      if (!merged) pushFallbackEndpointFan(arcB, false, shared);
    }
  }

  // --- Phase 5: Generate corner/blending faces at shared vertices ---
  _generateCornerFaces(faces, origFaces, edgeDataList, vertexEdgeMap);
  _fixTJunctions(faces);

  // Add BRep faces for spherical corner patches (from _generateTrihedronCorner).
  // Build a NURBS surface using the Cobb octant construction so that the
  // spherical face has an exact rational representation for CAM/machining.
  {
    const seen = new Set();
    for (const face of faces) {
      if (!face.isCorner || !face._sphereCenter || !face._triVerts) continue;
      const cKey = _edgeVKey(face._sphereCenter);
      if (seen.has(cKey)) continue;
      seen.add(cKey);
      let nurbsSurf = null;
      try {
        nurbsSurf = NurbsSurface.createSphericalPatch(
          face._sphereCenter, face._sphereRadius,
          face._triVerts[0], face._triVerts[1], face._triVerts[2]
        );
      } catch (e) {
        // Degenerate geometry — fall back to metadata-only.
      }
      const brepFace = new BRepFace(nurbsSurf, 'spherical', face.shared);
      brepFace.sphereCenter = { ...face._sphereCenter };
      brepFace.sphereRadius = face._sphereRadius;
      brep.addFace(brepFace);
    }
  }

  {
    const seen = new Set();
    for (const face of faces) {
      if (!face.isCorner || !face._cornerPatch || !face._cornerPatchKey) continue;
      if (seen.has(face._cornerPatchKey)) continue;
      seen.add(face._cornerPatchKey);
      let nurbsSurf = null;
      try {
        nurbsSurf = NurbsSurface.createCornerBlendPatch(
          face._cornerPatch.top0,
          face._cornerPatch.top1,
          face._cornerPatch.side0Mid,
          face._cornerPatch.side1Mid,
          face._cornerPatch.apex,
          face._cornerPatch.centerPoint,
          face._cornerPatch.topMid,
        );
      } catch (e) {
        // Keep the exact corner grouped in BRep history even if patch fitting fails.
      }
      const brepFace = new BRepFace(nurbsSurf, 'fillet', face.shared);
      brepFace.isCornerPatch = true;
      brep.addFace(brepFace);
    }
  }

  // --- Phase 6: Heal boundary edges left by sequential fillet interactions ---
  _healBoundaryLoops(faces);

  _weldVertices(faces);
  _removeDegenerateFaces(faces);
  _mergeMixedSharedPlanarComponents(faces);
  _mergeAdjacentCoplanarFacePairs(faces);
  _fixTJunctions(faces);
  _healBoundaryLoops(faces);
  _removeDegenerateFaces(faces);
  _recomputeFaceNormals(faces);

  try {
    const topoBody = _buildExactFilletTopoBody(faces, edgeDataList);
    if (topoBody) {
      const exactGeometry = tessellateBody(topoBody);
      exactGeometry.topoBody = topoBody;
      exactGeometry.brep = brep;
      const edgeResult = computeFeatureEdges(exactGeometry.faces || []);
      const exactEdgeResult = _buildExactFeatureEdgesFromTopoBody(topoBody, exactGeometry.faces || []);
      exactGeometry.edges = exactEdgeResult.edges.length > 0 ? exactEdgeResult.edges : edgeResult.edges;
      exactGeometry.paths = exactEdgeResult.paths.length > 0 ? exactEdgeResult.paths : edgeResult.paths;
      exactGeometry.visualEdges = edgeResult.visualEdges;
      const exactMeshUsage = _countMeshEdgeUsage(exactGeometry.faces || []);
      if (exactMeshUsage.boundaryCount === 0 && exactMeshUsage.nonManifoldCount === 0) {
        return exactGeometry;
      }

      const fallbackFaces = _applyTopoFaceIdsToFallbackMesh(faces, topoBody, edgeDataList);
      _mergeMixedSharedPlanarComponents(fallbackFaces, true);
      _mergeAdjacentCoplanarFacePairs(fallbackFaces);
      _fixTJunctions(fallbackFaces);
      _healBoundaryLoops(fallbackFaces);
      _removeDegenerateFaces(fallbackFaces);
      _recomputeFaceNormals(fallbackFaces);
      _fixWindingConsistency(fallbackFaces);
      _fixOpposedCoplanarFacesInGroups(fallbackFaces);
      const hybridFallbackFaces = _replaceFallbackPlanarFacesWithExactTopoFaces(fallbackFaces, topoBody);
      _removeDegenerateFaces(hybridFallbackFaces);
      _recomputeFaceNormals(hybridFallbackFaces);
      _fixWindingConsistency(hybridFallbackFaces);
      _fixOpposedCoplanarFacesInGroups(hybridFallbackFaces);
      _mergeCoplanarNonManifoldComponents(hybridFallbackFaces);
      _removeDegenerateFaces(hybridFallbackFaces);
      _recomputeFaceNormals(hybridFallbackFaces);
      _fixWindingConsistency(hybridFallbackFaces);
      _fixOpposedCoplanarFacesInGroups(hybridFallbackFaces);
      const hybridMeshUsage = _countMeshEdgeUsage(hybridFallbackFaces);
      if (hybridMeshUsage.boundaryCount > 0 || hybridMeshUsage.nonManifoldCount > 0) {
        _fixTJunctions(hybridFallbackFaces);
        _healBoundaryLoops(hybridFallbackFaces);
        _removeDegenerateFaces(hybridFallbackFaces);
        _recomputeFaceNormals(hybridFallbackFaces);
        _fixWindingConsistency(hybridFallbackFaces);
        _fixOpposedCoplanarFacesInGroups(hybridFallbackFaces);
        _mergeCoplanarNonManifoldComponents(hybridFallbackFaces);
        _removeDegenerateFaces(hybridFallbackFaces);
        _recomputeFaceNormals(hybridFallbackFaces);
        _fixWindingConsistency(hybridFallbackFaces);
        _fixOpposedCoplanarFacesInGroups(hybridFallbackFaces);
      }
      const fallbackGeometry = { vertices: [], faces: hybridFallbackFaces, brep, topoBody };
      const fallbackEdgeResult = computeFeatureEdges(hybridFallbackFaces);
      const fallbackExactEdgeResult = _buildExactFeatureEdgesFromTopoBody(topoBody, hybridFallbackFaces);
      const supportedExactEdgeResult = _mergeExactAndFallbackFeatureEdges(
        hybridFallbackFaces,
        fallbackExactEdgeResult,
        fallbackEdgeResult,
      );
      fallbackGeometry.edges = supportedExactEdgeResult.edges.length > 0 ? supportedExactEdgeResult.edges : fallbackEdgeResult.edges;
      fallbackGeometry.paths = supportedExactEdgeResult.paths.length > 0 ? supportedExactEdgeResult.paths : fallbackEdgeResult.paths;
      fallbackGeometry.visualEdges = fallbackEdgeResult.visualEdges;
      return fallbackGeometry;
    }
  } catch (exactErr) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('Exact fillet topology promotion skipped:', exactErr.message);
    }
  }

  const newGeom = { vertices: [], faces, brep };
  _triangulateConcaveFaces(newGeom.faces);
  const edgeResult = computeFeatureEdges(newGeom.faces);
  newGeom.edges = edgeResult.edges;
  newGeom.paths = edgeResult.paths;
  newGeom.visualEdges = edgeResult.visualEdges;
  return newGeom;
}

// -----------------------------------------------------------------------
// Batch chamfer/fillet helpers
// -----------------------------------------------------------------------

// _buildVertexEdgeMap → delegates to toolkit/TopologyUtils.js
const _buildVertexEdgeMap = _buildVertexEdgeMap_toolkit;

function _buildExactFeatureEdgesFromTopoBody(topoBody, faces, edgeSegments = 16) {
  if (!topoBody || !topoBody.shells || !Array.isArray(faces) || faces.length === 0) {
    return { edges: [], paths: [] };
  }

  const repFaceIndexByTopoFaceId = _buildRepFaceIndexByTopoFaceId(faces);

  const edges = [];
  for (const shell of topoBody.shells) {
    for (const edge of shell.edges()) {
      const points = _sampleExactEdgePoints(edge, edgeSegments);
      if (points.length < 2) continue;

      const topoFaceIds = edge.coedges
        .map((coedge) => coedge && coedge.face ? coedge.face.id : undefined)
        .filter((id) => id !== undefined);
      const faceIndices = topoFaceIds
        .map((topoFaceId) => repFaceIndexByTopoFaceId.get(topoFaceId))
        .filter((index) => index !== undefined);
      if (faceIndices.length === 0) continue;

      const hasFillet = faceIndices.some((fi) => !!faces[fi]?.isFillet);
      const hasNonFillet = faceIndices.some((fi) => !faces[fi]?.isFillet);

      edges.push({
        start: { ...points[0] },
        end: { ...points[points.length - 1] },
        points,
        faceIndices,
        normals: faceIndices.map((fi) => faces[fi].normal),
        type: hasFillet && hasNonFillet ? 'fillet-boundary' : 'sharp',
      });
    }
  }

  return { edges, paths: _chainEdgePaths(edges) };
}


function _countMeshEdgeUsage(faces) {
  if (!Array.isArray(faces) || faces.length === 0) {
    return { boundaryCount: 0, nonManifoldCount: 0 };
  }
  const edgeCounts = new Map();
  for (const face of faces) {
    const vertices = face && Array.isArray(face.vertices) ? face.vertices : [];
    for (let i = 0; i < vertices.length; i++) {
      const edgeKey = _edgeKeyFromVerts(vertices[i], vertices[(i + 1) % vertices.length]);
      edgeCounts.set(edgeKey, (edgeCounts.get(edgeKey) || 0) + 1);
    }
  }
  let boundaryCount = 0;
  let nonManifoldCount = 0;
  for (const count of edgeCounts.values()) {
    if (count === 1) boundaryCount += 1;
    else if (count > 2) nonManifoldCount += 1;
  }
  return { boundaryCount, nonManifoldCount };
}

function _countMeshBoundaryEdges(faces) {
  return _countMeshEdgeUsage(faces).boundaryCount;
}

function _pathEndpointPoints(edges, path) {
  if (!path || path.isClosed || !Array.isArray(path.edgeIndices) || path.edgeIndices.length === 0) {
    return null;
  }

  const counts = new Map();
  const points = new Map();
  for (const edgeIndex of path.edgeIndices) {
    const edge = edges[edgeIndex];
    if (!edge) continue;
    for (const point of [edge.start, edge.end]) {
      const key = _edgeVKey(point);
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!points.has(key)) points.set(key, point);
    }
  }

  const endpoints = [];
  for (const [key, count] of counts) {
    if (count === 1 && points.has(key)) endpoints.push(points.get(key));
  }
  return endpoints.length === 2 ? endpoints : null;
}

function _pathFaceGroupKey(edges, path, faces) {
  const groups = new Set();
  if (!path || !Array.isArray(path.edgeIndices)) return '';

  for (const edgeIndex of path.edgeIndices) {
    const edge = edges[edgeIndex];
    if (!edge || !Array.isArray(edge.faceIndices)) continue;
    for (const fi of edge.faceIndices) {
      const group = faces[fi] && faces[fi].faceGroup;
      if (group !== undefined && group !== null) groups.add(group);
    }
  }

  return [...groups].sort((a, b) => a - b).join('|');
}

function _pathFeatureKind(edges, path, faces) {
  let hasFillet = false;
  let hasNonFillet = false;
  let hasBoundary = false;
  if (!path || !Array.isArray(path.edgeIndices)) return 'sharp';

  for (const edgeIndex of path.edgeIndices) {
    const edge = edges[edgeIndex];
    if (!edge) continue;
    if (edge.type === 'fillet-boundary') return 'fillet-boundary';
    if (Array.isArray(edge.faceIndices) && edge.faceIndices.length === 1) hasBoundary = true;
    for (const fi of edge.faceIndices || []) {
      const face = faces[fi];
      if (!face) continue;
      if (face.isFillet) hasFillet = true;
      else hasNonFillet = true;
    }
  }

  if (hasFillet && hasNonFillet) return 'fillet-boundary';
  if (hasBoundary) return 'boundary';
  return 'sharp';
}

function _mergeExactAndFallbackFeatureEdges(faces, exactEdgeResult, fallbackEdgeResult, endpointTolerance = 1e-4) {
  if (!fallbackEdgeResult || !Array.isArray(fallbackEdgeResult.edges) || fallbackEdgeResult.edges.length === 0) {
    return exactEdgeResult && Array.isArray(exactEdgeResult.edges) ? exactEdgeResult : { edges: [], paths: [] };
  }
  if (!exactEdgeResult || !Array.isArray(exactEdgeResult.edges) || exactEdgeResult.edges.length === 0) {
    return fallbackEdgeResult;
  }

  const maxEndpointDistSq = endpointTolerance * endpointTolerance * 2;
  const exactPaths = Array.isArray(exactEdgeResult.paths) ? exactEdgeResult.paths : _chainEdgePaths(exactEdgeResult.edges);
  const fallbackPaths = Array.isArray(fallbackEdgeResult.paths) ? fallbackEdgeResult.paths : _chainEdgePaths(fallbackEdgeResult.edges);

  const exactPathDescriptors = exactPaths.map((path, index) => ({
    index,
    path,
    faceGroupKey: _pathFaceGroupKey(exactEdgeResult.edges, path, faces),
    endpoints: _pathEndpointPoints(exactEdgeResult.edges, path),
    kind: _pathFeatureKind(exactEdgeResult.edges, path, faces),
  }));

  const usedExactPathIndices = new Set();
  const mergedEdges = [];

  for (const fallbackPath of fallbackPaths) {
    const fallbackFaceGroupKey = _pathFaceGroupKey(fallbackEdgeResult.edges, fallbackPath, faces);
    const fallbackEndpoints = _pathEndpointPoints(fallbackEdgeResult.edges, fallbackPath);
    const fallbackKind = _pathFeatureKind(fallbackEdgeResult.edges, fallbackPath, faces);

    let matchedExactDescriptor = null;
    let bestEndpointScore = Infinity;
    if (fallbackEndpoints && fallbackFaceGroupKey) {
      for (const descriptor of exactPathDescriptors) {
        if (usedExactPathIndices.has(descriptor.index)) continue;
        if (!descriptor.endpoints) continue;
        if (descriptor.faceGroupKey !== fallbackFaceGroupKey) continue;

        const forwardA = _vec3Sub(fallbackEndpoints[0], descriptor.endpoints[0]);
        const forwardB = _vec3Sub(fallbackEndpoints[1], descriptor.endpoints[1]);
        const reverseA = _vec3Sub(fallbackEndpoints[0], descriptor.endpoints[1]);
        const reverseB = _vec3Sub(fallbackEndpoints[1], descriptor.endpoints[0]);
        const forwardScore = _vec3Dot(forwardA, forwardA) + _vec3Dot(forwardB, forwardB);
        const reverseScore = _vec3Dot(reverseA, reverseA) + _vec3Dot(reverseB, reverseB);
        const endpointScore = Math.min(forwardScore, reverseScore);
        if (endpointScore <= maxEndpointDistSq && endpointScore < bestEndpointScore) {
          bestEndpointScore = endpointScore;
          matchedExactDescriptor = descriptor;
        }
      }
    }

    if (!matchedExactDescriptor && fallbackEndpoints && fallbackKind === 'fillet-boundary') {
      for (const descriptor of exactPathDescriptors) {
        if (usedExactPathIndices.has(descriptor.index)) continue;
        if (!descriptor.endpoints) continue;
        if (descriptor.kind !== fallbackKind) continue;

        const forwardA = _vec3Sub(fallbackEndpoints[0], descriptor.endpoints[0]);
        const forwardB = _vec3Sub(fallbackEndpoints[1], descriptor.endpoints[1]);
        const reverseA = _vec3Sub(fallbackEndpoints[0], descriptor.endpoints[1]);
        const reverseB = _vec3Sub(fallbackEndpoints[1], descriptor.endpoints[0]);
        const forwardScore = _vec3Dot(forwardA, forwardA) + _vec3Dot(forwardB, forwardB);
        const reverseScore = _vec3Dot(reverseA, reverseA) + _vec3Dot(reverseB, reverseB);
        const endpointScore = Math.min(forwardScore, reverseScore);
        if (endpointScore <= maxEndpointDistSq && endpointScore < bestEndpointScore) {
          bestEndpointScore = endpointScore;
          matchedExactDescriptor = descriptor;
        }
      }
    }

    if (matchedExactDescriptor) {
      usedExactPathIndices.add(matchedExactDescriptor.index);
      for (const edgeIndex of matchedExactDescriptor.path.edgeIndices || []) {
        const edge = exactEdgeResult.edges[edgeIndex];
        if (edge) mergedEdges.push(edge);
      }
      continue;
    }

    for (const edgeIndex of fallbackPath.edgeIndices || []) {
      const edge = fallbackEdgeResult.edges[edgeIndex];
      if (edge) mergedEdges.push(edge);
    }
  }

  return {
    edges: mergedEdges,
    paths: _chainEdgePaths(mergedEdges),
  };
}


// _cloneMeshFace → delegates to toolkit/MeshRepair.js
const _cloneMeshFace = _cloneMeshFace_toolkit;

function _replaceFallbackPlanarFacesWithExactTopoFaces(fallbackFaces, topoBody) {
  if (!Array.isArray(fallbackFaces) || !topoBody) return fallbackFaces;

  const exactFaces = _extractFeatureFacesFromTopoBody({ topoBody, faces: [] });
  if (!Array.isArray(exactFaces) || exactFaces.length === 0) return fallbackFaces;

  const exactPlanarFaces = exactFaces
    .filter((face) =>
      face &&
      !face.isFillet &&
      !face.isCorner &&
      face.surfaceType === SurfaceType.PLANE &&
      Array.isArray(face.vertices) &&
      face.vertices.length >= 3 &&
      face.topoFaceId !== undefined)
    .map((face) => _cloneMeshFace(face));

  if (exactPlanarFaces.length === 0) return fallbackFaces;

  const replacedTopoFaceIds = new Set(
    exactPlanarFaces
      .map((face) => face.topoFaceId)
      .filter((topoFaceId) => topoFaceId !== undefined)
  );

  const preservedFaces = [];
  for (const face of fallbackFaces) {
    if (!face) continue;
    const topoFaceIds = _collectFaceTopoFaceIds(face);
    const replacesFace = topoFaceIds.some((topoFaceId) => replacedTopoFaceIds.has(topoFaceId));
    if (replacesFace) continue;
    preservedFaces.push(_cloneMeshFace(face));
  }

  return [...preservedFaces, ...exactPlanarFaces];
}

function _applyTopoFaceIdsToFallbackMesh(faces, topoBody, edgeDataList = []) {
  if (!Array.isArray(faces) || !topoBody || !Array.isArray(topoBody.shells) || topoBody.shells.length === 0) {
    return faces;
  }

  const shellFaces = topoBody.shells[0].faces || [];
  if (shellFaces.length === 0) return faces;

  const annotated = faces.map((face) => ({
    ...face,
    vertices: Array.isArray(face.vertices) ? face.vertices.map((vertex) => _canonicalPoint(vertex)) : [],
  }));

  let topoOrdinal = 0;
  for (let i = 0; i < annotated.length; i++) {
    const face = annotated[i];
    if (!face || face.isFillet) continue;
    const topoFace = shellFaces[topoOrdinal++];
    if (!topoFace) break;
    face.topoFaceId = topoFace.id;
    face.faceGroup = topoFace.id;
    face.surfaceType = topoFace.surfaceType;
  }

  const filletFaceOffset = topoOrdinal;
  const filletTopoFaceIds = new Map();
  for (let dataIndex = 0; dataIndex < edgeDataList.length; dataIndex++) {
    const topoFace = shellFaces[filletFaceOffset + dataIndex];
    if (!topoFace) continue;
    filletTopoFaceIds.set(dataIndex, topoFace.id);
  }

  for (const face of annotated) {
    if (!face || !face.isFillet) continue;
    const topoFaceId = filletTopoFaceIds.get(face._exactFilletFaceOrdinal);
    if (topoFaceId === undefined) continue;
    face.topoFaceId = topoFaceId;
    face.faceGroup = topoFaceId;
    face.surfaceType = SurfaceType.BSPLINE;
  }

  return annotated;
}


/**
 * Batch trim faces for all edge data at once.
 * Handles the case where a face has multiple edges being chamfered/filleted
 * (e.g., the circular top face of a cylinder). At shared vertices between two
 * edges on the same face, both replacement vertices are inserted.
 */
function _batchTrimFaces(faces, edgeDataList) {
  // Build per-face maps:
  // For each (face, original_vertex_key) → list of {edgeDataIndex, replacement position, role}
  // role: 'a' means vertex is edgeA of this edge data, 'b' means it's edgeB
  const faceTrimInfo = new Map(); // fi → Map(vk → [{di, pos, role}])

  for (let di = 0; di < edgeDataList.length; di++) {
    const d = edgeDataList[di];
    const vkA = _edgeVKey(d.edgeA);
    const vkB = _edgeVKey(d.edgeB);

    // Face 0
    if (!faceTrimInfo.has(d.fi0)) faceTrimInfo.set(d.fi0, new Map());
    const m0 = faceTrimInfo.get(d.fi0);
    if (!m0.has(vkA)) m0.set(vkA, []);
    m0.get(vkA).push({ di, pos: d.p0a, role: 'a' });
    if (!m0.has(vkB)) m0.set(vkB, []);
    m0.get(vkB).push({ di, pos: d.p0b, role: 'b' });

    // Face 1
    if (!faceTrimInfo.has(d.fi1)) faceTrimInfo.set(d.fi1, new Map());
    const m1 = faceTrimInfo.get(d.fi1);
    if (!m1.has(vkA)) m1.set(vkA, []);
    m1.get(vkA).push({ di, pos: d.p1a, role: 'a' });
    if (!m1.has(vkB)) m1.set(vkB, []);
    m1.get(vkB).push({ di, pos: d.p1b, role: 'b' });
  }

  // Now apply trims per face
  for (const [fi, vertMap] of faceTrimInfo) {
    const face = faces[fi];
    const verts = face.vertices;
    const newVerts = [];

    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const vk = _edgeVKey(v);
      const entries = vertMap.get(vk);

      if (!entries || entries.length === 0) {
        // Vertex not involved in any edge — keep as-is
        newVerts.push(v);
      } else if (entries.length === 1) {
        // Vertex involved in exactly one edge — simple replacement
        newVerts.push({ ...entries[0].pos });
      } else {
        // Vertex shared by multiple edges on this face.
        // Insert replacement positions in face-winding order.
        // The vertex is endpoint B of the previous edge and endpoint A of the next.
        // We need: [p_b_of_prev_edge, p_a_of_next_edge]
        const prevIdx = (i - 1 + verts.length) % verts.length;
        const nextIdx = (i + 1) % verts.length;
        const prevVk = _edgeVKey(verts[prevIdx]);
        const nextVk = _edgeVKey(verts[nextIdx]);

        // Determine which entry connects to the previous vertex (role 'b' of that edge,
        // where edgeA matches prevVk) and which connects to the next (role 'a', edgeB matches nextVk)
        let firstPos = null, secondPos = null;

        for (const entry of entries) {
          const d = edgeDataList[entry.di];
          const otherA = _edgeVKey(d.edgeA);
          const otherB = _edgeVKey(d.edgeB);

          if (entry.role === 'b' && otherA === prevVk) {
            // This edge goes from prev vertex to current vertex — it should come first
            firstPos = entry.pos;
          } else if (entry.role === 'a' && otherB === nextVk) {
            // This edge goes from current vertex to next vertex — it should come second
            secondPos = entry.pos;
          } else if (entry.role === 'a' && otherB === prevVk) {
            firstPos = entry.pos;
          } else if (entry.role === 'b' && otherA === nextVk) {
            secondPos = entry.pos;
          }
        }

        if (firstPos && secondPos) {
          // Check if positions are essentially the same (avoid duplicate vertices)
          if (_edgeVKey(firstPos) === _edgeVKey(secondPos)) {
            newVerts.push({ ...firstPos });
          } else {
            newVerts.push({ ...firstPos });
            newVerts.push({ ...secondPos });
          }
        } else if (firstPos) {
          newVerts.push({ ...firstPos });
        } else if (secondPos) {
          newVerts.push({ ...secondPos });
        } else {
          // Fallback: use first entry's position
          newVerts.push({ ...entries[0].pos });
        }
      }
    }

    face.vertices = newVerts;
  }
}

/**
 * Batch-split vertices at all endpoints across all edges.
 * For vertices shared by multiple edges (internal path vertices), we use
 * the pre-computed replacement positions from the edge data rather than
 * the original single-edge _splitVertexAtEndpoint approach.
 */
function _batchSplitVertices(faces, edgeDataList, vertexEdgeMap) {
  // Collect all face indices that are directly involved in edges
  const edgeFaceIndices = new Set();
  for (const d of edgeDataList) {
    edgeFaceIndices.add(d.fi0);
    edgeFaceIndices.add(d.fi1);
  }

  // For each edge data, collect the endpoints that need splitting
  // in "other" faces (not face0 or face1 of that edge or any other edge)
  // Build a map: vertex key → { p0positions, p1positions } from all edges
  const vertexReplacements = new Map();
  for (const d of edgeDataList) {
    for (const [origVert, p0, p1] of [
      [d.edgeA, d.p0a, d.p1a],
      [d.edgeB, d.p0b, d.p1b],
    ]) {
      const vk = _edgeVKey(origVert);
      if (!vertexReplacements.has(vk)) {
        vertexReplacements.set(vk, { edges: [], fi0Set: new Set(), fi1Set: new Set() });
      }
      const entry = vertexReplacements.get(vk);
      entry.edges.push({ d, p0, p1 });
      entry.fi0Set.add(d.fi0);
      entry.fi1Set.add(d.fi1);
    }
  }

  // Extra faces generated when splitting creates non-planar polygons
  const extraFaces = [];

  // For each "other" face (not in any edge's face0/face1), determine
  // the correct replacement vertex at shared endpoints
  for (const [vk, entry] of vertexReplacements) {
    // Use the first edge's data for the actual split logic
    // (all edges meeting at this vertex should produce compatible offsets)
    const primary = entry.edges[0];

    for (let fi = 0; fi < faces.length; fi++) {
      if (entry.fi0Set.has(fi) || entry.fi1Set.has(fi)) continue;
      const face = faces[fi];
      // Skip existing fillet/corner faces from prior features - we'll clip them separately
      // in the fillet-fillet intersection handling instead of trying to split their vertices
      if (face.isFillet || face.isCorner) continue;
      const verts = face.vertices;

      let vidx = -1;
      for (let i = 0; i < verts.length; i++) {
        if (_edgeVKey(verts[i]) === vk) { vidx = i; break; }
      }
      if (vidx < 0) continue;

      const prevIdx = (vidx - 1 + verts.length) % verts.length;
      const nextIdx = (vidx + 1) % verts.length;
      const prevEdge = _edgeKeyFromVerts(verts[prevIdx], verts[vidx]);
      const nextEdge = _edgeKeyFromVerts(verts[vidx], verts[nextIdx]);

      // Check adjacency to ALL edges' face0Keys/face1Keys
      let touchesAnyF0 = false, touchesAnyF1 = false;
      let prevInAnyF0 = false, nextInAnyF0 = false;
      let firstP0 = primary.p0, firstP1 = primary.p1;

      for (const { d, p0, p1 } of entry.edges) {
        const prevInF0 = d.face0Keys.has(prevEdge);
        const prevInF1 = d.face1Keys.has(prevEdge);
        const nextInF0 = d.face0Keys.has(nextEdge);
        const nextInF1 = d.face1Keys.has(nextEdge);
        if (prevInF0 || nextInF0) { touchesAnyF0 = true; firstP0 = p0; }
        if (prevInF0) prevInAnyF0 = true;
        if (nextInF0) nextInAnyF0 = true;
        if (prevInF1 || nextInF1) { touchesAnyF1 = true; firstP1 = p1; }
      }

      let newPts;
      if (touchesAnyF0 && touchesAnyF1) {
        // Both face0 and face1 share edges with this face at the split vertex.
        // Inserting both offset positions can create a non-planar polygon when
        // the face (e.g. a bevel from a previous chamfer) isn't coplanar with
        // either face0 or face1.  Detect this and split into the original
        // planar face + a corner triangle to fill the gap.
        const ordered = prevInAnyF0
          ? [{ ...firstP0 }, { ...firstP1 }]
          : [{ ...firstP1 }, { ...firstP0 }];

        // Check planarity of both inserted points against the face's plane.
        const otherVerts = verts.filter((_, idx) => idx !== vidx);
        const firstOnPlane = _pointOnFacePlane(ordered[0], otherVerts);
        const secondOnPlane = _pointOnFacePlane(ordered[1], otherVerts);

        if (firstOnPlane && secondOnPlane) {
          newPts = ordered;
        } else if (firstOnPlane && !secondOnPlane) {
          // Second point off-plane: keep first, corner triangle toward next vertex.
          newPts = [ordered[0]];
          const triVerts = [{ ...ordered[0] }, { ...ordered[1] }, { ...verts[nextIdx] }];
          const triNormal = _vec3Normalize(_vec3Cross(
            _vec3Sub(triVerts[1], triVerts[0]),
            _vec3Sub(triVerts[2], triVerts[0])
          ));
          extraFaces.push({
            vertices: triVerts, normal: triNormal,
            shared: face.shared ? { ...face.shared } : null,
          });
        } else if (!firstOnPlane && secondOnPlane) {
          // First point off-plane: keep second, corner triangle toward prev vertex.
          newPts = [ordered[1]];
          const triVerts = [{ ...verts[prevIdx] }, { ...ordered[0] }, { ...ordered[1] }];
          const triNormal = _vec3Normalize(_vec3Cross(
            _vec3Sub(triVerts[1], triVerts[0]),
            _vec3Sub(triVerts[2], triVerts[0])
          ));
          extraFaces.push({
            vertices: triVerts, normal: triNormal,
            shared: face.shared ? { ...face.shared } : null,
          });
        } else {
          // Both off-plane — keep neither; generate two corner triangles.
          newPts = [];
          const tri1 = [{ ...verts[prevIdx] }, { ...ordered[0] }, { ...ordered[1] }];
          const tri2 = [{ ...ordered[0] }, { ...ordered[1] }, { ...verts[nextIdx] }];
          for (const triVerts of [tri1, tri2]) {
            const triNormal = _vec3Normalize(_vec3Cross(
              _vec3Sub(triVerts[1], triVerts[0]),
              _vec3Sub(triVerts[2], triVerts[0])
            ));
            extraFaces.push({
              vertices: triVerts, normal: triNormal,
              shared: face.shared ? { ...face.shared } : null,
            });
          }
        }
      } else if (touchesAnyF0) {
        // Faces that stay on the face0 side should receive a single trim point.
        // This is critical for segmented exact-boolean walls where a chamfered
        // path runs through multiple coplanar triangles: inserting both p0 and
        // p1 opens the wall and creates overlapping seam triangles.
        const fn = _vec3Normalize(face.normal);
        const n0 = _vec3Normalize(faces[primary.d.fi0].normal);
        const sameAsF0 = Math.abs(_vec3Dot(fn, n0)) > 0.999;
        if (face.isFillet || sameAsF0) {
          newPts = [{ ...firstP0 }];
        } else {
          newPts = nextInAnyF0
            ? [{ ...firstP1 }, { ...firstP0 }]
            : [{ ...firstP0 }, { ...firstP1 }];
        }
      } else if (touchesAnyF1) {
        newPts = [face.isFillet ? { ...firstP1 } : { ...firstP1 }];
      } else {
        // No direct edge connection — pick side by normal alignment
        const fn = _vec3Normalize(face.normal);
        const n0 = _vec3Normalize(faces[primary.d.fi0].normal);
        const n1 = _vec3Normalize(faces[primary.d.fi1].normal);
        const dot0 = Math.abs(_vec3Dot(fn, n0));
        const dot1 = Math.abs(_vec3Dot(fn, n1));
        newPts = [dot0 > dot1 ? { ...firstP0 } : { ...firstP1 }];
      }

      const newVerts = [];
      for (let i = 0; i < verts.length; i++) {
        if (i === vidx) {
          newVerts.push(...newPts);
        } else {
          newVerts.push(verts[i]);
        }
      }
      face.vertices = newVerts;
    }
  }

  // Append any corner triangles generated by non-planar splits
  if (extraFaces.length > 0) faces.push(...extraFaces);
}

/**
 * Generate corner (gap-filling) faces at shared vertices where 2+ edges meet.
 *
 * At each shared vertex, adjacent bevel/arc faces don't connect directly because
 * the offset directions differ between edges. This creates a single gap around the
 * vertex that needs one polygon to fill it.
 *
 * The corner polygon is constructed by walking around the vertex in two passes:
 * 1. p0 positions (face0 side) in reverse sorted order
 * 2. p1 positions (face1 side) in forward order, with "other vertices" between them
 */
function _generateCornerFaces(faces, origFaces, edgeDataList, vertexEdgeMap) {
  for (const [vk, edgeIndices] of vertexEdgeMap) {
    if (edgeIndices.length < 2) continue;

    // Collect edge info at this shared vertex
    const edgeInfos = [];
    for (const ei of edgeIndices) {
      const d = edgeDataList[ei];
      const isA = _edgeVKey(d.edgeA) === vk;
      edgeInfos.push({
        di: ei,
        data: d,
        isA,
        p0: isA ? d.p0a : d.p0b,
        p1: isA ? d.p1a : d.p1b,
        arc: d.arcA ? (isA ? d.arcA : d.arcB) : null,
      });
    }

    if (_isLinearEdgeContinuation(edgeInfos, origFaces)) continue;

    // Find "other vertex" for each edge (the vertex adjacent to vk in face1
    // that is NOT the other endpoint of the chamfered edge)
    for (const info of edgeInfos) {
      const d = info.data;
      const origFace1 = origFaces[d.fi1];
      const origVerts = origFace1.vertices;
      const otherEndVk = info.isA ? _edgeVKey(d.edgeB) : _edgeVKey(d.edgeA);
      info.otherVertex = null;
      for (let i = 0; i < origVerts.length; i++) {
        if (_edgeVKey(origVerts[i]) === vk) {
          const prevIdx = (i - 1 + origVerts.length) % origVerts.length;
          const nextIdx = (i + 1) % origVerts.length;
          const prevVk = _edgeVKey(origVerts[prevIdx]);
          const nextVk = _edgeVKey(origVerts[nextIdx]);
          if (nextVk !== otherEndVk && nextVk !== vk) {
            info.otherVertex = origVerts[nextIdx];
          } else if (prevVk !== otherEndVk && prevVk !== vk) {
            info.otherVertex = origVerts[prevIdx];
          }
          break;
        }
      }
    }

    // Sort edges around the vertex using face0 vertex ordering.
    // Use the shared vertex's position in the top face to determine the
    // correct angular order (handles wrap-around for circular faces).
    const fi0 = edgeInfos[0].data.fi0;
    const topFace = origFaces[fi0];
    const topVerts = topFace.vertices;

    // Find the shared vertex's index in the top face
    let sharedIdx = -1;
    for (let i = 0; i < topVerts.length; i++) {
      if (_edgeVKey(topVerts[i]) === vk) {
        sharedIdx = i;
        break;
      }
    }

    let allTopIndicesFound = true;
    for (const info of edgeInfos) {
      const d = info.data;
      const otherVk = info.isA ? _edgeVKey(d.edgeB) : _edgeVKey(d.edgeA);
      info.topIndex = -1;
      for (let i = 0; i < topVerts.length; i++) {
        if (_edgeVKey(topVerts[i]) === otherVk) {
          info.topIndex = i;
          break;
        }
      }
      // Compute relative position: distance going BACKWARD from sharedIdx
      // in the top face vertex list (matching the winding direction).
      // Edge connecting to the PREVIOUS vertex should sort first.
      if (sharedIdx >= 0 && info.topIndex >= 0) {
        info.sortKey = (sharedIdx - info.topIndex + topVerts.length) % topVerts.length;
      } else {
        allTopIndicesFound = false;
        info.sortKey = 0;
      }
    }

    // Fallback: when edges at this shared vertex have DIFFERENT face0s
    // (common after CSG boolean operations where large faces are triangulated),
    // the other endpoint may not be found in the first edge's face0.
    // Recompute sort keys using each edge's OWN face0 to determine whether
    // the shared vertex is the "incoming" end (endpoint B, isA=false) or
    // "outgoing" end (endpoint A, isA=true) of the edge in face0 winding.
    if (!allTopIndicesFound) {
      for (const info of edgeInfos) {
        if (info.topIndex >= 0) continue;

        const d = info.data;
        const otherVk = info.isA ? _edgeVKey(d.edgeB) : _edgeVKey(d.edgeA);
        const ownVerts = origFaces[d.fi0].vertices;

        let ownSharedIdx = -1;
        for (let i = 0; i < ownVerts.length; i++) {
          if (_edgeVKey(ownVerts[i]) === vk) { ownSharedIdx = i; break; }
        }

        if (ownSharedIdx >= 0) {
          const prevInOwn = (ownSharedIdx - 1 + ownVerts.length) % ownVerts.length;
          if (_edgeVKey(ownVerts[prevInOwn]) === otherVk) {
            // Other endpoint is the PREVIOUS vertex in face0 → incoming edge → sort first
            info.sortKey = 1;
          } else {
            // Other endpoint is the NEXT (or further) vertex → outgoing edge → sort last
            info.sortKey = Math.max(topVerts.length, edgeInfos.length + 1) - 1;
          }
        }
      }
    }

    edgeInfos.sort((a, b) => a.sortKey - b.sortKey);

    const shared = edgeInfos[0].data.shared;
    const hasFillet = edgeInfos.some(e => e.arc !== null);

    if (hasFillet) {
      // Fillet corner: generate triangle fan connecting arc arrays
      _generateFilletCorner(faces, edgeInfos, shared);
    } else {
      // Chamfer corner: build one polygon
      // Pass 1: p0 positions in reverse order (going backward around face0)
      const cornerVerts = [];
      for (let i = edgeInfos.length - 1; i >= 0; i--) {
        cornerVerts.push({ ...edgeInfos[i].p0 });
      }
      // Pass 2: p1 positions in forward order with other vertices between them
      for (let i = 0; i < edgeInfos.length; i++) {
        cornerVerts.push({ ...edgeInfos[i].p1 });
        if (i < edgeInfos.length - 1) {
          const curr = edgeInfos[i];
          const next = edgeInfos[i + 1];
          if (curr.otherVertex && next.otherVertex &&
              _edgeVKey(curr.otherVertex) === _edgeVKey(next.otherVertex)) {
            cornerVerts.push({ ...curr.otherVertex });
          }
        }
      }

      // Remove duplicate vertices (both consecutive and non-consecutive).
      // On curved surfaces, p1_curr and p1_next may be identical after rounding,
      // creating degenerate edges. Collapse such duplicates.
      const cleaned = _deduplicatePolygon(cornerVerts);
      if (cleaned.length < 3) continue;

      // Check if the corner polygon is redundant: when 3+ edges meet at a
      // vertex and their bevel faces already close the gap, all edges of the
      // corner polygon will already exist in exactly 2 faces.  Adding the
      // polygon would create non-manifold edges, so skip it.
      if (_isCornerRedundant(faces, cleaned)) continue;

      const cornerNormal = _vec3Normalize(_vec3Cross(
        _vec3Sub(cleaned[1], cleaned[0]),
        _vec3Sub(cleaned[cleaned.length - 1], cleaned[0])
      ));
      faces.push({ vertices: cleaned, normal: cornerNormal, shared });
    }
  }
}

// _sameNormalPair → delegates to toolkit/CoplanarUtils.js
const _sameNormalPair = _sameNormalPair_toolkit;

function _isLinearEdgeContinuation(edgeInfos, origFaces) {
  if (edgeInfos.length !== 2) return false;

  const d0 = edgeInfos[0].data;
  const d1 = edgeInfos[1].data;
  const n00 = origFaces[d0.fi0]?.normal;
  const n01 = origFaces[d0.fi1]?.normal;
  const n10 = origFaces[d1.fi0]?.normal;
  const n11 = origFaces[d1.fi1]?.normal;
  if (!n00 || !n01 || !n10 || !n11) return false;
  if (!_sameNormalPair(n00, n01, n10, n11)) return false;

  const other0 = edgeInfos[0].isA ? d0.edgeB : d0.edgeA;
  const other1 = edgeInfos[1].isA ? d1.edgeB : d1.edgeA;
  const shared = edgeInfos[0].isA ? d0.edgeA : d0.edgeB;
  const dir0 = _vec3Normalize(_vec3Sub(other0, shared));
  const dir1 = _vec3Normalize(_vec3Sub(other1, shared));
  return _vec3Dot(dir0, dir1) < -0.999;
}

function _isLinearFilletContinuation(edgeInfos, origFaces) {
  if (!edgeInfos[0].arc || !edgeInfos[1].arc) return false;
  return _isLinearEdgeContinuation(edgeInfos, origFaces);
}

/**
 * Check whether a corner polygon is redundant — all its edges already exist
 * in exactly 2 faces (meaning the gap is already closed by bevel/trimmed faces).
 * This happens when 3+ chamfered edges meet at a single vertex and their bevel
 * faces perfectly tile the corner without needing an extra polygon.
 */
function _isCornerRedundant(faces, cleanedVerts) {
  // Build edge count map for existing faces
  const edgeCounts = new Map();
  for (const face of faces) {
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const ek = _edgeKeyFromVerts(verts[i], verts[(i + 1) % verts.length]);
      edgeCounts.set(ek, (edgeCounts.get(ek) || 0) + 1);
    }
  }
  // Check if every edge of the corner polygon already has 2 faces
  for (let i = 0; i < cleanedVerts.length; i++) {
    const ek = _edgeKeyFromVerts(cleanedVerts[i], cleanedVerts[(i + 1) % cleanedVerts.length]);
    if ((edgeCounts.get(ek) || 0) < 2) return false;
  }
  return true;
}

/**
 * Remove duplicate vertices from a polygon (both consecutive and non-consecutive).
 * On curved surfaces like cylinders, offset positions at shared vertices may
 * coincide after rounding, creating degenerate edges. This function collapses
 * such duplicates by keeping only the first occurrence of each unique vertex key
 * and removing the "loop" between duplicates.
 */
function _deduplicatePolygon(verts) {
  if (!verts || verts.length === 0) return [];
  // First pass: remove consecutive duplicates
  const step1 = [verts[0]];
  for (let i = 1; i < verts.length; i++) {
    if (_edgeVKey(verts[i]) !== _edgeVKey(step1[step1.length - 1])) {
      step1.push(verts[i]);
    }
  }
  if (step1.length > 1 && _edgeVKey(step1[0]) === _edgeVKey(step1[step1.length - 1])) {
    step1.pop();
  }

  // Second pass: remove non-consecutive duplicates by keeping the SHORTEST path
  // between duplicate vertices (collapse the loop)
  const seen = new Map();
  const result = [];
  for (let i = 0; i < step1.length; i++) {
    const key = _edgeVKey(step1[i]);
    if (seen.has(key)) {
      // Found a duplicate — remove the vertices between the first occurrence
      // and this one (the loop), keeping the first occurrence
      const firstIdx = seen.get(key);
      // Remove everything from firstIdx+1 to result.length (the loop)
      result.length = firstIdx + 1;
      // Update seen map
      seen.clear();
      for (let j = 0; j < result.length; j++) {
        seen.set(_edgeVKey(result[j]), j);
      }
    } else {
      result.push(step1[i]);
      seen.set(key, result.length - 1);
    }
  }
  return result;
}

function _splicePolylineIntoFaceEdge(faces, polyline) {
  if (!polyline || polyline.length < 3) return false;

  const startKey = _edgeVKey(polyline[0]);
  const endKey = _edgeVKey(polyline[polyline.length - 1]);
  const interior = polyline.slice(1, -1);

  for (const face of faces) {
    if (!face || !face.vertices || face.vertices.length < 3) continue;
    if (face.isFillet || face.isCorner) continue;

    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const aKey = _edgeVKey(verts[i]);
      const bKey = _edgeVKey(verts[(i + 1) % verts.length]);
      if ((aKey !== startKey || bKey !== endKey) && (aKey !== endKey || bKey !== startKey)) {
        continue;
      }

      const insert = aKey === startKey ? interior : [...interior].reverse();
      const newVerts = [];
      for (let vi = 0; vi < verts.length; vi++) {
        newVerts.push({ ...verts[vi] });
        if (vi === i) {
          for (const pt of insert) newVerts.push({ ...pt });
        }
      }

      face.vertices = _deduplicatePolygon(newVerts);
      const newNormal = _computePolygonNormal(face.vertices);
      if (newNormal && _vec3Dot(newNormal, face.normal || newNormal) < 0) {
        face.vertices.reverse();
      }
      face.normal = _computePolygonNormal(face.vertices) || face.normal;
      return true;
    }
  }

  return false;
}

/**
 * Generate a spherical triangle patch for a trihedron corner where 3+ fillet
 * edges meet at a single vertex.  The 3 fillet arcs at the vertex form the
 * boundary of a spherical triangle on a common sphere.  This function fills
 * that triangle with a properly tessellated mesh, replacing the pairwise
 * approach which produces overlapping/incorrect faces at 3-edge corners.
 *
 * @returns {boolean} true if the corner was handled, false to fall back
 */
function _generateTrihedronCorner(faces, edgeInfos, shared) {
  if (edgeInfos.length < 3) return false;
  const segs = edgeInfos[0].arc ? edgeInfos[0].arc.length - 1 : 0;
  if (segs < 1) return false;

  // Step 1: Find the 3 unique arc endpoints (vertices of the spherical triangle).
  // Each fillet arc at the shared vertex has 2 endpoints (arc[0] on face0,
  // arc[segs] on face1).  At a trihedron corner each endpoint is shared by
  // exactly 2 arcs.
  const endpointMap = new Map();
  for (let i = 0; i < edgeInfos.length; i++) {
    const arc = edgeInfos[i].arc;
    if (!arc) continue;
    for (const idx of [0, segs]) {
      const vk = _edgeVKey(arc[idx]);
      if (!endpointMap.has(vk)) endpointMap.set(vk, []);
      endpointMap.get(vk).push({ ei: i, idx });
    }
  }

  const triVerts = [];
  for (const [vk, entries] of endpointMap) {
    if (entries.length >= 2) {
      triVerts.push({
        vk,
        pos: { ...edgeInfos[entries[0].ei].arc[entries[0].idx] },
        entries,
      });
    }
  }

  // Must have exactly 3 triangle vertices for a trihedron
  if (triVerts.length !== 3) return false;

  // Step 2: Find which arc connects each pair of vertices, oriented V[i]→V[j].
  function findArc(vi, vj) {
    for (const info of edgeInfos) {
      const arc = info.arc;
      if (!arc) continue;
      if (_edgeVKey(arc[0]) === vi.vk && _edgeVKey(arc[segs]) === vj.vk) return arc;
      if (_edgeVKey(arc[0]) === vj.vk && _edgeVKey(arc[segs]) === vi.vk) return [...arc].reverse();
    }
    return null;
  }

  // Compute the sphere center early so both the fill triangle and the grid
  // can use it to determine outward-facing winding.
  const midIdx = Math.max(1, Math.floor(segs / 2));
  const p3Arc = edgeInfos[0].arc[midIdx];
  const sphereCenter = _circumsphereCenter(triVerts[0].pos, triVerts[1].pos, triVerts[2].pos, p3Arc);
  const sphereRadius = sphereCenter ? _vec3Len(_vec3Sub(triVerts[0].pos, sphereCenter)) : 0;
  const useSphere = sphereCenter !== null && sphereRadius > 1e-10;

  // Ensure outward-facing normals: swap triVerts[0] and triVerts[1] if
  // the default grid winding produces inward normals.  For a visualization
  // mesh the correct face orientation (outward normals) takes priority over
  // strict manifold edge consistency at the fillet–trihedron boundary,
  // because the NURBS/BRep representation is the mathematically correct
  // one and the mesh is only for rendering.
  {
    const testArc = findArc(triVerts[0], triVerts[1]);
    const testLeft = findArc(triVerts[0], triVerts[2]);
    if (useSphere && testArc && testLeft && testArc.length >= 2 && testLeft.length >= 2) {
      const ga = testArc[0], gb = testArc[1], gc = testLeft[1];
      const testNormal = _vec3Cross(_vec3Sub(gb, ga), _vec3Sub(gc, ga));
      const outDir = _vec3Sub(ga, sphereCenter);
      if (_vec3Dot(testNormal, outDir) < 0) {
        const tmp = triVerts[0];
        triVerts[0] = triVerts[1];
        triVerts[1] = tmp;
      }
    }
  }

  // Bottom arc: V[0] → V[1] ;  Left arc: V[0] → V[2] ;  Right arc: V[1] → V[2]
  const arcBottom = findArc(triVerts[0], triVerts[1]);
  const arcLeft   = findArc(triVerts[0], triVerts[2]);
  const arcRight  = findArc(triVerts[1], triVerts[2]);
  if (!arcBottom || !arcLeft || !arcRight) return false;

  // The planar faces keep their straight chord trims from _batchTrimFaces.
  // The fillet strip + trihedron grid share the curved arc boundary.
  // A fill triangle bridges the gap between the straight chord and the arcs.

  // Step 3: Build the triangular grid.
  //   Row 0 (bottom):  segs+1 points from arcBottom (V[0] → V[1])
  //   Row r:           segs-r+1 points; left = arcLeft[r], right = arcRight[r]
  //   Row segs (top):  1 point = V[2]
  const grid = [];

  // Row 0: exact bottom boundary arc
  grid[0] = arcBottom.map(p => ({ ...p }));

  // Row segs: top vertex
  grid[segs] = [{ ...triVerts[2].pos }];

  // Intermediate rows
  for (let r = 1; r < segs; r++) {
    const left = arcLeft[r];
    const right = arcRight[r];
    const count = segs - r + 1;
    grid[r] = [];
    for (let j = 0; j < count; j++) {
      if (j === 0) {
        grid[r][j] = { ...left };
      } else if (j === count - 1) {
        grid[r][j] = { ...right };
      } else {
        const t = j / (count - 1);
        grid[r][j] = _vec3Lerp(left, right, t);
      }
    }
  }

  // Fair the interior toward a smooth ball-like blend and then project the
  // interior back onto the common sphere defined by the trim boundaries.
  // This preserves the round trihedron corner while the spliced boundary
  // arcs and later T-junction repair keep the topology closed.
  for (let iter = 0; iter < 4; iter++) {
    for (let r = 1; r < segs; r++) {
      const row = grid[r];
      for (let j = 1; j < row.length - 1; j++) {
        const neighbors = [row[j - 1], row[j + 1]];
        if (j < grid[r - 1].length) neighbors.push(grid[r - 1][j]);
        if (j + 1 < grid[r - 1].length) neighbors.push(grid[r - 1][j + 1]);
        if (j < grid[r + 1].length) neighbors.push(grid[r + 1][j]);
        if (j - 1 >= 0 && j - 1 < grid[r + 1].length) neighbors.push(grid[r + 1][j - 1]);
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (const pt of neighbors) {
          sx += pt.x;
          sy += pt.y;
          sz += pt.z;
        }
        let nextPt = { x: sx / neighbors.length, y: sy / neighbors.length, z: sz / neighbors.length };
        if (useSphere) {
          const dir = _vec3Sub(nextPt, sphereCenter);
          const len = _vec3Len(dir);
          if (len > 1e-10) {
            nextPt = _vec3Add(sphereCenter, _vec3Scale(dir, sphereRadius / len));
          }
        }
        row[j] = nextPt;
      }
    }
  }

  // Pre-compute shared metadata for emitted corner faces.
  const triVertPositions = [{ ...triVerts[0].pos }, { ...triVerts[1].pos }, { ...triVerts[2].pos }];

  // Determine correct winding by checking manifold consistency with adjacent
  // fillet strip faces.  The grid boundary edge grid[0][0]→grid[0][1] must
  // traverse in the OPPOSITE direction from the adjacent fillet quad's edge.
  const needFlip = _shouldFlipTrihedronWinding(faces, grid);

  // Emit the fill triangle that bridges the straight trim chords on the
  // planar faces to the curved trihedron boundary arcs.
  {
    const p0 = triVerts[0].pos, p1 = triVerts[1].pos, p2 = triVerts[2].pos;
    const fillVerts = needFlip
      ? [{ x: p0.x, y: p0.y, z: p0.z }, { x: p2.x, y: p2.y, z: p2.z }, { x: p1.x, y: p1.y, z: p1.z }]
      : [{ x: p0.x, y: p0.y, z: p0.z }, { x: p1.x, y: p1.y, z: p1.z }, { x: p2.x, y: p2.y, z: p2.z }];
    const n = _computePolygonNormal(fillVerts);
    if (n && _vec3Len(n) > 1e-10) {
      faces.push({
        vertices: fillVerts,
        normal: n,
        shared,
        isCorner: true,
        _sphereCenter: null,
        _sphereRadius: 0,
        _triVerts: triVertPositions,
      });
    }
  }

  // Step 4: Emit triangles from the grid.
  // Use needFlip to swap vertex order so boundary edges are manifold-
  // consistent with the adjacent fillet strip quads.
  for (let r = 0; r < segs; r++) {
    const currRow = grid[r];
    const nextRow = grid[r + 1];
    const currLen = currRow.length;
    const nextLen = nextRow.length;

    for (let j = 0; j < currLen - 1; j++) {
      // "Down" triangle: currRow[j], currRow[j+1], nextRow[j]
      const a = currRow[j], b = currRow[j + 1], c = nextRow[j];
      const tri1 = needFlip
        ? [{ ...a }, { ...c }, { ...b }]
        : [{ ...a }, { ...b }, { ...c }];
      const n1 = _vec3Normalize(_vec3Cross(
        _vec3Sub(tri1[1], tri1[0]), _vec3Sub(tri1[2], tri1[0])
      ));
      if (_vec3Len(n1) > 1e-10) {
        faces.push({ vertices: tri1, normal: n1, shared, isCorner: true,
          _sphereCenter: useSphere ? sphereCenter : null, _sphereRadius: sphereRadius,
          _triVerts: triVertPositions });
      }

      // "Up" triangle: currRow[j+1], nextRow[j+1], nextRow[j]
      if (j < nextLen - 1) {
        const d = currRow[j + 1], e = nextRow[j + 1], f = nextRow[j];
        const tri2 = needFlip
          ? [{ ...d }, { ...f }, { ...e }]
          : [{ ...d }, { ...e }, { ...f }];
        const n2 = _vec3Normalize(_vec3Cross(
          _vec3Sub(tri2[1], tri2[0]), _vec3Sub(tri2[2], tri2[0])
        ));
        if (_vec3Len(n2) > 1e-10) {
          faces.push({ vertices: tri2, normal: n2, shared, isCorner: true,
            _sphereCenter: useSphere ? sphereCenter : null, _sphereRadius: sphereRadius,
            _triVerts: triVertPositions });
        }
      }
    }
  }

  return true;
}

/**
 * Determine whether the trihedron corner grid needs its winding flipped.
 * Checks if the first boundary edge of the grid (row 0, columns 0→1)
 * is traversed in the same direction by an adjacent fillet strip face.
 * If so, the trihedron must flip to maintain manifold consistency.
 */
function _shouldFlipTrihedronWinding(faces, grid) {
  if (!grid[0] || grid[0].length < 2) return false;
  const k0 = _edgeVKey(grid[0][0]);
  const k1 = _edgeVKey(grid[0][1]);

  for (let fi = 0; fi < faces.length; fi++) {
    if (!faces[fi].isFillet) continue;
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const va = verts[i], vb = verts[(i + 1) % verts.length];
      const ka = _edgeVKey(va), kb = _edgeVKey(vb);
      if (ka === k0 && kb === k1) return true;   // same direction → flip
      if (ka === k1 && kb === k0) return false;  // opposite → no flip
    }
  }

  // Fallback: try any face (not just fillet) sharing this edge
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const va = verts[i], vb = verts[(i + 1) % verts.length];
      const ka = _edgeVKey(va), kb = _edgeVKey(vb);
      if (ka === k0 && kb === k1) return true;
      if (ka === k1 && kb === k0) return false;
    }
  }
  return false;
}

function _emitTwoEdgeFilletCornerPatch(faces, arcLeft, arcRight, shared, trimCurve = null) {
  if (!arcLeft || !arcRight || arcLeft.length !== arcRight.length || arcLeft.length < 2) {
    return;
  }

  const segs = arcLeft.length - 1;
  const top0 = arcLeft[0];
  const top1 = arcRight[0];
  const apex = arcLeft[segs];
  const topMid = trimCurve && trimCurve.length > 0 ? trimCurve[0] : _vec3Lerp(top0, top1, 0.5);
  const topBoundary = _edgeVKey(topMid) === _edgeVKey(top0) || _edgeVKey(topMid) === _edgeVKey(top1)
    ? [{ ...top0 }, { ...top1 }]
    : [{ ...top0 }, { ...topMid }, { ...top1 }];
  const topRow = _samplePolyline(topBoundary, segs);
  _splicePolylineIntoFaceEdge(faces, topBoundary);

  const grid = [topRow];
  for (let r = 1; r < segs; r++) {
    const left = arcLeft[r];
    const right = arcRight[r];
    const count = segs - r + 1;
    const row = [];
    for (let j = 0; j < count; j++) {
      row.push(_vec3Lerp(left, right, j / (count - 1 || 1)));
    }
    grid.push(row);
  }
  grid.push([{ ...apex }]);

  for (let iter = 0; iter < 3; iter++) {
    for (let r = 1; r < grid.length - 1; r++) {
      for (let j = 1; j < grid[r].length - 1; j++) {
        const neighbors = [];
        neighbors.push(grid[r][j - 1], grid[r][j + 1]);
        if (j < grid[r - 1].length) neighbors.push(grid[r - 1][j]);
        if (j + 1 < grid[r - 1].length) neighbors.push(grid[r - 1][j + 1]);
        if (j < grid[r + 1].length) neighbors.push(grid[r + 1][j]);
        if (j - 1 >= 0 && j - 1 < grid[r + 1].length) neighbors.push(grid[r + 1][j - 1]);
        if (neighbors.length === 0) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (const pt of neighbors) {
          sx += pt.x;
          sy += pt.y;
          sz += pt.z;
        }
        grid[r][j] = { x: sx / neighbors.length, y: sy / neighbors.length, z: sz / neighbors.length };
      }
    }
  }

  const flip = _shouldFlipTrihedronWinding(faces, [topRow]);
  const midRow = grid[Math.floor(segs / 2)] || grid[0];
  const midPoint = midRow[Math.floor((midRow.length - 1) / 2)] || _vec3Lerp(top0, apex, 0.5);
  const cornerPatch = {
    top0: { ...top0 },
    top1: { ...top1 },
    topMid: { ...topMid },
    side0Mid: { ...arcLeft[Math.floor(segs / 2)] },
    side1Mid: { ...arcRight[Math.floor(segs / 2)] },
    apex: { ...apex },
    centerPoint: { ...midPoint },
  };
  const patchKey = [
    _edgeVKey(cornerPatch.top0),
    _edgeVKey(cornerPatch.top1),
    _edgeVKey(cornerPatch.apex),
  ].join('|');

  for (let r = 0; r < segs; r++) {
    const currRow = grid[r];
    const nextRow = grid[r + 1];
    const currLen = currRow.length;
    const nextLen = nextRow.length;

    for (let j = 0; j < currLen - 1; j++) {
      const down = flip
        ? [{ ...currRow[j] }, { ...nextRow[j] }, { ...currRow[j + 1] }]
        : [{ ...currRow[j] }, { ...currRow[j + 1] }, { ...nextRow[j] }];
      const downNormal = _vec3Normalize(_vec3Cross(
        _vec3Sub(down[1], down[0]), _vec3Sub(down[2], down[0])
      ));
      if (_vec3Len(downNormal) > 1e-10) {
        faces.push({
          vertices: down,
          normal: downNormal,
          shared,
          isFillet: true,
          isCorner: true,
          _cornerPatch: cornerPatch,
          _cornerPatchKey: patchKey,
        });
      }

      if (j < nextLen - 1) {
        const up = flip
          ? [{ ...currRow[j + 1] }, { ...nextRow[j] }, { ...nextRow[j + 1] }]
          : [{ ...currRow[j + 1] }, { ...nextRow[j + 1] }, { ...nextRow[j] }];
        const upNormal = _vec3Normalize(_vec3Cross(
          _vec3Sub(up[1], up[0]), _vec3Sub(up[2], up[0])
        ));
        if (_vec3Len(upNormal) > 1e-10) {
          faces.push({
            vertices: up,
            normal: upNormal,
            shared,
            isFillet: true,
            isCorner: true,
            _cornerPatch: cornerPatch,
            _cornerPatchKey: patchKey,
          });
        }
      }
    }
  }
}

/**
 * Generate fillet corner faces at a shared vertex using triangle fans.
 * The boundary of the gap consists of:
 * 1. Top face edge: arcB_(i-1)[0] → arcA_i[0]
 * 2. Arc from edge i going backward: arcA_i[0] → arcA_i[seg] (face1 side)
 * 3. Gap through other vertex: arcA_i[seg] → vi_bot → arcB_(i-1)[seg]
 * 4. Arc from edge (i-1) going forward: arcB_(i-1)[seg] → arcB_(i-1)[0] (face0 side)
 *
 * The polygon must traverse these in opposite direction to adjacent faces.
 */
function _generateFilletCorner(faces, edgeInfos, shared) {
  // For 3+ edges forming a closed trihedron, use a proper spherical triangle
  // patch instead of the pairwise approach which creates overlapping faces.
  if (edgeInfos.length >= 3 && _generateTrihedronCorner(faces, edgeInfos, shared)) {
    return;
  }

  // Handle pairs of adjacent edges around the vertex.
  // For M edges, process each consecutive pair (i, i+1).
  // For M=2 this produces a single corner patch; for M>=3 it produces one
  // patch per pair (some may be redundant and will be skipped).
  for (let ei = 0; ei < edgeInfos.length; ei++) {
    const curr = edgeInfos[ei];
    const next = edgeInfos[(ei + 1) % edgeInfos.length];
    const arcCurr = curr.arc;
    const arcNext = next.arc;

    if (!arcCurr || !arcNext) continue;

    const segs = arcCurr.length - 1;

    const lastCurr = arcCurr[segs];
    const lastNext = arcNext[segs];
    const arcsMeet = _edgeVKey(lastCurr) === _edgeVKey(lastNext);

    if (arcsMeet && segs > 1) {
      const trimNext = next.isA ? next.data.sharedTrimA : next.data.sharedTrimB;
      const trimCurr = curr.isA ? curr.data.sharedTrimA : curr.data.sharedTrimB;
      if (edgeInfos.length === 2 && trimNext && trimCurr && trimNext.length === trimCurr.length) {
        break;
      }
      const trimCurve = trimNext && trimCurr && trimNext.length === trimCurr.length ? trimNext : null;
      _emitTwoEdgeFilletCornerPatch(faces, arcNext, arcCurr, shared, trimCurve);
    } else {
      // Fallback: polygon fan approach for non-meeting arcs
      const cornerVerts = [];
      cornerVerts.push({ ...arcNext[0] });
      cornerVerts.push({ ...arcCurr[0] });
      for (let s = 1; s <= segs; s++) {
        cornerVerts.push({ ...arcCurr[s] });
      }
      if (!arcsMeet && curr.otherVertex) {
        cornerVerts.push({ ...curr.otherVertex });
      }
      const startS = arcsMeet ? segs - 1 : segs;
      for (let s = startS; s >= 1; s--) {
        cornerVerts.push({ ...arcNext[s] });
      }
      const cleaned = [cornerVerts[0]];
      for (let i = 1; i < cornerVerts.length; i++) {
        if (_edgeVKey(cornerVerts[i]) !== _edgeVKey(cleaned[cleaned.length - 1])) {
          cleaned.push(cornerVerts[i]);
        }
      }
      if (cleaned.length > 1 && _edgeVKey(cleaned[0]) === _edgeVKey(cleaned[cleaned.length - 1])) {
        cleaned.pop();
      }
      if (cleaned.length < 3) { if (edgeInfos.length === 2) break; continue; }
      if (_isCornerRedundant(faces, cleaned)) { if (edgeInfos.length === 2) break; continue; }
      for (let i = 1; i < cleaned.length - 1; i++) {
        const triNormal = _vec3Normalize(_vec3Cross(
          _vec3Sub(cleaned[i], cleaned[0]),
          _vec3Sub(cleaned[i + 1], cleaned[0])
        ));
        if (_vec3Len(triNormal) > 1e-10) {
          faces.push({
            vertices: [{ ...cleaned[0] }, { ...cleaned[i] }, { ...cleaned[i + 1] }],
            normal: triNormal, shared,
          });
        }
      }
    }

    // For M=2 edges, only one patch needed (don't wrap around)
    if (edgeInfos.length === 2) break;
  }
}


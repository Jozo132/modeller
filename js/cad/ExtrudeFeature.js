// js/cad/ExtrudeFeature.js — Extrude operation feature
// Extrudes a 2D sketch profile to create a 3D solid.
//
// Now produces exact B-Rep topology alongside the tessellated mesh,
// enabling STEP-quality export and exact boolean operations.

import { Feature } from './Feature.js';
import { booleanOp } from './BooleanDispatch.js';
import { computeFeatureEdges } from './EdgeAnalysis.js';
import { calculateMeshVolume, calculateBoundingBox } from './toolkit/MeshAnalysis.js';
import { constrainedTriangulate } from './Tessellator2/CDT.js';
import { tessellateBody } from './Tessellation.js';
import { chainEdgePaths } from './toolkit/EdgePathUtils.js';
import { tryBuildNativeExtrude } from './wasm/NativeExtrude.js';
import { NurbsCurve } from './NurbsCurve.js';
import { NurbsSurface } from './NurbsSurface.js';
import {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody, deriveEdgeAndVertexHashes,
} from './BRepTopology.js';

/** Monotonically increasing ID for fused half-cylinder face groups. */
let _nextFusedId = 1;

/**
 * ExtrudeFeature extrudes a 2D sketch profile along its normal to create 3D geometry.
 */
export class ExtrudeFeature extends Feature {
  constructor(name = 'Extrude', sketchFeatureId = null, distance = 10) {
    super(name);
    this.type = 'extrude';
    
    // Reference to the sketch feature to extrude
    this.sketchFeatureId = sketchFeatureId;
    if (sketchFeatureId) {
      this.addDependency(sketchFeatureId);
    }
    
    // Extrusion parameters
    this.distance = distance;
    this.direction = 1; // 1 = normal direction, -1 = reverse
    this.symmetric = false; // If true, extrude in both directions
    this.extrudeType = 'distance'; // 'distance' | 'throughAll' | 'upToFace'
    this.taper = false;
    this.taperAngle = 5; // degrees
    this.taperInward = true; // true = inward taper, false = outward
    
    // Operation mode
    this.operation = 'new'; // 'new', 'add', 'subtract', 'intersect'
  }

  /**
   * Execute the extrude operation.
   * @param {Object} context - Execution context with previous results
   * @returns {Object} Result with 3D geometry
   */
  execute(context) {
    // Get the sketch feature result
    const sketchResult = context.results[this.sketchFeatureId];
    if (!sketchResult || sketchResult.error) {
      throw new Error('Sketch feature not found or has errors');
    }
    
    if (sketchResult.type !== 'sketch') {
      throw new Error('Referenced feature is not a sketch');
    }
    
    const { plane, profiles } = sketchResult;
    
    if (profiles.length === 0) {
      throw new Error('No closed profiles found in sketch');
    }
    
    // Get the current solid (if any)
    let solid = this.getPreviousSolid(context);

    const profileGroups = this.groupProfilesForExtrusion(profiles);

    const profileGeometries = profileGroups.map((group) =>
      this.generateGeometry([group.outer], plane, group.holes));

    if (solid && this.operation === 'subtract') {
      const directCut = this._tryApplyPlanarThroughCut(solid, profileGroups, plane);
      if (directCut) {
        solid = directCut;
        const finalGeometry = solid.geometry;
        return {
          type: 'solid',
          geometry: finalGeometry,
          solid,
          volume: this.calculateVolume(finalGeometry),
          boundingBox: this.calculateBoundingBox(finalGeometry),
        };
      }
    }

    // When adding/subtracting/intersecting against an existing solid, combine
    // all bodies from this feature first and run a single boolean. Sequential
    // unions on the same support face can trigger BSP coplanar clipping issues.
    if (solid && profileGeometries.length > 1) {
      const featureGeometry = this.combineGeometries(profileGeometries);
      solid = this.applyOperation(solid, featureGeometry);
    } else {
      // Generate geometry per-profile and apply each body individually.
      // This preserves support for disconnected new bodies when no prior solid
      // exists yet in the feature tree.
      for (let pi = 0; pi < profileGeometries.length; pi++) {
        const bodyGeom = profileGeometries[pi];
        if (pi === 0) {
          // First profile: use the feature's configured operation
          solid = this.applyOperation(solid, bodyGeom);
        } else {
          // Subsequent profiles: always union into the accumulating solid
          // so all bodies from the same sketch end up in one solid
          solid = this._unionBody(solid, bodyGeom);
        }
      }
    }

    // Use the result geometry
    const finalGeometry = solid.geometry;

    return {
      type: 'solid',
      geometry: finalGeometry,
      solid,
      volume: this.calculateVolume(finalGeometry),
      boundingBox: this.calculateBoundingBox(finalGeometry),
    };
  }

  /**
   * Group extracted sketch profiles into independent extrusion regions.
   * Outer/island profiles become bodies; odd-depth profiles become cap holes
   * attached to their direct parent.
   * @param {Array<Object>} profiles
   * @returns {Array<{outer: Object, holes: Object[]}>}
   */
  groupProfilesForExtrusion(profiles) {
    const groups = [];
    if (!Array.isArray(profiles)) return groups;
    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      if (!profile || profile.isHole) continue;
      const group = { outer: profile, holes: [] };
      for (const hi of profile.holes || []) {
        const hole = profiles[hi];
        if (hole) group.holes.push(hole);
      }
      groups.push(group);
    }
    return groups;
  }

  /**
   * Union a new body into an existing solid (used for multi-profile merging).
   */
  _unionBody(solid, geometry) {
    if (!solid || !solid.geometry) {
      if (geometry && geometry.faces) {
        for (const f of geometry.faces) {
          if (!f.shared) f.shared = { sourceFeatureId: this.id };
        }
        const edgeResult = computeFeatureEdges(geometry.faces);
        geometry.edges = geometry.nativeExtrude
          ? _augmentNativeCurvedSelectableEdges(edgeResult.edges, geometry.faces)
          : edgeResult.edges;
        geometry.paths = geometry.nativeExtrude ? chainEdgePaths(geometry.edges) : edgeResult.paths;
        geometry.visualEdges = edgeResult.visualEdges;
      }
      return { geometry };
    }
    if (this.operation === 'new') {
      return this._appendBodyGeometry(solid, geometry);
    }
    try {
      const resultGeom = booleanOp(solid.geometry, geometry, 'union',
        null, { sourceFeatureId: this.id });
      return { geometry: resultGeom };
    } catch (err) {
      console.warn('Multi-profile union failed:', err.message);
      if (this.operation === 'new') {
        return this._appendBodyGeometry(solid, geometry);
      }
      return solid;
    }
  }

  _appendBodyGeometry(solid, geometry) {
    if (!solid?.geometry) return { geometry };
    if (!geometry) return solid;

    const combined = {
      ...solid.geometry,
      vertices: [
        ...(solid.geometry.vertices || []),
        ...(geometry.vertices || []),
      ],
      faces: [
        ...(solid.geometry.faces || []),
        ...(geometry.faces || []),
      ],
    };

    if (solid.geometry.topoBody && geometry.topoBody) {
      const topoBody = TopoBody.deserialize(solid.geometry.topoBody.serialize());
      const appendedBody = TopoBody.deserialize(geometry.topoBody.serialize());
      for (const shell of appendedBody.shells || []) topoBody.addShell(shell);
      deriveEdgeAndVertexHashes(topoBody);
      combined.topoBody = topoBody;
    } else {
      combined.topoBody = solid.geometry.topoBody || geometry.topoBody || null;
    }

    for (const face of combined.faces) {
      if (!face.shared) face.shared = { sourceFeatureId: this.id };
    }
    const edgeResult = computeFeatureEdges(combined.faces);
    const hasNativeCurves = combined.nativeExtrude || geometry.nativeExtrude || solid.geometry.nativeExtrude;
    combined.edges = hasNativeCurves
      ? _augmentNativeCurvedSelectableEdges(edgeResult.edges, combined.faces)
      : edgeResult.edges;
    combined.paths = hasNativeCurves
      ? chainEdgePaths(combined.edges)
      : edgeResult.paths;
    combined.visualEdges = edgeResult.visualEdges;
    delete combined.nativeExtrude;
    return { geometry: combined };
  }

  /**
   * Combine multiple generated profile bodies into a single geometry.
   * @param {Array<Object>} geometries - Array of geometry objects
   * @returns {Object} Combined geometry
   */
  combineGeometries(geometries) {
    let combined = null;

    for (const geometry of geometries) {
      if (!geometry) continue;
      if (!combined) {
        combined = geometry;
        continue;
      }
      combined = booleanOp(combined, geometry, 'union',
        combined.faces?.[0]?.shared || null,
        { sourceFeatureId: this.id });
    }

    if (!combined) {
      return {
        vertices: [],
        faces: [],
        edges: [],
      };
    }

    return combined;
  }

  _tryApplyPlanarThroughCut(solid, profileGroups, plane) {
    if (!Array.isArray(profileGroups) || profileGroups.length < 2) return null;
    if (this.symmetric || this.taper || this.extrudeType !== 'distance') return null;
    const sourceBody = solid?.geometry?.topoBody;
    if (!sourceBody || !sourceBody.shells || sourceBody.shells.length === 0) return null;

    try {
      const planeFrame = this.resolvePlaneFrame(plane);
      const resolvedPlane = planeFrame.plane;
      const extrusionVector = {
        x: resolvedPlane.normal.x * this.distance * this.direction,
        y: resolvedPlane.normal.y * this.distance * this.direction,
        z: resolvedPlane.normal.z * this.distance * this.direction,
      };
      const endPoint = {
        x: resolvedPlane.origin.x + extrusionVector.x,
        y: resolvedPlane.origin.y + extrusionVector.y,
        z: resolvedPlane.origin.z + extrusionVector.z,
      };

      const resultBody = TopoBody.deserialize(sourceBody.serialize());
      const shell = resultBody.outerShell();
      if (!shell) return null;

      const entryFace = this._findPlanarFaceAtPoint(resultBody, resolvedPlane.origin, resolvedPlane.normal);
      const exitFace = this._findPlanarFaceAtPoint(resultBody, endPoint, resolvedPlane.normal);
      if (!entryFace || !exitFace || entryFace === exitFace) return null;

      for (const group of profileGroups) {
        const toolBody = this.buildExactBrep(
          [group.outer],
          resolvedPlane,
          extrusionVector,
          planeFrame,
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 0 },
          group.holes,
        );
        const toolFaces = toolBody.faces();
        const entryCap = toolFaces.find(face => face.stableHash?.includes('_Face_Bottom_'));
        const exitCap = toolFaces.find(face => face.stableHash?.includes('_Face_Top_'));
        if (!entryCap?.outerLoop || !exitCap?.outerLoop) return null;

        this._orientLoopAsInner(entryFace, entryCap.outerLoop);
        this._orientLoopAsInner(exitFace, exitCap.outerLoop);
        entryFace.addInnerLoop(entryCap.outerLoop);
        exitFace.addInnerLoop(exitCap.outerLoop);

        for (const sideFace of toolFaces) {
          if (sideFace === entryCap || sideFace === exitCap) continue;
          this._flipFaceOrientation(sideFace);
          sideFace.shared = { sourceFeatureId: this.id };
          if (sideFace.stableHash) sideFace.stableHash = `${this.id}_Cut_${sideFace.stableHash}`;
          shell.addFace(sideFace);
        }
      }

      return this._solidFromTopoBody(resultBody);
    } catch (_) {
      return null;
    }
  }

  _solidFromTopoBody(topoBody) {
    const mesh = tessellateBody(topoBody, { validate: false });
    const edgeResult = computeFeatureEdges(mesh.faces || []);
    return {
      geometry: {
        ...mesh,
        edges: edgeResult.edges,
        paths: edgeResult.paths,
        visualEdges: edgeResult.visualEdges,
        topoBody,
      },
    };
  }

  _findPlanarFaceAtPoint(body, point, normal) {
    const candidates = [];
    const targetNormal = _normalize(normal);
    for (const face of body.faces()) {
      if (face.surfaceType !== SurfaceType.PLANE || !face.outerLoop) continue;
      const points = face.outerLoop.points();
      if (points.length < 3) continue;
      const faceNormal = this._faceLoopNormal(face);
      if (!faceNormal) continue;
      if (Math.abs(_dot(faceNormal, targetNormal)) < 0.999) continue;
      const distance = Math.abs(_dot(faceNormal, _sub(point, points[0])));
      if (distance > 1e-4) continue;
      candidates.push({ face, distance, area: this._loopArea(points, faceNormal) });
    }
    candidates.sort((a, b) => a.distance - b.distance || b.area - a.area);
    return candidates[0]?.face || null;
  }

  _orientLoopAsInner(face, loop) {
    const outerNormal = this._faceLoopNormal(face);
    const loopNormal = this._polygonNormal(loop.points());
    if (!outerNormal || !loopNormal) return;
    if (_dot(outerNormal, loopNormal) > 0) this._reverseLoop(loop);
  }

  _flipFaceOrientation(face) {
    face.sameSense = !face.sameSense;
    for (const loop of face.allLoops()) this._reverseLoop(loop);
  }

  _reverseLoop(loop) {
    loop.coedges.reverse();
    for (const coedge of loop.coedges) coedge.sameSense = !coedge.sameSense;
  }

  _faceLoopNormal(face) {
    const normal = this._polygonNormal(face.outerLoop?.points() || []);
    if (!normal) return null;
    return face.sameSense === false
      ? { x: -normal.x, y: -normal.y, z: -normal.z }
      : normal;
  }

  _polygonNormal(points) {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      nx += (a.y - b.y) * (a.z + b.z);
      ny += (a.z - b.z) * (a.x + b.x);
      nz += (a.x - b.x) * (a.y + b.y);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len <= 1e-10) return null;
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  _loopArea(points, normal) {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      area += _dot(_cross(a, b), normal);
    }
    return Math.abs(area) * 0.5;
  }

  /**
   * Generate 3D geometry from sketch profiles.
   * @param {Array} profiles - Sketch profiles to extrude (outer boundaries)
   * @param {Object} plane - Sketch plane definition
   * @param {Array} [holes] - Hole profiles to subtract from the extrusion
   * @returns {Object} 3D geometry data
   */
  generateGeometry(profiles, plane, holes = [], options = {}) {
    const planeFrame = this.resolvePlaneFrame(plane);
    const resolvedPlane = planeFrame.plane;
    const geometry = {
      vertices: [],
      faces: [],
      edges: [],
    };
    
    const effectiveDistance = this.extrudeType === 'throughAll' ? 1000 : this.distance;
    const shouldOvershootForSubtract = this.operation === 'subtract';
    const overshoot = shouldOvershootForSubtract ? Math.max(1e-4, effectiveDistance * 1e-5) : 0;
    const directionUnit = {
      x: resolvedPlane.normal.x * this.direction,
      y: resolvedPlane.normal.y * this.direction,
      z: resolvedPlane.normal.z * this.direction,
    };
    const baseOffset = shouldOvershootForSubtract ? {
      x: -directionUnit.x * overshoot,
      y: -directionUnit.y * overshoot,
      z: -directionUnit.z * overshoot,
    } : { x: 0, y: 0, z: 0 };
    const tipOffset = shouldOvershootForSubtract ? {
      x: directionUnit.x * overshoot,
      y: directionUnit.y * overshoot,
      z: directionUnit.z * overshoot,
    } : { x: 0, y: 0, z: 0 };

    // Calculate extrusion vector
    const extrusionVector = {
      x: resolvedPlane.normal.x * effectiveDistance * this.direction,
      y: resolvedPlane.normal.y * effectiveDistance * this.direction,
      z: resolvedPlane.normal.z * effectiveDistance * this.direction,
    };

    // Taper: compute per-vertex shrink/grow at top face
    const useTaper = this.taper && this.taperAngle > 0 && this.taperAngle < 89;
    const taperOffset = useTaper
      ? effectiveDistance * Math.tan(this.taperAngle * Math.PI / 180) * (this.taperInward ? -1 : 1)
      : 0;
    
    // For each profile, create top and bottom faces and side faces
    for (const profile of profiles) {
      // Ensure profile winding is CCW (positive signed area) so that
      // extrusion normals point outward.
      let pts = profile.points.map((point) => planeFrame.toPlanePoint(point));
      let signedArea = 0;
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        signedArea += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
      }
      if (signedArea < 0) {
        pts = [...pts].reverse();
      }

      // Compute 2D centroid for taper scaling
      let cx2 = 0, cy2 = 0;
      if (useTaper) {
        for (const p of pts) { cx2 += p.x; cy2 += p.y; }
        cx2 /= pts.length; cy2 /= pts.length;
      }

      const bottomVertices = [];
      const topVertices = [];
      
      // Create vertices
      for (const point of pts) {
        // Transform 2D sketch point to 3D world coordinates
        const bottomBase = this.sketchToWorld(point, resolvedPlane);
        const bottom3D = {
          x: bottomBase.x + baseOffset.x,
          y: bottomBase.y + baseOffset.y,
          z: bottomBase.z + baseOffset.z,
        };
        bottomVertices.push(bottom3D);
        geometry.vertices.push(bottom3D);
        
        // Create top vertex (with taper offset if enabled)
        let topPoint = point;
        if (useTaper) {
          const dx = point.x - cx2, dy = point.y - cy2;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 1e-10) {
            const scale = taperOffset / dist;
            topPoint = { x: point.x + dx * scale, y: point.y + dy * scale };
          } else {
            topPoint = { x: point.x, y: point.y };
          }
        }
        const topBase = this.sketchToWorld(topPoint, resolvedPlane);
        const top3D = {
          x: topBase.x + extrusionVector.x + tipOffset.x,
          y: topBase.y + extrusionVector.y + tipOffset.y,
          z: topBase.z + extrusionVector.z + tipOffset.z,
        };
        topVertices.push(top3D);
        geometry.vertices.push(top3D);
      }
      
      // Create side faces for outer boundary
      for (let i = 0; i < pts.length; i++) {
        const nextI = (i + 1) % pts.length;
        const face = {
          vertices: [
            bottomVertices[i],
            bottomVertices[nextI],
            topVertices[nextI],
            topVertices[i],
          ],
        };
        face.normal = this.calculateFaceNormal(face.vertices);
        geometry.faces.push(face);
      }

      // Build cap faces — with or without holes
      if (holes && holes.length > 0) {
        // Generate hole vertices and side walls
        const holeVertArrays = []; // { pts2D, bottomVerts, topVerts }
        for (const hole of holes) {
          let hPts = hole.points.map(p => planeFrame.toPlanePoint(p));
          // Ensure CW winding for holes (negative signed area)
          let hArea = 0;
          for (let i = 0; i < hPts.length; i++) {
            const j = (i + 1) % hPts.length;
            hArea += hPts[i].x * hPts[j].y - hPts[j].x * hPts[i].y;
          }
          if (hArea > 0) hPts = [...hPts].reverse();

          const hBottom = [], hTop = [];
          for (const hp of hPts) {
            const hb = this.sketchToWorld(hp, resolvedPlane);
            const hb3 = {
              x: hb.x + baseOffset.x,
              y: hb.y + baseOffset.y,
              z: hb.z + baseOffset.z,
            };
            hBottom.push(hb3);
            geometry.vertices.push(hb3);

            let htPoint = hp;
            if (useTaper) {
              const dx = hp.x - cx2, dy = hp.y - cy2;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist > 1e-10) {
                const scale = taperOffset / dist;
                htPoint = { x: hp.x + dx * scale, y: hp.y + dy * scale };
              }
            }
            const ht = this.sketchToWorld(htPoint, resolvedPlane);
            const ht3 = {
              x: ht.x + extrusionVector.x + tipOffset.x,
              y: ht.y + extrusionVector.y + tipOffset.y,
              z: ht.z + extrusionVector.z + tipOffset.z,
            };
            hTop.push(ht3);
            geometry.vertices.push(ht3);
          }
          holeVertArrays.push({ pts2D: hPts, bottomVerts: hBottom, topVerts: hTop });

          // Hole side walls — CW boundary with standard quad winding gives inward normals
          for (let i = 0; i < hBottom.length; i++) {
            const nextI = (i + 1) % hBottom.length;
            const hFace = {
              vertices: [
                hBottom[i],
                hBottom[nextI],
                hTop[nextI],
                hTop[i],
              ],
            };
            hFace.normal = this.calculateFaceNormal(hFace.vertices);
            geometry.faces.push(hFace);
          }
        }

        // CDT triangulation for caps with holes
        const holePts2D = holeVertArrays.map(h => h.pts2D);
        const triangles = constrainedTriangulate(pts, holePts2D);

        // Build flat vertex lookup: outer vertices then hole vertices
        const allBottom = [...bottomVertices];
        const allTop = [...topVertices];
        for (const h of holeVertArrays) {
          allBottom.push(...h.bottomVerts);
          allTop.push(...h.topVerts);
        }

        const downNormal = { x: -resolvedPlane.normal.x, y: -resolvedPlane.normal.y, z: -resolvedPlane.normal.z };
        const upNormal = { x: resolvedPlane.normal.x, y: resolvedPlane.normal.y, z: resolvedPlane.normal.z };

        for (const [a, b, c] of triangles) {
          // Bottom cap — reversed winding
          geometry.faces.push({ vertices: [allBottom[c], allBottom[b], allBottom[a]], normal: { ...downNormal } });
          // Top cap
          geometry.faces.push({ vertices: [allTop[a], allTop[b], allTop[c]], normal: { ...upNormal } });
        }
      } else {
        // No holes — use CDT for concave polygons, simple face for convex
        const downNormal = { x: -resolvedPlane.normal.x, y: -resolvedPlane.normal.y, z: -resolvedPlane.normal.z };
        const upNormal = { x: resolvedPlane.normal.x, y: resolvedPlane.normal.y, z: resolvedPlane.normal.z };

        if (pts.length > 3) {
          const triangles = constrainedTriangulate(pts);
          for (const [a, b, c] of triangles) {
            geometry.faces.push({ vertices: [bottomVertices[c], bottomVertices[b], bottomVertices[a]], normal: { ...downNormal } });
            geometry.faces.push({ vertices: [topVertices[a], topVertices[b], topVertices[c]], normal: { ...upNormal } });
          }
        } else {
          geometry.faces.push({ vertices: [...bottomVertices].reverse(), normal: downNormal });
          geometry.faces.push({ vertices: [...topVertices], normal: upNormal });
        }
      }
    }

    // When direction is negative, the extrusion vector is reversed so vertex
    // positions are correct, but face normals/winding assume positive direction.
    // Flip all faces to correct the inside-out orientation.
    if (this.direction < 0) {
      for (const face of geometry.faces) {
        face.vertices.reverse();
        face.normal = {
          x: -face.normal.x,
          y: -face.normal.y,
          z: -face.normal.z,
        };
      }
    }
    
    if (options.previewOnly === true) {
      return geometry;
    }

    // Attach exact B-Rep alongside mesh
    try {
      geometry.topoBody = this.buildExactBrep(profiles, resolvedPlane, extrusionVector, planeFrame, baseOffset, tipOffset, holes);
    } catch (_) {
      // Exact B-Rep is best-effort; mesh is always the fallback
      geometry.topoBody = null;
    }

    const nativeGeometry = this._tryBuildNativeExtrudeGeometry(
      profiles,
      resolvedPlane,
      extrusionVector,
      planeFrame,
      baseOffset,
      tipOffset,
      holes,
      geometry.topoBody,
    );
    if (nativeGeometry) return nativeGeometry;

    return geometry;
  }

  _tryBuildNativeExtrudeGeometry(profiles, plane, extrusionVector, planeFrame, baseOffset, tipOffset, holes, topoBody) {
    if (this.operation !== 'new') return null;
    if (this.symmetric || this.taper || this.extrudeType !== 'distance') return null;
    if (!topoBody) return null;
    if (Array.isArray(holes) && holes.length > 0) return null;
    if (!this._nativeProfilesAreSupported(profiles, holes)) return null;

    const nativeVector = {
      x: extrusionVector.x + tipOffset.x - baseOffset.x,
      y: extrusionVector.y + tipOffset.y - baseOffset.y,
      z: extrusionVector.z + tipOffset.z - baseOffset.z,
    };
    const extDir = _normalize(nativeVector);
    const loops = [];

    for (let profileIndex = 0; profileIndex < profiles.length; profileIndex++) {
      const outerLoop = this._buildNativeExtrudeLoop(profiles[profileIndex], true, true, plane, planeFrame, baseOffset, extDir);
      if (!outerLoop) return null;
      loops.push(outerLoop);
      if (profileIndex === 0) {
        for (const hole of holes || []) {
          const holeLoop = this._buildNativeExtrudeLoop(hole, false, false, plane, planeFrame, baseOffset, extDir);
          if (!holeLoop) return null;
          loops.push(holeLoop);
        }
      }
    }

    const nativeGeometry = tryBuildNativeExtrude({
      loops,
      plane,
      extrusionVector: nativeVector,
      refDir: plane.xAxis || { x: 1, y: 0, z: 0 },
      topoBody,
      sourceFeatureId: this.id,
    });
    if (!nativeGeometry) return null;

    const edgeResult = computeFeatureEdges(nativeGeometry.faces || []);
    nativeGeometry.edges = _augmentNativeCurvedSelectableEdges(edgeResult.edges, nativeGeometry.faces || []);
    nativeGeometry.paths = chainEdgePaths(nativeGeometry.edges);
    nativeGeometry.visualEdges = edgeResult.visualEdges;
    return nativeGeometry;
  }

  _nativeProfilesAreSupported(profiles, holes = []) {
    for (const profile of [...(profiles || []), ...(holes || [])]) {
      for (const edge of profile?.edges || []) {
        const type = edge?.type || 'segment';
        if (type === 'spline' || type === 'bezier') return false;
        if (type !== 'segment' && type !== 'line' && type !== 'arc' && type !== 'circle') return false;
      }
    }
    return true;
  }

  _buildNativeExtrudeLoop(profile, wantCCW, isOuter, plane, planeFrame, baseOffset, extDir) {
    if (!profile || !Array.isArray(profile.points) || profile.points.length < 3) return null;
    let pts = profile.points.map((point) => planeFrame.toPlanePoint(point));
    let profileEdges = profile.edges || null;

    let signedArea = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      signedArea += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    const isCCW = signedArea >= 0;
    if (isCCW !== wantCCW) {
      if (profileEdges) {
        const reversedProfile = _reverseProfileWinding(pts, profileEdges);
        pts = reversedProfile.points;
        profileEdges = reversedProfile.edges;
      } else {
        pts = [...pts].reverse();
      }
    }

    const bottomVerts = pts.map((point) => {
      const world = this.sketchToWorld(point, plane);
      return {
        x: world.x + baseOffset.x,
        y: world.y + baseOffset.y,
        z: world.z + baseOffset.z,
      };
    });

    const ranges = _buildEdgeRanges(profileEdges, bottomVerts.length);

    if (ranges.length === 1 && ranges[0].type === 'circle' && ranges[0].center && ranges[0].radius) {
      return this._buildNativeCircleLoop(ranges[0], bottomVerts, plane, baseOffset, extDir, isOuter);
    }

    const nativePoints = [];
    const nativeEdges = [];
    const addPoint = (point) => {
      if (nativePoints.length > 0 && _distanceSq(nativePoints[nativePoints.length - 1], point) < 1e-20) {
        return nativePoints.length - 1;
      }
      if (nativePoints.length > 2 && _distanceSq(nativePoints[0], point) < 1e-20) {
        return 0;
      }
      nativePoints.push(point);
      return nativePoints.length - 1;
    };

    for (const range of ranges) {
      const spanIndices = [];
      for (let k = range.startIdx; ; k = (k + 1) % bottomVerts.length) {
        spanIndices.push(k);
        if (k === range.endIdx) break;
      }

      if ((range.type === 'arc' || range.type === 'circle') && range.center && range.radius) {
        const centerWorld = this.sketchToWorld(range.center, plane);
        const center = {
          x: centerWorld.x + baseOffset.x,
          y: centerWorld.y + baseOffset.y,
          z: centerWorld.z + baseOffset.z,
        };
        const startIdx = addPoint(bottomVerts[range.startIdx]);
        const endIdx = addPoint(bottomVerts[range.endIdx]);
        const sweep = this._nativeArcSweep(range, bottomVerts, center, extDir);
        nativeEdges.push({ type: 'arc', startIdx, endIdx, center, radius: range.radius, sweep });
        continue;
      }

      if (range.type !== 'segment') return null;
      const segmentCount = spanIndices.length - 1;
      for (let si = 0; si < segmentCount; si++) {
        const startIdx = addPoint(bottomVerts[spanIndices[si]]);
        const endIdx = addPoint(bottomVerts[spanIndices[si + 1]]);
        nativeEdges.push({ type: 'line', startIdx, endIdx });
      }
    }

    if (nativePoints.length > 2 && _distanceSq(nativePoints[0], nativePoints[nativePoints.length - 1]) < 1e-20) {
      nativePoints.pop();
      for (const edge of nativeEdges) {
        if (edge.startIdx === nativePoints.length) edge.startIdx = 0;
        if (edge.endIdx === nativePoints.length) edge.endIdx = 0;
      }
    }

    return nativePoints.length >= 3 && nativeEdges.length >= 3
      ? { points: nativePoints, edges: nativeEdges, isOuter }
      : null;
  }

  _buildNativeCircleLoop(range, bottomVerts, plane, baseOffset, extDir, isOuter) {
    const centerWorld = this.sketchToWorld(range.center, plane);
    const center = {
      x: centerWorld.x + baseOffset.x,
      y: centerWorld.y + baseOffset.y,
      z: centerWorld.z + baseOffset.z,
    };
    const seam = bottomVerts[range.startIdx];
    const r0 = _sub(seam, center);
    const r0Len = Math.hypot(r0.x, r0.y, r0.z);
    if (r0Len < 1e-12) return null;
    const xAx = { x: r0.x / r0Len, y: r0.y / r0Len, z: r0.z / r0Len };
    const positiveYAx = _normalize(_cross(extDir, xAx));
    const tangentIdx = range.endIdx !== range.startIdx ? range.endIdx : ((range.startIdx + 1) % bottomVerts.length);
    const tangent = _normalize(_sub(bottomVerts[tangentIdx], seam));
    const yAx = _dot(tangent, positiveYAx) >= 0
      ? positiveYAx
      : { x: -positiveYAx.x, y: -positiveYAx.y, z: -positiveYAx.z };
    const points = [seam];
    for (const angle of [Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      points.push({
        x: center.x + range.radius * (ca * xAx.x + sa * yAx.x),
        y: center.y + range.radius * (ca * xAx.y + sa * yAx.y),
        z: center.z + range.radius * (ca * xAx.z + sa * yAx.z),
      });
    }
    const edges = [0, 1, 2, 3].map((startIdx) => ({
      type: 'arc',
      startIdx,
      endIdx: (startIdx + 1) % 4,
      center,
      radius: range.radius,
      sweep: Math.PI * 0.5,
    }));
    return { points, edges, isOuter };
  }

  _nativeArcSweep(range, bottomVerts, center, extDir) {
    if (range.sweepAngle !== undefined) return range.sweepAngle;
    const r0 = _sub(bottomVerts[range.startIdx], center);
    const r1 = _sub(bottomVerts[range.endIdx], center);
    const r0Len = Math.hypot(r0.x, r0.y, r0.z);
    const r1Len = Math.hypot(r1.x, r1.y, r1.z);
    if (r0Len < 1e-12 || r1Len < 1e-12) return Math.PI;
    const cosA = Math.max(-1, Math.min(1, _dot(r0, r1) / (r0Len * r1Len)));
    const crossR = _cross(r0, r1);
    const sinSign = _dot(crossR, extDir);
    let sweep = Math.acos(cosA);
    if (sinSign < 0) sweep = 2 * Math.PI - sweep;
    return sweep;
  }

  /**
   * Build an exact B-Rep TopoBody for this extrusion.
   *
   * Produces:
   *   - planar cap faces with exact trim loops
   *   - exact side faces (planar for line segments, cylindrical for arcs)
   *   - exact vertical edge curves
   *   - exact profile-derived top and bottom wires
   *
   * @param {Array} profiles - Sketch profiles
   * @param {Object} plane - Resolved plane
   * @param {{x,y,z}} extrusionVector - Extrusion vector
   * @param {Object} planeFrame - Plane frame from resolvePlaneFrame
   * @returns {import('./BRepTopology.js').TopoBody}
   */
  buildExactBrep(profiles, plane, extrusionVector, planeFrame, baseOffset = { x: 0, y: 0, z: 0 }, tipOffset = { x: 0, y: 0, z: 0 }, holes = []) {
    const faceDescs = [];
    const extDir = _normalize(extrusionVector);
    const extHeight = Math.sqrt(
      extrusionVector.x * extrusionVector.x +
      extrusionVector.y * extrusionVector.y +
      extrusionVector.z * extrusionVector.z
    );

    const prepareProfileData = (profile, wantCCW) => {
      let pts = profile.points.map((point) => planeFrame.toPlanePoint(point));
      let profileEdges = profile.edges || null;

      let signedArea = 0;
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        signedArea += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
      }

      const isCCW = signedArea >= 0;
      if (isCCW !== wantCCW) {
        if (profileEdges) {
          const reversedProfile = _reverseProfileWinding(pts, profileEdges);
          pts = reversedProfile.points;
          profileEdges = reversedProfile.edges;
        } else {
          pts = [...pts].reverse();
        }
      }

      const n = pts.length;
      const bottomVerts = pts.map((point) => {
        const world = this.sketchToWorld(point, plane);
        return {
          x: world.x + baseOffset.x,
          y: world.y + baseOffset.y,
          z: world.z + baseOffset.z,
        };
      });
      const topVerts = bottomVerts.map((vertex) => ({
        x: vertex.x + extrusionVector.x + tipOffset.x - baseOffset.x,
        y: vertex.y + extrusionVector.y + tipOffset.y - baseOffset.y,
        z: vertex.z + extrusionVector.z + tipOffset.z - baseOffset.z,
      }));

      const edgeRanges = _buildEdgeRanges(profileEdges, n);
      const edgeInfos = [];

      for (const range of edgeRanges) {
        const { type, startIdx, endIdx } = range;
        const spanIndices = [];
        for (let k = startIdx; ; k = (k + 1) % n) {
          spanIndices.push(k);
          if (k === endIdx) break;
        }

        if ((type === 'arc' || type === 'circle') && range.center && range.radius) {
          const centerWorld = this.sketchToWorld(range.center, plane);
          const center3D = {
            x: centerWorld.x + baseOffset.x,
            y: centerWorld.y + baseOffset.y,
            z: centerWorld.z + baseOffset.z,
          };
          const topCenter3D = {
            x: center3D.x + extrusionVector.x + tipOffset.x - baseOffset.x,
            y: center3D.y + extrusionVector.y + tipOffset.y - baseOffset.y,
            z: center3D.z + extrusionVector.z + tipOffset.z - baseOffset.z,
          };

          if (type === 'circle') {
            // Split full circles into quarter-cylinder faces.  This avoids
            // self-loop seam edges, and gives cap loops at least four coedges
            // so exact boolean validation does not treat circular caps as
            // degenerate two-edge fragments.
            const seamIdx = spanIndices[0];
            const r0 = _sub(bottomVerts[seamIdx], center3D);
            const r0Len = Math.sqrt(r0.x * r0.x + r0.y * r0.y + r0.z * r0.z);
            const xAx = r0Len > 1e-14 ? { x: r0.x / r0Len, y: r0.y / r0Len, z: r0.z / r0Len } : plane.xAxis;
            const positiveYAx = _normalize(_cross(extDir, xAx));
            const tangentIdx = spanIndices[1] ?? seamIdx;
            const tangent = _normalize(_sub(bottomVerts[tangentIdx], bottomVerts[seamIdx]));
            const yAx = _dot(tangent, positiveYAx) >= 0
              ? positiveYAx
              : { x: -positiveYAx.x, y: -positiveYAx.y, z: -positiveYAx.z };

            const splitIndices = [seamIdx];
            for (const angle of [Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
              const ca = Math.cos(angle);
              const sa = Math.sin(angle);
              const bottomPoint = {
                x: center3D.x + range.radius * (ca * xAx.x + sa * yAx.x),
                y: center3D.y + range.radius * (ca * xAx.y + sa * yAx.y),
                z: center3D.z + range.radius * (ca * xAx.z + sa * yAx.z),
              };
              const topPoint = {
                x: topCenter3D.x + range.radius * (ca * xAx.x + sa * yAx.x),
                y: topCenter3D.y + range.radius * (ca * xAx.y + sa * yAx.y),
                z: topCenter3D.z + range.radius * (ca * xAx.z + sa * yAx.z),
              };
              const idx = bottomVerts.length;
              bottomVerts.push(bottomPoint);
              topVerts.push(topPoint);
              splitIndices.push(idx);
            }
            splitIndices.push(seamIdx);

            // Tag all quarters with a shared fusedGroupId so that the edge
            // analysis and selection logic treat them as one logical face.
            const fusedId = `cyl-${_nextFusedId++}`;

            for (let quarter = 0; quarter < 4; quarter++) {
              const startAngle = quarter * Math.PI * 0.5;
              const startIdx = splitIndices[quarter];
              const endIdx = splitIndices[quarter + 1];
              edgeInfos.push({
                type: 'arc',
                startIdx,
                endIdx,
                spanIndices: [startIdx, endIdx],
                isArc: true,
                bottomCurve: NurbsCurve.createArc(center3D, range.radius, xAx, yAx, startAngle, Math.PI * 0.5),
                topCurve: NurbsCurve.createArc(topCenter3D, range.radius, xAx, yAx, startAngle, Math.PI * 0.5),
                cylSurf: NurbsSurface.createCylinder(center3D, extDir, range.radius, extHeight, xAx, yAx, startAngle, Math.PI * 0.5),
                cylSurfaceInfo: { type: 'cylinder', origin: center3D, axis: extDir, xDir: xAx, yDir: yAx, radius: range.radius },
                fusedGroupId: fusedId,
              });
            }
            continue;
          }

          const r0 = _sub(bottomVerts[startIdx], center3D);
          const r0Len = Math.sqrt(r0.x * r0.x + r0.y * r0.y + r0.z * r0.z);
          const xAx = r0Len > 1e-14 ? { x: r0.x / r0Len, y: r0.y / r0Len, z: r0.z / r0Len } : plane.xAxis;
          const yAx = _normalize(_cross(extDir, xAx));

          const r1 = _sub(bottomVerts[endIdx], center3D);
          const cosA = Math.max(-1, Math.min(1, (r0.x * r1.x + r0.y * r1.y + r0.z * r1.z) / (r0Len * range.radius)));
          const crossR = _cross(r0, r1);
          const sinSign = crossR.x * extDir.x + crossR.y * extDir.y + crossR.z * extDir.z;
          let sweep = Math.acos(cosA);
          if (range.sweepAngle !== undefined) {
            sweep = Math.abs(range.sweepAngle);
            if ((range.sweepAngle > 0 && sinSign < 0) || (range.sweepAngle < 0 && sinSign > 0)) {
              sweep = 2 * Math.PI - sweep;
            }
            // Preserve the sweep direction: a negative sweepAngle means the arc
            // goes clockwise (concave), so negate sweep for createArc.
            if (range.sweepAngle < 0) sweep = -sweep;
          } else if (sinSign < 0) {
            sweep = 2 * Math.PI - sweep;
          }

          edgeInfos.push({
            type,
            startIdx,
            endIdx,
            spanIndices,
            isArc: true,
            bottomCurve: NurbsCurve.createArc(center3D, range.radius, xAx, yAx, 0, sweep),
            topCurve: NurbsCurve.createArc(topCenter3D, range.radius, xAx, yAx, 0, sweep),
            cylSurf: NurbsSurface.createCylinder(center3D, extDir, range.radius, extHeight, xAx, yAx, 0, sweep),
            cylSurfaceInfo: { type: 'cylinder', origin: center3D, axis: extDir, xDir: xAx, yDir: yAx, radius: range.radius },
          });
        } else if (type === 'spline' && range.controlPoints2D && range.knots) {
          // Create exact B-spline curves for bottom and top cap edges
          const toBottomWorld = (p) => {
            const w = this.sketchToWorld(p, plane);
            return { x: w.x + baseOffset.x, y: w.y + baseOffset.y, z: w.z + baseOffset.z };
          };
          const toTopWorld = (p) => {
            const w = this.sketchToWorld(p, plane);
            return {
              x: w.x + extrusionVector.x + tipOffset.x,
              y: w.y + extrusionVector.y + tipOffset.y,
              z: w.z + extrusionVector.z + tipOffset.z,
            };
          };
          const bottomCurve = _spline2Dto3D(range.controlPoints2D, range.degree, range.knots, toBottomWorld);
          const topCurve = _spline2Dto3D(range.controlPoints2D, range.degree, range.knots, toTopWorld);

          // Split into N sub-faces (N = max(3, numControlPoints)) so each
          // sub-face has a simple NURBS surface and the chamfer/fillet can
          // operate on individual sub-edges with 3+ vertex face boundaries.
          const N = Math.max(3, range.controlPoints2D.length);
          const bottomParts = bottomCurve.splitUniform(N);
          const topParts = topCurve.splitUniform(N);

          if (bottomParts && topParts && bottomParts.length === N && topParts.length === N) {
            // Add intermediate split-point vertices
            const splitVertIds = [startIdx];
            for (let i = 1; i < N; i++) {
              const bPt = bottomParts[i].evaluate(bottomParts[i].uMin);
              const tPt = topParts[i].evaluate(topParts[i].uMin);
              const idx = bottomVerts.length;
              bottomVerts.push(bPt);
              topVerts.push(tPt);
              splitVertIds.push(idx);
            }
            splitVertIds.push(endIdx);

            // Create N sub-edge infos
            for (let i = 0; i < N; i++) {
              const subExtSurf = NurbsSurface.createExtrudedSurface(bottomParts[i], extDir, extHeight);
              edgeInfos.push({
                type,
                startIdx: splitVertIds[i],
                endIdx: splitVertIds[i + 1],
                spanIndices: [splitVertIds[i], splitVertIds[i + 1]],
                isArc: false,
                isCurve: true,
                bottomCurve: bottomParts[i],
                topCurve: topParts[i],
                extrudedSurf: subExtSurf,
              });
            }
          } else {
            // Fallback: single face
            const extrudedSurf = NurbsSurface.createExtrudedSurface(bottomCurve, extDir, extHeight);
            edgeInfos.push({
              type,
              startIdx,
              endIdx,
              spanIndices,
              isArc: false,
              isCurve: true,
              bottomCurve,
              topCurve,
              extrudedSurf,
            });
          }
        } else if (type === 'bezier' && range.bezierVertices) {
          const toBottomWorld = (p) => {
            const w = this.sketchToWorld(p, plane);
            return { x: w.x + baseOffset.x, y: w.y + baseOffset.y, z: w.z + baseOffset.z };
          };
          const toTopWorld = (p) => {
            const w = this.sketchToWorld(p, plane);
            return {
              x: w.x + extrusionVector.x + tipOffset.x,
              y: w.y + extrusionVector.y + tipOffset.y,
              z: w.z + extrusionVector.z + tipOffset.z,
            };
          };
          const bottomCurve = _bezierVertices2Dto3D(range.bezierVertices, toBottomWorld);
          const topCurve = _bezierVertices2Dto3D(range.bezierVertices, toTopWorld);

          // Split bezier into N sub-faces (N = max(3, numVertices))
          const N = Math.max(3, range.bezierVertices.length);
          const bottomParts = bottomCurve.splitUniform(N);
          const topParts = topCurve.splitUniform(N);

          if (bottomParts && topParts && bottomParts.length === N && topParts.length === N) {
            const splitVertIds = [startIdx];
            for (let i = 1; i < N; i++) {
              const bPt = bottomParts[i].evaluate(bottomParts[i].uMin);
              const tPt = topParts[i].evaluate(topParts[i].uMin);
              const idx = bottomVerts.length;
              bottomVerts.push(bPt);
              topVerts.push(tPt);
              splitVertIds.push(idx);
            }
            splitVertIds.push(endIdx);

            for (let i = 0; i < N; i++) {
              const subExtSurf = NurbsSurface.createExtrudedSurface(bottomParts[i], extDir, extHeight);
              edgeInfos.push({
                type,
                startIdx: splitVertIds[i],
                endIdx: splitVertIds[i + 1],
                spanIndices: [splitVertIds[i], splitVertIds[i + 1]],
                isArc: false,
                isCurve: true,
                bottomCurve: bottomParts[i],
                topCurve: topParts[i],
                extrudedSurf: subExtSurf,
              });
            }
          } else {
            // Fallback: single face
            const extrudedSurf = NurbsSurface.createExtrudedSurface(bottomCurve, extDir, extHeight);
            edgeInfos.push({
              type,
              startIdx,
              endIdx,
              spanIndices,
              isArc: false,
              isCurve: true,
              bottomCurve,
              topCurve,
              extrudedSurf,
            });
          }
        } else {
          edgeInfos.push({
            type,
            startIdx,
            endIdx,
            spanIndices,
            isArc: false,
            isClosedRange: type === 'circle',
          });
        }
      }

      return { bottomVerts, topVerts, edgeInfos };
    };

    const buildCapLoop = (profileData, curveKey, reversed) => {
      const vertices = [];
      const edgeCurves = [];
      const infos = reversed ? [...profileData.edgeInfos].reverse() : profileData.edgeInfos;
      const verts = curveKey === 'bottomCurve' ? profileData.bottomVerts : profileData.topVerts;

      for (const info of infos) {
        if (info.isArc || info.isCurve) {
          vertices.push(reversed ? verts[info.endIdx] : verts[info.startIdx]);
          edgeCurves.push(reversed ? info[curveKey].reversed() : info[curveKey]);
          continue;
        }

        const indices = reversed ? [...info.spanIndices].reverse() : info.spanIndices;
        const segmentCount = info.isClosedRange ? indices.length : (indices.length - 1);
        for (let si = 0; si < segmentCount; si++) {
          const start = verts[indices[si]];
          const end = verts[indices[(si + 1) % indices.length]];
          vertices.push(start);
          edgeCurves.push(NurbsCurve.createLine(start, end));
        }
      }

      return { vertices, edgeCurves };
    };

    const addSideFaces = (profileData, hashPrefix) => {
      for (let ei = 0; ei < profileData.edgeInfos.length; ei++) {
        const info = profileData.edgeInfos[ei];
        if (info.isArc) {
          const bStart = profileData.bottomVerts[info.startIdx];
          const bEnd = profileData.bottomVerts[info.endIdx];
          const tStart = profileData.topVerts[info.startIdx];
          const tEnd = profileData.topVerts[info.endIdx];

          let vertices = [bStart, bEnd, tEnd, tStart];
          let edgeCurves = [
            info.bottomCurve,
            NurbsCurve.createLine(bEnd, tEnd),
            info.topCurve.reversed(),
            NurbsCurve.createLine(tStart, bStart),
          ];

          if (this.direction < 0) {
            const reversed = _reverseFaceGeometry(vertices, edgeCurves);
            vertices = reversed.vertices;
            edgeCurves = reversed.edgeCurves;
          }

          faceDescs.push({
            surface: info.cylSurf,
            surfaceType: SurfaceType.CYLINDER,
            surfaceInfo: info.cylSurfaceInfo || null,
            fusedGroupId: info.fusedGroupId || null,
            vertices,
            edgeCurves,
            shared: { sourceFeatureId: this.id },
            stableHash: `${this.id}_Face_Side_${hashPrefix}_${ei}`,
          });
          continue;
        }

        if (info.isCurve) {
          // Side face for a spline/bezier edge — extruded NURBS surface
          const bStart = profileData.bottomVerts[info.startIdx];
          const bEnd = profileData.bottomVerts[info.endIdx];
          const tStart = profileData.topVerts[info.startIdx];
          const tEnd = profileData.topVerts[info.endIdx];

          let vertices = [bStart, bEnd, tEnd, tStart];
          let edgeCurves = [
            info.bottomCurve,
            NurbsCurve.createLine(bEnd, tEnd),
            info.topCurve.reversed(),
            NurbsCurve.createLine(tStart, bStart),
          ];

          if (this.direction < 0) {
            const reversed = _reverseFaceGeometry(vertices, edgeCurves);
            vertices = reversed.vertices;
            edgeCurves = reversed.edgeCurves;
          }

          faceDescs.push({
            surface: info.extrudedSurf,
            surfaceType: SurfaceType.BSPLINE,
            vertices,
            edgeCurves,
            shared: { sourceFeatureId: this.id },
            stableHash: `${this.id}_Face_Side_${hashPrefix}_${ei}`,
          });
          continue;
        }

        const segmentCount = info.isClosedRange ? info.spanIndices.length : (info.spanIndices.length - 1);
        for (let si = 0; si < segmentCount; si++) {
          const i0 = info.spanIndices[si];
          const i1 = info.spanIndices[(si + 1) % info.spanIndices.length];
          let vertices = [
            profileData.bottomVerts[i0],
            profileData.bottomVerts[i1],
            profileData.topVerts[i1],
            profileData.topVerts[i0],
          ];
          if (this.direction < 0) vertices = [...vertices].reverse();

          const segSuffix = segmentCount > 1 ? `_s${si}` : '';
          faceDescs.push({
            surface: NurbsSurface.createPlane(vertices[0], _sub(vertices[1], vertices[0]), _sub(vertices[3], vertices[0])),
            surfaceType: SurfaceType.PLANE,
            vertices,
            edgeCurves: [
              NurbsCurve.createLine(vertices[0], vertices[1]),
              NurbsCurve.createLine(vertices[1], vertices[2]),
              NurbsCurve.createLine(vertices[2], vertices[3]),
              NurbsCurve.createLine(vertices[3], vertices[0]),
            ],
            shared: { sourceFeatureId: this.id },
            stableHash: `${this.id}_Face_Side_${hashPrefix}_${ei}${segSuffix}`,
          });
        }
      }
    };

    for (let profileIndex = 0; profileIndex < profiles.length; profileIndex++) {
      const outerData = prepareProfileData(profiles[profileIndex], true);
      const holeData = profileIndex === 0
        ? (holes || []).map((hole) => prepareProfileData(hole, false))
        : [];

      const bottomOuterLoop = buildCapLoop(outerData, 'bottomCurve', true);
      const topOuterLoop = buildCapLoop(outerData, 'topCurve', false);

      faceDescs.push({
        surface: NurbsSurface.createPlane(
          bottomOuterLoop.vertices[0],
          _sub(bottomOuterLoop.vertices[1] || bottomOuterLoop.vertices[0], bottomOuterLoop.vertices[0]),
          _sub(bottomOuterLoop.vertices[bottomOuterLoop.vertices.length - 1] || bottomOuterLoop.vertices[0], bottomOuterLoop.vertices[0]),
        ),
        surfaceType: SurfaceType.PLANE,
        vertices: bottomOuterLoop.vertices,
        edgeCurves: bottomOuterLoop.edgeCurves,
        innerLoops: holeData.map((holeProfile) => buildCapLoop(holeProfile, 'bottomCurve', true)),
        shared: { sourceFeatureId: this.id },
        stableHash: `${this.id}_Face_Bottom_p${profileIndex}`,
      });

      faceDescs.push({
        surface: NurbsSurface.createPlane(
          topOuterLoop.vertices[0],
          _sub(topOuterLoop.vertices[1] || topOuterLoop.vertices[0], topOuterLoop.vertices[0]),
          _sub(topOuterLoop.vertices[topOuterLoop.vertices.length - 1] || topOuterLoop.vertices[0], topOuterLoop.vertices[0]),
        ),
        surfaceType: SurfaceType.PLANE,
        vertices: topOuterLoop.vertices,
        edgeCurves: topOuterLoop.edgeCurves,
        innerLoops: holeData.map((holeProfile) => buildCapLoop(holeProfile, 'topCurve', false)),
        shared: { sourceFeatureId: this.id },
        stableHash: `${this.id}_Face_Top_p${profileIndex}`,
      });

      addSideFaces(outerData, `p${profileIndex}`);
      for (let hi = 0; hi < holeData.length; hi++) {
        addSideFaces(holeData[hi], `p${profileIndex}_h${hi}`);
      }
    }

    const body = buildTopoBody(faceDescs);
    deriveEdgeAndVertexHashes(body);
    return body;
  }

  /**
   * Normalize the sketch plane basis to a right-handed frame.
   * Existing files may contain left-handed face planes; mirror local Y at
   * extrusion time so world-space sketch positions stay unchanged.
   * @param {Object} plane - Sketch plane definition
   * @returns {{plane: Object, toPlanePoint: Function}}
   */
  resolvePlaneFrame(plane) {
    const cross = {
      x: plane.xAxis.y * plane.yAxis.z - plane.xAxis.z * plane.yAxis.y,
      y: plane.xAxis.z * plane.yAxis.x - plane.xAxis.x * plane.yAxis.z,
      z: plane.xAxis.x * plane.yAxis.y - plane.xAxis.y * plane.yAxis.x,
    };
    const handedness = cross.x * plane.normal.x + cross.y * plane.normal.y + cross.z * plane.normal.z;
    if (handedness >= 0) {
      return {
        plane,
        toPlanePoint(point) {
          return { x: point.x, y: point.y };
        },
      };
    }

    return {
      plane: {
        ...plane,
        yAxis: {
          x: -plane.yAxis.x,
          y: -plane.yAxis.y,
          z: -plane.yAxis.z,
        },
      },
      toPlanePoint(point) {
        return { x: point.x, y: -point.y };
      },
    };
  }

  /**
   * Transform a 2D sketch point to 3D world coordinates.
   * @param {Object} point - 2D point in sketch space
   * @param {Object} plane - Sketch plane definition
   * @returns {Object} 3D point in world space
   */
  sketchToWorld(point, plane) {
    return {
      x: plane.origin.x + point.x * plane.xAxis.x + point.y * plane.yAxis.x,
      y: plane.origin.y + point.x * plane.xAxis.y + point.y * plane.yAxis.y,
      z: plane.origin.z + point.x * plane.xAxis.z + point.y * plane.yAxis.z,
    };
  }

  /**
   * Calculate face normal from vertices.
   * @param {Array} vertices - Face vertices (at least 3)
   * @returns {Object} Normal vector
   */
  calculateFaceNormal(vertices) {
    if (vertices.length < 3) {
      return { x: 0, y: 0, z: 1 };
    }
    
    const v1 = {
      x: vertices[1].x - vertices[0].x,
      y: vertices[1].y - vertices[0].y,
      z: vertices[1].z - vertices[0].z,
    };
    
    const v2 = {
      x: vertices[2].x - vertices[0].x,
      y: vertices[2].y - vertices[0].y,
      z: vertices[2].z - vertices[0].z,
    };
    
    // Cross product
    const normal = {
      x: v1.y * v2.z - v1.z * v2.y,
      y: v1.z * v2.x - v1.x * v2.z,
      z: v1.x * v2.y - v1.y * v2.x,
    };
    
    // Normalize
    const length = Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
    if (length > 0) {
      normal.x /= length;
      normal.y /= length;
      normal.z /= length;
    }
    
    return normal;
  }

  /**
   * Get the previous solid from the context (for boolean operations).
   * @param {Object} context - Execution context
   * @returns {Object|null} Previous solid or null
   */
  getPreviousSolid(context) {
    if (this.operation === 'new') return null;
    
    // Find the most recent solid result before this feature
    const thisIndex = context.tree.getFeatureIndex(this.id);
    for (let i = thisIndex - 1; i >= 0; i--) {
      const feature = context.tree.features[i];
      const result = context.results[feature.id];
      if (result && result.type === 'solid' && !result.error) {
        return result.solid;
      }
    }
    
    return null;
  }

  /**
   * Apply boolean operation between existing solid and new geometry.
   * @param {Object|null} solid - Existing solid (or null)
   * @param {Object} geometry - New geometry to add
   * @returns {Object} Resulting solid
   */
  applyOperation(solid, geometry) {
    if (this.operation === 'new' || !solid) {
      // Tag new faces with this feature's id so selection can link back
      if (geometry && geometry.faces) {
        for (const f of geometry.faces) {
          if (!f.shared) f.shared = { sourceFeatureId: this.id };
        }
        // Compute feature edges and face groups for the initial geometry
        const edgeResult = computeFeatureEdges(geometry.faces);
        geometry.edges = geometry.nativeExtrude
          ? _augmentNativeCurvedSelectableEdges(edgeResult.edges, geometry.faces)
          : edgeResult.edges;
        geometry.paths = geometry.nativeExtrude ? chainEdgePaths(geometry.edges) : edgeResult.paths;
        geometry.visualEdges = edgeResult.visualEdges;
      }
      return { geometry };
    }

    // Perform boolean operation using CSG
    const prevGeom = solid.geometry;
    if (!prevGeom || !prevGeom.faces || prevGeom.faces.length === 0) {
      return { geometry };
    }

    try {
      // Pass feature ids as shared metadata so faces track their source feature
      const resultGeom = booleanOp(prevGeom, geometry, this.operation,
        null, // keep existing shared on prevGeom faces
        { sourceFeatureId: this.id });
      return { geometry: resultGeom };
    } catch (err) {
      const message = this._formatBooleanError(err);
      const error = new Error(message);
      error.cause = err;
      error.diagnostics = err?.diagnostics;
      throw error;
    }
  }

  _formatBooleanError(err) {
    const base = err?.message || String(err);
    const diagnostics = err?.diagnostics;
    const finalBody = diagnostics?.finalBodyValidation;
    const invariant = diagnostics?.invariantValidation;
    const detail = finalBody?.diagnostics?.[0]?.detail || invariant?.diagnostics?.[0]?.detail;
    const count = finalBody?.count || invariant?.diagnosticCount || 0;
    const suffix = detail
      ? ` (${count > 1 ? `${count} issues; ` : ''}${detail})`
      : '';
    return `Boolean ${this.operation} failed: ${base}${suffix}`;
  }

  /**
   * Calculate volume of the extruded geometry (approximate).
   * TODO: Implement accurate volume calculation using profile area and extrusion distance
   * @param {Object} geometry - Geometry data
   * @returns {number} Volume
   */
  calculateVolume(geometry) {
    return calculateMeshVolume(geometry);
  }

  /**
   * Calculate bounding box of the geometry.
   * @param {Object} geometry - Geometry data
   * @returns {Object} Bounding box with min and max points
   */
  calculateBoundingBox(geometry) {
    return calculateBoundingBox(geometry);
  }

  /**
   * Set the sketch feature to extrude.
   * @param {string} sketchFeatureId - ID of the sketch feature
   */
  setSketchFeature(sketchFeatureId) {
    // Remove old dependency
    if (this.sketchFeatureId) {
      this.removeDependency(this.sketchFeatureId);
    }
    
    // Add new dependency
    this.sketchFeatureId = sketchFeatureId;
    if (sketchFeatureId) {
      this.addDependency(sketchFeatureId);
    }
    
    this.modified = new Date();
  }

  /**
   * Set the extrusion distance.
   * Negative values flip the direction instead of using a negative distance.
   * @param {number} distance - Extrusion distance
   */
  setDistance(distance) {
    if (distance < 0) {
      this.distance = -distance;
      this.direction = -this.direction;
    } else {
      this.distance = distance;
    }
    this.modified = new Date();
  }

  /**
   * Serialize this extrude feature.
   */
  serialize() {
    return {
      ...super.serialize(),
      sketchFeatureId: this.sketchFeatureId,
      distance: this.distance,
      direction: this.direction,
      symmetric: this.symmetric,
      operation: this.operation,
      extrudeType: this.extrudeType,
      taper: this.taper,
      taperAngle: this.taperAngle,
      taperInward: this.taperInward,
    };
  }

  /**
   * Deserialize an extrude feature from JSON.
   */
  static deserialize(data) {
    const feature = new ExtrudeFeature();
    if (!data) return feature;
    
    // Deserialize base feature properties
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'extrude';
    
    // Deserialize extrude-specific properties
    feature.sketchFeatureId = data.sketchFeatureId || null;
    feature.distance = data.distance || 10;
    feature.direction = data.direction || 1;
    feature.symmetric = data.symmetric || false;
    feature.operation = data.operation || 'new';
    feature.extrudeType = data.extrudeType || 'distance';
    feature.taper = data.taper || false;
    feature.taperAngle = data.taperAngle != null ? data.taperAngle : 5;
    feature.taperInward = data.taperInward != null ? data.taperInward : true;
    
    return feature;
  }
}

// Vector helper for B-Rep construction
function _sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function _cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function _normalize(v) {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  return len > 1e-14 ? { x: v.x / len, y: v.y / len, z: v.z / len } : { x: 0, y: 0, z: 1 };
}

function _dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function _distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function _augmentNativeCurvedSelectableEdges(edges, faces) {
  if (!Array.isArray(edges) || edges.length === 0 || !Array.isArray(faces) || faces.length === 0) {
    return edges || [];
  }

  const buckets = new Map();
  const zPlaneTol = 1e-6;
  for (const edge of edges) {
    if (!edge || !Array.isArray(edge.faceIndices) || edge.faceIndices.length < 2) continue;
    if (Math.abs((edge.start?.z ?? 0) - (edge.end?.z ?? 0)) > zPlaneTol) continue;
    const adjacentFaces = edge.faceIndices.map((faceIndex) => faces[faceIndex]).filter(Boolean);
    const curvedFace = adjacentFaces.find((face) => face.isCurved && face.surfaceInfo?.type === 'cylinder');
    const planarFace = adjacentFaces.find((face) => !face.isCurved);
    if (!curvedFace || !planarFace) continue;
    const curvedId = curvedFace.topoFaceId ?? curvedFace.faceGroup ?? 'curved';
    const planeKey = Math.round(edge.start.z * 1e6);
    const key = `${curvedId}|${planeKey}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(edge);
  }

  const augmented = [...edges];
  const existing = new Set(edges.map((edge) => _edgeSelectionKey(edge.start, edge.end)));
  for (const bucketEdges of buckets.values()) {
    const paths = chainEdgePaths(bucketEdges);
    for (const path of paths) {
      const orderedPoints = _orderedEdgePathPoints(bucketEdges, path.edgeIndices);
      if (orderedPoints.length < 4) continue;
      const chunk = 3;
      for (let startIndex = 0; startIndex + chunk < orderedPoints.length; startIndex += chunk) {
        const start = orderedPoints[startIndex];
        const end = orderedPoints[startIndex + chunk];
        if (_distanceSq(start, end) < 0.25) continue;
        const key = _edgeSelectionKey(start, end);
        if (existing.has(key)) continue;
        existing.add(key);
        augmented.push({
          start,
          end,
          faceIndices: bucketEdges[path.edgeIndices[0]]?.faceIndices || [],
          normals: bucketEdges[path.edgeIndices[0]]?.normals || [],
          nativeSelectableSpan: true,
        });
      }
    }
  }

  return augmented;
}

function _orderedEdgePathPoints(edges, edgeIndices) {
  const remaining = edgeIndices.map((edgeIndex) => edges[edgeIndex]).filter(Boolean);
  if (remaining.length === 0) return [];
  const firstEdge = remaining.shift();
  const points = [firstEdge.start, firstEdge.end];

  while (remaining.length > 0) {
    let matchedIndex = -1;
    let appendPoint = null;
    let prependPoint = null;
    const head = points[0];
    const tail = points[points.length - 1];

    for (let index = 0; index < remaining.length; index++) {
      const edge = remaining[index];
      if (_pointsCoincident(edge.start, tail)) { matchedIndex = index; appendPoint = edge.end; break; }
      if (_pointsCoincident(edge.end, tail)) { matchedIndex = index; appendPoint = edge.start; break; }
      if (_pointsCoincident(edge.end, head)) { matchedIndex = index; prependPoint = edge.start; break; }
      if (_pointsCoincident(edge.start, head)) { matchedIndex = index; prependPoint = edge.end; break; }
    }

    if (matchedIndex < 0) break;
    remaining.splice(matchedIndex, 1);
    if (appendPoint) points.push(appendPoint);
    else if (prependPoint) points.unshift(prependPoint);
  }

  return points;
}

function _pointsCoincident(a, b) {
  return !!a && !!b && _distanceSq(a, b) < 1e-10;
}

function _edgeSelectionKey(a, b) {
  const format = (value) => (Math.abs(value) < 1e-12 ? 0 : value).toFixed(6);
  const first = `${format(a.x)},${format(a.y)},${format(a.z)}`;
  const second = `${format(b.x)},${format(b.y)},${format(b.z)}`;
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function _reverseFaceGeometry(vertices, edgeCurves) {
  const n = vertices.length;
  return {
    vertices: [...vertices].reverse(),
    edgeCurves: edgeCurves.map((_, i) => {
      const curve = edgeCurves[(n - 2 - i + n) % n];
      return curve && typeof curve.reversed === 'function' ? curve.reversed() : curve;
    }),
  };
}

/**
 * Reverse edge metadata list when profile winding is reversed.
 * The edges list must be reversed and each arc sweep direction flipped.
 */
function _reverseEdgeMetaList(edges, totalPoints) {
  if (!edges || edges.length === 0) return edges;
  const result = [];
  for (let i = edges.length - 1; i >= 0; i--) {
    const e = { ...edges[i] };
    if (e.type === 'arc' && e.sweepAngle !== undefined) {
      e.sweepAngle = -e.sweepAngle;
      if (e.startAngle !== undefined) {
        e.startAngle = e.startAngle + edges[i].sweepAngle;
      }
    }
    result.push(e);
  }
  return result;
}

function _reverseProfileWinding(points, edges) {
  if (!Array.isArray(points) || points.length === 0 || !Array.isArray(edges) || edges.length === 0) {
    return {
      points: Array.isArray(points) ? [...points].reverse() : points,
      edges: Array.isArray(edges) ? _reverseEdgeMetaList(edges) : edges,
    };
  }

  if (edges.length === 1 && edges[0].type === 'circle') {
    return {
      points: [points[0], ...points.slice(1).reverse()],
      edges: [{
        ..._reverseSingleEdgeMeta(edges[0]),
        pointStartIndex: 0,
        pointCount: points.length,
      }],
    };
  }

  const pointCount = points.length;
  const ranges = _buildEdgeRanges(edges, pointCount);
  const pointChains = ranges.map((range) => {
    const chain = [];
    for (let index = range.startIdx; ; index = (index + 1) % pointCount) {
      chain.push(points[index]);
      if (index === range.endIdx) break;
    }
    return chain;
  });

  const reversedPoints = [{ ...points[0] }];
  const reversedEdges = [];
  for (let edgeIndex = edges.length - 1; edgeIndex >= 0; edgeIndex--) {
    reversedEdges.push(_reverseSingleEdgeMeta(edges[edgeIndex]));

    const reversedChain = [...pointChains[edgeIndex]].reverse();
    for (let i = 1; i < reversedChain.length; i++) {
      reversedPoints.push({ ...reversedChain[i] });
    }
  }

  if (reversedPoints.length > 1) {
    const first = reversedPoints[0];
    const last = reversedPoints[reversedPoints.length - 1];
    if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) {
      reversedPoints.pop();
    }
  }

  let currentIndex = 0;
  const normalizedEdges = reversedEdges.map((edge) => {
    const normalized = {
      ...edge,
      pointStartIndex: currentIndex,
      pointCount: edge.pointCount || 2,
    };
    currentIndex = (currentIndex + normalized.pointCount - 1) % reversedPoints.length;
    return normalized;
  });

  return {
    points: reversedPoints,
    edges: normalizedEdges,
  };
}

function _reverseSingleEdgeMeta(edge) {
  const reversed = { ...edge };
  if (edge.type === 'arc' && edge.sweepAngle !== undefined) {
    reversed.startAngle = edge.startAngle !== undefined ? edge.startAngle + edge.sweepAngle : edge.startAngle;
    reversed.sweepAngle = -edge.sweepAngle;
  }
  if (edge.type === 'spline' && edge.controlPoints2D && edge.knots) {
    // Reverse control points and flip knot vector
    reversed.controlPoints2D = [...edge.controlPoints2D].reverse();
    const kMin = edge.knots[0], kMax = edge.knots[edge.knots.length - 1];
    reversed.knots = edge.knots.map(k => kMax + kMin - k).reverse();
  }
  if (edge.type === 'bezier' && edge.bezierVertices) {
    // Reverse vertex order and swap/negate handles
    reversed.bezierVertices = [...edge.bezierVertices].reverse().map(v => ({
      x: v.x, y: v.y,
      handleOut: v.handleIn ? { dx: -v.handleIn.dx, dy: -v.handleIn.dy } : null,
      handleIn: v.handleOut ? { dx: -v.handleOut.dx, dy: -v.handleOut.dy } : null,
    }));
  }
  return reversed;
}

/**
 * Build edge ranges from profile edge metadata.
 * Returns array of { type, startIdx, endIdx, center?, radius?, sweepAngle? }
 * where startIdx..endIdx are indices into the profile points array.
 */
function _buildEdgeRanges(profileEdges, totalPoints) {
  if (!profileEdges || profileEdges.length === 0) {
    // No edge metadata — treat entire profile as line segments
    const ranges = [];
    for (let i = 0; i < totalPoints; i++) {
      ranges.push({
        type: 'segment',
        startIdx: i,
        endIdx: (i + 1) % totalPoints,
      });
    }
    return ranges;
  }

  const ranges = [];
  let currentIdx = 0;

  for (const edge of profileEdges) {
    const nPts = edge.pointCount || 2;
    // The edge covers nPts tessellation points (including shared start),
    // contributing nPts-1 point advances
    const advance = nPts - 1;
    const endIdx = (currentIdx + advance) % totalPoints;

    ranges.push({
      type: edge.type || 'segment',
      startIdx: currentIdx,
      endIdx,
      center: edge.center,
      radius: edge.radius,
      sweepAngle: edge.sweepAngle,
      startAngle: edge.startAngle,
      // Propagate exact spline data
      controlPoints2D: edge.controlPoints2D,
      degree: edge.degree,
      knots: edge.knots,
      // Propagate exact bezier data
      bezierVertices: edge.bezierVertices,
    });

    currentIdx = endIdx;
  }

  return ranges;
}

/**
 * Build edge curves for cap faces.
 * For segments between cap vertices → line curves.
 * For arcs → NURBS arc curves in 3D.
 * @param {Array} capVerts - Cap vertices in order
 * @param {Array} edgeRanges - Edge range descriptors
 * @param {number} n - Total number of profile points
 * @param {boolean} isBottom - If true, cap is reversed winding (needs arc reversal)
 */
function _buildCapEdgeCurves(capVerts, edgeRanges, n, isBottom) {
  // Cap vertices just form a polygon boundary; each consecutive pair
  // of vertices is an edge. For now, use line curves for all cap edges.
  // Arc curves on cap edges are not needed for the planar cap surface —
  // the key improvement is the cylindrical SIDE faces.
  return capVerts.map((v, i) =>
    NurbsCurve.createLine(v, capVerts[(i + 1) % capVerts.length])
  );
}

/**
 * Create a 3D NurbsCurve from 2D B-spline control points by transforming
 * each control point from sketch space to world 3D via a plane+offset.
 * @param {Array<{x:number,y:number}>} controlPoints2D
 * @param {number} degree
 * @param {number[]} knots
 * @param {Function} toWorld - (sketchPt2D) => {x,y,z}
 * @returns {NurbsCurve}
 */
function _spline2Dto3D(controlPoints2D, degree, knots, toWorld) {
  const cps3D = controlPoints2D.map(p => toWorld(p));
  return new NurbsCurve(degree, cps3D, knots);
}

/**
 * Convert piecewise bezier vertices (with handles) into a NURBS curve.
 *
 * A piecewise cubic bezier with N segments is a degree-3 B-spline with
 * 3N+1 control points and a specific knot pattern (clamped, with
 * multiplicity 3 at inner joins).
 *
 * Quadratic/linear segments are degree-elevated to cubic so that the
 * entire curve is a uniform degree-3 B-spline.
 *
 * @param {Array<{x:number,y:number,handleOut?:{dx:number,dy:number},handleIn?:{dx:number,dy:number}}>} vertices
 * @param {Function} toWorld - (sketchPt2D) => {x,y,z}
 * @returns {NurbsCurve}
 */
function _bezierVertices2Dto3D(vertices, toWorld) {
  if (vertices.length < 2) throw new Error('Need at least 2 bezier vertices');
  const nSegs = vertices.length - 1;

  // Build the list of cubic Bezier control points for each segment.
  // Each segment contributes 4 control points (P0, C1, C2, P3), where
  // consecutive segments share the last/first control point (P3 of seg i = P0 of seg i+1).
  const allCPs = [];

  for (let s = 0; s < nSegs; s++) {
    const v0 = vertices[s];
    const v1 = vertices[s + 1];
    const p0 = { x: v0.x, y: v0.y };
    const p3 = { x: v1.x, y: v1.y };
    const ho = v0.handleOut;
    const hi = v1.handleIn;

    let c1, c2;
    if (ho && hi) {
      // Cubic bezier
      c1 = { x: p0.x + ho.dx, y: p0.y + ho.dy };
      c2 = { x: p3.x + hi.dx, y: p3.y + hi.dy };
    } else if (ho) {
      // Quadratic → elevate to cubic:  C1 = P0 + 2/3*(Q-P0), C2 = P3 + 2/3*(Q-P3)
      const q = { x: p0.x + ho.dx, y: p0.y + ho.dy };
      c1 = { x: p0.x + 2 / 3 * (q.x - p0.x), y: p0.y + 2 / 3 * (q.y - p0.y) };
      c2 = { x: p3.x + 2 / 3 * (q.x - p3.x), y: p3.y + 2 / 3 * (q.y - p3.y) };
    } else if (hi) {
      const q = { x: p3.x + hi.dx, y: p3.y + hi.dy };
      c1 = { x: p0.x + 2 / 3 * (q.x - p0.x), y: p0.y + 2 / 3 * (q.y - p0.y) };
      c2 = { x: p3.x + 2 / 3 * (q.x - p3.x), y: p3.y + 2 / 3 * (q.y - p3.y) };
    } else {
      // Linear → elevate to cubic
      c1 = { x: p0.x + (p3.x - p0.x) / 3, y: p0.y + (p3.y - p0.y) / 3 };
      c2 = { x: p0.x + 2 * (p3.x - p0.x) / 3, y: p0.y + 2 * (p3.y - p0.y) / 3 };
    }

    if (s === 0) allCPs.push(p0);
    allCPs.push(c1, c2, p3);
  }

  // Build clamped knot vector with C0 continuity (multiplicity 3) at joins.
  // For nSegs cubic segments: n_cps = 3*nSegs + 1, degree = 3
  // knots = [0,0,0,0, 1,1,1, 2,2,2, ..., nSegs,nSegs,nSegs,nSegs]
  const degree = 3;
  const knots = [];
  // Clamped start
  for (let i = 0; i <= degree; i++) knots.push(0);
  // Inner knots (multiplicity 3 for C0)
  for (let s = 1; s < nSegs; s++) {
    for (let m = 0; m < degree; m++) knots.push(s);
  }
  // Clamped end
  for (let i = 0; i <= degree; i++) knots.push(nSegs);

  const cps3D = allCPs.map(p => toWorld(p));
  return new NurbsCurve(degree, cps3D, knots);
}

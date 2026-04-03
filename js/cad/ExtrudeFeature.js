// js/cad/ExtrudeFeature.js — Extrude operation feature
// Extrudes a 2D sketch profile to create a 3D solid.
//
// Now produces exact B-Rep topology alongside the tessellated mesh,
// enabling STEP-quality export and exact boolean operations.

import { Feature } from './Feature.js';
import { booleanOp, calculateMeshVolume, calculateBoundingBox, computeFeatureEdges } from './CSG.js';
import { constrainedTriangulate } from './Tessellator2/CDT.js';
import { NurbsCurve } from './NurbsCurve.js';
import { NurbsSurface } from './NurbsSurface.js';
import {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody,
} from './BRepTopology.js';

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

    // Group profiles: outer profiles (non-holes) carry their hole children.
    // Each group is { outer: profile, holes: [profile, ...] }.
    const profileGroups = [];
    for (let i = 0; i < profiles.length; i++) {
      if (profiles[i].isHole) continue; // holes are attached to their parent
      const group = { outer: profiles[i], holes: [] };
      if (profiles[i].holes) {
        for (const hi of profiles[i].holes) {
          group.holes.push(profiles[hi]);
        }
      }
      profileGroups.push(group);
    }

    const profileGeometries = profileGroups.map((group) =>
      this.generateGeometry([group.outer], plane, group.holes));

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
   * Union a new body into an existing solid (used for multi-profile merging).
   */
  _unionBody(solid, geometry) {
    if (!solid || !solid.geometry) {
      if (geometry && geometry.faces) {
        for (const f of geometry.faces) {
          if (!f.shared) f.shared = { sourceFeatureId: this.id };
        }
        const edgeResult = computeFeatureEdges(geometry.faces);
        geometry.edges = edgeResult.edges;
        geometry.paths = edgeResult.paths;
        geometry.visualEdges = edgeResult.visualEdges;
      }
      return { geometry };
    }
    try {
      const resultGeom = booleanOp(solid.geometry, geometry, 'union',
        null, { sourceFeatureId: this.id });
      return { geometry: resultGeom };
    } catch (err) {
      console.warn('Multi-profile union failed:', err.message);
      return solid;
    }
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

  /**
   * Generate 3D geometry from sketch profiles.
   * @param {Array} profiles - Sketch profiles to extrude (outer boundaries)
   * @param {Object} plane - Sketch plane definition
   * @param {Array} [holes] - Hole profiles to subtract from the extrusion
   * @returns {Object} 3D geometry data
   */
  generateGeometry(profiles, plane, holes = []) {
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
    
    // Attach exact B-Rep alongside mesh
    try {
      geometry.topoBody = this.buildExactBrep(profiles, resolvedPlane, extrusionVector, planeFrame, baseOffset, tipOffset, holes);
    } catch (_) {
      // Exact B-Rep is best-effort; mesh is always the fallback
      geometry.topoBody = null;
    }

    return geometry;
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
            const halfIndex = Math.floor(spanIndices.length / 2);
            const circleHalves = [
              {
                startIdx: spanIndices[0],
                endIdx: spanIndices[halfIndex],
                tangentIdx: spanIndices[1] ?? spanIndices[0],
              },
              {
                startIdx: spanIndices[halfIndex],
                endIdx: spanIndices[0],
                tangentIdx: spanIndices[(halfIndex + 1) % spanIndices.length] ?? spanIndices[halfIndex],
              },
            ];

            for (const half of circleHalves) {
              const r0 = _sub(bottomVerts[half.startIdx], center3D);
              const r0Len = Math.sqrt(r0.x * r0.x + r0.y * r0.y + r0.z * r0.z);
              const xAx = r0Len > 1e-14 ? { x: r0.x / r0Len, y: r0.y / r0Len, z: r0.z / r0Len } : plane.xAxis;
              const positiveYAx = _normalize(_cross(extDir, xAx));
              const tangent = _normalize(_sub(bottomVerts[half.tangentIdx], bottomVerts[half.startIdx]));
              const yAx = _dot(tangent, positiveYAx) >= 0
                ? positiveYAx
                : { x: -positiveYAx.x, y: -positiveYAx.y, z: -positiveYAx.z };

              edgeInfos.push({
                type,
                startIdx: half.startIdx,
                endIdx: half.endIdx,
                spanIndices: [half.startIdx, half.endIdx],
                isArc: true,
                bottomCurve: NurbsCurve.createArc(center3D, range.radius, xAx, yAx, 0, Math.PI),
                topCurve: NurbsCurve.createArc(topCenter3D, range.radius, xAx, yAx, 0, Math.PI),
                cylSurf: NurbsSurface.createCylinder(center3D, extDir, range.radius, extHeight, xAx, yAx, 0, Math.PI),
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
          });
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
        if (info.isArc) {
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

    const addSideFaces = (profileData) => {
      for (const info of profileData.edgeInfos) {
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
            vertices = [...vertices].reverse();
            edgeCurves = edgeCurves.reverse();
          }

          faceDescs.push({
            surface: info.cylSurf,
            surfaceType: SurfaceType.CYLINDER,
            vertices,
            edgeCurves,
            shared: { sourceFeatureId: this.id },
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
      });

      addSideFaces(outerData);
      for (const holeProfile of holeData) {
        addSideFaces(holeProfile);
      }
    }

    return buildTopoBody(faceDescs);
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
        geometry.edges = edgeResult.edges;
        geometry.paths = edgeResult.paths;
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
      console.warn(`Boolean operation '${this.operation}' failed:`, err.message);
      // Preserve the previous solid rather than replacing it with the new geometry
      return solid;
    }
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

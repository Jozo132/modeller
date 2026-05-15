// js/cad/RevolveFeature.js — Revolve operation feature
// Revolves a 2D sketch profile around an axis to create 3D geometry.
//
// Now produces exact B-Rep topology alongside the tessellated mesh,
// enabling STEP-quality export and exact boolean operations.

import { Feature } from './Feature.js';
import { resolveSketchRevolveAxis } from './SketchFeature.js';
import { booleanOp } from './BooleanDispatch.js';
import { computeFeatureEdges } from './EdgeAnalysis.js';
import { calculateMeshVolume, calculateBoundingBox } from './toolkit/MeshAnalysis.js';
import { chainEdgePaths } from './toolkit/EdgePathUtils.js';
import { tryBuildOcctRevolveGeometrySync } from './occt/OcctSketchModeling.js';
import { NurbsCurve } from './NurbsCurve.js';
import { NurbsSurface } from './NurbsSurface.js';
import {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody, deriveEdgeAndVertexHashes,
} from './BRepTopology.js';

/**
 * RevolveFeature revolves a 2D sketch profile around an axis to create 3D geometry.
 */
export class RevolveFeature extends Feature {
  constructor(name = 'Revolve', sketchFeatureId = null, angle = Math.PI * 2) {
    super(name);
    this.type = 'revolve';
    
    // Reference to the sketch feature to revolve
    this.sketchFeatureId = sketchFeatureId;
    if (sketchFeatureId) {
      this.addDependency(sketchFeatureId);
    }
    
    // Revolve parameters
    this.angle = angle; // Angle in radians (2π = 360°)
    this.segments = 32; // Number of segments for approximation
    
    // Axis of revolution (in sketch plane coordinates)
    this.axis = {
      origin: { x: 0, y: 0 }, // Point on axis
      direction: { x: 0, y: 1 }, // Axis direction (typically vertical in sketch)
    };
    this.axisSegmentId = null;
    this.axisSource = 'default';
    
    // Operation mode
    this.operation = 'new'; // 'new', 'add', 'subtract', 'intersect'
  }

  /**
   * Execute the revolve operation.
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
    
    const { sketch, plane, profiles } = sketchResult;
    
    if (profiles.length === 0) {
      throw new Error('No closed profiles found in sketch');
    }

    this._refreshAxisFromSketch(sketch);
    const allowOcctModeling = this.operation === 'new' && profiles.length === 1;
    
    // Get the current solid (if any)
    let solid = this.getPreviousSolid(context);
    
    // Process each profile individually so multi-body sketches each get
    // a proper boolean operation against the accumulating solid.
    for (let pi = 0; pi < profiles.length; pi++) {
      const bodyGeom = this.generateGeometry([profiles[pi]], plane, { allowOcctModeling });
      if (pi === 0) {
        solid = this.applyOperation(solid, bodyGeom);
      } else {
        solid = this._unionBody(solid, bodyGeom);
      }
    }

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
   * Generate 3D geometry from sketch profiles by revolution.
   * @param {Array} profiles - Sketch profiles to revolve
   * @param {Object} plane - Sketch plane definition
   * @param {Object} options - Generation options
   * @returns {Object} 3D geometry data
   */
  generateGeometry(profiles, plane, options = {}) {
    const geometry = {
      vertices: [],
      faces: [],
      edges: [],
    };
    
    // For each profile, create revolution surface
    for (const profile of profiles) {
      const profileVertices = [];
      
      // Generate vertices for each angular segment
      for (let seg = 0; seg <= this.segments; seg++) {
        const theta = (seg / this.segments) * this.angle;
        const ringVertices = [];
        
        for (const point of profile.points) {
          // Calculate distance from revolution axis
          const axisPoint = this.projectPointOnAxis(point);
          const radius = Math.hypot(point.x - axisPoint.x, point.y - axisPoint.y);
          const height = this.getAxisCoordinate(point);
          
          // Revolve point around axis
          const vertex3D = this.revolvePoint(radius, height, theta, plane);
          ringVertices.push(vertex3D);
          geometry.vertices.push(vertex3D);
        }
        
        profileVertices.push(ringVertices);
      }
      
      // Create faces between consecutive rings
      for (let seg = 0; seg < this.segments; seg++) {
        const currentRing = profileVertices[seg];
        const nextRing = profileVertices[seg + 1];
        
        for (let i = 0; i < currentRing.length; i++) {
          const nextI = (i + 1) % currentRing.length;
          
          // Create quad face (or two triangles)
          const face = {
            vertices: [
              currentRing[i],
              nextRing[i],
              nextRing[nextI],
              currentRing[nextI],
            ],
          };
          
          // Calculate face normal
          face.normal = this.calculateFaceNormal(face.vertices);
          geometry.faces.push(face);
        }
      }
      
      // If not a full revolution, add end caps
      if (Math.abs(this.angle - Math.PI * 2) > 0.01) {
        // Start cap
        geometry.faces.push({
          vertices: profileVertices[0],
          normal: this.calculateFaceNormal(profileVertices[0]),
        });
        
        // End cap
        geometry.faces.push({
          vertices: profileVertices[this.segments].reverse(),
          normal: this.calculateFaceNormal(profileVertices[this.segments]),
        });
      }
    }
    
    // Attach exact B-Rep alongside mesh
    try {
      geometry.topoBody = this.buildExactBrep(profiles, plane);
    } catch (_) {
      geometry.topoBody = null;
    }

    const occtGeometry = options.allowOcctModeling === true
      ? tryBuildOcctRevolveGeometrySync({
        profile: profiles[0] || null,
        plane,
        angleRadians: this.angle,
        axisOrigin: this.axis.origin,
        axisDirection: this.getNormalizedAxisDirection2D(),
        topoBody: geometry.topoBody,
        sketchToWorld: (point, planeDef) => this.sketchToWorld(point, planeDef),
        sketchVectorToWorld: (vector, planeDef) => this.sketchVectorToWorld(vector, planeDef),
      })
      : null;
    if (occtGeometry) return occtGeometry;

    return geometry;
  }

  /**
   * Build an exact B-Rep TopoBody for this revolution.
   *
   * Produces:
   *   - revolution surface faces for each profile edge
   *   - planar cap faces for partial revolves
   *   - exact seam edges for closed revolves
   *
   * @param {Array} profiles - Sketch profiles
   * @param {Object} plane - Sketch plane definition
   * @returns {import('./BRepTopology.js').TopoBody}
   */
  buildExactBrep(profiles, plane) {
    const faceDescs = [];
    const isFullRevolution = Math.abs(Math.abs(this.angle) - Math.PI * 2) < 0.01;
    const axisFrame = this.resolveAxisFrame(plane);

    for (let profileIndex = 0; profileIndex < profiles.length; profileIndex++) {
      const profile = profiles[profileIndex];
      const edgeRanges = _buildEdgeRanges(profile.edges, profile.points.length);

      // Build rings of 3D vertices at start and end of revolution
      const startRing = profile.points.map((point) => this.revolveSketchPoint(point, 0, plane, axisFrame));
      const endRing = profile.points.map((point) => this.revolveSketchPoint(point, this.angle, plane, axisFrame));

      for (let edgeIndex = 0; edgeIndex < edgeRanges.length; edgeIndex++) {
        const range = edgeRanges[edgeIndex];
        let exactFaces = null;

        if (range.type === 'segment') {
          exactFaces = this._buildExactSegmentRevolveFaceDescs(
            profile,
            range,
            profileIndex,
            edgeIndex,
            plane,
            axisFrame,
            isFullRevolution,
          );
        } else {
          exactFaces = this._buildExactCurveRevolveFaceDescs(
            range,
            profileIndex,
            edgeIndex,
            plane,
            axisFrame,
            isFullRevolution,
          );
        }

        if (exactFaces && exactFaces.length > 0) {
          faceDescs.push(...exactFaces);
          continue;
        }

        faceDescs.push(
          ...this._buildFallbackRevolveFaceDescs(
            profile,
            range,
            profileIndex,
            edgeIndex,
            plane,
            axisFrame,
          )
        );
      }

      // Cap faces for partial revolves
      if (!isFullRevolution) {
        // Start cap
        faceDescs.push({
          surface: null,
          surfaceType: SurfaceType.PLANE,
          vertices: startRing,
          edgeCurves: startRing.map((v, i) =>
            NurbsCurve.createLine(v, startRing[(i + 1) % startRing.length])),
          shared: { sourceFeatureId: this.id },
          stableHash: `${this.id}_Face_CapStart_p${profileIndex}`,
        });

        // End cap
        faceDescs.push({
          surface: null,
          surfaceType: SurfaceType.PLANE,
          vertices: [...endRing].reverse(),
          edgeCurves: [...endRing].reverse().map((v, i, arr) =>
            NurbsCurve.createLine(v, arr[(i + 1) % arr.length])),
          shared: { sourceFeatureId: this.id },
          stableHash: `${this.id}_Face_CapEnd_p${profileIndex}`,
        });
      }
    }

    const body = buildTopoBody(faceDescs);
    deriveEdgeAndVertexHashes(body);
    return body;
  }

  _buildExactSegmentRevolveFaceDescs(profile, range, profileIndex, edgeIndex, plane, axisFrame, isFullRevolution) {
    const p0 = profile.points[range.startIdx];
    const p1 = profile.points[range.endIdx];
    const start = this._describeRevolvePoint(p0, plane, axisFrame);
    const end = this._describeRevolvePoint(p1, plane, axisFrame);
    const baseHash = `${this.id}_Face_Revolve_p${profileIndex}_e${edgeIndex}`;

    if (Math.abs(start.height - end.height) < REVOLVE_EPS) {
      return this._buildPlanarRevolveFaceDescs(start, end, baseHash, axisFrame, isFullRevolution);
    }

    if (Math.abs(start.signedRadius - end.signedRadius) < REVOLVE_EPS && start.radius > REVOLVE_EPS) {
      return this._buildCylindricalRevolveFaceDescs(start, end, baseHash, axisFrame, isFullRevolution);
    }

    if (start.radius < REVOLVE_EPS && end.radius < REVOLVE_EPS) {
      return [];
    }

    // A line segment that crosses the axis mid-span does not map cleanly onto
    // a single rectangular cone patch. Split it at the axis and emit two
    // analytic cone patches instead of falling back to ruled quads.
    if (start.signedRadius * end.signedRadius < -REVOLVE_EPS) {
      return this._buildAxisCrossingSegmentRevolveFaceDescs(
        profile,
        range,
        start,
        end,
        baseHash,
        plane,
        axisFrame,
        isFullRevolution,
      );
    }

    return this._buildConicalRevolveFaceDescs(
      profile,
      range,
      start,
      end,
      baseHash,
      plane,
      axisFrame,
      isFullRevolution,
    );
  }

  _buildPlanarRevolveFaceDescs(start, end, baseHash, axisFrame, isFullRevolution) {
    const spansAxis = this._segmentSpansAxis(start, end);
    const outerRadius = Math.max(start.radius, end.radius);
    const innerRadius = spansAxis ? 0 : Math.min(start.radius, end.radius);
    const outerSample = start.radius >= end.radius ? start : end;
    const frame = this._selectFaceFrame(outerSample, start.radius > end.radius ? end : start, axisFrame);
    const directionSign = Math.sign(this.angle || 1);

    if (outerRadius < REVOLVE_EPS) {
      return [];
    }

    if (isFullRevolution) {
      const outerLoop = this._buildFullCircleLoop(start.height, outerRadius, 4, frame, axisFrame, directionSign, false);
      const faceDesc = {
        surface: NurbsSurface.createPlane(
          outerLoop.vertices[0],
          _sub3(outerLoop.vertices[1], outerLoop.vertices[0]),
          _sub3(outerLoop.vertices[outerLoop.vertices.length - 1], outerLoop.vertices[0]),
        ),
        surfaceType: SurfaceType.PLANE,
        vertices: outerLoop.vertices,
        edgeCurves: outerLoop.edgeCurves,
        shared: { sourceFeatureId: this.id },
        stableHash: baseHash,
      };

      if (innerRadius > REVOLVE_EPS) {
        faceDesc.innerLoops = [
          this._buildFullCircleLoop(start.height, innerRadius, 4, frame, axisFrame, directionSign, true),
        ];
      }

      return [faceDesc];
    }

    const startInner = innerRadius > REVOLVE_EPS
      ? this._pointOnRevolveFrame(innerRadius, start.height, 0, frame, axisFrame)
      : this._axisPointAtHeight(start.height, axisFrame);
    const startOuter = this._pointOnRevolveFrame(outerRadius, start.height, 0, frame, axisFrame);
    const endOuter = this._pointOnRevolveFrame(outerRadius, start.height, this.angle, frame, axisFrame);
    const endInner = innerRadius > REVOLVE_EPS
      ? this._pointOnRevolveFrame(innerRadius, start.height, this.angle, frame, axisFrame)
      : this._axisPointAtHeight(start.height, axisFrame);

    const vertices = innerRadius > REVOLVE_EPS
      ? [startInner, startOuter, endOuter, endInner]
      : [startInner, startOuter, endOuter];
    const edgeCurves = innerRadius > REVOLVE_EPS
      ? [
        NurbsCurve.createLine(startInner, startOuter),
        this._makeRevolveArc(start.height, outerRadius, frame, axisFrame, 0, this.angle),
        NurbsCurve.createLine(endOuter, endInner),
        this._makeRevolveArc(start.height, innerRadius, frame, axisFrame, this.angle, -this.angle),
      ]
      : [
        NurbsCurve.createLine(startInner, startOuter),
        this._makeRevolveArc(start.height, outerRadius, frame, axisFrame, 0, this.angle),
        NurbsCurve.createLine(endOuter, endInner),
      ];

    return [{
      surface: NurbsSurface.createPlane(
        vertices[0],
        _sub3(vertices[1], vertices[0]),
        _sub3(vertices[vertices.length - 1], vertices[0]),
      ),
      surfaceType: SurfaceType.PLANE,
      vertices,
      edgeCurves,
      shared: { sourceFeatureId: this.id },
      stableHash: baseHash,
    }];
  }

  _buildCylindricalRevolveFaceDescs(start, end, baseHash, axisFrame, isFullRevolution) {
    const frame = this._selectFaceFrame(start, end, axisFrame);
    const radius = start.radius;

    if (radius < REVOLVE_EPS) {
      return [];
    }

    if (isFullRevolution) {
      const sliceSweep = Math.sign(this.angle || 1) * (Math.PI / 2);
      const faces = [];
      for (let sliceIndex = 0; sliceIndex < 4; sliceIndex++) {
        faces.push(this._createRevolveSideSliceFaceDesc(
          start,
          end,
          frame,
          axisFrame,
          SurfaceType.CYLINDER,
          {
            surface: NurbsSurface.createCylinder(
              start.axisWorldPoint,
              axisFrame.axisWorld,
              radius,
              end.height - start.height,
              frame.xDir,
              frame.yDir,
              sliceIndex * sliceSweep,
              sliceSweep,
            ),
            surfaceInfo: {
              type: 'cylinder',
              origin: start.axisWorldPoint,
              axis: axisFrame.axisWorld,
              xDir: frame.xDir,
              yDir: frame.yDir,
              radius,
            },
          },
          sliceIndex * sliceSweep,
          sliceSweep,
          `${baseHash}_s${sliceIndex}`,
        ));
      }
      return faces;
    }

    return [this._createRevolveSideSliceFaceDesc(
      start,
      end,
      frame,
      axisFrame,
      SurfaceType.CYLINDER,
      {
        surface: NurbsSurface.createCylinder(
          start.axisWorldPoint,
          axisFrame.axisWorld,
          radius,
          end.height - start.height,
          frame.xDir,
          frame.yDir,
          0,
          this.angle,
        ),
        surfaceInfo: {
          type: 'cylinder',
          origin: start.axisWorldPoint,
          axis: axisFrame.axisWorld,
          xDir: frame.xDir,
          yDir: frame.yDir,
          radius,
        },
      },
      0,
      this.angle,
      baseHash,
    )];
  }

  _buildAxisCrossingSegmentRevolveFaceDescs(profile, range, start, end, baseHash, plane, axisFrame, isFullRevolution) {
    const denom = start.signedRadius - end.signedRadius;
    if (Math.abs(denom) < REVOLVE_EPS) {
      return null;
    }

    const t = start.signedRadius / denom;
    if (t <= REVOLVE_EPS || t >= 1 - REVOLVE_EPS) {
      return null;
    }

    const splitHeight = start.height + (end.height - start.height) * t;
    const splitPoint = {
      height: splitHeight,
      signedRadius: 0,
      radius: 0,
      axisWorldPoint: this._axisPointAtHeight(splitHeight, axisFrame),
      worldPoint: this._axisPointAtHeight(splitHeight, axisFrame),
      radialWorld: null,
    };

    const halves = [
      { start, end: splitPoint, stableHash: `${baseHash}_a` },
      { start: splitPoint, end, stableHash: `${baseHash}_b` },
    ];
    const faces = [];

    for (const half of halves) {
      const heightDelta = half.end.height - half.start.height;
      if (Math.abs(heightDelta) < REVOLVE_EPS) {
        continue;
      }

      const frame = this._selectFaceFrame(half.start, half.end, axisFrame);
      const semiAngle = Math.atan2(half.end.radius - half.start.radius, heightDelta);
      const surfaceInfo = {
        type: 'cone',
        origin: half.start.axisWorldPoint,
        axis: axisFrame.axisWorld,
        xDir: frame.xDir,
        yDir: frame.yDir,
        radius: half.start.radius,
        semiAngle,
      };
      const sameSense = this._computeConeSameSense(profile, range, plane, frame, axisFrame, semiAngle);

      if (isFullRevolution) {
        const sliceSweep = Math.sign(this.angle || 1) * (Math.PI / 2);
        for (let sliceIndex = 0; sliceIndex < 4; sliceIndex++) {
          faces.push(this._createRevolveSideSliceFaceDesc(
            half.start,
            half.end,
            frame,
            axisFrame,
            SurfaceType.CONE,
            { surface: null, surfaceInfo, sameSense },
            sliceIndex * sliceSweep,
            sliceSweep,
            `${half.stableHash}_s${sliceIndex}`,
          ));
        }
        continue;
      }

      faces.push(this._createRevolveSideSliceFaceDesc(
        half.start,
        half.end,
        frame,
        axisFrame,
        SurfaceType.CONE,
        { surface: null, surfaceInfo, sameSense },
        0,
        this.angle,
        half.stableHash,
      ));
    }

    return faces;
  }

  _buildConicalRevolveFaceDescs(profile, range, start, end, baseHash, plane, axisFrame, isFullRevolution) {
    const frame = this._selectFaceFrame(start, end, axisFrame);
    const heightDelta = end.height - start.height;

    if (Math.abs(heightDelta) < REVOLVE_EPS) {
      return null;
    }

    const surfaceInfo = {
      type: 'cone',
      origin: start.axisWorldPoint,
      axis: axisFrame.axisWorld,
      xDir: frame.xDir,
      yDir: frame.yDir,
      radius: start.radius,
      semiAngle: Math.atan2(end.radius - start.radius, heightDelta),
    };
    const sameSense = this._computeConeSameSense(profile, range, plane, frame, axisFrame, surfaceInfo.semiAngle);

    if (isFullRevolution) {
      const sliceSweep = Math.sign(this.angle || 1) * (Math.PI / 2);
      const faces = [];
      for (let sliceIndex = 0; sliceIndex < 4; sliceIndex++) {
        faces.push(this._createRevolveSideSliceFaceDesc(
          start,
          end,
          frame,
          axisFrame,
          SurfaceType.CONE,
          { surface: null, surfaceInfo, sameSense },
          sliceIndex * sliceSweep,
          sliceSweep,
          `${baseHash}_s${sliceIndex}`,
        ));
      }
      return faces;
    }

    return [this._createRevolveSideSliceFaceDesc(
      start,
      end,
      frame,
      axisFrame,
      SurfaceType.CONE,
      { surface: null, surfaceInfo, sameSense },
      0,
      this.angle,
      baseHash,
    )];
  }

  _createRevolveSideSliceFaceDesc(start, end, frame, axisFrame, surfaceType, surfaceData, startAngle, sweepAngle, stableHash) {
    const hasStartCircle = start.radius > REVOLVE_EPS;
    const hasEndCircle = end.radius > REVOLVE_EPS;
    const startAt0 = hasStartCircle
      ? this._pointOnRevolveFrame(start.radius, start.height, startAngle, frame, axisFrame)
      : this._axisPointAtHeight(start.height, axisFrame);
    const startAt1 = hasStartCircle
      ? this._pointOnRevolveFrame(start.radius, start.height, startAngle + sweepAngle, frame, axisFrame)
      : this._axisPointAtHeight(start.height, axisFrame);
    const endAt0 = hasEndCircle
      ? this._pointOnRevolveFrame(end.radius, end.height, startAngle, frame, axisFrame)
      : this._axisPointAtHeight(end.height, axisFrame);
    const endAt1 = hasEndCircle
      ? this._pointOnRevolveFrame(end.radius, end.height, startAngle + sweepAngle, frame, axisFrame)
      : this._axisPointAtHeight(end.height, axisFrame);

    let vertices;
    let edgeCurves;
    if (!hasStartCircle) {
      vertices = [startAt0, endAt0, endAt1];
      edgeCurves = [
        NurbsCurve.createLine(startAt0, endAt0),
        this._makeRevolveArc(end.height, end.radius, frame, axisFrame, startAngle, sweepAngle),
        NurbsCurve.createLine(endAt1, startAt0),
      ];
    } else if (!hasEndCircle) {
      vertices = [startAt0, startAt1, endAt0];
      edgeCurves = [
        this._makeRevolveArc(start.height, start.radius, frame, axisFrame, startAngle, sweepAngle),
        NurbsCurve.createLine(startAt1, endAt0),
        NurbsCurve.createLine(endAt0, startAt0),
      ];
    } else {
      vertices = [startAt0, startAt1, endAt1, endAt0];
      edgeCurves = [
        this._makeRevolveArc(start.height, start.radius, frame, axisFrame, startAngle, sweepAngle),
        NurbsCurve.createLine(startAt1, endAt1),
        this._makeRevolveArc(end.height, end.radius, frame, axisFrame, startAngle + sweepAngle, -sweepAngle),
        NurbsCurve.createLine(endAt0, startAt0),
      ];
    }

    return {
      surface: surfaceData.surface,
      surfaceType,
      vertices,
      edgeCurves,
      shared: { sourceFeatureId: this.id },
      surfaceInfo: surfaceData.surfaceInfo,
      sameSense: surfaceData.sameSense,
      stableHash,
    };
  }

  _buildExactCurveRevolveFaceDescs(range, profileIndex, edgeIndex, plane, axisFrame, isFullRevolution) {
    const curveParts = this._buildCurveRevolveSourceParts(range, plane, axisFrame);
    if (!curveParts || curveParts.length === 0) {
      return null;
    }

    const baseHash = `${this.id}_Face_Revolve_p${profileIndex}_e${edgeIndex}`;
    const faceDescs = [];
    const sliceDefs = isFullRevolution
      ? _buildRevolveSliceDefs(this.angle, 4)
      : [{ startAngle: 0, sweepAngle: this.angle, suffix: '' }];

    for (let curveIndex = 0; curveIndex < curveParts.length; curveIndex++) {
      const curve = curveParts[curveIndex];
      const curveSuffix = curveParts.length > 1 ? `_c${curveIndex}` : '';

      for (const slice of sliceDefs) {
        const faceDesc = this._createCurveRevolveFaceDesc(
          curve,
          axisFrame,
          slice.startAngle,
          slice.sweepAngle,
          `${baseHash}${curveSuffix}${slice.suffix}`,
        );
        if (faceDesc) {
          faceDescs.push(faceDesc);
        }
      }
    }

    return faceDescs;
  }

  _createCurveRevolveFaceDesc(sourceCurve, axisFrame, startAngle, sweepAngle, stableHash) {
    const surface = NurbsSurface.createRevolvedSurface(
      sourceCurve,
      axisFrame.originWorld,
      axisFrame.axisWorld,
      axisFrame.perpWorld,
      axisFrame.normalWorld,
      startAngle,
      sweepAngle,
    );
    const startCurve = _rotateCurveAroundAxis(sourceCurve, axisFrame, startAngle);
    const endCurve = _rotateCurveAroundAxis(sourceCurve, axisFrame, startAngle + sweepAngle);

    const startAt0 = startCurve.evaluate(startCurve.uMin);
    const endAt0 = startCurve.evaluate(startCurve.uMax);
    const endAt1 = endCurve.evaluate(endCurve.uMax);
    const startAt1 = endCurve.evaluate(endCurve.uMin);
    const startDesc = this._describeWorldRevolvePoint(startAt0, axisFrame);
    const endDesc = this._describeWorldRevolvePoint(endAt0, axisFrame);
    const startMeridian = this._makeWorldRevolveCurve(startDesc, axisFrame, startAngle, sweepAngle);
    const endMeridian = this._makeWorldRevolveCurve(endDesc, axisFrame, startAngle, sweepAngle);

    let vertices;
    let edgeCurves;
    if (!startMeridian && !endMeridian) {
      return null;
    }
    if (!startMeridian) {
      vertices = [startAt0, endAt0, endAt1];
      edgeCurves = [
        startCurve,
        endMeridian,
        endCurve.reversed(),
      ];
    } else if (!endMeridian) {
      vertices = [startAt0, endAt0, startAt1];
      edgeCurves = [
        startCurve,
        endCurve.reversed(),
        startMeridian.reversed(),
      ];
    } else {
      vertices = [startAt0, endAt0, endAt1, startAt1];
      edgeCurves = [
        startCurve,
        endMeridian,
        endCurve.reversed(),
        startMeridian.reversed(),
      ];
    }

    return {
      surface,
      surfaceType: SurfaceType.BSPLINE,
      vertices,
      edgeCurves,
      shared: { sourceFeatureId: this.id },
      stableHash,
    };
  }

  _buildCurveRevolveSourceParts(range, plane, axisFrame) {
    const sourceCurve = this._buildRangeSourceCurve(range, plane);
    if (!sourceCurve) {
      return null;
    }

    let parts = [sourceCurve];
    if (_curveIsClosed(sourceCurve) || range.type === 'circle') {
      const splitCount = _getClosedCurveSplitCount(range, sourceCurve);
      const split = sourceCurve.splitUniform(splitCount);
      if (split && split.length === splitCount) {
        parts = split;
      }
    }

    const finalParts = [];
    for (const part of parts) {
      const rootSplitParts = _splitCurveAtAxisRoots(part, axisFrame);
      for (const rootPart of rootSplitParts) {
        const boundaryParts = _splitDoubleAxisCurvePart(rootPart, axisFrame);
        for (const boundaryPart of boundaryParts) {
          if (!_curveIsDegenerate(boundaryPart)) {
            finalParts.push(boundaryPart);
          }
        }
      }
    }

    return finalParts;
  }

  _buildRangeSourceCurve(range, plane) {
    const toWorld = (point) => this.sketchToWorld(point, plane);
    if ((range.type === 'arc' || range.type === 'circle') && range.center && range.radius) {
      const centerWorld = this.sketchToWorld(range.center, plane);
      if (range.type === 'circle') {
        return NurbsCurve.createCircle(centerWorld, range.radius, plane.xAxis, plane.yAxis);
      }
      return NurbsCurve.createArc(
        centerWorld,
        range.radius,
        plane.xAxis,
        plane.yAxis,
        range.startAngle || 0,
        range.sweepAngle || 0,
      );
    }
    if (range.type === 'spline' && range.controlPoints2D && range.knots) {
      return _spline2Dto3D(range.controlPoints2D, range.degree, range.knots, toWorld);
    }
    if (range.type === 'bezier' && range.bezierVertices) {
      return _bezierVertices2Dto3D(range.bezierVertices, toWorld);
    }
    return null;
  }

  _buildFallbackRevolveFaceDescs(profile, range, profileIndex, edgeIndex, plane, axisFrame) {
    const faceDescs = [];
    const nPts = profile.points.length;
    const baseHash = `${this.id}_Face_Revolve_p${profileIndex}_e${edgeIndex}`;

    let spanIndex = 0;
    let current = range.startIdx;
    while (current !== range.endIdx) {
      const next = (current + 1) % nPts;
      const p00 = this.revolveSketchPoint(profile.points[current], 0, plane, axisFrame);
      const p01 = this.revolveSketchPoint(profile.points[current], this.angle, plane, axisFrame);
      const p10 = this.revolveSketchPoint(profile.points[next], 0, plane, axisFrame);
      const p11 = this.revolveSketchPoint(profile.points[next], this.angle, plane, axisFrame);

      faceDescs.push({
        surface: NurbsSurface.createPlane(
          p00,
          _sub3(p10, p00),
          _sub3(p01, p00),
        ),
        surfaceType: SurfaceType.REVOLUTION,
        vertices: [p00, p10, p11, p01],
        edgeCurves: [
          NurbsCurve.createLine(p00, p10),
          NurbsCurve.createLine(p10, p11),
          NurbsCurve.createLine(p11, p01),
          NurbsCurve.createLine(p01, p00),
        ],
        shared: { sourceFeatureId: this.id },
        stableHash: `${baseHash}_t${spanIndex}`,
      });

      current = next;
      spanIndex++;
    }

    return faceDescs;
  }

  _buildFullCircleLoop(height, radius, segments, frame, axisFrame, directionSign, reverse = false) {
    const sweep = directionSign * (Math.PI * 2 / segments);
    const vertices = [];
    const edgeCurves = [];
    const angles = [];

    for (let index = 0; index < segments; index++) {
      angles.push(index * sweep);
    }

    if (reverse) {
      angles.reverse();
    }

    for (let index = 0; index < angles.length; index++) {
      const angle = angles[index];
      const nextAngle = index === angles.length - 1 ? angles[0] + directionSign * Math.PI * 2 : angles[index + 1];
      vertices.push(this._pointOnRevolveFrame(radius, height, angle, frame, axisFrame));
      edgeCurves.push(this._makeRevolveArc(height, radius, frame, axisFrame, angle, nextAngle - angle));
    }

    return { vertices, edgeCurves };
  }

  _describeRevolvePoint(point, plane, axisFrame) {
    const height = this.getAxisCoordinate(point);
    const signedRadius = this.getSignedRadius(point);
    const axisWorldPoint = this._axisPointAtHeight(height, axisFrame);
    const worldPoint = this.revolvePoint(signedRadius, height, 0, plane, axisFrame);
    const radialVector = _sub3(worldPoint, axisWorldPoint);
    const radius = Math.abs(signedRadius);

    return {
      point,
      height,
      signedRadius,
      radius,
      axisWorldPoint,
      worldPoint,
      radialWorld: radius > REVOLVE_EPS ? _normalize3(radialVector) : null,
    };
  }

  _describeWorldRevolvePoint(worldPoint, axisFrame) {
    const rel = _sub3(worldPoint, axisFrame.originWorld);
    const height = _dot3(rel, axisFrame.axisWorld);
    const signedRadius = _dot3(rel, axisFrame.perpWorld);
    const axisWorldPoint = this._axisPointAtHeight(height, axisFrame);
    const radialVector = _sub3(worldPoint, axisWorldPoint);
    const radius = Math.hypot(radialVector.x, radialVector.y, radialVector.z);

    return {
      height,
      signedRadius,
      radius,
      axisWorldPoint,
      worldPoint,
      radialWorld: radius > REVOLVE_EPS ? _normalize3(radialVector) : null,
    };
  }

  _selectFaceFrame(primarySample, secondarySample, axisFrame) {
    const sample = primarySample.radius > REVOLVE_EPS ? primarySample : secondarySample;
    const xDir = sample && sample.radialWorld ? sample.radialWorld : axisFrame.perpWorld;
    const yDir = _normalize3(_cross3(xDir, axisFrame.axisWorld));
    return { xDir, yDir };
  }

  _segmentSpansAxis(start, end) {
    return Math.abs(start.signedRadius) < REVOLVE_EPS
      || Math.abs(end.signedRadius) < REVOLVE_EPS
      || start.signedRadius * end.signedRadius < 0;
  }

  _pointOnRevolveFrame(radius, height, theta, frame, axisFrame) {
    const center = this._axisPointAtHeight(height, axisFrame);
    const radialDir = _add3(
      _scale3(frame.xDir, Math.cos(theta)),
      _scale3(frame.yDir, Math.sin(theta)),
    );
    return _add3(center, _scale3(radialDir, radius));
  }

  _axisPointAtHeight(height, axisFrame) {
    return _add3(axisFrame.originWorld, _scale3(axisFrame.axisWorld, height));
  }

  _makeRevolveArc(height, radius, frame, axisFrame, startAngle, sweepAngle) {
    const center = this._axisPointAtHeight(height, axisFrame);
    return NurbsCurve.createArc(center, radius, frame.xDir, frame.yDir, startAngle, sweepAngle);
  }

  _makeWorldRevolveCurve(pointDesc, axisFrame, startAngle, sweepAngle) {
    if (!pointDesc || pointDesc.radius < REVOLVE_EPS) {
      return null;
    }
    const xDir = pointDesc.radialWorld || axisFrame.perpWorld;
    const yDir = _normalize3(_cross3(xDir, axisFrame.axisWorld));
    return NurbsCurve.createArc(pointDesc.axisWorldPoint, pointDesc.radius, xDir, yDir, 0, sweepAngle);
  }

  _computeConeSameSense(profile, range, plane, frame, axisFrame, semiAngle) {
    const p0 = profile.points[range.startIdx];
    const p1 = profile.points[range.endIdx];
    const orientation = _profileOrientation(profile.points);
    const tangent = { x: p1.x - p0.x, y: p1.y - p0.y };
    const outward2D = orientation >= 0
      ? { x: tangent.y, y: -tangent.x }
      : { x: -tangent.y, y: tangent.x };
    const outward3D = _normalize3(this.sketchVectorToWorld(outward2D, plane));
    const surfaceNormal = _normalize3({
      x: frame.xDir.x * Math.cos(semiAngle) - axisFrame.axisWorld.x * Math.sin(semiAngle),
      y: frame.xDir.y * Math.cos(semiAngle) - axisFrame.axisWorld.y * Math.sin(semiAngle),
      z: frame.xDir.z * Math.cos(semiAngle) - axisFrame.axisWorld.z * Math.sin(semiAngle),
    });
    return _dot3(surfaceNormal, outward3D) >= 0;
  }

  resolveAxisFrame(plane) {
    const axisDir2D = this.getNormalizedAxisDirection2D();
    const axisPerp2D = { x: axisDir2D.y, y: -axisDir2D.x };
    return {
      axisDir2D,
      axisPerp2D,
      axisWorld: _normalize3(this.sketchVectorToWorld(axisDir2D, plane)),
      perpWorld: _normalize3(this.sketchVectorToWorld(axisPerp2D, plane)),
      normalWorld: _normalize3(plane.normal || { x: 0, y: 0, z: 1 }),
      originWorld: this.sketchToWorld(this.axis.origin, plane),
    };
  }

  getNormalizedAxisDirection2D() {
    const axisLength = Math.hypot(this.axis.direction.x, this.axis.direction.y);
    if (axisLength < REVOLVE_EPS) {
      return { x: 0, y: 1 };
    }
    return {
      x: this.axis.direction.x / axisLength,
      y: this.axis.direction.y / axisLength,
    };
  }

  /**
   * Project a point onto the revolution axis.
   * @param {Object} point - 2D point in sketch space
   * @returns {Object} Projected point on axis
   */
  projectPointOnAxis(point) {
    const axisDirection = this.getNormalizedAxisDirection2D();
    const dx = point.x - this.axis.origin.x;
    const dy = point.y - this.axis.origin.y;
    const dot = dx * axisDirection.x + dy * axisDirection.y;

    return {
      x: this.axis.origin.x + dot * axisDirection.x,
      y: this.axis.origin.y + dot * axisDirection.y,
    };
  }

  /**
   * Get the coordinate along the revolution axis.
   * @param {Object} point - 2D point in sketch space
   * @returns {number} Coordinate along axis
   */
  getAxisCoordinate(point) {
    const axisDirection = this.getNormalizedAxisDirection2D();
    const dx = point.x - this.axis.origin.x;
    const dy = point.y - this.axis.origin.y;
    return dx * axisDirection.x + dy * axisDirection.y;
  }

  getSignedRadius(point) {
    const axisDirection = this.getNormalizedAxisDirection2D();
    const axisPerp = { x: axisDirection.y, y: -axisDirection.x };
    const dx = point.x - this.axis.origin.x;
    const dy = point.y - this.axis.origin.y;
    return dx * axisPerp.x + dy * axisPerp.y;
  }

  sketchToWorld(point, plane) {
    return {
      x: plane.origin.x + point.x * plane.xAxis.x + point.y * plane.yAxis.x,
      y: plane.origin.y + point.x * plane.xAxis.y + point.y * plane.yAxis.y,
      z: plane.origin.z + point.x * plane.xAxis.z + point.y * plane.yAxis.z,
    };
  }

  sketchVectorToWorld(vector, plane) {
    return {
      x: vector.x * plane.xAxis.x + vector.y * plane.yAxis.x,
      y: vector.x * plane.xAxis.y + vector.y * plane.yAxis.y,
      z: vector.x * plane.xAxis.z + vector.y * plane.yAxis.z,
    };
  }

  revolveSketchPoint(point, theta, plane, axisFrame = null) {
    const height = this.getAxisCoordinate(point);
    const signedRadius = this.getSignedRadius(point);
    return this.revolvePoint(signedRadius, height, theta, plane, axisFrame);
  }

  /**
   * Revolve a point at given radius and height by angle theta.
   * @param {number} radius - Signed distance from axis in sketch space
   * @param {number} height - Position along axis
   * @param {number} theta - Revolution angle
   * @param {Object} plane - Sketch plane definition
   * @returns {Object} 3D point
   */
  revolvePoint(radius, height, theta, plane, axisFrame = null) {
    const frame = axisFrame || this.resolveAxisFrame(plane);
    const center = this._axisPointAtHeight(height, frame);
    return _add3(
      center,
      _add3(
        _scale3(frame.perpWorld, radius * Math.cos(theta)),
        _scale3(frame.normalWorld, radius * Math.sin(theta)),
      ),
    );
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
      // Compute feature edges and face groups for the initial geometry
      if (geometry && geometry.faces) {
        const edgeResult = computeFeatureEdges(geometry.faces);
        const useOcctEdges = geometry._occtModeling?.authoritative === true
          && Array.isArray(geometry.edges)
          && geometry.edges.length > 0;
        geometry.edges = useOcctEdges ? geometry.edges : edgeResult.edges;
        geometry.paths = useOcctEdges ? chainEdgePaths(geometry.edges) : edgeResult.paths;
        geometry.visualEdges = edgeResult.visualEdges;
      }
      return { geometry };
    }

    const prevGeom = solid.geometry;
    if (!prevGeom || !prevGeom.faces || prevGeom.faces.length === 0) {
      return { geometry };
    }

    try {
      const resultGeom = booleanOp(prevGeom, geometry, this.operation);
      return { geometry: resultGeom };
    } catch (err) {
      console.warn(`Boolean operation '${this.operation}' failed:`, err.message);
      // Preserve the previous solid rather than replacing it with the new geometry
      return solid;
    }
  }

  /**
   * Union a new body into an existing solid (used for multi-profile merging).
   */
  _unionBody(solid, geometry) {
    if (!solid || !solid.geometry) {
      if (geometry && geometry.faces) {
        const edgeResult = computeFeatureEdges(geometry.faces);
        geometry.edges = edgeResult.edges;
        geometry.paths = edgeResult.paths;
        geometry.visualEdges = edgeResult.visualEdges;
      }
      return { geometry };
    }
    try {
      const resultGeom = booleanOp(solid.geometry, geometry, 'union');
      return { geometry: resultGeom };
    } catch (err) {
      console.warn('Multi-profile union failed:', err.message);
      return solid;
    }
  }

  /**
   * Calculate volume of the revolved geometry (approximate).
   * TODO: Implement accurate volume calculation using Pappus's centroid theorem
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
   * Set the sketch feature to revolve.
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
   * Set the revolution angle.
   * @param {number} angle - Angle in radians
   */
  setAngle(angle) {
    this.angle = angle;
    this.modified = new Date();
  }

  _assignAxis(origin, direction, source = this.axisSource, touchModified = false) {
    this.axis.origin = { ...origin };
    this.axis.direction = { ...direction };
    this.axisSource = source;
    if (touchModified) {
      this.modified = new Date();
    }
  }

  _refreshAxisFromSketch(sketch) {
    if (!sketch || this.axisSource === 'manual') {
      return;
    }

    const axisResolution = resolveSketchRevolveAxis(sketch, this.axisSegmentId);
    if (axisResolution.ambiguous) {
      throw new Error('Multiple construction lines found in sketch. Select one construction line as the revolve axis.');
    }

    if (!axisResolution.axis) {
      return;
    }

    this._assignAxis(axisResolution.axis.origin, axisResolution.axis.direction, 'construction', false);
    if (axisResolution.axisSegmentId != null) {
      this.axisSegmentId = axisResolution.axisSegmentId;
    }
  }

  /**
   * Set the revolution axis.
   * @param {Object} origin - Point on axis
   * @param {Object} direction - Axis direction vector
   */
  setAxis(origin, direction, source = 'manual') {
    if (source !== 'construction') {
      this.axisSegmentId = null;
    }
    this._assignAxis(origin, direction, source, true);
  }

  setAxisSegmentId(axisSegmentId) {
    this.axisSegmentId = axisSegmentId ?? null;
    this.axisSource = this.axisSegmentId != null ? 'construction' : 'default';
    this.modified = new Date();
  }

  /**
   * Serialize this revolve feature.
   */
  serialize() {
    return {
      ...super.serialize(),
      sketchFeatureId: this.sketchFeatureId,
      angle: this.angle,
      segments: this.segments,
      axis: this.axis,
      axisSegmentId: this.axisSegmentId,
      axisSource: this.axisSource,
      operation: this.operation,
    };
  }

  /**
   * Deserialize a revolve feature from JSON.
   */
  static deserialize(data) {
    const feature = new RevolveFeature();
    if (!data) return feature;
    
    // Deserialize base feature properties
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'revolve';
    
    // Deserialize revolve-specific properties
    feature.sketchFeatureId = data.sketchFeatureId || null;
    feature.angle = data.angle || Math.PI * 2;
    feature.segments = data.segments || 32;
    feature.axis = data.axis || { origin: { x: 0, y: 0 }, direction: { x: 0, y: 1 } };
    feature.axisSegmentId = data.axisSegmentId ?? null;
    feature.axisSource = data.axisSource || (feature.axisSegmentId != null ? 'construction' : 'default');
    feature.operation = data.operation || 'new';
    
    return feature;
  }
}

const REVOLVE_EPS = 1e-8;

function _add3(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function _sub3(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function _scale3(v, scalar) {
  return { x: v.x * scalar, y: v.y * scalar, z: v.z * scalar };
}

function _dot3(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function _cross3(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function _normalize3(v) {
  const length = Math.hypot(v.x, v.y, v.z);
  if (length < REVOLVE_EPS) {
    return { x: 0, y: 0, z: 0 };
  }
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function _profileOrientation(points) {
  let area2 = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area2 += current.x * next.y - next.x * current.y;
  }
  return area2;
}

function _buildEdgeRanges(profileEdges, totalPoints) {
  if (!profileEdges || profileEdges.length === 0) {
    const ranges = [];
    for (let index = 0; index < totalPoints; index++) {
      ranges.push({
        type: 'segment',
        startIdx: index,
        endIdx: (index + 1) % totalPoints,
      });
    }
    return ranges;
  }

  const ranges = [];
  let currentIdx = 0;

  for (const edge of profileEdges) {
    const pointCount = edge.pointCount || 2;
    const advance = pointCount - 1;
    const endIdx = (currentIdx + advance) % totalPoints;

    ranges.push({
      type: edge.type || 'segment',
      startIdx: currentIdx,
      endIdx,
      center: edge.center,
      radius: edge.radius,
      sweepAngle: edge.sweepAngle,
      startAngle: edge.startAngle,
      controlPoints2D: edge.controlPoints2D,
      degree: edge.degree,
      knots: edge.knots,
      bezierVertices: edge.bezierVertices,
    });

    currentIdx = endIdx;
  }

  return ranges;
}

function _buildRevolveSliceDefs(angle, sliceCount) {
  const sliceSweep = angle / sliceCount;
  const slices = [];
  for (let index = 0; index < sliceCount; index++) {
    slices.push({
      startAngle: index * sliceSweep,
      sweepAngle: sliceSweep,
      suffix: `_s${index}`,
    });
  }
  return slices;
}

function _curveIsClosed(curve) {
  if (!curve) return false;
  const start = curve.evaluate(curve.uMin);
  const end = curve.evaluate(curve.uMax);
  return Math.hypot(start.x - end.x, start.y - end.y, start.z - end.z) < 1e-7;
}

function _getClosedCurveSplitCount(range, curve) {
  if (range.type === 'circle') return 4;
  if (range.type === 'bezier' && range.bezierVertices) return Math.max(3, range.bezierVertices.length);
  if (range.type === 'spline' && range.controlPoints2D) return Math.max(3, range.controlPoints2D.length);
  return Math.max(3, Math.ceil(curve.controlPoints.length / 2));
}

function _splitCurveAtAxisRoots(curve, axisFrame) {
  const roots = _findCurveAxisRoots(curve, axisFrame);
  if (roots.length === 0) {
    return [curve];
  }

  const parts = [];
  let remaining = curve;
  for (const root of roots) {
    if (root <= remaining.uMin + 1e-8 || root >= remaining.uMax - 1e-8) {
      continue;
    }
    const split = remaining.splitAt(root);
    if (!split) {
      continue;
    }
    if (!_curveIsDegenerate(split[0])) {
      parts.push(split[0]);
    }
    remaining = split[1];
  }

  if (!_curveIsDegenerate(remaining)) {
    parts.push(remaining);
  }
  return parts.length > 0 ? parts : [curve];
}

function _splitDoubleAxisCurvePart(curve, axisFrame) {
  const startDesc = _describeWorldPointRelativeToAxis(curve.evaluate(curve.uMin), axisFrame);
  const endDesc = _describeWorldPointRelativeToAxis(curve.evaluate(curve.uMax), axisFrame);
  if (startDesc.radius >= REVOLVE_EPS || endDesc.radius >= REVOLVE_EPS) {
    return [curve];
  }

  const split = curve.splitUniform(2);
  if (!split || split.length !== 2) {
    return [curve];
  }
  return split.filter(part => !_curveIsDegenerate(part));
}

function _curveIsDegenerate(curve) {
  if (!curve) return true;
  return curve.arcLength(24) < 1e-7;
}

function _findCurveAxisRoots(curve, axisFrame) {
  const roots = [];
  const sampleCount = Math.max(64, curve.controlPoints.length * 16);
  const domain = curve.uMax - curve.uMin;
  const rootTol = 1e-6;

  const addRoot = (value) => {
    if (value <= curve.uMin + 1e-8 || value >= curve.uMax - 1e-8) return;
    if (roots.some(existing => Math.abs(existing - value) < 1e-6 * Math.max(1, domain))) return;
    roots.push(value);
  };

  const signedRadiusAt = (u) => _signedRadiusForWorldPoint(curve.evaluate(u), axisFrame);

  let prevU = curve.uMin;
  let prevF = signedRadiusAt(prevU);
  if (Math.abs(prevF) < rootTol) addRoot(prevU);

  for (let index = 1; index <= sampleCount; index++) {
    const nextU = curve.uMin + (index / sampleCount) * domain;
    const nextF = signedRadiusAt(nextU);

    if (Math.abs(nextF) < rootTol) {
      addRoot(nextU);
    }

    if (prevF * nextF < 0) {
      let lo = prevU;
      let hi = nextU;
      let flo = prevF;
      for (let iter = 0; iter < 32; iter++) {
        const mid = (lo + hi) * 0.5;
        const fmid = signedRadiusAt(mid);
        if (Math.abs(fmid) < rootTol) {
          lo = mid;
          hi = mid;
          break;
        }
        if (flo * fmid <= 0) {
          hi = mid;
        } else {
          lo = mid;
          flo = fmid;
        }
      }
      addRoot((lo + hi) * 0.5);
    }

    prevU = nextU;
    prevF = nextF;
  }

  roots.sort((a, b) => a - b);
  return roots;
}

function _signedRadiusForWorldPoint(point, axisFrame) {
  const rel = _sub3(point, axisFrame.originWorld);
  return _dot3(rel, axisFrame.perpWorld);
}

function _describeWorldPointRelativeToAxis(worldPoint, axisFrame) {
  const rel = _sub3(worldPoint, axisFrame.originWorld);
  const height = _dot3(rel, axisFrame.axisWorld);
  const axisWorldPoint = _add3(axisFrame.originWorld, _scale3(axisFrame.axisWorld, height));
  const radialVector = _sub3(worldPoint, axisWorldPoint);
  return {
    height,
    signedRadius: _dot3(rel, axisFrame.perpWorld),
    radius: Math.hypot(radialVector.x, radialVector.y, radialVector.z),
  };
}

function _rotateCurveAroundAxis(curve, axisFrame, theta) {
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const controlPoints = curve.controlPoints.map((point) => {
    const rel = _sub3(point, axisFrame.originWorld);
    const height = _dot3(rel, axisFrame.axisWorld);
    const x = _dot3(rel, axisFrame.perpWorld);
    const y = _dot3(rel, axisFrame.normalWorld);
    return _add3(
      axisFrame.originWorld,
      _add3(
        _scale3(axisFrame.axisWorld, height),
        _add3(
          _scale3(axisFrame.perpWorld, x * cosTheta - y * sinTheta),
          _scale3(axisFrame.normalWorld, x * sinTheta + y * cosTheta),
        ),
      ),
    );
  });
  return new NurbsCurve(curve.degree, controlPoints, curve.knots, curve.weights);
}

function _spline2Dto3D(controlPoints2D, degree, knots, toWorld) {
  const cps3D = controlPoints2D.map(point => toWorld(point));
  return new NurbsCurve(degree, cps3D, knots);
}

function _bezierVertices2Dto3D(vertices, toWorld) {
  if (vertices.length < 2) throw new Error('Need at least 2 bezier vertices');
  const segmentCount = vertices.length - 1;
  const allControlPoints = [];

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
    const start = vertices[segmentIndex];
    const end = vertices[segmentIndex + 1];
    const p0 = { x: start.x, y: start.y };
    const p3 = { x: end.x, y: end.y };
    const handleOut = start.handleOut;
    const handleIn = end.handleIn;

    let c1;
    let c2;
    if (handleOut && handleIn) {
      c1 = { x: p0.x + handleOut.dx, y: p0.y + handleOut.dy };
      c2 = { x: p3.x + handleIn.dx, y: p3.y + handleIn.dy };
    } else if (handleOut) {
      const q = { x: p0.x + handleOut.dx, y: p0.y + handleOut.dy };
      c1 = { x: p0.x + 2 / 3 * (q.x - p0.x), y: p0.y + 2 / 3 * (q.y - p0.y) };
      c2 = { x: p3.x + 2 / 3 * (q.x - p3.x), y: p3.y + 2 / 3 * (q.y - p3.y) };
    } else if (handleIn) {
      const q = { x: p3.x + handleIn.dx, y: p3.y + handleIn.dy };
      c1 = { x: p0.x + 2 / 3 * (q.x - p0.x), y: p0.y + 2 / 3 * (q.y - p0.y) };
      c2 = { x: p3.x + 2 / 3 * (q.x - p3.x), y: p3.y + 2 / 3 * (q.y - p3.y) };
    } else {
      c1 = { x: p0.x + (p3.x - p0.x) / 3, y: p0.y + (p3.y - p0.y) / 3 };
      c2 = { x: p0.x + 2 * (p3.x - p0.x) / 3, y: p0.y + 2 * (p3.y - p0.y) / 3 };
    }

    if (segmentIndex === 0) allControlPoints.push(p0);
    allControlPoints.push(c1, c2, p3);
  }

  const degree = 3;
  const knots = [];
  for (let index = 0; index <= degree; index++) knots.push(0);
  for (let segmentIndex = 1; segmentIndex < segmentCount; segmentIndex++) {
    for (let mult = 0; mult < degree; mult++) knots.push(segmentIndex);
  }
  for (let index = 0; index <= degree; index++) knots.push(segmentCount);

  const cps3D = allControlPoints.map(point => toWorld(point));
  return new NurbsCurve(degree, cps3D, knots);
}

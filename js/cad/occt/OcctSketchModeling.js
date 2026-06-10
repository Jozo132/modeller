import {
  getCachedOcctKernelModule,
  occtKernelReadySync,
  resolveOcctKernelEnv,
} from './OcctKernelLoader.js';
import { OcctKernelAdapter } from './OcctKernelAdapter.js';
import { computeFeatureEdges } from '../EdgeAnalysis.js';
import { globalTessConfig } from '../TessellationConfig.js';

const WORLD_XY_TOLERANCE = 1e-6;
const DEFAULT_OCCT_LINEAR_DEFLECTION = 0.1;
const DEFAULT_OCCT_ANGULAR_DEFLECTION = 0.5;
const OCCT_BLEND_LOG_THRESHOLD_MS = 100;

let sharedAdapter = null;
const reportedOcctSketchFallbacks = new Set();

function reportOcctSketchFallbackOnce(code, message, details = undefined) {
  if (reportedOcctSketchFallbacks.has(code)) return;
  reportedOcctSketchFallbacks.add(code);
  if (typeof console?.info === 'function') {
    if (details !== undefined) {
      console.info(`[OCCT] sketch-solid fallback: ${message}`, details);
    } else {
      console.info(`[OCCT] sketch-solid fallback: ${message}`);
    }
  }
}

function occtSketchNowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function cleanNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.abs(number) < 1e-12 ? 0 : number;
}

function nearlyZero(value, tolerance = WORLD_XY_TOLERANCE) {
  return Math.abs(Number(value) || 0) <= tolerance;
}

function toTuple(point) {
  return [cleanNumber(point.x), cleanNumber(point.y)];
}

function toTuple3(point) {
  return [cleanNumber(point.x), cleanNumber(point.y), cleanNumber(point.z)];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function dot3(a, b) {
  return (Number(a?.x) || 0) * (Number(b?.x) || 0)
    + (Number(a?.y) || 0) * (Number(b?.y) || 0)
    + (Number(a?.z) || 0) * (Number(b?.z) || 0);
}

function vectorLength3(vector) {
  return Math.hypot(Number(vector?.x) || 0, Number(vector?.y) || 0, Number(vector?.z) || 0);
}

function boundingBoxDiagonal(bounds) {
  if (!bounds || typeof bounds !== 'object') return 0;
  return Math.hypot(
    Number(bounds.xMax) - Number(bounds.xMin),
    Number(bounds.yMax) - Number(bounds.yMin),
    Number(bounds.zMax) - Number(bounds.zMin),
  );
}

function buildOcctTessellationOptions(topology, operation, options = {}) {
  const isBlend = operation === 'fillet' || operation === 'chamfer';
  const liveBlendDisplay = options.liveBlendDisplay === true && isBlend;
  const minEdgeSegments = isBlend
    ? (liveBlendDisplay ? 16 : 32)
    : 16;
  const minSurfaceSegments = isBlend
    ? (liveBlendDisplay ? 8 : 16)
    : 8;
  const configuredEdgeSegments = Math.max(Number(globalTessConfig.edgeSegments) || 0, minEdgeSegments);
  const configuredSurfaceSegments = Math.max(Number(globalTessConfig.surfaceSegments) || 0, minSurfaceSegments);
  const edgeSegments = liveBlendDisplay
    ? Math.min(configuredEdgeSegments, 24)
    : configuredEdgeSegments;
  const surfaceSegments = liveBlendDisplay
    ? Math.min(configuredSurfaceSegments, 12)
    : configuredSurfaceSegments;
  const diag = boundingBoxDiagonal(topology?.boundingBox);
  const linearDeflection = diag > WORLD_XY_TOLERANCE
    ? clamp(
      diag / Math.max(edgeSegments * (isBlend ? (liveBlendDisplay ? 20 : 48) : 32), 1),
      isBlend ? (liveBlendDisplay ? 0.005 : 0.002) : 0.005,
      isBlend ? (liveBlendDisplay ? 0.1 : 0.05) : DEFAULT_OCCT_LINEAR_DEFLECTION,
    )
    : (isBlend ? 0.01 : DEFAULT_OCCT_LINEAR_DEFLECTION);
  const angularDeflection = clamp(
    Math.PI / Math.max(surfaceSegments * (isBlend ? (liveBlendDisplay ? 1 : 2) : 1), isBlend ? (liveBlendDisplay ? 12 : 24) : 12),
    isBlend ? (liveBlendDisplay ? 0.06 : 0.03) : 0.08,
    isBlend ? (liveBlendDisplay ? 0.25 : 0.15) : DEFAULT_OCCT_ANGULAR_DEFLECTION,
  );
  return {
    topology,
    linearDeflection: cleanNumber(linearDeflection),
    angularDeflection: cleanNumber(angularDeflection),
  };
}

function normalizeVector3(vector) {
  const length = vectorLength3(vector);
  if (!(length > WORLD_XY_TOLERANCE)) return null;
  return {
    x: cleanNumber(vector.x / length),
    y: cleanNumber(vector.y / length),
    z: cleanNumber(vector.z / length),
  };
}

function addVector3(a, b) {
  return {
    x: cleanNumber(Number(a?.x || 0) + Number(b?.x || 0)),
    y: cleanNumber(Number(a?.y || 0) + Number(b?.y || 0)),
    z: cleanNumber(Number(a?.z || 0) + Number(b?.z || 0)),
  };
}

function subtractVector3(a, b) {
  return {
    x: cleanNumber(Number(a?.x || 0) - Number(b?.x || 0)),
    y: cleanNumber(Number(a?.y || 0) - Number(b?.y || 0)),
    z: cleanNumber(Number(a?.z || 0) - Number(b?.z || 0)),
  };
}

function resolvePlaneFrame(plane) {
  if (!plane?.origin || !plane?.xAxis || !plane?.yAxis || !plane?.normal) return null;
  const cross = {
    x: plane.xAxis.y * plane.yAxis.z - plane.xAxis.z * plane.yAxis.y,
    y: plane.xAxis.z * plane.yAxis.x - plane.xAxis.x * plane.yAxis.z,
    z: plane.xAxis.x * plane.yAxis.y - plane.xAxis.y * plane.yAxis.x,
  };
  const handedness = dot3(cross, plane.normal);
  if (handedness >= 0) {
    return {
      plane,
      toPlanePoint(point) {
        return { x: point.x, y: point.y };
      },
      toPlaneVector(vector) {
        return { x: vector.x, y: vector.y };
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
    toPlaneVector(vector) {
      return { x: vector.x, y: -vector.y };
    },
  };
}

function localSketchPoint(point, planeFrame) {
  if (!point || !planeFrame) return null;
  const local = planeFrame.toPlanePoint(point);
  if (!Number.isFinite(local?.x) || !Number.isFinite(local?.y)) return null;
  return {
    x: cleanNumber(local.x),
    y: cleanNumber(local.y),
  };
}

function localSketchVector(vector, planeFrame) {
  if (!vector || !planeFrame) return null;
  const local = planeFrame.toPlaneVector(vector);
  if (!Number.isFinite(local?.x) || !Number.isFinite(local?.y)) return null;
  return {
    x: cleanNumber(local.x),
    y: cleanNumber(local.y),
  };
}

function hasMeaningfulTranslation(translation) {
  return Array.isArray(translation)
    && translation.length >= 3
    && translation.some((component) => Math.abs(Number(component) || 0) > WORLD_XY_TOLERANCE);
}

function buildAxisAngleFromBasis(xAxis, yAxis, zAxis) {
  const r00 = xAxis.x;
  const r01 = yAxis.x;
  const r02 = zAxis.x;
  const r10 = xAxis.y;
  const r11 = yAxis.y;
  const r12 = zAxis.y;
  const r20 = xAxis.z;
  const r21 = yAxis.z;
  const r22 = zAxis.z;
  const trace = r00 + r11 + r22;
  const angle = Math.acos(clamp((trace - 1) * 0.5, -1, 1));
  if (!(angle > 1e-9)) return null;

  let axis = null;
  if (Math.PI - angle <= 1e-5) {
    axis = {
      x: Math.sqrt(Math.max(0, (r00 + 1) * 0.5)),
      y: Math.sqrt(Math.max(0, (r11 + 1) * 0.5)),
      z: Math.sqrt(Math.max(0, (r22 + 1) * 0.5)),
    };
    if (axis.x >= axis.y && axis.x >= axis.z && axis.x > 1e-6) {
      axis.y = (r01 + r10) / (4 * axis.x);
      axis.z = (r02 + r20) / (4 * axis.x);
    } else if (axis.y >= axis.z && axis.y > 1e-6) {
      axis.x = (r01 + r10) / (4 * axis.y);
      axis.z = (r12 + r21) / (4 * axis.y);
    } else if (axis.z > 1e-6) {
      axis.x = (r02 + r20) / (4 * axis.z);
      axis.y = (r12 + r21) / (4 * axis.z);
    } else {
      axis = { x: 1, y: 0, z: 0 };
    }
  } else {
    axis = normalizeVector3({
      x: r21 - r12,
      y: r02 - r20,
      z: r10 - r01,
    });
  }

  const normalizedAxis = normalizeVector3(axis);
  if (!normalizedAxis) return null;

  return {
    axisOrigin: [0, 0, 0],
    axisDirection: toTuple3(normalizedAxis),
    angleDegrees: cleanNumber(angle * 180 / Math.PI),
  };
}

function buildOcctPlaneFrame(planeFrame, originOverride = null) {
  const resolvedPlane = planeFrame?.plane;
  if (!resolvedPlane?.origin || !resolvedPlane?.normal || !resolvedPlane?.xAxis) return null;
  const origin = originOverride || resolvedPlane.origin;
  const normal = normalizeVector3(resolvedPlane.normal);
  const xDirection = normalizeVector3(resolvedPlane.xAxis);
  if (!normal || !xDirection) return null;
  return {
    origin: toTuple3(origin),
    normal: toTuple3(normal),
    xDirection: toTuple3(xDirection),
  };
}

function planeLocalPointToWorld(point, planeFrame) {
  const resolvedPlane = planeFrame?.plane;
  if (!point || !resolvedPlane?.origin || !resolvedPlane?.xAxis || !resolvedPlane?.yAxis) return null;
  return {
    x: cleanNumber(resolvedPlane.origin.x + resolvedPlane.xAxis.x * point.x + resolvedPlane.yAxis.x * point.y),
    y: cleanNumber(resolvedPlane.origin.y + resolvedPlane.xAxis.y * point.x + resolvedPlane.yAxis.y * point.y),
    z: cleanNumber(resolvedPlane.origin.z + resolvedPlane.xAxis.z * point.x + resolvedPlane.yAxis.z * point.y),
  };
}

function planeLocalVectorToWorld(vector, planeFrame) {
  const resolvedPlane = planeFrame?.plane;
  if (!vector || !resolvedPlane?.xAxis || !resolvedPlane?.yAxis) return null;
  return normalizeVector3({
    x: resolvedPlane.xAxis.x * vector.x + resolvedPlane.yAxis.x * vector.y,
    y: resolvedPlane.xAxis.y * vector.x + resolvedPlane.yAxis.y * vector.y,
    z: resolvedPlane.xAxis.z * vector.x + resolvedPlane.yAxis.z * vector.y,
  });
}

function adapterHasKernelMethod(adapter, methodName) {
  try {
    return typeof adapter?.requireReady?.()[methodName] === 'function';
  } catch {
    return false;
  }
}

function buildLocalToWorldTransform(planeFrame) {
  const resolvedPlane = planeFrame?.plane;
  if (!resolvedPlane?.origin || !resolvedPlane?.xAxis || !resolvedPlane?.yAxis || !resolvedPlane?.normal) {
    return null;
  }
  const xAxis = normalizeVector3(resolvedPlane.xAxis);
  const yAxis = normalizeVector3(resolvedPlane.yAxis);
  const zAxis = normalizeVector3(resolvedPlane.normal);
  if (!xAxis || !yAxis || !zAxis) return null;

  const translation = toTuple3(resolvedPlane.origin);
  const rotation = buildAxisAngleFromBasis(xAxis, yAxis, zAxis);
  if (!rotation && !hasMeaningfulTranslation(translation)) return null;

  const transform = {};
  if (rotation) transform.rotation = rotation;
  if (hasMeaningfulTranslation(translation)) transform.translation = translation;
  return transform;
}

function pointsMatch(a, b) {
  if (!a || !b) return false;
  return nearlyZero(a.x - b.x, 1e-5) && nearlyZero(a.y - b.y, 1e-5);
}

function profileEdgeEndpoints(profile, edge) {
  const points = Array.isArray(profile?.points) ? profile.points : [];
  if (!Number.isInteger(edge?.pointStartIndex) || !Number.isInteger(edge?.pointCount)) return null;
  if (points.length === 0 || edge.pointCount < 2) return null;
  const startIndex = edge.pointStartIndex;
  if (startIndex < 0 || startIndex >= points.length) return null;
  const endIndex = (startIndex + edge.pointCount - 1) % points.length;
  return {
    start: points[startIndex],
    end: points[endIndex],
  };
}

function buildLineSegment(profile, edge, planeFrame) {
  const endpoints = profileEdgeEndpoints(profile, edge);
  if (!endpoints) return null;
  const start = localSketchPoint(endpoints.start, planeFrame);
  const end = localSketchPoint(endpoints.end, planeFrame);
  if (!start || !end || pointsMatch(start, end)) return null;
  return {
    type: 'line',
    start: toTuple(start),
    end: toTuple(end),
  };
}

function buildArcSegment(edge, planeFrame) {
  const center = edge?.center;
  const radius = Number(edge?.radius);
  const startAngle = Number(edge?.startAngle);
  const sweepAngle = Number(edge?.sweepAngle);
  if (!center || !Number.isFinite(radius) || radius <= WORLD_XY_TOLERANCE) return null;
  if (!Number.isFinite(startAngle) || !Number.isFinite(sweepAngle)) return null;

  const sketchPointAt = (angle) => ({
    x: center.x + Math.cos(angle) * radius,
    y: center.y + Math.sin(angle) * radius,
  });

  const start = localSketchPoint(sketchPointAt(startAngle), planeFrame);
  const mid = localSketchPoint(sketchPointAt(startAngle + sweepAngle * 0.5), planeFrame);
  const end = localSketchPoint(sketchPointAt(startAngle + sweepAngle), planeFrame);
  if (!start || !mid || !end) return null;
  if (pointsMatch(start, mid) || pointsMatch(mid, end) || pointsMatch(start, end)) return null;

  return {
    type: 'arc',
    start: toTuple(start),
    mid: toTuple(mid),
    end: toTuple(end),
  };
}

function buildCircleSegment(edge, planeFrame) {
  const center = edge?.center;
  const radius = Number(edge?.radius);
  if (!center || !Number.isFinite(radius) || radius <= WORLD_XY_TOLERANCE) return null;

  const centre = localSketchPoint(center, planeFrame);
  if (!centre) return null;

  return {
    type: 'circle',
    centre: toTuple(centre),
    radius: cleanNumber(radius),
  };
}

function buildControlPointTuples(points, planeFrame) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const controlPoints = [];
  for (const point of points) {
    const local = localSketchPoint(point, planeFrame);
    if (!local) return null;
    controlPoints.push(toTuple(local));
  }
  return controlPoints;
}

function compressKnotVector(knots) {
  if (!Array.isArray(knots) || knots.length < 2) return null;
  const values = [];
  const multiplicities = [];
  for (const raw of knots) {
    const knot = Number(raw);
    if (!Number.isFinite(knot)) return null;
    if (values.length === 0 || Math.abs(knot - values[values.length - 1]) > 1e-9) {
      values.push(cleanNumber(knot));
      multiplicities.push(1);
    } else {
      multiplicities[multiplicities.length - 1] += 1;
    }
  }
  return { knots: values, multiplicities };
}

function buildBsplineSegment(edge, planeFrame) {
  const controlPoints = buildControlPointTuples(edge?.controlPoints2D, planeFrame);
  const degree = Number(edge?.degree);
  const compressed = compressKnotVector(edge?.knots);
  if (!controlPoints || !Number.isInteger(degree) || degree < 1 || !compressed) {
    reportOcctSketchFallbackOnce(
      'invalid-profile-spline',
      'OCCT sketch-solid replay could not translate spline edge metadata into the OCCT bspline segment schema.',
      {
        controlPointCount: Array.isArray(edge?.controlPoints2D) ? edge.controlPoints2D.length : 0,
        degree: edge?.degree,
        knotCount: Array.isArray(edge?.knots) ? edge.knots.length : 0,
      },
    );
    return null;
  }
  const multiplicitySum = compressed.multiplicities.reduce((sum, value) => sum + value, 0);
  if (multiplicitySum - degree - 1 !== controlPoints.length) {
    reportOcctSketchFallbackOnce(
      'invalid-profile-spline',
      'OCCT sketch-solid replay found inconsistent spline control points, degree, and knot multiplicities.',
      {
        controlPointCount: controlPoints.length,
        degree,
        knots: compressed.knots,
        multiplicities: compressed.multiplicities,
      },
    );
    return null;
  }
  return {
    type: 'bspline',
    controlPoints,
    degree,
    knots: compressed.knots,
    multiplicities: compressed.multiplicities,
  };
}

function buildBezierControlPoint(point, handle, planeFrame) {
  const anchor = localSketchPoint(point, planeFrame);
  if (!anchor) return null;
  if (!handle) return anchor;
  const vector = localSketchVector(handle, planeFrame);
  if (!vector) return null;
  return {
    x: cleanNumber(anchor.x + vector.x),
    y: cleanNumber(anchor.y + vector.y),
  };
}

function buildBezierSpanSegment(startVertex, endVertex, planeFrame) {
  const start = localSketchPoint(startVertex, planeFrame);
  const end = localSketchPoint(endVertex, planeFrame);
  if (!start || !end || pointsMatch(start, end)) return null;

  const startHandle = buildBezierControlPoint(startVertex, startVertex?.handleOut, planeFrame);
  const endHandle = buildBezierControlPoint(endVertex, endVertex?.handleIn, planeFrame);
  if (startVertex?.handleOut && !startHandle) return null;
  if (endVertex?.handleIn && !endHandle) return null;

  if (!startVertex?.handleOut && !endVertex?.handleIn) {
    return {
      type: 'line',
      start: toTuple(start),
      end: toTuple(end),
    };
  }

  const controlPoints = [toTuple(start)];
  if (startVertex?.handleOut) controlPoints.push(toTuple(startHandle));
  if (endVertex?.handleIn) controlPoints.push(toTuple(endHandle));
  controlPoints.push(toTuple(end));
  return {
    type: 'bezier',
    controlPoints,
  };
}

function buildBezierSegments(edge, planeFrame) {
  const vertices = Array.isArray(edge?.bezierVertices) ? edge.bezierVertices : [];
  if (vertices.length < 2) {
    reportOcctSketchFallbackOnce(
      'invalid-profile-bezier',
      'OCCT sketch-solid replay could not translate Bezier edge metadata because fewer than two vertices were provided.',
    );
    return null;
  }
  const segments = [];
  for (let index = 0; index + 1 < vertices.length; index++) {
    const segment = buildBezierSpanSegment(vertices[index], vertices[index + 1], planeFrame);
    if (!segment) {
      reportOcctSketchFallbackOnce(
        'invalid-profile-bezier',
        'OCCT sketch-solid replay could not translate Bezier edge metadata into OCCT bezier segments.',
      );
      return null;
    }
    segments.push(segment);
  }
  return segments;
}

function segmentStart(segment) {
  if (!segment) return null;
  if (segment.type === 'circle') return null;
  if (segment.type === 'bezier' || segment.type === 'bspline') {
    const first = Array.isArray(segment.controlPoints) ? segment.controlPoints[0] : null;
    return Array.isArray(first) && first.length >= 2
      ? { x: first[0], y: first[1] }
      : null;
  }
  return { x: segment.start[0], y: segment.start[1] };
}

function segmentEnd(segment) {
  if (!segment) return null;
  if (segment.type === 'circle') return null;
  if (segment.type === 'bezier' || segment.type === 'bspline') {
    const controlPoints = Array.isArray(segment.controlPoints) ? segment.controlPoints : [];
    const last = controlPoints[controlPoints.length - 1];
    return Array.isArray(last) && last.length >= 2
      ? { x: last[0], y: last[1] }
      : null;
  }
  return { x: segment.end[0], y: segment.end[1] };
}

function reportUnsupportedProfileEdgeType(type) {
  reportOcctSketchFallbackOnce(
    `unsupported-profile-${String(type)}`,
    `OCCT sketch-solid replay hit unsupported profile edge type "${String(type)}".`,
  );
}

function buildOcctWire(profile, planeFrame) {
  const edges = Array.isArray(profile?.edges) ? profile.edges : [];
  if (edges.length === 0) return null;

  const segments = [];
  for (const edge of edges) {
    const type = edge?.type || 'segment';
    let edgeSegments = null;
    if (type === 'segment' || type === 'line') {
      const segment = buildLineSegment(profile, edge, planeFrame);
      edgeSegments = segment ? [segment] : null;
    } else if (type === 'arc') {
      const segment = buildArcSegment(edge, planeFrame);
      edgeSegments = segment ? [segment] : null;
    } else if (type === 'circle') {
      const segment = buildCircleSegment(edge, planeFrame);
      edgeSegments = segment ? [segment] : null;
    } else if (type === 'spline') {
      const segment = buildBsplineSegment(edge, planeFrame);
      edgeSegments = segment ? [segment] : null;
    } else if (type === 'bezier') {
      edgeSegments = buildBezierSegments(edge, planeFrame);
    } else {
      reportUnsupportedProfileEdgeType(type);
      return null;
    }
    if (!edgeSegments || edgeSegments.length === 0) return null;
    segments.push(...edgeSegments);
  }

  if (!(segments.length === 1 && segments[0].type === 'circle')) {
    for (let index = 0; index < segments.length; index++) {
      const currentEnd = segmentEnd(segments[index]);
      const nextStart = segmentStart(segments[(index + 1) % segments.length]);
      if (!pointsMatch(currentEnd, nextStart)) return null;
    }
  }

  return { segments };
}

function buildOcctProfile(profile, holes = [], planeFrame) {
  const outer = buildOcctWire(profile, planeFrame);
  if (!outer) return null;

  const holeWires = [];
  for (const hole of holes || []) {
    const holeWire = buildOcctWire(hole, planeFrame);
    if (!holeWire) return null;
    holeWires.push(holeWire);
  }

  if (holeWires.length === 0) return outer;
  return {
    outer,
    holes: holeWires,
  };
}

function worldTupleFromSketchPoint(point, planeFrame) {
  const local = localSketchPoint(point, planeFrame);
  const world = local ? planeLocalPointToWorld(local, planeFrame) : null;
  return world ? toTuple3(world) : null;
}

function buildWorldSketchWire(sketchResult) {
  const sketch = sketchResult?.sketch?.scene || sketchResult?.sketch || null;
  const planeFrame = resolvePlaneFrame(sketchResult?.plane);
  if (!sketch || !planeFrame) return null;

  const segments = [];
  for (const seg of sketch.segments || []) {
    if (seg?.construction || seg?.visible === false || !seg.p1 || !seg.p2) continue;
    const start = worldTupleFromSketchPoint(seg.p1, planeFrame);
    const end = worldTupleFromSketchPoint(seg.p2, planeFrame);
    if (start && end) segments.push({ type: 'line', start, end });
  }

  for (const arc of sketch.arcs || []) {
    if (arc?.construction || arc?.visible === false) continue;
    const center = arc.center || { x: arc.cx, y: arc.cy };
    const radius = Number(arc.radius);
    const startAngle = Number(arc.startAngle);
    const endAngle = Number(arc.endAngle);
    if (!center || !Number.isFinite(radius) || !Number.isFinite(startAngle) || !Number.isFinite(endAngle)) continue;
    let sweep = endAngle - startAngle;
    if (sweep <= 0) sweep += Math.PI * 2;
    const start = worldTupleFromSketchPoint({ x: center.x + Math.cos(startAngle) * radius, y: center.y + Math.sin(startAngle) * radius }, planeFrame);
    const mid = worldTupleFromSketchPoint({ x: center.x + Math.cos(startAngle + sweep * 0.5) * radius, y: center.y + Math.sin(startAngle + sweep * 0.5) * radius }, planeFrame);
    const end = worldTupleFromSketchPoint({ x: center.x + Math.cos(startAngle + sweep) * radius, y: center.y + Math.sin(startAngle + sweep) * radius }, planeFrame);
    if (start && mid && end) segments.push({ type: 'arc', start, mid, end });
  }

  if (segments.length > 0) return { segments };

  const profile = Array.isArray(sketchResult?.profiles) ? sketchResult.profiles[0] : null;
  const profileWire = profile ? buildOcctWire(profile, planeFrame) : null;
  if (!profileWire?.segments?.length) return null;
  return {
    segments: profileWire.segments.map((segment) => ({ ...segment, coordinateSpace: 'sketch', plane: buildOcctPlaneFrame(planeFrame) })),
  };
}

function buildFirstSectionFromSketchResult(sketchResult) {
  const planeFrame = resolvePlaneFrame(sketchResult?.plane);
  const profile = Array.isArray(sketchResult?.profiles) ? sketchResult.profiles[0] : null;
  if (!planeFrame || !profile) return null;
  const occtProfile = buildOcctProfile(profile, [], planeFrame);
  const occtPlane = buildOcctPlaneFrame(planeFrame);
  if (!occtProfile || !occtPlane) return null;
  return { type: 'profile', profile: occtProfile, plane: occtPlane };
}

function getSharedAdapterSync() {
  if (sharedAdapter) return sharedAdapter;

  const env = resolveOcctKernelEnv();
  const loaded = getCachedOcctKernelModule() || getCachedOcctKernelModule(env);
  if (!loaded?.module && !occtKernelReadySync() && !occtKernelReadySync(env)) {
    reportOcctSketchFallbackOnce(
      'module-not-ready',
      'OCCT is enabled for sketch solids, but the kernel was not preloaded before synchronous feature replay.',
    );
    return null;
  }
  if (!loaded?.module) return null;

  sharedAdapter = OcctKernelAdapter.createSync({ loaded });
  return sharedAdapter;
}

function finalizeOcctGeometry(adapter, handle, topoBody, operation, options = {}) {
  if (!handle || handle <= 0) {
    reportOcctSketchFallbackOnce(
      `occt-${operation}-empty-handle`,
      `OCCT ${operation} returned an empty shape handle.`,
    );
    return null;
  }

  const startedAt = occtSketchNowMs();
  const validStartedAt = startedAt;
  const valid = adapter.checkValidity(handle);
  const validMs = occtSketchNowMs() - validStartedAt;
  if (!valid) {
    reportOcctSketchFallbackOnce(
      `occt-${operation}-invalid-shape`,
      `OCCT ${operation} returned an invalid shape; keeping the resident OCCT result and skipping the compatibility fallback on this branch.`,
    );
  }

  const topologyStartedAt = occtSketchNowMs();
  const topology = adapter.getTopology(handle);
  const topologyMs = occtSketchNowMs() - topologyStartedAt;
  const tessellateStartedAt = occtSketchNowMs();
  const geometry = adapter.tessellate(handle, buildOcctTessellationOptions(topology, operation, options));
  const tessellateMs = occtSketchNowMs() - tessellateStartedAt;
  if (!geometry?.faces?.length) {
    reportOcctSketchFallbackOnce(
      `occt-${operation}-empty-tessellation`,
      `OCCT ${operation} produced no tessellated faces.`,
    );
    adapter.disposeShape(handle);
    return null;
  }

  geometry.topoBody = topoBody || null;
  geometry.occtShapeHandle = handle;
  geometry.occtShapeResident = true;
  geometry._occtModeling = {
    authoritative: true,
    operation,
    acceptedInvalidShape: valid !== true,
    topology,
  };
  geometry._occtFinalizeTiming = {
    validMs,
    topologyMs,
    tessellateMs,
    totalMs: occtSketchNowMs() - startedAt,
  };
  return geometry;
}

function faceMatchesOcctBlendSelectors(face, selectors) {
  return face?.shared?.isFillet === true
    || (
      selectors.topoFaceIds.has(face?.topoFaceId)
      || (!!face?.stableHash && selectors.stableHashes.has(face.stableHash))
    );
}

function collectOcctBlendFaceSelectors(blendFaces) {
  const topoFaceIds = new Set();
  const stableHashes = new Set();
  for (const face of blendFaces || []) {
    if (Number.isInteger(face)) {
      topoFaceIds.add(face);
      continue;
    }
    if (typeof face === 'string') {
      stableHashes.add(face);
      continue;
    }
    if (!face || typeof face !== 'object') continue;
    const topoFaceId = Number.isInteger(face.topoFaceId)
      ? face.topoFaceId
      : (Number.isInteger(face.faceId)
        ? face.faceId
        : (Number.isInteger(face.id) ? face.id : null));
    if (topoFaceId != null) topoFaceIds.add(topoFaceId);
    const stableHash = typeof face.stableHash === 'string'
      ? face.stableHash
      : (typeof face.hash === 'string'
        ? face.hash
        : (typeof face.faceHash === 'string' ? face.faceHash : null));
    if (stableHash) stableHashes.add(stableHash);
  }
  return { topoFaceIds, stableHashes };
}

function collectOcctGeneratedBlendFaceSelectors(currentTopology, sourceTopology) {
  const topoFaceIds = new Set();
  const stableHashes = new Set();
  if (!Array.isArray(currentTopology?.faces) || !Array.isArray(sourceTopology?.faces)) {
    return { topoFaceIds, stableHashes };
  }

  const previousFaceHashes = new Set(
    sourceTopology.faces
      .map((face) => (typeof face?.stableHash === 'string' ? face.stableHash : null))
      .filter(Boolean),
  );
  if (previousFaceHashes.size === 0) {
    return { topoFaceIds, stableHashes };
  }

  for (const face of currentTopology.faces) {
    const stableHash = typeof face?.stableHash === 'string' ? face.stableHash : null;
    if (!stableHash || previousFaceHashes.has(stableHash)) continue;
    stableHashes.add(stableHash);
    if (Number.isInteger(face?.id)) topoFaceIds.add(face.id);
  }

  return { topoFaceIds, stableHashes };
}

function applyOcctBlendFaceMetadata(geometry, operation, blendFaces, sourceTopology = null) {
  if (!geometry?.faces?.length || operation !== 'fillet') return;

  let selectors = collectOcctBlendFaceSelectors(blendFaces);
  let hasSelectors = selectors.topoFaceIds.size > 0 || selectors.stableHashes.size > 0;
  if (hasSelectors) {
    const matchedFace = geometry.faces.some((face) => faceMatchesOcctBlendSelectors(face, selectors));
    if (!matchedFace) {
      const fallbackSelectors = collectOcctGeneratedBlendFaceSelectors(geometry?._occtModeling?.topology, sourceTopology);
      const hasFallbackSelectors = fallbackSelectors.topoFaceIds.size > 0 || fallbackSelectors.stableHashes.size > 0;
      if (hasFallbackSelectors) {
        selectors = fallbackSelectors;
        hasSelectors = true;
      }
    }
  }

  for (const face of geometry.faces) {
    const matched = hasSelectors && faceMatchesOcctBlendSelectors(face, selectors);
    if (!matched) continue;
    face.shared = { ...(face.shared || {}), isFillet: true, isFilletFace: true };
    face.isFillet = true;
  }
}

function _edgePointKey(point) {
  return `${cleanNumber(point?.x).toFixed(6)},${cleanNumber(point?.y).toFixed(6)},${cleanNumber(point?.z).toFixed(6)}`;
}

function _edgeSegmentKey(edge) {
  if (!edge?.start || !edge?.end) return null;
  const startKey = _edgePointKey(edge.start);
  const endKey = _edgePointKey(edge.end);
  return startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
}

export function mergeOcctFeatureEdgeSets(nativeEdges = [], nativePaths = [], computedEdges = [], computedPaths = []) {
  const mergedEdges = [];
  const edgeIndexByKey = new Map();

  const appendEdges = (edges) => {
    const remap = new Map();
    for (let index = 0; index < edges.length; index += 1) {
      const edge = edges[index];
      const key = _edgeSegmentKey(edge);
      if (!key) continue;
      const existingIndex = edgeIndexByKey.get(key);
      if (existingIndex != null) {
        remap.set(index, existingIndex);
        continue;
      }
      const mergedIndex = mergedEdges.length;
      mergedEdges.push(edge);
      edgeIndexByKey.set(key, mergedIndex);
      remap.set(index, mergedIndex);
    }
    return remap;
  };

  const nativeRemap = appendEdges(Array.isArray(nativeEdges) ? nativeEdges : []);
  const computedRemap = appendEdges(Array.isArray(computedEdges) ? computedEdges : []);

  const mergedPaths = [];
  const pathSignatures = new Set();
  const appendPaths = (paths, remap) => {
    for (const path of paths || []) {
      if (!path || !Array.isArray(path.edgeIndices) || path.edgeIndices.length === 0) continue;
      const edgeIndices = path.edgeIndices
        .map((edgeIndex) => remap.get(edgeIndex))
        .filter((edgeIndex) => Number.isInteger(edgeIndex));
      if (edgeIndices.length === 0) continue;
      const signature = `${path.isClosed === true ? '1' : '0'}|${edgeIndices.join(',')}`;
      if (pathSignatures.has(signature)) continue;
      pathSignatures.add(signature);
      mergedPaths.push({
        ...path,
        edgeIndices,
      });
    }
  };

  appendPaths(nativePaths, nativeRemap);
  appendPaths(computedPaths, computedRemap);

  return {
    edges: mergedEdges,
    paths: mergedPaths,
  };
}

function attachOcctBlendFeatureEdges(geometry) {
  if (!geometry?.faces?.length) return;
  if (!Array.isArray(geometry._occtFeatureEdges)
      && Array.isArray(geometry.edges)
      && geometry.edges.some((edge) => !!edge?.stableHash)) {
    geometry._occtFeatureEdges = geometry.edges;
  }
  if (!Array.isArray(geometry._occtFeaturePaths)
      && Array.isArray(geometry.paths)
      && geometry.paths.some((path) => !!path?.stableHash)) {
    geometry._occtFeaturePaths = geometry.paths;
  }
  const edgeResult = computeFeatureEdges(geometry.faces);
  if (Array.isArray(geometry._occtFeatureEdges) && geometry._occtFeatureEdges.length > 0) {
    const merged = mergeOcctFeatureEdgeSets(
      geometry._occtFeatureEdges,
      Array.isArray(geometry._occtFeaturePaths) ? geometry._occtFeaturePaths : [],
      edgeResult.edges,
      edgeResult.paths,
    );
    geometry.edges = merged.edges;
    geometry.paths = merged.paths;
  } else {
    geometry.edges = edgeResult.edges;
    geometry.paths = edgeResult.paths;
  }
  geometry.visualEdges = edgeResult.visualEdges;
}

export function rehydrateOcctFeatureDisplayGeometry(geometry, operation = null, sourceTopology = null) {
  if (!geometry?.faces?.length) return geometry;
  if (operation === 'fillet') {
    const generatedSelectors = sourceTopology
      ? collectOcctGeneratedBlendFaceSelectors(geometry?._occtModeling?.topology, sourceTopology)
      : null;
    const hasGeneratedSelectors = !!generatedSelectors
      && (generatedSelectors.topoFaceIds.size > 0 || generatedSelectors.stableHashes.size > 0);
    if (hasGeneratedSelectors) {
      for (const face of geometry.faces) {
        if (!faceMatchesOcctBlendSelectors(face, generatedSelectors)) continue;
        face.shared = { ...(face.shared || {}), isFillet: true, isFilletFace: true };
        face.isFillet = true;
      }
    } else {
      applyOcctBlendFaceMetadata(geometry, operation, [], sourceTopology);
    }
  }
  if (operation === 'fillet' || operation === 'chamfer') {
    attachOcctBlendFeatureEdges(geometry);
  }
  return geometry;
}

function buildStructuredExtrudeExtent({ distance, extrudeType, targetFaceRef, surfaceOffset }) {
  if (extrudeType === 'throughAll') return { type: 'throughAll' };
  if (extrudeType === 'upToNext') return { type: 'upToNext' };
  if (extrudeType === 'upToFace') {
    return targetFaceRef
      ? { type: 'upToFace', targetFace: targetFaceRef }
      : { type: 'upToFace' };
  }
  if (extrudeType === 'offsetFromSurface') {
    return targetFaceRef
      ? { type: 'offsetFromSurface', targetFace: targetFaceRef, offset: cleanNumber(surfaceOffset) }
      : { type: 'offsetFromSurface', offset: cleanNumber(surfaceOffset) };
  }
  return { type: 'blind', distance: cleanNumber(distance) };
}

function buildStructuredExtrudeSpec({ occtPlane, distance, taper, taperAngle, taperInward, extrudeType, targetFaceRef, surfaceOffset }) {
  const spec = {
    schemaVersion: 1,
    plane: occtPlane,
    extent: buildStructuredExtrudeExtent({ distance, extrudeType, targetFaceRef, surfaceOffset }),
  };
  if (taper && Number(taperAngle) > 0) {
    const angle = Math.abs(Number(taperAngle));
    spec.draftAngleDegrees = cleanNumber(taperInward ? -angle : angle);
  }
  return spec;
}

function buildStructuredRevolveExtent({ extentType, angleRadians, targetFaceRef, startFaceRef, endFaceRef, surfaceOffset }) {
  if (extentType === 'throughAll') return { type: 'throughAll' };
  if (extentType === 'upToFace') {
    return targetFaceRef ? { type: 'upToFace', targetFace: targetFaceRef } : { type: 'upToFace' };
  }
  if (extentType === 'offsetFromSurface') {
    return targetFaceRef
      ? { type: 'offsetFromSurface', targetFace: targetFaceRef, offset: cleanNumber(surfaceOffset) }
      : { type: 'offsetFromSurface', offset: cleanNumber(surfaceOffset) };
  }
  if (extentType === 'fromFaceToFace') {
    const extent = { type: 'fromFaceToFace' };
    if (startFaceRef) extent.startFace = startFaceRef;
    if (endFaceRef) extent.endFace = endFaceRef;
    return extent;
  }
  return {
    type: 'angle',
    angleDegrees: cleanNumber(Number(angleRadians) * 180 / Math.PI),
  };
}

export function tryBuildOcctExtrudeGeometrySync(options = {}) {
  const {
    profile,
    plane,
    distance,
    direction = 1,
    symmetric = false,
    extrudeType = 'distance',
    targetFaceRef = null,
    surfaceOffset = 0,
    taper = false,
    holes = [],
    baseOffset = null,
    tipOffset = null,
    topoBody = null,
  } = options;
  if (!profile || !plane) return null;
  const structuredExtentTypes = new Set(['distance', 'throughAll', 'upToNext', 'upToFace', 'offsetFromSurface']);
  if (symmetric || !structuredExtentTypes.has(extrudeType)) {
    reportOcctSketchFallbackOnce(
      'unsupported-extrude-options',
      'OCCT sketch extrude received unsupported extrude options.',
      { symmetric: !!symmetric, taper: !!taper, extrudeType },
    );
    return null;
  }

  const planeFrame = resolvePlaneFrame(plane);
  if (!planeFrame) return null;

  const adapter = getSharedAdapterSync();
  if (!adapter) return null;

  const occtProfile = buildOcctProfile(profile, holes, planeFrame);
  if (!occtProfile) {
    reportOcctSketchFallbackOnce(
      'unsupported-profile',
      'OCCT sketch extrude currently supports only line/arc/circle profiles that resolve to closed local wires.',
    );
    return null;
  }

  const startOrigin = addVector3(planeFrame.plane.origin, baseOffset);
  const occtPlane = buildOcctPlaneFrame(planeFrame, startOrigin);
  if (!occtPlane) return null;

  const extrusionVector = addVector3(
    {
      x: Number(planeFrame.plane.normal?.x || 0) * Number(distance || 0) * Number(direction || 0),
      y: Number(planeFrame.plane.normal?.y || 0) * Number(distance || 0) * Number(direction || 0),
      z: Number(planeFrame.plane.normal?.z || 0) * Number(distance || 0) * Number(direction || 0),
    },
    subtractVector3(tipOffset, baseOffset),
  );
  if (!(vectorLength3(extrusionVector) > WORLD_XY_TOLERANCE)) return null;

  const structuredOnlyExtent = extrudeType !== 'distance' && extrudeType !== 'throughAll';
  if (taper || structuredOnlyExtent) {
    reportOcctSketchFallbackOnce(
      'unsupported-structured-extrude',
      'Standalone OCCT sketch extrude supports blind and through-all style prism builds only; draft and face-limited extents still use the compatibility path.',
    );
    return null;
  }

  let handle = 0;
  try {
    handle = adapter.extrudeProfile(occtProfile, {
      plane: occtPlane,
      vector: toTuple3(extrusionVector),
    });
    return finalizeOcctGeometry(adapter, handle, topoBody, 'extrude');
  } catch (error) {
    reportOcctSketchFallbackOnce(
      'occt-extrude-error',
      'OCCT extrude rejected the translated sketch profile.',
      { message: error?.message || String(error) },
    );
    if (handle > 0) adapter.disposeShape(handle);
    return null;
  }
}

export function tryBuildOcctRevolveGeometrySync(options = {}) {
  const {
    profile,
    plane,
    angleRadians,
    axisOrigin,
    axisDirection,
    extentType = 'angle',
    targetFaceRef = null,
    startFaceRef = null,
    endFaceRef = null,
    surfaceOffset = 0,
    topoBody = null,
    sketchToWorld = null,
    sketchVectorToWorld = null,
  } = options;
  if (!profile || !plane) {
    return null;
  }
  const structuredOnlyExtent = extentType !== 'angle';
  if (!structuredOnlyExtent && !(Number(angleRadians) > 0)) return null;

  const planeFrame = resolvePlaneFrame(plane);
  if (!planeFrame) return null;

  const localAxisOrigin = localSketchPoint(axisOrigin, planeFrame);
  const localAxisDirection = localSketchVector(axisDirection, planeFrame);
  if (!localAxisOrigin || !localAxisDirection) return null;

  const axisLength = Math.hypot(localAxisDirection.x, localAxisDirection.y);
  if (!(axisLength > WORLD_XY_TOLERANCE)) return null;

  const normalizedAxis = {
    x: localAxisDirection.x / axisLength,
    y: localAxisDirection.y / axisLength,
    z: 0,
  };

  const adapter = getSharedAdapterSync();
  if (!adapter) return null;

  const occtProfile = buildOcctProfile(profile, [], planeFrame);
  if (!occtProfile) {
    reportOcctSketchFallbackOnce(
      'unsupported-revolve-profile',
      'OCCT sketch revolve currently supports only line/arc/circle profiles that resolve to closed local wires.',
    );
    return null;
  }

  if (adapterHasKernelMethod(adapter, 'revolveProfileWithSpec')) {
    const occtPlane = buildOcctPlaneFrame(planeFrame);
    const worldAxisOrigin = typeof sketchToWorld === 'function'
      ? sketchToWorld(axisOrigin, planeFrame.plane)
      : planeLocalPointToWorld(localAxisOrigin, planeFrame);
    const worldAxisDirection = typeof sketchVectorToWorld === 'function'
      ? normalizeVector3(sketchVectorToWorld(axisDirection, planeFrame.plane))
      : planeLocalVectorToWorld(localAxisDirection, planeFrame);
    if (occtPlane && worldAxisOrigin && worldAxisDirection) {
      let structuredHandle = 0;
      try {
        structuredHandle = adapter.revolveProfileWithSpec({
          profile: occtProfile,
          spec: {
            schemaVersion: 1,
            plane: occtPlane,
            axisOrigin: toTuple3(worldAxisOrigin),
            axisDirection: toTuple3(worldAxisDirection),
            extent: buildStructuredRevolveExtent({ extentType, angleRadians, targetFaceRef, startFaceRef, endFaceRef, surfaceOffset }),
          },
        });
        return finalizeOcctGeometry(adapter, structuredHandle, topoBody, 'revolve');
      } catch (error) {
        reportOcctSketchFallbackOnce(
          'occt-structured-revolve-error',
          'OCCT structured revolve rejected the translated sketch profile; falling back to the legacy OCCT profile revolve.',
          { message: error?.message || String(error) },
        );
        if (structuredHandle > 0) adapter.disposeShape(structuredHandle);
      }
    }
  }

  if (structuredOnlyExtent) return null;

  const localToWorldTransform = buildLocalToWorldTransform(planeFrame);

  let handle = 0;
  let transformedHandle = 0;
  try {
    handle = adapter.revolveProfile(occtProfile, {
      angleRadians,
      axisOrigin: [localAxisOrigin.x, localAxisOrigin.y, 0],
      axisDirection: [normalizedAxis.x, normalizedAxis.y, 0],
    });
    transformedHandle = localToWorldTransform
      ? adapter.transformShape(handle, localToWorldTransform)
      : handle;
    if (transformedHandle !== handle && handle > 0) {
      adapter.disposeShape(handle);
      handle = 0;
    }
    return finalizeOcctGeometry(adapter, transformedHandle, topoBody, 'revolve');
  } catch (error) {
    reportOcctSketchFallbackOnce(
      'occt-revolve-error',
      'OCCT revolve rejected the translated sketch profile.',
      { message: error?.message || String(error) },
    );
    if (transformedHandle > 0 && transformedHandle !== handle) adapter.disposeShape(transformedHandle);
    if (handle > 0) adapter.disposeShape(handle);
    return null;
  }
}

export function tryBuildOcctSweepGeometrySync(options = {}) {
  const {
    profileSketchResult,
    pathSketchResult,
    spec = {},
    shapeHandle = 0,
    topoBody = null,
  } = options;
  const section = buildFirstSectionFromSketchResult(profileSketchResult);
  const spine = buildWorldSketchWire(pathSketchResult);
  if (!section || !spine?.segments?.length) return null;

  const adapter = getSharedAdapterSync();
  if (!adapter || !adapterHasKernelMethod(adapter, 'sweepProfileWithSpec')) return null;

  let handle = 0;
  try {
    const sweepSpec = {
      schemaVersion: 1,
      plane: section.plane,
      spine,
      solid: spec.makeSolid !== false,
      trihedronMode: spec.mode === 'fixed'
        ? { type: 'fixedBinormal', binormal: section.plane.normal }
        : { type: 'frenet' },
    };
    const request = {
      profile: section.profile,
      spec: sweepSpec,
    };
    if (Number.isInteger(shapeHandle) && shapeHandle > 0) request.shape = shapeHandle;
    if (spec.cut === true) request.cut = true;
    handle = adapter.sweepProfileWithSpec(request);
    return finalizeOcctGeometry(adapter, handle, topoBody, 'sweep');
  } catch (error) {
    reportOcctSketchFallbackOnce(
      'occt-structured-sweep-error',
      'OCCT structured sweep rejected the translated sketch profile/path.',
      { message: error?.message || String(error) },
    );
    if (handle > 0) adapter.disposeShape(handle);
    return null;
  }
}

export function tryBuildOcctLoftGeometrySync(options = {}) {
  const { sectionSketchResults = [], spec = {}, shapeHandle = 0, topoBody = null } = options;
  const sections = [];
  for (const sketchResult of sectionSketchResults || []) {
    const section = buildFirstSectionFromSketchResult(sketchResult);
    if (!section) return null;
    sections.push(section);
  }
  if (sections.length < 2) return null;

  const adapter = getSharedAdapterSync();
  if (!adapter || !adapterHasKernelMethod(adapter, 'loftWithSpec')) return null;

  let handle = 0;
  try {
    const request = {
      sections,
      spec: {
        schemaVersion: 1,
        solid: spec.makeSolid !== false,
        ruled: spec.ruled === true,
        continuity: spec.continuity || 'C2',
      },
    };
    if (Number.isInteger(shapeHandle) && shapeHandle > 0) request.shape = shapeHandle;
    if (spec.cut === true) request.cut = true;
    handle = adapter.loftWithSpec(request);
    return finalizeOcctGeometry(adapter, handle, topoBody, 'loft');
  } catch (error) {
    reportOcctSketchFallbackOnce(
      'occt-structured-loft-error',
      'OCCT structured loft rejected the translated sketch sections.',
      { message: error?.message || String(error) },
    );
    if (handle > 0) adapter.disposeShape(handle);
    return null;
  }
}

export function tryBuildOcctBooleanMetadataSync(options = {}) {
  const { handleA, handleB, operation } = options;
  if (!Number.isInteger(handleA) || handleA <= 0) return null;
  if (!Number.isInteger(handleB) || handleB <= 0) return null;

  const adapter = getSharedAdapterSync();
  if (!adapter) return null;

  let resultHandle = 0;
  try {
    switch (operation) {
      case 'union':
        resultHandle = adapter.booleanUnion(handleA, handleB);
        break;
      case 'subtract':
        resultHandle = adapter.booleanSubtract(handleA, handleB);
        break;
      case 'intersect':
        resultHandle = adapter.booleanIntersect(handleA, handleB);
        break;
      default:
        return null;
    }

    if (!(resultHandle > 0)) {
      return null;
    }

    const valid = adapter.checkValidity(resultHandle);
    if (!valid) {
      reportOcctSketchFallbackOnce(
        `occt-boolean-${operation}-invalid-shape`,
        `OCCT resident boolean ${operation} returned an invalid shape; keeping the resident OCCT result and skipping the compatibility fallback on this branch.`,
      );
    }

    const topology = adapter.getTopology(resultHandle);
    const mesh = adapter.tessellate(resultHandle, { topology });
    if (!mesh?.faces?.length) {
      adapter.disposeShape(resultHandle);
      return null;
    }

    return {
      ...mesh,
      occtShapeHandle: resultHandle,
      occtShapeResident: true,
      _occtModeling: {
        authoritative: true,
        acceptedInvalidShape: valid !== true,
        operation,
        source: 'resident-boolean',
        topology,
      },
    };
  } catch {
    if (resultHandle > 0) adapter.disposeShape(resultHandle);
    return null;
  }
}

function _normalizeBlendCapabilities(capabilities) {
  const operations = capabilities?.operations && typeof capabilities.operations === 'object'
    ? capabilities.operations
    : null;
  const fillet = capabilities?.fillet && typeof capabilities.fillet === 'object'
    ? capabilities.fillet
    : null;
  const chamfer = capabilities?.chamfer && typeof capabilities.chamfer === 'object'
    ? capabilities.chamfer
    : null;
  return {
    fillet: operations?.fillet === true
      || operations?.nativeExactBlendOpsV1 === true
      || capabilities?.fillet === true
      || fillet?.nativeExact === true,
    chamfer: operations?.chamfer === true
      || operations?.nativeExactBlendOpsV1 === true
      || capabilities?.chamfer === true
      || chamfer?.nativeExact === true,
  };
}

function _normalizeBlendEdgeRef(edge) {
  if (!edge || typeof edge !== 'object') return null;
  const stableHash = typeof edge.stableHash === 'string' && edge.stableHash.length > 0
    ? edge.stableHash
    : null;
  const topoId = Number.isInteger(edge.topoId) ? edge.topoId : null;
  if (!stableHash && topoId == null) return null;
  return {
    ...(stableHash ? { stableHash } : {}),
    ...(topoId != null ? { topoId } : {}),
  };
}

function _resolveConcreteBlendEdgeRef(adapter, handle, edgeRef) {
  const normalized = _normalizeBlendEdgeRef(edgeRef);
  if (!normalized) return null;
  if (normalized.topoId != null) return normalized;
  if (!normalized.stableHash || typeof adapter?.resolveStableEntity !== 'function') return normalized;

  try {
    const resolved = adapter.resolveStableEntity(handle, normalized.stableHash);
    const resolvedTopoId = Number.isInteger(resolved?.topoId)
      ? resolved.topoId
      : (Number.isInteger(resolved?.id) ? resolved.id : null);
    const resolvedKind = typeof resolved?.kind === 'string' ? resolved.kind.toLowerCase() : null;
    if (resolvedTopoId == null) return normalized;
    if (resolvedKind && resolvedKind !== 'edge') return normalized;
    return {
      topoId: resolvedTopoId,
      ...(normalized.stableHash ? { stableHash: normalized.stableHash } : {}),
    };
  } catch {
    return normalized;
  }
}

function _promoteBlendEdgeRefs(adapter, handle, edgeRefs) {
  return edgeRefs.map((edgeRef) => _resolveConcreteBlendEdgeRef(adapter, handle, edgeRef)).filter(Boolean);
}

function _blendEdgeRefsChanged(leftRefs, rightRefs) {
  if (!Array.isArray(leftRefs) || !Array.isArray(rightRefs) || leftRefs.length !== rightRefs.length) return true;
  for (let index = 0; index < leftRefs.length; index += 1) {
    const left = leftRefs[index];
    const right = rightRefs[index];
    if ((left?.topoId ?? null) !== (right?.topoId ?? null)) return true;
    if ((left?.stableHash ?? null) !== (right?.stableHash ?? null)) return true;
  }
  return false;
}

function _cloneBlendSpecWithResolvedRefs(spec, resolvedEdgeRefs) {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.edges)) return spec;
  return {
    ...spec,
    edges: spec.edges.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return {
          edge: resolvedEdgeRefs[index],
        };
      }
      const nextEntry = { ...entry };
      nextEntry.edge = resolvedEdgeRefs[index] || _normalizeBlendEdgeRef(entry.edge ?? entry.edgeRef ?? entry);
      delete nextEntry.edgeRef;
      delete nextEntry.topoId;
      delete nextEntry.stableHash;
      return nextEntry;
    }),
  };
}

function _populateBlendFailureInfo(target, payload) {
  if (!target || typeof target !== 'object' || !payload || typeof payload !== 'object') return;
  Object.assign(target, payload);
}

function _buildBlendFeatureSpec(kind, edgeRefs, params = {}) {
  const edges = edgeRefs.map((edgeRef) => ({
    edge: edgeRef,
    ...(params.perEdge || {}),
  }));
  return {
    schemaVersion: 1,
    unit: { length: 'model', angle: 'radians' },
    ...params.spec,
    edges,
  };
}

function _finalizeOcctBlendResult(adapter, operation, blendResult, topoBody, sourceTopology = null) {
  const handle = blendResult?.shape?.id || blendResult?.shapeId || blendResult?.shapeHandle || 0;
  const geometry = finalizeOcctGeometry(adapter, handle, topoBody, operation, { liveBlendDisplay: true });
  if (!geometry) return null;
  const blendFaces = Array.isArray(blendResult?.blendFaces) ? blendResult.blendFaces : [];
  applyOcctBlendFaceMetadata(geometry, operation, blendFaces, sourceTopology);
  const edgeBuildStartedAt = occtSketchNowMs();
  attachOcctBlendFeatureEdges(geometry);
  const edgeBuildMs = occtSketchNowMs() - edgeBuildStartedAt;
  const finalizeTiming = geometry._occtFinalizeTiming || null;
  const totalMs = (finalizeTiming?.totalMs || 0) + edgeBuildMs;
  if (totalMs >= OCCT_BLEND_LOG_THRESHOLD_MS && typeof console?.info === 'function') {
    console.info('OCCT blend finalize timing', {
      operation,
      validMs: finalizeTiming ? +finalizeTiming.validMs.toFixed(1) : 0,
      topologyMs: finalizeTiming ? +finalizeTiming.topologyMs.toFixed(1) : 0,
      tessellateMs: finalizeTiming ? +finalizeTiming.tessellateMs.toFixed(1) : 0,
      edgeBuildMs: +edgeBuildMs.toFixed(1),
      totalMs: +totalMs.toFixed(1),
    });
  }
  geometry._occtBlend = {
    blendFaces,
    lineage: blendResult?.lineage || null,
    status: blendResult?.status || null,
    revision: blendResult?.revision || null,
  };
  if (blendResult?.topology) {
    geometry._occtModeling = {
      ...(geometry._occtModeling || {}),
      topology: blendResult.topology,
    };
  }
  return geometry;
}

export function tryBuildOcctFilletMetadataSync(options = {}) {
  const {
    handle,
    edgeRefs = [],
    topoBody = null,
    sourceTopology = null,
    radius = null,
    spec = null,
    failureInfo = null,
  } = options;
  if (!Number.isInteger(handle) || handle <= 0) return null;
  if (!Array.isArray(edgeRefs) || edgeRefs.length === 0) return null;

  const adapter = getSharedAdapterSync();
  if (!adapter) return null;
  const capabilities = _normalizeBlendCapabilities(adapter.getCapabilities());
  if (capabilities.fillet !== true) return null;

  const normalizedEdgeRefs = edgeRefs.map(_normalizeBlendEdgeRef).filter(Boolean);
  if (normalizedEdgeRefs.length === 0) return null;

  const promotedEdgeRefs = _promoteBlendEdgeRefs(adapter, handle, normalizedEdgeRefs);
  const usePromotedEdgeRefs = promotedEdgeRefs.length === normalizedEdgeRefs.length
    && _blendEdgeRefsChanged(promotedEdgeRefs, normalizedEdgeRefs);
  const effectiveEdgeRefs = usePromotedEdgeRefs ? promotedEdgeRefs : normalizedEdgeRefs;

  const filletSpec = spec
    ? _cloneBlendSpecWithResolvedRefs(spec, effectiveEdgeRefs)
    : _buildBlendFeatureSpec('fillet', effectiveEdgeRefs, {
    spec: {
      radiusMode: 'constant',
      radius: Number(radius) || 0,
    },
  });
  const fallbackSpec = usePromotedEdgeRefs && spec
    ? _cloneBlendSpecWithResolvedRefs(spec, normalizedEdgeRefs)
    : null;

  try {
    let kernelMs = 0;
    let retriedKernel = false;
    let resolvedStableHashes = 0;
    let lastError = null;
    const invokeFillet = (requestedSpec) => {
      try {
        return adapter.filletEdges(handle, requestedSpec);
      } catch (error) {
        lastError = error;
        return null;
      }
    };
    let kernelStartedAt = occtSketchNowMs();
    let blendResult = invokeFillet(filletSpec);
    kernelMs += occtSketchNowMs() - kernelStartedAt;
    if (usePromotedEdgeRefs) {
      resolvedStableHashes = promotedEdgeRefs.reduce((count, edgeRef, index) => (
        edgeRef?.topoId != null && normalizedEdgeRefs[index]?.topoId == null ? count + 1 : count
      ), 0);
    }
    if (!blendResult || typeof blendResult !== 'object') {
      // Some first-pass blend calls on freshly restored OCCT state can return
      // an empty result even though the same resident handle/spec succeeds on
      // an immediate retry.
      kernelStartedAt = occtSketchNowMs();
      blendResult = invokeFillet(filletSpec);
      kernelMs += occtSketchNowMs() - kernelStartedAt;
      retriedKernel = true;
    }
    if ((!blendResult || typeof blendResult !== 'object') && usePromotedEdgeRefs && fallbackSpec) {
      kernelStartedAt = occtSketchNowMs();
      blendResult = invokeFillet(fallbackSpec);
      kernelMs += occtSketchNowMs() - kernelStartedAt;
      retriedKernel = true;
    }
    if (!blendResult || typeof blendResult !== 'object') {
      let revision = null;
      let analysis = null;
      try {
        if (typeof adapter.getRevisionInfo === 'function') {
          revision = adapter.getRevisionInfo(handle);
        }
      } catch {
        revision = null;
      }
      try {
        if (typeof adapter.analyzeShape === 'function') {
          analysis = adapter.analyzeShape(handle);
        }
      } catch {
        analysis = null;
      }
      _populateBlendFailureInfo(failureInfo, {
        operation: 'fillet',
        edgeRefCount: normalizedEdgeRefs.length,
        resolvedStableHashes,
        usedPromotedEdgeRefs: usePromotedEdgeRefs,
        retriedKernel,
        requestedEdgeRefs: normalizedEdgeRefs,
        effectiveEdgeRefs,
        nativeError: lastError
          ? {
            name: lastError.name || 'Error',
            code: lastError.code || null,
            message: lastError.message || String(lastError),
            detail: lastError.detail || null,
          }
          : null,
        revision: revision && typeof revision === 'object'
          ? {
            revisionId: revision.revisionId ?? null,
            topologyHash: revision.topologyHash ?? null,
          }
          : null,
        analysis: analysis && typeof analysis === 'object'
          ? {
            valid: analysis.valid ?? analysis.isValid ?? null,
            shapeType: analysis.shapeType ?? null,
            solidCount: analysis.solidCount ?? null,
            faceCount: analysis.faceCount ?? null,
            edgeCount: analysis.edgeCount ?? null,
            vertexCount: analysis.vertexCount ?? null,
          }
          : null,
      });
      return null;
    }
    const finalizeStartedAt = occtSketchNowMs();
    const geometry = _finalizeOcctBlendResult(adapter, 'fillet', blendResult, topoBody, sourceTopology);
    const finalizeMs = occtSketchNowMs() - finalizeStartedAt;
    const totalMs = kernelMs + finalizeMs;
    if (totalMs >= OCCT_BLEND_LOG_THRESHOLD_MS && typeof console?.info === 'function') {
      console.info('OCCT fillet timing', {
        edgeRefCount: normalizedEdgeRefs.length,
        resolvedStableHashes,
        retriedKernel,
        kernelMs: +kernelMs.toFixed(1),
        finalizeMs: +finalizeMs.toFixed(1),
        totalMs: +totalMs.toFixed(1),
      });
    }
    return geometry;
  } catch {
    return null;
  }
}

export function tryBuildOcctChamferMetadataSync(options = {}) {
  const {
    handle,
    edgeRefs = [],
    topoBody = null,
    sourceTopology = null,
    distance = null,
    spec = null,
    failureInfo = null,
  } = options;
  if (!Number.isInteger(handle) || handle <= 0) return null;
  if (!Array.isArray(edgeRefs) || edgeRefs.length === 0) return null;

  const adapter = getSharedAdapterSync();
  if (!adapter) return null;
  const capabilities = _normalizeBlendCapabilities(adapter.getCapabilities());
  if (capabilities.chamfer !== true) return null;

  const normalizedEdgeRefs = edgeRefs.map(_normalizeBlendEdgeRef).filter(Boolean);
  if (normalizedEdgeRefs.length === 0) return null;

  const promotedEdgeRefs = _promoteBlendEdgeRefs(adapter, handle, normalizedEdgeRefs);
  const usePromotedEdgeRefs = promotedEdgeRefs.length === normalizedEdgeRefs.length
    && _blendEdgeRefsChanged(promotedEdgeRefs, normalizedEdgeRefs);
  const effectiveEdgeRefs = usePromotedEdgeRefs ? promotedEdgeRefs : normalizedEdgeRefs;
  const chamferSpec = spec
    ? _cloneBlendSpecWithResolvedRefs(spec, effectiveEdgeRefs)
    : _buildBlendFeatureSpec('chamfer', effectiveEdgeRefs, {
      spec: {
        mode: 'symmetric',
        distance: Number(distance) || 0,
      },
    });
  const fallbackSpec = usePromotedEdgeRefs && spec
    ? _cloneBlendSpecWithResolvedRefs(spec, normalizedEdgeRefs)
    : null;

  try {
    let kernelMs = 0;
    let retriedKernel = false;
    let resolvedStableHashes = 0;
    let lastError = null;
    const invokeChamfer = (requestedSpec) => {
      try {
        return adapter.chamferEdges(handle, requestedSpec);
      } catch (error) {
        lastError = error;
        return null;
      }
    };
    let kernelStartedAt = occtSketchNowMs();
    let blendResult = invokeChamfer(chamferSpec);
    kernelMs += occtSketchNowMs() - kernelStartedAt;
    if (usePromotedEdgeRefs) {
      resolvedStableHashes = promotedEdgeRefs.reduce((count, edgeRef, index) => (
        edgeRef?.topoId != null && normalizedEdgeRefs[index]?.topoId == null ? count + 1 : count
      ), 0);
    }
    if (!blendResult || typeof blendResult !== 'object') {
      kernelStartedAt = occtSketchNowMs();
      blendResult = invokeChamfer(chamferSpec);
      kernelMs += occtSketchNowMs() - kernelStartedAt;
      retriedKernel = true;
    }
    if ((!blendResult || typeof blendResult !== 'object') && usePromotedEdgeRefs && fallbackSpec) {
      kernelStartedAt = occtSketchNowMs();
      blendResult = invokeChamfer(fallbackSpec);
      kernelMs += occtSketchNowMs() - kernelStartedAt;
      retriedKernel = true;
    }
    if (!blendResult || typeof blendResult !== 'object') {
      let revision = null;
      let analysis = null;
      try {
        if (typeof adapter.getRevisionInfo === 'function') {
          revision = adapter.getRevisionInfo(handle);
        }
      } catch {
        revision = null;
      }
      try {
        if (typeof adapter.analyzeShape === 'function') {
          analysis = adapter.analyzeShape(handle);
        }
      } catch {
        analysis = null;
      }
      _populateBlendFailureInfo(failureInfo, {
        operation: 'chamfer',
        edgeRefCount: normalizedEdgeRefs.length,
        resolvedStableHashes,
        usedPromotedEdgeRefs: usePromotedEdgeRefs,
        retriedKernel,
        requestedEdgeRefs: normalizedEdgeRefs,
        effectiveEdgeRefs,
        nativeError: lastError
          ? {
            name: lastError.name || 'Error',
            code: lastError.code || null,
            message: lastError.message || String(lastError),
            detail: lastError.detail || null,
          }
          : null,
        revision: revision && typeof revision === 'object'
          ? {
            revisionId: revision.revisionId ?? null,
            topologyHash: revision.topologyHash ?? null,
          }
          : null,
        analysis: analysis && typeof analysis === 'object'
          ? {
            valid: analysis.valid ?? analysis.isValid ?? null,
            shapeType: analysis.shapeType ?? null,
            solidCount: analysis.solidCount ?? null,
            faceCount: analysis.faceCount ?? null,
            edgeCount: analysis.edgeCount ?? null,
            vertexCount: analysis.vertexCount ?? null,
          }
          : null,
      });
      return null;
    }
    const finalizeStartedAt = occtSketchNowMs();
    const geometry = _finalizeOcctBlendResult(adapter, 'chamfer', blendResult, topoBody, sourceTopology);
    const finalizeMs = occtSketchNowMs() - finalizeStartedAt;
    const totalMs = kernelMs + finalizeMs;
    if (totalMs >= OCCT_BLEND_LOG_THRESHOLD_MS && typeof console?.info === 'function') {
      console.info('OCCT chamfer timing', {
        edgeRefCount: normalizedEdgeRefs.length,
        resolvedStableHashes,
        retriedKernel,
        kernelMs: +kernelMs.toFixed(1),
        finalizeMs: +finalizeMs.toFixed(1),
        totalMs: +totalMs.toFixed(1),
      });
    }
    return geometry;
  } catch {
    return null;
  }
}

export function tryImportOcctStepResidencySync(options = {}) {
  const {
    stepData,
    heal = true,
    sew = true,
    fixSameParameter = true,
    fixSolid = true,
    includeMesh = false,
    tessellationOptions = null,
  } = options;
  if (typeof stepData !== 'string' || stepData.length === 0) return null;

  const adapter = getSharedAdapterSync();
  if (!adapter) return null;

  let importResult = null;
  let importedWithPackage = false;
  try {
    try {
      importResult = adapter.importStepPackage(stepData, {
        heal,
        sew,
        fixSameParameter,
        fixSolid,
        linearDeflection: tessellationOptions?.linearDeflection ?? tessellationOptions?.chordalDeviation,
        angularDeflection: tessellationOptions?.angularDeflection ?? tessellationOptions?.angularTolerance,
      });
      importedWithPackage = !!importResult;
    } catch {
      importResult = null;
      importedWithPackage = false;
    }

    let handle = importResult?.shapeHandle || 0;
    if (!(handle > 0) || adapter.checkValidity(handle) !== true) {
      if (handle > 0) adapter.disposeShape(handle);
      importResult = adapter.importStepDetailed(stepData, {
        heal,
        sew,
        fixSameParameter,
        fixSolid,
      });
      importedWithPackage = false;
    }

    handle = importResult?.shapeHandle || 0;
    if (!(handle > 0) || adapter.checkValidity(handle) !== true) {
      if (handle > 0) adapter.disposeShape(handle);
      return null;
    }

    let topology = importResult.topology || adapter.getTopology(handle);
    let mesh = null;
    if (includeMesh) {
      mesh = adapter.tessellate(handle, {
        ...(tessellationOptions || {}),
        topology,
      });
      if (!mesh?.faces?.length && importedWithPackage) {
        adapter.disposeShape(handle);
        importResult = adapter.importStepDetailed(stepData, {
          heal,
          sew,
          fixSameParameter,
          fixSolid,
        });
        importedWithPackage = false;
        handle = importResult?.shapeHandle || 0;
        if (!(handle > 0) || adapter.checkValidity(handle) !== true) {
          if (handle > 0) adapter.disposeShape(handle);
          return null;
        }
        topology = importResult.topology || adapter.getTopology(handle);
        mesh = adapter.tessellate(handle, {
          ...(tessellationOptions || {}),
          topology,
        });
      }
      if (!mesh?.faces?.length) mesh = null;
    }

    return {
      occtShapeHandle: handle,
      occtShapeResident: true,
      mesh,
      occtCheckpoint: importResult.checkpoint || null,
      _occtModeling: {
        authoritative: !!mesh,
        source: 'step-import',
        topology: importResult.topology || topology,
        import: {
          readStatus: importResult.readStatus ?? null,
          transferStatus: importResult.transferStatus ?? null,
          rootCount: importResult.rootCount ?? 0,
          transferredRootCount: importResult.transferredRootCount ?? 0,
          isValid: importResult.isValid === true,
          wasValidBeforeHealing: importResult.wasValidBeforeHealing === true,
          healed: importResult.healed === true,
          messageCount: Array.isArray(importResult.messageList) ? importResult.messageList.length : 0,
        },
      },
    };
  } catch {
    const handle = importResult?.shapeHandle || 0;
    if (handle > 0) adapter.disposeShape(handle);
    return null;
  }
}

export function exportOcctSketchModelingStep(handle) {
  if (!sharedAdapter || !Number.isInteger(handle) || handle <= 0) return null;
  return sharedAdapter.exportStep(handle);
}

export function getOcctSketchModelingTopology(handle) {
  if (!sharedAdapter || !Number.isInteger(handle) || handle <= 0) return null;
  return sharedAdapter.getTopology(handle);
}

export function createOcctSketchModelingCheckpoint(handle) {
  const adapter = getSharedAdapterSync();
  if (!adapter || !Number.isInteger(handle) || handle <= 0) return null;
  return adapter.createCheckpoint(handle);
}

export function cloneOcctCheckpointMeshSnapshot(meshSnapshot) {
  if (!meshSnapshot || typeof meshSnapshot !== 'object') return null;
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(meshSnapshot);
    }
    return JSON.parse(JSON.stringify(meshSnapshot));
  } catch {
    return null;
  }
}

export function restoreOcctSketchModelingCheckpoint(checkpoint, tessellationOptions = null, meshSnapshot = null) {
  const adapter = getSharedAdapterSync();
  if (!adapter || !checkpoint || typeof checkpoint !== 'object') return null;

  let handle = 0;
  try {
    handle = adapter.hydrateCheckpoint(checkpoint);
    if (!(handle > 0)) return null;

    const valid = adapter.checkValidity(handle);
    const topology = adapter.getTopology(handle);
    let geometry = cloneOcctCheckpointMeshSnapshot(meshSnapshot);
    if (!geometry?.faces?.length) {
      geometry = adapter.tessellate(handle, {
        ...(tessellationOptions || {}),
        topology,
      });
    }
    if (!geometry?.faces?.length) {
      adapter.disposeShape(handle);
      return null;
    }

    geometry.topoBody = null;
    geometry.occtShapeHandle = handle;
    geometry.occtShapeResident = true;
    const previousModeling = geometry._occtModeling && typeof geometry._occtModeling === 'object'
      ? geometry._occtModeling
      : null;
    // A retessellated restore is always authoritative; snapshot-backed restores
    // preserve any explicit non-authoritative flag captured in the saved mesh.
    geometry._occtModeling = {
      ...(previousModeling || {}),
      authoritative: previousModeling?.authoritative !== false,
      acceptedInvalidShape: valid !== true,
      operation: topology?.operationType || previousModeling?.operation || null,
      source: 'checkpoint-restore',
      topology: topology || previousModeling?.topology || null,
    };

    return {
      geometry,
      mesh: geometry,
      occtShapeHandle: handle,
      occtShapeResident: true,
      topology,
      _occtModeling: geometry._occtModeling,
    };
  } catch (error) {
    if (handle > 0) {
      try {
        adapter.disposeShape(handle);
      } catch {
        // Best-effort cleanup after failed checkpoint restore.
      }
    }
    throw error;
  }
}

export function ensureOcctGeometryResidentFromCheckpoint(geometry, checkpoint = null) {
  if (geometry?.occtShapeHandle > 0) {
    return {
      geometry,
      mesh: geometry,
      occtShapeHandle: geometry.occtShapeHandle,
      occtShapeResident: geometry.occtShapeResident === true,
      topology: geometry?._occtModeling?.topology || null,
      _occtModeling: geometry?._occtModeling || null,
    };
  }

  const adapter = getSharedAdapterSync();
  const resolvedCheckpoint = checkpoint || geometry?.occtCheckpoint || null;
  if (!adapter || !geometry || !resolvedCheckpoint || typeof resolvedCheckpoint !== 'object') {
    return null;
  }

  let handle = 0;
  try {
    handle = adapter.hydrateCheckpoint(resolvedCheckpoint);
    if (!(handle > 0)) return null;

    const valid = adapter.checkValidity(handle);
    const topology = adapter.getTopology(handle);
    const previousModeling = geometry._occtModeling && typeof geometry._occtModeling === 'object'
      ? geometry._occtModeling
      : null;

    geometry.topoBody = null;
    geometry.occtShapeHandle = handle;
    geometry.occtShapeResident = true;
    geometry.occtCheckpoint = resolvedCheckpoint;
    geometry._occtModeling = {
      ...(previousModeling || {}),
      authoritative: previousModeling?.authoritative !== false,
      acceptedInvalidShape: valid !== true,
      operation: topology?.operationType || previousModeling?.operation || null,
      source: 'checkpoint-restore',
      topology: topology || previousModeling?.topology || null,
    };

    return {
      geometry,
      mesh: geometry,
      occtShapeHandle: handle,
      occtShapeResident: true,
      topology,
      _occtModeling: geometry._occtModeling,
    };
  } catch (error) {
    if (handle > 0) {
      try {
        adapter.disposeShape(handle);
      } catch {
        // Best-effort cleanup after failed checkpoint hydration.
      }
    }
    throw error;
  }
}

export function disposeOcctSketchModelingShape(handle) {
  if (!sharedAdapter || !Number.isInteger(handle) || handle <= 0) return;
  try {
    sharedAdapter.disposeShape(handle);
  } catch {
    // Best-effort disposal for replaced feature results.
  }
}

export function invalidateOcctSketchModelingSession() {
  if (!sharedAdapter) return;
  try {
    sharedAdapter.dispose();
  } finally {
    sharedAdapter = null;
  }
}
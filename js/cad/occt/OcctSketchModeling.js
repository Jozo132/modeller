import { getFlag } from '../../featureFlags.js';

import {
  getCachedOcctKernelModule,
  occtKernelReadySync,
  resolveOcctKernelEnv,
} from './OcctKernelLoader.js';
import { OcctKernelAdapter } from './OcctKernelAdapter.js';

const OCCT_SKETCH_SOLID_FLAG = 'CAD_USE_OCCT_SKETCH_SOLIDS';
const WORLD_XY_TOLERANCE = 1e-6;

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

function finalizeOcctGeometry(adapter, handle, topoBody, operation) {
  if (!handle || handle <= 0) {
    reportOcctSketchFallbackOnce(
      `occt-${operation}-empty-handle`,
      `OCCT ${operation} returned an empty shape handle.`,
    );
    return null;
  }

  const valid = adapter.checkValidity(handle);
  if (!valid) {
    reportOcctSketchFallbackOnce(
      `occt-${operation}-invalid-shape`,
      `OCCT ${operation} returned an invalid shape; keeping the resident OCCT result and skipping the compatibility fallback on this branch.`,
    );
  }

  const geometry = adapter.tessellate(handle);
  if (!geometry?.faces?.length) {
    reportOcctSketchFallbackOnce(
      `occt-${operation}-empty-tessellation`,
      `OCCT ${operation} produced no tessellated faces.`,
    );
    adapter.disposeShape(handle);
    return null;
  }

  const topology = adapter.getTopology(handle);
  geometry.topoBody = topoBody || null;
  geometry.occtShapeHandle = handle;
  geometry.occtShapeResident = true;
  geometry._occtModeling = {
    authoritative: true,
    operation,
    acceptedInvalidShape: valid !== true,
    topology,
  };
  return geometry;
}

export function tryBuildOcctExtrudeGeometrySync(options = {}) {
  if (getFlag(OCCT_SKETCH_SOLID_FLAG) !== true) {
    reportOcctSketchFallbackOnce(
      'flag-disabled',
      'CAD_USE_OCCT_SKETCH_SOLIDS is disabled; sketch solids stay on the compatibility exact path.',
    );
    return null;
  }

  const {
    profile,
    plane,
    distance,
    direction = 1,
    symmetric = false,
    extrudeType = 'distance',
    taper = false,
    holes = [],
    baseOffset = null,
    tipOffset = null,
    topoBody = null,
  } = options;
  if (!profile || !plane) return null;
  if (symmetric || taper || (extrudeType !== 'distance' && extrudeType !== 'throughAll')) {
    reportOcctSketchFallbackOnce(
      'unsupported-extrude-options',
      'OCCT sketch extrude currently supports distance and through-all style extrudes only, without symmetry or taper.',
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
  if (getFlag(OCCT_SKETCH_SOLID_FLAG) !== true) return null;

  const {
    profile,
    plane,
    angleRadians,
    axisOrigin,
    axisDirection,
    topoBody = null,
  } = options;
  if (!profile || !plane) {
    return null;
  }
  if (!(Number(angleRadians) > 0)) return null;

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

export function tryBuildOcctBooleanMetadataSync(options = {}) {
  if (getFlag(OCCT_SKETCH_SOLID_FLAG) !== true) return null;

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

    const mesh = adapter.tessellate(resultHandle);
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
        topology: adapter.getTopology(resultHandle),
      },
    };
  } catch {
    if (resultHandle > 0) adapter.disposeShape(resultHandle);
    return null;
  }
}

export function tryImportOcctStepResidencySync(options = {}) {
  if (getFlag(OCCT_SKETCH_SOLID_FLAG) !== true) return null;

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
  try {
    importResult = adapter.importStepDetailed(stepData, {
      heal,
      sew,
      fixSameParameter,
      fixSolid,
    });
    const handle = importResult?.shapeHandle || 0;
    if (!(handle > 0) || adapter.checkValidity(handle) !== true) {
      if (handle > 0) adapter.disposeShape(handle);
      return null;
    }

    let mesh = null;
    if (includeMesh) {
      mesh = adapter.tessellate(handle, tessellationOptions || {});
      if (!mesh?.faces?.length) mesh = null;
    }

    return {
      occtShapeHandle: handle,
      occtShapeResident: true,
      mesh,
      _occtModeling: {
        authoritative: !!mesh,
        source: 'step-import',
        topology: adapter.getTopology(handle),
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
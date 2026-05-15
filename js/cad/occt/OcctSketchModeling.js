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

function cleanNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.abs(number) < 1e-12 ? 0 : number;
}

function nearlyZero(value, tolerance = WORLD_XY_TOLERANCE) {
  return Math.abs(Number(value) || 0) <= tolerance;
}

function toWorldXY(point) {
  if (!point) return null;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return null;
  if (!nearlyZero(point.z)) return null;
  return {
    x: cleanNumber(point.x),
    y: cleanNumber(point.y),
  };
}

function toTuple(point) {
  return [cleanNumber(point.x), cleanNumber(point.y)];
}

function pointsMatch(a, b) {
  if (!a || !b) return false;
  return nearlyZero(a.x - b.x, 1e-5) && nearlyZero(a.y - b.y, 1e-5);
}

function worldSketchPoint(point, sketchToWorld, plane) {
  return toWorldXY(sketchToWorld(point, plane));
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

function buildLineSegment(profile, edge, sketchToWorld, plane) {
  const endpoints = profileEdgeEndpoints(profile, edge);
  if (!endpoints) return null;
  const start = worldSketchPoint(endpoints.start, sketchToWorld, plane);
  const end = worldSketchPoint(endpoints.end, sketchToWorld, plane);
  if (!start || !end || pointsMatch(start, end)) return null;
  return {
    type: 'line',
    start: toTuple(start),
    end: toTuple(end),
  };
}

function buildArcSegment(edge, sketchToWorld, plane) {
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

  const start = worldSketchPoint(sketchPointAt(startAngle), sketchToWorld, plane);
  const mid = worldSketchPoint(sketchPointAt(startAngle + sweepAngle * 0.5), sketchToWorld, plane);
  const end = worldSketchPoint(sketchPointAt(startAngle + sweepAngle), sketchToWorld, plane);
  if (!start || !mid || !end) return null;
  if (pointsMatch(start, mid) || pointsMatch(mid, end) || pointsMatch(start, end)) return null;

  return {
    type: 'arc',
    start: toTuple(start),
    mid: toTuple(mid),
    end: toTuple(end),
  };
}

function buildCircleSegment(edge, sketchToWorld, plane) {
  const center = edge?.center;
  const radius = Number(edge?.radius);
  if (!center || !Number.isFinite(radius) || radius <= WORLD_XY_TOLERANCE) return null;

  const centre = worldSketchPoint(center, sketchToWorld, plane);
  if (!centre) return null;

  return {
    type: 'circle',
    centre: toTuple(centre),
    radius: cleanNumber(radius),
  };
}

function segmentStart(segment) {
  if (!segment) return null;
  if (segment.type === 'circle') return null;
  return { x: segment.start[0], y: segment.start[1] };
}

function segmentEnd(segment) {
  if (!segment) return null;
  if (segment.type === 'circle') return null;
  return { x: segment.end[0], y: segment.end[1] };
}

function buildOcctProfile(profile, sketchToWorld, plane) {
  const edges = Array.isArray(profile?.edges) ? profile.edges : [];
  if (edges.length === 0) return null;

  const segments = [];
  for (const edge of edges) {
    const type = edge?.type || 'segment';
    let segment = null;
    if (type === 'segment' || type === 'line') {
      segment = buildLineSegment(profile, edge, sketchToWorld, plane);
    } else if (type === 'arc') {
      segment = buildArcSegment(edge, sketchToWorld, plane);
    } else if (type === 'circle') {
      segment = buildCircleSegment(edge, sketchToWorld, plane);
    } else {
      return null;
    }
    if (!segment) return null;
    segments.push(segment);
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

function getSharedAdapterSync() {
  if (sharedAdapter) return sharedAdapter;

  const env = resolveOcctKernelEnv();
  const loaded = getCachedOcctKernelModule() || getCachedOcctKernelModule(env);
  if (!loaded?.module && !occtKernelReadySync() && !occtKernelReadySync(env)) return null;
  if (!loaded?.module) return null;

  sharedAdapter = OcctKernelAdapter.createSync({ loaded });
  return sharedAdapter;
}

function finalizeOcctGeometry(adapter, handle, topoBody, operation) {
  if (!handle || handle <= 0) return null;

  const valid = adapter.checkValidity(handle);
  if (!valid) {
    adapter.disposeShape(handle);
    return null;
  }

  const geometry = adapter.tessellate(handle);
  if (!geometry?.faces?.length) {
    adapter.disposeShape(handle);
    return null;
  }

  geometry.topoBody = topoBody || null;
  geometry.occtShapeHandle = handle;
  geometry.occtShapeResident = true;
  geometry._occtModeling = {
    authoritative: true,
    operation,
    topology: adapter.getTopology(handle),
  };
  return geometry;
}

export function tryBuildOcctExtrudeGeometrySync(options = {}) {
  if (getFlag(OCCT_SKETCH_SOLID_FLAG) !== true) return null;

  const {
    profile,
    plane,
    distance,
    direction = 1,
    symmetric = false,
    extrudeType = 'distance',
    taper = false,
    holes = [],
    topoBody = null,
    sketchToWorld,
  } = options;
  if (!profile || !plane || typeof sketchToWorld !== 'function') return null;
  if (symmetric || taper || extrudeType !== 'distance') return null;
  if (Array.isArray(holes) && holes.length > 0) return null;

  const adapter = getSharedAdapterSync();
  if (!adapter) return null;

  const occtProfile = buildOcctProfile(profile, sketchToWorld, plane);
  if (!occtProfile) return null;

  const extrusionVector = {
    x: Number(plane.normal?.x || 0) * Number(distance || 0) * Number(direction || 0),
    y: Number(plane.normal?.y || 0) * Number(distance || 0) * Number(direction || 0),
    z: Number(plane.normal?.z || 0) * Number(distance || 0) * Number(direction || 0),
  };
  if (!nearlyZero(extrusionVector.x) || !nearlyZero(extrusionVector.y) || extrusionVector.z <= WORLD_XY_TOLERANCE) {
    return null;
  }

  let handle = 0;
  try {
    handle = adapter.extrudeProfile(occtProfile, extrusionVector.z);
    return finalizeOcctGeometry(adapter, handle, topoBody, 'extrude');
  } catch {
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
    sketchToWorld,
    sketchVectorToWorld,
  } = options;
  if (!profile || !plane || typeof sketchToWorld !== 'function' || typeof sketchVectorToWorld !== 'function') {
    return null;
  }
  if (!(Number(angleRadians) > 0)) return null;

  const axisOriginWorld = sketchToWorld(axisOrigin, plane);
  const axisDirectionWorld = sketchVectorToWorld(axisDirection, plane);
  if (!axisOriginWorld || !axisDirectionWorld) return null;
  if (!nearlyZero(axisOriginWorld.x) || !nearlyZero(axisOriginWorld.z)) return null;

  const axisLength = Math.hypot(axisDirectionWorld.x, axisDirectionWorld.y, axisDirectionWorld.z);
  if (!(axisLength > WORLD_XY_TOLERANCE)) return null;

  const normalizedAxis = {
    x: axisDirectionWorld.x / axisLength,
    y: axisDirectionWorld.y / axisLength,
    z: axisDirectionWorld.z / axisLength,
  };
  if (!nearlyZero(normalizedAxis.x) || !nearlyZero(normalizedAxis.z) || Math.abs(normalizedAxis.y - 1) > WORLD_XY_TOLERANCE) {
    return null;
  }

  const adapter = getSharedAdapterSync();
  if (!adapter) return null;

  const occtProfile = buildOcctProfile(profile, sketchToWorld, plane);
  if (!occtProfile) return null;

  let handle = 0;
  try {
    handle = adapter.revolveProfile(occtProfile, angleRadians);
    return finalizeOcctGeometry(adapter, handle, topoBody, 'revolve');
  } catch {
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

    if (!(resultHandle > 0) || adapter.checkValidity(resultHandle) !== true) {
      if (resultHandle > 0) adapter.disposeShape(resultHandle);
      return null;
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
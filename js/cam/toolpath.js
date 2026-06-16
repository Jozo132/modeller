import { getOperationLoops, getOperationSegmentLoops, getOperationSourceSurfaces, normalizeCamConfig } from './model.js';
import { cleanLoop, offsetPolygon, polygonArea } from './geometry/polygonOffset.js';
import { isWorldZAlignedPlane, normalizeCamPlane } from './plane.js';

const EPSILON = 1e-9;
const MAX_POCKET_SCAN_LEVELS = 10000;
const MAX_POCKET_CONTOUR_SHELLS = 1000;
const FACE_MILL_STRATEGIES = new Set(['zigzag-x', 'zigzag-y', 'oneway-x', 'oneway-y']);

export function generateToolpaths(camConfig) {
  const config = normalizeCamConfig(camConfig);
  const toolById = new Map(config.tools.map((tool) => [tool.id, tool]));
  const toolpaths = [];
  const warnings = [];

  for (const operation of config.operations) {
    if (!operation.enabled) continue;
    const tool = toolById.get(operation.toolId);
    if (!tool) {
      warnings.push({ operationId: operation.id, message: `Missing tool ${operation.toolId || '(none)'}` });
      continue;
    }
    const sourcePlaneError = unsupportedSourcePlaneError(operation);
    if (sourcePlaneError) {
      warnings.push({ operationId: operation.id, ...sourcePlaneError });
      continue;
    }
    const loops = getOperationLoops(operation);
    const segmentLoops = getOperationSegmentLoops(operation);
    if (loops.length === 0 && segmentLoops.length === 0) {
      warnings.push({ operationId: operation.id, message: 'Operation has no contours' });
      continue;
    }
    const toolpath = operation.type === 'pocket'
      ? generatePocketToolpath(operation, tool, loops, config.stock)
      : (operation.type === 'face'
        ? generateFaceToolpath(operation, tool, loops, config.stock)
        : generateProfileToolpath(operation, tool, loops, segmentLoops));
    if (Array.isArray(toolpath.warnings) && toolpath.warnings.length > 0) {
      for (const warning of toolpath.warnings) {
        warnings.push({ operationId: operation.id, message: String(warning?.message || warning) });
      }
    }
    toolpath.warnings = warnings.filter((warning) => warning.operationId === operation.id);
    if (toolpath.blocked) continue;
    toolpaths.push(toolpath);
  }

  return { config, toolpaths, warnings };
}

function unsupportedSourcePlaneError(operation) {
  const source = operation?.source;
  if (source?.type !== 'face') return null;
  const planes = collectSourcePlanes(source);
  if (planes.length === 0) return null;
  return planes.every((plane) => isWorldZAlignedPlane(plane))
    ? null
    : {
      severity: 'error',
      code: 'unsupported-face-source-plane',
      message: 'Current 2.5D CAM only supports planar face sources that are parallel to the XY machining plane.',
    };
}

function collectSourcePlanes(source) {
  const planes = [];
  const pushPlane = (plane) => {
    const normalized = normalizeCamPlane(plane);
    if (normalized) planes.push(normalized);
  };
  pushPlane(source?.plane);
  for (const surface of Array.isArray(source?.surfaces) ? source.surfaces : []) {
    pushPlane(surface?.plane);
  }
  return planes;
}

export function generateFaceToolpath(operation, tool, loops = getOperationLoops(operation), stock = null) {
  return generatePocketToolpath({
    ...operation,
    pocketOrder: 'per-level',
    pocketStrategy: normalizeFaceMillStrategy(operation?.pocketStrategy),
    sideEntryEnabled: false,
  }, tool, loops, stock);
}

export function generateProfileToolpath(operation, tool, loops = getOperationLoops(operation), segmentLoops = getOperationSegmentLoops(operation)) {
  const radius = tool.diameter / 2;
  const offsetDistance = operation.side === 'outside'
    ? radius
    : (operation.side === 'inside' ? -radius : 0);
  const passes = depthPasses(operation.topZ, operation.bottomZ, operation.stepDown);
  const moves = operationHeader(operation, tool);
  const useExactSegmentLoops = offsetDistance === 0 && Array.isArray(segmentLoops) && segmentLoops.length > 0;

  for (const depth of passes) {
    if (useExactSegmentLoops) {
      for (const segmentLoop of segmentLoops) appendClosedSegmentPathPass(moves, segmentLoop, depth, operation);
    } else {
      for (const loop of loops) {
        const path = offsetDistance === 0 ? loop : offsetPolygon(loop, offsetDistance);
        appendClosedPathPass(moves, path, depth, operation);
      }
    }
  }
  appendRetractZMove(moves, operation, operation.safeZ);
  moves.push({ type: 'spindle', on: false });
  return makeToolpath(operation, tool, moves);
}

export function generatePocketToolpath(operation, tool, loops = getOperationLoops(operation), stock = null) {
  const radius = tool.diameter / 2;
  const stepover = pocketStepover(operation, tool);
  const passes = depthPasses(operation.topZ, operation.bottomZ, operation.stepDown);
  const moves = operationHeader(operation, tool);
  const warnings = [];
  const loopInfos = classifyPocketLoops(loops);
  const surfaceStates = buildPocketSurfaceStates(operation, passes);
  const reEvaluateSurfacesByPass = surfaceStates.length > 0;
  const pocketOrder = operation.pocketOrder === 'per-pocket' && !reEvaluateSurfacesByPass ? 'per-pocket' : 'per-level';
  const pocketStrategy = describePocketStrategy(operation.pocketStrategy);

  if (loopInfos.length === 0) {
    warnings.push({ message: 'Operation has no machinable contours' });
  } else {
    const result = reEvaluateSurfacesByPass
      ? appendSurfacePocketPasses(moves, surfaceStates, radius, stepover, operation, stock, pocketStrategy)
      : (pocketStrategy.mode === 'contour'
        ? appendContourPocketPasses(moves, loopInfos, passes, radius, stepover, operation, pocketOrder, stock, getOperationSegmentLoops(operation).length > 0)
        : { appended: appendRasterPocketPasses(moves, loopInfos, passes, radius, stepover, operation, pocketOrder, pocketStrategy), error: null });
    if (result.error) warnings.push(result.error);
    else if (result.appended === 0) warnings.push({ message: 'Tool does not fit inside the selected pocket surfaces' });
  }

  appendRetractZMove(moves, operation, operation.safeZ);
  moves.push({ type: 'spindle', on: false });
  return makeToolpath(operation, tool, moves, warnings, {
    blocked: warnings.some((warning) => warning?.severity === 'error'),
  });
}

function appendSurfacePocketPasses(moves, surfaceStates, radius, stepover, operation, stock, pocketStrategy) {
  let appended = 0;
  let error = null;
  for (const state of surfaceStates) {
    for (const surface of state.surfaces) {
      const loopInfos = classifyPocketLoops(surface.loops);
      if (loopInfos.length === 0) continue;
      const result = pocketStrategy.mode === 'contour'
        ? appendContourPocketPasses(moves, loopInfos, [state.depth], radius, stepover, operation, 'per-level', stock, Array.isArray(surface.segmentLoops) && surface.segmentLoops.length > 0)
        : { appended: appendRasterPocketPasses(moves, loopInfos, [state.depth], radius, stepover, operation, 'per-level', pocketStrategy), error: null };
      appended += result.appended;
      if (!error && result.error) error = result.error;
    }
  }
  return { appended, error };
}

function buildPocketSurfaceStates(operation, passes) {
  const surfaces = getOperationSourceSurfaces(operation)
    .filter((surface) => Array.isArray(surface.loops) && surface.loops.length > 0);
  const uniqueDepths = new Set(surfaces.map((surface) => normalizePocketDepth(surface.z)).filter(Number.isFinite));
  if (surfaces.length <= 1 && uniqueDepths.size <= 1) return [];

  const descending = Number(operation.bottomZ) <= Number(operation.topZ);
  const states = [];
  let previousDepth = Number(operation.topZ);
  for (const depth of passes) {
    const activeSurfaces = surfaces.filter((surface) => surfaceNeedsCutAtDepth(surface, previousDepth, descending, operation.bottomZ));
    if (activeSurfaces.length > 0) states.push({ depth, surfaces: activeSurfaces });
    previousDepth = depth;
  }
  return states;
}

function normalizePocketDepth(value) {
  return Number.isFinite(Number(value)) ? Number(value) : NaN;
}

function surfaceNeedsCutAtDepth(surface, previousDepth, descending, fallbackDepth) {
  const floorZ = Number.isFinite(Number(surface?.z)) ? Number(surface.z) : Number(fallbackDepth);
  if (!Number.isFinite(floorZ) || !Number.isFinite(previousDepth)) return true;
  return descending ? floorZ < previousDepth - EPSILON : floorZ > previousDepth + EPSILON;
}

function appendContourPocketPasses(moves, loopInfos, passes, radius, stepover, operation, pocketOrder, stock, preferExactPlanner = false) {
  if (!shouldUseComplexPocketPlanner(loopInfos)) {
    if (pocketOrder === 'per-pocket') {
      let appended = 0;
      for (const loopInfo of loopInfos) {
        for (const depth of passes) appended += appendSimpleContourPocketLoopPasses(moves, loopInfo.loop, depth, radius, stepover, operation, stock);
      }
      return { appended, error: null };
    }

    let appended = 0;
    for (const depth of passes) {
      for (const loopInfo of loopInfos) appended += appendSimpleContourPocketLoopPasses(moves, loopInfo.loop, depth, radius, stepover, operation, stock);
    }
    return { appended, error: null };
  }

  const contourGroups = preferExactPlanner
    ? buildExactContourPocketGroups(loopInfos, radius, stepover)
    : buildComplexContourPocketGroups(loopInfos, radius, stepover);
  if (contourGroups.length === 0) {
    return hasInsetContourCandidate(loopInfos, radius)
      ? {
        appended: 0,
        error: {
          severity: 'error',
          code: 'contour-offset-generation-failed',
          message: 'Contour offset failed to generate inset contours for this pocket. Toolpath generation stopped for this operation.',
        },
      }
      : { appended: 0, error: null };
  }

  let appended = 0;
  if (pocketOrder === 'per-pocket') {
    for (const group of contourGroups) {
      for (const depth of passes) appended += appendContourPocketGroupPasses(moves, group, depth, operation, stock, radius);
    }
    return { appended, error: null };
  }

  for (const depth of passes) {
    for (const group of contourGroups) appended += appendContourPocketGroupPasses(moves, group, depth, operation, stock, radius);
  }
  return { appended, error: null };
}

function appendContourPocketGroupPasses(moves, group, depth, operation, stock, radius) {
  const nestedShellLoops = group.shells.every((shellLoops) => shellLoops.length === 1)
    ? group.shells.map((shellLoops) => shellLoops[0])
    : null;
  if (nestedShellLoops) {
    return appendContourShellChainPasses(moves, nestedShellLoops, depth, operation, { stock, radius });
  }

  let appended = 0;
  for (const shellLoops of group.shells) {
    for (const loop of shellLoops) {
      appendClosedPathPass(moves, loop, depth, operation);
      appended += 1;
    }
  }

  if (appended > 1) {
    for (const loop of group.shells[0] || []) {
      appendClosedPathPass(moves, loop, depth, operation);
      appended += 1;
    }
  }
  return appended;
}

function appendRasterPocketPasses(moves, loopInfos, passes, radius, stepover, operation, pocketOrder, strategy) {
  const regions = buildComplexPocketRegions(loopInfos, radius, stepover, strategy.axis);
  if (regions.length === 0) return 0;

  let appended = 0;
  if (pocketOrder === 'per-pocket') {
    for (const region of regions) {
      for (const depth of passes) appended += appendComplexPocketRegionPasses(moves, region, depth, operation, { alternateDirection: strategy.alternateDirection });
    }
    return appended;
  }

  for (const depth of passes) {
    for (const region of regions) appended += appendComplexPocketRegionPasses(moves, region, depth, operation, { alternateDirection: strategy.alternateDirection });
  }
  return appended;
}

function appendSimpleContourPocketLoopPasses(moves, loop, depth, radius, stepover, operation, stock) {
  return appendContourShellChainPasses(moves, buildSimpleContourShellLoops(loop, radius, stepover), depth, operation, { stock, radius });
}

function buildSimpleContourShellLoops(loop, radius, stepover) {
  const shellLoops = [];
  let offset = -radius;
  let previousArea = Infinity;
  for (let index = 0; index < 100; index++) {
    const path = offsetPolygon(loop, offset);
    if (path.length < 3) break;
    const area = Math.abs(polygonArea(path));
    if (!(area < previousArea - EPSILON)) break;
    shellLoops.push(path);
    previousArea = area;
    offset -= stepover;
  }
  return shellLoops;
}

function hasInsetContourCandidate(loopInfos, radius) {
  const inset = Math.abs(Number(radius) || 0);
  if (!(inset > EPSILON)) return false;
  return (Array.isArray(loopInfos) ? loopInfos : []).some((info) => !info?.isHole && offsetPolygon(info.loop, -inset).length >= 3);
}

function appendContourShellChainPasses(moves, shellLoops, depth, operation, options = {}) {
  const rawShells = (Array.isArray(shellLoops) ? shellLoops : [])
    .filter((loop) => Array.isArray(loop) && loop.length >= 3);
  if (rawShells.length === 0) return 0;

  const orderedShells = rawShells.slice().reverse();
  const contourPlan = buildContourShellPlan(orderedShells, operation, options);
  if (!contourPlan || contourPlan.shells.length === 0) return 0;

  appendRetractZMove(moves, operation, operation.clearanceZ);
  moves.push({ type: 'rapid', x: contourPlan.anchorPoint.x, y: contourPlan.anchorPoint.y });
  moves.push({ type: 'feed', z: depth, feed: operation.plungeRate });

  let currentPoint = contourPlan.anchorPoint;
  for (let index = 0; index < contourPlan.shells.length; index++) {
    const shell = contourPlan.shells[index];
    const leadPoint = contourPlan.leadPoints[index] || shell[0];
    if (pointDistanceSquared(currentPoint, leadPoint) > EPSILON * EPSILON) {
      moves.push({ type: 'feed', x: leadPoint.x, y: leadPoint.y, feed: operation.feedRate });
      currentPoint = leadPoint;
    }
    if (pointDistanceSquared(currentPoint, shell[0]) > EPSILON * EPSILON) {
      moves.push({ type: 'feed', x: shell[0].x, y: shell[0].y, feed: operation.feedRate });
    }
    appendClosedLoopFeedMoves(moves, shell, operation.feedRate);
    currentPoint = shell[0];
  }

  appendRetractZMove(moves, operation, operation.clearanceZ);
  return contourPlan.shells.length;
}

function appendClosedLoopFeedMoves(moves, path, feedRate) {
  for (let index = 1; index < path.length; index++) {
    moves.push({ type: 'feed', x: path[index].x, y: path[index].y, feed: feedRate });
  }
  moves.push({ type: 'feed', x: path[0].x, y: path[0].y, feed: feedRate });
}

function buildContourShellPlan(shellLoops, operation, options = {}) {
  const sideEntry = findContourSideEntry(shellLoops[shellLoops.length - 1], options.stock, options.radius, operation);
  if (sideEntry) {
    const shells = shellLoops.map((loop) => splitClosedPathAtClosestPoint(loop, contourSideAnchorTarget(loop, sideEntry)));
    const leadPoints = shells.map((shell) => extendContourPointOutsideStock(shell[0], sideEntry, options.stock));
    return {
      anchorPoint: leadPoints[0],
      leadPoints,
      shells,
    };
  }

  const centerPoint = polygonCentroid(shellLoops[0]);
  return {
    anchorPoint: centerPoint,
    leadPoints: shellLoops.map(() => centerPoint),
    shells: shellLoops.map((loop) => splitClosedPathAtClosestPoint(loop, centerPoint)),
  };
}

function splitClosedPathAtClosestPoint(path, target) {
  if (!Array.isArray(path) || path.length < 2) return Array.isArray(path) ? path.slice() : [];

  let best = null;
  for (let index = 0; index < path.length; index++) {
    const start = path[index];
    const end = path[(index + 1) % path.length];
    const closest = closestPointOnSegment(target, start, end);
    const distanceSq = pointDistanceSquared(target, closest.point);
    if (!best || distanceSq < best.distanceSq - EPSILON) {
      best = { index, distanceSq, point: closest.point, t: closest.t };
    }
  }

  if (!best) return path.slice();
  const startPoint = best.point;
  const nextIndex = (best.index + 1) % path.length;
  const result = [startPoint];
  for (let offset = 0; offset < path.length - 1; offset++) {
    const point = path[(nextIndex + offset) % path.length];
    if (pointDistanceSquared(result[result.length - 1], point) > EPSILON * EPSILON) result.push(point);
  }
  const lastPoint = path[best.index];
  if (pointDistanceSquared(result[result.length - 1], lastPoint) > EPSILON * EPSILON) result.push(lastPoint);
  return cleanLoop(result);
}

function closestPointOnSegment(target, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= EPSILON) return { point: { x: start.x, y: start.y }, t: 0 };
  const t = clamp((((target.x - start.x) * dx) + ((target.y - start.y) * dy)) / lengthSq, 0, 1);
  return {
    point: {
      x: start.x + dx * t,
      y: start.y + dy * t,
    },
    t,
  };
}

function polygonCentroid(loop) {
  const cleaned = cleanLoop(loop);
  if (cleaned.length === 0) return { x: 0, y: 0 };
  let area2 = 0;
  let centroidX = 0;
  let centroidY = 0;
  for (let index = 0; index < cleaned.length; index++) {
    const a = cleaned[index];
    const b = cleaned[(index + 1) % cleaned.length];
    const cross = (a.x * b.y) - (b.x * a.y);
    area2 += cross;
    centroidX += (a.x + b.x) * cross;
    centroidY += (a.y + b.y) * cross;
  }
  if (Math.abs(area2) <= EPSILON) {
    const bounds = loopBounds([cleaned]);
    return { x: (bounds.minX + bounds.maxX) * 0.5, y: (bounds.minY + bounds.maxY) * 0.5 };
  }
  return {
    x: centroidX / (3 * area2),
    y: centroidY / (3 * area2),
  };
}

function findContourSideEntry(outerLoop, stock, radius, operation) {
  if (!operation?.sideEntryEnabled || !Array.isArray(outerLoop) || outerLoop.length < 2 || !stock) return null;
  const stockMinX = Number(stock.min?.x);
  const stockMaxX = Number(stock.max?.x);
  const stockMinY = Number(stock.min?.y);
  const stockMaxY = Number(stock.max?.y);
  if (![stockMinX, stockMaxX, stockMinY, stockMaxY].every(Number.isFinite)) return null;

  const bounds = loopBounds([outerLoop]);
  const tolerance = Math.max(1e-6, Math.abs(radius || 0) * 0.05, 0.001);
  const extension = Math.max((radius || 0) * 2, Number(operation?.leadInLength) || 0);
  const candidates = [];

  if (bounds.minX <= stockMinX + (radius || 0) + tolerance) {
    candidates.push({ side: 'left', span: bounds.maxY - bounds.minY, coordinate: (bounds.minY + bounds.maxY) * 0.5, extension });
  }
  if (bounds.maxX >= stockMaxX - (radius || 0) - tolerance) {
    candidates.push({ side: 'right', span: bounds.maxY - bounds.minY, coordinate: (bounds.minY + bounds.maxY) * 0.5, extension });
  }
  if (bounds.minY <= stockMinY + (radius || 0) + tolerance) {
    candidates.push({ side: 'bottom', span: bounds.maxX - bounds.minX, coordinate: (bounds.minX + bounds.maxX) * 0.5, extension });
  }
  if (bounds.maxY >= stockMaxY - (radius || 0) - tolerance) {
    candidates.push({ side: 'top', span: bounds.maxX - bounds.minX, coordinate: (bounds.minX + bounds.maxX) * 0.5, extension });
  }

  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.span - left.span);
  return candidates[0];
}

function contourSideAnchorTarget(loop, sideEntry) {
  const bounds = loopBounds([loop]);
  if (sideEntry.side === 'left') return { x: bounds.minX, y: clamp(sideEntry.coordinate, bounds.minY, bounds.maxY) };
  if (sideEntry.side === 'right') return { x: bounds.maxX, y: clamp(sideEntry.coordinate, bounds.minY, bounds.maxY) };
  if (sideEntry.side === 'bottom') return { x: clamp(sideEntry.coordinate, bounds.minX, bounds.maxX), y: bounds.minY };
  return { x: clamp(sideEntry.coordinate, bounds.minX, bounds.maxX), y: bounds.maxY };
}

function extendContourPointOutsideStock(point, sideEntry, stock) {
  const extension = Math.max(Number(sideEntry?.extension) || 0, 0);
  if (sideEntry.side === 'left') return { x: Number(stock.min?.x) - extension, y: point.y };
  if (sideEntry.side === 'right') return { x: Number(stock.max?.x) + extension, y: point.y };
  if (sideEntry.side === 'bottom') return { x: point.x, y: Number(stock.min?.y) - extension };
  return { x: point.x, y: Number(stock.max?.y) + extension };
}

function appendComplexPocketRegionPasses(moves, region, depth, operation, options = {}) {
  const paths = buildContinuousPocketRegionPaths(region, options);
  let appended = 0;
  for (const path of paths) {
    appendOpenPathPass(moves, path, depth, operation);
    appended += 1;
  }
  return appended;
}

function classifyPocketLoops(loops) {
  const loopInfos = (Array.isArray(loops) ? loops : [])
    .map((loop) => cleanLoop(loop))
    .filter((loop) => loop.length >= 3)
    .map((loop, index) => ({
      index,
      loop,
      area: polygonArea(loop),
      absArea: Math.abs(polygonArea(loop)),
      nestingDepth: 0,
      isHole: false,
    }));

  if (loopInfos.length <= 1) return loopInfos;

  const loopMeta = loopInfos.map((info) => ({ ...info, samples: representativeLoopSamples(info.loop, info.area) }));
  for (const info of loopMeta) {
    let depth = 0;
    for (const other of loopMeta) {
      if (other.index === info.index) continue;
      if (info.samples.some((sample) => pointInPolygon(sample, other.loop))) depth += 1;
    }
    info.nestingDepth = depth;
    info.isHole = (depth % 2) === 1;
  }

  return loopMeta;
}

function representativeLoopSamples(loop, signedArea) {
  const points = Array.isArray(loop) ? loop : [];
  if (points.length < 2) return points.slice();
  const ccw = signedArea >= 0;
  const { minX, minY, maxX, maxY } = loopBounds([loop]);
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const epsilon = Math.max(diag * 1e-6, 1e-7);
  const samples = [];
  const step = Math.max(1, Math.floor(points.length / 12));

  for (let index = 0; index < points.length; index += step) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length <= EPSILON) continue;
    const nx = ccw ? -dy / length : dy / length;
    const ny = ccw ? dx / length : -dx / length;
    samples.push({
      x: (a.x + b.x) * 0.5 + nx * epsilon,
      y: (a.y + b.y) * 0.5 + ny * epsilon,
    });
  }

  return samples.length > 0 ? samples : points.slice(0, 1);
}

function shouldUseComplexPocketPlanner(loopInfos) {
  return loopInfos.some((info) => info.nestingDepth > 0 || !isConvexLoop(info.loop));
}

function isConvexLoop(loop) {
  if (!Array.isArray(loop) || loop.length < 4) return true;
  let sign = 0;
  for (let index = 0; index < loop.length; index++) {
    const a = loop[index];
    const b = loop[(index + 1) % loop.length];
    const c = loop[(index + 2) % loop.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) <= EPSILON) continue;
    const currentSign = Math.sign(cross);
    if (!sign) sign = currentSign;
    else if (currentSign !== sign) return false;
  }
  return true;
}

function buildComplexContourPocketGroups(loopInfos, radius, stepover) {
  const shells = [];
  for (let shellIndex = 0; shellIndex < MAX_POCKET_CONTOUR_SHELLS; shellIndex++) {
    const shellRadius = radius + stepover * shellIndex;
    const sampleStep = contourRegionScanStep(shellRadius, stepover);
    const shellLoopGroups = buildContourShellLoopGroups(collectPocketScanLevels(loopInfos, shellRadius, sampleStep, 'x'));
    if (shellLoopGroups.length === 0) break;
    shells.push(shellLoopGroups);
  }

  if (shells.length === 0) return [];

  const groups = shells[0].map((shellGroup) => createContourPocketGroup(shellGroup.outerLoop, shellGroup.loops, 0));
  for (let shellIndex = 1; shellIndex < shells.length; shellIndex++) {
    for (const group of groups) group.shells.push([]);
    for (const shellGroup of shells[shellIndex]) {
      const group = findContourPocketGroup(groups, shellGroup.outerLoop) || createContourPocketGroup(shellGroup.outerLoop, shellGroup.loops, shellIndex);
      if (!groups.includes(group)) groups.push(group);
      group.shells[shellIndex].push(...shellGroup.loops);
    }
  }

  return groups.sort((left, right) => (left.minX - right.minX) || (left.minY - right.minY));
}

function buildExactContourPocketGroups(loopInfos, radius, stepover) {
  const shells = [];
  for (let shellIndex = 0; shellIndex < MAX_POCKET_CONTOUR_SHELLS; shellIndex++) {
    const shellRadius = radius + stepover * shellIndex;
    const shellGroups = buildExactContourShellLoopGroups(loopInfos, shellRadius);
    if (shellGroups.length === 0) break;
    shells.push(shellGroups);
  }

  if (shells.length === 0) return [];

  const groups = shells[0].map((shellGroup) => createContourPocketGroup(shellGroup.outerLoop, shellGroup.loops, 0));
  for (let shellIndex = 1; shellIndex < shells.length; shellIndex++) {
    for (const group of groups) group.shells.push([]);
    for (const shellGroup of shells[shellIndex]) {
      const group = findContourPocketGroup(groups, shellGroup.outerLoop) || createContourPocketGroup(shellGroup.outerLoop, shellGroup.loops, shellIndex);
      if (!groups.includes(group)) groups.push(group);
      group.shells[shellIndex].push(...shellGroup.loops);
    }
  }

  return groups.sort((left, right) => (left.minX - right.minX) || (left.minY - right.minY));
}

function buildExactContourShellLoopGroups(loopInfos, shellRadius) {
  const shellLoops = loopInfos
    .map((info) => {
      const loop = offsetPolygon(info.loop, info.isHole ? shellRadius : -shellRadius);
      if (loop.length < 3) return null;
      const bounds = loopBounds([loop]);
      return {
        loop,
        bounds,
        absArea: Math.abs(polygonArea(loop)),
        isHole: info.isHole,
      };
    })
    .filter(Boolean);

  const outerLoops = shellLoops.filter((info) => !info.isHole);
  if (outerLoops.length === 0) return [];
  const holeLoops = shellLoops.filter((info) => info.isHole);

  const groups = outerLoops
    .sort((left, right) => (left.bounds.minX - right.bounds.minX) || (left.bounds.minY - right.bounds.minY))
    .map((info) => ({ outerLoop: info.loop, loops: [info.loop], area: info.absArea }));

  for (const hole of holeLoops) {
    const sample = polygonCentroid(hole.loop);
    let bestGroup = null;
    let bestArea = Infinity;
    for (const group of groups) {
      if (!pointInPolygon(sample, group.outerLoop)) continue;
      if (group.area < bestArea) {
        bestArea = group.area;
        bestGroup = group;
      }
    }
    if (bestGroup) bestGroup.loops.push(hole.loop);
  }

  return groups.map((group) => ({ outerLoop: group.outerLoop, loops: group.loops }));
}

function createContourPocketGroup(loop, loops, shellIndex) {
  const bounds = loopBounds([loop]);
  return {
    outerLoop: loop,
    minX: bounds.minX,
    minY: bounds.minY,
    shells: Array.from({ length: shellIndex + 1 }, (_, index) => (index === shellIndex ? loops.slice() : [])),
  };
}

function findContourPocketGroup(groups, loop) {
  const sample = loop[0];
  let bestGroup = null;
  let bestArea = Infinity;
  for (const group of groups) {
    if (!pointInPolygon(sample, group.outerLoop)) continue;
    const area = Math.abs(polygonArea(group.outerLoop));
    if (area < bestArea) {
      bestArea = area;
      bestGroup = group;
    }
  }
  return bestGroup;
}

function contourRegionScanStep(radius, stepover) {
  return Math.max(EPSILON, Math.min(stepover, Math.max(stepover * 0.25, radius * 0.35)));
}

function buildContourShellLoopGroups(levels) {
  const loops = buildAxisAlignedUnionLoops(buildContourShellRectangles(levels));
  if (loops.length === 0) return [];

  const loopInfos = loops.map((loop) => ({
    loop,
    area: polygonArea(loop),
    absArea: Math.abs(polygonArea(loop)),
    bounds: loopBounds([loop]),
  }));
  const outerLoops = loopInfos.filter((info) => info.area > 0);
  const holeLoops = loopInfos.filter((info) => info.area < 0);

  const groups = outerLoops
    .sort((left, right) => (left.bounds.minX - right.bounds.minX) || (left.bounds.minY - right.bounds.minY))
    .map((info) => ({ outerLoop: info.loop, loops: [info.loop], bounds: info.bounds, area: info.absArea }));

  for (const hole of holeLoops) {
    const sample = hole.loop[0];
    let bestGroup = null;
    let bestArea = Infinity;
    for (const group of groups) {
      if (!pointInPolygon(sample, group.outerLoop)) continue;
      if (group.area < bestArea) {
        bestArea = group.area;
        bestGroup = group;
      }
    }
    if (bestGroup) bestGroup.loops.push(hole.loop);
  }

  return groups.map((group) => ({ outerLoop: group.outerLoop, loops: group.loops }));
}

function buildContourShellRectangles(levels) {
  const rectangles = [];
  for (let index = 0; index + 1 < levels.length; index++) {
    const lower = levels[index];
    const upper = levels[index + 1];
    const bottom = lower.position;
    const top = upper.position;
    if (top - bottom <= EPSILON) continue;
    for (const lowerInterval of lower.intervals) {
      for (const upperInterval of upper.intervals) {
        const overlap = lineSharedInterval(lowerInterval, upperInterval);
        if (!overlap) continue;
        rectangles.push({ left: overlap.start, right: overlap.end, bottom, top });
      }
    }
  }
  return rectangles;
}

function buildAxisAlignedUnionLoops(rectangles) {
  const edges = new Map();
  for (const rectangle of rectangles) {
    const left = normalizePocketCoord(rectangle.left);
    const right = normalizePocketCoord(rectangle.right);
    const bottom = normalizePocketCoord(rectangle.bottom);
    const top = normalizePocketCoord(rectangle.top);
    if (right - left <= EPSILON || top - bottom <= EPSILON) continue;

    const bottomLeft = { x: left, y: bottom };
    const bottomRight = { x: right, y: bottom };
    const topRight = { x: right, y: top };
    const topLeft = { x: left, y: top };
    togglePocketBoundaryEdge(edges, bottomLeft, bottomRight);
    togglePocketBoundaryEdge(edges, bottomRight, topRight);
    togglePocketBoundaryEdge(edges, topRight, topLeft);
    togglePocketBoundaryEdge(edges, topLeft, bottomLeft);
  }

  if (edges.size === 0) return [];

  const outgoing = new Map();
  for (const edge of edges.values()) {
    if (!outgoing.has(edge.startKey)) outgoing.set(edge.startKey, []);
    outgoing.get(edge.startKey).push(edge);
  }

  const loops = [];
  while (edges.size > 0) {
    const startEdge = edges.values().next().value;
    const loop = [];
    let current = startEdge;
    const startKey = startEdge.startKey;

    for (let guard = 0; guard < 100000 && current; guard++) {
      edges.delete(current.key);
      loop.push(current.start);
      const nextEdges = outgoing.get(current.endKey) || [];
      const next = nextEdges.find((edge) => edges.has(edge.key)) || null;
      if (!next) {
        if (current.endKey === startKey) {
          const simplified = simplifyAxisAlignedLoop(loop);
          if (simplified.length >= 3) loops.push(simplified);
        }
        break;
      }
      current = next;
    }
  }

  return loops;
}

function togglePocketBoundaryEdge(edges, start, end) {
  const startKey = pocketBoundaryPointKey(start);
  const endKey = pocketBoundaryPointKey(end);
  const reverseKey = `${endKey}>${startKey}`;
  if (edges.has(reverseKey)) {
    edges.delete(reverseKey);
    return;
  }
  const key = `${startKey}>${endKey}`;
  edges.set(key, { key, start, end, startKey, endKey });
}

function pocketBoundaryPointKey(point) {
  return `${normalizePocketCoord(point.x)},${normalizePocketCoord(point.y)}`;
}

function normalizePocketCoord(value) {
  return Math.round(Number(value) * 1e7) / 1e7;
}

function simplifyAxisAlignedLoop(loop) {
  const cleaned = cleanLoop(loop);
  if (cleaned.length < 3) return [];

  const simplified = [];
  for (let index = 0; index < cleaned.length; index++) {
    const previous = cleaned[(index - 1 + cleaned.length) % cleaned.length];
    const current = cleaned[index];
    const next = cleaned[(index + 1) % cleaned.length];
    const vertical = Math.abs(previous.x - current.x) <= EPSILON && Math.abs(current.x - next.x) <= EPSILON;
    const horizontal = Math.abs(previous.y - current.y) <= EPSILON && Math.abs(current.y - next.y) <= EPSILON;
    if (vertical || horizontal) continue;
    simplified.push(current);
  }

  return cleanLoop(simplified);
}

function collectPocketScanLevels(loopInfos, radius, scanStep, axis = 'x') {
  const scanAxis = axis === 'y' ? 'y' : 'x';
  const transformedLoopInfos = scanAxis === 'y'
    ? loopInfos.map((info) => ({ ...info, loop: swapLoopAxes(info.loop), samples: swapLoopAxes(info.samples || []) }))
    : loopInfos;
  const bounds = loopBounds(transformedLoopInfos.map((info) => info.loop));
  const levels = [];
  for (const y of pocketScanLevels(bounds, radius, scanStep)) {
    const intervals = scanPocketIntervalsAtY(transformedLoopInfos, y, radius);
    if (intervals.length > 0) levels.push({ axis: scanAxis, position: y, intervals });
  }
  return levels;
}

function buildComplexPocketRegions(loopInfos, radius, scanStep, axis = 'x') {
  const levels = collectPocketScanLevels(loopInfos, radius, scanStep, axis);
  if (levels.length === 0) return [];

  const regions = [];
  let previous = [];
  for (const level of levels) {
    const current = [];
    for (const interval of level.intervals) {
      const matches = previous.filter((entry) => intervalsConnect(entry.interval, interval, scanStep));
      let region = null;
      if (matches.length > 0) {
        matches.sort((left, right) => intervalOverlapWidth(right.interval, interval) - intervalOverlapWidth(left.interval, interval));
        region = matches[0].region;
      }
      if (!region) {
        region = { lines: [], minX: interval.start, minY: level.position };
        regions.push(region);
      }
      region.lines.push({ axis: level.axis, position: level.position, start: interval.start, end: interval.end });
      region.minX = Math.min(region.minX, interval.start);
      region.minY = Math.min(region.minY, level.position);
      current.push({ interval, region });
    }
    previous = current;
  }

  for (const region of regions) {
    region.lines.sort((left, right) => (left.position - right.position) || (left.start - right.start));
  }

  return regions.sort((left, right) => (left.minX - right.minX) || (left.minY - right.minY));
}

function pocketScanLevels(bounds, radius, stepover) {
  const minY = bounds.minY + radius;
  const maxY = bounds.maxY - radius;
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || minY > maxY + EPSILON) return [];

  const step = Math.max(EPSILON, stepover);
  const levels = [minY];
  let current = minY;
  for (let guard = 0; guard < MAX_POCKET_SCAN_LEVELS; guard++) {
    const next = current + step;
    if (next >= maxY - EPSILON) break;
    levels.push(next);
    current = next;
  }
  if (Math.abs(levels[levels.length - 1] - maxY) > EPSILON) levels.push(maxY);
  return levels;
}

function scanPocketIntervalsAtY(loopInfos, y, radius) {
  const filled = buildFilledIntervalsAtY(loopInfos, y);
  if (filled.length === 0) return [];
  const forbidden = mergeIntervals(loopInfos.flatMap((info) => loopClearanceIntervalsAtY(info.loop, y, radius)));
  return subtractIntervals(filled, forbidden).filter((interval) => interval.end - interval.start > EPSILON);
}

function buildFilledIntervalsAtY(loopInfos, y) {
  const crossings = [];
  for (const info of loopInfos) {
    const loop = info.loop;
    for (let index = 0; index < loop.length; index++) {
      const a = loop[index];
      const b = loop[(index + 1) % loop.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        const t = (y - a.y) / (b.y - a.y);
        crossings.push(a.x + (b.x - a.x) * t);
      }
    }
  }
  crossings.sort((left, right) => left - right);

  const intervals = [];
  for (let index = 0; index + 1 < crossings.length; index += 2) {
    const start = crossings[index];
    const end = crossings[index + 1];
    if (end - start > EPSILON) intervals.push({ start, end });
  }
  return intervals;
}

function loopClearanceIntervalsAtY(loop, y, radius) {
  const intervals = [];
  for (let index = 0; index < loop.length; index++) {
    const a = loop[index];
    const b = loop[(index + 1) % loop.length];
    intervals.push(...segmentClearanceIntervalsAtY(a, b, y, radius));
  }
  return intervals;
}

function segmentClearanceIntervalsAtY(a, b, y, radius) {
  const clearanceRadius = Math.max(0, radius - 1e-7);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= EPSILON) return circleIntervalsAtY(a, y, clearanceRadius);

  const intervals = [];
  intervals.push(...circleIntervalsAtY(a, y, clearanceRadius));
  intervals.push(...circleIntervalsAtY(b, y, clearanceRadius));

  if (Math.abs(dx) <= EPSILON) {
    if (y >= Math.min(a.y, b.y) - EPSILON && y <= Math.max(a.y, b.y) + EPSILON) {
      intervals.push({ start: a.x - clearanceRadius, end: a.x + clearanceRadius });
    }
    return intervals;
  }

  if (Math.abs(dy) <= EPSILON) {
    const deltaY = Math.abs(y - a.y);
    if (deltaY < clearanceRadius) intervals.push({ start: Math.min(a.x, b.x), end: Math.max(a.x, b.x) });
    return intervals;
  }

  const length = Math.sqrt(lengthSq);
  const crossConstant = -dy * a.x - dx * (y - a.y);
  const lineStart = (-crossConstant - clearanceRadius * length) / dy;
  const lineEnd = (-crossConstant + clearanceRadius * length) / dy;
  const xAtT0 = a.x - ((y - a.y) * dy) / dx;
  const xAtT1 = a.x + (lengthSq - (y - a.y) * dy) / dx;
  const start = Math.max(Math.min(lineStart, lineEnd), Math.min(xAtT0, xAtT1));
  const end = Math.min(Math.max(lineStart, lineEnd), Math.max(xAtT0, xAtT1));
  if (end - start > EPSILON) intervals.push({ start, end });
  return intervals;
}

function circleIntervalsAtY(point, y, radius) {
  const dy = Math.abs(y - point.y);
  if (dy >= radius) return [];
  const dx = Math.sqrt(Math.max(0, radius * radius - dy * dy));
  return [{ start: point.x - dx, end: point.x + dx }];
}

function mergeIntervals(intervals) {
  const normalized = (Array.isArray(intervals) ? intervals : [])
    .map((interval) => ({ start: Math.min(interval.start, interval.end), end: Math.max(interval.start, interval.end) }))
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end - interval.start > EPSILON)
    .sort((left, right) => left.start - right.start);
  if (normalized.length === 0) return [];

  const merged = [normalized[0]];
  for (let index = 1; index < normalized.length; index++) {
    const current = normalized[index];
    const last = merged[merged.length - 1];
    if (current.start <= last.end + EPSILON) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function subtractIntervals(source, forbidden) {
  if (!Array.isArray(source) || source.length === 0) return [];
  if (!Array.isArray(forbidden) || forbidden.length === 0) return source.slice();

  const result = [];
  for (const interval of source) {
    let cursor = interval.start;
    for (const block of forbidden) {
      if (block.end <= cursor + EPSILON) continue;
      if (block.start >= interval.end - EPSILON) break;
      if (block.start > cursor + EPSILON) {
        result.push({ start: cursor, end: Math.min(block.start, interval.end) });
      }
      cursor = Math.max(cursor, block.end);
      if (cursor >= interval.end - EPSILON) break;
    }
    if (cursor < interval.end - EPSILON) result.push({ start: cursor, end: interval.end });
  }
  return result.filter((interval) => interval.end - interval.start > EPSILON);
}

function intervalsConnect(a, b, stepover) {
  return intervalOverlapWidth(a, b) >= -Math.max(EPSILON, stepover * 0.5);
}

function intervalOverlapWidth(a, b) {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

function loopBounds(loops) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const loop of loops) {
    for (const point of loop || []) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  return { minX, minY, maxX, maxY };
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && (point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x);
    if (intersects) inside = !inside;
  }
  return inside;
}

export function depthPasses(topZ, bottomZ, stepDown) {
  const top = Number(topZ);
  const bottom = Number(bottomZ);
  const step = Math.max(EPSILON, Math.abs(Number(stepDown) || 0));
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return [];
  if (Math.abs(top - bottom) <= EPSILON) return [bottom];

  const direction = bottom < top ? -1 : 1;
  const passes = [];
  let current = top;
  for (let guard = 0; guard < 10000; guard++) {
    const next = current + direction * step;
    current = direction < 0 ? Math.max(next, bottom) : Math.min(next, bottom);
    passes.push(current);
    if (Math.abs(current - bottom) <= EPSILON) break;
  }
  return passes;
}

function operationHeader(operation, tool) {
  const moves = [
    { type: 'comment', text: `${operation.name} (${operation.type})` },
    { type: 'toolchange', toolNumber: tool.number, toolId: tool.id, toolName: tool.name },
    { type: 'spindle', on: true, rpm: operation.spindleRpm || tool.spindleRpm, clockwise: true },
    { type: 'coolant', on: !!tool.coolant },
  ];
  appendRetractZMove(moves, operation, operation.safeZ);
  return moves;
}

function appendRetractZMove(moves, operation, z) {
  const targetZ = Number(z);
  if (!Number.isFinite(targetZ)) return;
  if (operation?.rapidZRetract === false) {
    moves.push({ type: 'feed', z: targetZ, feed: operation.plungeRate });
    return;
  }
  moves.push({ type: 'rapid', z: targetZ });
}

function appendClosedPathPass(moves, path, depth, operation) {
  if (!Array.isArray(path) || path.length < 2) return;
  const orderedPath = rotateClosedPath(path, operation.leadInPosition);
  const first = orderedPath[0];
  const leadInPath = buildLeadInPath(orderedPath, operation);
  const rapidTarget = leadInPath[0] || first;
  appendRetractZMove(moves, operation, operation.clearanceZ);
  moves.push({ type: 'rapid', x: rapidTarget.x, y: rapidTarget.y });
  moves.push({ type: 'feed', z: depth, feed: operation.plungeRate });
  for (let index = 1; index < leadInPath.length; index++) {
    moves.push({ type: 'feed', x: leadInPath[index].x, y: leadInPath[index].y, feed: operation.feedRate });
  }
  for (let index = 1; index < orderedPath.length; index++) {
    moves.push({ type: 'feed', x: orderedPath[index].x, y: orderedPath[index].y, feed: operation.feedRate });
  }
  moves.push({ type: 'feed', x: first.x, y: first.y, feed: operation.feedRate });
  appendRetractZMove(moves, operation, operation.clearanceZ);
}

function appendClosedSegmentPathPass(moves, segmentLoop, depth, operation) {
  if (!Array.isArray(segmentLoop) || segmentLoop.length === 0) return;
  const orderedSegments = rotateClosedSegments(segmentLoop, operation.leadInPosition);
  const first = segmentPointAtStart(orderedSegments[0]);
  const tangent = segmentLeadDirectionPoint(orderedSegments[0]);
  if (!first || !tangent) return;
  const leadInPath = buildLeadInPath([first, tangent], operation);
  const rapidTarget = leadInPath[0] || first;
  appendRetractZMove(moves, operation, operation.clearanceZ);
  moves.push({ type: 'rapid', x: rapidTarget.x, y: rapidTarget.y });
  moves.push({ type: 'feed', z: depth, feed: operation.plungeRate });
  for (let index = 1; index < leadInPath.length; index++) {
    moves.push({ type: 'feed', x: leadInPath[index].x, y: leadInPath[index].y, feed: operation.feedRate });
  }
  for (const segment of orderedSegments) appendSegmentMove(moves, segment, operation.feedRate);
  const last = segmentPointAtEnd(orderedSegments[orderedSegments.length - 1]);
  if (last && pointDistanceSquared(last, first) > EPSILON * EPSILON) {
    moves.push({ type: 'feed', x: first.x, y: first.y, feed: operation.feedRate });
  }
  appendRetractZMove(moves, operation, operation.clearanceZ);
}

function appendOpenPathPass(moves, path, depth, operation) {
  if (!Array.isArray(path) || path.length < 2) return;
  const first = path[0];
  const leadInPath = buildLeadInPath(path, operation);
  const rapidTarget = leadInPath[0] || first;
  appendRetractZMove(moves, operation, operation.clearanceZ);
  moves.push({ type: 'rapid', x: rapidTarget.x, y: rapidTarget.y });
  moves.push({ type: 'feed', z: depth, feed: operation.plungeRate });
  for (let index = 1; index < leadInPath.length; index++) {
    moves.push({ type: 'feed', x: leadInPath[index].x, y: leadInPath[index].y, feed: operation.feedRate });
  }
  for (let index = 1; index < path.length; index++) {
    moves.push({ type: 'feed', x: path[index].x, y: path[index].y, feed: operation.feedRate });
  }
  appendRetractZMove(moves, operation, operation.clearanceZ);
}

function buildContinuousPocketRegionPaths(region, options = {}) {
  const lines = Array.isArray(region?.lines) ? region.lines : [];
  if (lines.length === 0) return [];

  const alternateDirection = options.alternateDirection !== false;
  const axis = lines[0]?.axis === 'y' ? 'y' : 'x';
  if (!alternateDirection) return buildOneWayPocketRegionPaths(lines, axis);

  const paths = [];
  let currentChunk = [lines[0]];

  for (let index = 1; index < lines.length; index++) {
    const previous = lines[index - 1];
    const current = lines[index];
    if (lineOverlap(previous, current) > EPSILON) {
      currentChunk.push(current);
      continue;
    }
    const chunkPath = buildPocketLineChunkPath(currentChunk, axis, { alternateDirection });
    if (chunkPath.length >= 2) paths.push(chunkPath);
    currentChunk = [current];
  }

  const lastChunkPath = buildPocketLineChunkPath(currentChunk, axis, { alternateDirection });
  if (lastChunkPath.length >= 2) paths.push(lastChunkPath);
  return paths;
}

function buildOneWayPocketRegionPaths(lines, axis) {
  const paths = [];
  for (const line of lines) {
    const path = [];
    appendPocketPathPoint(path, axis, Math.min(line.start, line.end), line.position);
    appendPocketPathPoint(path, axis, Math.max(line.start, line.end), line.position);
    if (path.length >= 2) paths.push(path);
  }
  return paths;
}

function buildPocketLineChunkPath(lines, axis, options = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const alternateDirection = options.alternateDirection !== false;
  const connectorSides = [];
  const connectorCoords = [];
  for (let index = 0; index + 1 < lines.length; index++) {
    const overlap = lineSharedInterval(lines[index], lines[index + 1]);
    if (!overlap) break;
    const side = alternateDirection ? (index % 2 === 0 ? 'end' : 'start') : 'start';
    connectorSides.push(side);
    connectorCoords.push(side === 'start' ? overlap.start : overlap.end);
  }

  const path = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const hasPrev = index > 0;
    const hasNext = index < lines.length - 1;
    const prevSide = hasPrev ? connectorSides[index - 1] : null;
    const prevCoord = hasPrev ? connectorCoords[index - 1] : null;
    const nextSide = hasNext ? connectorSides[index] : null;
    const nextCoord = hasNext ? connectorCoords[index] : null;

    const entrySide = hasPrev
      ? prevSide
      : (alternateDirection
        ? (hasNext ? oppositePocketLineSide(nextSide) : 'start')
        : 'start');
    const exitSide = hasNext
      ? nextSide
      : (alternateDirection ? oppositePocketLineSide(entrySide) : 'end');
    const entryCoord = hasPrev ? prevCoord : (entrySide === 'start' ? line.start : line.end);
    const exitCoord = hasNext ? nextCoord : (exitSide === 'start' ? line.start : line.end);

    appendPocketLineCoverage(path, line, axis, entrySide, entryCoord, exitSide, exitCoord);
    if (hasNext) appendPocketPathPoint(path, axis, nextCoord, lines[index + 1].position);
  }
  return path;
}

function appendPocketLineCoverage(path, line, axis, entrySide, entryCoord, exitSide, exitCoord) {
  const start = Math.min(line.start, line.end);
  const end = Math.max(line.start, line.end);
  const clampedEntry = clamp(entryCoord, start, end);
  const clampedExit = clamp(exitCoord, start, end);
  appendPocketPathPoint(path, axis, clampedEntry, line.position);

  if (entrySide === 'start') {
    if (clampedEntry > start + EPSILON) appendPocketPathPoint(path, axis, start, line.position);
    appendPocketPathPoint(path, axis, end, line.position);
    if (exitSide === 'start') {
      appendPocketPathPoint(path, axis, start, line.position);
      if (clampedExit > start + EPSILON) appendPocketPathPoint(path, axis, clampedExit, line.position);
    } else if (clampedExit < end - EPSILON) {
      appendPocketPathPoint(path, axis, clampedExit, line.position);
    }
    return;
  }

  if (clampedEntry < end - EPSILON) appendPocketPathPoint(path, axis, end, line.position);
  appendPocketPathPoint(path, axis, start, line.position);
  if (exitSide === 'end') {
    appendPocketPathPoint(path, axis, end, line.position);
    if (clampedExit < end - EPSILON) appendPocketPathPoint(path, axis, clampedExit, line.position);
  } else if (clampedExit > start + EPSILON) {
    appendPocketPathPoint(path, axis, clampedExit, line.position);
  }
}

function appendPocketPathPoint(path, axis, primary, secondary) {
  const point = axis === 'y'
    ? { x: secondary, y: primary }
    : { x: primary, y: secondary };
  const previous = path[path.length - 1];
  if (previous && Math.abs(previous.x - point.x) <= EPSILON && Math.abs(previous.y - point.y) <= EPSILON) return;
  path.push(point);
}

function lineOverlap(a, b) {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

function lineSharedInterval(a, b) {
  const start = Math.max(Math.min(a.start, a.end), Math.min(b.start, b.end));
  const end = Math.min(Math.max(a.start, a.end), Math.max(b.start, b.end));
  return end - start > EPSILON ? { start, end } : null;
}

function oppositePocketLineSide(side) {
  return side === 'end' ? 'start' : 'end';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pocketStepover(operation, tool) {
  const percent = Number(operation.stepoverPercent);
  if (Number.isFinite(percent)) {
    const clampedPercent = Math.max(1, Math.min(100, percent));
    return Math.max(EPSILON, tool.diameter * (clampedPercent / 100));
  }
  return Math.max(EPSILON, operation.stepover || tool.diameter * 0.4);
}

function normalizePocketStrategy(strategy) {
  const value = typeof strategy === 'string' ? strategy.trim().toLowerCase() : '';
  if (value === 'zigzag-y' || value === 'oneway-x' || value === 'oneway-y') return value;
  if (value === 'zigzag-x') return value;
  return 'contour';
}

function describePocketStrategy(strategy) {
  const value = normalizePocketStrategy(strategy);
  if (value === 'contour') return { mode: 'contour', axis: 'x', alternateDirection: true };
  return {
    mode: 'raster',
    axis: value.endsWith('-y') ? 'y' : 'x',
    alternateDirection: !value.startsWith('oneway'),
  };
}

function rotateClosedPath(path, position = 0) {
  if (!Array.isArray(path) || path.length < 2) return path || [];
  const clamped = Math.max(0, Math.min(1, Number(position) || 0));
  const startIndex = Math.min(path.length - 1, Math.round(clamped * (path.length - 1)));
  if (startIndex <= 0) return path;
  return path.slice(startIndex).concat(path.slice(0, startIndex));
}

function rotateClosedSegments(segments, position = 0) {
  if (!Array.isArray(segments) || segments.length < 2) return segments || [];
  const clamped = Math.max(0, Math.min(1, Number(position) || 0));
  const startIndex = Math.min(segments.length - 1, Math.round(clamped * (segments.length - 1)));
  if (startIndex <= 0) return segments;
  return segments.slice(startIndex).concat(segments.slice(0, startIndex));
}

function buildLeadInPath(path, operation) {
  if (!operation?.leadInEnabled || !Array.isArray(path) || path.length < 2) return [];
  const length = Math.max(0, Number(operation.leadInLength) || 0);
  if (length <= EPSILON) return [];
  const first = path[0];
  const second = path[1];
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const segmentLength = Math.hypot(dx, dy);
  if (segmentLength <= EPSILON) return [];
  const ux = dx / segmentLength;
  const uy = dy / segmentLength;
  const px = -uy;
  const py = ux;
  const amplitude = Math.max(0, Number(operation.leadInZigZagAmplitude) || 0);
  const count = Math.max(1, Math.round(Number(operation.leadInZigZagCount) || 3));
  const points = [];
  for (let index = 0; index <= count; index++) {
    const t = index / count;
    const along = -length * (1 - t);
    const side = index === count ? 0 : (index % 2 === 0 ? -amplitude : amplitude);
    points.push({
      x: first.x + ux * along + px * side,
      y: first.y + uy * along + py * side,
    });
  }
  return points;
}

function swapLoopAxes(points) {
  return (Array.isArray(points) ? points : []).map((point) => ({ x: point.y, y: point.x }));
}

function segmentPointAtStart(segment) {
  if (!segment || typeof segment !== 'object') return null;
  if (segment.type === 'polyline') return normalizeSegmentPoint(segment.points?.[0]);
  return normalizeSegmentPoint(segment.start);
}

function segmentPointAtEnd(segment) {
  if (!segment || typeof segment !== 'object') return null;
  if (segment.type === 'polyline') return normalizeSegmentPoint(segment.points?.[segment.points.length - 1]);
  return normalizeSegmentPoint(segment.end);
}

function segmentLeadDirectionPoint(segment) {
  if (!segment || typeof segment !== 'object') return null;
  if (segment.type === 'polyline') return normalizeSegmentPoint(segment.points?.[1] || segment.points?.[0]);
  if (segment.type === 'cubic') return normalizeSegmentPoint(segment.control1);
  return segmentPointAtEnd(segment);
}

function normalizeSegmentPoint(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function appendSegmentMove(moves, segment, feedRate) {
  if (!segment || typeof segment !== 'object') return;
  if (segment.type === 'line') {
    moves.push({ type: 'feed', x: segment.end.x, y: segment.end.y, feed: feedRate });
    return;
  }
  if (segment.type === 'arc') {
    moves.push({
      type: 'arc',
      x: segment.end.x,
      y: segment.end.y,
      centerX: segment.center.x,
      centerY: segment.center.y,
      clockwise: segment.clockwise === true,
      feed: feedRate,
    });
    return;
  }
  if (segment.type === 'cubic') {
    moves.push({
      type: 'cubic',
      x: segment.end.x,
      y: segment.end.y,
      control1X: segment.control1.x,
      control1Y: segment.control1.y,
      control2X: segment.control2.x,
      control2Y: segment.control2.y,
      feed: feedRate,
    });
    return;
  }
  if (segment.type === 'polyline' && Array.isArray(segment.points)) {
    for (let index = 1; index < segment.points.length; index++) {
      moves.push({ type: 'feed', x: segment.points[index].x, y: segment.points[index].y, feed: feedRate });
    }
  }
}

function pointDistanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function makeToolpath(operation, tool, moves, warnings = []) {
  return {
    id: `toolpath-${operation.id}`,
    operationId: operation.id,
    operationType: operation.type,
    name: operation.name,
    toolId: tool.id,
    toolNumber: tool.number,
    moves,
    warnings,
  };
}

function normalizeFaceMillStrategy(strategy) {
  return FACE_MILL_STRATEGIES.has(strategy) ? strategy : 'zigzag-x';
}

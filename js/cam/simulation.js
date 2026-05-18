import { normalizeCamConfig } from './model.js';
import { generateToolpaths } from './toolpath.js';

const EPSILON = 1e-9;
export const CAM_SIMULATION_MIN_RESOLUTION = 8;
export const CAM_SIMULATION_DEFAULT_RESOLUTION = 384;
export const CAM_SIMULATION_MAX_RESOLUTION = 1024;

export function buildToolpathMotionTimeline(camConfig, toolpathsOrOptions = null) {
  const config = normalizeCamConfig(camConfig);
  const explicitToolpaths = Array.isArray(toolpathsOrOptions) ? toolpathsOrOptions : null;
  const toolpaths = explicitToolpaths || generateToolpaths(config).toolpaths;
  const toolById = new Map(config.tools.map((tool) => [tool.id, tool]));
  const motionSegments = collectMotionSegments(toolpaths, toolById, config.units);
  const feedSegments = motionSegments.filter((segment) => segment.cutting);
  const totalCutSeconds = feedSegments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  const totalMotionSeconds = motionSegments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  return {
    toolpaths,
    motionSegments,
    motionSegmentCount: motionSegments.length,
    feedSegments,
    feedSegmentCount: feedSegments.length,
    totalCutSeconds,
    totalMotionSeconds,
  };
}

export function simulateStockRemoval(camConfig, toolpathsOrOptions = null, maybeOptions = {}) {
  const config = normalizeCamConfig(camConfig);
  const explicitToolpaths = Array.isArray(toolpathsOrOptions) ? toolpathsOrOptions : null;
  const options = explicitToolpaths ? maybeOptions : (toolpathsOrOptions || {});
  const toolpaths = explicitToolpaths || generateToolpaths(config).toolpaths;
  const stock = config.stock;
  const width = stock.max.x - stock.min.x;
  const depth = stock.max.y - stock.min.y;
  if (!stock.enabled || width <= EPSILON || depth <= EPSILON) {
    return null;
  }

  const resolution = Math.max(
    CAM_SIMULATION_MIN_RESOLUTION,
    Math.min(CAM_SIMULATION_MAX_RESOLUTION, Math.round(options.resolution || CAM_SIMULATION_DEFAULT_RESOLUTION)),
  );
  const columns = Math.max(1, Math.round(resolution));
  const rows = Math.max(1, Math.round(resolution * Math.max(0.25, Math.min(4, depth / width))));
  const heights = new Float32Array((columns + 1) * (rows + 1));
  heights.fill(stock.max.z);
  const initialVolume = estimateStockVolume(stock);
  const operationStates = buildOperationStates(toolpaths, stock, initialVolume);
  const operationStateById = new Map(operationStates.map((state) => [state.operationId, state]));

  const motionTimeline = buildToolpathMotionTimeline(config, toolpaths);
  const motionSegments = motionTimeline.motionSegments;
  const feedSegments = motionTimeline.feedSegments;
  for (const segment of feedSegments) {
    const state = operationStateById.get(segment.operationId);
    if (state) state.feedSegmentCount += 1;
  }

  const finalizedOperationIds = new Set();
  const finalizeOperationState = (state) => {
    if (!state || finalizedOperationIds.has(state.operationId)) return;
    const summary = summarizeHeightField(heights, stock, initialVolume);
    state.progress = state.feedSegmentCount > 0
      ? Math.max(0, Math.min(1, state.processedSegmentCount / state.feedSegmentCount))
      : 0;
    state.removedVertexCount = summary.removedVertexCount;
    state.minHeight = summary.minHeight;
    state.remainingVolume = summary.remainingVolume;
    state.removedVolume = summary.removedVolume;
    finalizedOperationIds.add(state.operationId);
  };

  const progress = Math.max(0, Math.min(1, Number(options.progress ?? 1)));
  const totalCutSeconds = motionTimeline.totalCutSeconds;
  const totalMotionSeconds = motionTimeline.totalMotionSeconds;
  const targetMotionSeconds = totalMotionSeconds * progress;
  let processedSegmentCount = 0;
  let processedCutSeconds = 0;
  let processedMotionSegmentCount = 0;
  let processedMotionSeconds = 0;
  let activeOperationState = null;
  let toolState = motionSegments.length > 0 ? buildToolState(motionSegments[0], motionSegments[0].start, 0) : null;
  for (const segment of motionSegments) {
    const operationState = operationStateById.get(segment.operationId) || null;
    if (activeOperationState && activeOperationState.operationId !== segment.operationId) {
      finalizeOperationState(activeOperationState);
    }
    activeOperationState = operationState;

    if (processedMotionSeconds >= targetMotionSeconds - EPSILON) break;
    const remainingSeconds = targetMotionSeconds - processedMotionSeconds;
    if (remainingSeconds + EPSILON >= segment.durationSeconds) {
      if (segment.cutting) {
        carveSegment(heights, columns, rows, stock, segment);
        processedCutSeconds += segment.durationSeconds;
        processedSegmentCount += 1;
        if (operationState) operationState.processedSegmentCount += 1;
      }
      processedMotionSeconds += segment.durationSeconds;
      processedMotionSegmentCount += 1;
      toolState = buildToolState(segment, segment.end, 1);
      continue;
    }
    const ratio = Math.max(0, Math.min(1, remainingSeconds / segment.durationSeconds));
    if (ratio > EPSILON) {
      const partialSegment = {
        ...segment,
        end: interpolatePoint(segment.start, segment.end, ratio),
      };
      if (segment.cutting) {
        carveSegment(heights, columns, rows, stock, partialSegment);
        processedCutSeconds += remainingSeconds;
        processedSegmentCount += ratio;
        if (operationState) operationState.processedSegmentCount += ratio;
      }
      processedMotionSeconds += remainingSeconds;
      processedMotionSegmentCount += ratio;
      toolState = buildToolState(segment, partialSegment.end, ratio);
    }
    break;
  }

  finalizeOperationState(activeOperationState);

  const summary = summarizeHeightField(heights, stock, initialVolume);

  return {
    stock: {
      min: { ...stock.min },
      max: { ...stock.max },
    },
    columns,
    rows,
    heights,
    progress,
    motionSegments,
    motionSegmentCount: motionSegments.length,
    processedMotionSegmentCount,
    totalMotionSeconds,
    processedMotionSeconds,
    feedSegmentCount: feedSegments.length,
    processedSegmentCount,
    totalCutSeconds,
    processedCutSeconds,
    removedVertexCount: summary.removedVertexCount,
    minHeight: summary.minHeight,
    remainingVolume: summary.remainingVolume,
    removedVolume: summary.removedVolume,
    operationStates,
    toolState,
  };
}

function collectMotionSegments(toolpaths, toolById, units = 'mm') {
  const segments = [];
  for (let toolpathIndex = 0; toolpathIndex < (toolpaths || []).length; toolpathIndex++) {
    const toolpath = toolpaths[toolpathIndex];
    const tool = toolById.get(toolpath.toolId) || toolById.get(String(toolpath.toolId));
    const radius = Math.max(EPSILON, Number(tool?.diameter || 1) / 2);
    let current = { x: null, y: null, z: null };
    for (const move of toolpath.moves || []) {
      const next = {
        x: Number.isFinite(Number(move.x)) ? Number(move.x) : current.x,
        y: Number.isFinite(Number(move.y)) ? Number(move.y) : current.y,
        z: Number.isFinite(Number(move.z)) ? Number(move.z) : current.z,
      };
      if (move.type === 'feed' || move.type === 'rapid') {
        appendLinearMotionSegment(segments, {
          current,
          next,
          move,
          tool,
          toolpath,
          toolpathIndex,
          radius,
          units,
        });
      } else if (move.type === 'arc') {
        appendArcMotionSegments(segments, {
          current,
          next,
          move,
          tool,
          toolpath,
          toolpathIndex,
          radius,
          units,
        });
      } else if (move.type === 'cubic') {
        appendCubicMotionSegments(segments, {
          current,
          next,
          move,
          tool,
          toolpath,
          toolpathIndex,
          radius,
          units,
        });
      }
      current = next;
    }
  }
  return segments;
}

function appendLinearMotionSegment(segments, context) {
  const { current, next, move, tool, toolpath, toolpathIndex, radius, units } = context;
  if (!hasPoint3(current) || !hasPoint3(next)) return;
  const length = segmentLength(current, next);
  if (length <= EPSILON) return;
  segments.push(buildMotionSegment({
    start: current,
    end: next,
    moveType: move.type,
    tool,
    toolpath,
    toolpathIndex,
    radius,
    feedOverride: move.feed,
    units,
  }));
}

function appendArcMotionSegments(segments, context) {
  const { current, next, move, tool, toolpath, toolpathIndex, radius, units } = context;
  if (!hasPoint3(current) || !hasPoint3(next)) return;
  const centerX = Number(move.centerX);
  const centerY = Number(move.centerY);
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
    appendLinearMotionSegment(segments, { ...context, move: { ...move, type: 'feed' } });
    return;
  }
  const startAngle = Math.atan2(current.y - centerY, current.x - centerX);
  let endAngle = Math.atan2(next.y - centerY, next.x - centerX);
  let sweep = endAngle - startAngle;
  if (move.clockwise === true) {
    if (sweep >= 0) sweep -= Math.PI * 2;
  } else if (sweep <= 0) {
    sweep += Math.PI * 2;
  }
  if (Math.abs(sweep) <= EPSILON) {
    appendLinearMotionSegment(segments, { ...context, move: { ...move, type: 'feed' } });
    return;
  }

  const radiusLength = Math.hypot(current.x - centerX, current.y - centerY);
  const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
  let previous = { ...current };
  for (let index = 1; index <= steps; index++) {
    const t = index / steps;
    const angle = startAngle + sweep * t;
    const point = {
      x: centerX + Math.cos(angle) * radiusLength,
      y: centerY + Math.sin(angle) * radiusLength,
      z: current.z + (next.z - current.z) * t,
    };
    segments.push(buildMotionSegment({
      start: previous,
      end: point,
      moveType: 'feed',
      displayType: 'arc',
      tool,
      toolpath,
      toolpathIndex,
      radius,
      feedOverride: move.feed,
      units,
    }));
    previous = point;
  }
}

function appendCubicMotionSegments(segments, context) {
  const { current, next, move, tool, toolpath, toolpathIndex, radius, units } = context;
  if (!hasPoint3(current) || !hasPoint3(next)) return;
  const control1 = { x: Number(move.control1X), y: Number(move.control1Y), z: current.z };
  const control2 = { x: Number(move.control2X), y: Number(move.control2Y), z: next.z };
  if (!hasPoint3(control1) || !hasPoint3(control2)) {
    appendLinearMotionSegment(segments, { ...context, move: { ...move, type: 'feed' } });
    return;
  }

  const steps = 16;
  let previous = { ...current };
  for (let index = 1; index <= steps; index++) {
    const t = index / steps;
    const point = evaluateCubicPoint(current, control1, control2, next, t);
    segments.push(buildMotionSegment({
      start: previous,
      end: point,
      moveType: 'feed',
      displayType: 'cubic',
      tool,
      toolpath,
      toolpathIndex,
      radius,
      feedOverride: move.feed,
      units,
    }));
    previous = point;
  }
}

function buildMotionSegment({
  start,
  end,
  moveType,
  displayType = moveType,
  tool,
  toolpath,
  toolpathIndex,
  radius,
  feedOverride,
  units,
}) {
  const length = segmentLength(start, end);
  const feedRate = resolveMotionRate(moveType, feedOverride, tool, units);
  return {
    start: { ...start },
    end: { ...end },
    radius,
    moveType,
    displayType,
    cutting: moveType !== 'rapid',
    durationSeconds: Math.max(EPSILON, (length / Math.max(EPSILON, feedRate)) * 60),
    operationId: toolpath.operationId,
    operationIndex: toolpathIndex,
    toolpathId: toolpath.id,
    toolId: tool?.id || toolpath.toolId,
    toolNumber: tool?.number || toolpath.toolNumber,
    toolType: tool?.type || 'endmill',
    toolDiameter: Number(tool?.diameter || radius * 2 || 1),
    toolRadius: radius,
    toolStickout: Number(tool?.stickout || tool?.fluteLength || (radius * 8)),
    toolFluteLength: Number(tool?.fluteLength || tool?.stickout || (radius * 4)),
    toolBallRadius: Number(tool?.ballRadius || radius),
    toolTipDiameter: Number(tool?.tipDiameter || 0),
    toolTaperAngle: Number(tool?.taperAngle || 60),
    toolPointAngle: Number(tool?.pointAngle || 118),
  };
}

function resolveMotionRate(moveType, feedOverride, tool, units) {
  if (moveType === 'rapid') {
    const fallbackRapid = units === 'inch' ? 120 : 3000;
    return Math.max(EPSILON, Math.max(Number(tool?.feedRate || 0) * 6, fallbackRapid));
  }
  return Math.max(EPSILON, Number(feedOverride) || Number(tool?.feedRate) || 1);
}

function buildToolState(segment, position, progress) {
  if (!segment || !position) return null;
  return {
    operationId: segment.operationId,
    toolpathId: segment.toolpathId,
    toolId: segment.toolId,
    toolNumber: segment.toolNumber,
    type: segment.toolType,
    moveType: segment.moveType,
    displayType: segment.displayType,
    radius: segment.toolRadius,
    diameter: segment.toolDiameter,
    stickout: segment.toolStickout,
    fluteLength: segment.toolFluteLength,
    ballRadius: segment.toolBallRadius,
    tipDiameter: segment.toolTipDiameter,
    taperAngle: segment.toolTaperAngle,
    pointAngle: segment.toolPointAngle,
    progress,
    position: { ...position },
  };
}

function evaluateCubicPoint(start, control1, control2, end, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * start.x + 3 * mt * mt * t * control1.x + 3 * mt * t * t * control2.x + t * t * t * end.x,
    y: mt * mt * mt * start.y + 3 * mt * mt * t * control1.y + 3 * mt * t * t * control2.y + t * t * t * end.y,
    z: mt * mt * mt * start.z + 3 * mt * mt * t * control1.z + 3 * mt * t * t * control2.z + t * t * t * end.z,
  };
}

function hasPoint3(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y) && Number.isFinite(point?.z);
}

function segmentLength(start, end) {
  return Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
}

function buildOperationStates(toolpaths, stock, initialVolume) {
  return (toolpaths || []).map((toolpath, index, allToolpaths) => ({
    operationId: toolpath.operationId,
    toolpathId: toolpath.id,
    name: toolpath.name,
    operationType: toolpath.operationType,
    sequenceIndex: index,
    remainingOperationIds: allToolpaths.slice(index + 1).map((candidate) => candidate.operationId),
    feedSegmentCount: 0,
    processedSegmentCount: 0,
    progress: 0,
    removedVertexCount: 0,
    minHeight: stock.max.z,
    remainingVolume: initialVolume,
    removedVolume: 0,
  }));
}

function estimateStockVolume(stock) {
  const width = Math.max(0, Number(stock?.max?.x) - Number(stock?.min?.x));
  const depth = Math.max(0, Number(stock?.max?.y) - Number(stock?.min?.y));
  const height = Math.max(0, Number(stock?.max?.z) - Number(stock?.min?.z));
  return width * depth * height;
}

function summarizeHeightField(heights, stock, initialVolume) {
  let minHeight = stock.max.z;
  let removedVertexCount = 0;
  let remainingVolume = 0;
  const width = Math.max(EPSILON, Number(stock.max.x) - Number(stock.min.x));
  const depth = Math.max(EPSILON, Number(stock.max.y) - Number(stock.min.y));
  const sampleArea = (width * depth) / Math.max(1, heights.length);

  for (const height of heights) {
    if (height < stock.max.z - EPSILON) removedVertexCount++;
    if (height < minHeight) minHeight = height;
    remainingVolume += Math.max(0, height - stock.min.z) * sampleArea;
  }

  return {
    minHeight,
    removedVertexCount,
    remainingVolume,
    removedVolume: Math.max(0, initialVolume - remainingVolume),
  };
}

function carveSegment(heights, columns, rows, stock, segment) {
  const deltaX = segment.end.x - segment.start.x;
  const deltaY = segment.end.y - segment.start.y;
  const length = Math.hypot(deltaX, deltaY);
  const cellSize = Math.min((stock.max.x - stock.min.x) / columns, (stock.max.y - stock.min.y) / rows);
  const step = Math.max(cellSize * 0.5, segment.radius * 0.35, EPSILON);
  const samples = Math.max(1, Math.ceil(length / step));
  for (let sampleIndex = 0; sampleIndex <= samples; sampleIndex++) {
    const t = sampleIndex / samples;
    const x = segment.start.x + deltaX * t;
    const y = segment.start.y + deltaY * t;
    const z = Math.min(segment.start.z, segment.end.z);
    carvePoint(heights, columns, rows, stock, x, y, z, segment.radius);
  }
}

function interpolatePoint(start, end, ratio) {
  return {
    x: start.x + (end.x - start.x) * ratio,
    y: start.y + (end.y - start.y) * ratio,
    z: start.z + (end.z - start.z) * ratio,
  };
}

function carvePoint(heights, columns, rows, stock, x, y, z, radius) {
  const minColumn = Math.max(0, Math.floor(((x - radius - stock.min.x) / (stock.max.x - stock.min.x)) * columns));
  const maxColumn = Math.min(columns, Math.ceil(((x + radius - stock.min.x) / (stock.max.x - stock.min.x)) * columns));
  const minRow = Math.max(0, Math.floor(((y - radius - stock.min.y) / (stock.max.y - stock.min.y)) * rows));
  const maxRow = Math.min(rows, Math.ceil(((y + radius - stock.min.y) / (stock.max.y - stock.min.y)) * rows));
  const radiusSquared = radius * radius;
  for (let row = minRow; row <= maxRow; row++) {
    const pointY = stock.min.y + ((stock.max.y - stock.min.y) * row) / rows;
    for (let column = minColumn; column <= maxColumn; column++) {
      const pointX = stock.min.x + ((stock.max.x - stock.min.x) * column) / columns;
      const distanceSquared = (pointX - x) * (pointX - x) + (pointY - y) * (pointY - y);
      if (distanceSquared > radiusSquared + EPSILON) continue;
      const index = row * (columns + 1) + column;
      heights[index] = Math.min(heights[index], z);
    }
  }
}

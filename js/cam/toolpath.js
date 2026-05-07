import { getOperationLoops, normalizeCamConfig } from './model.js';
import { offsetPolygon } from './geometry/polygonOffset.js';

const EPSILON = 1e-9;

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
    const loops = getOperationLoops(operation);
    if (loops.length === 0) {
      warnings.push({ operationId: operation.id, message: 'Operation has no contours' });
      continue;
    }
    const toolpath = operation.type === 'pocket'
      ? generatePocketToolpath(operation, tool, loops)
      : generateProfileToolpath(operation, tool, loops);
    toolpath.warnings = warnings.filter((warning) => warning.operationId === operation.id);
    toolpaths.push(toolpath);
  }

  return { config, toolpaths, warnings };
}

export function generateProfileToolpath(operation, tool, loops = getOperationLoops(operation)) {
  const radius = tool.diameter / 2;
  const offsetDistance = operation.side === 'outside'
    ? radius
    : (operation.side === 'inside' ? -radius : 0);
  const passes = depthPasses(operation.topZ, operation.bottomZ, operation.stepDown);
  const moves = operationHeader(operation, tool);

  for (const depth of passes) {
    for (const loop of loops) {
      const path = offsetDistance === 0 ? loop : offsetPolygon(loop, offsetDistance);
      appendClosedPathPass(moves, path, depth, operation);
    }
  }
  moves.push({ type: 'rapid', z: operation.safeZ });
  moves.push({ type: 'spindle', on: false });
  return makeToolpath(operation, tool, moves);
}

export function generatePocketToolpath(operation, tool, loops = getOperationLoops(operation)) {
  const radius = tool.diameter / 2;
  const stepover = Math.max(
    EPSILON,
    Number.isFinite(Number(operation.stepoverPercent))
      ? tool.diameter * Math.max(1, Math.min(100, Number(operation.stepoverPercent))) / 100
      : (operation.stepover || tool.diameter * 0.4),
  );
  const passes = depthPasses(operation.topZ, operation.bottomZ, operation.stepDown);
  const moves = operationHeader(operation, tool);

  for (const depth of passes) {
    for (const loop of loops) {
      let offset = -radius;
      for (let index = 0; index < 100; index++) {
        const path = offsetPolygon(loop, offset);
        if (path.length < 3) break;
        appendClosedPathPass(moves, path, depth, operation);
        offset -= stepover;
      }
    }
  }
  moves.push({ type: 'rapid', z: operation.safeZ });
  moves.push({ type: 'spindle', on: false });
  return makeToolpath(operation, tool, moves);
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
  return [
    { type: 'comment', text: `${operation.name} (${operation.type})` },
    { type: 'toolchange', toolNumber: tool.number, toolId: tool.id, toolName: tool.name },
    { type: 'spindle', on: true, rpm: operation.spindleRpm || tool.spindleRpm, clockwise: true },
    { type: 'coolant', on: !!tool.coolant },
    { type: 'rapid', z: operation.safeZ },
  ];
}

function appendClosedPathPass(moves, path, depth, operation) {
  if (!Array.isArray(path) || path.length < 2) return;
  const orderedPath = rotateClosedPath(path, operation.leadInPosition);
  const first = orderedPath[0];
  const leadInPath = buildLeadInPath(orderedPath, operation);
  const rapidTarget = leadInPath[0] || first;
  moves.push({ type: 'rapid', z: operation.clearanceZ });
  moves.push({ type: 'rapid', x: rapidTarget.x, y: rapidTarget.y });
  moves.push({ type: 'feed', z: depth, feed: operation.plungeRate });
  for (let index = 1; index < leadInPath.length; index++) {
    moves.push({ type: 'feed', x: leadInPath[index].x, y: leadInPath[index].y, feed: operation.feedRate });
  }
  for (let index = 1; index < orderedPath.length; index++) {
    moves.push({ type: 'feed', x: orderedPath[index].x, y: orderedPath[index].y, feed: operation.feedRate });
  }
  moves.push({ type: 'feed', x: first.x, y: first.y, feed: operation.feedRate });
  moves.push({ type: 'rapid', z: operation.clearanceZ });
}

function rotateClosedPath(path, position = 0) {
  if (!Array.isArray(path) || path.length < 2) return path || [];
  const clamped = Math.max(0, Math.min(1, Number(position) || 0));
  const startIndex = Math.min(path.length - 1, Math.round(clamped * (path.length - 1)));
  if (startIndex <= 0) return path;
  return path.slice(startIndex).concat(path.slice(0, startIndex));
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

function makeToolpath(operation, tool, moves) {
  return {
    id: `toolpath-${operation.id}`,
    operationId: operation.id,
    operationType: operation.type,
    name: operation.name,
    toolId: tool.id,
    toolNumber: tool.number,
    moves,
  };
}

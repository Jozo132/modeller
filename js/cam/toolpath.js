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
  const stepover = Math.max(EPSILON, operation.stepover || tool.diameter * 0.4);
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
  const first = path[0];
  moves.push({ type: 'rapid', z: operation.clearanceZ });
  moves.push({ type: 'rapid', x: first.x, y: first.y });
  moves.push({ type: 'feed', z: depth, feed: operation.plungeRate });
  for (let index = 1; index < path.length; index++) {
    moves.push({ type: 'feed', x: path[index].x, y: path[index].y, feed: operation.feedRate });
  }
  moves.push({ type: 'feed', x: first.x, y: first.y, feed: operation.feedRate });
  moves.push({ type: 'rapid', z: operation.clearanceZ });
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
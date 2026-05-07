import { normalizeCamConfig } from './model.js';
import { generateToolpaths } from './toolpath.js';

const EPSILON = 1e-9;

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

  const resolution = Math.max(8, Math.min(96, Math.round(options.resolution || 48)));
  const columns = Math.max(1, Math.round(resolution));
  const rows = Math.max(1, Math.round(resolution * Math.max(0.25, Math.min(4, depth / width))));
  const heights = new Float32Array((columns + 1) * (rows + 1));
  heights.fill(stock.max.z);

  const toolById = new Map(config.tools.map((tool) => [tool.id, tool]));
  const feedSegments = collectFeedSegments(toolpaths, toolById);
  const progress = Math.max(0, Math.min(1, Number(options.progress ?? 1)));
  const limit = Math.floor(feedSegments.length * progress + EPSILON);
  for (let segmentIndex = 0; segmentIndex < limit; segmentIndex++) {
    carveSegment(heights, columns, rows, stock, feedSegments[segmentIndex]);
  }

  let minHeight = stock.max.z;
  let removedVertexCount = 0;
  for (const height of heights) {
    if (height < stock.max.z - EPSILON) removedVertexCount++;
    if (height < minHeight) minHeight = height;
  }

  return {
    stock: {
      min: { ...stock.min },
      max: { ...stock.max },
    },
    columns,
    rows,
    heights,
    progress,
    feedSegmentCount: feedSegments.length,
    processedSegmentCount: limit,
    removedVertexCount,
    minHeight,
  };
}

function collectFeedSegments(toolpaths, toolById) {
  const segments = [];
  for (const toolpath of toolpaths || []) {
    const tool = toolById.get(toolpath.toolId) || toolById.get(String(toolpath.toolId));
    const radius = Math.max(EPSILON, Number(tool?.diameter || 1) / 2);
    let current = { x: null, y: null, z: null };
    for (const move of toolpath.moves || []) {
      if (move.type !== 'feed' && move.type !== 'rapid') continue;
      const next = {
        x: Number.isFinite(Number(move.x)) ? Number(move.x) : current.x,
        y: Number.isFinite(Number(move.y)) ? Number(move.y) : current.y,
        z: Number.isFinite(Number(move.z)) ? Number(move.z) : current.z,
      };
      const hasCurrentPoint = Number.isFinite(current.x) && Number.isFinite(current.y) && Number.isFinite(current.z);
      const hasNextPoint = Number.isFinite(next.x) && Number.isFinite(next.y) && Number.isFinite(next.z);
      if (move.type === 'feed' && hasCurrentPoint && hasNextPoint) {
        segments.push({ start: { ...current }, end: next, radius });
      }
      current = next;
    }
  }
  return segments;
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
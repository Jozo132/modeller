export const CAM_CONFIG_VERSION = 1;

export const CAM_TOOL_TYPES = Object.freeze(['endmill', 'ball', 'cone', 'drill']);
export const CAM_OPERATION_TYPES = Object.freeze(['profile', 'pocket']);
export const CAM_PROFILE_SIDES = Object.freeze(['along', 'inside', 'outside']);

const DEFAULT_BOUNDS = Object.freeze({
  min: Object.freeze({ x: 0, y: 0, z: 0 }),
  max: Object.freeze({ x: 100, y: 100, z: 10 }),
});

export function createDefaultCamConfig(options = {}) {
  return normalizeCamConfig({}, options);
}

export function normalizeCamConfig(input = {}, options = {}) {
  const data = input && typeof input === 'object' ? input : {};
  const stock = normalizeStock(data.stock, options.bounds);
  const tools = normalizeTools(data.tools);
  const activeToolId = tools.some((tool) => tool.id === data.activeToolId)
    ? data.activeToolId
    : tools[0]?.id || null;
  const operations = normalizeOperations(data.operations, { stock, tools, activeToolId });
  const activeOperationId = operations.some((operation) => operation.id === data.activeOperationId)
    ? data.activeOperationId
    : operations[0]?.id || null;

  return {
    version: CAM_CONFIG_VERSION,
    units: data.units === 'inch' ? 'inch' : 'mm',
    tolerance: positiveNumber(data.tolerance, positiveNumber(options.tolerance, 0.001)),
    postprocessorId: typeof data.postprocessorId === 'string' && data.postprocessorId.trim()
      ? data.postprocessorId.trim()
      : 'linuxcnc',
    stock,
    machineOrigin: normalizeMachineOrigin(data.machineOrigin, stock),
    tools,
    operations,
    activeToolId,
    activeOperationId,
  };
}

export function boundsFromGeometry(geometry) {
  const bounds = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };

  const visitPoint = (point) => {
    if (!point) return;
    const x = numberOr(point.x, NaN);
    const y = numberOr(point.y, NaN);
    const z = numberOr(point.z, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    bounds.min.x = Math.min(bounds.min.x, x);
    bounds.min.y = Math.min(bounds.min.y, y);
    bounds.min.z = Math.min(bounds.min.z, z);
    bounds.max.x = Math.max(bounds.max.x, x);
    bounds.max.y = Math.max(bounds.max.y, y);
    bounds.max.z = Math.max(bounds.max.z, z);
  };

  for (const face of geometry?.faces || []) {
    for (const vertex of face.vertices || []) visitPoint(vertex);
  }
  for (const vertex of geometry?.vertices || []) visitPoint(vertex);

  if (!Number.isFinite(bounds.min.x) || !Number.isFinite(bounds.max.x)) return cloneBounds(DEFAULT_BOUNDS);
  return bounds;
}

export function normalizeTool(input = {}, index = 0) {
  const data = input && typeof input === 'object' ? input : {};
  const type = CAM_TOOL_TYPES.includes(data.type) ? data.type : 'endmill';
  const diameter = positiveNumber(data.diameter, 6);
  const tool = {
    id: normalizeId(data.id, `tool-${index + 1}`),
    number: Math.max(1, Math.round(positiveNumber(data.number, index + 1))),
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : defaultToolName(type, index),
    type,
    diameter,
    fluteLength: positiveNumber(data.fluteLength, diameter * 3),
    stickout: positiveNumber(data.stickout, diameter * 5),
    feedRate: positiveNumber(data.feedRate, 400),
    plungeRate: positiveNumber(data.plungeRate, 120),
    spindleRpm: Math.round(positiveNumber(data.spindleRpm, 10000)),
    coolant: data.coolant === true,
  };

  if (type === 'ball') {
    tool.ballRadius = positiveNumber(data.ballRadius, diameter / 2);
  } else if (type === 'cone') {
    tool.tipDiameter = nonNegativeNumber(data.tipDiameter, 0);
    tool.taperAngle = positiveNumber(data.taperAngle, 60);
  } else if (type === 'drill') {
    tool.pointAngle = positiveNumber(data.pointAngle, 118);
  } else {
    tool.cornerRadius = nonNegativeNumber(data.cornerRadius, 0);
  }

  return tool;
}

export function normalizeOperation(input = {}, index = 0, context = {}) {
  const data = input && typeof input === 'object' ? input : {};
  const type = CAM_OPERATION_TYPES.includes(data.type) ? data.type : 'profile';
  const stock = context.stock || normalizeStock();
  const tool = (context.tools || []).find((candidate) => candidate.id === data.toolId)
    || (context.tools || []).find((candidate) => candidate.id === context.activeToolId)
    || null;
  const toolId = tool?.id || context.activeToolId || null;
  const safeZ = numberOr(data.safeZ, stock.max.z + 10);
  const clearanceZ = numberOr(data.clearanceZ, Math.max(safeZ, stock.max.z + 5));
  const topZ = numberOr(data.topZ, stock.max.z);
  const bottomZ = numberOr(data.bottomZ, stock.min.z);

  const operation = {
    id: normalizeId(data.id, `${type}-${index + 1}`),
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : defaultOperationName(type, index),
    type,
    enabled: data.enabled !== false,
    toolId,
    source: normalizeSource(data.source || { loops: data.loops || data.contours || [] }),
    topZ,
    bottomZ,
    stepDown: positiveNumber(data.stepDown, Math.max(0.1, Math.abs(topZ - bottomZ) || 1)),
    safeZ,
    clearanceZ,
    feedRate: positiveNumber(data.feedRate, tool?.feedRate || 400),
    plungeRate: positiveNumber(data.plungeRate, tool?.plungeRate || 120),
    spindleRpm: Math.round(positiveNumber(data.spindleRpm, tool?.spindleRpm || 10000)),
    leadInEnabled: data.leadInEnabled === true,
    leadInLength: nonNegativeNumber(data.leadInLength, 0),
    leadInZigZagAmplitude: nonNegativeNumber(data.leadInZigZagAmplitude, tool ? tool.diameter * 0.15 : 0.9),
    leadInZigZagCount: Math.max(1, Math.round(positiveNumber(data.leadInZigZagCount, 3))),
    leadInPosition: clamp(numberOr(data.leadInPosition, 0), 0, 1),
  };

  if (type === 'profile') {
    operation.side = CAM_PROFILE_SIDES.includes(data.side) ? data.side : 'outside';
  } else {
    const defaultStepover = tool ? roundCamNumber(Math.max(tool.diameter * 0.4, 0.1)) : 2.4;
    const stepover = roundCamNumber(positiveNumber(data.stepover, defaultStepover));
    operation.stepover = stepover;
    operation.stepoverPercent = clamp(
      positiveNumber(data.stepoverPercent, tool?.diameter ? (stepover / tool.diameter) * 100 : 40),
      1,
      100,
    );
  }

  return operation;
}

export function getOperationLoops(operation) {
  if (!operation) return [];
  return normalizeSource(operation.source || { loops: operation.loops || operation.contours || [] }).loops;
}

function normalizeStock(input = null, bounds = null) {
  const data = input && typeof input === 'object' ? input : {};
  const sourceBounds = input ? { min: data.min, max: data.max } : inflateBounds(bounds || DEFAULT_BOUNDS, numberOr(data.margin, 5));
  const min = normalizePoint3(sourceBounds.min, DEFAULT_BOUNDS.min);
  const max = normalizePoint3(sourceBounds.max, DEFAULT_BOUNDS.max);
  return {
    enabled: data.enabled !== false,
    material: typeof data.material === 'string' && data.material.trim() ? data.material.trim() : 'stock',
    color: typeof data.color === 'string' && data.color.trim() ? data.color.trim() : '#68a7ff',
    opacity: clamp(numberOr(data.opacity, 0.42), 0.02, 0.9),
    min: {
      x: Math.min(min.x, max.x),
      y: Math.min(min.y, max.y),
      z: Math.min(min.z, max.z),
    },
    max: {
      x: Math.max(min.x, max.x),
      y: Math.max(min.y, max.y),
      z: Math.max(min.z, max.z),
    },
  };
}

function normalizeMachineOrigin(input = null, stock) {
  const data = input && typeof input === 'object' ? input : {};
  const preset = typeof data.preset === 'string' && data.preset.trim()
    ? data.preset.trim()
    : 'stock-top-front-left';
  return {
    preset,
    position: normalizePoint3(data.position, originFromPreset(preset, stock)),
    axes: {
      x: normalizePoint3(data.axes?.x, { x: 1, y: 0, z: 0 }),
      y: normalizePoint3(data.axes?.y, { x: 0, y: 1, z: 0 }),
      z: normalizePoint3(data.axes?.z, { x: 0, y: 0, z: 1 }),
    },
  };
}

function normalizeTools(input = []) {
  const source = Array.isArray(input) && input.length > 0 ? input : [{ type: 'endmill', number: 1, diameter: 6 }];
  const seen = new Set();
  return source.map((tool, index) => {
    const normalized = normalizeTool(tool, index);
    while (seen.has(normalized.id)) normalized.id = `${normalized.id}-${index + 1}`;
    seen.add(normalized.id);
    return normalized;
  });
}

function normalizeOperations(input = [], context = {}) {
  const source = Array.isArray(input) ? input : [];
  const seen = new Set();
  return source.map((operation, index) => {
    const normalized = normalizeOperation(operation, index, context);
    while (seen.has(normalized.id)) normalized.id = `${normalized.id}-${index + 1}`;
    seen.add(normalized.id);
    return normalized;
  });
}

function normalizeSource(input = {}) {
  const data = input && typeof input === 'object' ? input : {};
  const loops = Array.isArray(data.loops) ? data.loops : (Array.isArray(data.contours) ? data.contours : []);
  return {
    type: typeof data.type === 'string' && data.type.trim() ? data.type.trim() : 'manual',
    referenceId: typeof data.referenceId === 'string' ? data.referenceId : null,
    label: typeof data.label === 'string' && data.label.trim() ? data.label.trim() : null,
    faceIndex: integerOrNull(data.faceIndex),
    topoFaceId: integerOrNull(data.topoFaceId),
    edgeIndex: integerOrNull(data.edgeIndex),
    tolerance: positiveNumberOrNull(data.tolerance),
    loops: loops.map(normalizeLoop).filter((loop) => loop.length >= 3),
  };
}

function normalizeLoop(points) {
  if (!Array.isArray(points)) return [];
  return points
    .map((point) => ({ x: numberOr(point?.x, NaN), y: numberOr(point?.y, NaN) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function inflateBounds(bounds, margin) {
  const normalized = cloneBounds(bounds || DEFAULT_BOUNDS);
  return {
    min: {
      x: normalized.min.x - margin,
      y: normalized.min.y - margin,
      z: normalized.min.z,
    },
    max: {
      x: normalized.max.x + margin,
      y: normalized.max.y + margin,
      z: normalized.max.z + margin,
    },
  };
}

function cloneBounds(bounds) {
  return {
    min: normalizePoint3(bounds?.min, DEFAULT_BOUNDS.min),
    max: normalizePoint3(bounds?.max, DEFAULT_BOUNDS.max),
  };
}

function originFromPreset(preset, stock) {
  if (preset === 'stock-top-center') {
    return {
      x: (stock.min.x + stock.max.x) / 2,
      y: (stock.min.y + stock.max.y) / 2,
      z: stock.max.z,
    };
  }
  if (preset === 'model-origin') return { x: 0, y: 0, z: 0 };
  return { x: stock.min.x, y: stock.min.y, z: stock.max.z };
}

function normalizePoint3(point, fallback) {
  return {
    x: numberOr(point?.x, fallback.x),
    y: numberOr(point?.y, fallback.y),
    z: numberOr(point?.z, fallback.z),
  };
}

function normalizeId(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function defaultToolName(type, index) {
  const label = type === 'endmill' ? 'End Mill' : type[0].toUpperCase() + type.slice(1);
  return `${label} ${index + 1}`;
}

function defaultOperationName(type, index) {
  return `${type === 'profile' ? 'Profile' : 'Pocket'} ${index + 1}`;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = numberOr(value, fallback);
  return number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = numberOr(value, fallback);
  return number >= 0 ? number : fallback;
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function positiveNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function roundCamNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return Math.round(number * 1000000) / 1000000;
}

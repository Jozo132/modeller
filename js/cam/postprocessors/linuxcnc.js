export const linuxCncPostprocessor = Object.freeze({
  id: 'linuxcnc',
  label: 'LinuxCNC',
  postprocess,
});

export function postprocess(toolpaths, options = {}) {
  const paths = Array.isArray(toolpaths) ? toolpaths : [];
  const programName = sanitizeComment(options.programName || options.camConfig?.name || 'CAM program');
  const coordinateTolerance = Number.isFinite(Number(options.tolerance))
    ? Number(options.tolerance)
    : Number(options.camConfig?.tolerance);
  const decimalPlaces = toleranceToDecimals(coordinateTolerance);
  const useG5 = options.linuxCncUseG5 !== false && options.camConfig?.linuxCncUseG5 !== false;
  const lines = [
    '%',
    `(${programName})`,
    'G21',
    'G90',
    'G17',
    'G40',
    'G49',
    'G54',
  ];

  let activeFeed = null;
  let currentPosition = { x: null, y: null, z: null };
  for (const toolpath of paths) {
    for (const move of toolpath.moves || []) {
      if (move.type === 'comment') {
        lines.push(`(${sanitizeComment(move.text)})`);
      } else if (move.type === 'toolchange') {
        if (move.toolName) lines.push(`(Tool ${move.toolNumber}: ${sanitizeComment(move.toolName)})`);
        lines.push(`T${Math.max(1, Math.round(move.toolNumber || 1))} M6`);
        activeFeed = null;
      } else if (move.type === 'spindle') {
        lines.push(move.on === false ? 'M5' : `S${Math.round(move.rpm || 0)} ${move.clockwise === false ? 'M4' : 'M3'}`);
      } else if (move.type === 'coolant') {
        lines.push(move.on ? 'M8' : 'M9');
      } else if (move.type === 'rapid') {
        lines.push(formatMotion('G0', move, null, decimalPlaces));
        currentPosition = updatePosition(currentPosition, move);
      } else if (move.type === 'feed') {
        const feedChanged = Number.isFinite(Number(move.feed)) && Number(move.feed) !== activeFeed;
        if (feedChanged) activeFeed = Number(move.feed);
        lines.push(formatMotion('G1', move, feedChanged ? activeFeed : null, decimalPlaces));
        currentPosition = updatePosition(currentPosition, move);
      } else if (move.type === 'arc') {
        const feedChanged = Number.isFinite(Number(move.feed)) && Number(move.feed) !== activeFeed;
        if (feedChanged) activeFeed = Number(move.feed);
        lines.push(formatArcMotion(move, currentPosition, feedChanged ? activeFeed : null, decimalPlaces));
        currentPosition = updatePosition(currentPosition, move);
      } else if (move.type === 'cubic') {
        const feedChanged = Number.isFinite(Number(move.feed)) && Number(move.feed) !== activeFeed;
        if (feedChanged) activeFeed = Number(move.feed);
        if (useG5) {
          lines.push(formatCubicMotion(move, currentPosition, feedChanged ? activeFeed : null, decimalPlaces));
        } else {
          const linearized = linearizeCubicMove(currentPosition, move);
          for (let index = 0; index < linearized.length; index++) {
            lines.push(formatMotion('G1', linearized[index], index === 0 && feedChanged ? activeFeed : null, decimalPlaces));
          }
        }
        currentPosition = updatePosition(currentPosition, move);
      }
    }
  }

  lines.push('M5');
  lines.push('M9');
  lines.push('M2');
  lines.push('%');
  return `${lines.join('\n')}\n`;
}

function formatMotion(code, move, feed = null, decimals = 4) {
  const words = [code];
  if (Number.isFinite(Number(move.x))) words.push(`X${formatNumber(move.x, decimals)}`);
  if (Number.isFinite(Number(move.y))) words.push(`Y${formatNumber(move.y, decimals)}`);
  if (Number.isFinite(Number(move.z))) words.push(`Z${formatNumber(move.z, decimals)}`);
  if (feed != null && Number.isFinite(Number(feed))) words.push(`F${formatNumber(feed, decimals)}`);
  return words.join(' ');
}

function formatArcMotion(move, currentPosition, feed = null, decimals = 4) {
  const words = [move.clockwise === true ? 'G2' : 'G3'];
  if (Number.isFinite(Number(move.x))) words.push(`X${formatNumber(move.x, decimals)}`);
  if (Number.isFinite(Number(move.y))) words.push(`Y${formatNumber(move.y, decimals)}`);
  if (Number.isFinite(Number(move.z))) words.push(`Z${formatNumber(move.z, decimals)}`);
  const i = Number(move.centerX) - Number(currentPosition?.x);
  const j = Number(move.centerY) - Number(currentPosition?.y);
  words.push(`I${formatNumber(i, decimals)}`);
  words.push(`J${formatNumber(j, decimals)}`);
  if (feed != null && Number.isFinite(Number(feed))) words.push(`F${formatNumber(feed, decimals)}`);
  return words.join(' ');
}

function formatCubicMotion(move, currentPosition, feed = null, decimals = 4) {
  const words = ['G5'];
  words.push(`X${formatNumber(move.x, decimals)}`);
  words.push(`Y${formatNumber(move.y, decimals)}`);
  words.push(`I${formatNumber(Number(move.control1X) - Number(currentPosition?.x), decimals)}`);
  words.push(`J${formatNumber(Number(move.control1Y) - Number(currentPosition?.y), decimals)}`);
  words.push(`P${formatNumber(Number(move.control2X) - Number(move.x), decimals)}`);
  words.push(`Q${formatNumber(Number(move.control2Y) - Number(move.y), decimals)}`);
  if (feed != null && Number.isFinite(Number(feed))) words.push(`F${formatNumber(feed, decimals)}`);
  return words.join(' ');
}

function linearizeCubicMove(currentPosition, move, steps = 12) {
  const p0 = { x: Number(currentPosition?.x), y: Number(currentPosition?.y) };
  const p1 = { x: Number(move.control1X), y: Number(move.control1Y) };
  const p2 = { x: Number(move.control2X), y: Number(move.control2Y) };
  const p3 = { x: Number(move.x), y: Number(move.y) };
  if (![p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y].every((value) => Number.isFinite(value))) {
    return [{ x: move.x, y: move.y, z: move.z }];
  }

  const points = [];
  for (let index = 1; index <= steps; index++) {
    const t = index / steps;
    const mt = 1 - t;
    points.push({
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
      z: index === steps ? move.z : undefined,
    });
  }
  return points;
}

function updatePosition(currentPosition, move) {
  return {
    x: Number.isFinite(Number(move.x)) ? Number(move.x) : currentPosition?.x ?? null,
    y: Number.isFinite(Number(move.y)) ? Number(move.y) : currentPosition?.y ?? null,
    z: Number.isFinite(Number(move.z)) ? Number(move.z) : currentPosition?.z ?? null,
  };
}

function formatNumber(value, decimals = 4) {
  return Number(value).toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function toleranceToDecimals(tolerance) {
  const numeric = Number(tolerance);
  if (!Number.isFinite(numeric)) return 4;
  if (numeric === 0) return 4;
  if (numeric < 0) return 4;
  const decimals = Math.ceil(-Math.log10(numeric));
  return Math.max(0, Math.min(9, decimals));
}

function sanitizeComment(text = '') {
  return String(text).replace(/[()\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

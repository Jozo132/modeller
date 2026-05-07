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
      } else if (move.type === 'feed') {
        const feedChanged = Number.isFinite(Number(move.feed)) && Number(move.feed) !== activeFeed;
        if (feedChanged) activeFeed = Number(move.feed);
        lines.push(formatMotion('G1', move, feedChanged ? activeFeed : null, decimalPlaces));
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
  if (Number.isFinite(Number(feed))) words.push(`F${formatNumber(feed, decimals)}`);
  return words.join(' ');
}

function formatNumber(value, decimals = 4) {
  return Number(value).toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function toleranceToDecimals(tolerance) {
  const numeric = Number(tolerance);
  if (!Number.isFinite(numeric) || numeric <= 0) return 4;
  const decimals = Math.ceil(-Math.log10(numeric));
  return Math.max(0, Math.min(9, decimals));
}

function sanitizeComment(text = '') {
  return String(text).replace(/[()\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

// js/svg/import.js — SVG path parser for sketch import
import { state } from '../state.js';
import { info, error } from '../logger.js';

// ---------------------------------------------------------------------------
// SVG path tokenizer & command parser
// ---------------------------------------------------------------------------

/**
 * Tokenize an SVG path `d` attribute into an array of command objects.
 * Each command: { cmd: 'M'|'L'|..., args: number[] }
 */
function tokenizePath(d) {
  const commands = [];
  // Match command letter followed by its numeric arguments
  const re = /([MmLlHhVvCcSsQqTtAaZz])\s*([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1];
    const argStr = m[2].trim();
    const args = argStr.length > 0
      ? argStr.split(/[\s,]+|(?<=\d)(?=-)/).filter(s => s.length > 0).map(Number)
      : [];
    commands.push({ cmd, args });
  }
  return commands;
}

/**
 * Flatten an SVG path `d` string into an array of absolute-coordinate
 * drawing primitives: { type: 'line', x1,y1,x2,y2 }
 *
 * Cubic/quadratic beziers are linearized into short segments.
 * Elliptical arcs are also linearized.
 */
function flattenSVGPath(d, bezierSegments = 16) {
  const cmds = tokenizePath(d);
  const items = [];
  let cx = 0, cy = 0; // current point
  let sx = 0, sy = 0; // subpath start
  let prevCx2 = 0, prevCy2 = 0; // last cubic control point (for S)
  let prevQx = 0, prevQy = 0; // last quad control point (for T)
  let lastCmd = '';

  for (const { cmd, args } of cmds) {
    const isRel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    let i = 0;

    const abs = (val, ref) => isRel ? ref + val : val;

    const emitLine = (x1, y1, x2, y2) => {
      const dx = x2 - x1, dy = y2 - y1;
      if (dx * dx + dy * dy > 1e-12) {
        items.push({ type: 'line', x1, y1, x2, y2 });
      }
    };

    const emitCubic = (x0, y0, cp1x, cp1y, cp2x, cp2y, x, y) => {
      items.push({ type: 'cubicBezier', x0, y0, cp1x, cp1y, cp2x, cp2y, x, y });
    };

    const emitQuad = (x0, y0, cpx, cpy, x, y) => {
      items.push({ type: 'quadBezier', x0, y0, cpx, cpy, x, y });
    };

    const emitArc = (x0, y0, rx, ry, xRot, largeArc, sweep, x, y) => {
      // Linearize SVG elliptical arc
      const segs = arcToSegments(x0, y0, rx, ry, xRot, largeArc, sweep, x, y, bezierSegments * 2);
      let px = x0, py = y0;
      for (const pt of segs) {
        emitLine(px, py, pt.x, pt.y);
        px = pt.x; py = pt.y;
      }
    };

    switch (C) {
      case 'M':
        // Consume first pair as moveTo, subsequent pairs as implicit lineTo
        while (i + 1 < args.length) {
          const mx = abs(args[i], cx), my = abs(args[i + 1], cy);
          if (i === 0) {
            cx = mx; cy = my; sx = mx; sy = my;
          } else {
            emitLine(cx, cy, mx, my);
            cx = mx; cy = my;
          }
          i += 2;
        }
        break;

      case 'L':
        while (i + 1 < args.length) {
          const lx = abs(args[i], cx), ly = abs(args[i + 1], cy);
          emitLine(cx, cy, lx, ly);
          cx = lx; cy = ly;
          i += 2;
        }
        break;

      case 'H':
        while (i < args.length) {
          const hx = abs(args[i], cx);
          emitLine(cx, cy, hx, cy);
          cx = hx;
          i++;
        }
        break;

      case 'V':
        while (i < args.length) {
          const vy = abs(args[i], cy);
          emitLine(cx, cy, cx, vy);
          cy = vy;
          i++;
        }
        break;

      case 'C':
        while (i + 5 < args.length) {
          const c1x = abs(args[i], cx), c1y = abs(args[i + 1], cy);
          const c2x = abs(args[i + 2], cx), c2y = abs(args[i + 3], cy);
          const ex = abs(args[i + 4], cx), ey = abs(args[i + 5], cy);
          emitCubic(cx, cy, c1x, c1y, c2x, c2y, ex, ey);
          prevCx2 = c2x; prevCy2 = c2y;
          cx = ex; cy = ey;
          i += 6;
        }
        break;

      case 'S':
        while (i + 3 < args.length) {
          const rc1x = (lastCmd === 'C' || lastCmd === 'S') ? 2 * cx - prevCx2 : cx;
          const rc1y = (lastCmd === 'C' || lastCmd === 'S') ? 2 * cy - prevCy2 : cy;
          const sc2x = abs(args[i], cx), sc2y = abs(args[i + 1], cy);
          const sex = abs(args[i + 2], cx), sey = abs(args[i + 3], cy);
          emitCubic(cx, cy, rc1x, rc1y, sc2x, sc2y, sex, sey);
          prevCx2 = sc2x; prevCy2 = sc2y;
          cx = sex; cy = sey;
          i += 4;
          lastCmd = 'S';
        }
        break;

      case 'Q':
        while (i + 3 < args.length) {
          const qcx = abs(args[i], cx), qcy = abs(args[i + 1], cy);
          const qex = abs(args[i + 2], cx), qey = abs(args[i + 3], cy);
          emitQuad(cx, cy, qcx, qcy, qex, qey);
          prevQx = qcx; prevQy = qcy;
          cx = qex; cy = qey;
          i += 4;
        }
        break;

      case 'T':
        while (i + 1 < args.length) {
          const tqx = (lastCmd === 'Q' || lastCmd === 'T') ? 2 * cx - prevQx : cx;
          const tqy = (lastCmd === 'Q' || lastCmd === 'T') ? 2 * cy - prevQy : cy;
          const tex = abs(args[i], cx), tey = abs(args[i + 1], cy);
          emitQuad(cx, cy, tqx, tqy, tex, tey);
          prevQx = tqx; prevQy = tqy;
          cx = tex; cy = tey;
          i += 2;
          lastCmd = 'T';
        }
        break;

      case 'A':
        while (i + 6 < args.length) {
          const arx = args[i], ary = args[i + 1];
          const rot = args[i + 2];
          const la = args[i + 3], sw = args[i + 4];
          const ax = abs(args[i + 5], cx), ay = abs(args[i + 6], cy);
          emitArc(cx, cy, arx, ary, rot, la, sw, ax, ay);
          cx = ax; cy = ay;
          i += 7;
        }
        break;

      case 'Z':
        emitLine(cx, cy, sx, sy);
        cx = sx; cy = sy;
        break;
    }

    if (C !== 'S' && C !== 'T') lastCmd = C;
  }

  return items;
}

// ---------------------------------------------------------------------------
// SVG elliptical arc → point list  (endpoint parameterization → center form)
// ---------------------------------------------------------------------------

function arcToSegments(x1, y1, rx, ry, xRotDeg, largeArcFlag, sweepFlag, x2, y2, segments) {
  // Handle degenerate cases
  if (Math.abs(x1 - x2) < 1e-10 && Math.abs(y1 - y2) < 1e-10) return [];
  if (rx === 0 || ry === 0) return [{ x: x2, y: y2 }];

  rx = Math.abs(rx);
  ry = Math.abs(ry);

  const phi = xRotDeg * Math.PI / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);

  // Step 1: transform to unit-circle space
  const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // Scale up radii if too small
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s; ry *= s;
  }

  // Step 2: compute center in transformed space
  const rxSq = rx * rx, rySq = ry * ry;
  const x1pSq = x1p * x1p, y1pSq = y1p * y1p;
  let sq = (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) / (rxSq * y1pSq + rySq * x1pSq);
  if (sq < 0) sq = 0;
  let coef = Math.sqrt(sq);
  if (largeArcFlag === sweepFlag) coef = -coef;

  const cxp = coef * rx * y1p / ry;
  const cyp = -coef * ry * x1p / rx;

  // Step 3: center in original coordinates
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  // (not needed for point generation, but kept for clarity)

  // Step 4: compute angles
  const angleFn = (ux, uy, vx, vy) => {
    const n = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    if (n < 1e-20) return 0;
    let c = (ux * vx + uy * vy) / n;
    c = Math.max(-1, Math.min(1, c));
    const angle = Math.acos(c);
    return (ux * vy - uy * vx < 0) ? -angle : angle;
  };

  const theta1 = angleFn(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angleFn((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);

  if (!sweepFlag && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweepFlag && dTheta < 0) dTheta += 2 * Math.PI;

  // Step 5: generate points
  const pts = [];
  for (let s = 1; s <= segments; s++) {
    const t = s / segments;
    const angle = theta1 + t * dTheta;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const xr = rx * cos, yr = ry * sin;
    pts.push({
      x: cosPhi * xr - sinPhi * yr + mx + (cosPhi * cxp - sinPhi * cyp),
      y: sinPhi * xr + cosPhi * yr + my + (sinPhi * cxp + cosPhi * cyp),
    });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// SVG document parser
// ---------------------------------------------------------------------------

/**
 * Parse an SVG string and extract geometry as line primitives.
 * Handles <path>, <line>, <polyline>, <polygon>, <rect>, <circle>, <ellipse>.
 * Nested transforms (translate, scale, rotate, matrix) are resolved.
 *
 * @param {string} svgContent — raw SVG XML string
 * @returns {Array<{type:'line', x1:number, y1:number, x2:number, y2:number}>}
 */
export function parseSVGGeometry(svgContent) {
  const items = [];

  if (typeof DOMParser !== 'undefined') {
    // Browser: full DOM-based parsing with nested transform resolution
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgContent, 'image/svg+xml');
    const errorNode = doc.querySelector('parsererror');
    if (errorNode) {
      throw new Error('SVG parse error: ' + errorNode.textContent.slice(0, 200));
    }
    _walkNode(doc.documentElement, [1, 0, 0, 1, 0, 0], items);
  } else {
    // Node.js fallback: regex-based extraction (no nested transform support)
    _regexParseSVG(svgContent, items);
  }

  // SVG Y-axis points down; flip to CAD Y-up convention
  for (const item of items) {
    item.y1 = -item.y1;
    item.y2 = -item.y2;
  }

  return items;
}

/**
 * Recursively walk SVG DOM, resolving transforms and collecting geometry.
 */
function _walkNode(node, parentMatrix, items) {
  if (node.nodeType !== 1) return; // element nodes only

  const m = _composeTransform(parentMatrix, node.getAttribute('transform'));

  const tag = node.tagName.toLowerCase();
  switch (tag) {
    case 'path':
      _parsePath(node, m, items);
      break;
    case 'line':
      _parseLine(node, m, items);
      break;
    case 'polyline':
    case 'polygon':
      _parsePolyline(node, m, items, tag === 'polygon');
      break;
    case 'rect':
      _parseRect(node, m, items);
      break;
    case 'circle':
      _parseCircleEl(node, m, items);
      break;
    case 'ellipse':
      _parseEllipseEl(node, m, items);
      break;
  }

  // Recurse into children (g, svg, defs, etc.)
  for (const child of node.children) {
    _walkNode(child, m, items);
  }
}

// ---------------------------------------------------------------------------
// Element parsers
// ---------------------------------------------------------------------------

function _parsePath(node, m, items) {
  const d = node.getAttribute('d');
  if (!d) return;
  const segs = flattenSVGPath(d);
  for (const seg of segs) {
    const [x1, y1] = _applyMatrix(m, seg.x1, seg.y1);
    const [x2, y2] = _applyMatrix(m, seg.x2, seg.y2);
    items.push({ type: 'line', x1, y1, x2, y2 });
  }
}

function _parseLine(node, m, items) {
  const x1 = _num(node, 'x1'), y1 = _num(node, 'y1');
  const x2 = _num(node, 'x2'), y2 = _num(node, 'y2');
  const [ax, ay] = _applyMatrix(m, x1, y1);
  const [bx, by] = _applyMatrix(m, x2, y2);
  items.push({ type: 'line', x1: ax, y1: ay, x2: bx, y2: by });
}

function _parsePolyline(node, m, items, closed) {
  const raw = node.getAttribute('points');
  if (!raw) return;
  const nums = raw.trim().split(/[\s,]+/).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const [x, y] = _applyMatrix(m, nums[i], nums[i + 1]);
    pts.push({ x, y });
  }
  for (let i = 0; i < pts.length - 1; i++) {
    items.push({ type: 'line', x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y });
  }
  if (closed && pts.length > 2) {
    const last = pts[pts.length - 1], first = pts[0];
    items.push({ type: 'line', x1: last.x, y1: last.y, x2: first.x, y2: first.y });
  }
}

function _parseRect(node, m, items) {
  const x = _num(node, 'x'), y = _num(node, 'y');
  const w = _num(node, 'width'), h = _num(node, 'height');
  if (w <= 0 || h <= 0) return;
  const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(
    ([px, py]) => _applyMatrix(m, px, py)
  );
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    items.push({ type: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
  }
}

function _parseCircleEl(node, m, items) {
  const cx = _num(node, 'cx'), cy = _num(node, 'cy'), r = _num(node, 'r');
  if (r <= 0) return;
  // Approximate circle with 32 line segments
  _emitEllipse(cx, cy, r, r, m, items, 32);
}

function _parseEllipseEl(node, m, items) {
  const cx = _num(node, 'cx'), cy = _num(node, 'cy');
  const rx = _num(node, 'rx'), ry = _num(node, 'ry');
  if (rx <= 0 || ry <= 0) return;
  _emitEllipse(cx, cy, rx, ry, m, items, 32);
}

function _emitEllipse(cx, cy, rx, ry, m, items, segs) {
  let prev = _applyMatrix(m, cx + rx, cy);
  for (let i = 1; i <= segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    const cur = _applyMatrix(m, cx + rx * Math.cos(a), cy + ry * Math.sin(a));
    items.push({ type: 'line', x1: prev[0], y1: prev[1], x2: cur[0], y2: cur[1] });
    prev = cur;
  }
}

// ---------------------------------------------------------------------------
// 2D affine transform helpers  (column-major 6-element: [a,b,c,d,e,f])
//   | a c e |   point: | x |   result: | a*x + c*y + e |
//   | b d f |          | y |            | b*x + d*y + f |
//   | 0 0 1 |          | 1 |            |       1       |
// ---------------------------------------------------------------------------

function _applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function _multiplyMatrix(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function _parseTransformAttr(attr) {
  if (!attr) return [1, 0, 0, 1, 0, 0];
  let m = [1, 0, 0, 1, 0, 0];
  const re = /(translate|scale|rotate|skewX|skewY|matrix)\s*\(([^)]*)\)/gi;
  let match;
  while ((match = re.exec(attr)) !== null) {
    const fn = match[1].toLowerCase();
    const args = match[2].trim().split(/[\s,]+/).map(Number);
    let t;
    switch (fn) {
      case 'translate':
        t = [1, 0, 0, 1, args[0] || 0, args[1] || 0];
        break;
      case 'scale': {
        const sx = args[0] || 1, sy = args.length > 1 ? args[1] : sx;
        t = [sx, 0, 0, sy, 0, 0];
        break;
      }
      case 'rotate': {
        const deg = (args[0] || 0) * Math.PI / 180;
        const cs = Math.cos(deg), sn = Math.sin(deg);
        if (args.length >= 3) {
          const cx = args[1], cy = args[2];
          // rotate around (cx,cy)
          t = _multiplyMatrix(
            [1, 0, 0, 1, cx, cy],
            _multiplyMatrix([cs, sn, -sn, cs, 0, 0], [1, 0, 0, 1, -cx, -cy])
          );
        } else {
          t = [cs, sn, -sn, cs, 0, 0];
        }
        break;
      }
      case 'skewx': {
        const a = Math.tan((args[0] || 0) * Math.PI / 180);
        t = [1, 0, a, 1, 0, 0];
        break;
      }
      case 'skewy': {
        const a = Math.tan((args[0] || 0) * Math.PI / 180);
        t = [1, a, 0, 1, 0, 0];
        break;
      }
      case 'matrix':
        t = args.length >= 6 ? args.slice(0, 6) : [1, 0, 0, 1, 0, 0];
        break;
      default:
        continue;
    }
    m = _multiplyMatrix(m, t);
  }
  return m;
}

function _composeTransform(parent, transformAttr) {
  const local = _parseTransformAttr(transformAttr);
  return _multiplyMatrix(parent, local);
}

function _num(node, attr) {
  return parseFloat(node.getAttribute(attr)) || 0;
}

// ---------------------------------------------------------------------------
// Node.js regex fallback (no DOM available)
// ---------------------------------------------------------------------------

function _regexParseSVG(svgContent, items) {
  const identity = [1, 0, 0, 1, 0, 0];

  // Extract <path d="..."> elements
  const pathRe = /<path\b[^>]*?\bd\s*=\s*"([^"]*)"/gi;
  let pm;
  while ((pm = pathRe.exec(svgContent)) !== null) {
    const segs = flattenSVGPath(pm[1]);
    for (const seg of segs) {
      items.push({ type: 'line', x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2 });
    }
  }

  // Extract <line x1="..." y1="..." x2="..." y2="...">
  const lineRe = /<line\b([^>]*)\/?\s*>/gi;
  let lm;
  while ((lm = lineRe.exec(svgContent)) !== null) {
    const a = lm[1];
    const x1 = _attrNum(a, 'x1'), y1 = _attrNum(a, 'y1');
    const x2 = _attrNum(a, 'x2'), y2 = _attrNum(a, 'y2');
    items.push({ type: 'line', x1, y1, x2, y2 });
  }

  // Extract <rect x="..." y="..." width="..." height="...">
  const rectRe = /<rect\b([^>]*)\/?\s*>/gi;
  let rm;
  while ((rm = rectRe.exec(svgContent)) !== null) {
    const a = rm[1];
    const x = _attrNum(a, 'x'), y = _attrNum(a, 'y');
    const w = _attrNum(a, 'width'), h = _attrNum(a, 'height');
    if (w > 0 && h > 0) {
      const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = corners[i], [bx, by] = corners[(i + 1) % 4];
        items.push({ type: 'line', x1: ax, y1: ay, x2: bx, y2: by });
      }
    }
  }

  // Extract <circle cx="..." cy="..." r="...">
  const circleRe = /<circle\b([^>]*)\/?\s*>/gi;
  let cm;
  while ((cm = circleRe.exec(svgContent)) !== null) {
    const a = cm[1];
    const cx = _attrNum(a, 'cx'), cy = _attrNum(a, 'cy'), r = _attrNum(a, 'r');
    if (r > 0) _emitEllipse(cx, cy, r, r, identity, items, 32);
  }

  // Extract <ellipse cx="..." cy="..." rx="..." ry="...">
  const ellipseRe = /<ellipse\b([^>]*)\/?\s*>/gi;
  let em;
  while ((em = ellipseRe.exec(svgContent)) !== null) {
    const a = em[1];
    const cx = _attrNum(a, 'cx'), cy = _attrNum(a, 'cy');
    const rx = _attrNum(a, 'rx'), ry = _attrNum(a, 'ry');
    if (rx > 0 && ry > 0) _emitEllipse(cx, cy, rx, ry, identity, items, 32);
  }

  // Extract <polyline points="..."> and <polygon points="...">
  const polyRe = /<(polyline|polygon)\b[^>]*?\bpoints\s*=\s*"([^"]*)"/gi;
  let plm;
  while ((plm = polyRe.exec(svgContent)) !== null) {
    const closed = plm[1].toLowerCase() === 'polygon';
    const nums = plm[2].trim().split(/[\s,]+/).map(Number);
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
    for (let i = 0; i < pts.length - 1; i++) {
      items.push({ type: 'line', x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y });
    }
    if (closed && pts.length > 2) {
      const last = pts[pts.length - 1], first = pts[0];
      items.push({ type: 'line', x1: last.x, y1: last.y, x2: first.x, y2: first.y });
    }
  }
}

function _attrNum(attrString, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = attrString.match(re);
  return m ? parseFloat(m[1]) || 0 : 0;
}

// ---------------------------------------------------------------------------
// Public helpers (mirror the DXF import API)
// ---------------------------------------------------------------------------

/**
 * Compute the bounding box of parsed SVG geometry primitives.
 * @param {Array} items - From parseSVGGeometry
 * @returns {{minX, minY, maxX, maxY, width, height, cx, cy}}
 */
export function svgBounds(items) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of items) {
    if (item.type === 'line') {
      minX = Math.min(minX, item.x1, item.x2);
      minY = Math.min(minY, item.y1, item.y2);
      maxX = Math.max(maxX, item.x1, item.x2);
      maxY = Math.max(maxY, item.y1, item.y2);
    } else if (item.type === 'cubicBezier') {
      minX = Math.min(minX, item.x0, item.cp1x, item.cp2x, item.x);
      minY = Math.min(minY, item.y0, item.cp1y, item.cp2y, item.y);
      maxX = Math.max(maxX, item.x0, item.cp1x, item.cp2x, item.x);
      maxY = Math.max(maxY, item.y0, item.cp1y, item.cp2y, item.y);
    } else if (item.type === 'quadBezier') {
      minX = Math.min(minX, item.x0, item.cpx, item.x);
      minY = Math.min(minY, item.y0, item.cpy, item.y);
      maxX = Math.max(maxX, item.x0, item.cpx, item.x);
      maxY = Math.max(maxY, item.y0, item.cpy, item.y);
    }
  }
  const width = maxX - minX;
  const height = maxY - minY;
  return { minX, minY, maxX, maxY, width, height, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/**
 * Apply offset and scale to parsed SVG geometry and add to the sketch scene.
 * @param {Array} items - From parseSVGGeometry
 * @param {object} opts
 * @param {number} opts.offsetX
 * @param {number} opts.offsetY
 * @param {number} opts.scale
 * @param {boolean} opts.centerOnOrigin
 */
export function addSVGToScene(items, { offsetX = 0, offsetY = 0, scale = 1, centerOnOrigin = true } = {}) {
  const bounds = svgBounds(items);
  const shiftX = centerOnOrigin ? -bounds.cx : 0;
  const shiftY = centerOnOrigin ? -bounds.cy : 0;

  let count = 0;
  for (const item of items) {
    if (item.type === 'line') {
      const x1 = (item.x1 + shiftX) * scale + offsetX;
      const y1 = (item.y1 + shiftY) * scale + offsetY;
      const x2 = (item.x2 + shiftX) * scale + offsetX;
      const y2 = (item.y2 + shiftY) * scale + offsetY;
      state.scene.addSegment(x1, y1, x2, y2, { merge: true });
      count++;
    } else if (item.type === 'cubicBezier') {
      const x0 = (item.x0 + shiftX) * scale + offsetX;
      const y0 = (item.y0 + shiftY) * scale + offsetY;
      const cp1x = (item.cp1x + shiftX) * scale + offsetX;
      const cp1y = (item.cp1y + shiftY) * scale + offsetY;
      const cp2x = (item.cp2x + shiftX) * scale + offsetX;
      const cp2y = (item.cp2y + shiftY) * scale + offsetY;
      const x = (item.x + shiftX) * scale + offsetX;
      const y = (item.y + shiftY) * scale + offsetY;
      state.scene.addBezier([
        { x: x0, y: y0, handleOut: { dx: cp1x - x0, dy: cp1y - y0 }, tangent: true },
        { x: x, y: y, handleIn: { dx: cp2x - x, dy: cp2y - y }, tangent: true },
      ], { merge: true });
      count++;
    } else if (item.type === 'quadBezier') {
      const x0 = (item.x0 + shiftX) * scale + offsetX;
      const y0 = (item.y0 + shiftY) * scale + offsetY;
      const cpx = (item.cpx + shiftX) * scale + offsetX;
      const cpy = (item.cpy + shiftY) * scale + offsetY;
      const x = (item.x + shiftX) * scale + offsetX;
      const y = (item.y + shiftY) * scale + offsetY;
      state.scene.addBezier([
        { x: x0, y: y0, handleOut: { dx: cpx - x0, dy: cpy - y0 }, tangent: false },
        { x: x, y: y, tangent: false },
      ], { merge: true });
      count++;
    }
  }

  info('SVG geometry added to sketch', { count, offsetX, offsetY, scale });
  return count;
}

/**
 * Open a file picker for SVG import and return the parsed geometry.
 * @returns {Promise<{items: Array, filename: string}|null>}
 */
export function pickSVGFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.svg';
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const items = parseSVGGeometry(reader.result);
          resolve({ items, filename: file.name });
        } catch (err) {
          error('SVG parse failed', err);
          resolve(null);
        }
      };
      reader.onerror = () => { resolve(null); };
      reader.readAsText(file);
    });
    input.click();
  });
}

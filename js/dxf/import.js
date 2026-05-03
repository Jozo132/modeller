// js/dxf/import.js — DXF parser (supports R12/R2000 ASCII)
import { state } from '../state.js';
import { TextPrimitive, DimensionPrimitive } from '../cad/index.js';
import { info, debug, warn, error } from '../logger.js';

/**
 * Parse a DXF string and add entities to state.
 * @param {string} dxfContent
 */
export function importDXF(dxfContent) {
  info('DXF import started');
  const pairs = parsePairs(dxfContent);
  const entities = extractEntities(pairs);
  debug('DXF parsed', { pairs: pairs.length, entities: entities.length });

  let imported = 0;
  const created = [];
  for (const ent of entities) {
    try {
      const prim = createEntity(ent);
      if (prim) {
        const prims = Array.isArray(prim) ? prim : [prim];
        imported += prims.length;
        created.push(...prims);
      }
    } catch (err) {
      error('Failed to import entity', { type: ent?.type, err });
    }
  }

  // Extract layers
  const layerSection = extractLayers(pairs);
  for (const layer of layerSection) {
    state.addLayer(layer.name, layer.color);
  }
  if (created.length > 0) {
    state.scene.addGroup(created, { name: 'DXF Import', immutable: true });
  }
  info('DXF import completed', { imported, layers: layerSection.length });
}

/**
 * Parse DXF content into group code/value pairs.
 */
function parsePairs(content) {
  const lines = content.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i < lines.length - 1; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    const value = lines[i + 1].trim();
    if (Number.isFinite(code)) {
      pairs.push({ code, value, index: i });
    }
  }
  return pairs;
}

/**
 * Extract entity definitions from the ENTITIES section.
 */
function extractEntities(pairs) {
  let inEntities = false;
  const entities = [];
  let current = null;

  for (const pair of pairs) {
    if (pair.code === 0 && pair.value === 'SECTION') continue;
    if (pair.code === 2 && pair.value === 'ENTITIES') { inEntities = true; continue; }
    if (pair.code === 0 && pair.value === 'ENDSEC' && inEntities) { 
      if (current) entities.push(current);
      current = null;
      inEntities = false; 
      continue; 
    }
    if (!inEntities) continue;

    if (pair.code === 0) {
      if (current) entities.push(current);
      current = { type: pair.value, props: {} };
    } else if (current) {
      const key = pair.code;
      if (current.props[key] !== undefined) {
        // Handle multiple values with same code (e.g., polyline vertices)
        if (!Array.isArray(current.props[key])) {
          current.props[key] = [current.props[key]];
        }
        current.props[key].push(pair.value);
      } else {
        current.props[key] = pair.value;
      }
    }
  }
  if (current) entities.push(current);

  return entities;
}

/**
 * Extract layers from the TABLES section.
 */
function extractLayers(pairs) {
  let inTables = false;
  let inLayerTable = false;
  const layers = [];
  let current = null;

  for (const pair of pairs) {
    if (pair.code === 2 && pair.value === 'TABLES') { inTables = true; continue; }
    if (pair.code === 0 && pair.value === 'ENDSEC' && inTables) { inTables = false; continue; }
    if (!inTables) continue;

    if (pair.code === 2 && pair.value === 'LAYER') { inLayerTable = true; continue; }
    if (pair.code === 0 && pair.value === 'ENDTAB') { 
      if (current) layers.push(current);
      current = null;
      inLayerTable = false; 
      continue; 
    }
    if (!inLayerTable) continue;

    if (pair.code === 0 && pair.value === 'LAYER') {
      if (current) layers.push(current);
      current = { name: '0', color: '#ffffff' };
    } else if (current) {
      if (pair.code === 2) current.name = pair.value;
      if (pair.code === 62) current.color = aciToColor(parseInt(pair.value, 10));
    }
  }
  if (current) layers.push(current);

  return layers;
}

/**
 * Create a primitive from parsed DXF entity data and add to scene.
 */
function createEntity(ent) {
  const p = ent.props;
  const layer = p[8] || '0';

  switch (ent.type) {
    case 'LINE': {
      const seg = state.scene.addSegment(
        parseFloat(p[10]) || 0, parseFloat(p[20]) || 0,
        parseFloat(p[11]) || 0, parseFloat(p[21]) || 0,
        { merge: true, layer }
      );
      return seg;
    }

    case 'CIRCLE': {
      const circ = state.scene.addCircle(
        parseFloat(p[10]) || 0, parseFloat(p[20]) || 0,
        parseFloat(p[40]) || 1,
        { merge: true, layer }
      );
      return circ;
    }

    case 'ARC': {
      const arc = state.scene.addArc(
        parseFloat(p[10]) || 0, parseFloat(p[20]) || 0,
        parseFloat(p[40]) || 1,
        (parseFloat(p[50]) || 0) * Math.PI / 180,
        (parseFloat(p[51]) || 360) * Math.PI / 180,
        { merge: true, layer }
      );
      return arc;
    }

    case 'LWPOLYLINE': {
      const xs = Array.isArray(p[10]) ? p[10] : [p[10]];
      const ys = Array.isArray(p[20]) ? p[20] : [p[20]];
      const points = [];
      for (let i = 0; i < xs.length; i++) {
        points.push({ x: parseFloat(xs[i]) || 0, y: parseFloat(ys[i]) || 0 });
      }
      const closed = (parseInt(p[70], 10) & 1) === 1;
      const count = closed ? points.length : points.length - 1;
      const segments = [];
      for (let i = 0; i < count; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        const seg = state.scene.addSegment(a.x, a.y, b.x, b.y, { merge: true, layer });
        segments.push(seg);
      }
      return segments;
    }

    case 'POLYLINE': {
      // Old-style polyline — skip
      return null;
    }

    case 'SPLINE': {
      // DXF SPLINE entity — import as PSpline (B-spline) or PBezier
      const degree = parseInt(p[71], 10) || 3;
      // Control points (code 10/20 may be arrays)
      const xs = Array.isArray(p[10]) ? p[10] : (p[10] != null ? [p[10]] : []);
      const ys = Array.isArray(p[20]) ? p[20] : (p[20] != null ? [p[20]] : []);
      const controlPts = [];
      for (let i = 0; i < xs.length; i++) {
        controlPts.push({ x: parseFloat(xs[i]) || 0, y: parseFloat(ys[i]) || 0 });
      }
      if (controlPts.length < 2) return null;

      // Check if this is a bezier spline (knot vector = [0,0,...,0,1,1,...,1])
      const knots = Array.isArray(p[40]) ? p[40].map(Number) : (p[40] != null ? [Number(p[40])] : []);
      const isBezierKnots = knots.length > 0 && degree === 3 && controlPts.length === 4 &&
        knots.slice(0, 4).every(k => k === 0) && knots.slice(4).every(k => k === 1);

      if (isBezierKnots && controlPts.length === 4) {
        // Import as bezier — 4 control points means cubic bezier
        const p0 = controlPts[0], c1 = controlPts[1], c2 = controlPts[2], p3 = controlPts[3];
        const bez = state.scene.addBezier([
          { x: p0.x, y: p0.y, handleOut: { dx: c1.x - p0.x, dy: c1.y - p0.y }, tangent: true },
          { x: p3.x, y: p3.y, handleIn: { dx: c2.x - p3.x, dy: c2.y - p3.y }, tangent: true },
        ], { merge: true, layer });
        return bez;
      } else {
        // Import as B-spline
        const spl = state.scene.addSpline(controlPts, { merge: true, layer });
        return spl;
      }
    }

    case 'TEXT': {
      const tp = new TextPrimitive(
        parseFloat(p[10]) || 0, parseFloat(p[20]) || 0,
        p[1] || 'Text',
        parseFloat(p[40]) || 5
      );
      tp.rotation = parseFloat(p[50]) || 0;
      tp.layer = layer;
      state.scene.texts.push(tp);
      return tp;
    }

    default:
      return null;
  }
}

/**
 * Map ACI color index to hex color.
 */
function aciToColor(aci) {
  const map = {
    1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff',
    5: '#0000ff', 6: '#ff00ff', 7: '#ffffff', 8: '#808080',
    9: '#c0c0c0', 30: '#ff8000',
  };
  return map[aci] || '#ffffff';
}

/**
 * Let user pick a file and import it.
 */
export function openDXFFile() {
  const input = document.getElementById('file-input');
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    info('DXF file selected', { name: file.name, size: file.size });
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        state.clearAll();
        importDXF(ev.target.result);
        state.emit('change');
        state.emit('file:loaded');
      } catch (err) {
        error('DXF file import failed', err);
      }
    };
    reader.onerror = () => {
      error('Failed reading DXF file');
    };
    reader.readAsText(file);
    input.value = '';
  };
  input.click();
}

/**
 * Parse a DXF string and return an array of 2D geometry primitives
 * without adding them to state. Used for sketch-mode import.
 *
 * Each returned item has: { type: 'line'|'circle'|'arc'|'spline'|'bezier', ...coords }
 * Lines: { type: 'line', x1, y1, x2, y2 }
 * Circles: { type: 'circle', cx, cy, radius }
 * Arcs: { type: 'arc', cx, cy, radius, startAngle, endAngle }
 * Splines: { type: 'spline', controlPoints: [{x, y}, ...] }
 * Beziers: { type: 'bezier', vertices: [{x, y, handleIn?, handleOut?, tangent?}, ...] }
 *
 * @param {string} dxfContent - Raw DXF file text
 * @returns {Array} Array of geometry primitives
 */
export function parseDXFGeometry(dxfContent) {
  const pairs = parsePairs(dxfContent);
  const entities = extractEntities(pairs);
  const result = [];

  for (const ent of entities) {
    const p = ent.props;
    switch (ent.type) {
      case 'LINE':
        result.push({
          type: 'line',
          x1: parseFloat(p[10]) || 0, y1: parseFloat(p[20]) || 0,
          x2: parseFloat(p[11]) || 0, y2: parseFloat(p[21]) || 0,
        });
        break;
      case 'CIRCLE':
        result.push({
          type: 'circle',
          cx: parseFloat(p[10]) || 0, cy: parseFloat(p[20]) || 0,
          radius: parseFloat(p[40]) || 1,
        });
        break;
      case 'ARC':
        result.push({
          type: 'arc',
          cx: parseFloat(p[10]) || 0, cy: parseFloat(p[20]) || 0,
          radius: parseFloat(p[40]) || 1,
          startAngle: (parseFloat(p[50]) || 0) * Math.PI / 180,
          endAngle: (parseFloat(p[51]) || 360) * Math.PI / 180,
        });
        break;
      case 'LWPOLYLINE': {
        const xs = Array.isArray(p[10]) ? p[10] : [p[10]];
        const ys = Array.isArray(p[20]) ? p[20] : [p[20]];
        const points = [];
        for (let i = 0; i < xs.length; i++) {
          points.push({ x: parseFloat(xs[i]) || 0, y: parseFloat(ys[i]) || 0 });
        }
        const closed = (parseInt(p[70], 10) & 1) === 1;
        const count = closed ? points.length : points.length - 1;
        for (let i = 0; i < count; i++) {
          const a = points[i], b = points[(i + 1) % points.length];
          result.push({ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        }
        break;
      }
      case 'SPLINE': {
        const degree = parseInt(p[71], 10) || 3;
        const xs = Array.isArray(p[10]) ? p[10] : (p[10] != null ? [p[10]] : []);
        const ys = Array.isArray(p[20]) ? p[20] : (p[20] != null ? [p[20]] : []);
        const controlPts = [];
        for (let i = 0; i < xs.length; i++) {
          controlPts.push({ x: parseFloat(xs[i]) || 0, y: parseFloat(ys[i]) || 0 });
        }
        if (controlPts.length < 2) break;

        const knots = Array.isArray(p[40]) ? p[40].map(Number) : (p[40] != null ? [Number(p[40])] : []);
        const isBezierKnots = knots.length > 0 && degree === 3 && controlPts.length === 4 &&
          knots.slice(0, 4).every(k => k === 0) && knots.slice(4).every(k => k === 1);

        if (isBezierKnots && controlPts.length === 4) {
          const p0 = controlPts[0], c1 = controlPts[1], c2 = controlPts[2], p3 = controlPts[3];
          result.push({
            type: 'bezier',
            vertices: [
              { x: p0.x, y: p0.y, handleOut: { dx: c1.x - p0.x, dy: c1.y - p0.y }, tangent: true },
              { x: p3.x, y: p3.y, handleIn: { dx: c2.x - p3.x, dy: c2.y - p3.y }, tangent: true },
            ],
          });
        } else {
          result.push({ type: 'spline', controlPoints: controlPts });
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Compute the bounding box of parsed DXF geometry primitives.
 * @param {Array} items - From parseDXFGeometry
 * @returns {{minX, minY, maxX, maxY, width, height, cx, cy}}
 */
export function dxfBounds(items) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of items) {
    if (item.type === 'line') {
      minX = Math.min(minX, item.x1, item.x2);
      minY = Math.min(minY, item.y1, item.y2);
      maxX = Math.max(maxX, item.x1, item.x2);
      maxY = Math.max(maxY, item.y1, item.y2);
    } else if (item.type === 'circle') {
      minX = Math.min(minX, item.cx - item.radius);
      minY = Math.min(minY, item.cy - item.radius);
      maxX = Math.max(maxX, item.cx + item.radius);
      maxY = Math.max(maxY, item.cy + item.radius);
    } else if (item.type === 'arc') {
      minX = Math.min(minX, item.cx - item.radius);
      minY = Math.min(minY, item.cy - item.radius);
      maxX = Math.max(maxX, item.cx + item.radius);
      maxY = Math.max(maxY, item.cy + item.radius);
    } else if (item.type === 'spline') {
      for (const pt of item.controlPoints) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
    } else if (item.type === 'bezier') {
      for (const v of item.vertices) {
        minX = Math.min(minX, v.x);
        minY = Math.min(minY, v.y);
        maxX = Math.max(maxX, v.x);
        maxY = Math.max(maxY, v.y);
      }
    }
  }
  const width = maxX - minX;
  const height = maxY - minY;
  return { minX, minY, maxX, maxY, width, height, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/**
 * Apply offset and scale to parsed DXF geometry and add to the sketch scene.
 * @param {Array} items - From parseDXFGeometry
 * @param {object} opts
 * @param {number} opts.offsetX - X offset (reference point in sketch coordinates)
 * @param {number} opts.offsetY - Y offset
 * @param {number} opts.scale - Uniform scale factor (default 1)
 * @param {boolean} opts.centerOnOrigin - If true, center the DXF at offset point
 */
export function addDXFToScene(items, { offsetX = 0, offsetY = 0, scale = 1, centerOnOrigin = true } = {}) {
  const bounds = dxfBounds(items);
  // If centering, shift so the DXF center lands on the offset point
  const shiftX = centerOnOrigin ? -bounds.cx : 0;
  const shiftY = centerOnOrigin ? -bounds.cy : 0;

  let count = 0;
  const created = [];
  for (const item of items) {
    if (item.type === 'line') {
      const x1 = (item.x1 + shiftX) * scale + offsetX;
      const y1 = (item.y1 + shiftY) * scale + offsetY;
      const x2 = (item.x2 + shiftX) * scale + offsetX;
      const y2 = (item.y2 + shiftY) * scale + offsetY;
      created.push(state.scene.addSegment(x1, y1, x2, y2, { merge: true }));
      count++;
    } else if (item.type === 'circle') {
      const cx = (item.cx + shiftX) * scale + offsetX;
      const cy = (item.cy + shiftY) * scale + offsetY;
      created.push(state.scene.addCircle(cx, cy, item.radius * scale, { merge: true }));
      count++;
    } else if (item.type === 'arc') {
      const cx = (item.cx + shiftX) * scale + offsetX;
      const cy = (item.cy + shiftY) * scale + offsetY;
      created.push(state.scene.addArc(cx, cy, item.radius * scale, item.startAngle, item.endAngle, { merge: true }));
      count++;
    } else if (item.type === 'spline') {
      const pts = item.controlPoints.map(pt => ({
        x: (pt.x + shiftX) * scale + offsetX,
        y: (pt.y + shiftY) * scale + offsetY,
      }));
      created.push(state.scene.addSpline(pts, { merge: true }));
      count++;
    } else if (item.type === 'bezier') {
      const verts = item.vertices.map(v => ({
        x: (v.x + shiftX) * scale + offsetX,
        y: (v.y + shiftY) * scale + offsetY,
        handleIn: v.handleIn ? { dx: v.handleIn.dx * scale, dy: v.handleIn.dy * scale } : null,
        handleOut: v.handleOut ? { dx: v.handleOut.dx * scale, dy: v.handleOut.dy * scale } : null,
        tangent: v.tangent,
      }));
      created.push(state.scene.addBezier(verts, { merge: true }));
      count++;
    }
  }
  if (created.length > 0) {
    const group = state.scene.addGroup(created, { name: 'DXF Import', immutable: true });
    state.clearSelection();
    state.select(group);
  }

  info('DXF geometry added to sketch', { count, offsetX, offsetY, scale });
  return count;
}

/**
 * Open a file picker for DXF import and return the parsed geometry (no state mutation).
 * @returns {Promise<{items: Array, filename: string}|null>}
 */
export function pickDXFFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.dxf';
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const items = parseDXFGeometry(reader.result);
          resolve({ items, filename: file.name });
        } catch (err) {
          error('DXF parse failed', err);
          resolve(null);
        }
      };
      reader.onerror = () => { resolve(null); };
      reader.readAsText(file);
    });
    input.click();
  });
}

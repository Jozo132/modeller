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
  for (const ent of entities) {
    try {
      const prim = createEntity(ent);
      if (prim) {
        imported += 1;
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
      let firstSeg = null;
      for (let i = 0; i < count; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        const seg = state.scene.addSegment(a.x, a.y, b.x, b.y, { merge: true, layer });
        if (!firstSeg) firstSeg = seg;
      }
      return firstSeg;
    }

    case 'POLYLINE': {
      // Old-style polyline — skip
      return null;
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

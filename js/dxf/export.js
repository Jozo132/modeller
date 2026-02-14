// js/dxf/export.js — DXF R12/R2000 writer
import { state } from '../state.js';
import { info, debug, error } from '../logger.js';

/**
 * Export current drawing to DXF string.
 * Produces an ASCII DXF compatible with AutoCAD R2000.
 */
export function exportDXF() {
  info('DXF export started', { entities: state.entities.length, layers: state.layers.length });
  const lines = [];
  const w = (code, value) => { lines.push(String(code)); lines.push(String(value)); };

  // --- HEADER ---
  w(0, 'SECTION');
  w(2, 'HEADER');
  w(9, '$ACADVER'); w(1, 'AC1015');
  w(9, '$INSUNITS'); w(70, 4); // millimeters
  w(0, 'ENDSEC');

  // --- TABLES ---
  w(0, 'SECTION');
  w(2, 'TABLES');

  // Layer table
  w(0, 'TABLE');
  w(2, 'LAYER');
  w(70, state.layers.length);
  for (const layer of state.layers) {
    w(0, 'LAYER');
    w(2, layer.name);
    w(70, layer.visible ? 0 : 1);
    w(62, colorToAci(layer.color));
    w(6, 'CONTINUOUS');
  }
  w(0, 'ENDTAB');

  // Linetype table
  w(0, 'TABLE');
  w(2, 'LTYPE');
  w(70, 1);
  w(0, 'LTYPE');
  w(2, 'CONTINUOUS');
  w(70, 0);
  w(3, 'Solid line');
  w(72, 65);
  w(73, 0);
  w(40, 0.0);
  w(0, 'ENDTAB');

  w(0, 'ENDSEC');

  // --- ENTITIES ---
  w(0, 'SECTION');
  w(2, 'ENTITIES');

  for (const entity of state.entities) {
    try {
      writeEntity(w, entity);
    } catch (err) {
      error('Failed to export entity', { type: entity?.type, id: entity?.id, err });
    }
  }

  w(0, 'ENDSEC');
  w(0, 'EOF');

  const out = lines.join('\r\n');
  debug('DXF export complete', { bytes: out.length });
  return out;
}

function writeEntity(w, entity) {
  switch (entity.type) {
    // --- Primitive types ---
    case 'segment':
      w(0, 'LINE');
      w(8, entity.layer);
      if (entity.color) w(62, colorToAci(entity.color));
      w(10, entity.x1); w(20, entity.y1); w(30, 0);
      w(11, entity.x2); w(21, entity.y2); w(31, 0);
      break;

    case 'circle':
      w(0, 'CIRCLE');
      w(8, entity.layer);
      if (entity.color) w(62, colorToAci(entity.color));
      w(10, entity.cx); w(20, entity.cy); w(30, 0);
      w(40, entity.radius);
      break;

    case 'arc':
      w(0, 'ARC');
      w(8, entity.layer);
      if (entity.color) w(62, colorToAci(entity.color));
      w(10, entity.cx); w(20, entity.cy); w(30, 0);
      w(40, entity.radius);
      w(50, entity.startAngle * 180 / Math.PI);
      w(51, entity.endAngle * 180 / Math.PI);
      break;

    case 'text':
      w(0, 'TEXT');
      w(8, entity.layer);
      if (entity.color) w(62, colorToAci(entity.color));
      w(10, entity.x); w(20, entity.y); w(30, 0);
      w(40, entity.height);
      w(1, entity.text);
      if (entity.rotation) w(50, entity.rotation);
      break;

    case 'dimension': {
      // Export as two lines + text (simplified for compatibility)
      w(0, 'LINE');
      w(8, entity.layer);
      w(10, entity.x1); w(20, entity.y1); w(30, 0);
      w(11, entity.x2); w(21, entity.y2); w(31, 0);
      const mx = (entity.x1 + entity.x2) / 2;
      const my = (entity.y1 + entity.y2) / 2;
      w(0, 'TEXT');
      w(8, entity.layer);
      w(10, mx); w(20, my + entity.offset); w(30, 0);
      w(40, 3);
      w(1, entity.displayLabel);
      break;
    }

    // --- Legacy entity types (for backward compat) ---
    case 'LINE':
      w(0, 'LINE');
      w(8, entity.layer);
      if (entity.color) w(62, colorToAci(entity.color));
      w(10, entity.x1); w(20, entity.y1); w(30, 0);
      w(11, entity.x2); w(21, entity.y2); w(31, 0);
      break;

    case 'LWPOLYLINE': {
      const pts = entity.points || entity.vertices;
      if (!pts || pts.length === 0) break;
      w(0, 'LWPOLYLINE');
      w(8, entity.layer);
      if (entity.color) w(62, colorToAci(entity.color));
      w(90, pts.length);
      w(70, entity.closed ? 1 : 0);
      for (const p of pts) {
        w(10, p.x); w(20, p.y);
      }
      break;
    }

    case 'TEXT':
      w(0, 'TEXT');
      w(8, entity.layer);
      if (entity.color) w(62, colorToAci(entity.color));
      w(10, entity.x); w(20, entity.y); w(30, 0);
      w(40, entity.height);
      w(1, entity.text);
      if (entity.rotation) w(50, entity.rotation);
      break;

    case 'DIMENSION':
      // Export as two lines + text (simplified for compatbility)
      w(0, 'LINE');
      w(8, entity.layer);
      w(10, entity.x1); w(20, entity.y1); w(30, 0);
      w(11, entity.x2); w(21, entity.y2); w(31, 0);
      // Add the dimension text
      const mx = (entity.x1 + entity.x2) / 2;
      const my = (entity.y1 + entity.y2) / 2;
      const len = Math.hypot(entity.x2 - entity.x1, entity.y2 - entity.y1);
      w(0, 'TEXT');
      w(8, entity.layer);
      w(10, mx); w(20, my + entity.offset); w(30, 0);
      w(40, 3);
      w(1, len.toFixed(2));
      break;
  }
}

/**
 * Map hex color to nearest ACI color index (simplified).
 */
function colorToAci(hex) {
  if (!hex) return 7; // white
  const map = {
    '#ffffff': 7, '#ff0000': 1, '#ffff00': 2, '#00ff00': 3,
    '#00ffff': 4, '#0000ff': 5, '#ff00ff': 6, '#808080': 8,
    '#c0c0c0': 9, '#ff8000': 30,
  };
  return map[hex.toLowerCase()] || 7;
}

/**
 * Trigger browser download of DXF file.
 */
export function downloadDXF(filename = 'drawing.dxf') {
  try {
    const content = exportDXF();
    const blob = new Blob([content], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    info('DXF download triggered', { filename });
  } catch (err) {
    error('DXF download failed', err);
  }
}

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
    if (entity.construction) continue; // construction geometry is not exported
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

    case 'spline': {
      // DXF SPLINE entity: export as cubic B-spline with clamped uniform knots
      const pts = entity.points;
      if (!pts || pts.length < 2) break;
      const n = pts.length;
      const degree = Math.min(3, n - 1);
      const knotCount = n + degree + 1;
      w(0, 'SPLINE');
      w(8, entity.layer);
      if (entity.color) w(62, colorToAci(entity.color));
      w(70, 8);      // flag: planar
      w(71, degree);  // degree
      w(72, knotCount); // number of knots
      w(73, n);       // number of control points
      // Knot vector (clamped uniform)
      for (let i = 0; i < knotCount; i++) {
        let kv;
        if (i <= degree) kv = 0;
        else if (i >= knotCount - degree - 1) kv = 1;
        else kv = (i - degree) / (n - degree);
        w(40, kv);
      }
      // Control points
      for (const cp of pts) {
        w(10, cp.x); w(20, cp.y); w(30, 0);
      }
      break;
    }

    case 'bezier': {
      // DXF doesn't have a native bezier entity; export each segment as a SPLINE
      // by converting bezier control points into cubic SPLINE control points.
      for (let si = 0; si < entity.segmentCount; si++) {
        const v0 = entity.vertices[si];
        const v1 = entity.vertices[si + 1];
        const p0 = v0.point, p3 = v1.point;
        const ho = v0.handleOut;
        const hi = v1.handleIn;
        if (ho && hi) {
          // Full cubic: 4 control points
          const c1x = p0.x + ho.dx, c1y = p0.y + ho.dy;
          const c2x = p3.x + hi.dx, c2y = p3.y + hi.dy;
          w(0, 'SPLINE');
          w(8, entity.layer);
          if (entity.color) w(62, colorToAci(entity.color));
          w(70, 8); w(71, 3); w(72, 8); w(73, 4);
          // Bezier knot vector: [0,0,0,0,1,1,1,1]
          w(40, 0); w(40, 0); w(40, 0); w(40, 0);
          w(40, 1); w(40, 1); w(40, 1); w(40, 1);
          w(10, p0.x); w(20, p0.y); w(30, 0);
          w(10, c1x); w(20, c1y); w(30, 0);
          w(10, c2x); w(20, c2y); w(30, 0);
          w(10, p3.x); w(20, p3.y); w(30, 0);
        } else {
          // Linear fallback — export as LINE
          w(0, 'LINE');
          w(8, entity.layer);
          if (entity.color) w(62, colorToAci(entity.color));
          w(10, p0.x); w(20, p0.y); w(30, 0);
          w(11, p3.x); w(21, p3.y); w(31, 0);
        }
      }
      break;
    }
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

/**
 * Build a plane definition from a face normal and origin point.
 * Returns {origin, normal, xAxis, yAxis} for projecting 3D points onto 2D.
 */
function buildProjectionPlane(normal, origin) {
  let ref = { x: 0, y: 0, z: 1 };
  const dot = Math.abs(normal.x * ref.x + normal.y * ref.y + normal.z * ref.z);
  if (dot > 0.9) ref = { x: 1, y: 0, z: 0 };

  const xAxis = {
    x: ref.y * normal.z - ref.z * normal.y,
    y: ref.z * normal.x - ref.x * normal.z,
    z: ref.x * normal.y - ref.y * normal.x,
  };
  const xLen = Math.sqrt(xAxis.x ** 2 + xAxis.y ** 2 + xAxis.z ** 2);
  if (xLen < 1e-10) return null;
  xAxis.x /= xLen; xAxis.y /= xLen; xAxis.z /= xLen;

  const yAxis = {
    x: normal.y * xAxis.z - normal.z * xAxis.y,
    y: normal.z * xAxis.x - normal.x * xAxis.z,
    z: normal.x * xAxis.y - normal.y * xAxis.x,
  };
  const yLen = Math.sqrt(yAxis.x ** 2 + yAxis.y ** 2 + yAxis.z ** 2);
  if (yLen < 1e-10) return null;
  yAxis.x /= yLen; yAxis.y /= yLen; yAxis.z /= yLen;

  return { origin, normal, xAxis, yAxis };
}

/**
 * Project a 3D point onto a 2D plane coordinate system.
 */
function projectTo2D(pt, plane) {
  const dx = pt.x - plane.origin.x;
  const dy = pt.y - plane.origin.y;
  const dz = pt.z - plane.origin.z;
  return {
    x: dx * plane.xAxis.x + dy * plane.xAxis.y + dz * plane.xAxis.z,
    y: dx * plane.yAxis.x + dy * plane.yAxis.y + dz * plane.yAxis.z,
  };
}

/**
 * Round a coordinate value for edge deduplication (snap to grid).
 */
function snapCoord(v, precision = 6) {
  return parseFloat(v.toFixed(precision));
}

/**
 * Build a canonical key for a line segment (order-independent).
 */
function edgeKey(x1, y1, x2, y2, precision = 6) {
  const a = `${snapCoord(x1, precision)},${snapCoord(y1, precision)}`;
  const b = `${snapCoord(x2, precision)},${snapCoord(y2, precision)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Project selected 3D faces onto a 2D plane and return the unique edge segments.
 * Useful for preview rendering without generating a full DXF string.
 *
 * @param {Array} faces - Array of face metadata objects (from renderer._meshFaces)
 * @param {Object} [planeOverride] - Optional {origin, normal, xAxis, yAxis}
 * @returns {{edges: Array<{x1,y1,x2,y2}>, bounds: {minX,minY,maxX,maxY,width,height}}|null}
 */
export function projectFacesToEdges(faces, planeOverride) {
  if (!faces || faces.length === 0) return null;
  const refFace = faces[0];
  const plane = planeOverride || (() => {
    const verts = refFace.vertices || [];
    let ox = 0, oy = 0, oz = 0;
    for (const v of verts) { ox += v.x; oy += v.y; oz += v.z; }
    if (verts.length > 0) { ox /= verts.length; oy /= verts.length; oz /= verts.length; }
    return buildProjectionPlane(refFace.normal, { x: ox, y: oy, z: oz });
  })();
  if (!plane) return null;
  const edgeSet = new Map();
  for (const face of faces) {
    const verts = face.vertices || [];
    if (verts.length < 2) continue;
    const pts2d = verts.map(v => projectTo2D(v, plane));
    for (let i = 0; i < pts2d.length; i++) {
      const a = pts2d[i];
      const b = pts2d[(i + 1) % pts2d.length];
      const key = edgeKey(a.x, a.y, b.x, b.y);
      if (!edgeSet.has(key)) edgeSet.set(key, { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  }
  const edges = [...edgeSet.values()];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of edges) {
    minX = Math.min(minX, e.x1, e.x2); minY = Math.min(minY, e.y1, e.y2);
    maxX = Math.max(maxX, e.x1, e.x2); maxY = Math.max(maxY, e.y1, e.y2);
  }
  return { edges, bounds: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY } };
}

/**
 * Export selected 3D faces as a projected 2D DXF.
 *
 * Projects each selected face's edges onto the first face's orthographic plane,
 * fusing duplicate edges to produce clean line output.
 *
 * @param {Array} faces - Array of face metadata objects (from renderer._meshFaces)
 * @param {Object} [planeOverride] - Optional {origin, normal, xAxis, yAxis}; if omitted,
 *   uses the first face's normal and centroid as the projection plane.
 * @returns {string} DXF content string
 */
export function exportFacesDXF(faces, planeOverride) {
  if (!faces || faces.length === 0) {
    error('exportFacesDXF: no faces provided');
    return '';
  }
  info('DXF face export started', { faceCount: faces.length });

  // Build projection plane from first face
  const refFace = faces[0];
  const plane = planeOverride || (() => {
    const verts = refFace.vertices || [];
    // Compute centroid as origin
    let ox = 0, oy = 0, oz = 0;
    for (const v of verts) { ox += v.x; oy += v.y; oz += v.z; }
    if (verts.length > 0) { ox /= verts.length; oy /= verts.length; oz /= verts.length; }
    return buildProjectionPlane(refFace.normal, { x: ox, y: oy, z: oz });
  })();

  if (!plane) {
    error('exportFacesDXF: failed to build projection plane');
    return '';
  }

  // Collect unique projected line segments from each face
  const edgeSet = new Map(); // key → {x1, y1, x2, y2}

  for (const face of faces) {
    const verts = face.vertices || [];
    if (verts.length < 2) continue;

    // Project each vertex to 2D
    const pts2d = verts.map(v => projectTo2D(v, plane));

    // Walk the boundary edges of this face polygon
    for (let i = 0; i < pts2d.length; i++) {
      const a = pts2d[i];
      const b = pts2d[(i + 1) % pts2d.length];
      const key = edgeKey(a.x, a.y, b.x, b.y);
      if (!edgeSet.has(key)) {
        edgeSet.set(key, { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
    }
  }

  info('DXF face export: projected edges', { unique: edgeSet.size });

  // Build DXF string
  const lines = [];
  const w = (code, value) => { lines.push(String(code)); lines.push(String(value)); };

  // Header
  w(0, 'SECTION'); w(2, 'HEADER');
  w(9, '$ACADVER'); w(1, 'AC1015');
  w(9, '$INSUNITS'); w(70, 4);
  w(0, 'ENDSEC');

  // Tables (minimal)
  w(0, 'SECTION'); w(2, 'TABLES');
  w(0, 'TABLE'); w(2, 'LAYER'); w(70, 1);
  w(0, 'LAYER'); w(2, '0'); w(70, 0); w(62, 7); w(6, 'CONTINUOUS');
  w(0, 'ENDTAB');
  w(0, 'TABLE'); w(2, 'LTYPE'); w(70, 1);
  w(0, 'LTYPE'); w(2, 'CONTINUOUS'); w(70, 0); w(3, 'Solid line'); w(72, 65); w(73, 0); w(40, 0.0);
  w(0, 'ENDTAB');
  w(0, 'ENDSEC');

  // Entities
  w(0, 'SECTION'); w(2, 'ENTITIES');
  for (const seg of edgeSet.values()) {
    w(0, 'LINE');
    w(8, '0');
    w(10, seg.x1); w(20, seg.y1); w(30, 0);
    w(11, seg.x2); w(21, seg.y2); w(31, 0);
  }
  w(0, 'ENDSEC');
  w(0, 'EOF');

  const out = lines.join('\r\n');
  debug('DXF face export complete', { bytes: out.length, edges: edgeSet.size });
  return out;
}

/**
 * Download a DXF from projected 3D faces.
 * @param {Array} faces - Face metadata array
 * @param {Object} [planeOverride] - Optional plane definition
 * @param {string} [filename='faces.dxf']
 */
export function downloadFacesDXF(faces, planeOverride, filename = 'faces.dxf') {
  try {
    const content = exportFacesDXF(faces, planeOverride);
    if (!content) { error('DXF face export produced empty output'); return; }
    const blob = new Blob([content], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    info('DXF face download triggered', { filename });
  } catch (err) {
    error('DXF face download failed', err);
  }
}

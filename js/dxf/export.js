// js/dxf/export.js — DXF R12/R2000 writer
import { state } from '../state.js';
import { NurbsCurve } from '../cad/NurbsCurve.js';
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
      const pts = entity.points;
      if (!pts || pts.length < 2 || typeof entity._knotVector !== 'function') break;
      const { knots, degree } = entity._knotVector();
      writeDxfSpline(w, {
        degree,
        knots,
        controlPoints: pts.map((cp) => ({ x: cp.x, y: cp.y, z: 0 })),
        weights: pts.map(() => 1),
      }, entity.layer, entity.color);
      break;
    }

    case 'bezier': {
      // DXF doesn't have a native bezier entity; export each span as an exact
      // clamped SPLINE rather than collapsing quadratic spans to lines.
      for (let si = 0; si < entity.segmentCount; si++) {
        const v0 = entity.vertices[si];
        const v1 = entity.vertices[si + 1];
        const p0 = v0.point, p3 = v1.point;
        const ho = v0.handleOut;
        const hi = v1.handleIn;
        if (ho && hi) {
          const c1x = p0.x + ho.dx, c1y = p0.y + ho.dy;
          const c2x = p3.x + hi.dx, c2y = p3.y + hi.dy;
          writeDxfSpline(w, {
            degree: 3,
            knots: [0, 0, 0, 0, 1, 1, 1, 1],
            controlPoints: [
              { x: p0.x, y: p0.y, z: 0 },
              { x: c1x, y: c1y, z: 0 },
              { x: c2x, y: c2y, z: 0 },
              { x: p3.x, y: p3.y, z: 0 },
            ],
            weights: [1, 1, 1, 1],
          }, entity.layer, entity.color);
        } else if (ho || hi) {
          const cx = ho ? p0.x + ho.dx : p3.x + hi.dx;
          const cy = ho ? p0.y + ho.dy : p3.y + hi.dy;
          writeDxfSpline(w, {
            degree: 2,
            knots: [0, 0, 0, 1, 1, 1],
            controlPoints: [
              { x: p0.x, y: p0.y, z: 0 },
              { x: cx, y: cy, z: 0 },
              { x: p3.x, y: p3.y, z: 0 },
            ],
            weights: [1, 1, 1],
          }, entity.layer, entity.color);
        } else {
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

function writeDxfSpline(w, spline, layer = '0', color = null) {
  const degree = spline?.degree;
  const knots = spline?.knots || [];
  const controlPoints = spline?.controlPoints || [];
  const weights = spline?.weights || controlPoints.map(() => 1);
  if (!Number.isFinite(degree) || degree < 1 || controlPoints.length < degree + 1 || knots.length !== controlPoints.length + degree + 1) {
    return;
  }
  const rational = weights.some((weight) => Math.abs((weight ?? 1) - 1) > 1e-9);
  w(0, 'SPLINE');
  w(8, layer);
  if (color) w(62, colorToAci(color));
  w(70, 8 | (rational ? 4 : 0));
  w(71, degree);
  w(72, knots.length);
  w(73, controlPoints.length);
  w(74, 0);
  for (const knot of knots) w(40, knot);
  if (rational) {
    for (const weight of weights) w(41, weight ?? 1);
  }
  for (const cp of controlPoints) {
    w(10, cp.x); w(20, cp.y); w(30, cp.z ?? 0);
  }
}

function writeDxfPolyline(w, polyline, layer = '0', color = null) {
  const points = polyline?.points || [];
  if (points.length < 2) return;
  w(0, 'LWPOLYLINE');
  w(8, layer);
  if (color) w(62, colorToAci(color));
  w(90, points.length);
  w(70, polyline.closed ? 1 : 0);
  for (const point of points) {
    w(10, point.x);
    w(20, point.y);
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
export function projectFacesToEdges(faces, planeOverride, options = {}) {
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
  const exactProjection = options.topoBody
    ? buildProjectedBoundaryEntities(faces, options.topoBody, plane)
    : null;
  if (exactProjection) return exactProjection;
  if (options.topoBody) return null;

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
  const bounds = boundsFromSegments(edges);
  return { edges, curves: edges.map((edge) => ({ type: 'line', ...edge })), bounds };
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
export function exportFacesDXF(faces, planeOverride, options = {}) {
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

  const projected = options.topoBody
    ? buildProjectedBoundaryEntities(faces, options.topoBody, plane)
    : null;
  if (!projected || !projected.curves || projected.curves.length === 0) {
    error('exportFacesDXF: exact boundary projection unavailable');
    return '';
  }

  info('DXF face export: projected curves', { curves: projected.curves.length, sampledEdges: projected.edges.length });

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
  for (const entity of projected.curves) {
    if (entity.type === 'line') {
      w(0, 'LINE');
      w(8, '0');
      w(10, entity.x1); w(20, entity.y1); w(30, 0);
      w(11, entity.x2); w(21, entity.y2); w(31, 0);
    } else if (entity.type === 'circle') {
      w(0, 'CIRCLE');
      w(8, '0');
      w(10, entity.cx); w(20, entity.cy); w(30, 0);
      w(40, entity.radius);
    } else if (entity.type === 'arc') {
      w(0, 'ARC');
      w(8, '0');
      w(10, entity.cx); w(20, entity.cy); w(30, 0);
      w(40, entity.radius);
      w(50, normalizeAngleRadians(entity.startAngle) * 180 / Math.PI);
      w(51, normalizeAngleRadians(entity.endAngle) * 180 / Math.PI);
    } else if (entity.type === 'polyline') {
      writeDxfPolyline(w, entity, '0', null);
    } else if (entity.type === 'spline') {
      writeDxfSpline(w, entity, '0', null);
    }
  }
  w(0, 'ENDSEC');
  w(0, 'EOF');

  const out = lines.join('\r\n');
  debug('DXF face export complete', { bytes: out.length, curves: projected.curves.length, previewEdges: projected.edges.length });
  return out;
}

/**
 * Download a DXF from projected 3D faces.
 * @param {Array} faces - Face metadata array
 * @param {Object} [planeOverride] - Optional plane definition
 * @param {string} [filename='faces.dxf']
 */
export function downloadFacesDXF(faces, planeOverride, filename = 'faces.dxf', options = {}) {
  try {
    const content = exportFacesDXF(faces, planeOverride, options);
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

function buildProjectedBoundaryEntities(meshFaces, topoBody, plane) {
  const topoFaces = collectSelectedTopoFaces(meshFaces, topoBody);
  if (topoFaces.length === 0) return null;

  const selectedFaceIds = new Set(topoFaces.map((face) => face.id));
  const edgeUseCount = new Map();
  for (const face of topoFaces) {
    for (const loop of face.allLoops()) {
      for (const coedge of loop.coedges) {
        edgeUseCount.set(coedge.edge.id, (edgeUseCount.get(coedge.edge.id) || 0) + 1);
      }
    }
  }

  const curves = [];
  for (const face of topoFaces) {
    for (const loop of face.allLoops()) {
      for (const coedge of loop.coedges) {
        if (edgeUseCount.get(coedge.edge.id) !== 1) continue;
        const curve = orientedCoedgeCurve(coedge);
        const projected = projectCurveEntity(curve, plane);
        if (projected) curves.push(projected);
      }
    }
  }
  if (curves.length === 0) return null;
  return summarizeProjectedCurves(curves);
}

function collectSelectedTopoFaces(meshFaces, topoBody) {
  if (!topoBody || typeof topoBody.faces !== 'function') return [];
  const faceById = new Map(topoBody.faces().map((face) => [face.id, face]));
  const topoFaceIds = new Set();
  for (const meshFace of meshFaces || []) {
    if (meshFace?.topoFaceId != null) topoFaceIds.add(meshFace.topoFaceId);
  }
  const faces = [];
  for (const topoFaceId of topoFaceIds) {
    const face = faceById.get(topoFaceId);
    if (face) faces.push(face);
  }
  return faces;
}

function orientedCoedgeCurve(coedge) {
  const curve = coedge?.edge?.curve;
  if (curve) {
    return coedge.sameSense === false && typeof curve.reversed === 'function'
      ? curve.reversed()
      : curve.clone ? curve.clone() : curve;
  }
  const start = coedge?.startVertex?.()?.point;
  const end = coedge?.endVertex?.()?.point;
  return start && end ? NurbsCurve.createLine(start, end) : null;
}

function projectCurveEntity(curve, plane) {
  if (!curve || !Array.isArray(curve.controlPoints) || curve.controlPoints.length < 2) return null;
  const circular = tryProjectCircularEntity(curve, plane);
  if (circular) return circular;

  const controlPoints = curve.controlPoints.map((point) => {
    const projected = projectTo2D(point, plane);
    return { x: projected.x, y: projected.y, z: 0 };
  });
  if (curve.degree === 1 && controlPoints.length === 2) {
    return {
      type: 'line',
      x1: controlPoints[0].x,
      y1: controlPoints[0].y,
      x2: controlPoints[1].x,
      y2: controlPoints[1].y,
    };
  }
  if (curve.degree === 1) {
    return {
      type: 'polyline',
      points: controlPoints.map(({ x, y }) => ({ x, y })),
      closed: false,
    };
  }
  return {
    type: 'spline',
    degree: curve.degree,
    controlPoints,
    knots: [...curve.knots],
    weights: [...(curve.weights || controlPoints.map(() => 1))],
  };
}

function tryProjectCircularEntity(curve, plane) {
  const weights = Array.isArray(curve?.weights) ? curve.weights : [];
  const hasRationalWeights = weights.some((weight) => Math.abs((weight ?? 1) - 1) > 1e-9);
  if (curve?.degree !== 2 || !hasRationalWeights || typeof curve.evaluate !== 'function') return null;

  const uMin = Number(curve.uMin);
  const uMax = Number(curve.uMax);
  const domain = uMax - uMin;
  if (!Number.isFinite(domain) || domain <= 1e-9) return null;

  const startPoint = projectTo2D(curve.evaluate(uMin), plane);
  const endPoint = projectTo2D(curve.evaluate(uMax), plane);
  const closed = Math.hypot(startPoint.x - endPoint.x, startPoint.y - endPoint.y) <= 1e-6;

  const seedParams = closed
    ? [uMin, uMin + domain / 3, uMin + (2 * domain) / 3]
    : [uMin, uMin + domain / 2, uMax];
  const seedPoints = seedParams.map((u) => projectTo2D(curve.evaluate(u), plane));
  const circle = circleFromThreePoints2D(seedPoints[0], seedPoints[1], seedPoints[2]);
  if (!circle || !Number.isFinite(circle.radius) || circle.radius <= 1e-9) return null;

  const validationSamples = closed ? 12 : 9;
  const radiusTolerance = Math.max(1e-6, circle.radius * 1e-5);
  for (let index = 0; index <= validationSamples; index++) {
    const u = uMin + (domain * index) / validationSamples;
    const point = projectTo2D(curve.evaluate(u), plane);
    const radius = Math.hypot(point.x - circle.cx, point.y - circle.cy);
    if (Math.abs(radius - circle.radius) > radiusTolerance) return null;
  }

  if (closed) {
    return {
      type: 'circle',
      cx: circle.cx,
      cy: circle.cy,
      radius: circle.radius,
    };
  }

  const startAngle = normalizeAngleRadians(Math.atan2(startPoint.y - circle.cy, startPoint.x - circle.cx));
  const endAngle = normalizeAngleRadians(Math.atan2(endPoint.y - circle.cy, endPoint.x - circle.cx));
  const midPoint = projectTo2D(curve.evaluate(uMin + domain / 2), plane);
  const midAngle = normalizeAngleRadians(Math.atan2(midPoint.y - circle.cy, midPoint.x - circle.cx));

  if (angleOnCounterClockwiseArc(startAngle, endAngle, midAngle)) {
    return { type: 'arc', cx: circle.cx, cy: circle.cy, radius: circle.radius, startAngle, endAngle };
  }
  if (angleOnCounterClockwiseArc(endAngle, startAngle, midAngle)) {
    return { type: 'arc', cx: circle.cx, cy: circle.cy, radius: circle.radius, startAngle: endAngle, endAngle: startAngle };
  }
  return null;
}

function circleFromThreePoints2D(first, second, third) {
  const ax = first.x;
  const ay = first.y;
  const bx = second.x;
  const by = second.y;
  const cx = third.x;
  const cy = third.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) <= 1e-12) return null;

  const ax2ay2 = ax * ax + ay * ay;
  const bx2by2 = bx * bx + by * by;
  const cx2cy2 = cx * cx + cy * cy;
  const centerX = (ax2ay2 * (by - cy) + bx2by2 * (cy - ay) + cx2cy2 * (ay - by)) / d;
  const centerY = (ax2ay2 * (cx - bx) + bx2by2 * (ax - cx) + cx2cy2 * (bx - ax)) / d;
  return {
    cx: centerX,
    cy: centerY,
    radius: Math.hypot(ax - centerX, ay - centerY),
  };
}

function normalizeAngleRadians(angle) {
  const fullTurn = Math.PI * 2;
  let normalized = angle % fullTurn;
  if (normalized < 0) normalized += fullTurn;
  return normalized;
}

function angleOnCounterClockwiseArc(startAngle, endAngle, probeAngle, tolerance = 1e-8) {
  const fullTurn = Math.PI * 2;
  const start = normalizeAngleRadians(startAngle);
  const end = normalizeAngleRadians(endAngle);
  const probe = normalizeAngleRadians(probeAngle);
  const span = (end - start + fullTurn) % fullTurn;
  const probeOffset = (probe - start + fullTurn) % fullTurn;
  return probeOffset >= -tolerance && probeOffset <= span + tolerance;
}

function summarizeProjectedCurves(curves) {
  const edges = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const curve of curves) {
    const points = sampleProjectedCurve(curve);
    if (points.length === 0) continue;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    for (let i = 1; i < points.length; i++) {
      edges.push({
        x1: points[i - 1].x,
        y1: points[i - 1].y,
        x2: points[i].x,
        y2: points[i].y,
      });
    }
  }

  return {
    curves,
    edges,
    bounds: {
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
    },
  };
}

function sampleProjectedCurve(curve) {
  if (curve.type === 'line') {
    return [
      { x: curve.x1, y: curve.y1 },
      { x: curve.x2, y: curve.y2 },
    ];
  }
  if (curve.type === 'circle') {
    const segments = 96;
    const points = [];
    for (let index = 0; index <= segments; index++) {
      const angle = (Math.PI * 2 * index) / segments;
      points.push({
        x: curve.cx + Math.cos(angle) * curve.radius,
        y: curve.cy + Math.sin(angle) * curve.radius,
      });
    }
    return points;
  }
  if (curve.type === 'arc') {
    const startAngle = normalizeAngleRadians(curve.startAngle);
    const endAngle = normalizeAngleRadians(curve.endAngle);
    const fullTurn = Math.PI * 2;
    const sweep = (endAngle - startAngle + fullTurn) % fullTurn;
    const segments = Math.max(24, Math.ceil((sweep || fullTurn) / (Math.PI / 24)));
    const points = [];
    for (let index = 0; index <= segments; index++) {
      const angle = startAngle + ((sweep || fullTurn) * index) / segments;
      points.push({
        x: curve.cx + Math.cos(angle) * curve.radius,
        y: curve.cy + Math.sin(angle) * curve.radius,
      });
    }
    return points;
  }
  if (curve.type === 'polyline') {
    return curve.points || [];
  }
  if (curve.type !== 'spline') return [];

  const spline = new NurbsCurve(curve.degree, curve.controlPoints, curve.knots, curve.weights);
  const spanCount = countCurveSpans(spline);
  const segments = Math.max(spanCount * 24, 24);
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const u = spline.uMin + ((spline.uMax - spline.uMin) * i) / segments;
    const point = spline.evaluate(u);
    points.push({ x: point.x, y: point.y });
  }
  return points;
}

function countCurveSpans(curve) {
  let spans = 0;
  for (let i = curve.degree; i < curve.controlPoints.length; i++) {
    if (curve.knots[i + 1] - curve.knots[i] > 1e-9) spans++;
  }
  return Math.max(spans, 1);
}

function boundsFromSegments(edges) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const edge of edges) {
    minX = Math.min(minX, edge.x1, edge.x2);
    minY = Math.min(minY, edge.y1, edge.y2);
    maxX = Math.max(maxX, edge.x1, edge.x2);
    maxY = Math.max(maxY, edge.y1, edge.y2);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

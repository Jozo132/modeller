// js/cad/StepExport.js — STEP AP203/AP214/AP242 file export
//
// Serializes exact B-Rep topology and geometry to ISO 10303 STEP format.
// Supports:
//   - manifold_solid_brep
//   - closed_shell
//   - advanced_face
//   - plane, cylindrical_surface, conical_surface, spherical_surface
//   - surface_of_linear_extrusion, surface_of_revolution
//   - b_spline_surface_with_knots
//   - edge_curve, oriented_edge, vertex_point
//   - face_bound, edge_loop

import { SurfaceType } from './BRepTopology.js';
import { telemetry } from '../telemetry.js';

const _now = typeof performance !== 'undefined' && performance.now
  ? () => performance.now()
  : () => Date.now();

function _measureStepExportPhase(timings, key, label, fn) {
  const start = _now();
  try {
    return fn();
  } finally {
    timings[key] = telemetry.recordTimer(label, _now() - start, start);
  }
}

function _assertStepExportable(body, opts) {
  // Block STEP export for fallback solids — they are discrete representations
  // and cannot be faithfully serialized as exact B-Rep STEP geometry.
  if (opts._isFallback || (body && body._isFallback)) {
    throw new Error('STEP export is not supported for fallback (discrete) solids. Fallback results are mesh-only representations.');
  }
  // Also block when resultGrade explicitly marks a non-exact result
  if (opts.resultGrade && opts.resultGrade !== 'exact') {
    throw new Error(`STEP export is not supported for results with grade '${opts.resultGrade}'. Only exact results may be exported as STEP.`);
  }
  if (body && body.resultGrade && body.resultGrade !== 'exact') {
    throw new Error(`STEP export is not supported for results with grade '${body.resultGrade}'. Only exact results may be exported as STEP.`);
  }
}

/**
 * Export a TopoBody to STEP format string.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @param {string} [opts.filename='export'] - File description
 * @param {string} [opts.author='CAD Modeller'] - Author name
 * @param {string} [opts.schema='AUTOMOTIVE_DESIGN'] - STEP schema
 * @returns {string} STEP file contents
 */
export function exportSTEP(body, opts = {}) {
  return exportSTEPDetailed(body, opts).stepString;
}

/**
 * Export a TopoBody to STEP format string with timing metadata.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @param {string} [opts.filename='export'] - File description
 * @param {string} [opts.author='CAD Modeller'] - Author name
 * @param {string} [opts.schema='AUTOMOTIVE_DESIGN'] - STEP schema
 * @returns {{ stepString: string, timings: Object }}
 */
export function exportSTEPDetailed(body, opts = {}) {
  _assertStepExportable(body, opts);

  const timings = {};
  const totalStart = _now();
  const filename = opts.filename ?? 'export';
  const author = opts.author ?? 'CAD Modeller';
  const schema = opts.schema ?? 'AUTOMOTIVE_DESIGN';

  const writer = new StepWriter();

  // Write header
  _measureStepExportPhase(timings, 'headerMs', 'step:export:header', () => {
    writer.writeHeader(filename, author, schema);
  });

  // Write body
  if (body && body.shells.length > 0) {
    _measureStepExportPhase(timings, 'writeBodyMs', 'step:export:write-body', () => {
      _writeBody(writer, body);
    });
  }

  const stepString = _measureStepExportPhase(timings, 'stringifyMs', 'step:export:stringify', () =>
    writer.toString(),
  );
  timings.totalMs = telemetry.recordTimer('step:export:total', _now() - totalStart, totalStart);
  timings.entityCount = writer.entityCount();
  timings.outputBytes = stepString.length;
  timings.shellCount = body ? body.shells.length : 0;
  timings.faceCount = body ? body.faces().length : 0;
  timings.edgeCount = body ? body.edges().length : 0;
  timings.vertexCount = body ? body.vertices().length : 0;

  return { stepString, timings };
}

/**
 * Internal STEP entity writer.
 */
class StepWriter {
  constructor() {
    this._entities = [];
    this._nextId = 1;
    this._header = '';
  }

  /**
   * Allocate a new entity ID.
   * @returns {number}
   */
  newId() {
    return this._nextId++;
  }

  /**
   * Add a STEP entity.
   * @param {number} id
   * @param {string} entity
   */
  addEntity(id, entity) {
    this._entities.push(`#${id}=${entity};`);
  }

  entityCount() {
    return this._entities.length;
  }

  /**
   * Write the STEP file header.
   */
  writeHeader(filename, author, schema) {
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    this._header = [
      'ISO-10303-21;',
      'HEADER;',
      `FILE_DESCRIPTION(('CAD Model'),'2;1');`,
      `FILE_NAME('${filename}.step','${now}',(\'${author}\'),(''),` +
        `'CAD Modeller STEP Export','CAD Modeller','');`,
      `FILE_SCHEMA(('${schema}'));`,
      'ENDSEC;',
    ].join('\n');
  }

  /**
   * Generate complete STEP file string.
   * @returns {string}
   */
  toString() {
    return [
      this._header,
      'DATA;',
      ...this._entities,
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');
  }
}

/**
 * Write a complete body to STEP.
 */
function _writeBody(writer, body) {
  // Write geometric context
  const ctxId = _writeGeometricContext(writer);

  // Write all vertices first
  const vertexIds = new Map();
  for (const v of body.vertices()) {
    const ptId = _writeCartesianPoint(writer, v.point);
    const vpId = writer.newId();
    writer.addEntity(vpId, `VERTEX_POINT('',#${ptId})`);
    vertexIds.set(v.id, vpId);
  }

  // Write all edges
  const edgeIds = new Map();
  for (const e of body.edges()) {
    const curveId = _writeEdgeCurve(writer, e);
    const svId = vertexIds.get(e.startVertex.id);
    const evId = vertexIds.get(e.endVertex.id);
    const ecId = writer.newId();
    writer.addEntity(ecId, `EDGE_CURVE('',#${svId},#${evId},#${curveId},.T.)`);
    edgeIds.set(e.id, ecId);
  }

  // Write shells
  const shellIds = [];
  for (const shell of body.shells) {
    const faceIds = [];

    for (const face of shell.faces) {
      const faceId = _writeFace(writer, face, edgeIds, vertexIds);
      faceIds.push(faceId);
    }

    const shellId = writer.newId();
    const faceRefs = faceIds.map(id => `#${id}`).join(',');
    writer.addEntity(shellId, `CLOSED_SHELL('',(${faceRefs}))`);
    shellIds.push(shellId);
  }

  // Write manifold solid brep
  if (shellIds.length > 0) {
    const brepId = writer.newId();
    writer.addEntity(brepId, `MANIFOLD_SOLID_BREP('',#${shellIds[0]})`);
  }
}

/**
 * Write a face (advanced_face) to STEP.
 */
function _writeFace(writer, face, edgeIds, vertexIds) {
  // Write the support surface
  const surfaceId = _writeSurface(writer, face);

  // Write loops
  const loopIds = [];
  if (face.outerLoop) {
    const loopId = _writeLoop(writer, face.outerLoop, edgeIds);
    const boundId = writer.newId();
    writer.addEntity(boundId, `FACE_OUTER_BOUND('',#${loopId},.T.)`);
    loopIds.push(boundId);
  }

  for (const il of face.innerLoops) {
    const loopId = _writeLoop(writer, il, edgeIds);
    const boundId = writer.newId();
    writer.addEntity(boundId, `FACE_BOUND('',#${loopId},.T.)`);
    loopIds.push(boundId);
  }

  const faceId = writer.newId();
  const boundRefs = loopIds.map(id => `#${id}`).join(',');
  const sense = face.sameSense ? '.T.' : '.F.';
  writer.addEntity(faceId,
    `ADVANCED_FACE('',(${boundRefs}),#${surfaceId},${sense})`);

  return faceId;
}

/**
 * Write a loop (edge_loop) to STEP.
 */
function _writeLoop(writer, loop, edgeIds) {
  const orientedEdgeIds = [];

  for (const ce of loop.coedges) {
    const ecId = edgeIds.get(ce.edge.id);
    if (ecId == null) continue;
    const sense = ce.sameSense ? '.T.' : '.F.';
    const oeId = writer.newId();
    writer.addEntity(oeId, `ORIENTED_EDGE('',*,*,#${ecId},${sense})`);
    orientedEdgeIds.push(oeId);
  }

  const loopId = writer.newId();
  const edgeRefs = orientedEdgeIds.map(id => `#${id}`).join(',');
  writer.addEntity(loopId, `EDGE_LOOP('',(${edgeRefs}))`);

  return loopId;
}

/**
 * Write a support surface to STEP.
 */
function _writeSurface(writer, face) {
  switch (face.surfaceType) {
    case SurfaceType.PLANE:
      return _writePlane(writer, face);
    case SurfaceType.CYLINDER:
      return _writeCylindricalSurface(writer, face);
    case SurfaceType.CONE:
      return _writeConicalSurface(writer, face);
    case SurfaceType.SPHERE:
      return _writeSphericalSurface(writer, face);
    case SurfaceType.TORUS:
      return _writeToroidalSurface(writer, face);
    case SurfaceType.EXTRUSION:
      return _writeExtrusionSurface(writer, face);
    case SurfaceType.REVOLUTION:
      return _writeRevolutionSurface(writer, face);
    case SurfaceType.BSPLINE:
    default:
      return _writeBSplineSurface(writer, face);
  }
}

/**
 * Write a plane to STEP.
 */
function _writePlane(writer, face) {
  const info = face.surfaceInfo && face.surfaceInfo.type === 'plane' ? face.surfaceInfo : null;
  if (!face.surface) {
    const origin = info?.origin || _faceReferencePoint(face);
    const normal = _normalizeDirection(info?.normal) || { x: 0, y: 0, z: 1 };
    const refDir = _referenceDirection(info, normal);
    const ptId = _writeCartesianPoint(writer, origin);
    const dirId = _writeDirection(writer, normal);
    const refId = _writeDirection(writer, refDir);
    const axisId = writer.newId();
    writer.addEntity(axisId, `AXIS2_PLACEMENT_3D('',#${ptId},#${dirId},#${refId})`);
    const planeId = writer.newId();
    writer.addEntity(planeId, `PLANE('',#${axisId})`);
    return planeId;
  }

  // Get plane data from surface evaluation
  const origin = face.surface.evaluate(0, 0);
  const normal = _normalizeDirection(face.surface.normal(0.5, 0.5)) || { x: 0, y: 0, z: 1 };

  const ptId = _writeCartesianPoint(writer, origin);
  const dirId = _writeDirection(writer, normal);
  const refId = _writeDirection(writer, _referenceDirection(info, normal));
  const axisId = writer.newId();
  writer.addEntity(axisId, `AXIS2_PLACEMENT_3D('',#${ptId},#${dirId},#${refId})`);
  const planeId = writer.newId();
  writer.addEntity(planeId, `PLANE('',#${axisId})`);
  return planeId;
}

/**
 * Write a cylindrical surface to STEP.
 */
function _writeCylindricalSurface(writer, face) {
  const info = face.surfaceInfo && face.surfaceInfo.type === 'cylinder' ? face.surfaceInfo : null;
  const origin = info?.origin || (face.surface ? face.surface.evaluate(0, 0) : _faceReferencePoint(face));
  const normal = _normalizeDirection(info?.axis || (face.surface ? face.surface.normal(0.5, 0.5) : null)) || { x: 0, y: 0, z: 1 };
  const refDir = _referenceDirection(info, normal);
  const radius = Number.isFinite(info?.radius) ? info.radius : 1.0;

  const ptId = _writeCartesianPoint(writer, origin);
  const dirId = _writeDirection(writer, normal);
  const refId = _writeDirection(writer, refDir);
  const axisId = writer.newId();
  writer.addEntity(axisId, `AXIS2_PLACEMENT_3D('',#${ptId},#${dirId},#${refId})`);

  const surfId = writer.newId();
  writer.addEntity(surfId, `CYLINDRICAL_SURFACE('',#${axisId},${_real(radius)})`);
  return surfId;
}

/**
 * Write a conical surface to STEP.
 */
function _writeConicalSurface(writer, face) {
  const info = face.surfaceInfo && face.surfaceInfo.type === 'cone' ? face.surfaceInfo : null;
  const origin = info?.origin || (face.surface ? face.surface.evaluate(0, 0) : _faceReferencePoint(face));
  const normal = _normalizeDirection(info?.axis || (face.surface ? face.surface.normal(0.5, 0.5) : null)) || { x: 0, y: 0, z: 1 };
  const refDir = _referenceDirection(info, normal);
  const radius = Number.isFinite(info?.radius) ? info.radius : 1.0;
  const semiAngle = Number.isFinite(info?.semiAngle) ? info.semiAngle : 0.5;

  const ptId = _writeCartesianPoint(writer, origin);
  const dirId = _writeDirection(writer, normal);
  const refId = _writeDirection(writer, refDir);
  const axisId = writer.newId();
  writer.addEntity(axisId, `AXIS2_PLACEMENT_3D('',#${ptId},#${dirId},#${refId})`);

  const surfId = writer.newId();
  writer.addEntity(surfId, `CONICAL_SURFACE('',#${axisId},${_real(radius)},${_real(semiAngle)})`);
  return surfId;
}

/**
 * Write a spherical surface to STEP.
 */
function _writeSphericalSurface(writer, face) {
  const info = face.surfaceInfo && face.surfaceInfo.type === 'sphere' ? face.surfaceInfo : null;
  const center = info?.origin || (face.surface ? face.surface.evaluate(0.5, 0.5) : _faceReferencePoint(face));
  const axis = _normalizeDirection(info?.axis) || { x: 0, y: 0, z: 1 };
  const refDir = _referenceDirection(info, axis);
  const radius = Number.isFinite(info?.radius) ? info.radius : 1.0;

  const ptId = _writeCartesianPoint(writer, center);
  const dirId = _writeDirection(writer, axis);
  const refId = _writeDirection(writer, refDir);
  const axisId = writer.newId();
  writer.addEntity(axisId, `AXIS2_PLACEMENT_3D('',#${ptId},#${dirId},#${refId})`);

  const surfId = writer.newId();
  writer.addEntity(surfId, `SPHERICAL_SURFACE('',#${axisId},${_real(radius)})`);
  return surfId;
}

/**
 * Write a toroidal surface to STEP.
 */
function _writeToroidalSurface(writer, face) {
  const info = face.surfaceInfo && face.surfaceInfo.type === 'torus' ? face.surfaceInfo : null;
  const origin = info?.origin || _faceReferencePoint(face);
  const axis = _normalizeDirection(info?.axis) || { x: 0, y: 0, z: 1 };
  const refDir = _referenceDirection(info, axis);
  const majorR = Number.isFinite(info?.majorR) ? info.majorR : 1.0;
  const minorR = Number.isFinite(info?.minorR) ? info.minorR : 0.25;

  const ptId = _writeCartesianPoint(writer, origin);
  const dirId = _writeDirection(writer, axis);
  const refId = _writeDirection(writer, refDir);
  const axisId = writer.newId();
  writer.addEntity(axisId, `AXIS2_PLACEMENT_3D('',#${ptId},#${dirId},#${refId})`);

  const surfId = writer.newId();
  writer.addEntity(surfId, `TOROIDAL_SURFACE('',#${axisId},${_real(majorR)},${_real(minorR)})`);
  return surfId;
}

/**
 * Write a surface of linear extrusion to STEP.
 */
function _writeExtrusionSurface(writer, face) {
  // Fallback to B-spline
  return _writeBSplineSurface(writer, face);
}

/**
 * Write a surface of revolution to STEP.
 */
function _writeRevolutionSurface(writer, face) {
  // Fallback to B-spline
  return _writeBSplineSurface(writer, face);
}

/**
 * Write a B-spline surface with knots to STEP.
 */
function _writeBSplineSurface(writer, face) {
  if (!face.surface) {
    // Fallback plane
    return _writePlane(writer, face);
  }

  const s = face.surface;
  const surfId = writer.newId();

  // Write control points grid
  const cpIds = [];
  for (let i = 0; i < s.numRowsU; i++) {
    const row = [];
    for (let j = 0; j < s.numColsV; j++) {
      const cp = s.controlPoints[i * s.numColsV + j];
      row.push(_writeCartesianPoint(writer, cp));
    }
    cpIds.push(row);
  }

  // Format control points as nested lists
  const cpGrid = cpIds.map(row => `(${row.map(id => `#${id}`).join(',')})`).join(',');

  // Knot multiplicities
  const knotMultU = _computeKnotMultiplicities(s.knotsU);
  const knotMultV = _computeKnotMultiplicities(s.knotsV);

  const uMults = knotMultU.multiplicities.join(',');
  const uKnots = knotMultU.knots.map(k => _real(k)).join(',');
  const vMults = knotMultV.multiplicities.join(',');
  const vKnots = knotMultV.knots.map(k => _real(k)).join(',');

  if (_hasNonUnitWeights(s.weights)) {
    const weightRows = [];
    for (let i = 0; i < s.numRowsU; i++) {
      const row = [];
      for (let j = 0; j < s.numColsV; j++) {
        row.push(_real(s.weights[i * s.numColsV + j]));
      }
      weightRows.push(`(${row.join(',')})`);
    }

    writer.addEntity(
      surfId,
      `(B_SPLINE_SURFACE(${s.degreeU},${s.degreeV},(${cpGrid}),.UNSPECIFIED.,.F.,.F.,.F.) ` +
      `B_SPLINE_SURFACE_WITH_KNOTS((${uMults}),(${vMults}),(${uKnots}),(${vKnots}),.UNSPECIFIED.) ` +
      `RATIONAL_B_SPLINE_SURFACE((${weightRows.join(',')})) SURFACE())`,
    );
    return surfId;
  }

  writer.addEntity(surfId,
    `B_SPLINE_SURFACE_WITH_KNOTS('',${s.degreeU},${s.degreeV},` +
    `(${cpGrid}),.UNSPECIFIED.,.F.,.F.,.F.,` +
    `(${uMults}),(${vMults}),` +
    `(${uKnots}),(${vKnots}),.UNSPECIFIED.)`);

  return surfId;
}

/**
 * Write an edge curve to STEP.
 */
function _writeEdgeCurve(writer, edge) {
  if (edge.curve) {
    return _writeBSplineCurve(writer, edge.curve);
  }

  // Straight line
  const p1 = edge.startVertex.point;
  const p2 = edge.endVertex.point;
  const ptId = _writeCartesianPoint(writer, p1);
  const dx = p2.x - p1.x, dy = p2.y - p1.y, dz = p2.z - p1.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const dir = len > 1e-14
    ? { x: dx / len, y: dy / len, z: dz / len }
    : { x: 1, y: 0, z: 0 };
  const dirId = _writeDirection(writer, dir);

  const vecId = writer.newId();
  writer.addEntity(vecId, `VECTOR('',#${dirId},${_real(len)})`);

  const lineId = writer.newId();
  writer.addEntity(lineId, `LINE('',#${ptId},#${vecId})`);
  return lineId;
}

/**
 * Write a B-spline curve to STEP.
 */
function _writeBSplineCurve(writer, curve) {
  const cpIds = curve.controlPoints.map(cp => _writeCartesianPoint(writer, cp));
  const cpRefs = cpIds.map(id => `#${id}`).join(',');

  const knotMult = _computeKnotMultiplicities(curve.knots);
  const mults = knotMult.multiplicities.join(',');
  const knots = knotMult.knots.map(k => _real(k)).join(',');

  const curveId = writer.newId();
  if (_hasNonUnitWeights(curve.weights)) {
    const weights = curve.weights.map(weight => _real(weight)).join(',');
    writer.addEntity(
      curveId,
      `(BOUNDED_CURVE() B_SPLINE_CURVE(${curve.degree},(${cpRefs}),.UNSPECIFIED.,.F.,.F.) ` +
      `B_SPLINE_CURVE_WITH_KNOTS((${mults}),(${knots}),.UNSPECIFIED.) ` +
      `RATIONAL_B_SPLINE_CURVE((${weights})) CURVE())`,
    );
    return curveId;
  }

  writer.addEntity(curveId,
    `B_SPLINE_CURVE_WITH_KNOTS('',${curve.degree},(${cpRefs}),` +
    `.UNSPECIFIED.,.F.,.F.,(${mults}),(${knots}),.UNSPECIFIED.)`);

  return curveId;
}

// -----------------------------------------------------------------------
// Primitive STEP entities
// -----------------------------------------------------------------------

function _writeCartesianPoint(writer, pt) {
  const id = writer.newId();
  writer.addEntity(id, `CARTESIAN_POINT('',(${_real(pt.x)},${_real(pt.y)},${_real(pt.z)}))`);
  return id;
}

function _writeDirection(writer, dir) {
  const id = writer.newId();
  writer.addEntity(id, `DIRECTION('',(${_real(dir.x)},${_real(dir.y)},${_real(dir.z)}))`);
  return id;
}

function _writeGeometricContext(writer) {
  // Length unit: millimeter
  const luId = writer.newId();
  writer.addEntity(luId, `(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);

  // Angle unit: radian
  const auId = writer.newId();
  writer.addEntity(auId, `(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);

  // Solid angle unit: steradian
  const saId = writer.newId();
  writer.addEntity(saId, `(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);

  // Uncertainty
  const uncId = writer.newId();
  writer.addEntity(uncId, `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.0E-6),#${luId},'DISTANCE_ACCURACY_VALUE','max. tolerance')`);

  // Context
  const ctxId = writer.newId();
  writer.addEntity(ctxId,
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncId}))` +
    `GLOBAL_UNIT_ASSIGNED_CONTEXT((#${luId},#${auId},#${saId}))REPRESENTATION_CONTEXT('','3D'))`);

  return ctxId;
}

function _faceReferencePoint(face) {
  const vertex = face?.outerLoop?.coedges?.[0]?.edge?.startVertex?.point;
  return vertex ? { x: vertex.x, y: vertex.y, z: vertex.z } : { x: 0, y: 0, z: 0 };
}

function _normalizeDirection(dir) {
  if (!dir) return null;
  const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  if (len < 1e-14) return null;
  return { x: dir.x / len, y: dir.y / len, z: dir.z / len };
}

function _referenceDirection(surfaceInfo, normal) {
  const ref = _normalizeDirection(surfaceInfo?.xDir);
  if (ref) return ref;
  return _perpendicular(normal);
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/**
 * Format a number as STEP real.
 */
function _real(n) {
  if (Number.isInteger(n)) return `${n}.`;
  return n.toExponential(10).toUpperCase().replace('+', '');
}

/**
 * Compute knot multiplicities from a knot vector.
 */
function _computeKnotMultiplicities(knots) {
  const uniqueKnots = [];
  const multiplicities = [];

  for (const k of knots) {
    if (uniqueKnots.length === 0 || Math.abs(k - uniqueKnots[uniqueKnots.length - 1]) > 1e-10) {
      uniqueKnots.push(k);
      multiplicities.push(1);
    } else {
      multiplicities[multiplicities.length - 1]++;
    }
  }

  return { knots: uniqueKnots, multiplicities };
}

function _hasNonUnitWeights(weights) {
  if (!Array.isArray(weights) || weights.length === 0) return false;
  return weights.some(weight => Math.abs((Number(weight) || 1) - 1) > 1e-12);
}

/**
 * Compute a perpendicular direction to a given normal.
 */
function _perpendicular(n) {
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  let ref;
  if (ax <= ay && ax <= az) {
    ref = { x: 1, y: 0, z: 0 };
  } else if (ay <= az) {
    ref = { x: 0, y: 1, z: 0 };
  } else {
    ref = { x: 0, y: 0, z: 1 };
  }

  // Cross product n × ref
  const cx = n.y * ref.z - n.z * ref.y;
  const cy = n.z * ref.x - n.x * ref.z;
  const cz = n.x * ref.y - n.y * ref.x;
  const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
  if (len < 1e-14) return { x: 1, y: 0, z: 0 };
  return { x: cx / len, y: cy / len, z: cz / len };
}

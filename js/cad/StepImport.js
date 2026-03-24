// js/cad/StepImport.js — STEP AP203/AP214/AP242 file import
//
// Parses ISO 10303 STEP files and builds exact B-Rep topology with
// NurbsCurve / NurbsSurface geometry, plus tessellated mesh for display.
//
// Supports:
//   - MANIFOLD_SOLID_BREP / ADVANCED_BREP_SHAPE_REPRESENTATION
//   - CLOSED_SHELL / OPEN_SHELL
//   - ADVANCED_FACE with FACE_BOUND / FACE_OUTER_BOUND
//   - EDGE_LOOP, ORIENTED_EDGE, EDGE_CURVE
//   - VERTEX_POINT, CARTESIAN_POINT, DIRECTION, VECTOR
//   - LINE, CIRCLE, ELLIPSE
//   - B_SPLINE_CURVE_WITH_KNOTS, RATIONAL_B_SPLINE_CURVE
//   - SURFACE_CURVE / SEAM_CURVE (unwraps to underlying 3D curve)
//   - PLANE, CYLINDRICAL_SURFACE, CONICAL_SURFACE
//   - SPHERICAL_SURFACE, TOROIDAL_SURFACE
//   - B_SPLINE_SURFACE_WITH_KNOTS, RATIONAL_B_SPLINE_SURFACE

import { NurbsCurve } from './NurbsCurve.js';
import { NurbsSurface } from './NurbsSurface.js';
import {
  SurfaceType,
  TopoVertex,
  TopoEdge,
  TopoCoEdge,
  TopoLoop,
  TopoFace,
  TopoShell,
  TopoBody,
} from './BRepTopology.js';

/**
 * Parse a STEP file string and return tessellated mesh geometry plus
 * an optional exact B-Rep topology body.
 *
 * @param {string} stepString - Contents of a STEP file
 * @param {Object} [opts]
 * @param {number} [opts.curveSegments=16] - Segments for curved edge tessellation
 * @param {number} [opts.surfaceSegments=8] - Segments for surface tessellation
 * @returns {{ vertices: {x,y,z}[], faces: {vertices:{x,y,z}[], normal:{x,y,z}}[], body: TopoBody|null }}
 */
export function importSTEP(stepString, opts = {}) {
  const curveSegments = opts.curveSegments ?? 16;
  const surfaceSegments = opts.surfaceSegments ?? 8;

  // ------------------------------------------------------------------
  // 1. Parse all entities from the DATA section
  // ------------------------------------------------------------------
  const entities = _parseEntities(stepString);

  // ------------------------------------------------------------------
  // 2. Resolve entity references into an object graph
  // ------------------------------------------------------------------
  const resolved = _resolveEntities(entities);

  // ------------------------------------------------------------------
  // 3. Find MANIFOLD_SOLID_BREP (or CLOSED_SHELL directly)
  // ------------------------------------------------------------------
  const shells = _findShells(resolved);
  if (shells.length === 0) {
    throw new Error('No solid geometry found in STEP file');
  }

  // ------------------------------------------------------------------
  // 4. Build B-Rep topology and tessellate
  // ------------------------------------------------------------------
  const allVertices = [];
  const allFaces = [];
  const topoShells = [];
  let faceGroupCounter = 0;

  for (const shell of shells) {
    const faceRefs = Array.isArray(shell.args[1]) ? shell.args[1] : shell.args;
    const topoFaces = [];

    for (const faceRef of faceRefs) {
      const faceId = _refId(faceRef);
      if (faceId == null) continue;

      const result = _buildFace(resolved, faceId, curveSegments, surfaceSegments, faceGroupCounter);
      if (result) {
        allVertices.push(...result.mesh.vertices);
        allFaces.push(...result.mesh.faces);
        if (result.topoFace) topoFaces.push(result.topoFace);
      }
      faceGroupCounter++;
    }

    const topoShell = new TopoShell(topoFaces);
    topoShell.closed = shell.type === 'CLOSED_SHELL';
    topoShells.push(topoShell);
  }

  const body = topoShells.length > 0 ? new TopoBody(topoShells) : null;

  return { vertices: allVertices, faces: allFaces, body };
}

// =====================================================================
// STEP Entity Parsing
// =====================================================================

/**
 * Parse STEP file into a map of entity ID → { type, rawArgs, line }.
 * Handles multi-line entities.
 */
function _parseEntities(stepString) {
  const entities = new Map();

  // Extract the DATA section
  const dataMatch = stepString.match(/DATA\s*;([\s\S]*?)ENDSEC\s*;/);
  if (!dataMatch) return entities;
  const dataSection = dataMatch[1];

  // Join multi-line entities: split by semicolons, then parse each
  // First, flatten into single-line entries
  const rawLines = dataSection.split(';');

  for (const rawLine of rawLines) {
    const trimmed = rawLine.replace(/\s+/g, ' ').trim();
    if (!trimmed || !trimmed.startsWith('#')) continue;

    // Pattern: #ID = TYPE(...)
    const match = trimmed.match(/^#(\d+)\s*=\s*(.+)$/);
    if (!match) continue;

    const id = parseInt(match[1], 10);
    let body = match[2].trim();

    // Handle complex entities: (TYPE1()TYPE2()...) or TYPE(...)
    let type, argsStr;

    if (body.startsWith('(')) {
      // Complex entity like (BOUNDED_CURVE() B_SPLINE_CURVE(...) ...)
      // Extract the most specific type and merge args from sub-entities
      const complexResult = _parseComplexEntity(body);
      type = complexResult.type;
      argsStr = complexResult.argsStr;
    } else {
      const parenIdx = body.indexOf('(');
      if (parenIdx < 0) {
        type = body;
        argsStr = '';
      } else {
        type = body.substring(0, parenIdx).trim();
        // Extract everything inside the outermost parens
        argsStr = body.substring(parenIdx + 1);
        // Remove trailing )
        if (argsStr.endsWith(')')) {
          argsStr = argsStr.substring(0, argsStr.length - 1);
        }
      }
    }

    entities.set(id, { id, type: type.toUpperCase(), argsStr });
  }

  return entities;
}

/**
 * Parse a complex STEP entity body like:
 *   ( BOUNDED_CURVE() B_SPLINE_CURVE(degree,(cps),form,closed,self_int)
 *     B_SPLINE_CURVE_WITH_KNOTS((mults),(knots),knot_spec)
 *     RATIONAL_B_SPLINE_CURVE((weights)) ... )
 * Returns the most specific type and merged args string.
 */
function _parseComplexEntity(body) {
  // Strip outer parens
  let inner = body.trim();
  if (inner.startsWith('(')) inner = inner.substring(1);
  if (inner.endsWith(')')) inner = inner.substring(0, inner.length - 1);
  inner = inner.trim();

  // Extract sub-entities: TYPE(args) patterns
  const subEntities = [];
  const regex = /([A-Z_][A-Z0-9_]*)\s*\(([^)]*)\)/g;
  // We need a more careful parser for nested parens
  let pos = 0;
  while (pos < inner.length) {
    // Skip whitespace
    while (pos < inner.length && /\s/.test(inner[pos])) pos++;
    if (pos >= inner.length) break;

    // Read type name
    const nameStart = pos;
    while (pos < inner.length && /[A-Z0-9_]/i.test(inner[pos])) pos++;
    const name = inner.substring(nameStart, pos).trim();
    if (!name) { pos++; continue; }

    // Skip whitespace
    while (pos < inner.length && /\s/.test(inner[pos])) pos++;

    // Expect '('
    if (pos >= inner.length || inner[pos] !== '(') {
      subEntities.push({ name, args: '' });
      continue;
    }
    pos++; // skip '('

    // Read args, handling nested parens
    let depth = 1;
    const argsStart = pos;
    while (pos < inner.length && depth > 0) {
      if (inner[pos] === '(') depth++;
      else if (inner[pos] === ')') depth--;
      if (depth > 0) pos++;
    }
    const args = inner.substring(argsStart, pos);
    pos++; // skip closing ')'
    subEntities.push({ name: name.toUpperCase(), args });
  }

  // Priority: pick the most specific type
  // For curves: RATIONAL_B_SPLINE_CURVE > B_SPLINE_CURVE_WITH_KNOTS > B_SPLINE_CURVE
  // For surfaces: RATIONAL_B_SPLINE_SURFACE > B_SPLINE_SURFACE_WITH_KNOTS > B_SPLINE_SURFACE
  const typeMap = new Map(subEntities.map(s => [s.name, s.args]));

  // Curves
  if (typeMap.has('B_SPLINE_CURVE_WITH_KNOTS') || typeMap.has('B_SPLINE_CURVE')) {
    // Merge args: B_SPLINE_CURVE provides (degree, cps, form, closed, self_int)
    // B_SPLINE_CURVE_WITH_KNOTS adds (mults, knots, knot_spec)
    // RATIONAL_B_SPLINE_CURVE adds (weights)
    const baseArgs = typeMap.get('B_SPLINE_CURVE') || '';
    const knotArgs = typeMap.get('B_SPLINE_CURVE_WITH_KNOTS') || '';
    const rationalArgs = typeMap.get('RATIONAL_B_SPLINE_CURVE') || '';

    // Merge: base_args, knot_args, rational_weights
    let merged = baseArgs;
    if (knotArgs) merged += ',' + knotArgs;
    if (rationalArgs) merged += ',' + rationalArgs;

    return {
      type: rationalArgs ? 'RATIONAL_B_SPLINE_CURVE' : 'B_SPLINE_CURVE_WITH_KNOTS',
      argsStr: merged,
    };
  }

  // Surfaces
  if (typeMap.has('B_SPLINE_SURFACE_WITH_KNOTS') || typeMap.has('B_SPLINE_SURFACE')) {
    const baseArgs = typeMap.get('B_SPLINE_SURFACE') || '';
    const knotArgs = typeMap.get('B_SPLINE_SURFACE_WITH_KNOTS') || '';
    const rationalArgs = typeMap.get('RATIONAL_B_SPLINE_SURFACE') || '';

    let merged = baseArgs;
    if (knotArgs) merged += ',' + knotArgs;
    if (rationalArgs) merged += ',' + rationalArgs;

    return {
      type: rationalArgs ? 'RATIONAL_B_SPLINE_SURFACE' : 'B_SPLINE_SURFACE_WITH_KNOTS',
      argsStr: merged,
    };
  }

  // Geometric representation context or other complex types
  if (typeMap.has('GEOMETRIC_REPRESENTATION_CONTEXT')) {
    return { type: 'GEOMETRIC_REPRESENTATION_CONTEXT', argsStr: typeMap.get('GEOMETRIC_REPRESENTATION_CONTEXT') || '' };
  }

  // Fallback: return __COMPLEX__ with the full body
  return { type: '__COMPLEX__', argsStr: body };
}

/**
 * Parse the argument string of an entity into a structured list.
 * Handles nested parentheses, references, strings, numbers, enums.
 */
function _parseArgs(argsStr) {
  if (!argsStr || argsStr.trim() === '') return [];

  const result = [];
  let depth = 0;
  let current = '';
  let inString = false;

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];

    if (ch === "'" && !inString) {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "'" && inString) {
      inString = false;
      current += ch;
      continue;
    }
    if (inString) {
      current += ch;
      continue;
    }

    if (ch === '(') {
      if (depth === 0) {
        // Start of a nested list
        if (current.trim()) {
          result.push(_parseToken(current.trim()));
          current = '';
        }
        current = '';
        depth++;
        continue;
      }
      depth++;
      current += ch;
      continue;
    }

    if (ch === ')') {
      depth--;
      if (depth === 0) {
        // End of nested list
        result.push(_parseArgs(current));
        current = '';
        continue;
      }
      if (depth < 0) break; // malformed
      current += ch;
      continue;
    }

    if (ch === ',' && depth === 0) {
      if (current.trim()) {
        result.push(_parseToken(current.trim()));
      }
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    result.push(_parseToken(current.trim()));
  }

  return result;
}

/**
 * Parse a single token (number, reference, enum, string, etc.)
 */
function _parseToken(token) {
  if (token === '*' || token === '$') return null;
  if (token.startsWith('#')) return token; // reference
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
  if (token.startsWith('.') && token.endsWith('.')) return token; // enum like .T.
  const num = Number(token);
  if (!isNaN(num)) return num;
  return token;
}

/**
 * Resolve all entities into objects with parsed args.
 */
function _resolveEntities(rawEntities) {
  const resolved = new Map();

  for (const [id, ent] of rawEntities) {
    const args = _parseArgs(ent.argsStr);
    resolved.set(id, { id, type: ent.type, args });
  }

  return resolved;
}

// =====================================================================
// Entity resolution helpers
// =====================================================================

/** Extract numeric ID from a '#N' reference string. */
function _refId(ref) {
  if (typeof ref === 'string' && ref.startsWith('#')) {
    return parseInt(ref.substring(1), 10);
  }
  if (typeof ref === 'number') return ref;
  return null;
}

/** Look up a resolved entity by reference. */
function _getEntity(resolved, ref) {
  const id = _refId(ref);
  if (id == null) return null;
  return resolved.get(id) || null;
}

// =====================================================================
// Topology extraction
// =====================================================================

/**
 * Find all CLOSED_SHELL / OPEN_SHELL entities referenced by MANIFOLD_SOLID_BREP.
 * Falls back to searching for CLOSED_SHELL directly if no BREP wrapper found.
 */
function _findShells(resolved) {
  const shells = [];

  // Try MANIFOLD_SOLID_BREP first
  for (const [, ent] of resolved) {
    if (ent.type === 'MANIFOLD_SOLID_BREP') {
      // args: [name, shellRef]
      const shellRef = ent.args[1];
      const shell = _getEntity(resolved, shellRef);
      if (shell) shells.push(shell);
    }
  }

  if (shells.length > 0) return shells;

  // Fallback: find CLOSED_SHELL / OPEN_SHELL directly
  for (const [, ent] of resolved) {
    if (ent.type === 'CLOSED_SHELL' || ent.type === 'OPEN_SHELL') {
      shells.push(ent);
    }
  }

  return shells;
}

// =====================================================================
// Face building — B-Rep topology + tessellated mesh
// =====================================================================

/**
 * Build a single ADVANCED_FACE into both B-Rep topology and mesh triangles.
 *
 * @param {Map} resolved - Resolved entity map
 * @param {number} faceId - Entity ID of the ADVANCED_FACE
 * @param {number} curveSegments - Segments for curved edges
 * @param {number} surfaceSegments - Segments for surface tessellation
 * @param {number} faceGroup - Face group index for smooth shading
 * @returns {{ topoFace: TopoFace|null, mesh: { vertices:{x,y,z}[], faces:{vertices:{x,y,z}[], normal:{x,y,z}}[] } }|null}
 */
function _buildFace(resolved, faceId, curveSegments, surfaceSegments, faceGroup) {
  const face = resolved.get(faceId);
  if (!face || face.type !== 'ADVANCED_FACE') return null;

  // ADVANCED_FACE('', (bound_refs...), surface_ref, same_sense)
  const boundsList = face.args[1];
  const surfaceRef = face.args[2];
  const sameSense = face.args[3] === '.T.';

  if (!Array.isArray(boundsList) || boundsList.length === 0) return null;

  // Build NURBS surface from the STEP surface entity
  const surfResult = _buildNurbsSurface(resolved, surfaceRef);
  const nurbsSurface = surfResult ? surfResult.surface : null;
  const surfaceType = surfResult ? surfResult.type : SurfaceType.UNKNOWN;

  // Extract surface normal from analytic surfaces for face winding
  const surfaceNormal = _extractSurfaceNormal(resolved, surfaceRef);

  // Extract surface geometric data for per-vertex normal computation
  const surfaceInfo = _extractSurfaceInfo(resolved, surfaceRef);

  // Build topology loops and polygon loops
  const loopData = [];
  for (const boundRef of boundsList) {
    const bound = _getEntity(resolved, boundRef);
    if (!bound) continue;

    const isFaceBound = bound.type === 'FACE_BOUND' || bound.type === 'FACE_OUTER_BOUND';
    if (!isFaceBound) continue;

    const loopRef = bound.args[1];
    const boundSense = bound.args[2] === '.T.';

    const loop = _getEntity(resolved, loopRef);
    if (!loop || loop.type !== 'EDGE_LOOP') continue;

    const orientedEdgeRefs = loop.args[1];
    if (!Array.isArray(orientedEdgeRefs)) continue;

    const loopResult = _buildLoop(resolved, orientedEdgeRefs, curveSegments);
    if (!loopResult || loopResult.polygon.length < 3) continue;

    if (!boundSense) {
      loopResult.polygon.reverse();
      loopResult.coedges.reverse();
      for (const ce of loopResult.coedges) ce.sameSense = !ce.sameSense;
    }

    loopData.push({
      isOuter: bound.type === 'FACE_OUTER_BOUND',
      polygon: loopResult.polygon,
      topoLoop: new TopoLoop(loopResult.coedges),
    });
  }

  if (loopData.length === 0) return null;

  // Build TopoFace
  const topoFace = new TopoFace(nurbsSurface, surfaceType, sameSense);
  const outerData = loopData.find(l => l.isOuter) || loopData[0];
  topoFace.setOuterLoop(outerData.topoLoop);
  for (const ld of loopData) {
    if (ld !== outerData) topoFace.addInnerLoop(ld.topoLoop);
  }

  // Tessellate: use parametric surface tessellation for curved surfaces with NURBS data
  const polygon = outerData.polygon;
  let meshFaces = [];
  let meshVertices = [];

  const isCurvedFace = surfaceType === SurfaceType.CYLINDER ||
    surfaceType === SurfaceType.CONE ||
    surfaceType === SurfaceType.SPHERE ||
    surfaceType === SurfaceType.TORUS;

  const hasBSplineSurface = nurbsSurface && (
    surfaceType === SurfaceType.BSPLINE ||
    isCurvedFace
  );

  if (hasBSplineSurface && surfaceType === SurfaceType.BSPLINE) {
    // Parametric tessellation of the full NURBS surface patch
    const tess = nurbsSurface.tessellate(surfaceSegments, surfaceSegments);
    if (!sameSense) {
      for (const f of tess.faces) {
        f.vertices.reverse();
        f.normal = { x: -f.normal.x, y: -f.normal.y, z: -f.normal.z };
      }
    }
    for (const f of tess.faces) {
      f.isCurved = true;
      f.faceGroup = faceGroup;
    }
    meshFaces = tess.faces;
    meshVertices = tess.vertices;
  } else {
    // Polygon-based tessellation (planar, or curved surfaces where we sample edges)
    let faceNormal;
    if (surfaceNormal) {
      faceNormal = sameSense
        ? surfaceNormal
        : { x: -surfaceNormal.x, y: -surfaceNormal.y, z: -surfaceNormal.z };
    } else {
      // For curved surfaces without an extracted analytic normal, compute
      // from the surface if available, otherwise from the polygon
      if (nurbsSurface) {
        const midU = (nurbsSurface.uMin + nurbsSurface.uMax) / 2;
        const midV = (nurbsSurface.vMin + nurbsSurface.vMax) / 2;
        const sn = nurbsSurface.normal(midU, midV);
        faceNormal = sameSense ? sn : { x: -sn.x, y: -sn.y, z: -sn.z };
      } else {
        faceNormal = _computePolygonNormal(polygon);
      }
    }

    // Triangulate the polygon with ear clipping
    const triangles = _triangulatePolygon(polygon, faceNormal);

    if (isCurvedFace && surfaceInfo) {
      // For curved surfaces, compute per-triangle normals from vertex positions
      // and the surface geometry (much better visual quality with smooth shading)
      for (const tri of triangles) {
        const triNormals = tri.map(v => _computeVertexNormal(v, surfaceInfo, sameSense));
        // Use centroid normal as the face normal for this triangle
        const cn = {
          x: (triNormals[0].x + triNormals[1].x + triNormals[2].x) / 3,
          y: (triNormals[0].y + triNormals[1].y + triNormals[2].y) / 3,
          z: (triNormals[0].z + triNormals[1].z + triNormals[2].z) / 3,
        };
        const centroidNormal = _normalize(cn);
        meshFaces.push({
          vertices: [tri[0], tri[1], tri[2]],
          normal: centroidNormal,
          isCurved: true,
          faceGroup,
        });
        meshVertices.push(tri[0], tri[1], tri[2]);
      }
    } else {
      for (const tri of triangles) {
        meshFaces.push({
          vertices: [tri[0], tri[1], tri[2]],
          normal: { ...faceNormal },
          faceGroup,
        });
        meshVertices.push(tri[0], tri[1], tri[2]);
      }
    }
  }

  return {
    topoFace,
    mesh: { vertices: meshVertices, faces: meshFaces },
  };
}

/**
 * Build a TopoLoop with coedges and gather the tessellated polygon.
 */
function _buildLoop(resolved, orientedEdgeRefs, curveSegments) {
  const polygon = [];
  const coedges = [];

  for (const oeRef of orientedEdgeRefs) {
    const oe = _getEntity(resolved, oeRef);
    if (!oe || oe.type !== 'ORIENTED_EDGE') continue;

    const edgeCurveRef = oe.args[3];
    const oeSense = oe.args[4] === '.T.';

    const edgeCurve = _getEntity(resolved, edgeCurveRef);
    if (!edgeCurve || edgeCurve.type !== 'EDGE_CURVE') continue;

    const startVertexRef = edgeCurve.args[1];
    const endVertexRef = edgeCurve.args[2];
    const curveRef = edgeCurve.args[3];
    const edgeSense = edgeCurve.args[4] === '.T.';

    const startPt = _getVertexPoint(resolved, startVertexRef);
    const endPt = _getVertexPoint(resolved, endVertexRef);
    if (!startPt || !endPt) continue;

    const forward = oeSense === edgeSense;

    // Build NurbsCurve from the edge geometry
    const nurbsCurve = _buildNurbsCurve(resolved, curveRef, startPt, endPt);

    // Create topology elements
    const sv = new TopoVertex(forward ? startPt : endPt);
    const ev = new TopoVertex(forward ? endPt : startPt);
    const topoEdge = new TopoEdge(sv, ev, nurbsCurve);
    const coedge = new TopoCoEdge(topoEdge, forward);
    coedges.push(coedge);

    // Tessellate for polygon
    const curvePoints = _sampleCurvePoints(resolved, curveRef, startPt, endPt, curveSegments);
    let edgePoints;
    if (curvePoints && curvePoints.length > 2) {
      edgePoints = forward ? curvePoints : [...curvePoints].reverse();
    } else {
      edgePoints = forward ? [startPt, endPt] : [endPt, startPt];
    }

    for (let i = 0; i < edgePoints.length - 1; i++) {
      polygon.push(edgePoints[i]);
    }
  }

  return { polygon, coedges };
}

/**
 * Get 3D point from a VERTEX_POINT entity.
 */
function _getVertexPoint(resolved, ref) {
  const vp = _getEntity(resolved, ref);
  if (!vp || vp.type !== 'VERTEX_POINT') return null;

  // VERTEX_POINT('', cartesian_point_ref)
  return _getCartesianPoint(resolved, vp.args[1]);
}

/**
 * Get {x,y,z} from a CARTESIAN_POINT entity.
 */
function _getCartesianPoint(resolved, ref) {
  const cp = _getEntity(resolved, ref);
  if (!cp || cp.type !== 'CARTESIAN_POINT') return null;

  // CARTESIAN_POINT('', (x, y, z))
  const coords = cp.args[1];
  if (!Array.isArray(coords) || coords.length < 3) return null;

  return {
    x: Number(coords[0]) || 0,
    y: Number(coords[1]) || 0,
    z: Number(coords[2]) || 0,
  };
}

/**
 * Get {x,y,z} from a DIRECTION entity.
 */
function _getDirection(resolved, ref) {
  const dir = _getEntity(resolved, ref);
  if (!dir || dir.type !== 'DIRECTION') return null;

  const coords = dir.args[1];
  if (!Array.isArray(coords) || coords.length < 3) return null;

  return {
    x: Number(coords[0]) || 0,
    y: Number(coords[1]) || 0,
    z: Number(coords[2]) || 0,
  };
}

// =====================================================================
// NurbsCurve / NurbsSurface construction from STEP entities
// =====================================================================

/**
 * Build a NurbsCurve from a STEP curve entity (LINE, CIRCLE, ELLIPSE,
 * B_SPLINE_CURVE_WITH_KNOTS, RATIONAL_B_SPLINE_CURVE).
 * Returns null for LINE (represented as a linear NurbsCurve would be wasteful)
 * or unsupported types.
 */
function _buildNurbsCurve(resolved, curveRef, startPt, endPt) {
  const curve = _getEntity(resolved, curveRef);
  if (!curve) return null;

  let geomCurve = curve;
  if (curve.type === 'SURFACE_CURVE' || curve.type === 'SEAM_CURVE') {
    const innerRef = curve.args[1];
    geomCurve = _getEntity(resolved, innerRef);
    if (!geomCurve) return null;
  }

  switch (geomCurve.type) {
    case 'LINE':
      return NurbsCurve.createLine(startPt, endPt);

    case 'CIRCLE': {
      const axisRef = geomCurve.args[1];
      const radius = Number(geomCurve.args[2]);
      const axis = _getAxis2Placement3D(resolved, axisRef);
      if (!axis || !radius) return null;
      const yDir = _cross(axis.zDir, axis.xDir);
      const startAngle = _pointToAngle(startPt, axis.origin, axis.xDir, yDir);
      let endAngle = _pointToAngle(endPt, axis.origin, axis.xDir, yDir);
      let sweep = endAngle - startAngle;
      if (sweep <= -Math.PI) sweep += 2 * Math.PI;
      if (sweep > Math.PI) sweep -= 2 * Math.PI;
      if (_dist3D(startPt, endPt) < 1e-8) sweep = 2 * Math.PI;
      return NurbsCurve.createArc(axis.origin, radius, axis.xDir, yDir, startAngle, sweep);
    }

    case 'B_SPLINE_CURVE_WITH_KNOTS':
      return _buildBSplineCurveNurbs(resolved, geomCurve, null);

    case 'RATIONAL_B_SPLINE_CURVE':
      return _buildBSplineCurveNurbs(resolved, geomCurve, geomCurve.args[9]);

    default:
      return null;
  }
}

/**
 * Build a NurbsCurve from a B_SPLINE_CURVE_WITH_KNOTS or RATIONAL_B_SPLINE_CURVE.
 */
function _buildBSplineCurveNurbs(resolved, entity, weightsArg) {
  const degree = Number(entity.args[1]) || 1;
  const cpRefs = entity.args[2];
  const knotMults = entity.args[6];
  const knotVals = entity.args[7];

  if (!Array.isArray(cpRefs) || !Array.isArray(knotMults) || !Array.isArray(knotVals)) {
    return null;
  }

  const controlPoints = [];
  for (const cpRef of cpRefs) {
    const pt = _getCartesianPoint(resolved, cpRef);
    if (!pt) return null;
    controlPoints.push(pt);
  }

  const mults = knotMults.map(m => Number(m) || 1);
  const vals = knotVals.map(v => Number(v));

  let weights = null;
  if (Array.isArray(weightsArg) && weightsArg.length === controlPoints.length) {
    weights = weightsArg.map(w => Number(w) || 1);
  }

  return NurbsCurve.fromStepBSpline(degree, controlPoints, mults, vals, weights);
}

/**
 * Build a NurbsSurface (and surface type) from a STEP surface entity.
 * Returns { surface: NurbsSurface, type: SurfaceType } or null.
 */
function _buildNurbsSurface(resolved, surfaceRef) {
  const surf = _getEntity(resolved, surfaceRef);
  if (!surf) return null;

  switch (surf.type) {
    case 'PLANE': {
      // Could build a NurbsSurface plane but the tessellator handles
      // planes via polygon anyway, so we just return the type.
      return { surface: null, type: SurfaceType.PLANE };
    }

    case 'CYLINDRICAL_SURFACE': {
      const axis = _getAxis2Placement3D(resolved, surf.args[1]);
      const radius = Number(surf.args[2]);
      if (!axis || !radius) return { surface: null, type: SurfaceType.CYLINDER };
      const yDir = _cross(axis.zDir, axis.xDir);
      // Build a full cylinder patch (360°, unit height) — trimmed by edge loops
      const surface = NurbsSurface.createCylinder(
        axis.origin, axis.zDir, radius, 1.0,
        axis.xDir, yDir, 0, 2 * Math.PI
      );
      return { surface, type: SurfaceType.CYLINDER };
    }

    case 'CONICAL_SURFACE': {
      return { surface: null, type: SurfaceType.CONE };
    }

    case 'SPHERICAL_SURFACE': {
      return { surface: null, type: SurfaceType.SPHERE };
    }

    case 'TOROIDAL_SURFACE': {
      return { surface: null, type: SurfaceType.TORUS };
    }

    case 'B_SPLINE_SURFACE_WITH_KNOTS':
      return _buildBSplineSurfaceNurbs(resolved, surf, null);

    case 'RATIONAL_B_SPLINE_SURFACE':
      return _buildBSplineSurfaceNurbs(resolved, surf, 'rational');

    default:
      return { surface: null, type: SurfaceType.UNKNOWN };
  }
}

/**
 * Build a NurbsSurface from a B_SPLINE_SURFACE_WITH_KNOTS or RATIONAL_B_SPLINE_SURFACE.
 *
 * Non-complex (flat) entity args layout:
 *   [0] name
 *   [1] degree_u
 *   [2] degree_v
 *   [3] control_points_grid
 *   [4] surface_form
 *   [5] u_closed
 *   [6] v_closed
 *   [7] self_intersect
 *   [8] u_knot_multiplicities
 *   [9] v_knot_multiplicities
 *   [10] u_knot_values
 *   [11] v_knot_values
 *   [12] knot_spec
 *   [13] weights_grid (only for rational)
 *
 * Complex (merged from B_SPLINE_SURFACE + B_SPLINE_SURFACE_WITH_KNOTS) args layout:
 *   [0] degree_u            (no name — B_SPLINE_SURFACE sub-entity has no name)
 *   [1] degree_v
 *   [2] control_points_grid
 *   [3] surface_form
 *   [4] u_closed
 *   [5] v_closed
 *   [6] self_intersect
 *   [7] u_knot_multiplicities
 *   [8] v_knot_multiplicities
 *   [9] u_knot_values
 *   [10] v_knot_values
 *   [11] knot_spec
 *   [12] weights_grid (only for rational)
 */
function _buildBSplineSurfaceNurbs(resolved, entity, rational) {
  // Detect offset: non-complex entities have a name string at args[0] (e.g. ''),
  // while complex entities (merged from sub-entities) start with degree (a number).
  // If args is empty or firstArg is unexpected, default to offset 0 (complex).
  const firstArg = entity.args[0];
  const offset = (typeof firstArg === 'string') ? 1 : 0;

  const degreeU = Number(entity.args[offset]) || 1;
  const degreeV = Number(entity.args[offset + 1]) || 1;
  const cpGrid = entity.args[offset + 2];

  // STEP B_SPLINE_SURFACE_WITH_KNOTS arg order:
  //   u_multiplicities, v_multiplicities, u_knots, v_knots, knot_spec
  const uKnotMults = entity.args[offset + 7];
  const vKnotMults = entity.args[offset + 8];
  const uKnotVals = entity.args[offset + 9];
  const vKnotVals = entity.args[offset + 10];

  if (!Array.isArray(cpGrid) || !Array.isArray(uKnotMults) || !Array.isArray(uKnotVals) ||
      !Array.isArray(vKnotMults) || !Array.isArray(vKnotVals)) {
    return { surface: null, type: SurfaceType.BSPLINE };
  }

  // Resolve control point grid
  const controlPointGrid = [];
  for (const row of cpGrid) {
    if (!Array.isArray(row)) return { surface: null, type: SurfaceType.BSPLINE };
    const cpRow = [];
    for (const cpRef of row) {
      const pt = _getCartesianPoint(resolved, cpRef);
      if (!pt) return { surface: null, type: SurfaceType.BSPLINE };
      cpRow.push(pt);
    }
    controlPointGrid.push(cpRow);
  }

  const multsU = uKnotMults.map(m => Number(m) || 1);
  const valsU = uKnotVals.map(v => Number(v));
  const multsV = vKnotMults.map(m => Number(m) || 1);
  const valsV = vKnotVals.map(v => Number(v));

  // Weights for rational surfaces
  let weightsGrid = null;
  if (rational) {
    const wGrid = entity.args[offset + 12];
    if (Array.isArray(wGrid) && wGrid.length === controlPointGrid.length) {
      weightsGrid = [];
      for (const row of wGrid) {
        if (Array.isArray(row)) {
          weightsGrid.push(row.map(w => Number(w) || 1));
        }
      }
    }
  }

  const surface = NurbsSurface.fromStepBSpline(
    degreeU, degreeV, controlPointGrid,
    multsU, valsU, multsV, valsV, weightsGrid
  );
  return { surface, type: SurfaceType.BSPLINE };
}

// =====================================================================
// Curve sampling for curved edges (tessellation)
// =====================================================================

/**
 * Sample points along a curve entity for tessellation.
 * Returns array of {x,y,z} points from start to end.
 */
function _sampleCurvePoints(resolved, curveRef, startPt, endPt, segments) {
  const curve = _getEntity(resolved, curveRef);
  if (!curve) return null;

  // Unwrap SURFACE_CURVE to get the 3D geometry curve
  let geomCurve = curve;
  if (curve.type === 'SURFACE_CURVE' || curve.type === 'SEAM_CURVE') {
    // SURFACE_CURVE('', 3d_curve_ref, (pcurves...), master_rep)
    const innerRef = curve.args[1];
    geomCurve = _getEntity(resolved, innerRef);
    if (!geomCurve) return null;
  }

  switch (geomCurve.type) {
    case 'LINE':
      return null; // Straight line: just use endpoints

    case 'CIRCLE':
      return _sampleCircle(resolved, geomCurve, startPt, endPt, segments);

    case 'ELLIPSE':
      return _sampleEllipse(resolved, geomCurve, startPt, endPt, segments);

    case 'B_SPLINE_CURVE_WITH_KNOTS':
      return _sampleBSplineCurve(resolved, geomCurve, startPt, endPt, segments);

    case 'RATIONAL_B_SPLINE_CURVE':
      return _sampleRationalBSplineCurve(resolved, geomCurve, startPt, endPt, segments);

    default:
      return null; // Unknown: treat as straight
  }
}

/**
 * Sample points along a CIRCLE arc.
 * CIRCLE('', axis2_placement_ref, radius)
 */
function _sampleCircle(resolved, entity, startPt, endPt, segments) {
  // CIRCLE('', axis2_placement_ref, radius)
  const axisRef = entity.args[1];
  const radius = Number(entity.args[2]);

  const axis = _getAxis2Placement3D(resolved, axisRef);
  if (!axis || !radius) return null;

  const { origin, zDir, xDir } = axis;

  // Compute yDir = zDir × xDir
  const yDir = _cross(zDir, xDir);

  // Project start and end onto the circle plane to get angles
  const startAngle = _pointToAngle(startPt, origin, xDir, yDir);
  const endAngle = _pointToAngle(endPt, origin, xDir, yDir);

  // Determine the arc direction (shortest arc or specific direction)
  let sweep = endAngle - startAngle;
  if (sweep <= -Math.PI) sweep += 2 * Math.PI;
  if (sweep > Math.PI) sweep -= 2 * Math.PI;

  // If nearly full circle, check
  const dist = _dist3D(startPt, endPt);
  if (dist < 1e-8) {
    sweep = 2 * Math.PI;
  }

  const numPts = Math.max(3, Math.ceil(Math.abs(sweep) / (2 * Math.PI) * segments));
  const points = [];

  for (let i = 0; i <= numPts; i++) {
    const t = i / numPts;
    const angle = startAngle + sweep * t;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    points.push({
      x: origin.x + radius * (cos * xDir.x + sin * yDir.x),
      y: origin.y + radius * (cos * xDir.y + sin * yDir.y),
      z: origin.z + radius * (cos * xDir.z + sin * yDir.z),
    });
  }

  return points;
}

/**
 * Sample points along an ELLIPSE arc.
 * ELLIPSE('', axis2_placement_ref, semi_axis_1, semi_axis_2)
 */
function _sampleEllipse(resolved, entity, startPt, endPt, segments) {
  const axisRef = entity.args[1];
  const semiA = Number(entity.args[2]);
  const semiB = Number(entity.args[3]);

  const axis = _getAxis2Placement3D(resolved, axisRef);
  if (!axis || !semiA || !semiB) return null;

  const { origin, zDir, xDir } = axis;
  const yDir = _cross(zDir, xDir);

  const startAngle = _pointToEllipseAngle(startPt, origin, xDir, yDir, semiA, semiB);
  const endAngle = _pointToEllipseAngle(endPt, origin, xDir, yDir, semiA, semiB);

  let sweep = endAngle - startAngle;
  if (sweep <= -Math.PI) sweep += 2 * Math.PI;
  if (sweep > Math.PI) sweep -= 2 * Math.PI;

  const dist = _dist3D(startPt, endPt);
  if (dist < 1e-8) {
    sweep = 2 * Math.PI;
  }

  const numPts = Math.max(3, Math.ceil(Math.abs(sweep) / (2 * Math.PI) * segments));
  const points = [];

  for (let i = 0; i <= numPts; i++) {
    const t = i / numPts;
    const angle = startAngle + sweep * t;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    points.push({
      x: origin.x + semiA * cos * xDir.x + semiB * sin * yDir.x,
      y: origin.y + semiA * cos * xDir.y + semiB * sin * yDir.y,
      z: origin.z + semiA * cos * xDir.z + semiB * sin * yDir.z,
    });
  }

  return points;
}

/**
 * Sample points along a B_SPLINE_CURVE_WITH_KNOTS.
 * B_SPLINE_CURVE_WITH_KNOTS('', degree, (cp_refs...), form, closed, self_intersect,
 *                            (knot_mults...), (knots...), knot_spec)
 */
function _sampleBSplineCurve(resolved, entity, startPt, endPt, segments) {
  // args: [name, degree, cp_list, form, closed, self_intersect, mults, knots, knot_spec]
  const degree = Number(entity.args[1]) || 1;
  const cpRefs = entity.args[2];
  const knotMults = entity.args[6];
  const knotVals = entity.args[7];

  if (!Array.isArray(cpRefs) || !Array.isArray(knotMults) || !Array.isArray(knotVals)) {
    return null;
  }

  // Resolve control points
  const controlPoints = [];
  for (const cpRef of cpRefs) {
    const pt = _getCartesianPoint(resolved, cpRef);
    if (!pt) return null;
    controlPoints.push(pt);
  }

  // Build full knot vector
  const knots = [];
  for (let i = 0; i < knotVals.length; i++) {
    const val = Number(knotVals[i]);
    const mult = Number(knotMults[i]) || 1;
    for (let m = 0; m < mult; m++) {
      knots.push(val);
    }
  }

  // Sample the B-spline curve
  const tMin = knots[degree];
  const tMax = knots[knots.length - 1 - degree];
  if (tMin >= tMax) return null;

  const numPts = Math.max(segments, 4);
  const points = [];

  for (let i = 0; i <= numPts; i++) {
    const t = tMin + (tMax - tMin) * (i / numPts);
    const pt = _evaluateBSpline(degree, knots, controlPoints, t);
    points.push(pt);
  }

  return points;
}

/**
 * Sample points along a RATIONAL_B_SPLINE_CURVE (NURBS).
 * Complex entity with merged args:
 *   [name, degree, cp_list, form, closed, self_int, mults, knots, knot_spec, weights]
 */
function _sampleRationalBSplineCurve(resolved, entity, startPt, endPt, segments) {
  // args: [name, degree, cp_list, form, closed, self_int, mults, knots, knot_spec, weights]
  const degree = Number(entity.args[1]) || 1;
  const cpRefs = entity.args[2];
  const knotMults = entity.args[6];
  const knotVals = entity.args[7];
  // weights is the last array arg (index 9 for rational)
  const weights = entity.args[9];

  if (!Array.isArray(cpRefs) || !Array.isArray(knotMults) || !Array.isArray(knotVals)) {
    return null;
  }

  const controlPoints = [];
  for (const cpRef of cpRefs) {
    const pt = _getCartesianPoint(resolved, cpRef);
    if (!pt) return null;
    controlPoints.push(pt);
  }

  const knots = [];
  for (let i = 0; i < knotVals.length; i++) {
    const val = Number(knotVals[i]);
    const mult = Number(knotMults[i]) || 1;
    for (let m = 0; m < mult; m++) knots.push(val);
  }

  // Parse weights (default to 1.0 if not available)
  const w = [];
  if (Array.isArray(weights)) {
    for (const wv of weights) w.push(Number(wv) || 1);
  }
  // If no valid weights or wrong count, fall back to non-rational
  if (w.length !== controlPoints.length) {
    return _sampleBSplineCurve(resolved, entity, startPt, endPt, segments);
  }

  const tMin = knots[degree];
  const tMax = knots[knots.length - 1 - degree];
  if (tMin >= tMax) return null;

  const numPts = Math.max(segments, 4);
  const points = [];

  for (let i = 0; i <= numPts; i++) {
    const t = tMin + (tMax - tMin) * (i / numPts);
    const pt = _evaluateRationalBSpline(degree, knots, controlPoints, w, t);
    points.push(pt);
  }

  return points;
}

/**
 * Evaluate a B-spline curve at parameter t using De Boor's algorithm.
 */
function _evaluateBSpline(degree, knots, controlPoints, t) {
  const n = controlPoints.length - 1;

  // Find the knot span index
  let k = degree;
  for (let i = degree; i <= n; i++) {
    if (t >= knots[i] && t < knots[i + 1]) {
      k = i;
      break;
    }
  }
  // Handle t == tMax
  if (t >= knots[n + 1]) k = n;

  // De Boor's algorithm
  const d = [];
  for (let j = 0; j <= degree; j++) {
    const idx = Math.min(Math.max(k - degree + j, 0), n);
    d.push({ ...controlPoints[idx] });
  }

  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const denom = knots[i + degree - r + 1] - knots[i];
      const alpha = denom > 1e-14 ? (t - knots[i]) / denom : 0;
      d[j] = {
        x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
        y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
        z: (1 - alpha) * d[j - 1].z + alpha * d[j].z,
      };
    }
  }

  return d[degree];
}

/**
 * Evaluate a rational B-spline (NURBS) curve at parameter t.
 * Uses the homogeneous De Boor algorithm.
 */
function _evaluateRationalBSpline(degree, knots, controlPoints, weights, t) {
  const n = controlPoints.length - 1;

  let k = degree;
  for (let i = degree; i <= n; i++) {
    if (t >= knots[i] && t < knots[i + 1]) { k = i; break; }
  }
  if (t >= knots[n + 1]) k = n;

  // Lift to homogeneous coordinates: (w*x, w*y, w*z, w)
  const d = [];
  for (let j = 0; j <= degree; j++) {
    const idx = Math.min(Math.max(k - degree + j, 0), n);
    const w = weights[idx];
    d.push({
      x: controlPoints[idx].x * w,
      y: controlPoints[idx].y * w,
      z: controlPoints[idx].z * w,
      w,
    });
  }

  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const denom = knots[i + degree - r + 1] - knots[i];
      const alpha = denom > 1e-14 ? (t - knots[i]) / denom : 0;
      d[j] = {
        x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
        y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
        z: (1 - alpha) * d[j - 1].z + alpha * d[j].z,
        w: (1 - alpha) * d[j - 1].w + alpha * d[j].w,
      };
    }
  }

  const result = d[degree];
  const invW = result.w > 1e-14 ? 1 / result.w : 0;
  return { x: result.x * invW, y: result.y * invW, z: result.z * invW };
}

// =====================================================================
// Surface normal extraction
// =====================================================================

/**
 * Extract surface normal from a surface entity (for correct face winding).
 */
function _extractSurfaceNormal(resolved, surfaceRef) {
  const surf = _getEntity(resolved, surfaceRef);
  if (!surf) return null;

  switch (surf.type) {
    case 'PLANE': {
      const axis = _getAxis2Placement3D(resolved, surf.args[1]);
      return axis ? axis.zDir : null;
    }
    case 'CYLINDRICAL_SURFACE':
    case 'CONICAL_SURFACE':
    case 'SPHERICAL_SURFACE':
    case 'TOROIDAL_SURFACE': {
      // For curved surfaces, the polygon normal is more reliable
      return null;
    }
    default:
      return null;
  }
}

/**
 * Extract surface geometric info needed for per-vertex normal computation.
 * Returns an object with { type, origin, axis, radius } for analytic surfaces,
 * or null if the surface type is not supported for vertex normals.
 */
function _extractSurfaceInfo(resolved, surfaceRef) {
  const surf = _getEntity(resolved, surfaceRef);
  if (!surf) return null;

  switch (surf.type) {
    case 'CYLINDRICAL_SURFACE': {
      const axis = _getAxis2Placement3D(resolved, surf.args[1]);
      const radius = Number(surf.args[2]);
      if (!axis || !radius) return null;
      return { type: 'cylinder', origin: axis.origin, axis: axis.zDir, radius };
    }
    case 'SPHERICAL_SURFACE': {
      const axis = _getAxis2Placement3D(resolved, surf.args[1]);
      const radius = Number(surf.args[2]);
      if (!axis || !radius) return null;
      return { type: 'sphere', origin: axis.origin, radius };
    }
    case 'CONICAL_SURFACE': {
      const axis = _getAxis2Placement3D(resolved, surf.args[1]);
      const radius = Number(surf.args[2]);
      const semiAngle = Number(surf.args[3]) || 0;
      if (!axis) return null;
      return { type: 'cone', origin: axis.origin, axis: axis.zDir, radius, semiAngle };
    }
    case 'TOROIDAL_SURFACE': {
      const axis = _getAxis2Placement3D(resolved, surf.args[1]);
      const majorR = Number(surf.args[2]);
      const minorR = Number(surf.args[3]);
      if (!axis || !majorR || !minorR) return null;
      return { type: 'torus', origin: axis.origin, axis: axis.zDir, majorR, minorR };
    }
    default:
      return null;
  }
}

/**
 * Compute the outward surface normal at a vertex position, using the
 * analytic surface definition. For cylinder, it's the radial direction
 * perpendicular to the axis. For sphere, it's the direction from center.
 *
 * @param {{x,y,z}} vertex - vertex position
 * @param {Object} surfaceInfo - from _extractSurfaceInfo
 * @param {boolean} sameSense - face orientation relative to surface
 * @returns {{x,y,z}} unit normal
 */
function _computeVertexNormal(vertex, surfaceInfo, sameSense) {
  let n;

  switch (surfaceInfo.type) {
    case 'cylinder': {
      // Radial direction: project (vertex - origin) onto plane perpendicular to axis
      const dx = vertex.x - surfaceInfo.origin.x;
      const dy = vertex.y - surfaceInfo.origin.y;
      const dz = vertex.z - surfaceInfo.origin.z;
      const ax = surfaceInfo.axis.x, ay = surfaceInfo.axis.y, az = surfaceInfo.axis.z;
      const dot = dx * ax + dy * ay + dz * az;
      n = _normalize({ x: dx - dot * ax, y: dy - dot * ay, z: dz - dot * az });
      break;
    }
    case 'sphere': {
      // Direction from center to vertex
      n = _normalize({
        x: vertex.x - surfaceInfo.origin.x,
        y: vertex.y - surfaceInfo.origin.y,
        z: vertex.z - surfaceInfo.origin.z,
      });
      break;
    }
    case 'cone': {
      // For a cone, the normal is perpendicular to the surface at the vertex
      const dx = vertex.x - surfaceInfo.origin.x;
      const dy = vertex.y - surfaceInfo.origin.y;
      const dz = vertex.z - surfaceInfo.origin.z;
      const ax = surfaceInfo.axis.x, ay = surfaceInfo.axis.y, az = surfaceInfo.axis.z;
      const axialDist = dx * ax + dy * ay + dz * az;
      // Radial component
      const rx = dx - axialDist * ax;
      const ry = dy - axialDist * ay;
      const rz = dz - axialDist * az;
      const radialLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (radialLen < 1e-14) {
        n = { x: ax, y: ay, z: az };
      } else {
        const cosA = Math.cos(surfaceInfo.semiAngle);
        const sinA = Math.sin(surfaceInfo.semiAngle);
        // Normal = radial * cos(semiAngle) - axis * sin(semiAngle)
        n = _normalize({
          x: (rx / radialLen) * cosA - ax * sinA,
          y: (ry / radialLen) * cosA - ay * sinA,
          z: (rz / radialLen) * cosA - az * sinA,
        });
      }
      break;
    }
    case 'torus': {
      // For a torus, project onto the major circle, then compute minor circle normal
      const dx = vertex.x - surfaceInfo.origin.x;
      const dy = vertex.y - surfaceInfo.origin.y;
      const dz = vertex.z - surfaceInfo.origin.z;
      const ax = surfaceInfo.axis.x, ay = surfaceInfo.axis.y, az = surfaceInfo.axis.z;
      const axialDist = dx * ax + dy * ay + dz * az;
      const rx = dx - axialDist * ax;
      const ry = dy - axialDist * ay;
      const rz = dz - axialDist * az;
      const radialLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (radialLen < 1e-14) {
        n = { x: ax, y: ay, z: az }; // Fallback to torus axis for degenerate case
      } else {
        // Center of the minor circle
        const cx = surfaceInfo.origin.x + (rx / radialLen) * surfaceInfo.majorR;
        const cy = surfaceInfo.origin.y + (ry / radialLen) * surfaceInfo.majorR;
        const cz = surfaceInfo.origin.z + (rz / radialLen) * surfaceInfo.majorR;
        n = _normalize({
          x: vertex.x - cx,
          y: vertex.y - cy,
          z: vertex.z - cz,
        });
      }
      break;
    }
    default:
      return { x: 0, y: 0, z: 1 };
  }

  if (!sameSense) {
    n = { x: -n.x, y: -n.y, z: -n.z };
  }
  return n;
}

// =====================================================================
// AXIS2_PLACEMENT_3D helper
// =====================================================================

/**
 * Resolve an AXIS2_PLACEMENT_3D entity.
 * AXIS2_PLACEMENT_3D('', location, axis, ref_direction)
 */
function _getAxis2Placement3D(resolved, ref) {
  const ent = _getEntity(resolved, ref);
  if (!ent || ent.type !== 'AXIS2_PLACEMENT_3D') return null;

  const origin = _getCartesianPoint(resolved, ent.args[1]);
  if (!origin) return null;

  let zDir = _getDirection(resolved, ent.args[2]);
  if (!zDir) zDir = { x: 0, y: 0, z: 1 };

  let xDir = _getDirection(resolved, ent.args[3]);
  if (!xDir) xDir = _perpendicular(zDir);

  // Normalize
  zDir = _normalize(zDir);
  xDir = _normalize(xDir);

  return { origin, zDir, xDir };
}

// =====================================================================
// Geometry helpers
// =====================================================================

function _cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function _normalize(v) {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len < 1e-14) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function _dist3D(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function _perpendicular(n) {
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  let ref;
  if (ax <= ay && ax <= az) ref = { x: 1, y: 0, z: 0 };
  else if (ay <= az) ref = { x: 0, y: 1, z: 0 };
  else ref = { x: 0, y: 0, z: 1 };
  return _normalize(_cross(n, ref));
}

/**
 * Project a 3D point onto a circle's plane and return its angle.
 */
function _pointToAngle(pt, origin, xDir, yDir) {
  const dx = pt.x - origin.x;
  const dy = pt.y - origin.y;
  const dz = pt.z - origin.z;
  const u = dx * xDir.x + dy * xDir.y + dz * xDir.z;
  const v = dx * yDir.x + dy * yDir.y + dz * yDir.z;
  return Math.atan2(v, u);
}

/**
 * Project a 3D point onto an ellipse's plane and return the parametric angle.
 */
function _pointToEllipseAngle(pt, origin, xDir, yDir, semiA, semiB) {
  const dx = pt.x - origin.x;
  const dy = pt.y - origin.y;
  const dz = pt.z - origin.z;
  const u = dx * xDir.x + dy * xDir.y + dz * xDir.z;
  const v = dx * yDir.x + dy * yDir.y + dz * yDir.z;
  return Math.atan2(v / semiB, u / semiA);
}

// =====================================================================
// Polygon triangulation (ear clipping)
// =====================================================================

/**
 * Compute polygon normal using Newell's method.
 */
function _computePolygonNormal(polygon) {
  const n = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < polygon.length; i++) {
    const curr = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    n.x += (curr.y - next.y) * (curr.z + next.z);
    n.y += (curr.z - next.z) * (curr.x + next.x);
    n.z += (curr.x - next.x) * (curr.y + next.y);
  }
  return _normalize(n);
}

/**
 * Triangulate a 3D polygon using ear clipping.
 * @returns {Array<[{x,y,z},{x,y,z},{x,y,z}]>} Array of triangles
 */
function _triangulatePolygon(polygon, normal) {
  if (polygon.length < 3) return [];
  if (polygon.length === 3) return [[polygon[0], polygon[1], polygon[2]]];

  // Project to 2D for ear clipping
  const pts2d = _projectTo2D(polygon, normal);

  // Determine winding
  let area = 0;
  for (let i = 0; i < pts2d.length; i++) {
    const j = (i + 1) % pts2d.length;
    area += pts2d[i].x * pts2d[j].y - pts2d[j].x * pts2d[i].y;
  }
  const winding = area >= 0 ? 1 : -1;

  const remaining = polygon.map((_, i) => i);
  const triangles = [];
  let guard = 0;
  const maxGuard = polygon.length * polygon.length;

  while (remaining.length > 3 && guard < maxGuard) {
    let earFound = false;

    for (let ri = 0; ri < remaining.length; ri++) {
      const prevIdx = remaining[(ri - 1 + remaining.length) % remaining.length];
      const currIdx = remaining[ri];
      const nextIdx = remaining[(ri + 1) % remaining.length];

      const a = pts2d[prevIdx];
      const b = pts2d[currIdx];
      const c = pts2d[nextIdx];

      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross * winding <= 1e-10) continue;

      let containsOther = false;
      for (const other of remaining) {
        if (other === prevIdx || other === currIdx || other === nextIdx) continue;
        if (_pointInTriangle2D(pts2d[other], a, b, c, winding)) {
          containsOther = true;
          break;
        }
      }
      if (containsOther) continue;

      triangles.push([polygon[prevIdx], polygon[currIdx], polygon[nextIdx]]);
      remaining.splice(ri, 1);
      earFound = true;
      break;
    }

    if (!earFound) break;
    guard++;
  }

  // Handle remaining triangle
  if (remaining.length === 3) {
    triangles.push([polygon[remaining[0]], polygon[remaining[1]], polygon[remaining[2]]]);
  }

  return triangles;
}

/**
 * Project 3D points to 2D for triangulation.
 */
function _projectTo2D(polygon, normal) {
  const an = { x: Math.abs(normal.x), y: Math.abs(normal.y), z: Math.abs(normal.z) };

  if (an.z >= an.x && an.z >= an.y) {
    return polygon.map(v => ({ x: v.x, y: v.y }));
  }
  if (an.y >= an.x) {
    return polygon.map(v => ({ x: v.x, y: v.z }));
  }
  return polygon.map(v => ({ x: v.y, y: v.z }));
}

/**
 * Test if a point is inside a triangle (2D, with winding direction).
 */
function _pointInTriangle2D(p, a, b, c, winding) {
  const c1 = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) * winding;
  const c2 = ((c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x)) * winding;
  const c3 = ((a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x)) * winding;
  return c1 >= -1e-8 && c2 >= -1e-8 && c3 >= -1e-8;
}

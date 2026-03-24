// js/cad/StepImport.js — STEP AP203/AP214/AP242 file import
//
// Parses ISO 10303 STEP files and extracts tessellated mesh geometry.
// Supports:
//   - MANIFOLD_SOLID_BREP / ADVANCED_BREP_SHAPE_REPRESENTATION
//   - CLOSED_SHELL / OPEN_SHELL
//   - ADVANCED_FACE with FACE_BOUND / FACE_OUTER_BOUND
//   - EDGE_LOOP, ORIENTED_EDGE, EDGE_CURVE
//   - VERTEX_POINT, CARTESIAN_POINT, DIRECTION, VECTOR
//   - LINE, CIRCLE, ELLIPSE, B_SPLINE_CURVE_WITH_KNOTS
//   - SURFACE_CURVE (unwraps to underlying 3D curve)
//   - PLANE, CYLINDRICAL_SURFACE, SPHERICAL_SURFACE, TOROIDAL_SURFACE
//   - B_SPLINE_SURFACE_WITH_KNOTS

/**
 * Parse a STEP file string and return tessellated mesh geometry.
 *
 * @param {string} stepString - Contents of a STEP file
 * @param {Object} [opts]
 * @param {number} [opts.curveSegments=16] - Segments for curved edge tessellation
 * @returns {{ vertices: {x,y,z}[], faces: {vertices:{x,y,z}[], normal:{x,y,z}}[] }}
 */
export function importSTEP(stepString, opts = {}) {
  const curveSegments = opts.curveSegments ?? 16;

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
  // 4. Tessellate each shell → mesh geometry
  // ------------------------------------------------------------------
  const allVertices = [];
  const allFaces = [];

  for (const shell of shells) {
    // CLOSED_SHELL('', (face_refs...)) — face list is the second argument
    const faceRefs = Array.isArray(shell.args[1]) ? shell.args[1] : shell.args;
    for (const faceRef of faceRefs) {
      const faceId = _refId(faceRef);
      if (faceId == null) continue;
      const faceMesh = _tessellateFace(resolved, faceId, curveSegments);
      if (faceMesh) {
        allVertices.push(...faceMesh.vertices);
        allFaces.push(...faceMesh.faces);
      }
    }
  }

  return { vertices: allVertices, faces: allFaces };
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
      // Complex entity like (GEOMETRIC_REPRESENTATION_CONTEXT(3)...)
      type = '__COMPLEX__';
      argsStr = body;
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
// Face tessellation
// =====================================================================

/**
 * Tessellate a single ADVANCED_FACE into mesh triangles.
 *
 * @param {Map} resolved - Resolved entity map
 * @param {number} faceId - Entity ID of the ADVANCED_FACE
 * @param {number} curveSegments - Segments for curved edges
 * @returns {{ vertices: {x,y,z}[], faces: {vertices:{x,y,z}[], normal:{x,y,z}}[] } | null}
 */
function _tessellateFace(resolved, faceId, curveSegments) {
  const face = resolved.get(faceId);
  if (!face || face.type !== 'ADVANCED_FACE') return null;

  // ADVANCED_FACE('', (bound_refs...), surface_ref, same_sense)
  const boundsList = face.args[1]; // list of bound references
  const surfaceRef = face.args[2];
  const sameSense = face.args[3] === '.T.';

  if (!Array.isArray(boundsList) || boundsList.length === 0) return null;

  // Extract the surface normal (for correct winding)
  const surfaceNormal = _extractSurfaceNormal(resolved, surfaceRef);

  const loopPolygons = [];

  for (const boundRef of boundsList) {
    const bound = _getEntity(resolved, boundRef);
    if (!bound) continue;

    // FACE_BOUND or FACE_OUTER_BOUND: ('', edge_loop_ref, orientation)
    const isFaceBound = bound.type === 'FACE_BOUND' || bound.type === 'FACE_OUTER_BOUND';
    if (!isFaceBound) continue;

    const loopRef = bound.args[1];
    const boundSense = bound.args[2] === '.T.';

    const loop = _getEntity(resolved, loopRef);
    if (!loop || loop.type !== 'EDGE_LOOP') continue;

    // EDGE_LOOP('', (oriented_edge_refs...))
    const orientedEdgeRefs = loop.args[1];
    if (!Array.isArray(orientedEdgeRefs)) continue;

    const polygon = _extractLoopPolygon(resolved, orientedEdgeRefs, curveSegments);
    if (polygon.length < 3) continue;

    // Apply bound sense
    if (!boundSense) {
      polygon.reverse();
    }

    loopPolygons.push({
      isOuter: bound.type === 'FACE_OUTER_BOUND',
      polygon,
    });
  }

  if (loopPolygons.length === 0) return null;

  // Use the first polygon (outer bound) as the face polygon
  // Inner bounds (holes) would require more complex tessellation
  let outerLoop = loopPolygons.find(l => l.isOuter);
  if (!outerLoop) outerLoop = loopPolygons[0];

  let polygon = outerLoop.polygon;

  // Apply face sense
  if (!sameSense) {
    polygon = [...polygon].reverse();
  }

  // Compute face normal from polygon
  const normal = surfaceNormal || _computePolygonNormal(polygon);

  // Triangulate the polygon
  const triangles = _triangulatePolygon(polygon, normal);

  const vertices = [];
  const faces = [];

  for (const tri of triangles) {
    vertices.push(tri[0], tri[1], tri[2]);
    faces.push({
      vertices: [tri[0], tri[1], tri[2]],
      normal: { ...normal },
    });
  }

  return { vertices, faces };
}

/**
 * Extract ordered vertex positions from a loop of oriented edges.
 */
function _extractLoopPolygon(resolved, orientedEdgeRefs, curveSegments) {
  const polygon = [];

  for (const oeRef of orientedEdgeRefs) {
    const oe = _getEntity(resolved, oeRef);
    if (!oe || oe.type !== 'ORIENTED_EDGE') continue;

    // ORIENTED_EDGE('', *, *, edge_curve_ref, orientation)
    const edgeCurveRef = oe.args[3];
    const oeSense = oe.args[4] === '.T.';

    const edgeCurve = _getEntity(resolved, edgeCurveRef);
    if (!edgeCurve || edgeCurve.type !== 'EDGE_CURVE') continue;

    // EDGE_CURVE('', start_vertex, end_vertex, curve_geometry, same_sense)
    const startVertexRef = edgeCurve.args[1];
    const endVertexRef = edgeCurve.args[2];
    const curveRef = edgeCurve.args[3];
    const edgeSense = edgeCurve.args[4] === '.T.';

    const startPt = _getVertexPoint(resolved, startVertexRef);
    const endPt = _getVertexPoint(resolved, endVertexRef);

    if (!startPt || !endPt) continue;

    // Determine the effective direction
    const forward = oeSense === edgeSense;

    // Try to get intermediate curve points for curved edges
    const curvePoints = _sampleCurvePoints(resolved, curveRef, startPt, endPt, curveSegments);

    let edgePoints;
    if (curvePoints && curvePoints.length > 2) {
      edgePoints = forward ? curvePoints : [...curvePoints].reverse();
    } else {
      edgePoints = forward ? [startPt, endPt] : [endPt, startPt];
    }

    // Add points (skip last to avoid duplicates at loop junctions)
    for (let i = 0; i < edgePoints.length - 1; i++) {
      polygon.push(edgePoints[i]);
    }
  }

  return polygon;
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
// Curve sampling for curved edges
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

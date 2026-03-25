// js/cad/StepImport.js — STEP AP203/AP214/AP242 file import
//
// Parses ISO 10303 STEP files and extracts exact NURBS/B-Rep topology as
// the primary output.  Tessellation is a separate post-processing step
// used only for UI display — see ARCHITECTURE.md, Rules 1-4.
//
// Public API:
//   parseSTEPTopology(stepString) → TopoBody   (exact topology, no mesh)
//   importSTEP(stepString, opts)  → { body, vertices, faces }  (convenience)
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

/** Snap a coordinate to 0 if it's within floating-point noise of zero. */
function _snapZero(v) { return Math.abs(v) < 1e-12 ? 0 : v; }
/** Snap an {x,y,z} point's coordinates to avoid -0 / tiny-epsilon issues. */
function _snapPoint(p) { return { x: _snapZero(p.x), y: _snapZero(p.y), z: _snapZero(p.z) }; }

/**
 * Parse a STEP file and extract the exact NURBS/B-Rep topology.
 *
 * This is the primary import entry point.  It builds a complete TopoBody
 * with NurbsSurface on every face and NurbsCurve on every edge — no
 * tessellation is performed.  Call {@link tessellateBody} afterwards to
 * obtain a display mesh.
 *
 * @param {string} stepString - Contents of a STEP file
 * @returns {TopoBody} Exact B-Rep topology body
 */
export function parseSTEPTopology(stepString) {
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
  // 4. Build exact B-Rep topology (no tessellation)
  // ------------------------------------------------------------------
  const topoShells = [];

  for (const shell of shells) {
    const faceRefs = Array.isArray(shell.args[1]) ? shell.args[1] : shell.args;
    const topoFaces = [];

    for (const faceRef of faceRefs) {
      const faceId = _refId(faceRef);
      if (faceId == null) continue;

      const topoFace = _buildFaceTopology(resolved, faceId);
      if (topoFace) topoFaces.push(topoFace);
    }

    const topoShell = new TopoShell(topoFaces);
    topoShell.closed = shell.type === 'CLOSED_SHELL';
    topoShells.push(topoShell);
  }

  if (topoShells.length === 0) {
    throw new Error('No solid geometry found in STEP file. The file may contain only surface data or use an unsupported representation.');
  }

  return new TopoBody(topoShells);
}

/**
 * Tessellate a STEP-imported TopoBody into a display mesh.
 *
 * This is a STEP-optimized tessellator that produces faceGroup indices,
 * isCurved flags for smooth shading, and analytic per-vertex normals
 * for curved surfaces.  For general B-Rep tessellation see
 * {@link import('./Tessellation.js').tessellateBody}.
 *
 * The resulting mesh is suitable for rendering but must NOT be used
 * for further feature operations — see ARCHITECTURE.md, Rule 2.
 *
 * @param {TopoBody} body - Exact B-Rep topology body
 * @param {Object} [opts]
 * @param {number} [opts.curveSegments=64] - Segments for curved edge tessellation
 * @param {number} [opts.surfaceSegments=16] - Segments per axis for B-spline surface tessellation
 * @returns {{ vertices: {x,y,z}[], faces: {vertices:{x,y,z}[], normal:{x,y,z}}[] }}
 */
function _tessellateSTEPBody(body, opts = {}) {
  const curveSegments = opts.curveSegments ?? 64;
  const surfaceSegments = opts.surfaceSegments ?? 16;

  const allVertices = [];
  const allFaces = [];
  let faceGroupCounter = 0;

  for (const topoFace of body.faces()) {
    const result = _tessellateFace(topoFace, curveSegments, surfaceSegments, faceGroupCounter);
    if (result) {
      allVertices.push(...result.vertices);
      allFaces.push(...result.faces);
    }
    faceGroupCounter++;
  }

  return { vertices: allVertices, faces: allFaces };
}

/**
 * Parse a STEP file and return both exact B-Rep topology and a display mesh.
 *
 * Convenience wrapper that calls {@link parseSTEPTopology} to extract the
 * complete topology, then tessellates it for display.  The `body` (TopoBody)
 * is the primary output; `vertices` and `faces` are secondary display-only
 * data — see ARCHITECTURE.md, Rule 2.
 *
 * @param {string} stepString - Contents of a STEP file
 * @param {Object} [opts]
 * @param {number} [opts.curveSegments=64] - Segments for curved edge tessellation
 * @param {number} [opts.surfaceSegments=16] - Segments for surface tessellation
 * @returns {{ body: TopoBody, vertices: {x,y,z}[], faces: {vertices:{x,y,z}[], normal:{x,y,z}}[] }}
 */
export function importSTEP(stepString, opts = {}) {
  const body = parseSTEPTopology(stepString);
  const mesh = _tessellateSTEPBody(body, opts);
  return { body, vertices: mesh.vertices, faces: mesh.faces };
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
// Face topology extraction (Phase 1 — no tessellation)
// =====================================================================

/**
 * Build a TopoFace from a single ADVANCED_FACE entity.
 *
 * Extracts exact NURBS/B-Rep topology only — no mesh tessellation.
 * The returned TopoFace carries:
 *   - NurbsSurface (support surface)
 *   - surfaceType / surfaceInfo for analytic surfaces
 *   - TopoLoops with TopoCoEdges/TopoEdges carrying NurbsCurves
 *
 * @param {Map} resolved - Resolved entity map
 * @param {number} faceId - Entity ID of the ADVANCED_FACE
 * @returns {TopoFace|null}
 */
function _buildFaceTopology(resolved, faceId) {
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

  // Extract analytic surface geometry (axis, center, radius, etc.)
  const surfaceInfo = _extractSurfaceInfo(resolved, surfaceRef);

  // Build topology loops
  const loopEntries = [];
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

    const coedges = _buildLoopTopology(resolved, orientedEdgeRefs);
    if (!coedges || coedges.length === 0) continue;

    if (!boundSense) {
      coedges.reverse();
      for (const ce of coedges) ce.sameSense = !ce.sameSense;
    }

    loopEntries.push({
      isOuter: bound.type === 'FACE_OUTER_BOUND',
      topoLoop: new TopoLoop(coedges),
    });
  }

  if (loopEntries.length === 0) return null;

  // Build TopoFace with all topology data
  const topoFace = new TopoFace(nurbsSurface, surfaceType, sameSense);
  topoFace.surfaceInfo = surfaceInfo;

  const outerEntry = loopEntries.find(l => l.isOuter) || loopEntries[0];
  topoFace.setOuterLoop(outerEntry.topoLoop);
  for (const le of loopEntries) {
    if (le !== outerEntry) topoFace.addInnerLoop(le.topoLoop);
  }

  return topoFace;
}

/**
 * Build topology coedges from an EDGE_LOOP's ORIENTED_EDGE references.
 *
 * Creates TopoVertex → TopoEdge (with NurbsCurve) → TopoCoEdge chain.
 * No curve sampling or tessellation is performed.
 *
 * @param {Map} resolved - Resolved entity map
 * @param {Array} orientedEdgeRefs - References to ORIENTED_EDGE entities
 * @returns {TopoCoEdge[]}
 */
function _buildLoopTopology(resolved, orientedEdgeRefs) {
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

    // Build NurbsCurve from the edge geometry (exact representation)
    const nurbsCurve = _buildNurbsCurve(resolved, curveRef, startPt, endPt);

    // Create topology elements
    const sv = new TopoVertex(forward ? startPt : endPt);
    const ev = new TopoVertex(forward ? endPt : startPt);
    const topoEdge = new TopoEdge(sv, ev, nurbsCurve);
    const coedge = new TopoCoEdge(topoEdge, forward);
    coedges.push(coedge);
  }

  return coedges;
}

// =====================================================================
// Face tessellation (Phase 2 — post-processing for display only)
// =====================================================================

/**
 * Tessellate a TopoFace into display mesh triangles.
 *
 * Works entirely from the exact topology data stored on the TopoFace
 * (NurbsSurface, NurbsCurves, surfaceInfo) — no STEP entity access.
 *
 * @param {TopoFace} topoFace - Exact B-Rep face
 * @param {number} curveSegments - Segments for curved edges
 * @param {number} surfaceSegments - Segments for surface tessellation
 * @param {number} faceGroup - Face group index for smooth shading
 * @returns {{ vertices:{x,y,z}[], faces:{vertices:{x,y,z}[], normal:{x,y,z}}[] }|null}
 */
function _tessellateFace(topoFace, curveSegments, surfaceSegments, faceGroup) {
  const { surface: nurbsSurface, surfaceType, sameSense, surfaceInfo } = topoFace;

  // Tessellate outer loop boundary polygon from topology curves
  const outerLoop = topoFace.outerLoop;
  if (!outerLoop) return null;

  const outerTess = _tessellateLoop(outerLoop, curveSegments);
  if (!outerTess || outerTess.polygon.length < 3) return null;

  // Remove duplicate consecutive points that arise when adjacent edges
  // share a vertex and both emit it (common with curve-less seam edges).
  const polygon = _deduplicateConsecutive(outerTess.polygon);
  if (polygon.length < 3) return null;

  const edgeBounds = outerTess.edgeBounds;

  // Compute a surface normal for face winding
  const surfaceNormal = _surfaceNormalFromTopology(topoFace, polygon);

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
    // Boundary-based tessellation: triangulate the trimmed boundary polygon,
    // then subdivide large triangles so the mesh conforms to the curved
    // surface instead of cutting across it in flat planes.
    const faceNormal = _computeCurvedFaceNormal(surfaceNormal, nurbsSurface, polygon, sameSense);
    let triangles = _triangulatePolygon(polygon, faceNormal);

    // Subdivide: split triangles whose midpoint deviates from the surface.
    // Each triangle midpoint is projected onto the NURBS surface; if the
    // deviation exceeds a threshold the triangle is split into 4 sub-tris.
    triangles = _subdivideBSplineTriangles(triangles, nurbsSurface, surfaceSegments);

    for (const tri of triangles) {
      const triNormals = tri.map(v => {
        const uv = nurbsSurface.closestPointUV(v);
        const n = nurbsSurface.normal(uv.u, uv.v);
        return sameSense ? n : { x: -n.x, y: -n.y, z: -n.z };
      });
      const cn = {
        x: (triNormals[0].x + triNormals[1].x + triNormals[2].x) / 3,
        y: (triNormals[0].y + triNormals[1].y + triNormals[2].y) / 3,
        z: (triNormals[0].z + triNormals[1].z + triNormals[2].z) / 3,
      };
      meshFaces.push({
        vertices: [tri[0], tri[1], tri[2]],
        normal: _normalize(cn),
        isCurved: true,
        faceGroup,
      });
      meshVertices.push(tri[0], tri[1], tri[2]);
    }
  } else if (isCurvedFace && surfaceInfo) {
    // Try strip tessellation for curved faces with paired arc edges
    const stripResult = _tessellateStripFromEdgeBounds(polygon, edgeBounds, surfaceInfo, sameSense, faceGroup);
    if (stripResult) {
      meshFaces = stripResult.faces;
      meshVertices = stripResult.vertices;
    } else {
      // Fall back to polygon-based tessellation with per-vertex normals
      const faceNormal = _computeCurvedFaceNormal(surfaceNormal, nurbsSurface, polygon, sameSense);
      const triangles = _triangulatePolygon(polygon, faceNormal);
      for (const tri of triangles) {
        const triNormals = tri.map(v => _computeVertexNormal(v, surfaceInfo, sameSense));
        const cn = {
          x: (triNormals[0].x + triNormals[1].x + triNormals[2].x) / 3,
          y: (triNormals[0].y + triNormals[1].y + triNormals[2].y) / 3,
          z: (triNormals[0].z + triNormals[1].z + triNormals[2].z) / 3,
        };
        meshFaces.push({
          vertices: [tri[0], tri[1], tri[2]],
          normal: _normalize(cn),
          isCurved: true,
          faceGroup,
        });
        meshVertices.push(tri[0], tri[1], tri[2]);
      }
    }
  } else {
    // Polygon-based tessellation (planar faces)
    let faceNormal;
    if (surfaceNormal) {
      faceNormal = sameSense
        ? surfaceNormal
        : { x: -surfaceNormal.x, y: -surfaceNormal.y, z: -surfaceNormal.z };
    } else if (nurbsSurface) {
      const midU = (nurbsSurface.uMin + nurbsSurface.uMax) / 2;
      const midV = (nurbsSurface.vMin + nurbsSurface.vMax) / 2;
      const sn = nurbsSurface.normal(midU, midV);
      faceNormal = sameSense ? sn : { x: -sn.x, y: -sn.y, z: -sn.z };
    } else {
      faceNormal = _computePolygonNormal(polygon);
    }

    const triangles = _triangulatePolygon(polygon, faceNormal);
    for (const tri of triangles) {
      meshFaces.push({
        vertices: [tri[0], tri[1], tri[2]],
        normal: { ...faceNormal },
        faceGroup,
      });
      meshVertices.push(tri[0], tri[1], tri[2]);
    }
  }

  // Tag every mesh face with its TopoFace origin so that
  // assignCoplanarFaceGroups does not merge faces across STEP boundaries.
  for (const f of meshFaces) {
    f.topoFaceId = faceGroup;
  }

  return { vertices: meshVertices, faces: meshFaces };
}

/**
 * Tessellate a TopoLoop into a polygon boundary and edge bounds.
 *
 * Samples each edge's NurbsCurve to produce display-quality polygon points.
 * Works entirely from topology data — no STEP entity access.
 *
 * @param {TopoLoop} topoLoop
 * @param {number} curveSegments - Segments for curved edge sampling
 * @returns {{ polygon:{x,y,z}[], edgeBounds:{ start:number, count:number, isArc:boolean }[] }|null}
 */
function _tessellateLoop(topoLoop, curveSegments) {
  const polygon = [];
  const edgeBounds = [];

  for (const coedge of topoLoop.coedges) {
    const edge = coedge.edge;
    const forward = coedge.sameSense;
    const curve = edge.curve;

    // Determine if this is a non-linear curve that needs sampling
    const isLinear = !curve ||
      (curve.degree === 1 && curve.controlPoints.length === 2);

    let edgePoints;
    let isArc = false;

    if (!isLinear) {
      // Sample the NURBS curve from topology.
      // The NurbsCurve is parameterized in the original STEP curve direction.
      // When coedge.sameSense is false, the loop traverses the curve in
      // reverse, so we reverse the sampled points.
      const curvePoints = curve.tessellate(curveSegments);
      isArc = curvePoints.length > 2;
      edgePoints = forward ? curvePoints : [...curvePoints].reverse();
    } else {
      // Straight edge: use the curve's natural endpoints to determine
      // direction.  The NurbsCurve was built from the STEP EDGE_CURVE's
      // start→end vertex, while edge.startVertex/endVertex may have been
      // swapped during _buildLoopTopology.  When FACE_BOUND sense flips
      // the coedge sameSense, the relationship between sv/ev and the
      // curve direction can become inconsistent.  Using the curve's own
      // control points (which always reflect the STEP curve direction)
      // and applying the sameSense flag gives the correct loop direction.
      if (curve) {
        const cp = curve.controlPoints;
        const p0 = cp[0];
        const p1 = cp[cp.length - 1];
        edgePoints = forward ? [p0, p1] : [p1, p0];
      } else {
        const sp = edge.startVertex.point;
        const ep = edge.endVertex.point;
        edgePoints = [sp, ep];
      }
    }

    const edgeStart = polygon.length;
    for (let i = 0; i < edgePoints.length - 1; i++) {
      polygon.push(edgePoints[i]);
    }
    edgeBounds.push({ start: edgeStart, count: edgePoints.length - 1, isArc });
  }

  return { polygon, edgeBounds };
}

/**
 * Derive a surface normal from topology data for face winding.
 * For planes, uses the NurbsSurface or surfaceInfo. For other types,
 * returns null (polygon normal or per-vertex normals are used instead).
 */
function _surfaceNormalFromTopology(topoFace, polygon) {
  const { surface, surfaceType } = topoFace;

  if (surfaceType === SurfaceType.PLANE) {
    // For plane surfaces, derive normal from the surface or polygon
    if (surface) {
      const midU = (surface.uMin + surface.uMax) / 2;
      const midV = (surface.vMin + surface.vMax) / 2;
      return surface.normal(midU, midV);
    }
    return _computePolygonNormal(polygon);
  }
  // For curved surfaces, return null — vertex normals are computed analytically
  return null;
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

  return _snapPoint({
    x: Number(coords[0]) || 0,
    y: Number(coords[1]) || 0,
    z: Number(coords[2]) || 0,
  });
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

    case 'ELLIPSE': {
      // Represent the ellipse arc as a polyline NurbsCurve by sampling
      const pts = _sampleEllipse(resolved, geomCurve, startPt, endPt, 64);
      if (!pts || pts.length < 2) return NurbsCurve.createLine(startPt, endPt);
      return NurbsCurve.createPolyline(pts);
    }

    default:
      // Fallback: create a straight line so the edge direction is handled
      // correctly by _tessellateLoop (curve reversal via sameSense).
      return NurbsCurve.createLine(startPt, endPt);
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
    points.push(_snapPoint({
      x: origin.x + radius * (cos * xDir.x + sin * yDir.x),
      y: origin.y + radius * (cos * xDir.y + sin * yDir.y),
      z: origin.z + radius * (cos * xDir.z + sin * yDir.z),
    }));
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
    points.push(_snapPoint({
      x: origin.x + semiA * cos * xDir.x + semiB * sin * yDir.x,
      y: origin.y + semiA * cos * xDir.y + semiB * sin * yDir.y,
      z: origin.z + semiA * cos * xDir.z + semiB * sin * yDir.z,
    }));
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
    points.push(_snapPoint(pt));
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
    points.push(_snapPoint(pt));
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

/**
 * Remove duplicate consecutive points from a polygon (including
 * wrap-around: last point vs first point).
 * Uses a squared-distance tolerance in model units to detect coincident vertices.
 */
function _deduplicateConsecutive(polygon) {
  if (polygon.length < 2) return polygon;
  const out = [];
  // Coincident vertex tolerance (model units) — matches STEP geometry precision
  const COINCIDENT_TOL = 1e-8;
  for (let i = 0; i < polygon.length; i++) {
    const prev = i === 0 ? polygon[polygon.length - 1] : polygon[i - 1];
    const cur = polygon[i];
    const dx = cur.x - prev.x, dy = cur.y - prev.y, dz = cur.z - prev.z;
    if (dx * dx + dy * dy + dz * dz > COINCIDENT_TOL * COINCIDENT_TOL) {
      out.push(cur);
    }
  }
  return out;
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
 * Compute face normal for curved surfaces (helper to reduce code duplication).
 */
function _computeCurvedFaceNormal(surfaceNormal, nurbsSurface, polygon, sameSense) {
  if (surfaceNormal) {
    return sameSense
      ? surfaceNormal
      : { x: -surfaceNormal.x, y: -surfaceNormal.y, z: -surfaceNormal.z };
  }
  if (nurbsSurface) {
    const midU = (nurbsSurface.uMin + nurbsSurface.uMax) / 2;
    const midV = (nurbsSurface.vMin + nurbsSurface.vMax) / 2;
    const sn = nurbsSurface.normal(midU, midV);
    return sameSense ? sn : { x: -sn.x, y: -sn.y, z: -sn.z };
  }
  return _computePolygonNormal(polygon);
}

/**
 * Attempt strip tessellation for a curved face by detecting paired arc edges.
 *
 * For a typical cylinder/cone face, the edge loop has the pattern:
 *   [line, arc, line, arc] or a rotation thereof.
 * The two arcs have the same number of sample points and run in opposite
 * directions.  We pair corresponding points to create a quad strip.
 *
 * For sphere patches with 3+ arcs, we tessellate as a fan/strip from
 * the common vertex.
 *
 * Returns { faces, vertices } or null if the edge structure doesn't match.
 */
function _tessellateStripFromEdgeBounds(polygon, edgeBounds, surfaceInfo, sameSense, faceGroup) {
  if (!edgeBounds || edgeBounds.length < 2) return null;

  // Identify arc edges and line edges
  const arcEdges = [];
  const lineEdges = [];
  for (let i = 0; i < edgeBounds.length; i++) {
    if (edgeBounds[i].isArc) arcEdges.push(i);
    else lineEdges.push(i);
  }

  // Case 1: Two arcs + two lines (cylinder, cone) — strip between the arcs
  if (arcEdges.length === 2 && lineEdges.length === 2) {
    return _tessellateDoubleArcStrip(polygon, edgeBounds, arcEdges, surfaceInfo, sameSense, faceGroup);
  }

  // Case 2: Three or more arcs (sphere, torus patches) — try structured tessellation
  if (arcEdges.length >= 3) {
    return _tessellateMultiArcPatch(polygon, edgeBounds, arcEdges, surfaceInfo, sameSense, faceGroup);
  }

  return null;
}

/**
 * Strip tessellation for a face with 2 arc edges + 2 line edges.
 *
 * Collects the full point strip for each arc (including end vertices
 * from the adjacent line edges) then pairs them into quad strips.
 */
function _tessellateDoubleArcStrip(polygon, edgeBounds, arcIndices, surfaceInfo, sameSense, faceGroup) {
  const [ai, bi] = arcIndices;
  const arcA = edgeBounds[ai];
  const arcB = edgeBounds[bi];

  // Build full point sequences for each arc, including the first vertex
  // of the next edge (which is the arc endpoint, shared with the line edge).
  const totalPts = polygon.length;
  const getPoint = idx => polygon[idx % totalPts];

  const stripA = [];
  for (let i = 0; i <= arcA.count; i++) stripA.push(getPoint(arcA.start + i));
  const stripB = [];
  for (let i = 0; i <= arcB.count; i++) stripB.push(getPoint(arcB.start + i));

  // The two arcs traverse in opposite directions around the loop.
  // Reverse stripB so corresponding parametric positions align.
  stripB.reverse();

  // Both strips should have the same length
  if (stripA.length !== stripB.length || stripA.length < 2) return null;

  const faces = [];
  const vertices = [];
  const n = stripA.length;

  for (let i = 0; i < n - 1; i++) {
    const a0 = stripA[i], a1 = stripA[i + 1];
    const b0 = stripB[i], b1 = stripB[i + 1];

    // Quad → 2 triangles with per-vertex normals
    const tri1 = [a0, a1, b1];
    const tri2 = [a0, b1, b0];

    for (const tri of [tri1, tri2]) {
      const triNormals = tri.map(v => _computeVertexNormal(v, surfaceInfo, sameSense));
      const cn = {
        x: (triNormals[0].x + triNormals[1].x + triNormals[2].x) / 3,
        y: (triNormals[0].y + triNormals[1].y + triNormals[2].y) / 3,
        z: (triNormals[0].z + triNormals[1].z + triNormals[2].z) / 3,
      };
      faces.push({
        vertices: [tri[0], tri[1], tri[2]],
        normal: _normalize(cn),
        isCurved: true,
        faceGroup,
      });
      vertices.push(tri[0], tri[1], tri[2]);
    }
  }

  return { faces, vertices };
}

/**
 * Project a 3D point onto an analytic surface defined by surfaceInfo.
 * For spheres the point is pushed to the sphere surface along the radial
 * direction from the center; for other surface types a straight-through
 * return is used (no projection).
 *
 * @param {{x:number, y:number, z:number}} point - 3D point to project
 * @param {{type:string, origin:{x:number,y:number,z:number}, radius?:number}} surfaceInfo - Analytic surface definition
 * @returns {{x:number, y:number, z:number}} Projected point on the surface
 */
function _projectOntoSurface(point, surfaceInfo) {
  if (surfaceInfo.type === 'sphere') {
    const ox = surfaceInfo.origin.x, oy = surfaceInfo.origin.y, oz = surfaceInfo.origin.z;
    const dx = point.x - ox, dy = point.y - oy, dz = point.z - oz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-14) return { x: ox + surfaceInfo.radius, y: oy, z: oz };
    const s = surfaceInfo.radius / len;
    return { x: ox + dx * s, y: oy + dy * s, z: oz + dz * s };
  }
  return point;
}

/**
 * Structured tessellation for a face with 3+ arc edges (sphere/torus patches).
 * Creates a fan from the polygon centroid, then adaptively subdivides
 * triangles so that all interior vertices lie on the analytic surface.
 */
function _tessellateMultiArcPatch(polygon, edgeBounds, arcIndices, surfaceInfo, sameSense, faceGroup) {
  if (polygon.length < 3) return null;

  const n = polygon.length;

  // Fan triangulation from polygon centroid projected onto the surface
  const cx = polygon.reduce((s, p) => s + p.x, 0) / n;
  const cy = polygon.reduce((s, p) => s + p.y, 0) / n;
  const cz = polygon.reduce((s, p) => s + p.z, 0) / n;
  const centroid = _projectOntoSurface(_snapPoint({ x: cx, y: cy, z: cz }), surfaceInfo);

  // Build initial fan triangles
  let triangles = [];
  for (let i = 0; i < n; i++) {
    triangles.push([centroid, polygon[i], polygon[(i + 1) % n]]);
  }

  // Adaptive subdivision: split the longest edge when its midpoint
  // deviates from the analytic surface by more than a tolerance.
  // Max depth scales logarithmically; minimum base of 16 ensures at least
  // 4 levels for small polygons so the sphere curvature is resolved.
  const maxDepth = Math.max(1, Math.ceil(Math.log2(Math.max(16, n))));
  // Deviation tolerance in model units — matches _subdivideBSplineTriangles
  const deviationTol = 1e-3;

  for (let depth = 0; depth < maxDepth; depth++) {
    const next = [];
    let anySplit = false;
    for (const tri of triangles) {
      const [a, b, c] = tri;
      const dAB = _dist3D(a, b);
      const dBC = _dist3D(b, c);
      const dCA = _dist3D(c, a);

      let mid, p0, p1, p2;
      if (dAB >= dBC && dAB >= dCA) {
        mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
        p0 = a; p1 = b; p2 = c;
      } else if (dBC >= dCA) {
        mid = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2, z: (b.z + c.z) / 2 };
        p0 = b; p1 = c; p2 = a;
      } else {
        mid = { x: (c.x + a.x) / 2, y: (c.y + a.y) / 2, z: (c.z + a.z) / 2 };
        p0 = c; p1 = a; p2 = b;
      }

      const surfPt = _projectOntoSurface(mid, surfaceInfo);
      const dev = _dist3D(mid, surfPt);

      if (dev > deviationTol) {
        next.push([p0, surfPt, p2]);
        next.push([surfPt, p1, p2]);
        anySplit = true;
      } else {
        next.push(tri);
      }
    }
    triangles = next;
    if (!anySplit) break;
  }

  // Build output faces with per-vertex normals
  const faces = [];
  const vertices = [];
  for (const tri of triangles) {
    const triNormals = tri.map(v => _computeVertexNormal(v, surfaceInfo, sameSense));
    const cn = {
      x: (triNormals[0].x + triNormals[1].x + triNormals[2].x) / 3,
      y: (triNormals[0].y + triNormals[1].y + triNormals[2].y) / 3,
      z: (triNormals[0].z + triNormals[1].z + triNormals[2].z) / 3,
    };
    faces.push({
      vertices: [tri[0], tri[1], tri[2]],
      normal: _normalize(cn),
      isCurved: true,
      faceGroup,
    });
    vertices.push(tri[0], tri[1], tri[2]);
  }

  return { faces, vertices };
}

/**
 * Subdivide B-spline face triangles so that the mesh conforms to the
 * curved NURBS surface.  For each triangle, the midpoint of the longest
 * edge is projected onto the surface.  If the projected point deviates
 * from the linear midpoint beyond a threshold, the triangle is split.
 *
 * This produces an adaptive refinement: flat regions stay coarse while
 * curved regions get more triangles.
 *
 * @param {Array} triangles - Input triangles from ear-clipping
 * @param {NurbsSurface} surface - The NURBS surface to conform to
 * @param {number} segments - Desired surface resolution (controls max depth)
 * @returns {Array} Refined triangle list
 */
function _subdivideBSplineTriangles(triangles, surface, segments) {
  // Max depth scales logarithmically with the requested segment count to
  // limit exponential triangle growth (each level can at most double the
  // triangle count). E.g. segments=16 → maxDepth=4, segments=64 → 6.
  const maxDepth = Math.max(1, Math.ceil(Math.log2(segments)));
  // Deviation tolerance in model units: if the NURBS surface point at a
  // triangle edge midpoint differs from the linear midpoint by more than
  // this, the triangle is split.
  const deviationTol = 1e-3;

  let current = triangles;
  for (let depth = 0; depth < maxDepth; depth++) {
    const next = [];
    let anySplit = false;
    for (const tri of current) {
      const [a, b, c] = tri;

      // Find the longest edge and its midpoints
      const dAB = _dist3D(a, b);
      const dBC = _dist3D(b, c);
      const dCA = _dist3D(c, a);

      // Compute midpoint of the longest edge
      let mid, p0, p1, p2;
      if (dAB >= dBC && dAB >= dCA) {
        mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
        p0 = a; p1 = b; p2 = c;
      } else if (dBC >= dCA) {
        mid = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2, z: (b.z + c.z) / 2 };
        p0 = b; p1 = c; p2 = a;
      } else {
        mid = { x: (c.x + a.x) / 2, y: (c.y + a.y) / 2, z: (c.z + a.z) / 2 };
        p0 = c; p1 = a; p2 = b;
      }

      // Project midpoint onto the NURBS surface
      const uv = surface.closestPointUV(mid);
      const surfPt = surface.evaluate(uv.u, uv.v);
      const dev = _dist3D(mid, surfPt);

      if (dev > deviationTol) {
        // Split: replace the triangle with two using the surface point
        next.push([p0, surfPt, p2]);
        next.push([surfPt, p1, p2]);
        anySplit = true;
      } else {
        next.push(tri);
      }
    }
    current = next;
    if (!anySplit) break;
  }

  return current;
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

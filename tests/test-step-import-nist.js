import './_watchdog.mjs';
#!/usr/bin/env node
/**
 * tests/test-step-import-nist.js
 *
 * Corpus validation for the public NIST STEP samples downloaded into
 * tests/nist-samples/. This script does more than check that importSTEP()
 * does not throw:
 *
 * 1. Traverses the reachable STEP shell topology directly from the source file
 * 2. Compares source shell/face/loop/edge/vertex counts to the imported body
 * 3. Runs B-Rep validation on the imported topology
 * 4. Detects tessellated faces that never produced triangles
 * 5. Measures mesh validity: open/non-manifold edges, degenerate triangles,
 *    normal mismatches, analytic support orientation, and self-intersections
 * 6. Prints a targeted analysis of the importer failures for each sample
 *
 * Usage:
 *   node tests/test-step-import-nist.js
 *   node tests/test-step-import-nist.js --sample ftc_11
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NIST_ROOT = path.join(__dirname, 'nist-samples');
const MANIFEST_PATH = path.join(NIST_ROOT, 'manifest.json');
const DEFAULT_SCORECARD_PATH = path.join(__dirname, 'step-import-nist-scorecard.md');
const IMPORT_OPTIONS = { curveSegments: 16, surfaceSegments: 12 };

const INTERNAL_DEBUG_PREFIXES = [
  '[CAD-Fallback]',
  '[FaceTriangulator]',
  '[NurbsCurve.tessellate]',
  '[robust-tessellate]',
];

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

function shouldSuppressLog(args) {
  const message = args.map((value) => String(value)).join(' ');
  return INTERNAL_DEBUG_PREFIXES.some((prefix) => message.startsWith(prefix));
}

console.log = (...args) => {
  if (shouldSuppressLog(args)) return;
  originalConsoleLog(...args);
};

console.warn = (...args) => {
  if (shouldSuppressLog(args)) return;
  originalConsoleWarn(...args);
};

const { importSTEP } = await import('../js/cad/StepImport.js');
const { validateFull } = await import('../js/cad/BRepValidator.js');

function parseCliArgs(argv) {
  let samplePattern = '';
  let writeScorecardPath = '';
  let allowFailures = false;
  let regressionGate = false;
  // Tolerance expressed in percentage points (the scorecard is rendered to 0.1% precision,
  // so anything larger than 0.1pp is a genuine drop and not a formatting artifact).
  let regressionTolerance = 0.3;

  const parseTolerance = (raw) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Invalid --regression-gate tolerance: ${raw}`);
    }
    return parsed;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sample') {
      samplePattern = argv[++i] || '';
      continue;
    }
    if (arg.startsWith('--sample=')) {
      samplePattern = arg.slice('--sample='.length);
      continue;
    }
    if (arg === '--write-scorecard') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        writeScorecardPath = next;
        i++;
      } else {
        writeScorecardPath = DEFAULT_SCORECARD_PATH;
      }
      continue;
    }
    if (arg.startsWith('--write-scorecard=')) {
      writeScorecardPath = arg.slice('--write-scorecard='.length) || DEFAULT_SCORECARD_PATH;
      continue;
    }
    if (arg === '--allow-failures') {
      allowFailures = true;
      continue;
    }
    if (arg === '--regression-gate') {
      regressionGate = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        regressionTolerance = parseTolerance(next);
        i++;
      }
      continue;
    }
    if (arg.startsWith('--regression-gate=')) {
      regressionGate = true;
      regressionTolerance = parseTolerance(arg.slice('--regression-gate='.length));
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node tests/test-step-import-nist.js ' +
        '[--sample <substring>] [--write-scorecard [path]] [--allow-failures] ' +
        '[--regression-gate [tolerance-pp]]',
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    samplePattern: samplePattern.trim().toLowerCase(),
    writeScorecardPath: writeScorecardPath ? path.resolve(process.cwd(), writeScorecardPath) : '',
    allowFailures,
    regressionGate,
    regressionTolerance,
  };
}

function refId(ref) {
  if (typeof ref === 'string' && ref.startsWith('#')) return parseInt(ref.slice(1), 10);
  if (typeof ref === 'number') return ref;
  return null;
}

function getEntity(resolved, ref) {
  const id = refId(ref);
  return id == null ? null : (resolved.get(id) || null);
}

function parseEntities(stepString) {
  const entities = new Map();
  const dataMatch = stepString.match(/DATA\s*;([\s\S]*?)ENDSEC\s*;/);
  if (!dataMatch) return entities;

  const rawLines = dataMatch[1].split(';');
  for (const rawLine of rawLines) {
    const trimmed = rawLine.replace(/\s+/g, ' ').trim();
    if (!trimmed || !trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^#(\d+)\s*=\s*(.+)$/);
    if (!match) continue;

    const id = parseInt(match[1], 10);
    let body = match[2].trim();
    let type;
    let argsStr;

    if (body.startsWith('(')) {
      const complex = parseComplexEntity(body);
      type = complex.type;
      argsStr = complex.argsStr;
    } else {
      const parenIdx = body.indexOf('(');
      if (parenIdx < 0) {
        type = body;
        argsStr = '';
      } else {
        type = body.substring(0, parenIdx).trim();
        argsStr = body.substring(parenIdx + 1);
        if (argsStr.endsWith(')')) argsStr = argsStr.slice(0, -1);
      }
    }

    entities.set(id, { id, type: type.toUpperCase(), argsStr });
  }

  return entities;
}

function parseComplexEntity(body) {
  let inner = body.trim();
  if (inner.startsWith('(')) inner = inner.slice(1);
  if (inner.endsWith(')')) inner = inner.slice(0, -1);
  inner = inner.trim();

  const subEntities = [];
  let pos = 0;
  while (pos < inner.length) {
    while (pos < inner.length && /\s/.test(inner[pos])) pos++;
    if (pos >= inner.length) break;

    const nameStart = pos;
    while (pos < inner.length && /[A-Z0-9_]/i.test(inner[pos])) pos++;
    const name = inner.substring(nameStart, pos).trim();
    if (!name) {
      pos++;
      continue;
    }

    while (pos < inner.length && /\s/.test(inner[pos])) pos++;
    if (pos >= inner.length || inner[pos] !== '(') {
      subEntities.push({ name: name.toUpperCase(), args: '' });
      continue;
    }

    pos++;
    const argsStart = pos;
    let depth = 1;
    while (pos < inner.length && depth > 0) {
      if (inner[pos] === '(') depth++;
      else if (inner[pos] === ')') depth--;
      if (depth > 0) pos++;
    }
    const args = inner.substring(argsStart, pos);
    pos++;
    subEntities.push({ name: name.toUpperCase(), args });
  }

  const typeMap = new Map(subEntities.map((entry) => [entry.name, entry.args]));

  if (typeMap.has('B_SPLINE_CURVE_WITH_KNOTS') || typeMap.has('B_SPLINE_CURVE')) {
    let merged = typeMap.get('B_SPLINE_CURVE') || '';
    const knotArgs = typeMap.get('B_SPLINE_CURVE_WITH_KNOTS') || '';
    const rationalArgs = typeMap.get('RATIONAL_B_SPLINE_CURVE') || '';
    if (knotArgs) merged += (merged ? ',' : '') + knotArgs;
    if (rationalArgs) merged += (merged ? ',' : '') + rationalArgs;
    return {
      type: rationalArgs ? 'RATIONAL_B_SPLINE_CURVE' : 'B_SPLINE_CURVE_WITH_KNOTS',
      argsStr: merged,
    };
  }

  if (typeMap.has('B_SPLINE_SURFACE_WITH_KNOTS') || typeMap.has('B_SPLINE_SURFACE')) {
    let merged = typeMap.get('B_SPLINE_SURFACE') || '';
    const knotArgs = typeMap.get('B_SPLINE_SURFACE_WITH_KNOTS') || '';
    const rationalArgs = typeMap.get('RATIONAL_B_SPLINE_SURFACE') || '';
    if (knotArgs) merged += (merged ? ',' : '') + knotArgs;
    if (rationalArgs) merged += (merged ? ',' : '') + rationalArgs;
    return {
      type: rationalArgs ? 'RATIONAL_B_SPLINE_SURFACE' : 'B_SPLINE_SURFACE_WITH_KNOTS',
      argsStr: merged,
    };
  }

  if (typeMap.has('GEOMETRIC_REPRESENTATION_CONTEXT')) {
    return {
      type: 'GEOMETRIC_REPRESENTATION_CONTEXT',
      argsStr: typeMap.get('GEOMETRIC_REPRESENTATION_CONTEXT') || '',
    };
  }

  return { type: '__COMPLEX__', argsStr: body };
}

function parseToken(token) {
  if (token === '*' || token === '$') return null;
  if (token.startsWith('#')) return token;
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
  if (token.startsWith('.') && token.endsWith('.')) return token;
  const num = Number(token);
  if (!Number.isNaN(num)) return num;
  return token;
}

function parseArgs(argsStr) {
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
        if (current.trim()) {
          result.push(parseToken(current.trim()));
          current = '';
        }
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
        result.push(parseArgs(current));
        current = '';
        continue;
      }
      if (depth < 0) break;
      current += ch;
      continue;
    }

    if (ch === ',' && depth === 0) {
      if (current.trim()) result.push(parseToken(current.trim()));
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) result.push(parseToken(current.trim()));
  return result;
}

function resolveEntities(rawEntities) {
  const resolved = new Map();
  for (const [id, entity] of rawEntities) {
    resolved.set(id, { id, type: entity.type, args: parseArgs(entity.argsStr) });
  }
  return resolved;
}

function findShells(resolved) {
  const shells = [];

  for (const [, entity] of resolved) {
    if (entity.type !== 'MANIFOLD_SOLID_BREP') continue;
    const shell = getEntity(resolved, entity.args[1]);
    if (shell) shells.push(shell);
  }
  if (shells.length > 0) return shells;

  for (const [, entity] of resolved) {
    if (entity.type === 'CLOSED_SHELL' || entity.type === 'OPEN_SHELL') {
      shells.push(entity);
    }
  }
  return shells;
}

function normalizeSurfaceType(type) {
  switch ((type || '').toUpperCase()) {
    case 'PLANE': return 'plane';
    case 'CYLINDRICAL_SURFACE': return 'cylinder';
    case 'CONICAL_SURFACE': return 'cone';
    case 'SPHERICAL_SURFACE': return 'sphere';
    case 'TOROIDAL_SURFACE': return 'torus';
    case 'SURFACE_OF_LINEAR_EXTRUSION': return 'extrusion';
    case 'SURFACE_OF_REVOLUTION': return 'revolution';
    case 'B_SPLINE_SURFACE':
    case 'B_SPLINE_SURFACE_WITH_KNOTS':
    case 'RATIONAL_B_SPLINE_SURFACE':
      return 'bspline';
    default:
      return type ? type.toLowerCase() : 'unknown';
  }
}

function incrementBreakdown(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function ratioScore(expected, actual) {
  const lhs = Math.max(0, Number(expected) || 0);
  const rhs = Math.max(0, Number(actual) || 0);
  if (lhs === 0 && rhs === 0) return 1;
  if (lhs === 0 || rhs === 0) return 0;
  return Math.min(lhs, rhs) / Math.max(lhs, rhs);
}

function averageScore(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function selectLikelyOuterLoop(loopStats) {
  if (!loopStats.length) return null;
  return [...loopStats].sort((a, b) =>
    b.uniqueBoundaryVertices - a.uniqueBoundaryVertices ||
    b.coedgeCount - a.coedgeCount ||
    a.index - b.index
  )[0];
}

function collectSourceTopologyStats(stepString) {
  const resolved = resolveEntities(parseEntities(stepString));
  const shells = findShells(resolved);

  const faceIds = new Set();
  const loopIds = new Set();
  const edgeIds = new Set();
  const vertexIds = new Set();
  const surfaceBreakdown = {};
  const faceDetails = [];
  let innerLoopCount = 0;
  let facesWithoutExplicitOuterBound = 0;

  for (const shell of shells) {
    const faceRefs = Array.isArray(shell.args[1]) ? shell.args[1] : shell.args;
    for (const faceRef of faceRefs) {
      const face = getEntity(resolved, faceRef);
      if (!face || face.type !== 'ADVANCED_FACE') continue;

      faceIds.add(face.id);
      const surfaceEntity = getEntity(resolved, face.args[2]);
      const surfaceType = normalizeSurfaceType(surfaceEntity?.type);
      incrementBreakdown(surfaceBreakdown, surfaceType);

      let loopCount = 0;
      let outerBounds = 0;
      let faceInnerLoops = 0;
      let outerCoedges = 0;
      let totalCoedges = 0;
      let selfLoopCoedges = 0;
      const faceVertexIds = new Set();
      const loopStats = [];

      const bounds = Array.isArray(face.args[1]) ? face.args[1] : [];
      for (let boundIndex = 0; boundIndex < bounds.length; boundIndex++) {
        const boundRef = bounds[boundIndex];
        const bound = getEntity(resolved, boundRef);
        if (!bound) continue;
        if (bound.type !== 'FACE_BOUND' && bound.type !== 'FACE_OUTER_BOUND') continue;

        const loop = getEntity(resolved, bound.args[1]);
        if (!loop || loop.type !== 'EDGE_LOOP') continue;

        loopIds.add(loop.id);
        loopCount++;
        if (bound.type === 'FACE_BOUND') {
          faceInnerLoops++;
          innerLoopCount++;
        }
        if (bound.type === 'FACE_OUTER_BOUND') outerBounds++;

        const orientedEdges = Array.isArray(loop.args[1]) ? loop.args[1] : [];
        totalCoedges += orientedEdges.length;
        if (bound.type === 'FACE_OUTER_BOUND') outerCoedges += orientedEdges.length;
        const loopVertexIds = new Set();
        let loopSelfLoopCoedges = 0;

        for (const oeRef of orientedEdges) {
          const oe = getEntity(resolved, oeRef);
          if (!oe || oe.type !== 'ORIENTED_EDGE') continue;
          const edge = getEntity(resolved, oe.args[3]);
          if (!edge || edge.type !== 'EDGE_CURVE') continue;

          edgeIds.add(edge.id);
          const startVertexId = refId(edge.args[1]);
          const endVertexId = refId(edge.args[2]);
          if (startVertexId != null) {
            vertexIds.add(startVertexId);
            faceVertexIds.add(startVertexId);
            loopVertexIds.add(startVertexId);
          }
          if (endVertexId != null) {
            vertexIds.add(endVertexId);
            faceVertexIds.add(endVertexId);
            loopVertexIds.add(endVertexId);
          }
          if (startVertexId != null && startVertexId === endVertexId) {
            selfLoopCoedges++;
            loopSelfLoopCoedges++;
          }
        }

        loopStats.push({
          index: boundIndex,
          isOuter: bound.type === 'FACE_OUTER_BOUND',
          coedgeCount: orientedEdges.length,
          uniqueBoundaryVertices: loopVertexIds.size,
          selfLoopCoedges: loopSelfLoopCoedges,
        });
      }

      if (outerBounds === 0) facesWithoutExplicitOuterBound++;
      const inferredOuter = outerBounds === 0 ? selectLikelyOuterLoop(loopStats) : null;
      const normalizedOuterCoedges = outerBounds > 0
        ? outerCoedges
        : (inferredOuter?.coedgeCount || 0);
      const normalizedInnerLoops = outerBounds > 0
        ? faceInnerLoops
        : Math.max(0, loopCount - (inferredOuter ? 1 : 0));

      faceDetails.push({
        sourceFaceId: face.id,
        surfaceType,
        loops: loopCount,
        outerBounds,
        innerLoops: faceInnerLoops,
        normalizedInnerLoops,
        outerCoedges,
        normalizedOuterCoedges,
        totalCoedges,
        selfLoopCoedges,
        uniqueBoundaryVertices: faceVertexIds.size,
        hasCircularTrim: selfLoopCoedges > 0,
      });
    }
  }

  return {
    shellCount: shells.length,
    closedShellCount: shells.filter((shell) => shell.type === 'CLOSED_SHELL').length,
    faceCount: faceIds.size,
    loopCount: loopIds.size,
    innerLoopCount,
    normalizedInnerLoopCount: faceDetails.reduce((sum, face) => sum + face.normalizedInnerLoops, 0),
    facesWithoutExplicitOuterBound,
    edgeCount: edgeIds.size,
    vertexCount: vertexIds.size,
    faceDetails,
    surfaceBreakdown,
  };
}

function summarizeImportedBody(body) {
  const faceDetails = [];
  const surfaceBreakdown = {};
  let loopCount = 0;
  let innerLoopCount = 0;

  for (const face of body.faces()) {
    const loops = face.allLoops();
    loopCount += loops.length;
    innerLoopCount += face.innerLoops.length;

    let totalCoedges = 0;
    let selfLoopCoedges = 0;
    const faceVertices = new Set();
    for (const loop of loops) {
      totalCoedges += loop.coedges.length;
      for (const coedge of loop.coedges) {
        if (coedge.edge.startVertex === coedge.edge.endVertex) selfLoopCoedges++;
        faceVertices.add(coedge.edge.startVertex);
        faceVertices.add(coedge.edge.endVertex);
      }
    }

    const detail = {
      id: face.id,
      surfaceType: face.surfaceType || 'unknown',
      loops: loops.length,
      innerLoops: face.innerLoops.length,
      normalizedInnerLoops: face.innerLoops.length,
      outerCoedges: face.outerLoop?.coedges?.length || 0,
      normalizedOuterCoedges: face.outerLoop?.coedges?.length || 0,
      totalCoedges,
      selfLoopCoedges,
      uniqueBoundaryVertices: faceVertices.size,
      hasCircularTrim: selfLoopCoedges > 0,
      outerLoopClosed: !!face.outerLoop?.isClosed?.(),
      sameSense: face.sameSense !== false,
      surfaceInfo: face.surfaceInfo || null,
    };

    faceDetails.push(detail);
    incrementBreakdown(surfaceBreakdown, detail.surfaceType);
  }

  return {
    shellCount: body.shells.length,
    closedShellCount: body.shells.filter((shell) => shell.closed).length,
    faceCount: body.faces().length,
    loopCount,
    innerLoopCount,
    edgeCount: body.edges().length,
    vertexCount: body.vertices().length,
    faceDetails,
    surfaceBreakdown,
  };
}

function triangleArea2(face) {
  if (!Array.isArray(face.vertices) || face.vertices.length < 3) return 0;
  const a = face.vertices[0];
  const b = face.vertices[1];
  const c = face.vertices[2];
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return cx * cx + cy * cy + cz * cz;
}

function triangleNormal(face) {
  if (!Array.isArray(face.vertices) || face.vertices.length < 3) return null;
  const a = face.vertices[0];
  const b = face.vertices[1];
  const c = face.vertices[2];
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;
  return normalizeVector({
    x: aby * acz - abz * acy,
    y: abz * acx - abx * acz,
    z: abx * acy - aby * acx,
  });
}

function normalizeVector(vector) {
  const len = Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
  if (len < 1e-14) return null;
  return { x: vector.x / len, y: vector.y / len, z: vector.z / len };
}

function triangleCentroid(face) {
  if (!Array.isArray(face.vertices) || face.vertices.length < 3) return null;
  return {
    x: (face.vertices[0].x + face.vertices[1].x + face.vertices[2].x) / 3,
    y: (face.vertices[0].y + face.vertices[1].y + face.vertices[2].y) / 3,
    z: (face.vertices[0].z + face.vertices[1].z + face.vertices[2].z) / 3,
  };
}

function analyticNormalAtPoint(surfaceInfo, point, sameSense = true) {
  if (!surfaceInfo || !point) return null;

  let normal = null;
  switch (surfaceInfo.type) {
    case 'plane':
      normal = surfaceInfo.normal ? normalizeVector({ ...surfaceInfo.normal }) : null;
      break;
    case 'cylinder': {
      if (!surfaceInfo.origin || !surfaceInfo.axis) break;
      const dx = point.x - surfaceInfo.origin.x;
      const dy = point.y - surfaceInfo.origin.y;
      const dz = point.z - surfaceInfo.origin.z;
      const ax = surfaceInfo.axis.x;
      const ay = surfaceInfo.axis.y;
      const az = surfaceInfo.axis.z;
      const dot = dx * ax + dy * ay + dz * az;
      normal = normalizeVector({ x: dx - dot * ax, y: dy - dot * ay, z: dz - dot * az });
      break;
    }
    case 'sphere':
      if (!surfaceInfo.origin) break;
      normal = normalizeVector({
        x: point.x - surfaceInfo.origin.x,
        y: point.y - surfaceInfo.origin.y,
        z: point.z - surfaceInfo.origin.z,
      });
      break;
    case 'cone': {
      if (!surfaceInfo.origin || !surfaceInfo.axis) break;
      const dx = point.x - surfaceInfo.origin.x;
      const dy = point.y - surfaceInfo.origin.y;
      const dz = point.z - surfaceInfo.origin.z;
      const ax = surfaceInfo.axis.x;
      const ay = surfaceInfo.axis.y;
      const az = surfaceInfo.axis.z;
      const axial = dx * ax + dy * ay + dz * az;
      const rx = dx - axial * ax;
      const ry = dy - axial * ay;
      const rz = dz - axial * az;
      const radialLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (radialLen < 1e-14) {
        normal = normalizeVector({ x: ax, y: ay, z: az });
        break;
      }
      const semiAngle = surfaceInfo.semiAngle || 0;
      const cosA = Math.cos(semiAngle);
      const sinA = Math.sin(semiAngle);
      normal = normalizeVector({
        x: (rx / radialLen) * cosA - ax * sinA,
        y: (ry / radialLen) * cosA - ay * sinA,
        z: (rz / radialLen) * cosA - az * sinA,
      });
      break;
    }
    case 'torus': {
      if (!surfaceInfo.origin || !surfaceInfo.axis || !Number.isFinite(surfaceInfo.majorR)) break;
      const dx = point.x - surfaceInfo.origin.x;
      const dy = point.y - surfaceInfo.origin.y;
      const dz = point.z - surfaceInfo.origin.z;
      const ax = surfaceInfo.axis.x;
      const ay = surfaceInfo.axis.y;
      const az = surfaceInfo.axis.z;
      const axial = dx * ax + dy * ay + dz * az;
      const rx = dx - axial * ax;
      const ry = dy - axial * ay;
      const rz = dz - axial * az;
      const radialLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (radialLen < 1e-14) {
        normal = normalizeVector({ x: ax, y: ay, z: az });
        break;
      }
      const cx = surfaceInfo.origin.x + (rx / radialLen) * surfaceInfo.majorR;
      const cy = surfaceInfo.origin.y + (ry / radialLen) * surfaceInfo.majorR;
      const cz = surfaceInfo.origin.z + (rz / radialLen) * surfaceInfo.majorR;
      normal = normalizeVector({ x: point.x - cx, y: point.y - cy, z: point.z - cz });
      break;
    }
    default:
      return null;
  }

  if (!normal) return null;
  return sameSense
    ? normal
    : { x: -normal.x, y: -normal.y, z: -normal.z };
}

function analyzeMesh(mesh, bodySummary) {
  const faceIdsWithTriangles = new Set();
  const bodyFaceById = new Map((bodySummary.faceDetails || []).map((face) => [face.id, face]));
  const meshFacesByTopoFace = new Map();
  const edgeMap = new Map();
  let degenerateTriangles = 0;
  let normalMismatchTriangles = 0;
  const normalMismatchBreakdown = {};
  let analyticNormalInvertedTriangles = 0;
  let analyticNormalLowDotTriangles = 0;
  let minAnalyticNormalDot = Infinity;
  const analyticNormalInvertedBreakdown = {};
  const analyticNormalLowDotBreakdown = {};

  const vertexKey = (v) => `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;
  const edgeKey = (a, b) => {
    const ka = vertexKey(a);
    const kb = vertexKey(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };

  for (const face of mesh.faces) {
    let bodyFace = null;
    if (typeof face.topoFaceId === 'number') {
      faceIdsWithTriangles.add(face.topoFaceId);
      bodyFace = bodyFaceById.get(face.topoFaceId) || null;
    }
    if (triangleArea2(face) < 1e-20) degenerateTriangles++;

    if (bodyFace) {
      if (!meshFacesByTopoFace.has(bodyFace.id)) meshFacesByTopoFace.set(bodyFace.id, []);
      meshFacesByTopoFace.get(bodyFace.id).push({ face, surfaceType: bodyFace.surfaceType });
    }

    const geometricNormal = triangleNormal(face);
    const storedNormal = face.normal ? normalizeVector(face.normal) : null;
    if (geometricNormal && storedNormal) {
      const dot = geometricNormal.x * storedNormal.x +
        geometricNormal.y * storedNormal.y +
        geometricNormal.z * storedNormal.z;
      if (dot < 0.2) {
        normalMismatchTriangles++;
        incrementBreakdown(normalMismatchBreakdown, bodyFace?.surfaceType || 'unknown');
      }
    }

    if (bodyFace?.surfaceInfo) {
      const verts = face.vertices || [];
      if (geometricNormal && verts.length >= 3) {
        const centroid = triangleCentroid(face);
        const analyticNormal = analyticNormalAtPoint(bodyFace.surfaceInfo, centroid, bodyFace.sameSense);
        if (analyticNormal) {
          const dot = geometricNormal.x * analyticNormal.x +
            geometricNormal.y * analyticNormal.y +
            geometricNormal.z * analyticNormal.z;
          minAnalyticNormalDot = Math.min(minAnalyticNormalDot, dot);
          if (dot < -1e-6) {
            analyticNormalInvertedTriangles++;
            incrementBreakdown(analyticNormalInvertedBreakdown, bodyFace.surfaceType);
          } else if (dot < 0.2) {
            analyticNormalLowDotTriangles++;
            incrementBreakdown(analyticNormalLowDotBreakdown, bodyFace.surfaceType);
          }
        }
      }
    }

    const verts = face.vertices || [];
    for (let i = 0; i < verts.length; i++) {
      const key = edgeKey(verts[i], verts[(i + 1) % verts.length]);
      edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
    }
  }

  const sameFaceSelfIntersections = detectSameFaceSelfIntersections(meshFacesByTopoFace);

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edgeMap.values()) {
    if (count === 1) boundaryEdges++;
    else if (count > 2) nonManifoldEdges++;
  }

  const missingFaces = bodySummary.faceDetails.filter((face) => !faceIdsWithTriangles.has(face.id));
  const missingSurfaceBreakdown = {};
  let missingWithInnerLoops = 0;
  let missingWithSingleCoedgeOuterLoop = 0;
  let missingWithSelfLoopCoedges = 0;

  for (const face of missingFaces) {
    incrementBreakdown(missingSurfaceBreakdown, face.surfaceType);
    if (face.innerLoops > 0) missingWithInnerLoops++;
    if (face.outerCoedges <= 1) missingWithSingleCoedgeOuterLoop++;
    if (face.selfLoopCoedges > 0) missingWithSelfLoopCoedges++;
  }

  return {
    triangleCount: mesh.faces.length,
    displayVertexCount: mesh.vertices.length,
    faceGroupCount: faceIdsWithTriangles.size,
    faceIdsWithTriangles,
    boundaryEdges,
    nonManifoldEdges,
    degenerateTriangles,
    normalMismatchTriangles,
    normalMismatchBreakdown,
    analyticNormalInvertedTriangles,
    analyticNormalInvertedBreakdown,
    analyticNormalLowDotTriangles,
    minAnalyticNormalDot: Number.isFinite(minAnalyticNormalDot) ? minAnalyticNormalDot : null,
    analyticNormalLowDotBreakdown,
    selfIntersectionPairs: sameFaceSelfIntersections.count,
    selfIntersectionBreakdown: sameFaceSelfIntersections.breakdown,
    selfIntersectionExamples: sameFaceSelfIntersections.examples,
    missingFaces,
    missingSurfaceBreakdown,
    missingWithInnerLoops,
    missingWithSingleCoedgeOuterLoop,
    missingWithSelfLoopCoedges,
  };
}

function detectSameFaceSelfIntersections(meshFacesByTopoFace) {
  const breakdown = {};
  const examples = [];
  let count = 0;

  for (const [topoFaceId, entries] of meshFacesByTopoFace) {
    if (!entries || entries.length < 2) continue;

    const triangles = entries
      .map((entry, localIndex) => {
        const vertices = entry.face.vertices || [];
        if (vertices.length !== 3) return null;
        return {
          localIndex,
          surfaceType: entry.surfaceType || 'unknown',
          vertices,
          bbox: triangleBBox(vertices),
        };
      })
      .filter(Boolean);

    for (let i = 0; i < triangles.length; i++) {
      for (let j = i + 1; j < triangles.length; j++) {
        const a = triangles[i];
        const b = triangles[j];
        if (trianglesShareVertex(a.vertices, b.vertices)) continue;
        if (!bboxOverlap(a.bbox, b.bbox, 1e-9)) continue;
        if (!trianglesIntersect3D(a.vertices, b.vertices)) continue;

        count++;
        incrementBreakdown(breakdown, a.surfaceType);
        if (examples.length < 5) {
          examples.push({
            topoFaceId,
            surfaceType: a.surfaceType,
            triangles: [a.localIndex, b.localIndex],
          });
        }
      }
    }
  }

  return { count, breakdown, examples };
}

function triangleBBox(vertices) {
  return {
    minX: Math.min(vertices[0].x, vertices[1].x, vertices[2].x),
    minY: Math.min(vertices[0].y, vertices[1].y, vertices[2].y),
    minZ: Math.min(vertices[0].z, vertices[1].z, vertices[2].z),
    maxX: Math.max(vertices[0].x, vertices[1].x, vertices[2].x),
    maxY: Math.max(vertices[0].y, vertices[1].y, vertices[2].y),
    maxZ: Math.max(vertices[0].z, vertices[1].z, vertices[2].z),
  };
}

function bboxOverlap(a, b, eps = 0) {
  return a.minX <= b.maxX + eps && a.maxX + eps >= b.minX &&
    a.minY <= b.maxY + eps && a.maxY + eps >= b.minY &&
    a.minZ <= b.maxZ + eps && a.maxZ + eps >= b.minZ;
}

function trianglesShareVertex(a, b, eps = 1e-8) {
  for (const pa of a) {
    for (const pb of b) {
      if (
        Math.abs(pa.x - pb.x) <= eps &&
        Math.abs(pa.y - pb.y) <= eps &&
        Math.abs(pa.z - pb.z) <= eps
      ) {
        return true;
      }
    }
  }
  return false;
}

function trianglesIntersect3D(a, b) {
  for (const [lhs, rhs] of [[a, b], [b, a]]) {
    for (let i = 0; i < 3; i++) {
      if (segmentTriangleIntersect(lhs[i], lhs[(i + 1) % 3], rhs[0], rhs[1], rhs[2])) return true;
    }
  }
  return false;
}

function segmentTriangleIntersect(p0, p1, v0, v1, v2) {
  const dir = {
    x: p1.x - p0.x,
    y: p1.y - p0.y,
    z: p1.z - p0.z,
  };
  const e1 = {
    x: v1.x - v0.x,
    y: v1.y - v0.y,
    z: v1.z - v0.z,
  };
  const e2 = {
    x: v2.x - v0.x,
    y: v2.y - v0.y,
    z: v2.z - v0.z,
  };
  const h = {
    x: dir.y * e2.z - dir.z * e2.y,
    y: dir.z * e2.x - dir.x * e2.z,
    z: dir.x * e2.y - dir.y * e2.x,
  };
  const a = e1.x * h.x + e1.y * h.y + e1.z * h.z;
  if (Math.abs(a) < 1e-10) return false;

  const f = 1 / a;
  const s = {
    x: p0.x - v0.x,
    y: p0.y - v0.y,
    z: p0.z - v0.z,
  };
  const u = f * (s.x * h.x + s.y * h.y + s.z * h.z);
  if (u < 1e-8 || u > 1 - 1e-8) return false;

  const q = {
    x: s.y * e1.z - s.z * e1.y,
    y: s.z * e1.x - s.x * e1.z,
    z: s.x * e1.y - s.y * e1.x,
  };
  const v = f * (dir.x * q.x + dir.y * q.y + dir.z * q.z);
  if (v < 1e-8 || u + v > 1 - 1e-8) return false;

  const t = f * (e2.x * q.x + e2.y * q.y + e2.z * q.z);
  return t > 1e-8 && t < 1 - 1e-8;
}

function normalizeValidationMessage(message) {
  return message
    .replace(/Shell \d+/g, 'Shell #')
    .replace(/Face \d+/g, 'Face #')
    .replace(/edge \d+/g, 'edge #')
    .replace(/Edges \d+ and \d+/g, 'Edges # and #')
    .replace(/coedge \d+/g, 'coedge #')
    .replace(/Vertex \d+/g, 'Vertex #')
    .replace(/inner loop \d+/g, 'inner loop #');
}

function topPatterns(messages, limit = 4) {
  const counts = new Map();
  for (const message of messages) {
    const normalized = normalizeValidationMessage(message);
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function formatPatterns(patterns) {
  if (!patterns.length) return 'none';
  return patterns.map(([message, count]) => `${count}x ${message}`).join('; ');
}

function formatBreakdown(breakdown) {
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return 'none';
  return entries.map(([key, value]) => `${key} ${value}`).join(', ');
}

function compareBreakdowns(sourceBreakdown, importedBreakdown) {
  const keys = new Set([...Object.keys(sourceBreakdown), ...Object.keys(importedBreakdown)]);
  const diffs = [];
  for (const key of [...keys].sort()) {
    const source = sourceBreakdown[key] || 0;
    const imported = importedBreakdown[key] || 0;
    if (source !== imported) diffs.push(`${key}: source ${source}, imported ${imported}`);
  }
  return diffs;
}

function analyzeReport(report) {
  const failures = [];
  const warnings = [];
  const notes = [];

  const source = report.source;
  const body = report.body;
  const mesh = report.mesh;
  const validation = report.validation;

  if (report.error) {
    failures.push(`importSTEP threw: ${report.error}`);
    return { failures, warnings, notes };
  }

  const exactComparisons = [
    ['shell count', source.shellCount, body.shellCount],
    ['closed shell count', source.closedShellCount, body.closedShellCount],
    ['face count', source.faceCount, body.faceCount],
    ['loop count', source.loopCount, body.loopCount],
    ['effective inner loop count', source.normalizedInnerLoopCount, body.innerLoopCount],
    ['edge count', source.edgeCount, body.edgeCount],
    ['vertex count', source.vertexCount, body.vertexCount],
  ];

  for (const [label, expected, actual] of exactComparisons) {
    if (expected !== actual) failures.push(`${label} mismatch: source ${expected}, imported ${actual}`);
  }

  const surfaceDiffs = compareBreakdowns(source.surfaceBreakdown, body.surfaceBreakdown);
  if (surfaceDiffs.length) failures.push(`surface-type breakdown mismatch: ${surfaceDiffs.slice(0, 6).join('; ')}`);

  if (validation.errors.length > 0) {
    failures.push(`B-Rep validation reported ${validation.errors.length} error(s)`);
  }
  if (validation.warnings.length > 0) {
    warnings.push(`B-Rep validation reported ${validation.warnings.length} warning(s)`);
  }

  if (mesh.missingFaces.length > 0) {
    failures.push(`${mesh.missingFaces.length} imported face(s) produced no tessellated triangles`);
  }
  if (mesh.boundaryEdges > 0) {
    failures.push(`tessellated mesh has ${mesh.boundaryEdges} boundary edge(s)`);
  }
  if (mesh.nonManifoldEdges > 0) {
    failures.push(`tessellated mesh has ${mesh.nonManifoldEdges} non-manifold edge(s)`);
  }
  if (mesh.selfIntersectionPairs > 0) {
    failures.push(`tessellated mesh has ${mesh.selfIntersectionPairs} same-face self-intersection pair(s)`);
  }
  if (mesh.normalMismatchTriangles > 0) {
    failures.push(`tessellated mesh has ${mesh.normalMismatchTriangles} triangle normal/winding mismatch(es)`);
  }
  if (mesh.analyticNormalInvertedTriangles > 0) {
    failures.push(
      `tessellated mesh has ${mesh.analyticNormalInvertedTriangles} triangle(s) inverted relative to their analytic support surface`,
    );
  }
  if (mesh.analyticNormalLowDotTriangles > 0) {
    warnings.push(
      `tessellated mesh has ${mesh.analyticNormalLowDotTriangles} low-quality analytic support triangle(s)`,
    );
  }
  if (mesh.degenerateTriangles > 0) {
    failures.push(`tessellated mesh has ${mesh.degenerateTriangles} degenerate triangle(s)`);
  }

  const duplicateEdgeErrors = validation.errors.filter((message) => message.includes('coincident duplicates')).length;
  const openOuterLoopErrors = validation.errors.filter((message) => message.includes('outer loop is not closed')).length;
  const openInnerLoopErrors = validation.errors.filter((message) => message.includes('inner loop') && message.includes('not closed')).length;
  const shortOuterLoopWarnings = validation.warnings.filter((message) => message.includes('outer loop has fewer than 3 coedges')).length;

  if (
    source.faceCount !== body.faceCount ||
    source.loopCount !== body.loopCount ||
    source.edgeCount !== body.edgeCount ||
    source.vertexCount !== body.vertexCount
  ) {
    notes.push('Exact topology is being lost during STEP parse, before tessellation starts.');
  }
  if (duplicateEdgeErrors > 0) {
    notes.push('The importer is generating coincident duplicate TopoEdges instead of sewing shared edges cleanly.');
  }
  if (
    source.normalizedInnerLoopCount !== body.innerLoopCount &&
    source.facesWithoutExplicitOuterBound > 0 &&
    source.innerLoopCount !== source.normalizedInnerLoopCount
  ) {
    notes.push(
      `${source.facesWithoutExplicitOuterBound} source face(s) have no explicit FACE_OUTER_BOUND, so outer/inner classification must be inferred from geometry.`,
    );
  }
  if (openOuterLoopErrors > 0 || openInnerLoopErrors > 0) {
    notes.push('Broken trim loops are reaching the exact topology layer. That is a topology construction bug, not just a display issue.');
  }
  if (mesh.missingFaces.length > 0) {
    if (mesh.missingWithSingleCoedgeOuterLoop === mesh.missingFaces.length) {
      notes.push('Dropped tessellation is concentrated entirely in one-coedge seam/circular faces.');
    } else if (mesh.missingWithSingleCoedgeOuterLoop > 0 || mesh.missingWithSelfLoopCoedges > 0 || mesh.missingWithInnerLoops > 0) {
      const traits = [];
      if (mesh.missingWithSingleCoedgeOuterLoop > 0) traits.push(`${mesh.missingWithSingleCoedgeOuterLoop} one-coedge outer loops`);
      if (mesh.missingWithSelfLoopCoedges > 0) traits.push(`${mesh.missingWithSelfLoopCoedges} self-loop trimmed faces`);
      if (mesh.missingWithInnerLoops > 0) traits.push(`${mesh.missingWithInnerLoops} hole-bearing faces`);
      notes.push(`Dropped tessellation is strongly correlated with ${traits.join(', ')}.`);
    }

    const ordinaryMissingFaces = mesh.missingFaces.filter(
      (face) => face.outerCoedges >= 3 && face.selfLoopCoedges === 0,
    ).length;
    if (ordinaryMissingFaces > 0) {
      notes.push(`${ordinaryMissingFaces} dropped faces are ordinary multi-edge faces, so the problem is not limited to seam-loop special cases.`);
    }
  }
  if (mesh.analyticNormalInvertedTriangles > 0) {
    notes.push(`Analytic normal inversions by surface: ${formatBreakdown(mesh.analyticNormalInvertedBreakdown)}.`);
  }
  if (mesh.analyticNormalLowDotTriangles > 0) {
    notes.push(`Low analytic-normal quality by surface: ${formatBreakdown(mesh.analyticNormalLowDotBreakdown)}.`);
  }
  if (mesh.normalMismatchTriangles > 0) {
    notes.push(`Stored normal/winding mismatches by surface: ${formatBreakdown(mesh.normalMismatchBreakdown)}.`);
  }
  if (mesh.selfIntersectionPairs > 0) {
    notes.push(`Same-face self-intersections by surface: ${formatBreakdown(mesh.selfIntersectionBreakdown)}.`);
  }
  if (shortOuterLoopWarnings > 0) {
    notes.push(`${shortOuterLoopWarnings} face(s) have fewer than 3 outer coedges after import, which should not happen for valid trimmed faces.`);
  }

  return { failures, warnings, notes };
}

function formatTopologySummary(summary) {
  const effectiveInnerSuffix = (
    typeof summary.normalizedInnerLoopCount === 'number' &&
    summary.normalizedInnerLoopCount !== summary.innerLoopCount
  )
    ? `, ${summary.normalizedInnerLoopCount} effective inner`
    : '';

  return `${summary.shellCount} shell(s), ${summary.faceCount} face(s), ` +
    `${summary.loopCount} loop(s) (${summary.innerLoopCount} inner${effectiveInnerSuffix}), ` +
    `${summary.edgeCount} edge(s), ${summary.vertexCount} vertex/vertices`;
}

function formatMeshSummary(mesh, body) {
  return `${mesh.triangleCount} triangle(s), ${mesh.displayVertexCount} display verts, ` +
    `${mesh.faceGroupCount}/${body.faceCount} face groups, ` +
    `${mesh.boundaryEdges} boundary edge(s), ${mesh.nonManifoldEdges} non-manifold edge(s), ` +
    `${mesh.normalMismatchTriangles} normal mismatch(es), ${mesh.selfIntersectionPairs} self-intersection(s)`;
}

function buildFacePairs(report) {
  if (report.error || !report.body || !report.mesh) return [];

  const importedFaces = report.body.faceDetails || [];
  const faceIdsWithTriangles = report.mesh.faceIdsWithTriangles || new Set();

  // The importer builds faces in STEP shell traversal order, so pairing by
  // index gives a stable source/import comparison for diagnostics.
  return report.source.faceDetails.map((sourceFace, index) => {
    const importedFace = importedFaces[index] || null;
    return {
      index,
      source: sourceFace,
      imported: importedFace,
      tessellated: !!(importedFace && faceIdsWithTriangles.has(importedFace.id)),
    };
  });
}

function effectiveSourceInnerLoops(sourceFace) {
  if (typeof sourceFace?.normalizedInnerLoops === 'number') {
    return sourceFace.normalizedInnerLoops;
  }
  return sourceFace?.innerLoops || 0;
}

function effectiveSourceOuterCoedges(sourceFace) {
  if (typeof sourceFace?.normalizedOuterCoedges === 'number') {
    return sourceFace.normalizedOuterCoedges;
  }
  return sourceFace?.outerCoedges || 0;
}

function surfaceFaceScore(pair) {
  if (!pair.imported) return 0;

  const source = pair.source;
  const imported = pair.imported;
  const surfaceMatch = source.surfaceType === imported.surfaceType ? 1 : 0;
  const sourceInnerLoops = effectiveSourceInnerLoops(source);
  const sourceOuterCoedges = effectiveSourceOuterCoedges(source);

  return (
    surfaceMatch * 0.15 +
    ratioScore(source.loops, imported.loops) * 0.15 +
    ratioScore(sourceInnerLoops, imported.innerLoops) * 0.2 +
    ratioScore(sourceOuterCoedges, imported.outerCoedges) * 0.1 +
    ratioScore(source.totalCoedges, imported.totalCoedges) * 0.15 +
    (pair.tessellated ? 1 : 0) * 0.25
  );
}

function circleFaceScore(pair) {
  if (!pair.imported) return 0;
  return (
    ratioScore(pair.source.selfLoopCoedges, pair.imported.selfLoopCoedges) * 0.2 +
    ratioScore(effectiveSourceInnerLoops(pair.source), pair.imported.innerLoops) * 0.15 +
    ratioScore(pair.source.uniqueBoundaryVertices, pair.imported.uniqueBoundaryVertices) * 0.15 +
    (pair.tessellated ? 1 : 0) * 0.5
  );
}

function meshValidityScore(report) {
  if (report.error || !report.body || !report.mesh) return 0;

  const faceCount = Math.max(1, report.body.faceCount);
  const triCount = Math.max(1, report.mesh.triangleCount);
  const validationErrorLoad = report.validation.errors.length / faceCount;
  const validationWarningLoad = report.validation.warnings.length / (faceCount * 4);
  const boundaryLoad = report.mesh.boundaryEdges / faceCount;
  const nonManifoldLoad = report.mesh.nonManifoldEdges / faceCount;
  const selfIntersectionLoad = report.mesh.selfIntersectionPairs / faceCount;
  const degenerateLoad = report.mesh.degenerateTriangles / triCount;
  const normalLoad = (
    report.mesh.normalMismatchTriangles +
    report.mesh.analyticNormalInvertedTriangles * 4 +
    report.mesh.analyticNormalLowDotTriangles
  ) / triCount;

  const score = averageScore([
    1 / (1 + validationErrorLoad * 2),
    1 / (1 + validationWarningLoad),
    1 / (1 + boundaryLoad * 2),
    1 / (1 + nonManifoldLoad * 3),
    1 / (1 + selfIntersectionLoad * 4),
    1 / (1 + degenerateLoad * 50),
    1 / (1 + normalLoad * 50),
  ]) ?? 0;

  const hasInvalidGeometry = report.validation.errors.length > 0 ||
    report.mesh.boundaryEdges > 0 ||
    report.mesh.nonManifoldEdges > 0 ||
    report.mesh.selfIntersectionPairs > 0 ||
    report.mesh.degenerateTriangles > 0 ||
    report.mesh.normalMismatchTriangles > 0 ||
    report.mesh.analyticNormalInvertedTriangles > 0;

  return hasInvalidGeometry ? Math.min(score, 0.995) : score;
}

function meshHealthScore(report) {
  if (report.error || !report.body || !report.mesh) return 0;

  const faceCount = Math.max(1, report.body.faceCount);
  const vertexCount = Math.max(1, report.body.vertexCount);
  const warningLoad = report.validation.errors.length + report.validation.warnings.length * 0.35;
  const boundaryLoadByFace = report.mesh.boundaryEdges / faceCount;
  const nonManifoldLoadByFace = report.mesh.nonManifoldEdges / faceCount;

  const health = averageScore([
    ratioScore(report.body.faceCount, report.mesh.faceGroupCount),
    1 / (1 + boundaryLoadByFace * boundaryLoadByFace),
    1 / (1 + nonManifoldLoadByFace * nonManifoldLoadByFace),
    1 / (1 + warningLoad / faceCount),
    1 / (1 + (report.mesh.boundaryEdges / vertexCount) * (report.mesh.boundaryEdges / vertexCount)),
  ]) ?? 0;

  return health * meshValidityScore(report);
}

function surfaceHealthFactor(report) {
  if (report.error || !report.body || !report.mesh) return 0;

  const faceCount = Math.max(1, report.body.faceCount);
  const boundaryLoad = report.mesh.boundaryEdges / faceCount;
  const nonManifoldLoad = report.mesh.nonManifoldEdges / faceCount;

  const health = averageScore([
    1 / (1 + report.validation.errors.length / faceCount),
    1 / (1 + report.validation.warnings.length / (faceCount * 4)),
    1 / (1 + boundaryLoad),
    1 / (1 + nonManifoldLoad),
  ]) ?? 0;

  return (0.4 + health * 0.6) * meshValidityScore(report);
}

function surfaceScore(facePairs, surfaceType, report) {
  const raw = averageScore(
    facePairs
      .filter((pair) => pair.source.surfaceType === surfaceType)
      .map(surfaceFaceScore),
  );
  if (raw == null) return null;
  return raw * surfaceHealthFactor(report);
}

function computeScorecard(report) {
  if (report.error || !report.body || !report.mesh) {
    return {
      planes: 0,
      cylinders: 0,
      cones: 0,
      spheres: 0,
      tori: 0,
      bsplines: 0,
      faces: 0,
      geometry: 0,
      holesExact: 0,
      innerLoops: 0,
      vertices: 0,
      circles: 0,
      overall: 0,
    };
  }

  const facePairs = buildFacePairs(report);
  const faces = meshHealthScore(report);
  const geometry = meshValidityScore(report);
  const holedPairs = facePairs.filter((pair) => effectiveSourceInnerLoops(pair.source) > 0);
  const holesExact = averageScore(holedPairs.map((pair) =>
    pair.imported && effectiveSourceInnerLoops(pair.source) === pair.imported.innerLoops ? 1 : 0,
  )) ?? 1;
  const innerLoops = (
    (averageScore(facePairs.map((pair) =>
      ratioScore(effectiveSourceInnerLoops(pair.source), pair.imported?.innerLoops ?? 0),
    )) ?? 0) * 0.5 +
    ratioScore(report.source.normalizedInnerLoopCount, report.body.innerLoopCount) * 0.5
  );
  const boundaryVertexLoad = report.mesh.boundaryEdges / Math.max(1, report.body.vertexCount);
  const nonManifoldVertexLoad = report.mesh.nonManifoldEdges / Math.max(1, report.body.vertexCount);
  const vertices = averageScore([
    ratioScore(report.source.vertexCount, report.body.vertexCount),
    1 / (1 + boundaryVertexLoad * boundaryVertexLoad),
    1 / (1 + nonManifoldVertexLoad * nonManifoldVertexLoad),
  ]) ?? 0;
  const circles = averageScore(
    facePairs
      .filter((pair) => pair.source.hasCircularTrim)
      .map(circleFaceScore),
  );
  const surfaceFactor = surfaceHealthFactor(report);

  const scorecard = {
    planes: surfaceScore(facePairs, 'plane', report),
    cylinders: surfaceScore(facePairs, 'cylinder', report),
    cones: surfaceScore(facePairs, 'cone', report),
    spheres: surfaceScore(facePairs, 'sphere', report),
    tori: surfaceScore(facePairs, 'torus', report),
    bsplines: surfaceScore(facePairs, 'bspline', report),
    faces,
    geometry,
    holesExact,
    innerLoops,
    vertices,
    circles: circles == null ? null : circles * surfaceFactor,
  };

  scorecard.overall = averageScore(Object.values(scorecard)) ?? 0;
  return scorecard;
}

function formatPercent(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function modelLabel(file) {
  const match = file.match(/(?:nist_)?((?:ctc|ftc)_\d+)/i);
  if (match) return match[1].toUpperCase();
  return file.replace(/\.[^.]+$/, '').toUpperCase();
}

function buildScoreTableString(reports) {
  const columns = [
    { key: 'file', title: 'File', align: 'left' },
    { key: 'planes', title: 'Planes', align: 'right' },
    { key: 'cylinders', title: 'Cylinders', align: 'right' },
    { key: 'cones', title: 'Cones', align: 'right' },
    { key: 'spheres', title: 'Spheres', align: 'right' },
    { key: 'tori', title: 'Tori', align: 'right' },
    { key: 'bsplines', title: 'BSplines', align: 'right' },
    { key: 'faces', title: 'Faces', align: 'right' },
    { key: 'geometry', title: 'Geometry', align: 'right' },
    { key: 'holesExact', title: 'HolesExact', align: 'right' },
    { key: 'innerLoops', title: 'InnerLoops', align: 'right' },
    { key: 'vertices', title: 'Vertices', align: 'right' },
    { key: 'circles', title: 'Circles', align: 'right' },
    { key: 'overall', title: 'OVERALL', align: 'right' },
  ];

  const rows = reports.map((report) => ({
    file: modelLabel(report.file),
    ...Object.fromEntries(
      columns
        .filter((column) => column.key !== 'file')
        .map((column) => [column.key, formatPercent(report.scores[column.key])]),
    ),
  }));

  const averageRow = { file: 'AVERAGE' };
  for (const column of columns) {
    if (column.key === 'file') continue;
    averageRow[column.key] = formatPercent(
      averageScore(reports.map((report) => report.scores[column.key])),
    );
  }
  rows.push(averageRow);

  const widths = {};
  for (const column of columns) {
    widths[column.key] = Math.max(
      column.title.length,
      ...rows.map((row) => String(row[column.key]).length),
    );
  }

  const border = '+' + columns.map((column) => '-'.repeat(widths[column.key] + 2)).join('+') + '+';
  const renderCell = (value, width, align) =>
    align === 'left' ? String(value).padEnd(width, ' ') : String(value).padStart(width, ' ');
  const renderRow = (row) =>
    `| ${columns.map((column) => renderCell(row[column.key], widths[column.key], column.align)).join(' | ')} |`;

  return [
    border,
    renderRow(Object.fromEntries(columns.map((column) => [column.key, column.title]))),
    border,
    ...rows.map(renderRow),
    border,
  ].join('\n');
}

function printScoreTable(reports) {
  console.log(buildScoreTableString(reports));
}

function buildWorstFailures(reports, limit = 5) {
  return [...reports]
    .filter((report) => report.status === 'FAIL')
    .sort((a, b) => severityScore(b) - severityScore(a))
    .slice(0, limit);
}

function buildScorecardMarkdown({
  reports,
  passCount,
  warnCount,
  failCount,
  worstReports,
  samplePattern,
}) {
  const regenerateCommand = failCount > 0
    ? 'node tests/test-step-import-nist.js --write-scorecard --allow-failures'
    : 'node tests/test-step-import-nist.js --write-scorecard';
  const lines = [
    '# NIST STEP Import Scorecard',
    '',
    'Tracked baseline snapshot for STEP importer and robust tessellator progress against the public NIST corpus.',
    '',
    `Generated by \`${regenerateCommand}\` on ${new Date().toISOString()}.`,
    '',
    `Models: ${reports.length}`,
    `Import options: curveSegments=${IMPORT_OPTIONS.curveSegments}, surfaceSegments=${IMPORT_OPTIONS.surfaceSegments}`,
    `Sample filter: ${samplePattern || 'full corpus'}`,
    `Status counts: PASS ${passCount}, WARN ${warnCount}, FAIL ${failCount}`,
    '',
    '```text',
    buildScoreTableString(reports),
    '```',
    '',
    'Scoring notes:',
    '- `Faces` blends B-Rep validator health with tessellated face coverage and watertightness symptoms.',
    '- `Geometry` penalizes invalid B-Rep/tessellation output: validator errors, open or non-manifold mesh edges, degenerate triangles, inverted analytic normals, low-quality analytic slivers, and same-face self-intersections.',
    '- Surface columns score source-vs-imported B-Rep fidelity and tessellated coverage for each support surface type present in the corpus.',
    '- `HolesExact` measures exact effective hole-count preservation; STEP faces without `FACE_OUTER_BOUND` first infer one outer loop.',
    '- `Circles` tracks self-loop circular trims, which are currently a major STEP import/tessellation stress case.',
  ];

  if (worstReports.length) {
    lines.push('', 'Current worst failures:');
    for (const report of worstReports) {
      const headline = report.analysis.failures[0] || report.error || 'failed';
      lines.push(`- \`${modelLabel(report.file)}\`: ${headline}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function printFaceSamples(label, faces) {
  if (!faces.length) return;
  console.log(`  ${label}:`);
  for (const face of faces) {
    console.log(
      `    face ${face.id}: ${face.surfaceType}, loops=${face.loops}, innerLoops=${face.innerLoops}, ` +
      `outerCoedges=${face.outerCoedges}, totalCoedges=${face.totalCoedges}, selfLoopCoedges=${face.selfLoopCoedges}`,
    );
  }
}

function severityScore(report) {
  if (report.error) return 1e9;
  return (
    report.analysis.failures.length * 100000 +
    report.validation.errors.length * 1000 +
    report.mesh.missingFaces.length * 100 +
    report.mesh.selfIntersectionPairs * 10 +
    report.mesh.normalMismatchTriangles +
    report.mesh.analyticNormalInvertedTriangles * 10 +
    report.mesh.analyticNormalLowDotTriangles +
    report.mesh.degenerateTriangles +
    report.mesh.boundaryEdges +
    report.mesh.nonManifoldEdges
  );
}

async function analyzeFile(stepPath) {
  const stepString = await fs.readFile(stepPath, 'utf8');
  const source = collectSourceTopologyStats(stepString);

  try {
    const imported = importSTEP(stepString, IMPORT_OPTIONS);
    const body = summarizeImportedBody(imported.body);
    const mesh = analyzeMesh(imported, body);
    const validationResult = validateFull(imported.body);
    const validation = {
      errors: validationResult.errors,
      warnings: validationResult.warnings,
      errorPatterns: topPatterns(validationResult.errors),
      warningPatterns: topPatterns(validationResult.warnings),
    };

    const report = {
      file: path.basename(stepPath),
      stepPath,
      source,
      body,
      mesh,
      validation,
      error: null,
    };
    report.analysis = analyzeReport(report);
    report.scores = computeScorecard(report);
    report.status = report.analysis.failures.length > 0
      ? 'FAIL'
      : report.analysis.warnings.length > 0
        ? 'WARN'
        : 'PASS';
    return report;
  } catch (error) {
    const report = {
      file: path.basename(stepPath),
      stepPath,
      source,
      body: null,
      mesh: null,
      validation: { errors: [], warnings: [], errorPatterns: [], warningPatterns: [] },
      error: error.message,
    };
    report.analysis = analyzeReport(report);
    report.scores = computeScorecard(report);
    report.status = 'FAIL';
    return report;
  }
}

function printReport(report) {
  console.log(`\n[${report.status}] ${report.file}`);
  console.log(`  Source topology : ${formatTopologySummary(report.source)}`);

  if (report.error) {
    console.log(`  Import error    : ${report.error}`);
    return;
  }

  console.log(`  Imported body   : ${formatTopologySummary(report.body)}`);
  console.log(`  Tessellation    : ${formatMeshSummary(report.mesh, report.body)}`);

  if (report.analysis.failures.length) {
    console.log('  Hard failures:');
    for (const failure of report.analysis.failures) {
      console.log(`    - ${failure}`);
    }
  }

  if (report.analysis.warnings.length) {
    console.log('  Warnings:');
    for (const warning of report.analysis.warnings) {
      console.log(`    - ${warning}`);
    }
  }

  if (report.analysis.notes.length) {
    console.log('  Analysis:');
    for (const note of report.analysis.notes) {
      console.log(`    - ${note}`);
    }
  }

  if (report.validation.errorPatterns.length) {
    console.log(`  Validator errors: ${formatPatterns(report.validation.errorPatterns)}`);
  }
  if (report.validation.warningPatterns.length) {
    console.log(`  Validator warnings: ${formatPatterns(report.validation.warningPatterns)}`);
  }

  if (report.mesh.missingFaces.length) {
    console.log(`  Missing face breakdown: ${formatBreakdown(report.mesh.missingSurfaceBreakdown)}`);
    printFaceSamples('Missing face samples', report.mesh.missingFaces.slice(0, 8));
  }
}

// --- Regression gate -----------------------------------------------------
// Parses the committed NIST scorecard markdown (tests/step-import-nist-scorecard.md)
// into a per-sample, per-column baseline. Used by --regression-gate to fail the
// suite if any metric drops by more than a tolerance (percentage points).

const GATE_COLUMN_TITLES = {
  Planes: 'planes',
  Cylinders: 'cylinders',
  Cones: 'cones',
  Spheres: 'spheres',
  Tori: 'tori',
  BSplines: 'bsplines',
  Faces: 'faces',
  Geometry: 'geometry',
  HolesExact: 'holesExact',
  InnerLoops: 'innerLoops',
  Vertices: 'vertices',
  Circles: 'circles',
  OVERALL: 'overall',
};

function parseScorecardBaseline(markdown) {
  const lines = markdown.split(/\r?\n/);
  // Locate the rendered ASCII table inside the fenced ```text block.
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '```text') {
      start = i + 1;
      break;
    }
  }
  if (start < 0) throw new Error('Scorecard baseline: could not locate ```text table block');

  const tableLines = [];
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() === '```') break;
    tableLines.push(lines[i]);
  }
  // Expect at least: border, header, border, data rows..., border
  if (tableLines.length < 5) throw new Error('Scorecard baseline: table too short');

  const header = tableLines[1];
  const cells = header.split('|').map((cell) => cell.trim()).filter((cell) => cell.length > 0);
  const columnKeys = cells.map((title) => GATE_COLUMN_TITLES[title] ?? null);
  if (columnKeys[0] !== null && cells[0] !== 'File') {
    throw new Error('Scorecard baseline: first column must be File');
  }

  const rows = {};
  for (let i = 3; i < tableLines.length - 1; i++) {
    const line = tableLines[i];
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map((cell) => cell.trim());
    // parts[0] and parts[last] are empty (outer pipes)
    const dataCells = parts.slice(1, parts.length - 1);
    if (dataCells.length !== cells.length) continue;
    const fileLabel = dataCells[0];
    if (!fileLabel || fileLabel === 'AVERAGE') continue;
    const scores = {};
    for (let c = 1; c < cells.length; c++) {
      const key = columnKeys[c];
      if (!key) continue;
      const raw = dataCells[c];
      if (raw === 'n/a' || raw === '') {
        scores[key] = null;
      } else {
        const m = /^([\d.]+)%$/.exec(raw);
        if (!m) continue;
        scores[key] = Number(m[1]) / 100;
      }
    }
    rows[fileLabel] = scores;
  }

  if (!Object.keys(rows).length) throw new Error('Scorecard baseline: no data rows parsed');
  return rows;
}

function enforceRegressionGate(reports, baseline, tolerancePp) {
  const toleranceFrac = tolerancePp / 100;
  const regressions = [];
  const missingFromBaseline = [];
  const baselineLabels = new Set(Object.keys(baseline));

  for (const report of reports) {
    const label = modelLabel(report.file);
    const baselineScores = baseline[label];
    if (!baselineScores) {
      missingFromBaseline.push(label);
      continue;
    }
    baselineLabels.delete(label);
    for (const [key, baselineValue] of Object.entries(baselineScores)) {
      if (baselineValue == null) continue;
      const currentValue = report.scores[key];
      if (currentValue == null) {
        regressions.push({
          label,
          metric: key,
          baseline: baselineValue,
          current: null,
          delta: -baselineValue,
        });
        continue;
      }
      const delta = currentValue - baselineValue;
      if (delta < -toleranceFrac) {
        regressions.push({ label, metric: key, baseline: baselineValue, current: currentValue, delta });
      }
    }
  }

  const orphanBaseline = Array.from(baselineLabels);

  console.log('\n=== Regression Gate ===');
  console.log(`Tolerance: ${tolerancePp.toFixed(2)} percentage points per metric.`);
  if (missingFromBaseline.length) {
    console.log(`Samples missing from baseline (ignored): ${missingFromBaseline.join(', ')}`);
  }
  if (orphanBaseline.length) {
    console.log(`Baseline samples not present in current run: ${orphanBaseline.join(', ')}`);
  }

  if (!regressions.length) {
    console.log('Gate: PASS — no metric regressed beyond tolerance.');
    return true;
  }

  console.log(`Gate: FAIL — ${regressions.length} metric regression(s):`);
  for (const r of regressions) {
    const before = formatPercent(r.baseline);
    const after = r.current == null ? 'n/a' : formatPercent(r.current);
    const deltaPp = (r.delta * 100).toFixed(2);
    console.log(`  - ${r.label} / ${r.metric}: ${before} -> ${after} (Δ ${deltaPp} pp)`);
  }
  console.log(
    'If this regression is intentional, regenerate the baseline with ' +
    '`npm run test:nist-step:scorecard` and commit the updated markdown.',
  );
  return false;
}

async function main() {
  const {
    samplePattern,
    writeScorecardPath,
    allowFailures,
    regressionGate,
    regressionTolerance,
  } = parseCliArgs(process.argv.slice(2));

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
  } catch {
    if (regressionGate) {
      console.error('NIST regression gate: sample manifest not found. Run `npm run download` first.');
      process.exitCode = 1;
      return;
    }
    console.log('NIST sample manifest not found. Run `npm run download` first.');
    return;
  }

  const stepFiles = [];
  for (const source of manifest.sources || []) {
    for (const file of source.files || []) {
      if (file.format !== 'step') continue;
      const basename = path.basename(file.relativePath);
      const haystack = `${basename} ${file.relativePath}`.toLowerCase();
      if (samplePattern && !haystack.includes(samplePattern)) continue;
      stepFiles.push(path.join(NIST_ROOT, file.relativePath));
    }
  }

  if (stepFiles.length === 0) {
    console.error(`No STEP files matched${samplePattern ? ` pattern '${samplePattern}'` : ''}.`);
    process.exitCode = 1;
    return;
  }

  console.log('=== NIST STEP Import Corpus Diagnostics ===');
  console.log(`Models: ${stepFiles.length}`);
  console.log(`Import options: curveSegments=${IMPORT_OPTIONS.curveSegments}, surfaceSegments=${IMPORT_OPTIONS.surfaceSegments}`);

  const reports = [];
  for (const stepPath of stepFiles) {
    const report = await analyzeFile(stepPath);
    reports.push(report);
    printReport(report);
  }

  const passCount = reports.filter((report) => report.status === 'PASS').length;
  const warnCount = reports.filter((report) => report.status === 'WARN').length;
  const failCount = reports.filter((report) => report.status === 'FAIL').length;

  console.log('\n=== Summary ===');
  console.log(`PASS: ${passCount}`);
  console.log(`WARN: ${warnCount}`);
  console.log(`FAIL: ${failCount}`);

  console.log('\n=== Scorecard ===');
  printScoreTable(reports);
  console.log('Scores combine source-vs-imported B-Rep fidelity with tessellated face coverage and geometry validity.');
  console.log('`Geometry` penalizes open/non-manifold edges, degenerate triangles, inverted or low-quality analytic normals, self-intersections, and B-Rep validation errors.');
  console.log('`HolesExact` checks effective B-Rep hole counts; `Circles` tracks self-loop circular trims.');

  const worstReports = buildWorstFailures(reports);

  if (worstReports.length) {
    console.log('Worst failures:');
    for (const report of worstReports) {
      const headline = report.analysis.failures[0] || report.error || 'failed';
      console.log(`  - ${report.file}: ${headline}`);
    }
  }

  if (writeScorecardPath) {
    const markdown = buildScorecardMarkdown({
      reports,
      passCount,
      warnCount,
      failCount,
      worstReports,
      samplePattern,
    });
    await fs.writeFile(writeScorecardPath, markdown, 'utf8');
    console.log(`Scorecard written to ${path.relative(process.cwd(), writeScorecardPath) || writeScorecardPath}`);
  }

  if (regressionGate) {
    let baseline;
    try {
      const mdRaw = await fs.readFile(DEFAULT_SCORECARD_PATH, 'utf8');
      baseline = parseScorecardBaseline(mdRaw);
    } catch (err) {
      console.error(`NIST regression gate: failed to load baseline — ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const passed = enforceRegressionGate(reports, baseline, regressionTolerance);
    if (!passed) process.exitCode = 1;
  }

  if (failCount > 0 && !allowFailures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

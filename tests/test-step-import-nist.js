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
 * 5. Measures mesh boundary/non-manifold edges to expose obvious stitching bugs
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
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node tests/test-step-import-nist.js ' +
        '[--sample <substring>] [--write-scorecard [path]] [--allow-failures]',
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    samplePattern: samplePattern.trim().toLowerCase(),
    writeScorecardPath: writeScorecardPath ? path.resolve(process.cwd(), writeScorecardPath) : '',
    allowFailures,
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

function analyzeMesh(mesh, bodySummary) {
  const faceIdsWithTriangles = new Set();
  const edgeMap = new Map();
  let degenerateTriangles = 0;

  const vertexKey = (v) => `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;
  const edgeKey = (a, b) => {
    const ka = vertexKey(a);
    const kb = vertexKey(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };

  for (const face of mesh.faces) {
    if (typeof face.topoFaceId === 'number') faceIdsWithTriangles.add(face.topoFaceId);
    if (triangleArea2(face) < 1e-20) degenerateTriangles++;

    const verts = face.vertices || [];
    for (let i = 0; i < verts.length; i++) {
      const key = edgeKey(verts[i], verts[(i + 1) % verts.length]);
      edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
    }
  }

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
    missingFaces,
    missingSurfaceBreakdown,
    missingWithInnerLoops,
    missingWithSingleCoedgeOuterLoop,
    missingWithSelfLoopCoedges,
  };
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
  if (mesh.degenerateTriangles > 0) {
    warnings.push(`tessellated mesh has ${mesh.degenerateTriangles} degenerate triangle(s)`);
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
    `${mesh.boundaryEdges} boundary edge(s), ${mesh.nonManifoldEdges} non-manifold edge(s)`;
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

function meshHealthScore(report) {
  if (report.error || !report.body || !report.mesh) return 0;

  const faceCount = Math.max(1, report.body.faceCount);
  const vertexCount = Math.max(1, report.body.vertexCount);
  const warningLoad = report.validation.errors.length + report.validation.warnings.length * 0.35;
  const boundaryLoadByFace = report.mesh.boundaryEdges / faceCount;
  const nonManifoldLoadByFace = report.mesh.nonManifoldEdges / faceCount;

  return averageScore([
    ratioScore(report.body.faceCount, report.mesh.faceGroupCount),
    1 / (1 + boundaryLoadByFace * boundaryLoadByFace),
    1 / (1 + nonManifoldLoadByFace * nonManifoldLoadByFace),
    1 / (1 + warningLoad / faceCount),
    1 / (1 + (report.mesh.boundaryEdges / vertexCount) * (report.mesh.boundaryEdges / vertexCount)),
  ]) ?? 0;
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

  return 0.4 + health * 0.6;
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
      faces: 0,
      holesExact: 0,
      innerLoops: 0,
      vertices: 0,
      circles: 0,
      overall: 0,
    };
  }

  const facePairs = buildFacePairs(report);
  const faces = meshHealthScore(report);
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
    faces,
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
    { key: 'faces', title: 'Faces', align: 'right' },
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
  const lines = [
    '# NIST STEP Import Scorecard',
    '',
    'Tracked baseline snapshot for STEP importer and robust tessellator progress against the public NIST corpus.',
    '',
    `Generated by \`node tests/test-step-import-nist.js --write-scorecard\` on ${new Date().toISOString()}.`,
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

async function main() {
  const { samplePattern, writeScorecardPath, allowFailures } = parseCliArgs(process.argv.slice(2));

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
  } catch {
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
  console.log('Scores combine source-vs-imported B-Rep fidelity with tessellated face coverage.');
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

  if (failCount > 0 && !allowFailures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

#!/usr/bin/env node
import './_watchdog.mjs';
/**
 * tests/test-step-roundtrip-nist.js
 *
 * Round-trip validation for the public NIST STEP corpus:
 *
 *   input STEP -> importSTEP() -> exact TopoBody -> exportSTEP() -> importSTEP()
 *
 * The comparison is based on exact topology counts plus tolerant geometric
 * equality of the imported exact B-Rep, not raw STEP text.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NIST_ROOT = path.join(__dirname, 'nist-samples');
const MANIFEST_PATH = path.join(NIST_ROOT, 'manifest.json');
const IMPORT_OPTIONS = { curveSegments: 16, surfaceSegments: 12 };
const GEOMETRY_COMPARE_TOL = 1e-3;

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
const { exportSTEP } = await import('../js/cad/StepExport.js');
const { validateFull } = await import('../js/cad/BRepValidator.js');

function parseCliArgs(argv) {
  let samplePattern = '';
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
    if (arg === '--allow-failures') {
      allowFailures = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node tests/test-step-roundtrip-nist.js ' +
        '[--sample <substring>] [--allow-failures]',
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    samplePattern: samplePattern.trim().toLowerCase(),
    allowFailures,
  };
}

function incrementBreakdown(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function approxEqual(a, b, tol = GEOMETRY_COMPARE_TOL) {
  return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= tol;
}

function approxPoint(a, b, tol = GEOMETRY_COMPARE_TOL) {
  return approxEqual(a.x, b.x, tol) && approxEqual(a.y, b.y, tol) && approxEqual(a.z, b.z, tol);
}

function prettyNumber(value, digits = 4) {
  return (Number(value) || 0).toFixed(digits);
}

function prettyPoint(point, digits = 4) {
  return `${prettyNumber(point.x, digits)},${prettyNumber(point.y, digits)},${prettyNumber(point.z, digits)}`;
}

function normalizeVec(vec) {
  if (!vec) return null;
  return { x: Number(vec.x) || 0, y: Number(vec.y) || 0, z: Number(vec.z) || 0 };
}

function makeFaceDescriptor(face) {
  const loops = face.allLoops();
  let totalCoedges = 0;
  let selfLoopCoedges = 0;
  for (const loop of loops) {
    totalCoedges += loop.coedges.length;
    for (const coedge of loop.coedges) {
      if (coedge.edge.startVertex === coedge.edge.endVertex) selfLoopCoedges++;
    }
  }

  return {
    surfaceType: face.surfaceType || 'unknown',
    loops: loops.length,
    innerLoops: face.innerLoops.length,
    outerCoedges: face.outerLoop?.coedges?.length || 0,
    totalCoedges,
    selfLoopCoedges,
    surfaceInfoType: face.surfaceInfo?.type || null,
    origin: face.surfaceInfo?.origin ? { ...face.surfaceInfo.origin } : null,
    normal: face.surfaceInfo?.normal ? normalizeVec(face.surfaceInfo.normal) : null,
    axis: face.surfaceInfo?.axis ? normalizeVec(face.surfaceInfo.axis) : null,
    radius: face.surfaceInfo?.radius ?? null,
    semiAngle: face.surfaceInfo?.semiAngle ?? null,
    majorR: face.surfaceInfo?.majorR ?? null,
    minorR: face.surfaceInfo?.minorR ?? null,
    bsplineShape: face.surface
      ? `${face.surface.degreeU}:${face.surface.degreeV}:${face.surface.numRowsU}:${face.surface.numColsV}`
      : null,
  };
}

function descriptorSortKey(desc) {
  const origin = desc.origin ? prettyPoint(desc.origin, 3) : '';
  const axis = desc.axis ? prettyPoint(desc.axis, 3) : '';
  const normal = desc.normal ? prettyPoint(desc.normal, 3) : '';
  const radius = desc.radius == null ? '' : prettyNumber(desc.radius, 3);
  const semiAngle = desc.semiAngle == null ? '' : prettyNumber(desc.semiAngle, 3);
  const majorR = desc.majorR == null ? '' : prettyNumber(desc.majorR, 3);
  const minorR = desc.minorR == null ? '' : prettyNumber(desc.minorR, 3);
  return [
    desc.surfaceType,
    desc.surfaceInfoType || '',
    desc.loops,
    desc.innerLoops,
    desc.outerCoedges,
    desc.totalCoedges,
    desc.selfLoopCoedges,
    origin,
    axis,
    normal,
    radius,
    semiAngle,
    majorR,
    minorR,
    desc.bsplineShape || '',
  ].join('|');
}

function vertexSort(a, b) {
  if (a.x !== b.x) return a.x - b.x;
  if (a.y !== b.y) return a.y - b.y;
  return a.z - b.z;
}

function compareFaceDescriptors(inputDesc, outputDesc) {
  if (inputDesc.surfaceType !== outputDesc.surfaceType) return false;
  if (inputDesc.surfaceInfoType !== outputDesc.surfaceInfoType) return false;
  if (inputDesc.loops !== outputDesc.loops) return false;
  if (inputDesc.innerLoops !== outputDesc.innerLoops) return false;
  if (inputDesc.outerCoedges !== outputDesc.outerCoedges) return false;
  if (inputDesc.totalCoedges !== outputDesc.totalCoedges) return false;
  if (inputDesc.selfLoopCoedges !== outputDesc.selfLoopCoedges) return false;
  if ((inputDesc.bsplineShape || null) !== (outputDesc.bsplineShape || null)) return false;

  const pairedPoints = [
    [inputDesc.origin, outputDesc.origin],
    [inputDesc.normal, outputDesc.normal],
    [inputDesc.axis, outputDesc.axis],
  ];
  for (const [lhs, rhs] of pairedPoints) {
    if (!!lhs !== !!rhs) return false;
    if (lhs && rhs && !approxPoint(lhs, rhs)) return false;
  }

  const pairedScalars = [
    [inputDesc.radius, outputDesc.radius],
    [inputDesc.semiAngle, outputDesc.semiAngle],
    [inputDesc.majorR, outputDesc.majorR],
    [inputDesc.minorR, outputDesc.minorR],
  ];
  for (const [lhs, rhs] of pairedScalars) {
    if ((lhs == null) !== (rhs == null)) return false;
    if (lhs != null && rhs != null && !approxEqual(lhs, rhs)) return false;
  }

  return true;
}

function boundsOfBody(body) {
  const vertices = body.vertices().map((vertex) => vertex.point);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const point of vertices) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.z < minZ) minZ = point.z;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
    if (point.z > maxZ) maxZ = point.z;
  }
  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    sizeX: maxX - minX,
    sizeY: maxY - minY,
    sizeZ: maxZ - minZ,
  };
}

function summarizeBody(body) {
  const surfaceBreakdown = {};
  const faceDescriptors = body.faces()
    .map((face) => {
      incrementBreakdown(surfaceBreakdown, face.surfaceType || 'unknown');
      return makeFaceDescriptor(face);
    })
    .sort((a, b) => descriptorSortKey(a).localeCompare(descriptorSortKey(b)));

  const vertices = body.vertices().map((vertex) => ({ ...vertex.point })).sort(vertexSort);
  let loopCount = 0;
  let innerLoopCount = 0;
  for (const face of body.faces()) {
    loopCount += face.allLoops().length;
    innerLoopCount += face.innerLoops.length;
  }

  return {
    shellCount: body.shells.length,
    closedShellCount: body.shells.filter((shell) => shell.closed).length,
    faceCount: body.faces().length,
    loopCount,
    innerLoopCount,
    edgeCount: body.edges().length,
    vertexCount: body.vertices().length,
    surfaceBreakdown,
    faceDescriptors,
    vertices,
    bounds: boundsOfBody(body),
  };
}

function compareBreakdowns(inputBreakdown, outputBreakdown) {
  const keys = new Set([...Object.keys(inputBreakdown), ...Object.keys(outputBreakdown)]);
  const diffs = [];
  for (const key of [...keys].sort()) {
    const inputCount = inputBreakdown[key] || 0;
    const outputCount = outputBreakdown[key] || 0;
    if (inputCount !== outputCount) diffs.push(`${key}: input ${inputCount}, output ${outputCount}`);
  }
  return diffs;
}

function describeFaceDescriptor(desc) {
  const parts = [
    `type=${desc.surfaceType}`,
    `loops=${desc.loops}`,
    `inner=${desc.innerLoops}`,
    `outer=${desc.outerCoedges}`,
    `coedges=${desc.totalCoedges}`,
    `selfLoops=${desc.selfLoopCoedges}`,
  ];
  if (desc.origin) parts.push(`origin=${prettyPoint(desc.origin)}`);
  if (desc.normal) parts.push(`normal=${prettyPoint(desc.normal)}`);
  if (desc.axis) parts.push(`axis=${prettyPoint(desc.axis)}`);
  if (desc.radius != null) parts.push(`radius=${prettyNumber(desc.radius)}`);
  if (desc.semiAngle != null) parts.push(`semiAngle=${prettyNumber(desc.semiAngle)}`);
  if (desc.majorR != null) parts.push(`majorR=${prettyNumber(desc.majorR)}`);
  if (desc.minorR != null) parts.push(`minorR=${prettyNumber(desc.minorR)}`);
  if (desc.bsplineShape) parts.push(`surf=${desc.bsplineShape}`);
  return parts.join('|');
}

function compareVertices(inputVertices, outputVertices, limit = 20) {
  if (inputVertices.length !== outputVertices.length) {
    return [`vertex count mismatch: input ${inputVertices.length}, output ${outputVertices.length}`];
  }

  const used = new Array(outputVertices.length).fill(false);
  const diffs = [];
  for (let i = 0; i < inputVertices.length; i++) {
    let matchIndex = -1;
    for (let j = 0; j < outputVertices.length; j++) {
      if (used[j]) continue;
      if (approxPoint(inputVertices[i], outputVertices[j])) {
        matchIndex = j;
        break;
      }
    }

    if (matchIndex >= 0) {
      used[matchIndex] = true;
      continue;
    }

    const fallbackIndex = used.findIndex((flag) => !flag);
    const fallback = fallbackIndex >= 0 ? outputVertices[fallbackIndex] : outputVertices[outputVertices.length - 1];
    if (fallbackIndex >= 0) used[fallbackIndex] = true;

    diffs.push(
      `vertex set differs at item ${i + 1}: input ${prettyPoint(inputVertices[i])} | ` +
      `output ${prettyPoint(fallback)}`,
    );
    if (diffs.length >= limit) break;
  }
  return diffs;
}

function compareFaces(inputFaces, outputFaces, limit = 20) {
  if (inputFaces.length !== outputFaces.length) {
    return [`face descriptor count mismatch: input ${inputFaces.length}, output ${outputFaces.length}`];
  }

  const used = new Array(outputFaces.length).fill(false);
  const diffs = [];
  for (let i = 0; i < inputFaces.length; i++) {
    let matchIndex = -1;
    for (let j = 0; j < outputFaces.length; j++) {
      if (used[j]) continue;
      if (compareFaceDescriptors(inputFaces[i], outputFaces[j])) {
        matchIndex = j;
        break;
      }
    }

    if (matchIndex >= 0) {
      used[matchIndex] = true;
      continue;
    }

    const fallbackIndex = used.findIndex((flag) => !flag);
    const fallback = fallbackIndex >= 0 ? outputFaces[fallbackIndex] : outputFaces[outputFaces.length - 1];
    if (fallbackIndex >= 0) used[fallbackIndex] = true;

    diffs.push(
      `face descriptor differs at item ${i + 1}: input ${describeFaceDescriptor(inputFaces[i])} | ` +
      `output ${describeFaceDescriptor(fallback)}`,
    );
    if (diffs.length >= limit) break;
  }
  return diffs;
}

function formatBreakdown(breakdown) {
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return 'none';
  return entries.map(([key, value]) => `${key} ${value}`).join(', ');
}

function formatSummary(summary) {
  return [
    `shells=${summary.shellCount}`,
    `closed=${summary.closedShellCount}`,
    `faces=${summary.faceCount}`,
    `loops=${summary.loopCount}`,
    `holes=${summary.innerLoopCount}`,
    `edges=${summary.edgeCount}`,
    `vertices=${summary.vertexCount}`,
    `surfaces=[${formatBreakdown(summary.surfaceBreakdown)}]`,
    `bbox=${prettyNumber(summary.bounds.sizeX)}x${prettyNumber(summary.bounds.sizeY)}x${prettyNumber(summary.bounds.sizeZ)}`,
  ].join(', ');
}

function analyzeRoundTrip(inputBody, outputBody, inputValidation, outputValidation) {
  const input = summarizeBody(inputBody);
  const output = summarizeBody(outputBody);
  const failures = [];
  const warnings = [];

  const exactComparisons = [
    ['shell count', input.shellCount, output.shellCount],
    ['closed shell count', input.closedShellCount, output.closedShellCount],
    ['face count', input.faceCount, output.faceCount],
    ['loop count', input.loopCount, output.loopCount],
    ['inner loop count', input.innerLoopCount, output.innerLoopCount],
    ['edge count', input.edgeCount, output.edgeCount],
    ['vertex count', input.vertexCount, output.vertexCount],
  ];
  for (const [label, expected, actual] of exactComparisons) {
    if (expected !== actual) failures.push(`${label} mismatch: input ${expected}, output ${actual}`);
  }

  const surfaceDiffs = compareBreakdowns(input.surfaceBreakdown, output.surfaceBreakdown);
  if (surfaceDiffs.length) failures.push(`surface breakdown mismatch: ${surfaceDiffs.slice(0, 6).join('; ')}`);

  failures.push(...compareFaces(input.faceDescriptors, output.faceDescriptors));
  failures.push(...compareVertices(input.vertices, output.vertices));

  const pairedBounds = [
    [input.bounds.minX, output.bounds.minX],
    [input.bounds.minY, output.bounds.minY],
    [input.bounds.minZ, output.bounds.minZ],
    [input.bounds.maxX, output.bounds.maxX],
    [input.bounds.maxY, output.bounds.maxY],
    [input.bounds.maxZ, output.bounds.maxZ],
  ];
  if (!pairedBounds.every(([lhs, rhs]) => approxEqual(lhs, rhs))) {
    failures.push(
      `body bounds mismatch: input ${prettyNumber(input.bounds.sizeX)}x${prettyNumber(input.bounds.sizeY)}x${prettyNumber(input.bounds.sizeZ)}, ` +
      `output ${prettyNumber(output.bounds.sizeX)}x${prettyNumber(output.bounds.sizeY)}x${prettyNumber(output.bounds.sizeZ)}`,
    );
  }

  if (inputValidation.errors.length > 0) {
    warnings.push(`input body validator reported ${inputValidation.errors.length} error(s)`);
  }
  if (inputValidation.warnings.length > 0) {
    warnings.push(`input body validator reported ${inputValidation.warnings.length} warning(s)`);
  }
  if (outputValidation.errors.length > 0) {
    failures.push(`round-tripped body validator reported ${outputValidation.errors.length} error(s)`);
  }
  if (outputValidation.warnings.length > 0) {
    warnings.push(`round-tripped body validator reported ${outputValidation.warnings.length} warning(s)`);
  }

  return { input, output, failures, warnings };
}

async function analyzeFile(stepPath) {
  const file = path.basename(stepPath);
  const stepString = await fs.readFile(stepPath, 'utf8');

  try {
    const imported = importSTEP(stepString, IMPORT_OPTIONS);
    const inputValidation = validateFull(imported.body);
    const exported = exportSTEP(imported.body, { filename: file.replace(/\.[^.]+$/, '') });
    const roundTripped = importSTEP(exported, IMPORT_OPTIONS);
    const outputValidation = validateFull(roundTripped.body);
    const comparison = analyzeRoundTrip(imported.body, roundTripped.body, inputValidation, outputValidation);

    return {
      file,
      status: comparison.failures.length > 0 ? 'FAIL' : comparison.warnings.length > 0 ? 'WARN' : 'PASS',
      exportedBytes: Buffer.byteLength(exported, 'utf8'),
      input: comparison.input,
      output: comparison.output,
      failures: comparison.failures,
      warnings: comparison.warnings,
      error: null,
    };
  } catch (error) {
    return {
      file,
      status: 'FAIL',
      exportedBytes: 0,
      input: null,
      output: null,
      failures: [`round-trip threw: ${error.message}`],
      warnings: [],
      error: error.message,
    };
  }
}

function printReport(report) {
  console.log(`\n[${report.status}] ${report.file}`);
  if (report.input) console.log(`  Input body  : ${formatSummary(report.input)}`);
  if (report.output) console.log(`  Output body : ${formatSummary(report.output)}`);
  if (report.exportedBytes > 0) console.log(`  Export size : ${report.exportedBytes} bytes`);
  if (report.failures.length) {
    console.log('  Failures:');
    for (const failure of report.failures) console.log(`    - ${failure}`);
  }
  if (report.warnings.length) {
    console.log('  Warnings:');
    for (const warning of report.warnings) console.log(`    - ${warning}`);
  }
}

async function main() {
  const { samplePattern, allowFailures } = parseCliArgs(process.argv.slice(2));

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

  console.log('=== NIST STEP Round-Trip Diagnostics ===');
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

  if (failCount > 0) {
    console.log('\nWorst failures:');
    for (const report of reports.filter((entry) => entry.status === 'FAIL').slice(0, 5)) {
      console.log(`  - ${report.file}: ${report.failures[0] || report.error || 'failed'}`);
    }
  }

  if (failCount > 0 && !allowFailures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
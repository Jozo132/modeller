#!/usr/bin/env node
// tests/analyze-cmod.js — Advanced .cmod geometry analysis tool
//
// Usage:  node tests/analyze-cmod.js <file.cmod> [--json] [--verbose]
//
// Loads a .cmod file, rebuilds the Part, and prints a detailed diagnostic
// report covering: feature tree, triangle meshes, face groups (flat vs curved),
// feature edges, polyline paths, manifold checks, and plane-reference eligibility.

import { readFileSync } from 'fs';
import { resolve, basename } from 'path';
import { Part } from '../js/cad/Part.js';
import { parseCMOD } from '../js/cmod.js';
import {
  calculateMeshVolume,
  calculateBoundingBox,
  calculateSurfaceArea,
  detectDisconnectedBodies,
  calculateWallThickness,
  countInvertedFaces,
} from '../js/cad/toolkit/MeshAnalysis.js';
import { makeEdgeKey } from '../js/cad/EdgeAnalysis.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FMT = (n, d = 5) => typeof n === 'number' ? n.toFixed(d) : String(n);
const V = (v) => `(${FMT(v.x)}, ${FMT(v.y)}, ${FMT(v.z)})`;
const VK = (v) => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
const EK = (a, b) => { const ka = VK(a), kb = VK(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };

function triArea(a, b, c) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

function faceArea(verts) {
  let a = 0;
  for (let i = 1; i < verts.length - 1; i++) a += triArea(verts[0], verts[i], verts[i + 1]);
  return a;
}

function triangleCount(face) {
  return Math.max(0, face.vertices.length - 2);
}

function vecLen(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
function edgeLen(a, b) { return vecLen({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }); }

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const files = args.filter(a => !a.startsWith('--'));
const jsonMode = flags.has('--json');
const verbose = flags.has('--verbose');

if (files.length === 0) {
  console.error('Usage: node tests/analyze-cmod.js <file.cmod> [--json] [--verbose]');
  process.exit(1);
}

const filePath = resolve(files[0]);
const raw = readFileSync(filePath, 'utf-8');
const parsed = parseCMOD(raw);
if (!parsed.ok) {
  console.error(`CMOD parse error: ${parsed.error}`);
  process.exit(1);
}

const cmod = parsed.data;

// ---------------------------------------------------------------------------
// Rebuild Part
// ---------------------------------------------------------------------------

if (!cmod.part) {
  console.error('CMOD file has no part data.');
  process.exit(1);
}

const part = Part.deserialize(cmod.part);
const result = part.getFinalGeometry();

if (!result || !result.geometry) {
  console.error('Part produced no solid geometry.');
  process.exit(1);
}

const geom = result.geometry;
const faces = geom.faces || [];
const edges = geom.edges || [];
const paths = geom.paths || [];
const visualEdges = geom.visualEdges || [];

// ---------------------------------------------------------------------------
// Compute all diagnostic data
// ---------------------------------------------------------------------------

const report = {};

// --- File info ---
report.file = {
  name: basename(filePath),
  format: cmod.format,
  version: cmod.version,
};

// --- Feature tree ---
const features = part.getFeatures();
report.featureTree = features.map(f => ({
  id: f.id,
  name: f.name,
  type: f.type,
  suppressed: f.suppressed,
  visible: f.visible,
}));

// --- Global geometry stats ---
const bb = calculateBoundingBox(geom);
const vol = calculateMeshVolume(geom);
const sa = calculateSurfaceArea(geom);
const bodies = detectDisconnectedBodies(geom);
const wt = calculateWallThickness(geom);
const invertedFaceCount = countInvertedFaces(geom);

report.geometry = {
  faceCount: faces.length,
  edgeCount: edges.length,
  pathCount: paths.length,
  visualEdgeCount: visualEdges.length,
  volume: +vol.toFixed(6),
  surfaceArea: +sa.toFixed(6),
  boundingBox: bb,
  dimensions: {
    width: +(bb.max.x - bb.min.x).toFixed(6),
    height: +(bb.max.y - bb.min.y).toFixed(6),
    depth: +(bb.max.z - bb.min.z).toFixed(6),
  },
  bodyCount: bodies.bodyCount,
  bodySizes: bodies.bodySizes,
  wallThickness: { min: +wt.minThickness.toFixed(6), max: +wt.maxThickness.toFixed(6) },
  invertedFaceCount,
};

// --- Triangle mesh analysis ---
let totalTriangles = 0;
let totalVertices = 0;
const vertexSet = new Set();
for (const face of faces) {
  totalTriangles += triangleCount(face);
  for (const v of face.vertices) {
    totalVertices++;
    vertexSet.add(VK(v));
  }
}
report.mesh = {
  totalTriangles,
  totalFaceVertices: totalVertices,
  uniqueVertices: vertexSet.size,
  polygonSizes: {},
};
for (const face of faces) {
  const n = face.vertices.length;
  report.mesh.polygonSizes[n] = (report.mesh.polygonSizes[n] || 0) + 1;
}

// --- Manifold check ---
const meshEdgeCounts = new Map();
const directedEdges = new Map();
for (let fi = 0; fi < faces.length; fi++) {
  const verts = faces[fi].vertices;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const ek = EK(a, b);
    meshEdgeCounts.set(ek, (meshEdgeCounts.get(ek) || 0) + 1);
    const ka = VK(a), kb = VK(b);
    const fwd = ka < kb;
    if (!directedEdges.has(ek)) directedEdges.set(ek, []);
    directedEdges.get(ek).push({ fi, fwd });
  }
}

let boundaryEdges = 0, nonManifoldEdges = 0, windingErrors = 0;
for (const [, count] of meshEdgeCounts) {
  if (count === 1) boundaryEdges++;
  if (count > 2) nonManifoldEdges++;
}
for (const [, entries] of directedEdges) {
  if (entries.length === 2 && entries[0].fwd === entries[1].fwd) windingErrors++;
}

report.manifold = {
  meshEdgeCount: meshEdgeCounts.size,
  boundaryEdges,
  nonManifoldEdges,
  windingErrors,
  isManifold: boundaryEdges === 0 && nonManifoldEdges === 0,
  isConsistentWinding: windingErrors === 0,
};

// --- Face groups with flat/curved classification ---
const groupMap = new Map(); // groupId → { faces, area, type, normal, ... }
for (let fi = 0; fi < faces.length; fi++) {
  const f = faces[fi];
  const g = f.faceGroup;
  if (!groupMap.has(g)) {
    groupMap.set(g, {
      groupId: g,
      faceIndices: [],
      isCurved: f.isCurved || false,
      isFillet: false,
      faceTypes: new Set(),
      normals: [],
      totalArea: 0,
      triangleCount: 0,
      vertexCount: 0,
      canBeSketchPlane: false,
    });
  }
  const grp = groupMap.get(g);
  grp.faceIndices.push(fi);
  grp.isCurved = grp.isCurved || (f.isCurved || false);
  if (f.isFillet) grp.isFillet = true;
  if (f.faceType) grp.faceTypes.add(f.faceType);
  grp.normals.push(f.normal);
  grp.totalArea += faceArea(f.vertices);
  grp.triangleCount += triangleCount(f);
  grp.vertexCount += f.vertices.length;
}

// Determine plane-reference eligibility and representative normal
for (const grp of groupMap.values()) {
  // A group can serve as a sketch plane if it's entirely flat (single consistent normal)
  const n0 = grp.normals[0];
  let allCoplanar = true;
  for (let i = 1; i < grp.normals.length; i++) {
    const ni = grp.normals[i];
    const dot = n0.x * ni.x + n0.y * ni.y + n0.z * ni.z;
    if (dot < 1 - 1e-5) { allCoplanar = false; break; }
  }
  grp.canBeSketchPlane = allCoplanar && !grp.isCurved && !grp.isFillet;

  // Representative normal (average for curved, exact for flat)
  if (allCoplanar) {
    grp.representativeNormal = { x: n0.x, y: n0.y, z: n0.z };
  } else {
    let sx = 0, sy = 0, sz = 0;
    for (const ni of grp.normals) { sx += ni.x; sy += ni.y; sz += ni.z; }
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    grp.representativeNormal = len > 1e-10
      ? { x: sx / len, y: sy / len, z: sz / len }
      : { x: 0, y: 0, z: 1 };
  }

  // Classify the group
  if (grp.isFillet) {
    grp.surfaceType = 'fillet';
  } else if (grp.isCurved) {
    grp.surfaceType = 'curved';
  } else {
    grp.surfaceType = 'flat';
  }

  // Clean up for output
  grp.faceTypes = [...grp.faceTypes];
  grp.totalArea = +grp.totalArea.toFixed(6);
  delete grp.normals; // too verbose for summary
}

const groups = [...groupMap.values()].sort((a, b) => a.groupId - b.groupId);
report.faceGroups = groups.map(g => ({
  groupId: g.groupId,
  surfaceType: g.surfaceType,
  canBeSketchPlane: g.canBeSketchPlane,
  faceCount: g.faceIndices.length,
  triangleCount: g.triangleCount,
  vertexCount: g.vertexCount,
  totalArea: g.totalArea,
  normal: V(g.representativeNormal),
  faceTypes: g.faceTypes,
  faceIndices: verbose ? g.faceIndices : undefined,
}));

report.faceGroupSummary = {
  totalGroups: groups.length,
  flatGroups: groups.filter(g => g.surfaceType === 'flat').length,
  curvedGroups: groups.filter(g => g.surfaceType === 'curved').length,
  filletGroups: groups.filter(g => g.surfaceType === 'fillet').length,
  sketchPlaneEligible: groups.filter(g => g.canBeSketchPlane).length,
};

// --- Feature edges ---
report.featureEdges = edges.map((e, i) => {
  const len = edgeLen(e.start, e.end);
  // Determine if this edge borders a fillet group
  const borderingGroups = new Set(e.faceIndices.map(fi => faces[fi].faceGroup));
  const touchesFillet = e.faceIndices.some(fi => faces[fi].isFillet);
  const touchesFlat = e.faceIndices.some(fi => !faces[fi].isFillet && !faces[fi].isCurved);
  let edgeType = 'sharp';
  if (touchesFillet && touchesFlat) edgeType = 'fillet-boundary';
  else if (e.faceIndices.length === 1) edgeType = 'boundary';

  return {
    index: i,
    start: V(e.start),
    end: V(e.end),
    length: +len.toFixed(6),
    edgeType,
    adjacentFaces: e.faceIndices.length,
    adjacentGroups: [...borderingGroups],
  };
});

// --- Polyline paths ---
report.paths = paths.map((p, i) => {
  const eIndices = p.edgeIndices;
  let totalLength = 0;
  const pathEdges = eIndices.map(ei => {
    const e = edges[ei];
    const len = edgeLen(e.start, e.end);
    totalLength += len;
    return ei;
  });

  // Determine path endpoints
  const firstEdge = edges[eIndices[0]];
  const lastEdge = edges[eIndices[eIndices.length - 1]];

  // Classify path: does it contain fillet boundary edges?
  const edgeTypes = new Set(eIndices.map(ei => {
    const e = edges[ei];
    const touchesFillet = e.faceIndices.some(fi => faces[fi].isFillet);
    const touchesFlat = e.faceIndices.some(fi => !faces[fi].isFillet && !faces[fi].isCurved);
    return (touchesFillet && touchesFlat) ? 'fillet-boundary' : 'sharp';
  }));

  return {
    index: i,
    edgeCount: eIndices.length,
    isClosed: p.isClosed,
    totalLength: +totalLength.toFixed(6),
    pathType: edgeTypes.has('fillet-boundary') ? 'fillet-boundary' : 'feature',
    edgeIndices: verbose ? pathEdges : undefined,
    startPoint: V(firstEdge.start),
    endPoint: p.isClosed ? '(closed)' : V(lastEdge.end),
  };
});

// --- Visual edges (tessellation wireframe on curved surfaces) ---
report.visualEdges = {
  count: visualEdges.length,
};
if (verbose && visualEdges.length > 0) {
  report.visualEdges.edges = visualEdges.map((e, i) => ({
    index: i,
    start: V(e.start),
    end: V(e.end),
    length: +edgeLen(e.start, e.end).toFixed(6),
  }));
}

// --- Per-face detail (verbose only) ---
if (verbose) {
  report.faces = faces.map((f, fi) => ({
    index: fi,
    vertexCount: f.vertices.length,
    triangleCount: triangleCount(f),
    area: +faceArea(f.vertices).toFixed(6),
    normal: V(f.normal),
    faceType: f.faceType || 'unknown',
    faceGroup: f.faceGroup,
    isCurved: f.isCurved || false,
    isFillet: f.isFillet || false,
    surfaceType: f.isFillet ? 'fillet' : f.isCurved ? 'curved' : 'flat',
    canBeSketchPlane: !f.isCurved && !f.isFillet,
    sourceFeature: f.shared?.sourceFeatureId || null,
    vertices: f.vertices.map(V),
  }));
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const SEP = '─'.repeat(72);
  const THICK = '═'.repeat(72);

  console.log(`\n${THICK}`);
  console.log(`  CMOD Geometry Analysis: ${report.file.name}`);
  console.log(`  Format: ${report.file.format} v${report.file.version}`);
  console.log(THICK);

  // Feature tree
  const BW = 70;
  console.log(`\n┌${'─'.repeat(BW)}┐`);
  const hdr = `  FEATURE TREE (${report.featureTree.length} features)`;
  console.log(`│${hdr.padEnd(BW)}│`);
  console.log(`├${'─'.repeat(BW)}┤`);
  for (const f of report.featureTree) {
    const sup = f.suppressed ? ' [SUPPRESSED]' : '';
    const vis = f.visible === false ? ' [hidden]' : '';
    const line = `  ${f.name} (${f.type})${sup}${vis}`;
    console.log(`│${line.padEnd(BW)}│`);
  }
  console.log(`└${'─'.repeat(BW)}┘`);

  // Global stats
  console.log(`\n${SEP}`);
  console.log(`  GEOMETRY OVERVIEW`);
  console.log(SEP);
  const g = report.geometry;
  console.log(`  Volume:          ${g.volume}`);
  console.log(`  Surface area:    ${g.surfaceArea}`);
  console.log(`  Dimensions:      ${g.dimensions.width} × ${g.dimensions.height} × ${g.dimensions.depth}`);
  console.log(`  Bodies:          ${g.bodyCount} (sizes: [${g.bodySizes.join(', ')}])`);
  console.log(`  Wall thickness:  ${g.wallThickness.min} – ${g.wallThickness.max}`);

  // Mesh stats
  console.log(`\n${SEP}`);
  console.log(`  TRIANGLE MESH`);
  console.log(SEP);
  const m = report.mesh;
  console.log(`  Faces:       ${g.faceCount}`);
  console.log(`  Triangles:   ${m.totalTriangles}`);
  console.log(`  Unique verts: ${m.uniqueVertices} (${m.totalFaceVertices} total face-vertices)`);
  const polyStrs = Object.entries(m.polygonSizes).map(([n, c]) => `${n}-gon: ${c}`);
  console.log(`  Polygons:     ${polyStrs.join(', ')}`);

  // Manifold check
  console.log(`\n${SEP}`);
  console.log(`  MANIFOLD CHECK`);
  console.log(SEP);
  const mf = report.manifold;
  console.log(`  Mesh edges:       ${mf.meshEdgeCount}`);
  console.log(`  Boundary edges:   ${mf.boundaryEdges}${mf.boundaryEdges > 0 ? '  *** HOLES ***' : '  ✓'}`);
  console.log(`  Non-manifold:     ${mf.nonManifoldEdges}${mf.nonManifoldEdges > 0 ? '  *** ERROR ***' : '  ✓'}`);
  console.log(`  Winding errors:   ${mf.windingErrors}${mf.windingErrors > 0 ? '  *** ERROR ***' : '  ✓'}`);
  console.log(`  Manifold:         ${mf.isManifold ? '✓ YES' : '✗ NO'}`);
  console.log(`  Consistent wind:  ${mf.isConsistentWinding ? '✓ YES' : '✗ NO'}`);

  // Face groups (flat vs curved)
  console.log(`\n${SEP}`);
  console.log(`  FACE GROUPS (${report.faceGroupSummary.totalGroups} groups)`);
  console.log(`  flat: ${report.faceGroupSummary.flatGroups}  |  curved: ${report.faceGroupSummary.curvedGroups}  |  fillet: ${report.faceGroupSummary.filletGroups}  |  sketch-plane eligible: ${report.faceGroupSummary.sketchPlaneEligible}`);
  console.log(SEP);

  // Table header
  const GH = '  ID   │ Type    │ Plane? │ Faces │ Tris │ Area        │ Normal';
  console.log(GH);
  console.log(`  ${'─'.repeat(5)}┼${'─'.repeat(9)}┼${'─'.repeat(8)}┼${'─'.repeat(7)}┼${'─'.repeat(6)}┼${'─'.repeat(13)}┼${'─'.repeat(22)}`);
  for (const grp of report.faceGroups) {
    const id = String(grp.groupId).padStart(4);
    const typ = grp.surfaceType.padEnd(7);
    const plane = grp.canBeSketchPlane ? '  YES ' : '  no  ';
    const fc = String(grp.faceCount).padStart(5);
    const tc = String(grp.triangleCount).padStart(4);
    const area = grp.totalArea.toFixed(4).padStart(11);
    console.log(`  ${id} │ ${typ} │${plane}│ ${fc} │ ${tc} │ ${area} │ ${grp.normal}`);
  }

  // Feature edges
  console.log(`\n${SEP}`);
  console.log(`  FEATURE EDGES (${edges.length} edges)`);
  console.log(SEP);
  const edgeTypeCounts = {};
  for (const e of report.featureEdges) {
    edgeTypeCounts[e.edgeType] = (edgeTypeCounts[e.edgeType] || 0) + 1;
  }
  console.log(`  Types: ${Object.entries(edgeTypeCounts).map(([t, c]) => `${t}: ${c}`).join(', ')}`);

  if (verbose) {
    for (const e of report.featureEdges) {
      console.log(`    E${e.index}: ${e.start} → ${e.end}  len=${e.length.toFixed(4)}  [${e.edgeType}]  groups=[${e.adjacentGroups.join(',')}]`);
    }
  }

  // Polyline paths
  console.log(`\n${SEP}`);
  console.log(`  POLYLINE PATHS (${paths.length} paths)`);
  console.log(SEP);
  const pathTypeCounts = {};
  for (const p of report.paths) {
    pathTypeCounts[p.pathType] = (pathTypeCounts[p.pathType] || 0) + 1;
  }
  console.log(`  Types: ${Object.entries(pathTypeCounts).map(([t, c]) => `${t}: ${c}`).join(', ')}`);
  console.log();
  for (const p of report.paths) {
    const closed = p.isClosed ? '(closed)' : '(open)  ';
    console.log(`    P${p.index}: ${p.edgeCount} edge(s)  ${closed}  len=${p.totalLength.toFixed(4)}  [${p.pathType}]  ${p.startPoint} → ${p.endPoint}`);
  }

  // Visual edges
  if (visualEdges.length > 0) {
    console.log(`\n${SEP}`);
    console.log(`  VISUAL EDGES (${visualEdges.length} tessellation wireframe edges)`);
    console.log(SEP);
  }

  // Per-face details (verbose)
  if (verbose) {
    console.log(`\n${SEP}`);
    console.log(`  PER-FACE DETAIL`);
    console.log(SEP);
    for (const f of report.faces) {
      const typ = f.surfaceType.padEnd(7);
      const plane = f.canBeSketchPlane ? 'plane' : '     ';
      const src = f.sourceFeature ? ` src=${f.sourceFeature}` : '';
      console.log(`    F${f.index}: ${f.vertexCount}v ${f.triangleCount}t  area=${f.area.toFixed(4)}  n=${f.normal}  [${typ}] grp=${f.faceGroup} ${plane}${src}`);
      for (const v of f.vertices) {
        console.log(`        ${v}`);
      }
    }
  }

  console.log(`\n${THICK}`);
  console.log(`  Analysis complete.`);
  console.log(THICK);
}

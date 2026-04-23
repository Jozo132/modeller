#!/usr/bin/env node
// tests/diag-edge-alignment.js — Diagnose edge alignment issues in STEP import
//
// Checks whether shared edges between adjacent STEP faces have matching vertices
// (critical for feature edge computation via computeFeatureEdges).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSTEP } from '../js/cad/StepImport.js';
import { computeFeatureEdges } from '../js/cad/EdgeAnalysis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const stepPath = path.resolve(__dirname, 'step/box-fillet-3.step');
const stepData = await fs.readFile(stepPath, 'utf8');

const result = importSTEP(stepData, { curveSegments: 16 });
console.log(`Faces: ${result.faces.length}`);

// Build edge map like computeFeatureEdges does
const precision = 6;
function vKey(v) {
  return `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`;
}
function eKey(a, b) {
  const ka = vKey(a), kb = vKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

const edgeMap = new Map(); // key -> { faceIndices, normals }

for (let fi = 0; fi < result.faces.length; fi++) {
  const face = result.faces[fi];
  const verts = face.vertices;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const key = eKey(a, b);
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { faceIndices: [], normals: [], start: a, end: b });
    }
    const entry = edgeMap.get(key);
    entry.faceIndices.push(fi);
    entry.normals.push(face.normal);
  }
}

let boundary = 0;
let interior = 0;
let tripleEdge = 0;

for (const [key, info] of edgeMap) {
  if (info.faceIndices.length === 1) boundary++;
  else if (info.faceIndices.length === 2) interior++;
  else tripleEdge++;
}

console.log(`\nEdge analysis:`);
console.log(`  Total unique edges: ${edgeMap.size}`);
console.log(`  Boundary edges (1 face): ${boundary}`);
console.log(`  Interior edges (2 faces): ${interior}`);
console.log(`  Triple+ edges (3+ faces): ${tripleEdge}`);

// Now look at feature edges
const feResult = computeFeatureEdges(result.faces);
console.log(`\nFeature edge analysis:`);
console.log(`  Feature edges: ${feResult.edges.length}`);
console.log(`  Visual edges: ${feResult.visualEdges.length}`);
console.log(`  Paths: ${feResult.paths.length}`);

// Check feature edges by type
let featureBoundary = 0;
let featureSharp = 0;
for (const edge of feResult.edges) {
  if (edge.normals.length === 1) featureBoundary++;
  else featureSharp++;
}
console.log(`  Feature boundary edges (open): ${featureBoundary}`);
console.log(`  Feature sharp edges (angle): ${featureSharp}`);

// For a closed solid manifold, boundary edges should be 0
// If boundary > 0, it means shared edges between faces didn't match
if (boundary > 0) {
  console.log(`\n⚠️  ${boundary} boundary edges found in a model that should be a closed manifold!`);
  console.log(`   This means adjacent faces have non-matching vertex positions at shared edges.`);
  
  // Sample a few boundary edges
  let count = 0;
  for (const [key, info] of edgeMap) {
    if (info.faceIndices.length === 1 && count < 10) {
      console.log(`   Boundary edge: face[${info.faceIndices[0]}] ${vKey(info.start)} -> ${vKey(info.end)}`);
      count++;
    }
  }
}

// Check how many distinct faceGroup values exist
const faceGroups = new Set();
for (const face of result.faces) {
  if (face.faceGroup !== undefined) faceGroups.add(face.faceGroup);
}
console.log(`\nFace groups: ${faceGroups.size}`);
for (const g of faceGroups) {
  const count = result.faces.filter(f => f.faceGroup === g).length;
  console.log(`  Group ${g}: ${count} triangles`);
}

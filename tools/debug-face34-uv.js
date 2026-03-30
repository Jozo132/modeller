#!/usr/bin/env node
/**
 * Debug UV boundary mapping for face 34 of Unnamed-Body.cmod
 * Prints the UV chain with jumps highlighted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Part } from '../js/cad/Part.js';
import { EdgeSampler } from '../js/cad/Tessellator2/EdgeSampler.js';
import { GeometryEvaluator } from '../js/cad/GeometryEvaluator.js';

const cmodPath = path.resolve('tests', 'samples', 'Unnamed-Body.cmod');
const raw = fs.readFileSync(cmodPath, 'utf8');
const data = JSON.parse(raw);
const partData = data.part || data;
const part = Part.deserialize(partData);
const geo = part.getFinalGeometry();
const body = geo?.body || geo?.solid?.body;
if (!body) { console.error('No body'); process.exit(1); }

const faces = Array.from(body.faces());
console.log('Total faces:', faces.length);

const FACE_IDX = 34;
const face = faces[FACE_IDX];
if (!face) { console.error('No face', FACE_IDX); process.exit(1); }

const surface = face.surface;
console.log(`Face ${FACE_IDX}:`, face.surfaceType, 'sameSense:', face.sameSense);
console.log('Surface:', surface ? 'present' : 'missing');
if (surface) {
  console.log('  uMin:', surface.uMin, 'uMax:', surface.uMax);
  console.log('  vMin:', surface.vMin, 'vMax:', surface.vMax);
}

// Build edge sampler
const edgeSegments = 64;
const edgeSampler = new EdgeSampler();
for (const shell of body.shells || []) {
  for (const edge of shell.edges()) edgeSampler.sampleEdge(edge, edgeSegments);
}

const coedges = face.outerLoop?.coedges || [];
console.log('\nCoedges:', coedges.length);

let allPts = [];
let coedgeBoundaries = [0];

for (const coedge of coedges) {
  const samples = edgeSampler.sampleCoEdge(coedge, edgeSegments);
  const startIdx = allPts.length > 0 ? 1 : 0;
  for (let i = startIdx; i < samples.length; i++) {
    allPts.push({ ...samples[i] });
  }
  coedgeBoundaries.push(allPts.length);
}

// Remove trailing duplicate
if (allPts.length > 1) {
  const first = allPts[0], last = allPts[allPts.length - 1];
  const d = Math.sqrt((first.x-last.x)**2 + (first.y-last.y)**2 + (first.z-last.z)**2);
  if (d < 1e-10) allPts.pop();
}

console.log('Total boundary pts:', allPts.length);
console.log('Coedge boundaries:', coedgeBoundaries);

if (!surface || !surface.closestPointUV) { console.log('No closestPointUV'); process.exit(0); }

// Compute UVs with hint-chaining
const uv0 = surface.closestPointUV(allPts[0]);
allPts[0]._u = uv0.u;
allPts[0]._v = uv0.v;

for (let i = 1; i < allPts.length; i++) {
  const prev = allPts[i - 1];
  const uv = surface.closestPointUV(allPts[i], 4, { u: prev._u, v: prev._v });
  allPts[i]._u = uv.u;
  allPts[i]._v = uv.v;
}

// Print jump analysis
console.log('\nJumps and coedge boundaries:');
let maxJumpTotal = 0, maxJumpIdx = -1;
for (let i = 0; i < allPts.length; i++) {
  const p = allPts[i];
  let du = 0, dv = 0;
  if (i > 0) {
    du = p._u - allPts[i-1]._u;
    dv = p._v - allPts[i-1]._v;
  }
  const isCoedgeBoundary = coedgeBoundaries.includes(i);
  const isJump = Math.abs(du) > 0.02 || Math.abs(dv) > 0.02;
  
  if (isJump || isCoedgeBoundary) {
    console.log(`  [${i}] u=${p._u.toFixed(6)} v=${p._v.toFixed(6)} du=${du.toFixed(6)} dv=${dv.toFixed(6)}${isCoedgeBoundary ? ' ** COEDGE' : ''}${isJump ? ' *** JUMP ***' : ''}`);
  }
  
  if (Math.abs(du) + Math.abs(dv) > maxJumpTotal) {
    maxJumpTotal = Math.abs(du) + Math.abs(dv);
    maxJumpIdx = i;
  }
}

console.log('\nMax jump at index', maxJumpIdx, ':', maxJumpTotal.toFixed(6));

// For jump points, compare hint vs grid
console.log('\n--- Hint vs Grid at jump points ---');
for (let i = 1; i < allPts.length; i++) {
  const du = Math.abs(allPts[i]._u - allPts[i-1]._u);
  const dv = Math.abs(allPts[i]._v - allPts[i-1]._v);
  if (du > 0.02 || dv > 0.02) {
    const gridUv = surface.closestPointUV(allPts[i], 16);
    const hintPt = GeometryEvaluator.evalSurface(surface, allPts[i]._u, allPts[i]._v).p;
    const gridPt = GeometryEvaluator.evalSurface(surface, gridUv.u, gridUv.v).p;
    const hintDist = Math.sqrt((hintPt.x-allPts[i].x)**2 + (hintPt.y-allPts[i].y)**2 + (hintPt.z-allPts[i].z)**2);
    const gridDist = Math.sqrt((gridPt.x-allPts[i].x)**2 + (gridPt.y-allPts[i].y)**2 + (gridPt.z-allPts[i].z)**2);
    console.log(`  [${i}] hint: u=${allPts[i]._u.toFixed(6)} v=${allPts[i]._v.toFixed(6)} dist=${hintDist.toExponential(3)}`);
    console.log(`        grid: u=${gridUv.u.toFixed(6)} v=${gridUv.v.toFixed(6)} dist=${gridDist.toExponential(3)}`);
    console.log(`        3D: (${allPts[i].x.toFixed(4)}, ${allPts[i].y.toFixed(4)}, ${allPts[i].z.toFixed(4)})`);
  }
}

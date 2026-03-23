#!/usr/bin/env node
import { readFileSync } from 'fs';
import { Part } from '../js/cad/Part.js';
import { parseCMOD } from '../js/cmod.js';

const file = process.argv[2] || 'tests/samples/box-fillet-2-s.cmod';
const data = JSON.parse(readFileSync(file, 'utf-8'));
const cmod = parseCMOD(data);
const part = Part.deserialize(cmod.part);
const result = part.getFinalGeometry();
if (!result || !result.geometry) { console.error('No geometry produced'); process.exit(1); }
const faces = result.geometry.faces;

const fmt = n => (Math.abs(n) < 5e-6 ? 0 : n).toFixed(5);
function vkey(v) { return fmt(v.x) + ',' + fmt(v.y) + ',' + fmt(v.z); }
function ekey(a, b) { const ka = vkey(a), kb = vkey(b); return ka < kb ? ka + '|' + kb : kb + '|' + ka; }

// Build edge counts
const edgeCounts = new Map();
const edgeDirected = new Map(); // ek -> [{fi, vkA, vkB}]
for (let fi = 0; fi < faces.length; fi++) {
  const v = faces[fi].vertices;
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    const ek = ekey(a, b);
    edgeCounts.set(ek, (edgeCounts.get(ek) || 0) + 1);
    if (!edgeDirected.has(ek)) edgeDirected.set(ek, []);
    edgeDirected.get(ek).push({ fi, vkA: vkey(a), vkB: vkey(b) });
  }
}

let boundary = 0;
const boundaryEdges = [];
for (const [ek, c] of edgeCounts) {
  if (c === 1) { boundary++; boundaryEdges.push(ek); }
}
console.log('Total faces:', faces.length);
console.log('Boundary edges:', boundary);

// Check vertex valence in boundary edges
const vertBoundary = new Map();
for (const ek of boundaryEdges) {
  const [a, b] = ek.split('|');
  vertBoundary.set(a, (vertBoundary.get(a) || 0) + 1);
  vertBoundary.set(b, (vertBoundary.get(b) || 0) + 1);
}
const valences = {};
for (const [, count] of vertBoundary) {
  valences[count] = (valences[count] || 0) + 1;
}
console.log('Vertex valence distribution in boundary:', valences);

// Show boundary edges grouped by x coordinate
const byX = {};
for (const ek of boundaryEdges) {
  const [a, b] = ek.split('|');
  const ax = a.split(',')[0], bx = b.split(',')[0];
  const xkey = ax === bx ? ax : ax + '-' + bx;
  if (!byX[xkey]) byX[xkey] = [];
  byX[xkey].push(ek);
}
console.log('\nBoundary edges by x-coordinate:');
for (const [x, edges] of Object.entries(byX)) {
  console.log(`  x=${x}: ${edges.length} edges`);
  for (const e of edges.slice(0, 3)) console.log(`    ${e}`);
  if (edges.length > 3) console.log(`    ... and ${edges.length - 3} more`);
}

// Check if boundary forms loops
console.log('\nTracing boundary loops:');
const outgoing = new Map();
for (const ek of boundaryEdges) {
  const entries = edgeDirected.get(ek);
  if (entries.length !== 1) continue;
  const { vkA, vkB } = entries[0];
  // Reverse direction for healing
  if (!outgoing.has(vkB)) outgoing.set(vkB, []);
  outgoing.get(vkB).push(vkA);
}

let loopCount = 0, chainCount = 0;
const visited = new Set();
for (const [startVk] of outgoing) {
  if (visited.has(startVk)) continue;
  const chain = [startVk];
  visited.add(startVk);
  let current = startVk;
  while (true) {
    const nexts = outgoing.get(current);
    if (!nexts) break;
    const next = nexts.find(n => !visited.has(n));
    if (!next) {
      if (nexts.includes(chain[0])) { loopCount++; chain.push(chain[0]); }
      break;
    }
    visited.add(next);
    chain.push(next);
    current = next;
  }
  const isLoop = chain[chain.length - 1] === chain[0];
  if (isLoop) {
    console.log(`  Loop: ${chain.length - 1} edges`);
  } else {
    chainCount++;
    console.log(`  Open chain: ${chain.length} vertices (${chain[0].substring(0, 20)}... → ${chain[chain.length - 1].substring(0, 20)}...)`);
  }
}
console.log(`Loops: ${loopCount}, Open chains: ${chainCount}`);

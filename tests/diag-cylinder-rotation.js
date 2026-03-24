#!/usr/bin/env node
// tests/diag-cylinder-rotation.js — Diagnose cylinder face polygon structure
//
// Shows the polygon vertices and edge structure for each cylindrical face
// in box-fillet-3.step to understand the "rotation" issue.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const stepPath = path.resolve(__dirname, 'step/box-fillet-3.step');
const stepData = await fs.readFile(stepPath, 'utf8');

// We need to trace _buildFace for cylinders - let's parse and inspect manually
// First, import the module to get the mesh output
import { importSTEP } from '../js/cad/StepImport.js';

const result = importSTEP(stepData, { curveSegments: 8 });

console.log(`Total faces: ${result.faces.length}`);

// Group faces by faceGroup
const groups = new Map();
for (let i = 0; i < result.faces.length; i++) {
  const f = result.faces[i];
  const g = f.faceGroup;
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push({ index: i, face: f });
}

// Find cylindrical face groups (they have isCurved and non-planar triangles)
for (const [groupId, faces] of groups) {
  if (!faces[0].face.isCurved) continue;
  
  console.log(`\n=== Face Group ${groupId} (${faces.length} triangles, curved) ===`);
  
  // Print all triangles and their normals
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i].face;
    const v = f.vertices;
    const n = f.normal;
    console.log(`  Tri ${i}: normal=(${n.x.toFixed(4)}, ${n.y.toFixed(4)}, ${n.z.toFixed(4)})`);
    for (let j = 0; j < v.length; j++) {
      console.log(`    v${j}: (${v[j].x.toFixed(6)}, ${v[j].y.toFixed(6)}, ${v[j].z.toFixed(6)})`);
    }
  }

  // Check for self-intersecting triangles in this group
  const tris = faces.map(f => f.face.vertices);
  for (let i = 0; i < tris.length; i++) {
    for (let j = i + 1; j < tris.length; j++) {
      if (trianglesIntersect(tris[i], tris[j])) {
        console.log(`  ⚠️ Triangles ${i} and ${j} intersect!`);
      }
    }
  }
}

// Simple triangle-triangle intersection test (Moller's method simplified)
function trianglesIntersect(t1, t2) {
  // Check if any edge of t1 passes through t2 or vice versa
  for (const tri of [[t1, t2], [t2, t1]]) {
    const [a, b] = tri;
    for (let i = 0; i < 3; i++) {
      const p0 = a[i];
      const p1 = a[(i + 1) % 3];
      const hit = rayTriangleIntersect(p0, p1, b[0], b[1], b[2]);
      if (hit) return true;
    }
  }
  return false;
}

function rayTriangleIntersect(p0, p1, v0, v1, v2) {
  const EPS = 1e-10;
  const dir = { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z };
  const e1 = { x: v1.x - v0.x, y: v1.y - v0.y, z: v1.z - v0.z };
  const e2 = { x: v2.x - v0.x, y: v2.y - v0.y, z: v2.z - v0.z };
  const h = cross(dir, e2);
  const a = dot(e1, h);
  if (Math.abs(a) < EPS) return false;
  const f = 1 / a;
  const s = { x: p0.x - v0.x, y: p0.y - v0.y, z: p0.z - v0.z };
  const u = f * dot(s, h);
  if (u < EPS || u > 1 - EPS) return false;
  const q = cross(s, e1);
  const v = f * dot(dir, q);
  if (v < EPS || u + v > 1 - EPS) return false;
  const t = f * dot(e2, q);
  // t must be strictly between 0 and 1 (segment intersection, not shared edge)
  return t > EPS && t < 1 - EPS;
}

function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

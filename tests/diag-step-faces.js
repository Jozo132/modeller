// Diagnostic: parse box-fillet-3.step and show per-face info
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stepFile = path.resolve(__dirname, 'step/box-fillet-3.step');
const stepData = fs.readFileSync(stepFile, 'utf8');

// Inline minimal parser to inspect entity parsing
const dataMatch = stepData.match(/DATA\s*;([\s\S]*?)ENDSEC\s*;/);
const dataSection = dataMatch[1];
const rawLines = dataSection.split(';');
const entities = new Map();

for (const rawLine of rawLines) {
  const trimmed = rawLine.replace(/\s+/g, ' ').trim();
  if (!trimmed || !trimmed.startsWith('#')) continue;
  const match = trimmed.match(/^#(\d+)\s*=\s*(.+)$/);
  if (!match) continue;
  const id = parseInt(match[1], 10);
  let body = match[2].trim();

  let type, argsStr;
  if (body.startsWith('(')) {
    // Complex entity - just show it
    type = '__COMPLEX__';
    argsStr = body;
  } else {
    const parenIdx = body.indexOf('(');
    if (parenIdx < 0) {
      type = body;
      argsStr = '';
    } else {
      type = body.substring(0, parenIdx).trim();
      argsStr = body.substring(parenIdx + 1);
      if (argsStr.endsWith(')')) argsStr = argsStr.substring(0, argsStr.length - 1);
    }
  }
  entities.set(id, { id, type: type.toUpperCase(), argsStr });
}

// Find all ADVANCED_FACE and show their surface types
console.log('=== ADVANCED_FACE entities ===');
const closedShell = entities.get(16);
console.log(`CLOSED_SHELL #16: ${closedShell.argsStr.substring(0, 100)}`);

// Get face refs from the CLOSED_SHELL
const faceIds = [17, 137, 246, 301, 379, 429, 483, 534, 561, 588];
for (const faceId of faceIds) {
  const face = entities.get(faceId);
  if (!face) { console.log(`  #${faceId}: NOT FOUND`); continue; }

  // Parse just enough to get surface ref
  const match = face.argsStr.match(/#(\d+),\s*(\.[TF]\.)\s*$/);
  let surfId = null, sameSense = null;
  if (match) {
    surfId = parseInt(match[1]);
    sameSense = match[2];
  } else {
    // Try alternate parse
    const parts = face.argsStr.split(',');
    sameSense = parts[parts.length - 1].trim();
    const surfRef = parts[parts.length - 2].trim();
    if (surfRef.startsWith('#')) surfId = parseInt(surfRef.substring(1));
  }

  const surfEnt = surfId ? entities.get(surfId) : null;
  const surfType = surfEnt ? surfEnt.type : 'UNKNOWN';

  // Get bound refs
  const boundMatch = face.argsStr.match(/^\s*'[^']*'\s*,\s*\(([^)]+)\)/);
  let boundInfo = '';
  if (boundMatch) {
    const boundRefs = boundMatch[1].split(',').map(s => s.trim());
    for (const br of boundRefs) {
      const bid = parseInt(br.substring(1));
      const bound = entities.get(bid);
      if (bound) boundInfo += ` ${bound.type}`;
    }
  }

  console.log(`  #${faceId}: surface=#${surfId} (${surfType}), sameSense=${sameSense}, bounds:${boundInfo}`);
}

// Now import using our actual importer and check face normals
console.log('\n=== Import with StepImport.js ===');
import { importSTEP } from '../js/cad/StepImport.js';

try {
  const result = importSTEP(stepData, { curveSegments: 16, surfaceSegments: 8 });
  console.log(`Total vertices: ${result.vertices.length}`);
  console.log(`Total faces: ${result.faces.length}`);
  console.log(`Has body: ${!!result.body}`);

  if (result.body) {
    const topoFaces = result.body.faces();
    console.log(`TopoFaces: ${topoFaces.length}`);
    for (let i = 0; i < topoFaces.length; i++) {
      const f = topoFaces[i];
      console.log(`  TopoFace ${i}: surfType=${f.surfaceType}, sameSense=${f.sameSense}, hasSurface=${!!f.surface}, hasOuterLoop=${!!f.outerLoop}`);
    }
  }

  // Check face normals - detect flipped faces
  let flippedCount = 0;
  let totalTris = 0;
  const faceGroupStats = {};

  for (const face of result.faces) {
    totalTris++;
    const verts = face.vertices;
    if (verts.length < 3) continue;

    // Compute winding normal
    const a = verts[0], b = verts[1], c = verts[2];
    const e1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const e2 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
    const wn = {
      x: e1.y * e2.z - e1.z * e2.y,
      y: e1.z * e2.x - e1.x * e2.z,
      z: e1.x * e2.y - e1.y * e2.x,
    };
    const wnLen = Math.sqrt(wn.x * wn.x + wn.y * wn.y + wn.z * wn.z);
    if (wnLen < 1e-14) continue;

    const fn = face.normal;
    const dot = (wn.x * fn.x + wn.y * fn.y + wn.z * fn.z) / wnLen;

    const fg = face.faceGroup ?? -1;
    if (!faceGroupStats[fg]) faceGroupStats[fg] = { total: 0, flipped: 0 };
    faceGroupStats[fg].total++;

    if (dot < 0) {
      flippedCount++;
      faceGroupStats[fg].flipped++;
    }
  }

  console.log(`\nTotal triangles: ${totalTris}, flipped: ${flippedCount}`);
  console.log('\nPer face-group stats:');
  for (const [fg, stats] of Object.entries(faceGroupStats).sort((a,b) => Number(a[0]) - Number(b[0]))) {
    const status = stats.flipped > 0 ? `  *** ${stats.flipped} FLIPPED ***` : '';
    console.log(`  Group ${fg}: ${stats.total} tris${status}`);
  }

} catch (err) {
  console.error('Import failed:', err.message);
  console.error(err.stack);
}

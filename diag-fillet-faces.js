import { readFileSync } from 'fs';
import { Part } from './js/cad/Part.js';

// Load the model with both fillets
const data = JSON.parse(readFileSync('tests/samples/box-fillet-2-s.cmod', 'utf-8'));
const part = Part.deserialize(data.part);

// Apply fillets one at a time to see what's happening
console.log('=== Manual Sequential Fillet Test ===');

// Start fresh
const part2 = new Part('T');
import { Sketch } from './js/cad/Sketch.js';
const s = new Sketch();
s.addSegment(0, 0, 10, 0);
s.addSegment(10, 0, 10, 10);
s.addSegment(10, 10, 0, 10);
s.addSegment(0, 10, 0, 0);
const sf = part2.addSketch(s);
part2.extrude(sf.id, 10);

// After extrude - check initial geometry
let result = part2.getFinalGeometry();
console.log('After extrude: BRep faces =', result.geometry.faces?.length);

// Apply Fillet 1
const fmt = n => n.toFixed(5);
const ek1 = fmt(0)+','+fmt(0)+','+fmt(10)+'|'+fmt(10)+','+fmt(0)+','+fmt(10);
part2.fillet([ek1], 1, { segments: 8 });

result = part2.getFinalGeometry();
console.log('After Fillet 1: BRep faces =', result.geometry.faces?.length);
console.log('  Has topoBody:', !!result.geometry.topoBody);
if (result.geometry.topoBody?.shells?.[0]) {
  const shell = result.geometry.topoBody.shells[0];
  console.log('  TopoBody faces:', shell.faces?.length);
  for (let i = 0; i < (shell.faces?.length || 0); i++) {
    const tf = shell.faces[i];
    const hasAxStart = !!(tf.shared && tf.shared._exactAxisStart);
    const isFillet = !!(tf.shared && tf.shared.isFillet);
    if (isFillet) {
      console.log(`    Face ${i}: isFillet=${isFillet}, hasAxisMeta=${hasAxStart}`);
      if (hasAxStart) {
        console.log(`      axisStart: ${JSON.stringify(tf.shared._exactAxisStart) || 'N/A'}`);
      }
    }
  }
}

// Check if any fillet faces have cylinder metadata
let filletFacesWithMeta = 0;
for (const f of result.geometry.faces || []) {
  if (f.isFillet && f._exactAxisStart) {
    filletFacesWithMeta++;
  }
}
console.log('  Fillet faces with cylinder metadata:', filletFacesWithMeta);

// Apply Fillet 2
const ek2 = fmt(10)+','+fmt(1)+','+fmt(10)+'|'+fmt(10)+','+fmt(10)+','+fmt(10);
part2.fillet([ek2], 0.5, { segments: 8 });

result = part2.getFinalGeometry();
console.log('After Fillet 2: BRep faces =', result.geometry.faces?.length);

// Count face types
let filletCount = 0, planarCount = 0, cornerCount = 0;
for (const f of result.geometry.faces || []) {
  if (f.isFillet) filletCount++;
  else if (f.isCorner) cornerCount++;
  else planarCount++;
}
console.log('  Fillet faces:', filletCount);
console.log('  Corner faces:', cornerCount);
console.log('  Planar faces:', planarCount);

// Check topology
function vkey(v) { return v.x.toFixed(5) + ',' + v.y.toFixed(5) + ',' + v.z.toFixed(5); }
function ekey(a, b) { const ka = vkey(a), kb = vkey(b); return ka < kb ? ka+'|'+kb : kb+'|'+ka; }

const edgeToFaces = new Map();
for (let fi = 0; fi < result.geometry.faces.length; fi++) {
  const v = result.geometry.faces[fi].vertices;
  for (let i = 0; i < v.length; i++) {
    const ek = ekey(v[i], v[(i + 1) % v.length]);
    if (!edgeToFaces.has(ek)) edgeToFaces.set(ek, []);
    edgeToFaces.get(ek).push(fi);
  }
}

let boundary = 0, nonManifold = 0;
for (const [, fis] of edgeToFaces.entries()) {
  if (fis.length === 1) boundary++;
  if (fis.length > 2) nonManifold++;
}
console.log('\\nTopology: boundary=' + boundary + ', non-manifold=' + nonManifold);
console.log('Status:', boundary === 0 && nonManifold === 0 ? 'WATERTIGHT' : 'HAS ISSUES');

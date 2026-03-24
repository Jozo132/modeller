// Diagnostic: 3-edge fillet strip extent at trihedron corner
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { makeEdgeKey } from '../js/cad/CSG.js';

function makeRectSketch(x1, y1, x2, y2) {
  const s = new Sketch();
  s.addSegment(x1, y1, x2, y1);
  s.addSegment(x2, y1, x2, y2);
  s.addSegment(x2, y2, x1, y2);
  s.addSegment(x1, y2, x1, y1);
  return s;
}

const part = new Part('diag_tri');
const sf = part.addSketch(makeRectSketch(0, 0, 10, 10));
part.extrude(sf.id, 10);

// 3 edges meeting at corner (10, 10, 10)
const ek1 = makeEdgeKey({ x: 0, y: 10, z: 10 }, { x: 10, y: 10, z: 10 }); // top-back
const ek2 = makeEdgeKey({ x: 10, y: 0, z: 10 }, { x: 10, y: 10, z: 10 }); // top-right
const ek3 = makeEdgeKey({ x: 10, y: 10, z: 0 }, { x: 10, y: 10, z: 10 }); // vertical

part.fillet([ek1, ek2, ek3], 1, { segments: 4 });

const geom = part.getFinalGeometry();
const g = geom.geometry;

const PREC = 5;
const fmt = (n) => (Math.abs(n) < 5e-6 ? 0 : n).toFixed(PREC);
const vk = (v) => `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`;

// Dump all fillet faces and their vertex ranges to see if they extend to (10,10,10)
const cornerPos = '10.00000,10.00000,10.00000';
for (let fi = 0; fi < g.faces.length; fi++) {
  const f = g.faces[fi];
  if (!f.isFillet) continue;
  const verts = f.vertices;
  const keys = verts.map(v => vk(v));
  // Check if any vertex is close to (10,10,10)
  const hasCorner = verts.some(v => Math.abs(v.x-10)+Math.abs(v.y-10)+Math.abs(v.z-10) < 0.01);
  // Check if any vertex is at arc boundary (e.g. near 9.0 on one axis)
  const nearArc = verts.some(v => {
    const d = [Math.abs(v.x-9), Math.abs(v.y-9), Math.abs(v.z-9)];
    return d.some(dd => dd < 0.05);
  });
  if (hasCorner || nearArc) {
    console.log(`Fillet face ${fi}: ${keys.join(' → ')}`);
  }
}

// Also dump corner face vertices
console.log('\nCorner faces:');
for (let fi = 0; fi < g.faces.length; fi++) {
  const f = g.faces[fi];
  if (!f.isCorner) continue;
  const verts = f.vertices;
  const keys = verts.map(v => vk(v));
  console.log(`Corner face ${fi}: ${keys.join(' → ')}`);
}

// Show the vertex range of each fillet face group
// Group by the edge (face pair fi0/fi1)
console.log('\nFillet strip edge mapping:');
for (let fi = 0; fi < g.faces.length; fi++) {
  const f = g.faces[fi];
  if (!f.isFillet) continue;
  const verts = f.vertices;
  // Look for max coordinates near the corner
  const maxSumDist = Math.max(...verts.map(v => v.x + v.y + v.z));
  if (maxSumDist > 28.5) { // near corner at (10,10,10) sum=30
    console.log(`  face ${fi}: maxSum=${maxSumDist.toFixed(3)} verts=[${verts.map(v=>`(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})`).join(', ')}]`);
  }
}

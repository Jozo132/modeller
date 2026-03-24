// Diagnostic: Replays box-fillet-2-p.cmod and inspects fillet geometry at the shared corner
import { applyFillet } from '../js/cad/CSG.js';

const v = (x, y, z) => ({ x, y, z });
// 10x10x10 box faces (standard orientation)
const faces = [
  { vertices: [v(0,0,0), v(10,0,0), v(10,10,0), v(0,10,0)], normal: v(0,0,-1), shared: null },   // bottom Z=0
  { vertices: [v(0,0,10), v(0,10,10), v(10,10,10), v(10,0,10)], normal: v(0,0,1), shared: null }, // top Z=10
  { vertices: [v(0,0,0), v(0,0,10), v(10,0,10), v(10,0,0)], normal: v(0,-1,0), shared: null },   // front Y=0
  { vertices: [v(0,10,0), v(10,10,0), v(10,10,10), v(0,10,10)], normal: v(0,1,0), shared: null }, // back Y=10
  { vertices: [v(0,0,0), v(0,10,0), v(0,10,10), v(0,0,10)], normal: v(-1,0,0), shared: null },   // left X=0
  { vertices: [v(10,0,0), v(10,0,10), v(10,10,10), v(10,10,0)], normal: v(1,0,0), shared: null }, // right X=10
];
const geom = { vertices: [], faces, edges: [], paths: [] };
const edgeKeys = [
  '0.00000,0.00000,10.00000|10.00000,0.00000,10.00000',  // front-top edge
  '10.00000,0.00000,10.00000|10.00000,10.00000,10.00000', // right-top edge
];

const result = applyFillet(geom, edgeKeys, 1, 8);

// Shared vertex is at (10, 0, 10)
const sv = '10.00000,0.00000,10.00000';

// Find all fillet faces
const filletFaces = result.faces.filter(f => f.isFillet);
const cornerFaces = result.faces.filter(f => f.isCorner);
const planarFaces = result.faces.filter(f => !f.isFillet && !f.isCorner);

console.log(`Total faces: ${result.faces.length}`);
console.log(`  Fillet: ${filletFaces.length}`);
console.log(`  Corner: ${cornerFaces.length}`);
console.log(`  Planar: ${planarFaces.length}`);

// Check for overlapping fillet faces near the shared vertex
function vKey(v) { return `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`; }
function touchesSV(face) {
  return face.vertices.some(v => {
    const d = Math.sqrt((v.x-10)**2 + (v.y-0)**2 + (v.z-10)**2);
    return d < 2; // within 2 units of shared vertex
  });
}

const nearCorner = filletFaces.filter(touchesSV);
console.log(`\nFillet faces near shared vertex (10,0,10): ${nearCorner.length}`);
for (const f of nearCorner) {
  const vs = f.vertices.map(v2 => `(${v2.x.toFixed(3)},${v2.y.toFixed(3)},${v2.z.toFixed(3)})`).join(' ');
  console.log(`  ${vs}`);
}

// BRep analysis
if (result.brep) {
  console.log(`\nBRep faces: ${result.brep.faces.length}`);
  for (const bf of result.brep.faces) {
    console.log(`  type=${bf.surfaceType}, hasSurface=${!!bf.surface}, hasOuterLoop=${bf.outerLoop.length} edges`);
  }
  console.log(`BRep edges: ${result.brep.edges.length}`);
}

// Check if any fillet strip quads from edge1 overlap with edge2's fillet strip quads
// near the corner by checking bounding box intersection
console.log('\n--- Checking fillet strip overlap at corner ---');
// The first 8 fillet faces should be edge1's strip, next 8 edge2's strip
// Let's verify by checking which edge each strip belongs to
for (let i = 0; i < Math.min(filletFaces.length, 20); i++) {
  const f = filletFaces[i];
  const vs = f.vertices.map(v2 => `(${v2.x.toFixed(2)},${v2.y.toFixed(2)},${v2.z.toFixed(2)})`).join(' ');
  const near = touchesSV(f) ? ' [NEAR CORNER]' : '';
  console.log(`  Strip[${i}]: ${vs}${near}`);
}

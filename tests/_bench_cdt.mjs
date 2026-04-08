import { constrainedTriangulate } from '../js/cad/Tessellator2/CDT.js';

// Simulate complex SVG: large polygon with many boundary points
function makePolygon(n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 100 + 20 * Math.sin(a * 7); // wavy boundary
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

// Polygon with hole
function makeHole(n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 30;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

// Warm up
constrainedTriangulate(makePolygon(10));

// Benchmark with increasing sizes
for (const N of [100, 500, 1000, 2000]) {
  const outer = makePolygon(N);
  const hole = makeHole(Math.max(10, N / 5));
  const t0 = performance.now();
  const tris = constrainedTriangulate(outer, [hole]);
  const dt = performance.now() - t0;
  console.log(`N=${N}: ${tris.length} triangles, ${dt.toFixed(1)}ms`);
}

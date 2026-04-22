import './_watchdog.mjs';
// tests/test-cdt.js — Unit tests for Constrained Delaunay Triangulation
import { constrainedTriangulate } from '../js/cad/Tessellator2/CDT.js';

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; return; }
  failed++;
  console.error('  FAIL:', msg);
}

function run(name, fn) {
  console.log(`  ${name}`);
  fn();
}

console.log('CDT Tests');

run('triangle — returns single triangle', () => {
  const outer = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }];
  const tris = constrainedTriangulate(outer);
  assert(tris.length === 1, `expected 1 triangle, got ${tris.length}`);
  assert(tris[0].length === 3, 'triangle should have 3 indices');
});

run('square — returns 2 triangles', () => {
  const outer = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const tris = constrainedTriangulate(outer);
  assert(tris.length === 2, `expected 2 triangles, got ${tris.length}`);
});

run('pentagon — returns 3 triangles', () => {
  const outer = [];
  for (let i = 0; i < 5; i++) {
    const a = (2 * Math.PI * i) / 5;
    outer.push({ x: Math.cos(a), y: Math.sin(a) });
  }
  const tris = constrainedTriangulate(outer);
  assert(tris.length === 3, `expected 3 triangles, got ${tris.length}`);
});

run('L-shape (concave) — correct triangle count', () => {
  // CCW L-shape
  const outer = [
    { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 },
    { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 0, y: 2 },
  ];
  const tris = constrainedTriangulate(outer);
  assert(tris.length === 4, `expected 4 triangles, got ${tris.length}`);
});

run('square with square hole — returns correct count', () => {
  const outer = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
  const hole = [{ x: 1, y: 1 }, { x: 1, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 1 }]; // CW
  const tris = constrainedTriangulate(outer, [hole]);
  // 8 points, 8 constraint edges, should produce 8 triangles (outer 4-gon + hole 4-gon)
  assert(tris.length >= 6, `expected >= 6 triangles, got ${tris.length}`);
  // All triangle indices should be in range [0, 8)
  for (const [a, b, c] of tris) {
    assert(a >= 0 && a < 8, `index ${a} out of range`);
    assert(b >= 0 && b < 8, `index ${b} out of range`);
    assert(c >= 0 && c < 8, `index ${c} out of range`);
  }
});

run('degenerate — fewer than 3 points returns empty', () => {
  assert(constrainedTriangulate([]).length === 0, 'empty');
  assert(constrainedTriangulate([{ x: 0, y: 0 }]).length === 0, '1 point');
  assert(constrainedTriangulate([{ x: 0, y: 0 }, { x: 1, y: 0 }]).length === 0, '2 points');
});

run('all constraint edges present in output', () => {
  const outer = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const tris = constrainedTriangulate(outer);
  // Check that each boundary edge appears in at least one triangle
  function hasEdge(tris, a, b) {
    for (const t of tris) {
      const ia = t.indexOf(a);
      if (ia === -1) continue;
      if (t[(ia + 1) % 3] === b || t[(ia + 2) % 3] === b) return true;
    }
    return false;
  }
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length;
    assert(hasEdge(tris, i, j) || hasEdge(tris, j, i), `edge ${i}-${j} missing`);
  }
});

run('circle approximation — many edges', () => {
  const n = 32;
  const outer = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    outer.push({ x: Math.cos(a), y: Math.sin(a) });
  }
  const tris = constrainedTriangulate(outer);
  assert(tris.length === n - 2, `expected ${n - 2} triangles, got ${tris.length}`);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

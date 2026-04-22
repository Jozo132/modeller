import './_watchdog.mjs';
// tests/test-helpers.js — Shared test utilities for the CAD modeller test suite
//
// Consolidates commonly duplicated helpers (test runner, assertions, sketch factories,
// manifold checks) so that individual test files can import them instead of re-defining.

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { calculateMeshVolume, calculateBoundingBox, makeEdgeKey } from '../js/cad/CSG.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { tessellateBody } from '../js/cad/Tessellation.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

/**
 * Create a scoped test-runner context that tracks pass/fail counts.
 * Usage:
 *   const { test, summarize } = createTestContext('My Suite');
 *   test('case name', () => { assert.ok(true); });
 *   summarize();                         // prints summary, exits 1 on failure
 */
export function createTestContext(suiteName) {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    const startedAt = startTiming();
    try {
      fn();
      console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}${formatTimingSuffix(startedAt)}`);
      console.log(`    ${err.message}`);
      failed++;
    }
  }

  function summarize() {
    console.log(`\n${suiteName}: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  }

  function counts() {
    return { passed, failed };
  }

  return { test, summarize, counts };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** Floating-point approximate equality check. */
export function assertApprox(actual, expected, tolerance, msg) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${msg}: expected ~${expected}, got ${actual} (diff: ${Math.abs(actual - expected).toFixed(6)})`,
  );
}

// ---------------------------------------------------------------------------
// Manifold / mesh quality helpers
// ---------------------------------------------------------------------------

// Mesh edge key formatting — vertex positions rounded to PREC digits.
const PREC = 5;
/** Threshold below which a value is treated as zero in vertex key formatting. */
export const VERTEX_ZERO_THRESHOLD = 5e-6;
const fmt = (n) => (Math.abs(n) < VERTEX_ZERO_THRESHOLD ? 0 : n).toFixed(PREC);
const vk = (v) => `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`;

/**
 * Verify mesh manifoldness: every directed edge should appear in exactly 2
 * faces with opposite traversal directions.
 *
 * Returns { boundaryEdges, nonManifoldEdges, windingErrors, totalEdges }.
 */
export function checkManifold(geometry) {
  const edgeMap = new Map();

  for (let fi = 0; fi < geometry.faces.length; fi++) {
    const verts = geometry.faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const ka = vk(a), kb = vk(b);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const fwd = ka < kb;
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push({ fi, fwd });
    }
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let windingErrors = 0;

  for (const [, entries] of edgeMap) {
    if (entries.length === 1) {
      boundaryEdges++;
    } else if (entries.length === 2) {
      if (entries[0].fwd === entries[1].fwd) windingErrors++;
    } else {
      nonManifoldEdges++;
    }
  }

  return { boundaryEdges, nonManifoldEdges, windingErrors, totalEdges: edgeMap.size };
}

/**
 * Count boundary edges in a TopoBody (edges shared by fewer than 2 faces).
 */
export function countBoundaryEdges(body) {
  const edgeRefs = new Map();
  for (const face of body.shells[0].faces) {
    for (const coedge of face.outerLoop.coedges) {
      edgeRefs.set(coedge.edge.id, (edgeRefs.get(coedge.edge.id) || 0) + 1);
    }
  }
  let count = 0;
  for (const c of edgeRefs.values()) {
    if (c < 2) count++;
  }
  return count;
}

/**
 * Assert the mesh is fully manifold (no holes, non-manifold edges, or winding
 * inconsistencies).
 */
export function assertManifold(geometry, label = '') {
  const m = checkManifold(geometry);
  const prefix = label ? `${label}: ` : '';
  assert.strictEqual(m.boundaryEdges, 0, `${prefix}boundary edges should be 0, got ${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `${prefix}non-manifold edges should be 0, got ${m.nonManifoldEdges}`);
  assert.strictEqual(m.windingErrors, 0, `${prefix}winding errors should be 0, got ${m.windingErrors}`);
}

/**
 * Assert that the TopoBody is topologically closed (no boundary edges).
 */
export function assertTopoClosed(body, label = '') {
  const bnd = countBoundaryEdges(body);
  const prefix = label ? `${label}: ` : '';
  assert.strictEqual(bnd, 0, `${prefix}topoBody should have 0 boundary edges, got ${bnd}`);
}

// ---------------------------------------------------------------------------
// Sketch / Part factories
// ---------------------------------------------------------------------------

/**
 * Create a rectangular Sketch from two corner coordinates.
 */
export function makeRectSketch(x1, y1, x2, y2) {
  const s = new Sketch();
  s.addSegment(x1, y1, x2, y1);
  s.addSegment(x2, y1, x2, y2);
  s.addSegment(x2, y2, x1, y2);
  s.addSegment(x1, y2, x1, y1);
  return s;
}

/**
 * Create a circle Sketch centered at (cx, cy) with the given radius.
 */
export function makeCircleSketch(cx, cy, radius) {
  const s = new Sketch();
  s.addCircle(cx, cy, radius);
  return s;
}

/** Default XY plane definition. */
export function makePlane() {
  return {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
}

/**
 * Build a box Part from rectangle dimensions and extrusion height.
 * Returns the Part instance with one sketch + one extrude feature already applied.
 */
export function makeBoxPart(w = 20, h = 10, d = 10) {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('Box');
  const sketch = makeRectSketch(0, 0, w, h);
  part.addSketch(sketch, makePlane());
  part.extrude(part.getSketches()[0].id, d);
  return part;
}

/**
 * Build a Part from a sketch factory function and extrusion height.
 * Resets feature/topo IDs for reproducibility.
 */
export function buildPartFromSketch(sketchSetup, extrudeHeight = 8) {
  resetFeatureIds();
  resetTopoIds();
  const sketch = new Sketch();
  sketchSetup(sketch);
  const part = new Part('Test');
  part.addSketch(sketch, makePlane());
  part.extrude(part.getSketches()[0].id, extrudeHeight);
  return part;
}

// ---------------------------------------------------------------------------
// Edge key helpers
// ---------------------------------------------------------------------------

/**
 * Format an edge key from two 3D point objects (canonical ordering).
 */
export function edgeKey(a, b) {
  return [a, b]
    .map((p) => `${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`)
    .sort()
    .join('|');
}

/**
 * Find an edge in the geometry edge list matching a predicate.
 */
export function findEdge(edges, pred) {
  const e = (edges || []).find(pred);
  assert.ok(e, 'Expected to find an edge matching the predicate');
  return e;
}

// ---------------------------------------------------------------------------
// Geometry accessors
// ---------------------------------------------------------------------------

/**
 * Get the extrude result geometry and topoBody from a Part.
 */
export function getExtrudeResult(part) {
  const extrude = part.featureTree.features.find((f) => f.type === 'extrude');
  assert.ok(extrude, 'Part should have an extrude feature');
  const geometry = extrude.result.geometry;
  assert.ok(geometry, 'Extrude should produce geometry');
  const topoBody = geometry.topoBody || geometry.body;
  return { geometry, topoBody };
}

// ---------------------------------------------------------------------------
// Re-exports from CSG for convenience
// ---------------------------------------------------------------------------

export { calculateMeshVolume, calculateBoundingBox, makeEdgeKey };
export { tessellateBody };
export { resetFeatureIds };
export { resetTopoIds };
export { Part, Sketch };

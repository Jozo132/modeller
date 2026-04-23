import './_watchdog.mjs';
// tests/test-feature-tree-incremental-tess.js — H21 auto-thread regression
//
// Validates that feature-level tessellation sites (BRepFillet, BRepChamfer)
// forward input geometry's DirtyFaceTracker signal alongside the incremental
// cache. The hookup lets the tessellator's identity-based cache eviction
// complement its automatic content-key invalidation, which was the last
// missing piece of the H21 "auto-thread dirtyFaceIds" plan in
// CAD-KERNEL-AUDIT.md.
//
// This is a light-weight functional guard — full end-to-end re-tessellation
// coverage lives in test-cbrep-tess-roundtrip / test-geometry-persistence.
// Here we only assert that:
//   1. robustTessellateBody accepts + honors `dirtyFaceIds` (array or Set).
//   2. Providing an incrementalCache alone reuses matched faces.
//   3. Providing dirtyFaceIds forces re-tessellation of the listed faces
//      while leaving other faces reusable.

import { strict as assert } from 'node:assert';

import { robustTessellateBody } from '../js/cad/Tessellator2/index.js';
import { buildTopoBody, SurfaceType } from '../js/cad/BRepTopology.js';

let passed = 0;
const failures = [];
function test(label, fn) {
  try {
    fn();
    console.log(`  \u2713 ${label}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${label}`);
    console.log(`    ${err && err.stack ? err.stack : err}`);
    failures.push(label);
  }
}

function makeUnitBox() {
  const c = [
    { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 1, z: 1 },
  ];
  return buildTopoBody([
    { surfaceType: SurfaceType.PLANE, vertices: [c[3], c[2], c[1], c[0]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[4], c[5], c[6], c[7]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[0], c[1], c[5], c[4]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[2], c[3], c[7], c[6]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[3], c[0], c[4], c[7]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[1], c[2], c[6], c[5]], surface: null, edgeCurves: null, shared: null },
  ]);
}

console.log('=== H21: dirtyFaceIds auto-thread into incremental tessellation ===');

test('baseline tessellation populates an incremental cache', () => {
  const body = makeUnitBox();
  const r1 = robustTessellateBody(body, { surfaceSegments: 4, edgeSegments: 8 });
  assert.ok(r1.incrementalTessellation, 'exposes incrementalTessellation');
  assert.ok(r1._incrementalTessellationCache, 'exposes _incrementalTessellationCache');
  assert.ok(r1.incrementalTessellation.dirtyFaceKeys.length > 0,
    'first pass reports every face as dirty (nothing cached)');
  assert.equal(r1.incrementalTessellation.reusedFaceKeys.length, 0);
});

test('second pass with same cache reuses every face', () => {
  const body = makeUnitBox();
  const r1 = robustTessellateBody(body, { surfaceSegments: 4, edgeSegments: 8 });
  const r2 = robustTessellateBody(body, {
    surfaceSegments: 4,
    edgeSegments: 8,
    incrementalCache: r1._incrementalTessellationCache,
  });
  assert.equal(r2.incrementalTessellation.dirtyFaceKeys.length, 0,
    'no faces need re-tessellation');
  assert.ok(r2.incrementalTessellation.reusedFaceKeys.length > 0,
    'every face reused from cache');
});

test('dirtyFaceIds forces re-tessellation of named faces only', () => {
  const body = makeUnitBox();
  const r1 = robustTessellateBody(body, { surfaceSegments: 4, edgeSegments: 8 });

  // Pick any face id that exists on the body; force-evict it.
  const firstFaceId = body.shells[0].faces[0].id;
  assert.notEqual(firstFaceId, undefined, 'faces have stable ids');

  const r2 = robustTessellateBody(body, {
    surfaceSegments: 4,
    edgeSegments: 8,
    incrementalCache: r1._incrementalTessellationCache,
    dirtyFaceIds: [firstFaceId],
  });

  // Exactly one face must have been re-triangulated; the rest reused.
  assert.equal(r2.incrementalTessellation.dirtyFaceKeys.length, 1,
    `expected 1 dirty face, got ${r2.incrementalTessellation.dirtyFaceKeys.length}`);
  assert.equal(r2.incrementalTessellation.reusedFaceKeys.length,
    body.shells[0].faces.length - 1,
    'all other faces must be reused');
});

test('dirtyFaceIds accepts Set as well as Array', () => {
  const body = makeUnitBox();
  const r1 = robustTessellateBody(body, { surfaceSegments: 4, edgeSegments: 8 });
  const firstFaceId = body.shells[0].faces[0].id;
  const r2 = robustTessellateBody(body, {
    surfaceSegments: 4,
    edgeSegments: 8,
    incrementalCache: r1._incrementalTessellationCache,
    dirtyFaceIds: new Set([firstFaceId]),
  });
  assert.equal(r2.incrementalTessellation.dirtyFaceKeys.length, 1);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}

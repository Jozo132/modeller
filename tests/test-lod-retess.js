import './_watchdog.mjs';
// tests/test-lod-retess.js — Tier-3 LoD retess consumer
//
// `retessellateForLod(part, segsU, segsV)` is the H21-consumer half wired
// into main.js via WasmRenderer.onLodChange. When the camera crosses a
// LoD band, every solid feature result in the active part gets its mesh
// re-triangulated at the new density — without re-running feature work.
//
// Contract guarded here:
//   1. New density is published to globalTessConfig (and mirrored onto
//      part.tessellationConfig) before any tessellation call.
//   2. `tessellateBody` is invoked once per solid feature result, carrying
//      the topoBody from that result and the new segment counts.
//   3. Suppressed / errored / bodiless results are skipped.
//   4. The new mesh replaces `result.geometry` (and `result.solid.geometry`
//      alias) — CBREP buffer, handle metadata, volume, boundingBox stay
//      untouched, and no JS incremental cache blob is persisted.
//   5. Invalid inputs (NaN, zero, negative) are rejected without side
//      effects.
//   6. A throwing tessellator leaves the old geometry in place and records
//      the failure.

import { strict as assert } from 'node:assert';

import { retessellateForLod } from '../js/cad/LodRetess.js';

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

function makePart(results) {
  return {
    tessellationConfig: { curveSegments: 16, edgeSegments: 16, surfaceSegments: 16 },
    featureTree: {
      features: Object.keys(results).map((id) => ({ id })),
      results,
    },
  };
}

console.log('=== Tier-3: LoD retessellation consumer ===');

test('baseline — empty tree is a no-op', () => {
  const part = makePart({});
  const cfg = { curveSegments: 8, edgeSegments: 8, surfaceSegments: 8 };
  let tessCalls = 0;
  const outcome = retessellateForLod(part, 24, 32, {
    tessellateBody: () => { tessCalls++; return { faces: [] }; },
    globalTessConfig: cfg,
  });
  assert.equal(outcome.retessellated.length, 0);
  assert.equal(outcome.skipped.length, 0);
  assert.equal(tessCalls, 0);
});

test('bad inputs — NaN / zero / negative produce no side effects', () => {
  const part = makePart({ f1: { solid: { topoBody: { shells: [{}] } } } });
  const cfg = { curveSegments: 8, edgeSegments: 8, surfaceSegments: 8 };
  const cfgBefore = { ...cfg };
  let tessCalls = 0;
  const deps = {
    tessellateBody: () => { tessCalls++; return { faces: [] }; },
    globalTessConfig: cfg,
  };
  retessellateForLod(part, NaN, 16, deps);
  retessellateForLod(part, 16, 0, deps);
  retessellateForLod(part, -4, 16, deps);
  assert.equal(tessCalls, 0);
  assert.deepEqual(cfg, cfgBefore, 'globalTessConfig must not mutate on bad input');
});

test('publishes new density before tessellating', () => {
  const topoBody = { shells: [{}] };
  const part = makePart({ f1: { solid: { topoBody } } });
  const cfg = { curveSegments: 8, edgeSegments: 8, surfaceSegments: 8 };
  let observed = null;
  retessellateForLod(part, 24, 32, {
    tessellateBody: () => {
      observed = { u: cfg.edgeSegments, v: cfg.surfaceSegments, c: cfg.curveSegments };
      return { faces: [{ vertices: [] }] };
    },
    globalTessConfig: cfg,
  });
  assert.deepEqual(observed, { u: 24, v: 32, c: 24 },
    'tessellator must observe new config values during the call');
  assert.equal(cfg.surfaceSegments, 32);
  assert.equal(cfg.edgeSegments, 24);
  assert.equal(cfg.curveSegments, 24);
  assert.equal(part.tessellationConfig.surfaceSegments, 32, 'part.tessellationConfig mirrored');
});

test('stamps new geometry on the result + preserves metadata', () => {
  const topoBody = { shells: [{}] };
  const originalCbrep = new Uint8Array([1, 2, 3]);
  const r = {
    solid: { topoBody, geometry: { old: true } },
    geometry: { old: true },
    cbrepBuffer: originalCbrep,
    wasmHandleId: 'h_42',
    exactBodyRevisionId: 7,
    volume: 1234.5,
    boundingBox: { min: {}, max: {} },
  };
  const part = makePart({ f1: r });
  const newMesh = { faces: [{ vertices: [] }] };
  const outcome = retessellateForLod(part, 24, 32, {
    tessellateBody: () => newMesh,
    globalTessConfig: { curveSegments: 8, edgeSegments: 8, surfaceSegments: 8 },
  });
  assert.deepEqual(outcome.retessellated, ['f1']);
  assert.equal(r.geometry, newMesh);
  assert.equal(r.solid.geometry, newMesh);
  assert.equal(r.cbrepBuffer, originalCbrep, 'CBREP buffer untouched');
  assert.equal(r.wasmHandleId, 'h_42', 'handle id untouched');
  assert.equal(r.exactBodyRevisionId, 7, 'revision id untouched');
  assert.equal(r.volume, 1234.5, 'volume untouched');
  assert.equal(r._incrementalTessellationCache, undefined);
});

test('skips suppressed, errored, and bodiless results', () => {
  const topoBody = { shells: [{}] };
  const good = { solid: { topoBody } };
  const part = makePart({
    f_suppressed: { suppressed: true },
    f_error: { error: 'oops' },
    f_nobody: { solid: {} },
    f_good: good,
  });
  let tessCalls = 0;
  const outcome = retessellateForLod(part, 16, 16, {
    tessellateBody: () => { tessCalls++; return { faces: [] }; },
    globalTessConfig: { curveSegments: 8, edgeSegments: 8, surfaceSegments: 8 },
  });
  assert.deepEqual(outcome.retessellated, ['f_good']);
  assert.deepEqual(outcome.skipped.sort(), ['f_error', 'f_nobody', 'f_suppressed']);
  assert.equal(tessCalls, 1);
});

test('throwing tessellator keeps old geometry and records failure', () => {
  const topoBody = { shells: [{}] };
  const oldGeom = { old: true };
  const r = { solid: { topoBody, geometry: oldGeom }, geometry: oldGeom };
  const part = makePart({ f1: r });
  const prevWarn = console.warn;
  console.warn = () => {};
  let outcome;
  try {
    outcome = retessellateForLod(part, 16, 16, {
      tessellateBody: () => { throw new Error('boom'); },
      globalTessConfig: { curveSegments: 8, edgeSegments: 8, surfaceSegments: 8 },
    });
  } finally {
    console.warn = prevWarn;
  }
  assert.deepEqual(outcome.failed, ['f1']);
  assert.equal(r.geometry, oldGeom, 'old geometry preserved on failure');
});

test('rounds fractional segments to integer', () => {
  const topoBody = { shells: [{}] };
  const part = makePart({ f1: { solid: { topoBody } } });
  const cfg = { curveSegments: 8, edgeSegments: 8, surfaceSegments: 8 };
  let observed = null;
  retessellateForLod(part, 23.6, 31.2, {
    tessellateBody: (_body, opts) => {
      observed = { u: opts.edgeSegments, v: opts.surfaceSegments };
      return { faces: [] };
    },
    globalTessConfig: cfg,
  });
  assert.deepEqual(observed, { u: 24, v: 31 });
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { robustTessellateBody } from '../js/cad/Tessellator2/index.js';
import { applyBRepChamfer } from '../js/cad/BRepChamfer.js';
import { edgeKeyFromVerts } from '../js/cad/toolkit/Vec3Utils.js';
import {
  clearSavedProject,
  loadProject,
  saveProject,
  setPartManagerForPersist,
} from '../js/persist.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  const startedAt = startTiming();
  try {
    fn();
    console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

function makeBoxPart() {
  const part = new Part('IncrementalBox');
  const sketch = new Sketch();
  sketch.addSegment(0, 0, 10, 0);
  sketch.addSegment(10, 0, 10, 10);
  sketch.addSegment(10, 10, 0, 10);
  sketch.addSegment(0, 10, 0, 0);
  const sketchFeature = part.addSketch(sketch);
  part.extrude(sketchFeature.id, 10);
  return part;
}

function withMockLocalStorage(fn) {
  const original = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  };

  try {
    fn();
  } finally {
    if (original === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = original;
    }
  }
}

console.log('\n=== Incremental Tessellation ===\n');

test('robust tessellation reuses cached face meshes for identical bodies', () => {
  const part = makeBoxPart();
  const finalResult = part.getFinalGeometry();
  const body = finalResult.geometry.topoBody;

  const first = robustTessellateBody(body, { validate: false });
  const second = robustTessellateBody(body, {
    validate: false,
    incrementalCache: first._incrementalTessellationCache,
  });

  assert.ok(first.incrementalTessellation.dirtyFaceKeys.length > 0,
    'first tessellation should mark faces dirty without a cache');
  assert.strictEqual(first.incrementalTessellation.reusedFaceKeys.length, 0,
    'first tessellation should not reuse cached faces');
  assert.strictEqual(second.incrementalTessellation.dirtyFaceKeys.length, 0,
    'second tessellation should reuse all face meshes');
  assert.strictEqual(second.incrementalTessellation.reusedFaceKeys.length, body.faces().length,
    'second tessellation should reuse one mesh per TopoFace');
  assert.strictEqual(second.faces.length, first.faces.length,
    'reused tessellation should keep the same triangle count');
});

test('BRep chamfer reports mixed dirty and reused topology after a local edit', () => {
  const part = makeBoxPart();
  const finalResult = part.getFinalGeometry();
  const geometry = finalResult.geometry;
  const warmMesh = robustTessellateBody(geometry.topoBody, { validate: false });
  const edge = geometry.edges[0];
  assert.ok(edge, 'expected at least one feature edge on the base box');

  const chamfered = applyBRepChamfer({
    ...geometry,
    _incrementalTessellationCache: warmMesh._incrementalTessellationCache,
  }, [edgeKeyFromVerts(edge.start, edge.end)], 1);

  assert.ok(chamfered, 'expected chamfer to produce geometry');
  assert.ok(chamfered.incrementalTessellation,
    'expected chamfer result to expose incremental tessellation metadata');
  assert.ok(chamfered.incrementalTessellation.dirtyFaceKeys.length > 0,
    'expected chamfer to retessellate changed faces');
  assert.ok(chamfered.incrementalTessellation.reusedFaceKeys.length > 0,
    'expected chamfer to reuse unaffected face meshes');
  assert.ok(chamfered.incrementalTessellation.dirtyEdgeKeys.length > 0,
    'expected chamfer to report changed exact edges');
});

console.log('\n=== Browser Persistence Cache Snapshot ===\n');

test('localStorage persistence carries the top-level exact-body snapshot', () => {
  withMockLocalStorage(() => {
    setPartManagerForPersist({
      getPart() {
        return {
          serialize() {
            return {
              type: 'Part',
              name: 'Persisted',
              featureTree: { features: [] },
              _finalCbrepPayload: 'AQID',
              _finalCbrepHash: 'deadbeefcafebabe',
            };
          },
        };
      },
    });

    try {
      saveProject();
      const loaded = loadProject();

      assert.ok(loaded && loaded.ok, 'expected loadProject to restore the saved payload');
      assert.strictEqual(loaded.finalCbrepPayload, 'AQID');
      assert.strictEqual(loaded.finalCbrepHash, 'deadbeefcafebabe');
    } finally {
      clearSavedProject();
      setPartManagerForPersist(null);
    }
  });
});

console.log(`\n=== Results ===\n\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

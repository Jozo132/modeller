import './_watchdog.mjs';
import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { Scene } from '../js/cad/index.js';
import { robustTessellateBody } from '../js/cad/Tessellator2/index.js';
import { applyBRepChamfer } from '../js/cad/BRepChamfer.js';
import { edgeKeyFromVerts } from '../js/cad/toolkit/Vec3Utils.js';
import {
  clearSavedProject,
  loadProject,
  saveProject,
  setCbrepPersistStoreFactory,
  setPartManagerForPersist,
} from '../js/persist.js';
import { state } from '../js/state.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  const startedAt = startTiming();
  try {
    await fn();
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

async function withMockLocalStorage(fn) {
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
    return await fn(storage);
  } finally {
    if (original === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = original;
    }
  }
}

async function withQuotaLimitedLocalStorage(maxValueLength, fn) {
  const original = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      const text = String(value);
      if (text.length > maxValueLength) {
        throw new Error(`quota exceeded: ${text.length} > ${maxValueLength}`);
      }
      storage.set(key, text);
    },
    removeItem(key) {
      storage.delete(key);
    },
  };

  try {
    return await fn(storage);
  } finally {
    if (original === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = original;
    }
  }
}

console.log('\n=== Incremental Tessellation ===\n');

await test('robust tessellation reuses cached face meshes for identical bodies', async () => {
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

await test('BRep chamfer reports mixed dirty and reused topology after a local edit', async () => {
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

await test('browser persistence falls back to inline exact snapshot without external storage', async () => {
  await withMockLocalStorage(async () => {
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
      setCbrepPersistStoreFactory(null);
      await saveProject();
      const loaded = await loadProject();

      assert.ok(loaded && loaded.ok, 'expected loadProject to restore the saved payload');
      assert.strictEqual(loaded.finalCbrepPayload, 'AQID');
      assert.strictEqual(loaded.finalCbrepHash, 'deadbeefcafebabe');
    } finally {
      clearSavedProject();
      setCbrepPersistStoreFactory(null);
      setPartManagerForPersist(null);
    }
  });
});

await test('browser persistence stores final exact snapshot behind an external manifest when available', async () => {
  await withMockLocalStorage(async () => {
    const externalStore = new Map();
    setCbrepPersistStoreFactory(() => ({
      async get(key) {
        return externalStore.has(key) ? externalStore.get(key) : null;
      },
      async put(key, value) {
        externalStore.set(key, value);
      },
      async delete(key) {
        externalStore.delete(key);
        return true;
      },
    }));
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
      await saveProject();
      const raw = JSON.parse(localStorage.getItem('cad-modeller-project'));
      const loaded = await loadProject();

      assert.ok(raw.finalCbrepContainer, 'expected a final CBREP manifest in localStorage');
      assert.strictEqual(raw.finalCbrepContainer.storage, 'idb');
      assert.ok(!raw.finalCbrepPayload, 'expected heavy final CBREP payload to stay out of localStorage');
      assert.ok(!raw.part._finalCbrepPayload, 'expected part JSON to omit the duplicated heavy payload');
      assert.strictEqual(loaded.finalCbrepPayload, 'AQID');
      assert.strictEqual(loaded.finalCbrepHash, 'deadbeefcafebabe');
    } finally {
      clearSavedProject();
      setCbrepPersistStoreFactory(null);
      setPartManagerForPersist(null);
    }
  });
});

await test('browser persistence keeps large image payloads out of quota-limited localStorage', async () => {
  await withQuotaLimitedLocalStorage(4096, async () => {
    const externalStore = new Map();
    const originalScene = state.scene;
    setCbrepPersistStoreFactory(() => ({
      async get(key) {
        return externalStore.has(key) ? externalStore.get(key) : null;
      },
      async put(key, value) {
        externalStore.set(key, value);
      },
      async delete(key) {
        externalStore.delete(key);
        return true;
      },
    }));

    state.scene = new Scene();
    const dataUrl = `data:image/png;base64,${'A'.repeat(12000)}`;
    state.scene.addImage(dataUrl, 0, 0, 100, 50, { name: 'Quota Test' });

    try {
      await saveProject();
      const raw = JSON.parse(localStorage.getItem('cad-modeller-project'));
      const loaded = await loadProject();

      assert.ok(raw.scene.images[0].dataUrlManifest, 'expected an external image manifest in localStorage');
      assert.ok(!raw.scene.images[0].dataUrl, 'expected image payload to stay out of localStorage');
      assert.ok(loaded && loaded.ok, 'expected loadProject to restore the saved image payload');
      assert.strictEqual(state.scene.images.length, 1);
      assert.strictEqual(state.scene.images[0].dataUrl, dataUrl);
    } finally {
      clearSavedProject();
      setCbrepPersistStoreFactory(null);
      state.scene = originalScene;
    }
  });
});

console.log(`\n=== Results ===\n\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

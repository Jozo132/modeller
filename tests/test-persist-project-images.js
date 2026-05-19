import assert from 'node:assert/strict';
import { startTiming, formatTimingSuffix } from './test-timing.js';
import { saveProject, setCbrepPersistStoreFactory } from '../js/persist.js';
import { state } from '../js/state.js';

async function test(name, fn) {
  const startedAt = startTiming();
  await fn();
  console.log(`ok - ${name}${formatTimingSuffix(startedAt)}`);
}

await test('project image payloads externalize through the CBREP persistence store', async () => {
  const originalLocalStorage = globalThis.localStorage;
  const originalScene = state.scene;
  const storeData = new Map();
  const storageData = new Map();

  globalThis.localStorage = {
    getItem(key) {
      return storageData.has(key) ? storageData.get(key) : null;
    },
    setItem(key, value) {
      storageData.set(key, String(value));
    },
    removeItem(key) {
      storageData.delete(key);
    },
  };

  setCbrepPersistStoreFactory(async () => ({
    async put(key, value) {
      storeData.set(key, value);
    },
    async get(key) {
      return storeData.get(key) ?? null;
    },
    async delete(key) {
      return storeData.delete(key);
    },
  }));

  state.scene = {
    serialize() {
      return {
        points: [],
        segments: [],
        circles: [],
        arcs: [],
        splines: [],
        beziers: [],
        constraints: [],
        images: [{ type: 'image', dataUrl: 'data:image/png;base64,AA==', x: 0, y: 0, width: 10, height: 10 }],
        texts: [],
        dimensions: [],
        groups: [],
        variables: [],
      };
    },
    shapes() {
      return [];
    },
  };

  try {
    await saveProject();

    const stored = JSON.parse(storageData.get('cad-modeller-project'));
    const image = stored.scene.images[0];

    assert.equal(storeData.size, 1, 'expected one persisted image payload');
    assert.equal('dataUrl' in image, false, 'inline image payload should be removed after externalization');
    assert.equal(image.dataUrlManifest?.storage, 'idb');
    assert.ok(typeof image.dataUrlManifest?.key === 'string' && image.dataUrlManifest.key.length > 0, 'expected an IndexedDB manifest key');
  } finally {
    state.scene = originalScene;
    setCbrepPersistStoreFactory(null);
    if (originalLocalStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = originalLocalStorage;
    }
  }
});
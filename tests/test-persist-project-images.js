import assert from 'node:assert/strict';
import { startTiming, formatTimingSuffix } from './test-timing.js';
import { loadProject, saveProject, saveViewState, setCbrepPersistStoreFactory, setRendererForPersist, setViewport } from '../js/persist.js';
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

await test('oversized project snapshots externalize through the CBREP persistence store when localStorage quota is exceeded', async () => {
  const originalLocalStorage = globalThis.localStorage;
  const originalScene = state.scene;
  const storeData = new Map();
  const storageData = new Map();

  globalThis.localStorage = {
    getItem(key) {
      return storageData.has(key) ? storageData.get(key) : null;
    },
    setItem(key, value) {
      const text = String(value);
      if (text.length > 512) {
        const error = new Error('quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      storageData.set(key, text);
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
        images: [],
        texts: [{ id: 'large', text: 'x'.repeat(8000), x: 0, y: 0 }],
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

    assert.equal(stored.kind, 'project-record');
    assert.equal(stored.storage, 'idb');
    assert.equal(storeData.has(stored.key), true, 'expected oversized project snapshot to be stored in IndexedDB');
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

await test('camera-only saves persist through the lightweight view-state overlay', async () => {
  const originalLocalStorage = globalThis.localStorage;
  const originalScene = state.scene;
  const originalViewport = { zoom: 1, panX: 0, panY: 0 };
  const viewport = { ...originalViewport };
  const initialOrbit = {
    theta: 0.1,
    phi: 1.2,
    radius: 40,
    target: { x: 1, y: 2, z: 3 },
    up: { x: 0, y: 0, z: 1 },
    fovDegrees: 45,
    ortho3D: false,
  };
  let orbit = { ...initialOrbit, target: { ...initialOrbit.target }, up: { ...initialOrbit.up } };
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

  setCbrepPersistStoreFactory(null);
  setViewport(viewport);
  setRendererForPersist({
    getOrbitState() {
      return {
        ...orbit,
        target: { ...orbit.target },
        up: { ...orbit.up },
      };
    },
  });

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
        images: [],
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
    const storedProjectBeforeViewSave = storageData.get('cad-modeller-project');

    viewport.zoom = 2.5;
    viewport.panX = 120;
    viewport.panY = -45;
    orbit = {
      theta: 0.9,
      phi: 1.05,
      radius: 22,
      target: { x: 4, y: 5, z: 6 },
      up: { x: 0, y: 0, z: 1 },
      fovDegrees: 55,
      ortho3D: false,
    };

    saveViewState();

    assert.equal(storageData.get('cad-modeller-project'), storedProjectBeforeViewSave, 'camera-only save should not rewrite the main project snapshot');

    const overlay = JSON.parse(storageData.get('cad-modeller-project:view'));
    assert.equal(overlay.viewport.zoom, 2.5);
    assert.equal(overlay.orbit.radius, 22);

    viewport.zoom = originalViewport.zoom;
    viewport.panX = originalViewport.panX;
    viewport.panY = originalViewport.panY;

    const loaded = await loadProject();

    assert.equal(loaded.ok, true);
    assert.equal(viewport.zoom, 2.5, 'load should apply the latest persisted viewport overlay');
    assert.equal(viewport.panX, 120);
    assert.equal(viewport.panY, -45);
    assert.equal(loaded.orbit.radius, 22, 'load should expose the latest persisted orbit overlay');
    assert.deepEqual(loaded.orbit.target, { x: 4, y: 5, z: 6 });
  } finally {
    state.scene = originalScene;
    setViewport(null);
    setRendererForPersist(null);
    setCbrepPersistStoreFactory(null);
    if (originalLocalStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = originalLocalStorage;
    }
  }
});
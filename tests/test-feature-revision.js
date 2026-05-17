import './_watchdog.mjs';
// tests/test-feature-revision.js — Tests for exactBodyRevisionId + irHash in feature results
//
// Validates that FeatureTree stamps solid results with:
//   - exactBodyRevisionId (monotonic counter)
//   - irHash (propagated from feature instance when available)
//   - wasmHandleId (when a registry is attached)

import { FeatureTree } from '../js/cad/FeatureTree.js';
import { Feature } from '../js/cad/Feature.js';
import { Part } from '../js/cad/Part.js';
import { PartManager } from '../js/part-manager.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  \u2713 ${msg}`);
    passed++;
  } else {
    console.error(`  \u2717 ${msg}`);
    failed++;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Minimal solid-producing feature for testing. */
class StubSolid extends Feature {
  constructor(name) {
    super(name);
    this.type = 'stub-solid';
  }
  execute(_ctx) {
    return { type: 'solid', geometry: {}, solid: {}, volume: 1, boundingBox: {} };
  }
}

/** Solid feature that exposes _irHash (simulating StepImportFeature). */
class StubSolidWithHash extends Feature {
  constructor(name, hash) {
    super(name);
    this.type = 'stub-solid-hash';
    this._irHash = hash;
  }
  execute(_ctx) {
    return { type: 'solid', geometry: {}, solid: {}, volume: 1, boundingBox: {} };
  }
}

/** Sketch-like feature that produces a non-solid result. */
class StubSketch extends Feature {
  constructor(name) {
    super(name);
    this.type = 'stub-sketch';
  }
  execute(_ctx) {
    return { type: 'sketch', geometry: {}, curves: [] };
  }
}

/** Minimal mock of WasmBrepHandleRegistry for testing. */
class MockHandleRegistry {
  constructor() {
    this.ready = true;
    this.UNMATERIALIZED = 0;
    this.HYDRATING = 1;
    this.RESIDENT = 2;
    this.STALE = 3;
    this.DISPOSED = 4;
    this._nextHandle = 1;
    this._handles = new Map();
    this._residencies = new Map();
    this._featureIds = new Map();
    this._revisions = new Map();
    this._released = [];
    this.resetCalls = 0;
    this.hydrateCalls = [];
    this._hydrateResult = true;
  }
  alloc() {
    const h = this._nextHandle++;
    this._handles.set(h, true);
    return h;
  }
  release(h) {
    this._handles.delete(h);
    this._released.push(h);
  }
  isValid(h) {
    return this._handles.has(h);
  }
  setResidency(h, s) { this._residencies.set(h, s); }
  getResidency(h) { return this._residencies.get(h) ?? -1; }
  setFeatureId(h, fid) { this._featureIds.set(h, fid); }
  bumpRevision(h) { this._revisions.set(h, (this._revisions.get(h) || 0) + 1); }
  getRevision(h) { return this._revisions.get(h) || 0; }
  resetTopology() { this.resetCalls++; }
  hydrateForHandle(h, cbrep) {
    this.hydrateCalls.push({ handle: h, byteLength: cbrep?.byteLength ?? 0 });
    return this._hydrateResult;
  }
}

class MockResidencyManager {
  constructor() {
    this.clearCalls = 0;
    this.storeCalls = [];
    this.markCalls = [];
  }
  clear() {
    this.clearCalls++;
  }
  storeCbrep(featureId, cbrep, irHash) {
    this.storeCalls.push({ featureId, cbrep, irHash });
  }
  markAccessed(featureId) {
    this.markCalls.push(featureId);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

console.log('=== exactBodyRevisionId ===');

{
  const tree = new FeatureTree();
  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  const r1 = tree.results[f1.id];
  assert(r1.type === 'solid', 'result is solid');
  assert(typeof r1.exactBodyRevisionId === 'number', 'revisionId is a number');
  assert(r1.exactBodyRevisionId > 0, 'revisionId is positive');
}

{
  const tree = new FeatureTree();
  const f1 = new StubSolid('a');
  const f2 = new StubSolid('b');
  tree.addFeature(f1);
  tree.addFeature(f2);
  const r1 = tree.results[f1.id];
  const r2 = tree.results[f2.id];
  assert(r2.exactBodyRevisionId > r1.exactBodyRevisionId,
    'revisionId is monotonically increasing across features');
}

{
  const tree = new FeatureTree();
  const f1 = new StubSolid('a');
  tree.addFeature(f1);
  const rev1 = tree.results[f1.id].exactBodyRevisionId;
  tree.markModified(f1.id);
  const rev2 = tree.results[f1.id].exactBodyRevisionId;
  assert(rev2 > rev1, 'revisionId bumps on recalculation');
}

{
  const tree = new FeatureTree();
  const sk = new StubSketch('sketch1');
  tree.addFeature(sk);
  const r = tree.results[sk.id];
  assert(r.exactBodyRevisionId === undefined, 'sketch results have no revisionId');
}

console.log('\n=== irHash propagation ===');

{
  const tree = new FeatureTree();
  const f = new StubSolidWithHash('import', 'abcdef0123456789');
  tree.addFeature(f);
  const r = tree.results[f.id];
  assert(r.irHash === 'abcdef0123456789', 'irHash propagated from feature to result');
}

{
  const tree = new FeatureTree();
  const f = new StubSolid('box');
  tree.addFeature(f);
  const r = tree.results[f.id];
  assert(r.irHash === undefined, 'result without _irHash has no irHash field');
}

console.log('\n=== WASM handle lifecycle ===');

{
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  tree.setHandleRegistry(reg);

  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  const r1 = tree.results[f1.id];
  assert(typeof r1.wasmHandleId === 'number' && r1.wasmHandleId > 0,
    'solid result gets wasmHandleId when registry attached');
  assert(reg.isValid(r1.wasmHandleId), 'handle is valid in registry');
}

{
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  tree.setHandleRegistry(reg);

  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  const oldHandle = tree.results[f1.id].wasmHandleId;

  // Recalculation replaces the result — old handle should be released
  tree.markModified(f1.id);
  const newHandle = tree.results[f1.id].wasmHandleId;
  assert(!reg.isValid(oldHandle), 'old handle released on recalculation');
  assert(reg.isValid(newHandle), 'new handle allocated after recalculation');
  assert(newHandle !== oldHandle, 'new handle is different from old handle');
}

{
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  tree.setHandleRegistry(reg);

  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  const handle = tree.results[f1.id].wasmHandleId;

  tree.removeFeature(f1.id);
  assert(!reg.isValid(handle), 'handle released on feature removal');
}

{
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  tree.setHandleRegistry(reg);

  const f1 = new StubSolid('a');
  const f2 = new StubSolid('b');
  tree.addFeature(f1);
  tree.addFeature(f2);
  const h1 = tree.results[f1.id].wasmHandleId;
  const h2 = tree.results[f2.id].wasmHandleId;

  tree.clear();
  assert(!reg.isValid(h1) && !reg.isValid(h2), 'clear() releases all handles');
}

{
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  tree.setHandleRegistry(reg);

  const sk = new StubSketch('sketch1');
  tree.addFeature(sk);
  const r = tree.results[sk.id];
  assert(r.wasmHandleId === undefined, 'sketch results do not get wasmHandleId');
}

{
  // No registry — should still work without errors
  const tree = new FeatureTree();
  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  const r = tree.results[f1.id];
  assert(r.wasmHandleId === undefined, 'no wasmHandleId without registry');
  assert(r.exactBodyRevisionId > 0, 'revisionId still assigned without registry');
}

console.log('\n=== executeAll handle release ===');

{
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  tree.setHandleRegistry(reg);

  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  const oldHandle = tree.results[f1.id].wasmHandleId;

  tree.executeAll();
  assert(!reg.isValid(oldHandle), 'executeAll releases old handles');
  const newHandle = tree.results[f1.id].wasmHandleId;
  assert(reg.isValid(newHandle), 'executeAll allocates new handles');
}

console.log('\n=== async CBREP attachment ===');

{
  const tree = new FeatureTree();
  const residency = new MockResidencyManager();
  const feature = new StubSolidWithHash('import', 'abcdef0123456789');
  const cbrepBuffer = new Uint8Array([1, 2, 3, 4]).buffer;

  tree.setResidencyManager(residency);
  tree.addFeature(feature);
  const attached = tree.attachCbrep(feature.id, cbrepBuffer, 'abcdef0123456789');

  assert(attached === true, 'attachCbrep succeeds for an existing solid result');
  assert(tree.results[feature.id].cbrepBuffer === cbrepBuffer,
    'attachCbrep adds the CBREP payload to the live result');
  assert(tree.results[feature.id].irHash === 'abcdef0123456789',
    'attachCbrep preserves the supplied irHash on the live result');
  assert(residency.storeCalls.length === 1, 'attachCbrep forwards the payload to residency');
  assert(residency.storeCalls[0].featureId === feature.id,
    'attachCbrep stores residency payload under the feature id');
  assert(residency.markCalls.includes(feature.id),
    'attachCbrep marks the feature as recently accessed');
}

{
  // H1: attachCbrep must hydrate into the WASM handle so the exact body
  // becomes resident in the kernel rather than just being stashed in JS.
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  const residency = new MockResidencyManager();
  tree.setHandleRegistry(reg);
  tree.setResidencyManager(residency);

  const feature = new StubSolidWithHash('import', 'abcdef0123456789');
  tree.addFeature(feature);
  const handle = tree.results[feature.id].wasmHandleId;
  assert(typeof handle === 'number' && handle > 0,
    'solid feature gets a wasm handle before CBREP attachment');
  assert(reg.getResidency(handle) === reg.UNMATERIALIZED,
    'fresh handle starts UNMATERIALIZED before CBREP hydration');
  const preAttachRev = reg.getRevision(handle);

  const cbrepBuffer = new Uint8Array([9, 8, 7, 6, 5]).buffer;
  const attached = tree.attachCbrep(feature.id, cbrepBuffer, 'deadbeef');
  assert(attached === true, 'attachCbrep succeeds when handle registry is attached');

  assert(reg.hydrateCalls.length === 1,
    'attachCbrep invokes registry.hydrateForHandle exactly once');
  assert(reg.hydrateCalls[0].handle === handle,
    'hydrateForHandle is called on the live handle for the feature');
  assert(reg.hydrateCalls[0].byteLength === cbrepBuffer.byteLength,
    'hydrateForHandle receives the full CBREP byte length');
  assert(reg.getResidency(handle) === reg.RESIDENT,
    'handle transitions to RESIDENT after successful hydrate');
  assert(reg.getRevision(handle) > preAttachRev,
    'handle revision bumps on hydrate');
  assert(tree.results[feature.id].wasmHandleResident === true,
    'result records that the WASM handle is now resident');
}

{
  // H1: hydrate failure must leave the handle marked STALE, not RESIDENT.
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  reg._hydrateResult = false;
  tree.setHandleRegistry(reg);

  const feature = new StubSolidWithHash('import', 'abcdef0123456789');
  tree.addFeature(feature);
  const handle = tree.results[feature.id].wasmHandleId;

  const cbrepBuffer = new Uint8Array([1, 2, 3]).buffer;
  tree.attachCbrep(feature.id, cbrepBuffer, 'abcdef');

  assert(reg.getResidency(handle) === reg.STALE,
    'failed hydrate leaves handle STALE');
  assert(tree.results[feature.id].wasmHandleResident === false,
    'result records that the WASM handle failed to hydrate');
}

console.log('\n=== Part lifecycle wiring ===');

{
  const pm = new PartManager();
  const reg = new MockHandleRegistry();
  const residency = new MockResidencyManager();

  pm.setWasmHandleSubsystem(reg, residency);
  const part = pm.createPart('WiredPart');

  assert(pm.getActivePart() === part, 'PartManager.getActivePart returns current part');
  assert(part.featureTree._handleRegistry === reg, 'createPart wires handle registry into new part');
  assert(part.featureTree._residencyManager === residency, 'createPart wires residency manager into new part');
}

{
  const pm = new PartManager();
  const reg = new MockHandleRegistry();
  const residency = new MockResidencyManager();
  let executeAllCalls = 0;
  let wiredHandle = null;
  let wiredResidency = null;

  pm.part = {
    featureTree: {
      features: [{ id: 'feature_1' }],
      executeAll() {
        executeAllCalls++;
      },
    },
    setWasmHandleSubsystem(handleRegistry, residencyManager) {
      wiredHandle = handleRegistry;
      wiredResidency = residencyManager;
    },
  };

  pm.setWasmHandleSubsystem(reg, residency);

  assert(wiredHandle === reg, 'late subsystem attach rewires existing part registry');
  assert(wiredResidency === residency, 'late subsystem attach rewires existing part residency');
  assert(executeAllCalls === 0, 'late subsystem attach no longer replays the existing feature tree');
  assert(reg.resetCalls === 1, 'late subsystem attach resets shared topology before replay');
  assert(residency.clearCalls === 1, 'late subsystem attach clears residency before replay');
}

{
  // Late subsystem attach should not drive the legacy CBREP hydrate path.
  const pm = new PartManager();
  const reg = new MockHandleRegistry();
  const residency = new MockResidencyManager();
  let executeAllCalls = 0;
  let hydrateCalls = 0;

  pm.part = {
    featureTree: {
      features: [{ id: 'feature_1' }],
      executeAll() { executeAllCalls++; },
      hydrateExistingResultsFromCbrep() {
        hydrateCalls++;
        return true;
      },
    },
    setWasmHandleSubsystem() { /* noop for this test */ },
  };

  pm.setWasmHandleSubsystem(reg, residency);

  assert(executeAllCalls === 0,
    'late subsystem attach skips executeAll when rewiring the subsystem');
  assert(hydrateCalls === 0,
    'late subsystem attach does not invoke legacy CBREP hydration');
  assert(reg.resetCalls === 1,
    'late subsystem attach still resets shared topology before rewiring');
}

{
  // Late subsystem attach should not fall back to a legacy replay path when
  // cached CBREPs are missing.
  const pm = new PartManager();
  const reg = new MockHandleRegistry();
  const residency = new MockResidencyManager();
  let executeAllCalls = 0;
  let hydrateCalls = 0;

  pm.part = {
    featureTree: {
      features: [{ id: 'feature_1' }, { id: 'feature_2' }],
      executeAll() { executeAllCalls++; },
      hydrateExistingResultsFromCbrep() {
        hydrateCalls++;
        return false;
      },
    },
    setWasmHandleSubsystem() { /* noop for this test */ },
  };

  pm.setWasmHandleSubsystem(reg, residency);

  assert(executeAllCalls === 0,
    'late subsystem attach does not replay when cached CBREPs do not cover the tree');
  assert(hydrateCalls === 0,
    'late subsystem attach does not invoke legacy CBREP hydration when cached CBREPs do not cover the tree');
}

{
  // H3/H4: FeatureTree.hydrateExistingResultsFromCbrep allocates handles for
  // every pre-existing solid result with a cached CBREP and reports success.
  const tree = new FeatureTree();
  const feature = new StubSolidWithHash('imported', 'cafebabe');
  tree.addFeature(feature); // no registry yet — no handle allocated
  tree.results[feature.id].cbrepBuffer = new Uint8Array([1, 2, 3, 4, 5]).buffer;

  const reg = new MockHandleRegistry();
  const residencyMgr = new MockResidencyManager();
  tree.setHandleRegistry(reg);
  tree.setResidencyManager(residencyMgr);

  const ok = tree.hydrateExistingResultsFromCbrep();
  assert(ok === true,
    'hydrateExistingResultsFromCbrep reports full restore when every solid is cached');

  const handle = tree.results[feature.id].wasmHandleId;
  assert(typeof handle === 'number' && handle > 0,
    'each cached solid result gets a freshly-allocated handle');
  assert(reg.getResidency(handle) === reg.RESIDENT,
    'handle is RESIDENT after cached hydrate');
  assert(reg.hydrateCalls.length === 1 && reg.hydrateCalls[0].handle === handle,
    'cached hydrate was driven through registry.hydrateForHandle');
  assert(tree.results[feature.id].wasmHandleResident === true,
    'solid result records the cached-hydrate outcome');
  assert(residencyMgr.storeCalls.length === 1 &&
    residencyMgr.storeCalls[0].featureId === feature.id,
    'cached hydrate mirrors the payload into the residency manager');
}

{
  // H3/H4: when at least one solid result has no cached CBREP, the method
  // must report false so the caller falls back to executeAll.
  const tree = new FeatureTree();
  const featureA = new StubSolidWithHash('a', 'aaa');
  const featureB = new StubSolidWithHash('b', 'bbb');
  tree.addFeature(featureA);
  tree.addFeature(featureB);
  tree.results[featureA.id].cbrepBuffer = new Uint8Array([1, 2]).buffer;
  // featureB intentionally has no cbrepBuffer

  const reg = new MockHandleRegistry();
  tree.setHandleRegistry(reg);

  const ok = tree.hydrateExistingResultsFromCbrep();
  assert(ok === false,
    'hydrateExistingResultsFromCbrep reports partial restore when a solid lacks a CBREP');
  assert(typeof tree.results[featureA.id].wasmHandleId === 'number' &&
    tree.results[featureA.id].wasmHandleId > 0,
    'partial restore still hydrates the solids that do have cached CBREPs');
}

console.log('\n=== H5: per-feature OCCT checkpoints ===');

{
  // serialize emits a checkpoint for every solid result with an OCCT checkpoint.
  const tree = new FeatureTree();
  const featureA = new StubSolidWithHash('a', 'hash-a');
  const featureB = new StubSolid('b'); // no irHash
  const featureC = new StubSolid('c'); // no OCCT checkpoint — should be absent from checkpoints
  tree.addFeature(featureA);
  tree.addFeature(featureB);
  tree.addFeature(featureC);
  tree.results[featureA.id].occtCheckpoint = {
    brep: 'checkpoint-a',
    revision: { revisionId: 'rev-a', topologyHash: 'topo-a' },
  };
  tree.results[featureB.id].occtCheckpoint = {
    brep: 'checkpoint-b',
    revision: { revisionId: 'rev-b', topologyHash: 'topo-b' },
  };

  const serialized = tree.serialize();
  assert(serialized.checkpoints && typeof serialized.checkpoints === 'object',
    'serialize includes a checkpoints map when any solid has an OCCT checkpoint');
  assert(serialized.checkpoints[featureA.id]?.occt?.brep === 'checkpoint-a',
    'feature with an OCCT checkpoint preserves that checkpoint in serialization');
  assert(serialized.checkpoints[featureA.id].payload === undefined,
    'serialized OCCT checkpoints do not emit a legacy CBREP payload');
  assert(serialized.checkpoints[featureB.id]?.occt?.revision?.topologyHash === 'topo-b',
    'feature without irHash still produces an OCCT checkpoint entry');
  assert(serialized.checkpoints[featureB.id].hash === undefined,
    'serialized OCCT checkpoints do not emit a legacy hash');
  assert(serialized.checkpoints[featureC.id] === undefined,
    'feature without an OCCT checkpoint is not present in the checkpoints map');
}

{
  // serialize omits the checkpoints key entirely when there is nothing to persist.
  const tree = new FeatureTree();
  tree.addFeature(new StubSolid('fresh'));
  const serialized = tree.serialize();
  assert(!('checkpoints' in serialized),
    'serialize omits checkpoints when no solid result carries a cached CBREP');
}

{
  // deserialize reattaches serialized OCCT checkpoints onto live results.
  const original = new FeatureTree();
  const featureA = new StubSolidWithHash('a', 'hash-a');
  original.addFeature(featureA);
  original.results[featureA.id].occtCheckpoint = {
    brep: 'checkpoint-a',
    revision: { revisionId: 'rev-a', topologyHash: 'topo-a' },
  };
  const serialized = original.serialize();

  const reg = new MockHandleRegistry();
  const residency = new MockResidencyManager();
  const restored = FeatureTree.deserialize(serialized, (data) => {
    // Factory reproduces the stubs by id so the restore path can match.
    const stub = new StubSolidWithHash(data.name || 'a', 'hash-a');
    stub.id = data.id || stub.id;
    return stub;
  }, { handleRegistry: reg, residencyManager: residency });

  const restoredFeature = restored.features[0];
  const restoredResult = restored.results[restoredFeature.id];
  assert(restoredResult && restoredResult.occtCheckpoint,
    'deserialize reattaches the OCCT checkpoint onto the restored solid result');
  assert(restoredResult.occtCheckpoint.brep === 'checkpoint-a',
    'reattached OCCT checkpoint preserves the serialized checkpoint payload');
  assert(restoredResult.occtTopologyHash === 'topo-a',
    'reattached OCCT checkpoint restores the serialized topology hash');
  assert(residency.storeCalls.length === 0,
    'reattaching an OCCT checkpoint does not mirror a legacy CBREP payload into residency');
}

{
  // stale checkpoints (topology hash mismatch against a freshly replayed result) are dropped.
  const tree = new FeatureTree();
  const featureA = new StubSolidWithHash('a', 'fresh-hash');
  tree.addFeature(featureA);
  tree.results[featureA.id].occtTopologyHash = 'fresh-topology';
  const staleCheckpoint = {
    [featureA.id]: {
      occt: {
        brep: 'stale-checkpoint',
        revision: { revisionId: 'rev-stale', topologyHash: 'stale-topology' },
      },
    },
  };
  tree._applySerializedCheckpoints(staleCheckpoint);
  const result = tree.results[featureA.id];
  assert(!result.occtCheckpoint,
    'stale checkpoint (topology hash mismatch) is dropped rather than overwriting the live result');
}

{
  const pm = new PartManager();
  const reg = new MockHandleRegistry();
  const residency = new MockResidencyManager();
  const originalDeserialize = Part.deserialize;
  let seenOptions = null;
  let wiredHandle = null;
  let wiredResidency = null;

  Part.deserialize = function mockDeserialize(_data, options) {
    seenOptions = options;
    return {
      featureTree: { features: [] },
      setWasmHandleSubsystem(handleRegistry, residencyManager) {
        wiredHandle = handleRegistry;
        wiredResidency = residencyManager;
      },
    };
  };

  try {
    pm.setWasmHandleSubsystem(reg, residency);
    pm.deserialize({ featureTree: { features: [] } }, {
      finalCbrepPayload: 'AQID',
      finalCbrepHash: 'deadbeefcafebabe',
    });
  } finally {
    Part.deserialize = originalDeserialize;
  }

  assert(seenOptions && seenOptions.handleRegistry === reg,
    'PartManager.deserialize passes handle registry into Part.deserialize');
  assert(seenOptions && seenOptions.residencyManager === residency,
    'PartManager.deserialize passes residency manager into Part.deserialize');
  assert(seenOptions && seenOptions.finalCbrepPayload === undefined,
    'PartManager.deserialize no longer forwards cached CBREP payload into Part.deserialize');
  assert(seenOptions && seenOptions.finalCbrepHash === undefined,
    'PartManager.deserialize no longer forwards cached CBREP hash into Part.deserialize');
  assert(wiredHandle === reg, 'deserialized part is rewired with handle registry');
  assert(wiredResidency === residency, 'deserialized part is rewired with residency manager');
  assert(reg.resetCalls === 1, 'deserialize resets shared topology before loading restored part');
  assert(residency.clearCalls === 1, 'deserialize clears residency before loading restored part');
}

// ── C1: tryFastRestoreFromCheckpoints ────────────────────────────────────

console.log('\n=== C1: fast-restore from serialized OCCT checkpoints ===');

function makeOcctCheckpoint(label) {
  return {
    brep: `checkpoint-${label}`,
    revision: {
      revisionId: `rev-${label}`,
      topologyHash: `topo-${label}`,
    },
  };
}

function makeOcctRestoredResult(checkpoint) {
  const topology = {
    revisionId: checkpoint.revision.revisionId,
    topologyHash: checkpoint.revision.topologyHash,
    boundingBox: { xMin: 0, yMin: 0, zMin: 0, xMax: 1, yMax: 1, zMax: 1 },
    volume: 7,
  };
  const geometry = {
    faces: [{ vertices: [], normal: { x: 0, y: 0, z: 1 } }],
    edges: [],
    paths: [],
    visualEdges: [],
    _occtModeling: { topology },
  };
  return {
    type: 'solid',
    geometry,
    solid: { geometry, body: null },
    body: null,
    volume: topology.volume,
    boundingBox: topology.boundingBox,
    occtCheckpoint: checkpoint,
    occtTopologyHash: topology.topologyHash,
    _restoredFromCheckpoint: true,
  };
}

{
  // Happy path: every solid feature has an OCCT checkpoint → execute() is NOT called.
  const tree = new FeatureTree();
  let executeCalls = 0;
  let occtRestoreCalls = 0;
  class TracingSolid extends Feature {
    constructor(name) { super(name); this.type = 'stub-solid'; }
    execute(_ctx) { executeCalls++; return { type: 'solid', geometry: {}, solid: {}, volume: 1, boundingBox: {} }; }
  }
  const fa = new TracingSolid('a');
  const fb = new TracingSolid('b');
  tree.features.push(fa, fb);
  tree.featureMap.set(fa.id, fa);
  tree.featureMap.set(fb.id, fb);
  tree._buildSolidResultFromOcctCheckpoint = (_featureId, checkpoint) => {
    occtRestoreCalls++;
    return makeOcctRestoredResult(checkpoint);
  };

  let legacyDepCalls = 0;
  const deps = {
    readCbrep: () => { legacyDepCalls++; throw new Error('legacy restore should not run'); },
    tessellateBody: () => { legacyDepCalls++; throw new Error('legacy restore should not run'); },
    computeFeatureEdges: () => { legacyDepCalls++; throw new Error('legacy restore should not run'); },
    calculateMeshVolume: () => { legacyDepCalls++; throw new Error('legacy restore should not run'); },
    calculateBoundingBox: () => { legacyDepCalls++; throw new Error('legacy restore should not run'); },
  };
  const checkpoints = {
    [fa.id]: { occt: makeOcctCheckpoint('a') },
    [fb.id]: { occt: makeOcctCheckpoint('b') },
  };
  const ok = tree.tryFastRestoreFromCheckpoints(checkpoints, deps);
  assert(ok === true, 'fast-restore returns true when every solid has an OCCT checkpoint');
  assert(executeCalls === 0, 'fast-restore does NOT call feature.execute() for solid features');
  assert(occtRestoreCalls === 2, 'fast-restore restores each solid feature from its OCCT checkpoint');
  assert(legacyDepCalls === 0, 'fast-restore ignores the legacy CBREP dependency bundle');
  const ra = tree.results[fa.id];
  assert(ra && ra.type === 'solid', 'restored result has type=solid');
  assert(ra._restoredFromCheckpoint === true, 'result is marked as restored from checkpoint');
  assert(ra.volume === 7, 'result carries the OCCT-restored volume');
  assert(ra.occtTopologyHash === 'topo-a', 'result preserves the OCCT topology hash');
}

{
  // Missing checkpoint: solid feature without coverage → returns false, no mutation.
  const tree = new FeatureTree();
  const fa = new StubSolid('a');
  const fb = new StubSolid('b');
  tree.features.push(fa, fb);
  tree.featureMap.set(fa.id, fa);
  tree.featureMap.set(fb.id, fb);
  const priorResults = tree.results;
  const checkpoints = { [fa.id]: { occt: makeOcctCheckpoint('a') } };
  const deps = {
    readCbrep: () => { throw new Error('legacy restore should not run'); },
    tessellateBody: () => { throw new Error('legacy restore should not run'); },
  };
  const ok = tree.tryFastRestoreFromCheckpoints(checkpoints, deps);
  assert(ok === false, 'fast-restore returns false when a solid feature has no OCCT checkpoint');
  assert(tree.results === priorResults, 'fast-restore does not mutate results on coverage miss');
}

{
  // Sketch features still execute during fast-restore so downstream context works.
  const tree = new FeatureTree();
  let sketchExecuted = 0;
  class TracingSketch extends Feature {
    constructor(name) { super(name); this.type = 'sketch'; }
    execute(_ctx) { sketchExecuted++; return { type: 'sketch', sketch: {}, profiles: [] }; }
  }
  const sk = new TracingSketch('sk');
  const fa = new StubSolid('a');
  tree.features.push(sk, fa);
  tree.featureMap.set(sk.id, sk);
  tree.featureMap.set(fa.id, fa);
  tree._buildSolidResultFromOcctCheckpoint = (_featureId, checkpoint) => makeOcctRestoredResult(checkpoint);
  const ok = tree.tryFastRestoreFromCheckpoints({ [fa.id]: { occt: makeOcctCheckpoint('a') } });
  assert(ok === true, 'fast-restore succeeds when only solids need OCCT checkpoints');
  assert(sketchExecuted === 1, 'sketch feature.execute() is called during fast-restore');
  assert(tree.results[sk.id].type === 'sketch', 'sketch result stored');
  assert(tree.results[fa.id].type === 'solid', 'solid result restored from OCCT checkpoint');
}

{
  // End-to-end via FeatureTree.deserialize + serialized OCCT checkpoint.
  class FT_Solid extends Feature {
    constructor(name) { super(name); this.type = 'stub-solid'; }
    serialize() { return { id: this.id, name: this.name, type: this.type }; }
  }
  let executeCalls = 0;
  FT_Solid.prototype.execute = function () { executeCalls++; return { type: 'solid', geometry: {}, solid: {}, volume: 0, boundingBox: {} }; };

  const data = {
    features: [{ id: 'f1', name: 'f1', type: 'stub-solid' }],
    checkpoints: { f1: { occt: makeOcctCheckpoint('1') } },
  };
  const originalBuild = FeatureTree.prototype._buildSolidResultFromOcctCheckpoint;
  FeatureTree.prototype._buildSolidResultFromOcctCheckpoint = function (_featureId, checkpoint) {
    return makeOcctRestoredResult(checkpoint);
  };
  try {
    const tree = FeatureTree.deserialize(data,
      (d) => { const f = new FT_Solid(d.name); f.id = d.id; return f; },
      {
        fastRestoreDeps: {
          readCbrep: () => { throw new Error('legacy restore should not run'); },
          tessellateBody: () => { throw new Error('legacy restore should not run'); },
        },
      });
    assert(executeCalls === 0, 'deserialize with OCCT checkpoints does NOT call executeAll()');
    assert(tree.results.f1 && tree.results.f1._restoredFromCheckpoint,
      'deserialize fast path produces a restored result');
    assert(tree.results.f1.occtTopologyHash === 'topo-1',
      'restored result carries the OCCT topology hash');
  } finally {
    FeatureTree.prototype._buildSolidResultFromOcctCheckpoint = originalBuild;
  }
}

{
  // Payload-only checkpoints no longer fast-restore and therefore fall back to executeAll.
  class FT_Solid2 extends Feature {
    constructor(name) { super(name); this.type = 'stub-solid'; }
  }
  let executeCalls = 0;
  FT_Solid2.prototype.execute = function () { executeCalls++; return { type: 'solid', geometry: {}, solid: {}, volume: 3, boundingBox: {} }; };

  const data = {
    features: [{ id: 'f1', name: 'f1', type: 'stub-solid' }],
    checkpoints: { f1: { payload: 'AQID', hash: 'h1' } },
  };
  const tree = FeatureTree.deserialize(data,
    (d) => { const f = new FT_Solid2(d.name); f.id = d.id; return f; },
    {
      fastRestoreDeps: {
        readCbrep: () => { throw new Error('legacy restore should not run'); },
        tessellateBody: () => { throw new Error('legacy restore should not run'); },
      },
    });
  assert(executeCalls === 1, 'payload-only checkpoints fall back to executeAll');
  assert(tree.results.f1 && !tree.results.f1._restoredFromCheckpoint,
    'payload-only checkpoints produce an executed result, not a fast-restored one');
}

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n=== Results ===\n\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

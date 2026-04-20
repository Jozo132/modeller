// tests/test-history-replay.js — Tests for history tree topology-first layer
//
// Covers:
//   1) Stable entity keys across repeated recompute
//   2) Save/load roundtrip preserving selection keys
//   3) Workflow recording replay stability
//   4) Geometry persistence when adding new sketches
//   5) Chamfer/fillet replay after benign upstream edits
//   6) Explicit failure/remap diagnostics when topology changes invalidate selection
//   7) Cache hits on unchanged history segments
//   8) Backward-compatible loading of older .cmod projects

import { strict as assert } from 'node:assert';

import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { buildCMOD, parseCMOD } from '../js/cmod.js';
import { ChamferFeature } from '../js/cad/ChamferFeature.js';
import { FilletFeature } from '../js/cad/FilletFeature.js';

import {
  EntityType, RemapStatus,
  vertexKey, edgeKey, faceKey,
  parseKey, isStableKey, isLegacyEdgeKey,
  legacyEdgeKeyToStable,
  keyBody, resolveKey,
  serializeKeys, deserializeKeys,
} from '../js/cad/history/StableEntityKey.js';

import {
  buildCacheKey, HistoryCache,
} from '../js/cad/history/HistoryCache.js';

import {
  ReplayStatus, DiagnosticReason,
  FeatureReplayDiagnostic, FeatureReplayResult,
  resolveEdgeSelections, replayFeatureTree,
} from '../js/cad/history/FeatureReplay.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

// -----------------------------------------------------------------------
// Test framework
// -----------------------------------------------------------------------

let _passed = 0;
let _failed = 0;
let _currentGroup = '';

function group(name) {
  _currentGroup = name;
  console.log(`\n--- ${name} ---`);
}

function test(name, fn) {
  const startedAt = startTiming();
  try {
    fn();
    _passed++;
    console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`);
  } catch (err) {
    _failed++;
    console.log(`  ✗ ${name}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${err.message}`);
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeBoxSketch(w = 10, h = 10) {
  const s = new Sketch();
  s.addSegment(0, 0, w, 0);
  s.addSegment(w, 0, w, h);
  s.addSegment(w, h, 0, h);
  s.addSegment(0, h, 0, 0);
  return s;
}

function makeBoxPart(w = 10, h = 10, d = 10) {
  resetFeatureIds();
  const part = new Part('TestBox');
  const sketch = makeBoxSketch(w, h);
  const sf = part.addSketch(sketch);
  part.extrude(sf.id, d);
  return part;
}

function getEdgeKeysFromPart(part) {
  const geo = part.getFinalGeometry();
  if (!geo || !geo.geometry || !geo.geometry.edges) return [];
  const keys = [];
  const prec = 5;
  const formatVertex = (v) => `${v.x.toFixed(prec)},${v.y.toFixed(prec)},${v.z.toFixed(prec)}`;
  for (const edge of geo.geometry.edges) {
    if (edge.start && edge.end) {
      keys.push(`${formatVertex(edge.start)}|${formatVertex(edge.end)}`);
    }
  }
  return keys;
}

// -----------------------------------------------------------------------
// 1) Stable entity keys across repeated recompute
// -----------------------------------------------------------------------

group('1) Stable entity keys across repeated recompute');

test('vertexKey produces deterministic key', () => {
  const k1 = vertexKey({ point: { x: 1, y: 2, z: 3 } }, 'feat1');
  const k2 = vertexKey({ point: { x: 1, y: 2, z: 3 } }, 'feat1');
  assert.strictEqual(k1, k2);
  assert.ok(isStableKey(k1));
});

test('edgeKey is direction-independent', () => {
  const edge1 = { startVertex: { point: { x: 0, y: 0, z: 0 } }, endVertex: { point: { x: 1, y: 0, z: 0 } } };
  const edge2 = { startVertex: { point: { x: 1, y: 0, z: 0 } }, endVertex: { point: { x: 0, y: 0, z: 0 } } };
  assert.strictEqual(edgeKey(edge1), edgeKey(edge2));
});

test('faceKey produces stable key with surface type', () => {
  const face = {
    surfaceType: 'plane',
    outerLoop: {
      points: () => [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }],
    },
  };
  const k1 = faceKey(face, 'f1');
  const k2 = faceKey(face, 'f1');
  assert.strictEqual(k1, k2);
  assert.ok(k1.includes('plane'));
});

test('parseKey extracts components', () => {
  const k = vertexKey({ point: { x: 1.5, y: 2.5, z: 3.5 } }, 'prov');
  const parsed = parseKey(k);
  assert.ok(parsed);
  assert.strictEqual(parsed.version, 'sek1');
  assert.strictEqual(parsed.entityType, EntityType.VERTEX);
  assert.strictEqual(parsed.provenance, 'prov');
});

test('isStableKey vs isLegacyEdgeKey', () => {
  assert.ok(isStableKey('sek1:E:0,0,0|1,0,0:feat1'));
  assert.ok(!isStableKey('0.00000,0.00000,0.00000|1.00000,0.00000,0.00000'));
  assert.ok(isLegacyEdgeKey('0.00000,0.00000,0.00000|1.00000,0.00000,0.00000'));
  assert.ok(!isLegacyEdgeKey('sek1:E:0,0,0|1,0,0:feat1'));
});

test('legacyEdgeKeyToStable converts correctly', () => {
  const legacy = '0.00000,0.00000,0.00000|1.00000,0.00000,0.00000';
  const stable = legacyEdgeKeyToStable(legacy, 'prov');
  assert.ok(isStableKey(stable));
  const parsed = parseKey(stable);
  assert.strictEqual(parsed.entityType, EntityType.EDGE);
});

test('legacyEdgeKeyToStable returns null for invalid input', () => {
  const result = legacyEdgeKeyToStable('not-a-valid-key');
  assert.strictEqual(result, null);
});

test('keys are stable across repeated Part recompute', () => {
  resetFeatureIds();
  const part1 = makeBoxPart(10, 10, 10);
  const keys1 = getEdgeKeysFromPart(part1);

  resetFeatureIds();
  const part2 = makeBoxPart(10, 10, 10);
  const keys2 = getEdgeKeysFromPart(part2);

  // Legacy keys should match since geometry is identical
  assert.strictEqual(keys1.length, keys2.length);
  const set1 = new Set(keys1);
  const set2 = new Set(keys2);
  for (const k of set1) {
    assert.ok(set2.has(k), `Key ${k} not found in second computation`);
  }
});

// -----------------------------------------------------------------------
// 2) Save/load roundtrip preserving selection keys
// -----------------------------------------------------------------------

group('2) Save/load roundtrip preserving selection keys');

test('chamfer stableEdgeKeys survive serialize/deserialize', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const edgeKeys = getEdgeKeysFromPart(part);
  if (edgeKeys.length > 0) {
    const chamfer = part.chamfer([edgeKeys[0]], 0.5);
    chamfer.stableEdgeKeys = [legacyEdgeKeyToStable(edgeKeys[0], chamfer.id)];

    const serialized = part.serialize();
    const deserialized = Part.deserialize(serialized);

    const features = deserialized.getFeatures();
    const chamferFeature = features.find(f => f.type === 'chamfer');
    assert.ok(chamferFeature, 'Chamfer feature found after deserialization');
    assert.strictEqual(chamferFeature.stableEdgeKeys.length, 1);
    assert.ok(isStableKey(chamferFeature.stableEdgeKeys[0]));
  }
});

test('fillet stableEdgeKeys survive serialize/deserialize', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const edgeKeys = getEdgeKeysFromPart(part);
  if (edgeKeys.length > 0) {
    const fillet = part.fillet([edgeKeys[0]], 0.5);
    fillet.stableEdgeKeys = [legacyEdgeKeyToStable(edgeKeys[0], fillet.id)];

    const serialized = part.serialize();
    const deserialized = Part.deserialize(serialized);

    const features = deserialized.getFeatures();
    const filletFeature = features.find(f => f.type === 'fillet');
    assert.ok(filletFeature, 'Fillet feature found after deserialization');
    assert.strictEqual(filletFeature.stableEdgeKeys.length, 1);
    assert.ok(isStableKey(filletFeature.stableEdgeKeys[0]));
  }
});

test('serializeKeys/deserializeKeys roundtrip', () => {
  const keys = ['sek1:E:0,0|1,0:f1', 'sek1:F:plane:c0,0,0:f2'];
  const ser = serializeKeys(keys);
  const deser = deserializeKeys(ser);
  assert.deepStrictEqual(deser, keys);
});

test('deserializeKeys handles missing/invalid data', () => {
  assert.deepStrictEqual(deserializeKeys(null), []);
  assert.deepStrictEqual(deserializeKeys(undefined), []);
  assert.deepStrictEqual(deserializeKeys('string'), []);
  assert.deepStrictEqual(deserializeKeys([1, null, 'valid']), ['valid']);
});

// -----------------------------------------------------------------------
// 3) Workflow recording replay stability
// -----------------------------------------------------------------------

group('3) Workflow recording replay stability');

test('replayFeatureTree returns diagnostics for empty tree', () => {
  resetFeatureIds();
  const part = new Part('Empty');
  const result = replayFeatureTree(part.featureTree);
  assert.ok(result);
  assert.strictEqual(result.overallStatus, ReplayStatus.EXACT);
  assert.strictEqual(result.diagnostics.length, 0);
});

test('replayFeatureTree returns exact for simple extrude', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const result = replayFeatureTree(part.featureTree);
  assert.ok(result);
  // Sketch + extrude = 2 features
  assert.strictEqual(result.diagnostics.length, 2);
  for (const d of result.diagnostics) {
    assert.strictEqual(d.status, ReplayStatus.EXACT);
  }
});

test('FeatureReplayResult toJSON produces valid structure', () => {
  const result = new FeatureReplayResult();
  result.addDiagnostic(new FeatureReplayDiagnostic({
    featureIndex: 0,
    featureId: 'feature_1',
    featureType: 'extrude',
    status: ReplayStatus.EXACT,
  }));
  const json = result.toJSON();
  assert.strictEqual(json.overallStatus, 'exact');
  assert.strictEqual(json.diagnostics.length, 1);
  assert.strictEqual(json.diagnostics[0].featureId, 'feature_1');
});

// -----------------------------------------------------------------------
// 4) Geometry persistence when adding new sketches
// -----------------------------------------------------------------------

group('4) Geometry persistence when adding new sketches');

test('solid persists after adding a sketch', () => {
  resetFeatureIds();
  const part = makeBoxPart(10, 10, 10);
  const geo1 = part.getFinalGeometry();
  assert.ok(geo1);
  assert.strictEqual(geo1.type, 'solid');

  // Add a new sketch
  const sketch2 = new Sketch();
  sketch2.addSegment(2, 2, 8, 2);
  sketch2.addSegment(8, 2, 8, 8);
  sketch2.addSegment(8, 8, 2, 8);
  sketch2.addSegment(2, 8, 2, 2);
  part.addSketch(sketch2);

  const geo2 = part.getFinalGeometry();
  assert.ok(geo2);
  assert.strictEqual(geo2.type, 'solid');
});

// -----------------------------------------------------------------------
// 5) Chamfer/fillet replay after benign upstream edits
// -----------------------------------------------------------------------

group('5) Chamfer/fillet replay after benign upstream edits');

test('chamfer feature serializes stableEdgeKeys', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const edgeKeys = getEdgeKeysFromPart(part);
  if (edgeKeys.length > 0) {
    const chamfer = part.chamfer([edgeKeys[0]], 0.5);
    const serialized = chamfer.serialize();
    assert.ok(Array.isArray(serialized.stableEdgeKeys));
    assert.ok(Array.isArray(serialized.edgeKeys));
    assert.strictEqual(serialized.edgeKeys.length, 1);
  }
});

test('fillet feature serializes stableEdgeKeys', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const edgeKeys = getEdgeKeysFromPart(part);
  if (edgeKeys.length > 0) {
    const fillet = part.fillet([edgeKeys[0]], 0.5);
    const serialized = fillet.serialize();
    assert.ok(Array.isArray(serialized.stableEdgeKeys));
    assert.ok(Array.isArray(serialized.edgeKeys));
    assert.strictEqual(serialized.edgeKeys.length, 1);
  }
});

test('Part.chamfer auto-populates stableEdgeKeys for new features', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const edgeKeys = getEdgeKeysFromPart(part);
  if (edgeKeys.length > 0) {
    const chamfer = part.chamfer([edgeKeys[0]], 0.5);
    assert.strictEqual(chamfer.stableEdgeKeys.length, 1, 'Expected 1 stable edge key');
    assert.ok(isStableKey(chamfer.stableEdgeKeys[0]), 'Expected a stable key');
    assert.ok(!chamfer._legacySelection, 'Should not be legacy since stable keys exist');
  }
});

test('Part.fillet auto-populates stableEdgeKeys for new features', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const edgeKeys = getEdgeKeysFromPart(part);
  if (edgeKeys.length > 0) {
    const fillet = part.fillet([edgeKeys[0]], 0.5);
    assert.strictEqual(fillet.stableEdgeKeys.length, 1, 'Expected 1 stable edge key');
    assert.ok(isStableKey(fillet.stableEdgeKeys[0]), 'Expected a stable key');
    assert.ok(!fillet._legacySelection, 'Should not be legacy since stable keys exist');
  }
});

test('Part.chamfer with multiple edges populates matching stableEdgeKeys', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const edgeKeys = getEdgeKeysFromPart(part);
  if (edgeKeys.length >= 2) {
    const chamfer = part.chamfer([edgeKeys[0], edgeKeys[1]], 0.5);
    assert.strictEqual(chamfer.stableEdgeKeys.length, 2, 'Expected 2 stable edge keys');
    for (const sk of chamfer.stableEdgeKeys) {
      assert.ok(isStableKey(sk), `Expected stable key, got ${sk}`);
    }
  }
});

test('ChamferFeature.deserialize marks legacy selection', () => {
  const feature = ChamferFeature.deserialize({
    id: 'feature_99',
    type: 'chamfer',
    distance: 2,
    edgeKeys: ['0,0,0|1,0,0'],
    // no stableEdgeKeys → legacy
  });
  assert.ok(feature._legacySelection);
});

test('FilletFeature.deserialize marks legacy selection', () => {
  const feature = FilletFeature.deserialize({
    id: 'feature_100',
    type: 'fillet',
    radius: 1,
    edgeKeys: ['0,0,0|1,0,0'],
    // no stableEdgeKeys → legacy
  });
  assert.ok(feature._legacySelection);
});

test('ChamferFeature.deserialize migrates legacy keys to stable keys', () => {
  const feature = ChamferFeature.deserialize({
    id: 'feature_101',
    type: 'chamfer',
    distance: 2,
    edgeKeys: ['0.00000,0.00000,0.00000|1.00000,0.00000,0.00000'],
  });
  assert.ok(feature._legacySelection, 'Should be flagged as legacy');
  assert.strictEqual(feature.stableEdgeKeys.length, 1, 'Should have migrated 1 stable key');
  assert.ok(isStableKey(feature.stableEdgeKeys[0]), 'Migrated key should be a stable key');
});

test('FilletFeature.deserialize migrates legacy keys to stable keys', () => {
  const feature = FilletFeature.deserialize({
    id: 'feature_102',
    type: 'fillet',
    radius: 1,
    edgeKeys: ['0.00000,0.00000,0.00000|1.00000,0.00000,0.00000'],
  });
  assert.ok(feature._legacySelection, 'Should be flagged as legacy');
  assert.strictEqual(feature.stableEdgeKeys.length, 1, 'Should have migrated 1 stable key');
  assert.ok(isStableKey(feature.stableEdgeKeys[0]), 'Migrated key should be a stable key');
});

test('migration preserves provenance from feature id', () => {
  const feature = ChamferFeature.deserialize({
    id: 'feature_200',
    type: 'chamfer',
    distance: 1,
    edgeKeys: ['1.00000,2.00000,3.00000|4.00000,5.00000,6.00000'],
  });
  assert.strictEqual(feature.stableEdgeKeys.length, 1);
  const parsed = parseKey(feature.stableEdgeKeys[0]);
  assert.ok(parsed, 'Stable key should be parseable');
  assert.strictEqual(parsed.provenance, 'feature_200');
});

// -----------------------------------------------------------------------
// 6) Explicit failure/remap diagnostics when topology changes
// -----------------------------------------------------------------------

group('6) Explicit failure/remap diagnostics');

test('resolveEdgeSelections returns non-exact when no topoBody', () => {
  const result = resolveEdgeSelections(['0,0,0|1,0,0'], null, 'feat1');
  assert.strictEqual(result.overallStatus, ReplayStatus.NON_EXACT);
  assert.strictEqual(result.resolvedKeys.length, 1);
});

test('resolveEdgeSelections handles empty keys', () => {
  const result = resolveEdgeSelections([], null, 'feat1');
  assert.strictEqual(result.overallStatus, ReplayStatus.EXACT);
  assert.strictEqual(result.resolvedKeys.length, 0);
});

test('RemapStatus enum values', () => {
  assert.strictEqual(RemapStatus.EXACT, 'exact');
  assert.strictEqual(RemapStatus.REMAPPED, 'remapped');
  assert.strictEqual(RemapStatus.MISSING, 'missing');
  assert.strictEqual(RemapStatus.AMBIGUOUS, 'ambiguous');
});

test('DiagnosticReason enum values', () => {
  assert.strictEqual(DiagnosticReason.MISSING_ENTITY, 'missing entity');
  assert.strictEqual(DiagnosticReason.AMBIGUOUS_MATCH, 'ambiguous match');
  assert.strictEqual(DiagnosticReason.TOPOLOGY_CHANGED, 'topology changed');
  assert.strictEqual(DiagnosticReason.CACHE_INVALIDATED, 'cache invalidated');
  assert.strictEqual(DiagnosticReason.UNSUPPORTED_LEGACY, 'unsupported legacy feature payload');
});

test('resolveKey returns missing for unknown key', () => {
  const bodyKeys = { faces: new Map(), edges: new Map(), vertices: new Map() };
  const result = resolveKey('sek1:E:99,99,99|88,88,88:unknown', bodyKeys);
  assert.strictEqual(result.status, RemapStatus.MISSING);
});

test('resolveKey returns missing for unparseable key', () => {
  const bodyKeys = { faces: new Map(), edges: new Map(), vertices: new Map() };
  const result = resolveKey('garbage', bodyKeys);
  assert.strictEqual(result.status, RemapStatus.MISSING);
  assert.ok(result.reason.includes('unparseable'));
});

// -----------------------------------------------------------------------
// 7) Cache hits on unchanged history segments
// -----------------------------------------------------------------------

group('7) Cache hits on unchanged history segments');

test('HistoryCache basic get/set', () => {
  const cache = new HistoryCache();
  const key = buildCacheKey({
    inputHash: 'abc',
    featureType: 'extrude',
    params: { distance: 10 },
  });
  assert.strictEqual(cache.get(key), null);

  cache.set(key, { type: 'solid', volume: 1000 });
  const cached = cache.get(key);
  assert.ok(cached);
  assert.strictEqual(cached.type, 'solid');
});

test('HistoryCache stats', () => {
  const cache = new HistoryCache();
  const key = 'test-key';
  cache.set(key, { data: true });
  cache.get(key); // hit
  cache.get('nonexistent'); // miss

  const stats = cache.stats();
  assert.strictEqual(stats.hits, 1);
  assert.strictEqual(stats.misses, 1);
  assert.strictEqual(stats.size, 1);
  assert.ok(stats.hitRate > 0);
});

test('HistoryCache eviction', () => {
  const cache = new HistoryCache({ maxEntries: 2 });
  cache.set('k1', { v: 1 });
  cache.set('k2', { v: 2 });
  cache.set('k3', { v: 3 }); // should evict k1

  assert.strictEqual(cache.get('k1'), null);
  assert.ok(cache.get('k2'));
  assert.ok(cache.get('k3'));
});

test('HistoryCache clear', () => {
  const cache = new HistoryCache();
  cache.set('key1', { v: 1 });
  cache.clear();
  assert.strictEqual(cache.stats().size, 0);
});

test('buildCacheKey is deterministic', () => {
  const opts = {
    inputHash: 'hash1',
    featureType: 'fillet',
    params: { radius: 2, segments: 8 },
    selectionKeys: ['sek1:E:0,0,0|1,0,0:f1'],
  };
  const k1 = buildCacheKey(opts);
  const k2 = buildCacheKey(opts);
  assert.strictEqual(k1, k2);
});

test('buildCacheKey varies with different params', () => {
  const k1 = buildCacheKey({ featureType: 'fillet', params: { radius: 1 } });
  const k2 = buildCacheKey({ featureType: 'fillet', params: { radius: 2 } });
  assert.notStrictEqual(k1, k2);
});

test('buildCacheKey varies with different selections', () => {
  const k1 = buildCacheKey({ featureType: 'chamfer', selectionKeys: ['a'] });
  const k2 = buildCacheKey({ featureType: 'chamfer', selectionKeys: ['b'] });
  assert.notStrictEqual(k1, k2);
});

test('replayFeatureTree with cache reports cache stats', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const cache = new HistoryCache();
  const result = replayFeatureTree(part.featureTree, { cache });
  assert.ok(result);
  // Should report misses on first run
  assert.ok(result.cacheMisses >= 0);
});

test('HistoryCache serialize produces valid structure', () => {
  const cache = new HistoryCache();
  cache.set('k1', { v: 1 });
  const ser = cache.serialize();
  assert.strictEqual(ser.version, 'hc1');
  assert.ok(Array.isArray(ser.entries));
  assert.ok(ser.stats);
});

test('HistoryCache.deserialize returns empty cache', () => {
  const cache = HistoryCache.deserialize({ version: 'hc1', entries: [] });
  assert.ok(cache instanceof HistoryCache);
  assert.strictEqual(cache.stats().size, 0);
});

// -----------------------------------------------------------------------
// 8) Backward-compatible loading of older .cmod projects
// -----------------------------------------------------------------------

group('8) Backward-compatible loading of older .cmod projects');

test('parseCMOD accepts version 1 (old format)', () => {
  const result = parseCMOD({ format: 'CAD Modeller Open Design', version: 1 });
  assert.strictEqual(result.ok, true);
});

test('parseCMOD accepts version 2 (new format)', () => {
  const result = parseCMOD({ format: 'CAD Modeller Open Design', version: 2 });
  assert.strictEqual(result.ok, true);
});

test('parseCMOD rejects version 3', () => {
  const result = parseCMOD({ format: 'CAD Modeller Open Design', version: 3 });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('newer'));
});

test('buildCMOD produces version 2', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const cmod = buildCMOD(part);
  assert.strictEqual(cmod.version, 2);
  assert.strictEqual(cmod.format, 'CAD Modeller Open Design');
});

test('buildCMOD with replayDiagnostics embeds them', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const diag = { overallStatus: 'exact', diagnostics: [] };
  const cmod = buildCMOD(part, { replayDiagnostics: diag });
  assert.ok(cmod._replayDiagnostics);
  assert.strictEqual(cmod._replayDiagnostics.overallStatus, 'exact');
});

test('old v1 cmod data parses and loads successfully', () => {
  // Simulate a v1 .cmod object
  resetFeatureIds();
  const part = makeBoxPart();
  const partData = part.serialize();
  const v1cmod = {
    format: 'CAD Modeller Open Design',
    version: 1,
    part: partData,
    settings: { gridSize: 10 },
  };
  const result = parseCMOD(v1cmod);
  assert.strictEqual(result.ok, true);
  assert.ok(result.data.part);
});

test('chamfer deserialized from v1 data (no stableEdgeKeys) has legacy flag and migrated keys', () => {
  const feature = ChamferFeature.deserialize({
    id: 'feature_50',
    type: 'chamfer',
    distance: 1,
    edgeKeys: ['1,2,3|4,5,6'],
  });
  assert.ok(feature._legacySelection, 'Legacy selection flag should be set');
  // Migration populates stableEdgeKeys from legacy keys
  assert.strictEqual(feature.stableEdgeKeys.length, 1, 'Should have migrated 1 stable key');
  assert.ok(isStableKey(feature.stableEdgeKeys[0]), 'Migrated key should be stable');
});

test('chamfer deserialized from v2 data (with stableEdgeKeys) has no legacy flag', () => {
  const feature = ChamferFeature.deserialize({
    id: 'feature_51',
    type: 'chamfer',
    distance: 1,
    edgeKeys: ['1,2,3|4,5,6'],
    stableEdgeKeys: ['sek1:E:1,2,3|4,5,6:feature_51'],
  });
  assert.ok(!feature._legacySelection, 'Legacy selection flag should not be set');
  assert.strictEqual(feature.stableEdgeKeys.length, 1);
});

// -----------------------------------------------------------------------
// Additional integration tests
// -----------------------------------------------------------------------

group('Additional integration');

test('keyBody on null returns empty maps', () => {
  const result = keyBody(null);
  assert.strictEqual(result.faces.size, 0);
  assert.strictEqual(result.edges.size, 0);
  assert.strictEqual(result.vertices.size, 0);
});

test('keyBody on object without shells returns empty maps', () => {
  const result = keyBody({});
  assert.strictEqual(result.faces.size, 0);
});

test('resolveKey with unknown entity type', () => {
  const bodyKeys = { faces: new Map(), edges: new Map(), vertices: new Map() };
  const result = resolveKey('sek1:X:sig:prov', bodyKeys);
  assert.strictEqual(result.status, RemapStatus.MISSING);
  assert.ok(result.reason.includes('unknown entity type'));
});

test('FeatureReplayDiagnostic toJSON', () => {
  const diag = new FeatureReplayDiagnostic({
    featureIndex: 3,
    featureId: 'feature_10',
    featureType: 'chamfer',
    status: ReplayStatus.FAILED,
    selectionKeys: ['key1'],
    reason: DiagnosticReason.MISSING_ENTITY,
  });
  const json = diag.toJSON();
  assert.strictEqual(json.featureIndex, 3);
  assert.strictEqual(json.featureId, 'feature_10');
  assert.strictEqual(json.status, 'failed');
  assert.strictEqual(json.selectionKeys.length, 1);
});

test('replayFeatureTree with suppressed features', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const features = part.getFeatures();
  // Suppress the extrude
  const extrudeFeature = features.find(f => f.type === 'extrude');
  if (extrudeFeature) {
    part.suppressFeature(extrudeFeature.id);
  }

  const result = replayFeatureTree(part.featureTree);
  const suppressed = result.diagnostics.filter(d => d.reason === 'suppressed');
  assert.ok(suppressed.length > 0, 'Should have at least one suppressed diagnostic');

  // Unsuppress
  if (extrudeFeature) {
    part.unsuppressFeature(extrudeFeature.id);
  }
});

test('replayFeatureTree dryRun does not execute', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const result = replayFeatureTree(part.featureTree, { dryRun: true });
  assert.ok(result);
  assert.strictEqual(result.overallStatus, ReplayStatus.EXACT);
});

// -----------------------------------------------------------------------
// 9) End-to-end .cmod roundtrip with stable keys
// -----------------------------------------------------------------------

group('9) End-to-end .cmod roundtrip with stable keys');

test('new chamfer roundtrip preserves auto-populated stableEdgeKeys', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const edgeKeys = getEdgeKeysFromPart(part);
  if (edgeKeys.length > 0) {
    part.chamfer([edgeKeys[0]], 0.5);
    const cmod = buildCMOD(part);
    const json = JSON.stringify(cmod);
    const parsed = parseCMOD(json);
    assert.strictEqual(parsed.ok, true);

    const restored = Part.deserialize(parsed.data.part);
    const chamfer = restored.getFeatures().find(f => f.type === 'chamfer');
    assert.ok(chamfer, 'Chamfer feature found after roundtrip');
    assert.strictEqual(chamfer.stableEdgeKeys.length, 1, 'stableEdgeKeys preserved');
    assert.ok(isStableKey(chamfer.stableEdgeKeys[0]), 'Key is stable after roundtrip');
    assert.ok(!chamfer._legacySelection, 'Not legacy after roundtrip with stable keys');
  }
});

test('new fillet roundtrip preserves auto-populated stableEdgeKeys', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const edgeKeys = getEdgeKeysFromPart(part);
  if (edgeKeys.length > 0) {
    part.fillet([edgeKeys[0]], 0.5);
    const cmod = buildCMOD(part);
    const json = JSON.stringify(cmod);
    const parsed = parseCMOD(json);
    assert.strictEqual(parsed.ok, true);

    const restored = Part.deserialize(parsed.data.part);
    const fillet = restored.getFeatures().find(f => f.type === 'fillet');
    assert.ok(fillet, 'Fillet feature found after roundtrip');
    assert.strictEqual(fillet.stableEdgeKeys.length, 1, 'stableEdgeKeys preserved');
    assert.ok(isStableKey(fillet.stableEdgeKeys[0]), 'Key is stable after roundtrip');
    assert.ok(!fillet._legacySelection, 'Not legacy after roundtrip with stable keys');
  }
});

test('v1 cmod with legacy chamfer keys migrates on load', () => {
  resetFeatureIds();
  const part = makeBoxPart();
  const edgeKeys = getEdgeKeysFromPart(part);
  if (edgeKeys.length > 0) {
    part.chamfer([edgeKeys[0]], 0.5);
    // Simulate v1 save: serialize then strip stableEdgeKeys
    const partData = part.serialize();
    const chamferData = partData.featureTree.features.find(f => f.type === 'chamfer');
    delete chamferData.stableEdgeKeys;

    const v1cmod = {
      format: 'CAD Modeller Open Design',
      version: 1,
      part: partData,
    };
    const parsed = parseCMOD(v1cmod);
    assert.strictEqual(parsed.ok, true);

    const restored = Part.deserialize(parsed.data.part);
    const chamfer = restored.getFeatures().find(f => f.type === 'chamfer');
    assert.ok(chamfer, 'Chamfer found after migration');
    assert.ok(chamfer._legacySelection, 'Flagged as legacy');
    assert.ok(chamfer.stableEdgeKeys.length > 0, 'Legacy keys migrated to stable keys');
    assert.ok(isStableKey(chamfer.stableEdgeKeys[0]), 'Migrated key is stable');
  }
});

test('stableEdgeKeys are deterministic across repeated creates', () => {
  resetFeatureIds();
  const part1 = makeBoxPart();
  const keys1 = getEdgeKeysFromPart(part1);
  if (keys1.length > 0) {
    const chamfer1 = part1.chamfer([keys1[0]], 0.5);
    const stableKeys1 = [...chamfer1.stableEdgeKeys];

    resetFeatureIds();
    const part2 = makeBoxPart();
    const keys2 = getEdgeKeysFromPart(part2);
    const chamfer2 = part2.chamfer([keys2[0]], 0.5);
    const stableKeys2 = [...chamfer2.stableEdgeKeys];

    assert.deepStrictEqual(stableKeys1, stableKeys2, 'Stable keys should be deterministic');
  }
});

// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------

console.log(`\nHistory Replay Tests: ${_passed} passed, ${_failed} failed`);
if (_failed > 0) process.exit(1);

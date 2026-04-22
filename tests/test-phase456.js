import './_watchdog.mjs';
// tests/test-phase456.js — Tests for Phase 4/5/6 features:
// - Per-intersection error bounds (ops.ts)
// - Dynamic LoD dispatch (lod-manager.js)
// - Handle residency manager (HandleResidencyManager.js)
// - Telemetry extensions (telemetry.js)

import assert from 'node:assert/strict';
import { formatTimingSuffix, startTiming } from './test-timing.js';

// ─── Helpers ─────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function test(section, name, fn) {
    const startedAt = startTiming();
    try {
        fn();
        console.log(`  \u2713 ${name}${formatTimingSuffix(startedAt)}`);
        passed++;
    } catch (e) {
        console.log(`  \u2717 ${name}: ${e.message}${formatTimingSuffix(startedAt)}`);
        failures.push(`[${section}] ${name}: ${e.message}`);
        failed++;
    }
}

// ─── Load WASM ───────────────────────────────────────────────────────

const wasm = await import('../build/release.js');

function buildUnitCube() {
    wasm.bodyBegin();
    wasm.geomPoolReset();

    const v = [];
    for (let z = 0; z < 2; z++)
        for (let y = 0; y < 2; y++)
            for (let x = 0; x < 2; x++)
                v.push(wasm.vertexAdd(x, y, z));

    // 6 faces: -X, +X, -Y, +Y, -Z, +Z
    const faceNormals = [
        [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1],
    ];
    const faceVerts = [
        [0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6],
    ];

    for (let f = 0; f < 6; f++) {
        const [nx, ny, nz] = faceNormals[f];
        const gOff = wasm.planeStore(
            faceVerts[f].reduce((s, vi) => s + wasm.vertexGetX(vi), 0) / 4,
            faceVerts[f].reduce((s, vi) => s + wasm.vertexGetY(vi), 0) / 4,
            faceVerts[f].reduce((s, vi) => s + wasm.vertexGetZ(vi), 0) / 4,
            nx, ny, nz, 0, 0, 0,
        );

        const fv = faceVerts[f];
        const N = fv.length;
        const edges = [];
        for (let i = 0; i < N; i++) {
            edges.push(wasm.edgeAdd(fv[i], fv[(i + 1) % N], wasm.GEOM_LINE, 0));
        }
        const coedges = [];
        for (let i = 0; i < N; i++) {
            coedges.push(wasm.coedgeAdd(edges[i], wasm.ORIENT_FORWARD, 0, f));
        }
        for (let i = 0; i < N; i++) {
            wasm.coedgeSetNext(coedges[i], coedges[(i + 1) % N]);
        }
        wasm.loopAdd(coedges[0], f, 1);
        wasm.faceAdd(f, 0, wasm.GEOM_PLANE, gOff, wasm.ORIENT_FORWARD, 1);
    }
    wasm.shellAdd(0, 6, 1);
    wasm.bodyEnd();
}

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Per-Intersection Error Bounds ===');

test('isx', 'isxReset clears count', () => {
    wasm.isxReset();
    assert.equal(wasm.isxGetCount() >>> 0, 0);
});

test('isx', 'isxRecord stores intersection and returns index', () => {
    wasm.isxReset();
    const idx = wasm.isxRecord(0, 1, 1.0, 2.0, 3.0, 0, 0, 1, 1, 0, 0, 0.0);
    assert.equal(idx, 0);
    assert.equal(wasm.isxGetCount() >>> 0, 1);
});

test('isx', 'isxGetErrorBound returns positive bound', () => {
    wasm.isxReset();
    // Perpendicular hit on plane: low error bound
    wasm.isxRecord(0, 1, 1.0, 0.0, 0.0, 1, 0, 0, 1, 0, 0, 0.0);
    const bound = wasm.isxGetErrorBound(0);
    assert.ok(bound > 0, `error bound should be positive, got ${bound}`);
    assert.ok(bound < 1e-10, `perpendicular plane hit should have tiny bound, got ${bound}`);
});

test('isx', 'near-tangent hit has larger error bound', () => {
    wasm.isxReset();
    // Perpendicular hit
    wasm.isxRecord(0, 1, 1.0, 0.0, 0.0, 0, 0, 1, 0, 0, 1, 0.0);
    const perpBound = wasm.isxGetErrorBound(0);
    // Near-tangent hit: ray almost parallel to normal
    wasm.isxRecord(0, 1, 1.0, 0.0, 0.0, 0, 0, 1, 0, 1, 1e-8, 0.0);
    const tangBound = wasm.isxGetErrorBound(1);
    assert.ok(tangBound > perpBound, `tangent bound ${tangBound} should exceed perpendicular ${perpBound}`);
});

test('isx', 'curved surface has larger bound than flat', () => {
    wasm.isxReset();
    // Flat surface (curvature=0)
    wasm.isxRecord(0, 1, 1.0, 0.0, 0.0, 0, 0, 1, 0, 0, 1, 0.0);
    const flatBound = wasm.isxGetErrorBound(0);
    // Curved surface (curvature=10, small radius)
    wasm.isxRecord(0, 1, 1.0, 0.0, 0.0, 0, 0, 1, 0, 0, 1, 10.0);
    const curvBound = wasm.isxGetErrorBound(1);
    assert.ok(curvBound > flatBound, `curved bound ${curvBound} should exceed flat ${flatBound}`);
});

test('isx', 'isxGetMaxErrorBound returns largest', () => {
    wasm.isxReset();
    wasm.isxRecord(0, 1, 1.0, 0.0, 0.0, 0, 0, 1, 0, 0, 1, 0.0);
    wasm.isxRecord(0, 1, 1.0, 0.0, 0.0, 0, 0, 1, 0, 1, 1e-8, 0.0);
    const max = wasm.isxGetMaxErrorBound();
    const b0 = wasm.isxGetErrorBound(0);
    const b1 = wasm.isxGetErrorBound(1);
    assert.equal(max, Math.max(b0, b1));
});

test('isx', 'isxAreDistinct — well-separated points', () => {
    wasm.isxReset();
    // Two points 10 units apart
    wasm.isxRecord(0, 1, 0.0, 0.0, 0.0, 0, 0, 1, 0, 0, 1, 0.0);
    wasm.isxRecord(0, 1, 10.0, 0.0, 0.0, 0, 0, 1, 0, 0, 1, 0.0);
    assert.ok(wasm.isxAreDistinct(0, 1) !== 0, 'points 10 apart should be distinct');
});

test('isx', 'isxAreDistinct — coincident points not distinct', () => {
    wasm.isxReset();
    wasm.isxRecord(0, 1, 1.0, 2.0, 3.0, 0, 0, 1, 0, 0, 1, 0.0);
    wasm.isxRecord(0, 1, 1.0, 2.0, 3.0, 0, 0, 1, 0, 0, 1, 0.0);
    assert.ok(!wasm.isxAreDistinct(0, 1), 'coincident points should not be distinct');
});

test('isx', 'isxRayFace hits plane', () => {
    buildUnitCube();
    wasm.isxReset();
    // Ray from (-1, 0.5, 0.5) along +X should hit the -X face at x=0
    const t = wasm.isxRayFace(0, 1, -1.0, 0.5, 0.5, 1, 0, 0);
    assert.ok(t > 0, `ray should hit plane, got t=${t}`);
    assert.ok(wasm.isxGetCount() >>> 0 >= 1, 'should have recorded intersection');
});

test('isx', 'isxRayFace misses when parallel', () => {
    buildUnitCube();
    wasm.isxReset();
    // Ray parallel to -X face normal (along Y)
    const t = wasm.isxRayFace(0, 1, -1.0, 0.5, 0.5, 0, 1, 0);
    assert.equal(t, -1.0, 'parallel ray should miss');
});

test('isx', 'isxRayFace hits sphere', () => {
    wasm.bodyBegin();
    wasm.geomPoolReset();
    wasm.vertexAdd(0, 0, 0);
    const gOff = wasm.sphereStore(0, 0, 0, 0, 0, 1, 1, 0, 0, 1.0);
    const edges = [wasm.edgeAdd(0, 0, wasm.GEOM_LINE, 0)];
    const ce = wasm.coedgeAdd(edges[0], wasm.ORIENT_FORWARD, 0, 0);
    wasm.coedgeSetNext(ce, ce);
    wasm.loopAdd(ce, 0, 1);
    wasm.faceAdd(0, 0, wasm.GEOM_SPHERE, gOff, wasm.ORIENT_FORWARD, 1);
    wasm.shellAdd(0, 1, 1);
    wasm.bodyEnd();

    wasm.isxReset();
    const t = wasm.isxRayFace(0, 0, -5, 0, 0, 1, 0, 0);
    assert.ok(t > 0, `ray should hit sphere, got t=${t}`);
    // Hit point should be near (-1, 0, 0) → t ≈ 4
    assert.ok(Math.abs(t - 4.0) < 0.01, `t should be ~4, got ${t}`);
});

test('isx', 'isxRayFace hits cylinder', () => {
    wasm.bodyBegin();
    wasm.geomPoolReset();
    wasm.vertexAdd(0, 0, 0);
    // Cylinder along Z axis, radius 1
    const gOff = wasm.cylinderStore(0, 0, 0, 0, 0, 1, 1, 0, 0, 1.0);
    const edges = [wasm.edgeAdd(0, 0, wasm.GEOM_LINE, 0)];
    const ce = wasm.coedgeAdd(edges[0], wasm.ORIENT_FORWARD, 0, 0);
    wasm.coedgeSetNext(ce, ce);
    wasm.loopAdd(ce, 0, 1);
    wasm.faceAdd(0, 0, wasm.GEOM_CYLINDER, gOff, wasm.ORIENT_FORWARD, 1);
    wasm.shellAdd(0, 1, 1);
    wasm.bodyEnd();

    wasm.isxReset();
    // Ray from (-5, 0, 0.5) along +X should hit cylinder at x = -1
    const t = wasm.isxRayFace(0, 0, -5, 0, 0.5, 1, 0, 0);
    assert.ok(t > 0, `ray should hit cylinder, got t=${t}`);
    assert.ok(Math.abs(t - 4.0) < 0.01, `t should be ~4, got ${t}`);
});

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Dynamic LoD Manager ===');

const { LodManager } = await import('../js/render/lod-manager.js');

test('lod', 'initial state has no band', () => {
    const lod = new LodManager();
    assert.equal(lod.currentBandIndex, -1);
});

test('lod', 'first update selects correct band', () => {
    const lod = new LodManager();
    const changed = lod.update(10);
    assert.ok(changed, 'first update should trigger retessellation');
    assert.deepEqual(lod.segments, { segsU: 32, segsV: 32 });
});

test('lod', 'close distance gives highest density', () => {
    const lod = new LodManager();
    lod.update(5);
    assert.deepEqual(lod.segments, { segsU: 32, segsV: 32 });
});

test('lod', 'far distance gives lowest density', () => {
    const lod = new LodManager();
    lod.update(1000);
    assert.deepEqual(lod.segments, { segsU: 2, segsV: 2 });
});

test('lod', 'mid distance gives mid density', () => {
    const lod = new LodManager();
    lod.update(100);
    assert.deepEqual(lod.segments, { segsU: 8, segsV: 8 });
});

test('lod', 'same distance does not trigger', () => {
    const lod = new LodManager();
    lod.update(10);
    const changed = lod.update(10);
    assert.ok(!changed, 'same distance should not retrigger');
});

test('lod', 'onRetessellate callback fires', () => {
    const lod = new LodManager();
    let cbArgs = null;
    lod.onRetessellate = (u, v) => { cbArgs = { u, v }; };
    lod.update(10);
    assert.ok(cbArgs, 'callback should have fired');
    assert.equal(cbArgs.u, 32);
    assert.equal(cbArgs.v, 32);
});

test('lod', 'forceSegments bypasses bands', () => {
    const lod = new LodManager();
    lod.forceSegments(64, 64);
    assert.deepEqual(lod.segments, { segsU: 64, segsV: 64 });
    assert.equal(lod.currentBandIndex, -1);
});

test('lod', 'reset allows re-trigger', () => {
    const lod = new LodManager();
    lod.update(10);
    lod.reset();
    const changed = lod.update(10);
    assert.ok(changed, 'should retrigger after reset');
});

test('lod', 'segmentsForDistance does not change state', () => {
    const lod = new LodManager();
    const segs = lod.segmentsForDistance(100);
    assert.deepEqual(segs, { segsU: 8, segsV: 8 });
    assert.equal(lod.currentBandIndex, -1, 'state should not change');
});

test('lod', 'custom bands', () => {
    const lod = new LodManager({
        bands: [
            { maxDistance: 10, segsU: 64, segsV: 64 },
            { maxDistance: Infinity, segsU: 4, segsV: 4 },
        ],
    });
    lod.update(5);
    assert.deepEqual(lod.segments, { segsU: 64, segsV: 64 });
    lod.update(50);
    assert.deepEqual(lod.segments, { segsU: 4, segsV: 4 });
});

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Handle Residency Manager ===');

const { default: WasmBrepHandleRegistry } = await import('../js/cad/WasmBrepHandleRegistry.js');
const { HandleResidencyManager } = await import('../js/cad/HandleResidencyManager.js');

const registry = new WasmBrepHandleRegistry();
await registry.init();

// Build a cube and dehydrate it to get a valid CBREP
buildUnitCube();
const cbrepBytes = registry.dehydrate();

test('residency', 'storeCbrep stores without hydrating', () => {
    const mgr = new HandleResidencyManager(registry);
    mgr.storeCbrep(42, cbrepBytes, 12345);
    assert.ok(mgr.hasCbrep(42));
    assert.equal(mgr.getHandle(42), 0, 'should not be hydrated yet');
    mgr.clear();
});

test('residency', 'ensureResident hydrates from CBREP', () => {
    const mgr = new HandleResidencyManager(registry);
    mgr.storeCbrep(42, cbrepBytes, 12345);
    const handle = mgr.ensureResident(42);
    assert.ok(handle > 0, `should return valid handle, got ${handle}`);
    assert.equal(mgr.getHandle(42), handle);
    mgr.clear();
});

test('residency', 'ensureResident returns same handle on repeat', () => {
    const mgr = new HandleResidencyManager(registry);
    mgr.storeCbrep(42, cbrepBytes);
    const h1 = mgr.ensureResident(42);
    const h2 = mgr.ensureResident(42);
    assert.equal(h1, h2, 'should return same handle');
    mgr.clear();
});

test('residency', 'ensureResident returns 0 for unknown feature', () => {
    const mgr = new HandleResidencyManager(registry);
    assert.equal(mgr.ensureResident(999), 0);
    mgr.clear();
});

test('residency', 'remove releases handle and removes entry', () => {
    const mgr = new HandleResidencyManager(registry);
    mgr.storeCbrep(42, cbrepBytes);
    mgr.ensureResident(42);
    mgr.remove(42);
    assert.ok(!mgr.hasCbrep(42));
    mgr.clear();
});

test('residency', 'evictInactive releases idle handles', () => {
    const mgr = new HandleResidencyManager(registry, { maxIdleMs: 1 });
    mgr.storeCbrep(42, cbrepBytes);
    mgr.ensureResident(42);
    const entry = mgr.diagnostics();
    assert.equal(entry.residentCount, 1);
    // Use negative maxIdleMs so cutoff = Date.now() + 100000 > any lastAccess
    const evicted = mgr.evictInactive(-100000);
    assert.ok(evicted >= 1, `should evict at least 1, got ${evicted}`);
    assert.equal(mgr.getHandle(42), 0, 'handle should be cleared');
    assert.ok(mgr.hasCbrep(42), 'CBREP should still be stored');
    mgr.clear();
});

test('residency', 're-hydration after eviction', () => {
    const mgr = new HandleResidencyManager(registry, { maxIdleMs: 1 });
    mgr.storeCbrep(42, cbrepBytes);
    const h1 = mgr.ensureResident(42);
    // Force eviction by passing a very large maxIdleMs value
    // so cutoff = Date.now() + 100000 > lastAccess
    mgr.evictInactive(-100000);
    assert.equal(mgr.getHandle(42), 0, 'handle should be cleared after eviction');
    const h2 = mgr.ensureResident(42);
    assert.ok(h2 > 0, 'should re-hydrate');
    mgr.clear();
});

test('residency', 'evictLRU keeps maxEntries', () => {
    const mgr = new HandleResidencyManager(registry, { maxEntries: 2 });
    for (let i = 0; i < 4; i++) {
        mgr.storeCbrep(i, cbrepBytes);
        mgr.ensureResident(i);
    }
    const evicted = mgr.evictLRU();
    assert.ok(evicted >= 2, `should evict at least 2, got ${evicted}`);
    mgr.clear();
});

test('residency', 'diagnostics returns correct counts', () => {
    const mgr = new HandleResidencyManager(registry);
    mgr.storeCbrep(1, cbrepBytes);
    mgr.storeCbrep(2, cbrepBytes);
    mgr.ensureResident(1);
    const diag = mgr.diagnostics();
    assert.equal(diag.entryCount, 2);
    assert.equal(diag.residentCount, 1);
    assert.ok(diag.hydrations >= 1);
    mgr.clear();
});

test('residency', 'clear releases all handles', () => {
    const mgr = new HandleResidencyManager(registry);
    mgr.storeCbrep(1, cbrepBytes);
    mgr.storeCbrep(2, cbrepBytes);
    mgr.ensureResident(1);
    mgr.ensureResident(2);
    mgr.clear();
    assert.ok(!mgr.hasCbrep(1));
    assert.ok(!mgr.hasCbrep(2));
});

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Telemetry Extensions ===');

const { telemetry } = await import('../js/telemetry.js');

test('telemetry', 'residency tracking', () => {
    telemetry.reset();
    telemetry.recordResidencyHit();
    telemetry.recordResidencyHit();
    telemetry.recordResidencyMiss();
    telemetry.recordHydration(5.0);
    telemetry.recordEviction(2);
    const rs = telemetry.residencySummary();
    assert.equal(rs.hits, 2);
    assert.equal(rs.misses, 1);
    assert.ok(Math.abs(rs.hitRate - 2 / 3) < 0.001);
    assert.equal(rs.hydrations, 1);
    assert.equal(rs.evictions, 2);
    assert.equal(rs.avgHydrationMs, 5.0);
});

test('telemetry', 'GPU dispatch tracking', () => {
    telemetry.reset();
    telemetry.recordGpuDispatch(10);
    telemetry.recordGpuDispatch(20);
    telemetry.recordGpuUpload(3);
    telemetry.recordGpuReadback(7);
    const gs = telemetry.gpuSummary();
    assert.equal(gs.dispatches, 2);
    assert.equal(gs.avgDispatchMs, 15);
    assert.equal(gs.totalUploadMs, 3);
    assert.equal(gs.totalReadbackMs, 7);
});

test('telemetry', 'summary includes residency and gpu', () => {
    telemetry.reset();
    telemetry.recordResidencyHit();
    telemetry.recordGpuDispatch(5);
    const s = telemetry.summary();
    assert.ok(s.residency, 'summary should have residency');
    assert.ok(s.gpu, 'summary should have gpu');
    assert.equal(s.residency.hits, 1);
    assert.equal(s.gpu.dispatches, 1);
});

test('telemetry', 'reset clears residency and gpu', () => {
    telemetry.recordResidencyHit();
    telemetry.recordGpuDispatch(5);
    telemetry.reset();
    const rs = telemetry.residencySummary();
    const gs = telemetry.gpuSummary();
    assert.equal(rs.hits, 0);
    assert.equal(gs.dispatches, 0);
});

// ═══════════════════════════════════════════════════════════════════════
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f}`));
}
process.exit(failed > 0 ? 1 : 0);

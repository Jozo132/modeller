// tests/test-wasm-brep-kernel.js — Foundation tests for the WASM B-Rep kernel
//
// Tests handle lifecycle, topology construction, transform correctness,
// octree pair queries, CBREP round-trip, and GPU batch packing.

import assert from 'assert';
import { formatTimingSuffix, startTiming } from './test-timing.js';

// Load WASM module (top-level await)
const wasm = await import('../build/release.js');

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
        if (err.stack) console.log(`    ${err.stack.split('\n').slice(1, 3).join('\n    ')}`);
        failed++;
    }
}

// ===========================================================================
// Handle Registry
// ===========================================================================
console.log('\n=== Handle Registry ===');

test('handleAlloc returns non-zero handle', () => {
    wasm.handleReleaseAll();
    const h = wasm.handleAlloc();
    assert.ok(h !== 0, 'handle should not be HANDLE_NONE');
    assert.strictEqual(wasm.handleIsValid(h), true);
    wasm.handleRelease(h);
});

test('handleRelease disposes handle', () => {
    wasm.handleReleaseAll();
    const h = wasm.handleAlloc();
    wasm.handleRelease(h);
    assert.strictEqual(wasm.handleIsValid(h), false);
});

test('handleAddRef keeps handle alive', () => {
    wasm.handleReleaseAll();
    const h = wasm.handleAlloc();
    wasm.handleAddRef(h);
    assert.strictEqual(wasm.handleGetRefCount(h), 2);
    wasm.handleRelease(h);
    assert.strictEqual(wasm.handleIsValid(h), true, 'still alive after first release');
    wasm.handleRelease(h);
    assert.strictEqual(wasm.handleIsValid(h), false, 'disposed after second release');
});

test('handleLiveCount tracks allocations', () => {
    wasm.handleReleaseAll();
    assert.strictEqual(wasm.handleLiveCount(), 0);
    const h1 = wasm.handleAlloc();
    const h2 = wasm.handleAlloc();
    assert.strictEqual(wasm.handleLiveCount(), 2);
    wasm.handleRelease(h1);
    assert.strictEqual(wasm.handleLiveCount(), 1);
    wasm.handleRelease(h2);
    assert.strictEqual(wasm.handleLiveCount(), 0);
});

test('residency state round-trip', () => {
    wasm.handleReleaseAll();
    const h = wasm.handleAlloc();
    assert.strictEqual(wasm.handleGetResidency(h), 0); // UNMATERIALIZED
    wasm.handleSetResidency(h, 2); // RESIDENT
    assert.strictEqual(wasm.handleGetResidency(h), 2);
    wasm.handleRelease(h);
});

test('revision bumps are monotonic', () => {
    wasm.handleReleaseAll();
    const h = wasm.handleAlloc();
    const r0 = wasm.handleGetRevision(h);
    wasm.handleBumpRevision(h);
    const r1 = wasm.handleGetRevision(h);
    assert.ok(r1 > r0, `revision should increase: ${r0} -> ${r1}`);
    wasm.handleBumpRevision(h);
    const r2 = wasm.handleGetRevision(h);
    assert.ok(r2 > r1, `revision should increase: ${r1} -> ${r2}`);
    wasm.handleRelease(h);
});

test('featureId and irHash storage', () => {
    wasm.handleReleaseAll();
    const h = wasm.handleAlloc();
    wasm.handleSetFeatureId(h, 42);
    wasm.handleSetIrHash(h, 0xDEADBEEF);
    assert.strictEqual(wasm.handleGetFeatureId(h), 42);
    assert.strictEqual(wasm.handleGetIrHash(h), 0xDEADBEEF);
    wasm.handleRelease(h);
});

test('handleReleaseAll clears everything', () => {
    const h1 = wasm.handleAlloc();
    const h2 = wasm.handleAlloc();
    wasm.handleReleaseAll();
    assert.strictEqual(wasm.handleLiveCount(), 0);
    assert.strictEqual(wasm.handleIsValid(h1), false);
    assert.strictEqual(wasm.handleIsValid(h2), false);
});

// ===========================================================================
// Topology
// ===========================================================================
console.log('\n=== Topology ===');

test('vertexAdd and getters', () => {
    wasm.bodyBegin();
    const v0 = wasm.vertexAdd(1.0, 2.0, 3.0);
    const v1 = wasm.vertexAdd(4.0, 5.0, 6.0);
    assert.strictEqual(v0, 0);
    assert.strictEqual(v1, 1);
    assert.strictEqual(wasm.vertexGetX(v0), 1.0);
    assert.strictEqual(wasm.vertexGetY(v0), 2.0);
    assert.strictEqual(wasm.vertexGetZ(v0), 3.0);
    assert.strictEqual(wasm.vertexGetX(v1), 4.0);
    assert.strictEqual(wasm.vertexGetCount(), 2);
});

test('edge, coedge, loop, face, shell construction', () => {
    wasm.bodyBegin();
    // Create a minimal quad face: 4 vertices, 4 edges, 4 coedges, 1 loop, 1 face, 1 shell
    const v0 = wasm.vertexAdd(0, 0, 0);
    const v1 = wasm.vertexAdd(1, 0, 0);
    const v2 = wasm.vertexAdd(1, 1, 0);
    const v3 = wasm.vertexAdd(0, 1, 0);

    // Geometry offset 0 = no geometry (using GEOM_LINE = 7)
    const e0 = wasm.edgeAdd(v0, v1, 7, 0);
    const e1 = wasm.edgeAdd(v1, v2, 7, 0);
    const e2 = wasm.edgeAdd(v2, v3, 7, 0);
    const e3 = wasm.edgeAdd(v3, v0, 7, 0);
    assert.strictEqual(wasm.edgeGetCount(), 4);

    // CoEdges: forward orientation (1), initially linked to themselves
    const ce0 = wasm.coedgeAdd(e0, 1, 0, 0);
    const ce1 = wasm.coedgeAdd(e1, 1, 0, 0);
    const ce2 = wasm.coedgeAdd(e2, 1, 0, 0);
    const ce3 = wasm.coedgeAdd(e3, 1, 0, 0);

    // Link coedges into a ring
    wasm.coedgeSetNext(ce0, ce1);
    wasm.coedgeSetNext(ce1, ce2);
    wasm.coedgeSetNext(ce2, ce3);
    wasm.coedgeSetNext(ce3, ce0);

    const loop0 = wasm.loopAdd(ce0, 0, 1); // face 0, outer
    const face0 = wasm.faceAdd(loop0, 0, 1, 0, 1, 1); // shell 0, GEOM_PLANE, forward, 1 loop
    const shell0 = wasm.shellAdd(face0, 1, 0); // 1 face, not closed (single face)

    assert.strictEqual(wasm.coedgeGetCount(), 4);
    assert.strictEqual(wasm.loopGetCount(), 1);
    assert.strictEqual(wasm.faceGetCount(), 1);
    assert.strictEqual(wasm.shellGetCount(), 1);

    // Verify connectivity
    assert.strictEqual(wasm.coedgeGetNext(ce0), ce1);
    assert.strictEqual(wasm.loopGetFirstCoedge(loop0), ce0);
    assert.strictEqual(wasm.faceGetFirstLoop(face0), loop0);
    assert.strictEqual(wasm.shellGetFirstFace(shell0), face0);
});

test('vertex coords pointer returns valid typed array view', () => {
    wasm.bodyBegin();
    wasm.vertexAdd(10, 20, 30);
    wasm.vertexAdd(40, 50, 60);
    const ptr = wasm.getVertexCoordsPtr();
    assert.ok(ptr > 0, 'pointer should be non-zero');
    const view = new Float64Array(wasm.memory.buffer, ptr, 6);
    assert.strictEqual(view[0], 10);
    assert.strictEqual(view[1], 20);
    assert.strictEqual(view[2], 30);
    assert.strictEqual(view[3], 40);
    assert.strictEqual(view[4], 50);
    assert.strictEqual(view[5], 60);
});

// ===========================================================================
// Geometry Pool
// ===========================================================================
console.log('\n=== Geometry Pool ===');

test('planeStore and read-back', () => {
    wasm.geomPoolReset();
    const offset = wasm.planeStore(
        0, 0, 0,    // origin
        0, 0, 1,    // normal
        1, 0, 0     // refDir
    );
    assert.strictEqual(offset, 0);
    assert.strictEqual(wasm.geomPoolUsed(), 9);
    // Read back origin Z
    assert.strictEqual(wasm.geomPoolRead(2), 0);
    // Read back normal Z
    assert.strictEqual(wasm.geomPoolRead(5), 1);
});

test('cylinderStore uses expected slot count', () => {
    wasm.geomPoolReset();
    const offset = wasm.cylinderStore(
        0, 0, 0,    // origin
        0, 0, 1,    // axis
        1, 0, 0,    // refDir
        5.0         // radius
    );
    assert.strictEqual(offset, 0);
    assert.strictEqual(wasm.geomPoolUsed(), 10);
    // Radius is the last slot
    assert.strictEqual(wasm.geomPoolRead(9), 5.0);
});

test('sphereStore uses 10 slots', () => {
    wasm.geomPoolReset();
    const offset = wasm.sphereStore(1, 2, 3, 0, 0, 1, 1, 0, 0, 7.5);
    assert.strictEqual(wasm.geomPoolUsed(), 10);
    assert.strictEqual(wasm.geomPoolRead(9), 7.5);
});

test('geomPoolReset clears usage', () => {
    wasm.geomPoolReset();
    wasm.planeStore(0, 0, 0, 0, 0, 1, 1, 0, 0);
    assert.ok(wasm.geomPoolUsed() > 0);
    wasm.geomPoolReset();
    assert.strictEqual(wasm.geomPoolUsed(), 0);
});

// ===========================================================================
// Transforms
// ===========================================================================
console.log('\n=== Transforms ===');

test('transformIdentity produces identity matrix', () => {
    wasm.transformIdentity();
    const ptr = wasm.getTransformOutMatPtr();
    const mat = new Float64Array(wasm.memory.buffer, ptr, 16);
    // Column-major identity
    for (let i = 0; i < 16; i++) {
        const expected = (i % 5 === 0) ? 1.0 : 0.0;
        assert.strictEqual(mat[i], expected, `mat[${i}] should be ${expected}`);
    }
});

test('transformTranslation produces correct matrix', () => {
    wasm.transformTranslation(10, 20, 30);
    const ptr = wasm.getTransformOutMatPtr();
    const mat = new Float64Array(wasm.memory.buffer, ptr, 16);
    // Column-major: translation is in elements 12, 13, 14
    assert.strictEqual(mat[12], 10);
    assert.strictEqual(mat[13], 20);
    assert.strictEqual(mat[14], 30);
    assert.strictEqual(mat[15], 1);
    // Diagonal should be 1
    assert.strictEqual(mat[0], 1);
    assert.strictEqual(mat[5], 1);
    assert.strictEqual(mat[10], 1);
});

test('transformPointByOutMat applies translation', () => {
    // Set up a translation matrix in outMat
    wasm.transformTranslation(5, 10, 15);
    // Transform point (1, 2, 3) using the matrix currently in outMat
    wasm.transformPointByOutMat(1, 2, 3);
    const ptPtr = wasm.getTransformOutPtPtr();
    const pt = new Float64Array(wasm.memory.buffer, ptPtr, 3);
    assert.strictEqual(pt[0], 6);   // 1 + 5
    assert.strictEqual(pt[1], 12);  // 2 + 10
    assert.strictEqual(pt[2], 18);  // 3 + 15
});

test('transformScale produces diagonal matrix', () => {
    wasm.transformScale(2, 3, 4);
    const ptr = wasm.getTransformOutMatPtr();
    const mat = new Float64Array(wasm.memory.buffer, ptr, 16);
    assert.strictEqual(mat[0], 2);
    assert.strictEqual(mat[5], 3);
    assert.strictEqual(mat[10], 4);
    assert.strictEqual(mat[15], 1);
});

// ===========================================================================
// Octree Broadphase
// ===========================================================================
console.log('\n=== Octree Broadphase ===');

test('octree with non-overlapping faces returns 0 pairs', () => {
    wasm.octreeReset();
    // Body A: face 0 at (0,0,0)-(1,1,1)
    wasm.octreeAddFaceAABB(0, 0, 0, 0, 1, 1, 1);
    // Body B: face 1 at (10,10,10)-(11,11,11) — far away
    wasm.octreeAddFaceAABB(1, 10, 10, 10, 11, 11, 11);
    wasm.octreeBuild();
    wasm.octreeQueryPairs(0, 1, 1, 2);
    assert.strictEqual(wasm.octreeGetPairCount(), 0);
});

test('octree with overlapping faces returns pairs', () => {
    wasm.octreeReset();
    // Body A: face 0 at (0,0,0)-(2,2,2)
    wasm.octreeAddFaceAABB(0, 0, 0, 0, 2, 2, 2);
    // Body B: face 1 at (1,1,1)-(3,3,3) — overlaps with face 0
    wasm.octreeAddFaceAABB(1, 1, 1, 1, 3, 3, 3);
    wasm.octreeBuild();
    wasm.octreeQueryPairs(0, 1, 1, 2);
    const pairCount = wasm.octreeGetPairCount();
    assert.ok(pairCount > 0, `expected pairs, got ${pairCount}`);

    // Verify pair data
    const pairsPtr = wasm.getOctreePairsPtr();
    const pairs = new Uint32Array(wasm.memory.buffer, pairsPtr, pairCount * 2);
    // Should contain pair (0, 1)
    let found = false;
    for (let i = 0; i < pairCount; i++) {
        if ((pairs[i * 2] === 0 && pairs[i * 2 + 1] === 1) ||
            (pairs[i * 2] === 1 && pairs[i * 2 + 1] === 0)) {
            found = true;
            break;
        }
    }
    assert.ok(found, 'expected pair (0,1) in results');
});

test('octree with many faces builds without overflow', () => {
    wasm.octreeReset();
    // Add 100 faces in a grid
    for (let i = 0; i < 100; i++) {
        const x = (i % 10) * 2;
        const y = Math.floor(i / 10) * 2;
        wasm.octreeAddFaceAABB(i, x, y, 0, x + 1, y + 1, 1);
    }
    wasm.octreeBuild();
    const nodeCount = wasm.octreeGetNodeCount();
    assert.ok(nodeCount > 0, `octree should have nodes: ${nodeCount}`);
});

// ===========================================================================
// GPU Batch
// ===========================================================================
console.log('\n=== GPU Batch ===');

test('gpuBatchReset clears surface count', () => {
    wasm.gpuBatchReset();
    assert.strictEqual(wasm.getGpuSurfaceCount(), 0);
});

test('getGpuHeaderBufPtr returns valid pointer', () => {
    const ptr = wasm.getGpuHeaderBufPtr();
    assert.ok(ptr > 0);
});

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\n=== Results ===\n\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

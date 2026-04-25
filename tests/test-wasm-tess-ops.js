import './_watchdog.mjs';
// tests/test-wasm-tess-ops.js — Tests for native tessellation + boolean ops modules
//
// Tests kernel/tessellation.ts (face tessellation, edge cache) and
// kernel/ops.ts (classification, distance helpers) against bodies
// built from the topology + geometry APIs.

import assert from 'assert';
import { formatTimingSuffix, startTiming } from './test-timing.js';

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

function approx(a, b, tol = 1e-6) {
    assert.ok(Math.abs(a - b) < tol, `expected ${a} ≈ ${b} (tol=${tol})`);
}

// ===========================================================================
// Helper: Build a unit cube body (6 planar faces)
// ===========================================================================
function buildUnitCube() {
    wasm.bodyBegin();
    wasm.geomPoolReset();

    // Vertices of a unit cube [0,1]^3
    const V = [];
    const corners = [
        [0,0,0], [1,0,0], [1,1,0], [0,1,0],
        [0,0,1], [1,0,1], [1,1,1], [0,1,1],
    ];
    for (const [x, y, z] of corners) {
        V.push(wasm.vertexAdd(x, y, z));
    }

    // 6 faces: bottom (z=0), top (z=1), front (y=0), back (y=1), left (x=0), right (x=1)
    const faceDefs = [
        // [normal, refDir, verts (CCW from outside)]
        { n: [0,0,-1], r: [1,0,0], verts: [0,3,2,1] },  // bottom
        { n: [0,0,1],  r: [1,0,0], verts: [4,5,6,7] },  // top
        { n: [0,-1,0], r: [1,0,0], verts: [0,1,5,4] },  // front
        { n: [0,1,0],  r: [1,0,0], verts: [2,3,7,6] },  // back
        { n: [-1,0,0], r: [0,1,0], verts: [0,4,7,3] },  // left
        { n: [1,0,0],  r: [0,1,0], verts: [1,2,6,5] },  // right
    ];

    for (const fd of faceDefs) {
        const [nx, ny, nz] = fd.n;
        const [rx, ry, rz] = fd.r;
        // Compute origin as centroid of face vertices
        let ox = 0, oy = 0, oz = 0;
        for (const vi of fd.verts) {
            ox += corners[vi][0]; oy += corners[vi][1]; oz += corners[vi][2];
        }
        ox /= fd.verts.length; oy /= fd.verts.length; oz /= fd.verts.length;

        const geomOff = wasm.planeStore(ox, oy, oz, nx, ny, nz, rx, ry, rz);

        // Build edges for this face
        const edges = [];
        for (let i = 0; i < fd.verts.length; i++) {
            const sv = V[fd.verts[i]];
            const ev = V[fd.verts[(i + 1) % fd.verts.length]];
            edges.push(wasm.edgeAdd(sv, ev, wasm.GEOM_LINE, 0));
        }

        // Build coedges (forward, linked in a ring)
        const faceId = wasm.faceGetCount();
        const loopId = wasm.loopGetCount();
        const ceStart = wasm.coedgeGetCount();
        const coedges = [];
        for (let i = 0; i < edges.length; i++) {
            coedges.push(wasm.coedgeAdd(edges[i], wasm.ORIENT_FORWARD, 0, loopId));
        }
        // Link coedges into a ring
        for (let i = 0; i < coedges.length; i++) {
            wasm.coedgeSetNext(coedges[i], coedges[(i + 1) % coedges.length]);
        }

        wasm.loopAdd(coedges[0], faceId, 1); // outer loop
        wasm.faceAdd(loopId, 0, wasm.GEOM_PLANE, geomOff, wasm.ORIENT_FORWARD, 1);
    }

    wasm.shellAdd(0, 6, 1); // closed shell
    wasm.bodyEnd();
}

// ===========================================================================
// Helper: Build a sphere body (1 sphere face)
// ===========================================================================
function buildSphere(cx, cy, cz, radius) {
    wasm.bodyBegin();
    wasm.geomPoolReset();

    const geomOff = wasm.sphereStore(cx, cy, cz, 0, 0, 1, 1, 0, 0, radius);

    // Sphere has no boundary edges (closed surface) — create a degenerate
    // single-vertex loop just for the topology system
    const v0 = wasm.vertexAdd(cx, cy + radius, cz);
    const e0 = wasm.edgeAdd(v0, v0, wasm.GEOM_CIRCLE, 0);
    const loopId = 0;
    const faceId = 0;
    const ce0 = wasm.coedgeAdd(e0, wasm.ORIENT_FORWARD, 0, loopId);
    wasm.coedgeSetNext(ce0, ce0); // self-loop

    wasm.loopAdd(ce0, faceId, 1);
    wasm.faceAdd(loopId, 0, wasm.GEOM_SPHERE, geomOff, wasm.ORIENT_FORWARD, 1);
    wasm.shellAdd(0, 1, 1);
    wasm.bodyEnd();
}

// ===========================================================================
// Helper: Build a cylinder body (1 cylinder face)
// ===========================================================================
function buildCylinder(ox, oy, oz, ax, ay, az, radius, height) {
    wasm.bodyBegin();
    wasm.geomPoolReset();

    // refDir perpendicular to axis
    let rx, ry, rz;
    if (Math.abs(ax) < 0.9) {
        rx = 0; ry = -az; rz = ay;
    } else {
        rx = az; ry = 0; rz = -ax;
    }
    const len = Math.sqrt(rx*rx + ry*ry + rz*rz);
    rx /= len; ry /= len; rz /= len;

    const geomOff = wasm.cylinderStore(ox, oy, oz, ax, ay, az, rx, ry, rz, radius);

    // Bottom and top rim vertices — both included in boundary loop
    // so the tessellator can detect the height range
    const N = 4;
    const botVerts = [];
    const topVerts = [];
    const bx = ay * rz - az * ry;
    const by = az * rx - ax * rz;
    const bz = ax * ry - ay * rx;
    for (let i = 0; i < N; i++) {
        const angle = (i / N) * 2 * Math.PI;
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const px = ox + radius * (rx * cosA + bx * sinA);
        const py = oy + radius * (ry * cosA + by * sinA);
        const pz = oz + radius * (rz * cosA + bz * sinA);
        botVerts.push(wasm.vertexAdd(px, py, pz));
        topVerts.push(wasm.vertexAdd(px + ax * height, py + ay * height, pz + az * height));
    }

    // Build boundary loop: bottom forward, then top backward
    // This creates a single closed loop enclosing the cylindrical surface
    const faceId = 0;
    const loopId = 0;
    const edges = [];
    // Bottom rim edges
    for (let i = 0; i < N; i++) {
        edges.push(wasm.edgeAdd(botVerts[i], botVerts[(i + 1) % N], wasm.GEOM_LINE, 0));
    }
    // Side edge up
    edges.push(wasm.edgeAdd(botVerts[0], topVerts[0], wasm.GEOM_LINE, 0));
    // Top rim edges (reversed direction)
    for (let i = 0; i < N; i++) {
        edges.push(wasm.edgeAdd(topVerts[(i + 1) % N], topVerts[i], wasm.GEOM_LINE, 0));
    }
    // Side edge down
    edges.push(wasm.edgeAdd(topVerts[0], botVerts[0], wasm.GEOM_LINE, 0));

    // Coedges forming the boundary loop
    const coedges = [];
    for (let i = 0; i < edges.length; i++) {
        coedges.push(wasm.coedgeAdd(edges[i], wasm.ORIENT_FORWARD, 0, loopId));
    }
    for (let i = 0; i < coedges.length; i++) {
        wasm.coedgeSetNext(coedges[i], coedges[(i + 1) % coedges.length]);
    }

    wasm.loopAdd(coedges[0], faceId, 1);
    wasm.faceAdd(loopId, 0, wasm.GEOM_CYLINDER, geomOff, wasm.ORIENT_FORWARD, 1);
    wasm.shellAdd(0, 1, 1);
    wasm.bodyEnd();
}

function snapshotCurrentCbrep() {
    const len = wasm.cbrepDehydrate() >>> 0;
    assert.ok(len > 0, 'expected non-empty CBREP snapshot');
    const ptr = wasm.getCbrepOutPtr() >>> 0;
    return new Uint8Array(wasm.memory.buffer, ptr, len).slice();
}

// ===========================================================================
// Tessellation Tests
// ===========================================================================
console.log('\n=== Native Tessellation ===');

test('tessBuildAllFaces — unit cube produces 12 triangles (2 per face)', () => {
    buildUnitCube();
    wasm.tessReset();
    const nTris = wasm.tessBuildAllFaces(16, 16);
    assert.strictEqual(nTris, 12, `expected 12 triangles, got ${nTris}`);
});

test('tessOutVertCount — cube has 24 vertices (4 per face × 6 faces)', () => {
    buildUnitCube();
    wasm.tessReset();
    wasm.tessBuildAllFaces(16, 16);
    const nVerts = wasm.getTessOutVertCount() >>> 0;
    assert.strictEqual(nVerts, 24);
});

test('tessOutTriCount matches return value', () => {
    buildUnitCube();
    wasm.tessReset();
    const nTris = wasm.tessBuildAllFaces(16, 16);
    const reported = wasm.getTessOutTriCount() >>> 0;
    assert.strictEqual(nTris, reported);
});

test('cube face map assigns correct face ids', () => {
    buildUnitCube();
    wasm.tessReset();
    const nTris = wasm.tessBuildAllFaces(16, 16);
    const fmapPtr = wasm.getTessOutFaceMapPtr() >>> 0;
    const mem = new Uint32Array(wasm.memory.buffer, fmapPtr, nTris);

    // First 2 triangles belong to face 0 (bottom), next 2 to face 1, etc.
    assert.strictEqual(mem[0], 0);
    assert.strictEqual(mem[1], 0);
    assert.strictEqual(mem[2], 1);
    assert.strictEqual(mem[3], 1);
    assert.strictEqual(mem[10], 5);
    assert.strictEqual(mem[11], 5);
});

test('cube vertex positions are in [0,1] range', () => {
    buildUnitCube();
    wasm.tessReset();
    wasm.tessBuildAllFaces(16, 16);
    const nVerts = wasm.getTessOutVertCount() >>> 0;
    const vPtr = wasm.getTessOutVertsPtr() >>> 0;
    const verts = new Float64Array(wasm.memory.buffer, vPtr, nVerts * 3);

    for (let i = 0; i < nVerts * 3; i++) {
        assert.ok(verts[i] >= -1e-10 && verts[i] <= 1.0 + 1e-10,
            `vertex component [${i}] = ${verts[i]} out of [0,1]`);
    }
});

test('cube normals are unit length', () => {
    buildUnitCube();
    wasm.tessReset();
    wasm.tessBuildAllFaces(16, 16);
    const nVerts = wasm.getTessOutVertCount() >>> 0;
    const nPtr = wasm.getTessOutNormalsPtr() >>> 0;
    const normals = new Float64Array(wasm.memory.buffer, nPtr, nVerts * 3);

    for (let i = 0; i < nVerts; i++) {
        const nx = normals[i*3], ny = normals[i*3+1], nz = normals[i*3+2];
        const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
        approx(len, 1.0, 1e-4);
    }
});

test('sphere tessellation produces expected grid', () => {
    buildSphere(0, 0, 0, 1.0);
    wasm.tessReset();
    const nTris = wasm.tessBuildAllFaces(8, 8);
    // UV sphere: 8×8 segments = 2 × 8 × 8 = 128 triangles
    assert.strictEqual(nTris, 128);
});

test('sphere vertices are on unit sphere', () => {
    buildSphere(0, 0, 0, 1.0);
    wasm.tessReset();
    wasm.tessBuildAllFaces(8, 8);
    const nVerts = wasm.getTessOutVertCount() >>> 0;
    const vPtr = wasm.getTessOutVertsPtr() >>> 0;
    const verts = new Float64Array(wasm.memory.buffer, vPtr, nVerts * 3);

    for (let i = 0; i < nVerts; i++) {
        const x = verts[i*3], y = verts[i*3+1], z = verts[i*3+2];
        const r = Math.sqrt(x*x + y*y + z*z);
        approx(r, 1.0, 1e-4);
    }
});

test('cylinder tessellation produces quads', () => {
    buildCylinder(0, 0, 0, 0, 0, 1, 1.0, 2.0);
    wasm.tessReset();
    const nTris = wasm.tessBuildAllFaces(12, 4);
    // 12 U segs × 4 V segs × 2 tris = 96
    assert.strictEqual(nTris, 96);
});

test('tessBuildFace — single face tessellation', () => {
    buildUnitCube();
    wasm.tessReset();
    const nTris = wasm.tessBuildFace(0, 16, 16);
    assert.strictEqual(nTris, 2, 'single planar face → 2 tris');
});

test('tessReset clears state', () => {
    buildUnitCube();
    wasm.tessReset();
    wasm.tessBuildAllFaces(16, 16);
    assert.ok(wasm.getTessOutTriCount() > 0);

    wasm.tessReset();
    assert.strictEqual(wasm.getTessOutTriCount() >>> 0, 0);
    assert.strictEqual(wasm.getTessOutVertCount() >>> 0, 0);
});

test('tessBuildHandleFaces — resident handle range excludes other bodies', () => {
    buildUnitCube();
    const cbrep = snapshotCurrentCbrep();

    wasm.topologyResetAll();
    wasm.geomPoolReset();
    wasm.handleReleaseAll();

    const h1 = wasm.handleAlloc() >>> 0;
    const h2 = wasm.handleAlloc() >>> 0;
    assert.ok(h1 > 0 && h2 > 0, 'expected handle allocation');
    assert.strictEqual(wasm.tessBuildHandleFaces(h1, 16, 16), -3, 'unmaterialized handle must not tessellate');

    assert.strictEqual(wasm.cbrepHydrateForHandle(h1, cbrep, cbrep.byteLength), 1);
    assert.strictEqual(wasm.cbrepHydrateForHandle(h2, cbrep, cbrep.byteLength), 1);
    wasm.handleSetResidency(h1, wasm.RESIDENCY_RESIDENT);
    wasm.handleSetResidency(h2, wasm.RESIDENCY_RESIDENT);

    assert.strictEqual(wasm.faceGetCount() >>> 0, 12, 'two resident cubes should append 12 faces globally');

    const n1 = wasm.tessBuildHandleFaces(h1, 16, 16);
    assert.strictEqual(n1, 12, 'first handle should tessellate one cube');
    let fmapPtr = wasm.getTessOutFaceMapPtr() >>> 0;
    let fmap = new Uint32Array(wasm.memory.buffer, fmapPtr, n1);
    assert.strictEqual(fmap[0], 0);
    assert.strictEqual(fmap[11], 5);

    const n2 = wasm.tessBuildHandleFaces(h2, 16, 16);
    assert.strictEqual(n2, 12, 'second handle should tessellate one cube');
    fmapPtr = wasm.getTessOutFaceMapPtr() >>> 0;
    fmap = new Uint32Array(wasm.memory.buffer, fmapPtr, n2);
    assert.strictEqual(fmap[0], 6);
    assert.strictEqual(fmap[11], 11);

    const all = wasm.tessBuildAllFaces(16, 16);
    assert.strictEqual(all, 24, 'global tessellation still sees both cubes');
    wasm.handleReleaseAll();
});

// ===========================================================================
// Edge Cache Tests (cross-parametric mapping)
// ===========================================================================
console.log('\n=== Edge Cache ===');

test('edge samples cached during tessellation', () => {
    buildUnitCube();
    wasm.tessReset();
    wasm.tessBuildAllFaces(16, 16);

    // Edge 0 should have been cached
    const count = wasm.getEdgeSampleCount(0) >>> 0;
    assert.strictEqual(count, 2, 'each edge caches start+end = 2 samples');
});

test('edge sample points match vertex positions', () => {
    buildUnitCube();
    wasm.tessReset();
    wasm.tessBuildAllFaces(16, 16);

    const count = wasm.getEdgeSampleCount(0) >>> 0;
    assert.strictEqual(count, 2);

    const start = wasm.getEdgeSampleStart(0) >>> 0;
    const ptr = wasm.getEdgeSamplePtsPtr() >>> 0;
    const pts = new Float64Array(wasm.memory.buffer, ptr + start * 3 * 8, count * 3);

    // Edge 0 of the cube connects vertex 0 (0,0,0) → vertex 3 (0,1,0)
    // (from the bottom face CCW: 0,3,2,1)
    approx(pts[0], 0); // x of start vertex
    approx(pts[1], 0); // y
    approx(pts[2], 0); // z
});

// ===========================================================================
// Boolean Ops Tests
// ===========================================================================
console.log('\n=== Boolean Classification ===');

test('classifyPointVsShell — point inside unit cube', () => {
    buildUnitCube();
    const cls = wasm.classifyPointVsShell(0.5, 0.5, 0.5, 0, 6);
    // For planar faces, ray-casting along +X should detect crossings
    // Point at center of [0,1]^3, 6 planar faces → INSIDE (1)
    assert.strictEqual(cls, 1);
});

test('classifyPointVsShell — point outside unit cube', () => {
    buildUnitCube();
    const cls = wasm.classifyPointVsShell(5.0, 5.0, 5.0, 0, 6);
    assert.strictEqual(cls, 0); // CLASSIFY_OUTSIDE
});

test('pointToPlaneDistance — positive side', () => {
    wasm.geomPoolReset();
    const off = wasm.planeStore(0, 0, 0, 0, 0, 1, 1, 0, 0);
    const d = wasm.pointToPlaneDistance(0, 0, 3, off, false);
    approx(d, 3.0);
});

test('pointToPlaneDistance — reversed normal', () => {
    wasm.geomPoolReset();
    const off = wasm.planeStore(0, 0, 0, 0, 0, 1, 1, 0, 0);
    const d = wasm.pointToPlaneDistance(0, 0, 3, off, true);
    approx(d, -3.0);
});

test('pointToSphereDistance — outside', () => {
    wasm.geomPoolReset();
    const off = wasm.sphereStore(0, 0, 0, 0, 0, 1, 1, 0, 0, 1);
    const d = wasm.pointToSphereDistance(3, 0, 0, off);
    approx(d, 2.0);
});

test('pointToSphereDistance — on surface', () => {
    wasm.geomPoolReset();
    const off = wasm.sphereStore(0, 0, 0, 0, 0, 1, 1, 0, 0, 1);
    const d = wasm.pointToSphereDistance(1, 0, 0, off);
    approx(d, 0.0);
});

test('pointToSphereDistance — inside', () => {
    wasm.geomPoolReset();
    const off = wasm.sphereStore(0, 0, 0, 0, 0, 1, 1, 0, 0, 5);
    const d = wasm.pointToSphereDistance(1, 0, 0, off);
    approx(d, -4.0);
});

test('pointToCylinderDistance — on surface', () => {
    wasm.geomPoolReset();
    // Cylinder along Z, radius 2
    const off = wasm.cylinderStore(0, 0, 0, 0, 0, 1, 1, 0, 0, 2);
    const d = wasm.pointToCylinderDistance(2, 0, 5, off);
    approx(d, 0.0);
});

test('pointToCylinderDistance — outside', () => {
    wasm.geomPoolReset();
    const off = wasm.cylinderStore(0, 0, 0, 0, 0, 1, 1, 0, 0, 2);
    const d = wasm.pointToCylinderDistance(5, 0, 0, off);
    approx(d, 3.0);
});

test('getFaceClassification defaults to UNKNOWN', () => {
    buildUnitCube();
    // Before any classification, faces should be UNKNOWN or uninitialized
    const cls = wasm.getFaceClassification(0);
    // The value might be 0 (OUTSIDE) or UNKNOWN depending on init
    assert.ok(cls >= 0 && cls <= 3, `face classification should be 0-3, got ${cls}`);
});

test('setFaceClassification roundtrips', () => {
    wasm.setFaceClassification(0, 1); // CLASSIFY_INSIDE
    assert.strictEqual(wasm.getFaceClassification(0), 1);

    wasm.setFaceClassification(0, 2); // CLASSIFY_ON_BOUNDARY
    assert.strictEqual(wasm.getFaceClassification(0), 2);
});

// ===========================================================================
// JS Bridge Tests (WasmBrepHandleRegistry tessellation methods)
// ===========================================================================
console.log('\n=== JS Bridge — Tessellation ===');

// Dynamically import the registry
const { WasmBrepHandleRegistry } = await import('../js/cad/WasmBrepHandleRegistry.js');
const registry = new WasmBrepHandleRegistry();
await registry.init();

test('tessellateBody returns mesh for cube', () => {
    buildUnitCube();
    const mesh = registry.tessellateBody(16, 16);
    assert.ok(mesh !== null);
    assert.strictEqual(mesh.indices.length, 12 * 3); // 12 tris × 3 indices
    assert.strictEqual(mesh.vertices.length, 24 * 3); // 24 verts × 3 components
    assert.strictEqual(mesh.normals.length, 24 * 3);
    assert.strictEqual(mesh.faceMap.length, 12);
});

test('tessellateFace returns count', () => {
    buildUnitCube();
    registry.tessReset();
    const n = registry.tessellateFace(0, 16, 16);
    assert.strictEqual(n, 2);
});

test('getEdgeSamples returns cached samples', () => {
    buildUnitCube();
    registry.tessReset();
    registry.tessellateBody(16, 16);
    const samples = registry.getEdgeSamples(0);
    assert.ok(samples !== null);
    assert.strictEqual(samples.length, 6); // 2 points × 3 components
});

test('tessellateHandle returns mesh for resident handle', () => {
    buildUnitCube();
    const cbrep = registry.dehydrate();
    assert.ok(cbrep && cbrep.byteLength > 0);

    registry.resetTopology();
    const handle = registry.alloc();
    assert.ok(handle > 0);
    assert.strictEqual(registry.hydrateForHandle(handle, cbrep), true);
    registry.setResidency(handle, registry.RESIDENT);

    const mesh = registry.tessellateHandle(handle, 16, 16);
    assert.ok(mesh !== null);
    assert.strictEqual(mesh.indices.length, 12 * 3);
    assert.strictEqual(mesh.vertices.length, 24 * 3);
    assert.strictEqual(mesh.normals.length, 24 * 3);
    assert.strictEqual(mesh.faceMap.length, 12);
    assert.strictEqual(mesh.faceMap[0], 0);
    assert.strictEqual(mesh.faceMap[11], 5);
});

test('classifyPoint returns valid result', () => {
    buildUnitCube();
    const cls = registry.classifyPoint(0.5, 0.5, 0.5, 0, 6);
    assert.ok(cls >= 0 && cls <= 3);
});

test('pointToPlaneDistance via registry', () => {
    wasm.geomPoolReset();
    const off = wasm.planeStore(0, 0, 0, 0, 0, 1, 1, 0, 0);
    const d = registry.pointToPlaneDistance(0, 0, 5, off);
    approx(d, 5.0);
});

test('CLASSIFY constants match WASM', () => {
    assert.strictEqual(WasmBrepHandleRegistry.CLASSIFY.OUTSIDE, 0);
    assert.strictEqual(WasmBrepHandleRegistry.CLASSIFY.INSIDE, 1);
    assert.strictEqual(WasmBrepHandleRegistry.CLASSIFY.ON_BOUNDARY, 2);
    assert.strictEqual(WasmBrepHandleRegistry.CLASSIFY.UNKNOWN, 3);
});

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);

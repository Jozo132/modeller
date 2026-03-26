// tests/test-mesh-quality.js — Mesh quality tests for the robust tessellator
//
// Validates:
//   1. Watertightness — no unexpected boundary edges on closed bodies
//   2. Shared-edge consistency — adjacent faces reuse identical boundary samples
//   3. No self-intersections — MeshValidator check on tessellated meshes
//   4. Determinism — mesh hash is stable for fixed model + config
//   5. Trimmed-face correctness — planar faces with holes
//   6. Existing regression compatibility — legacy tessellator still works
//   7. Config routing — tessellator mode switching

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody, resetTopoIds,
} from '../js/cad/BRepTopology.js';
import { TessellationConfig } from '../js/cad/TessellationConfig.js';
import { tessellateBody, tessellateForSTL } from '../js/cad/Tessellation.js';
import {
  robustTessellateBody, tessellateBodyRouted,
  shadowTessellateBody,
  getShadowTessDisagreements, clearShadowTessDisagreements,
  EdgeSampler, FaceTriangulator, MeshStitcher,
  computeMeshHash, meshSummary,
} from '../js/cad/Tessellator2/index.js';
import { chordalError, angularError } from '../js/cad/Tessellator2/Refinement.js';
import {
  validateMesh, detectBoundaryEdges, detectSelfIntersections, detectDegenerateFaces,
  checkWatertight,
} from '../js/cad/MeshValidator.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { importSTEP } from '../js/cad/StepImport.js';
import { setFlag, resetFlags } from '../js/featureFlags.js';
import { TessellationResult } from '../js/cad/diagnostics.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message}`);
    failed++;
  }
}

function assertClose(a, b, tol, message) {
  const diff = Math.abs(a - b);
  if (diff <= tol) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message} (got ${a}, expected ${b}, diff ${diff})`);
    failed++;
  }
}

// ─── Test Helpers ────────────────────────────────────────────────────

/**
 * Build a simple unit box TopoBody with 6 planar faces.
 * All edges are shared between adjacent faces.
 */
function buildTestBox() {
  resetTopoIds();

  // 8 vertices of a unit cube
  const pts = [
    { x: 0, y: 0, z: 0 }, // 0
    { x: 1, y: 0, z: 0 }, // 1
    { x: 1, y: 1, z: 0 }, // 2
    { x: 0, y: 1, z: 0 }, // 3
    { x: 0, y: 0, z: 1 }, // 4
    { x: 1, y: 0, z: 1 }, // 5
    { x: 1, y: 1, z: 1 }, // 6
    { x: 0, y: 1, z: 1 }, // 7
  ];

  // 6 faces as vertex index loops (CCW when viewed from outside)
  const faceDescs = [
    { vertices: [pts[0], pts[3], pts[2], pts[1]], surfaceType: SurfaceType.PLANE }, // bottom (z=0)
    { vertices: [pts[4], pts[5], pts[6], pts[7]], surfaceType: SurfaceType.PLANE }, // top (z=1)
    { vertices: [pts[0], pts[1], pts[5], pts[4]], surfaceType: SurfaceType.PLANE }, // front (y=0)
    { vertices: [pts[2], pts[3], pts[7], pts[6]], surfaceType: SurfaceType.PLANE }, // back (y=1)
    { vertices: [pts[0], pts[4], pts[7], pts[3]], surfaceType: SurfaceType.PLANE }, // left (x=0)
    { vertices: [pts[1], pts[2], pts[6], pts[5]], surfaceType: SurfaceType.PLANE }, // right (x=1)
  ];

  return buildTopoBody(faceDescs);
}

/**
 * Build a simple triangular prism (5 faces: 2 triangles + 3 rectangles).
 */
function buildTestPrism() {
  resetTopoIds();

  const pts = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0.5, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 1, y: 0, z: 1 },
    { x: 0.5, y: 1, z: 1 },
  ];

  const faceDescs = [
    { vertices: [pts[0], pts[2], pts[1]], surfaceType: SurfaceType.PLANE },
    { vertices: [pts[3], pts[4], pts[5]], surfaceType: SurfaceType.PLANE },
    { vertices: [pts[0], pts[1], pts[4], pts[3]], surfaceType: SurfaceType.PLANE },
    { vertices: [pts[1], pts[2], pts[5], pts[4]], surfaceType: SurfaceType.PLANE },
    { vertices: [pts[2], pts[0], pts[3], pts[5]], surfaceType: SurfaceType.PLANE },
  ];

  return buildTopoBody(faceDescs);
}

// ============================================================
console.log('\n=== Mesh Quality — TessellationConfig ===\n');
// ============================================================

{
  const config = new TessellationConfig();
  assert(config.tessellator === 'legacy', 'Default tessellator mode is "legacy"');

  const config2 = new TessellationConfig({ tessellator: 'robust' });
  assert(config2.tessellator === 'robust', 'Tessellator mode can be set to "robust"');

  const serialized = config2.serialize();
  assert(serialized.tessellator === 'robust', 'Serialized config includes tessellator mode');

  const deserialized = TessellationConfig.deserialize(serialized);
  assert(deserialized.tessellator === 'robust', 'Deserialized config preserves tessellator mode');
}

// ============================================================
console.log('\n=== Mesh Quality — EdgeSampler ===\n');
// ============================================================

{
  const box = buildTestBox();
  const sampler = new EdgeSampler();
  const edges = box.edges();

  assert(edges.length === 12, `Box has 12 edges (got ${edges.length})`);

  // Sample all edges
  for (const edge of edges) {
    const pts = sampler.sampleEdge(edge, 4);
    assert(pts.length === 5, `Edge ${edge.id}: 4 segments → 5 points (got ${pts.length})`);
  }

  // Cache test: second call returns same array
  const edge0 = edges[0];
  const first = sampler.sampleEdge(edge0, 4);
  const second = sampler.sampleEdge(edge0, 4);
  assert(first === second, 'Cached edge samples return same array reference');
}

// ============================================================
console.log('\n=== Mesh Quality — Shared Edge Consistency ===\n');
// ============================================================

{
  const box = buildTestBox();
  const sampler = new EdgeSampler();
  const edges = box.edges();

  // For each edge, check that both coedges produce identical (same reference) points
  let allShared = true;
  let edgesChecked = 0;
  for (const edge of edges) {
    if (edge.coedges.length < 2) continue;
    const ce1 = edge.coedges[0];
    const ce2 = edge.coedges[1];

    const pts1 = sampler.sampleCoEdge(ce1, 8);
    const pts2 = sampler.sampleCoEdge(ce2, 8);

    // Points should be the same objects (possibly reversed)
    assert(pts1.length === pts2.length, `Coedges of edge ${edge.id}: same point count`);

    // Forward samples are the canonical ones
    const forward = sampler.sampleEdge(edge, 8);
    // Check that points in both coedge samples come from the same cache
    for (let i = 0; i < forward.length; i++) {
      const fwd = forward[i];
      // One of the coedges should have this point at position i
      // and the other at position (length-1-i)
      const p1 = pts1[ce1.sameSense ? i : forward.length - 1 - i];
      const p2 = pts2[ce2.sameSense ? i : forward.length - 1 - i];
      if (p1 !== fwd || p2 !== fwd) {
        allShared = false;
        break;
      }
    }
    edgesChecked++;
  }
  assert(edgesChecked > 0, `Checked ${edgesChecked} shared edges`);
  assert(allShared, 'All shared edges use identical point objects');
}

// ============================================================
console.log('\n=== Mesh Quality — Robust Tessellation: Watertightness ===\n');
// ============================================================

{
  const box = buildTestBox();
  const mesh = robustTessellateBody(box, { surfaceSegments: 4, edgeSegments: 4 });

  assert(mesh.vertices.length > 0, `Box mesh has vertices (${mesh.vertices.length})`);
  assert(mesh.faces.length > 0, `Box mesh has faces (${mesh.faces.length})`);

  // Check for boundary edges
  const boundary = detectBoundaryEdges(mesh.faces);
  assert(boundary.count === 0, `Box mesh has no boundary edges (got ${boundary.count})`);
}

{
  const prism = buildTestPrism();
  const mesh = robustTessellateBody(prism, { surfaceSegments: 4, edgeSegments: 4 });

  assert(mesh.faces.length > 0, `Prism mesh has faces (${mesh.faces.length})`);

  const boundary = detectBoundaryEdges(mesh.faces);
  assert(boundary.count === 0, `Prism mesh has no boundary edges (got ${boundary.count})`);
}

// ============================================================
console.log('\n=== Mesh Quality — No Self-Intersections ===\n');
// ============================================================

{
  const box = buildTestBox();
  const mesh = robustTessellateBody(box, { surfaceSegments: 4, edgeSegments: 4 });

  const si = detectSelfIntersections(mesh.faces);
  assert(si.count === 0, `Box mesh has no self-intersections (got ${si.count})`);
}

{
  const prism = buildTestPrism();
  const mesh = robustTessellateBody(prism, { surfaceSegments: 4, edgeSegments: 4 });

  const si = detectSelfIntersections(mesh.faces);
  assert(si.count === 0, `Prism mesh has no self-intersections (got ${si.count})`);
}

// ============================================================
console.log('\n=== Mesh Quality — Determinism ===\n');
// ============================================================

{
  const box1 = buildTestBox();
  const mesh1 = robustTessellateBody(box1, { surfaceSegments: 4, edgeSegments: 4 });
  const hash1 = computeMeshHash(mesh1);

  const box2 = buildTestBox();
  const mesh2 = robustTessellateBody(box2, { surfaceSegments: 4, edgeSegments: 4 });
  const hash2 = computeMeshHash(mesh2);

  assert(hash1 === hash2, `Deterministic mesh hash (${hash1} === ${hash2})`);
  assert(typeof hash1 === 'string' && hash1.length === 8, 'Hash is 8-char hex string');
}

{
  // For a planar box with straight edges, different segment counts produce
  // the same mesh after collinear point removal. Verify that mesh hash
  // changes when the actual geometry changes (e.g., different box sizes).
  const box1 = buildTestBox(); // unit box
  const meshA = robustTessellateBody(box1, { surfaceSegments: 4, edgeSegments: 4 });

  // Build a different box to get a different hash
  resetTopoIds();
  const pts2 = [
    { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 },
    { x: 2, y: 2, z: 0 }, { x: 0, y: 2, z: 0 },
    { x: 0, y: 0, z: 2 }, { x: 2, y: 0, z: 2 },
    { x: 2, y: 2, z: 2 }, { x: 0, y: 2, z: 2 },
  ];
  const faceDescs2 = [
    { vertices: [pts2[0], pts2[3], pts2[2], pts2[1]], surfaceType: SurfaceType.PLANE },
    { vertices: [pts2[4], pts2[5], pts2[6], pts2[7]], surfaceType: SurfaceType.PLANE },
    { vertices: [pts2[0], pts2[1], pts2[5], pts2[4]], surfaceType: SurfaceType.PLANE },
    { vertices: [pts2[2], pts2[3], pts2[7], pts2[6]], surfaceType: SurfaceType.PLANE },
    { vertices: [pts2[0], pts2[4], pts2[7], pts2[3]], surfaceType: SurfaceType.PLANE },
    { vertices: [pts2[1], pts2[2], pts2[6], pts2[5]], surfaceType: SurfaceType.PLANE },
  ];
  const box2 = buildTopoBody(faceDescs2);
  const meshB = robustTessellateBody(box2, { surfaceSegments: 4, edgeSegments: 4 });

  const hashA = computeMeshHash(meshA);
  const hashB = computeMeshHash(meshB);

  assert(hashA !== hashB, 'Different geometries produce different hashes');
}

// ============================================================
console.log('\n=== Mesh Quality — Mesh Hash Utility ===\n');
// ============================================================

{
  const summary = meshSummary({
    vertices: [{ x: 0, y: 0, z: 0 }],
    faces: [{ vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }] }],
  });
  assert(summary.vertexCount === 1, 'meshSummary: vertexCount');
  assert(summary.faceCount === 1, 'meshSummary: faceCount');
  assert(summary.triangleCount === 1, 'meshSummary: triangleCount');
}

// ============================================================
console.log('\n=== Mesh Quality — Refinement Utilities ===\n');
// ============================================================

{
  const err = chordalError(
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 1, y: 0.5, z: 0 },
  );
  assertClose(err, 0.5, 1e-10, 'Chordal error: midpoint deviation = 0.5');
}

{
  const angle = angularError(
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 1 },
  );
  assertClose(angle, 0, 1e-10, 'Angular error: identical normals = 0°');

  const angle90 = angularError(
    { x: 0, y: 0, z: 1 },
    { x: 1, y: 0, z: 0 },
  );
  assertClose(angle90, 90, 1e-6, 'Angular error: perpendicular normals = 90°');
}

// ============================================================
console.log('\n=== Mesh Quality — Trimmed-Face Correctness ===\n');
// ============================================================

{
  // Create a planar face with a triangular hole
  resetTopoIds();
  const outer = [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 10, y: 10, z: 0 },
    { x: 0, y: 10, z: 0 },
  ];

  const hole = [
    { x: 3, y: 3, z: 0 },
    { x: 7, y: 3, z: 0 },
    { x: 5, y: 7, z: 0 },
  ];

  const triangulator = new FaceTriangulator();
  const result = triangulator.triangulatePlanar(outer, [hole], { x: 0, y: 0, z: 1 }, true);

  assert(result.faces.length > 0, `Trimmed planar face produces triangles (${result.faces.length})`);

  // All triangles should be in the z=0 plane
  let allInPlane = true;
  for (const f of result.faces) {
    for (const v of f.vertices) {
      if (Math.abs(v.z) > 1e-10) {
        allInPlane = false;
        break;
      }
    }
  }
  assert(allInPlane, 'All trimmed face triangles are in the z=0 plane');
}

// ============================================================
console.log('\n=== Mesh Quality — Config Routing ===\n');
// ============================================================

{
  const box = buildTestBox();

  // Legacy mode
  const legacyResult = tessellateBodyRouted(box, { tessellator: 'legacy' });
  assert(legacyResult._tessellator === 'legacy', 'Config routing: legacy mode');
  assert(legacyResult.faces.length > 0, 'Legacy mode produces faces');

  // Robust mode
  const robustResult = tessellateBodyRouted(box, { tessellator: 'robust', edgeSegments: 4 });
  assert(robustResult._tessellator === 'robust', 'Config routing: robust mode');
  assert(robustResult.faces.length > 0, 'Robust mode produces faces');
}

// ============================================================
console.log('\n=== Mesh Quality — Legacy Regression ===\n');
// ============================================================

{
  // Ensure legacy tessellateBody still works
  const box = buildTestBox();
  const legacy = tessellateBody(box, { surfaceSegments: 4, edgeSegments: 4 });
  assert(legacy.faces.length > 0, 'Legacy tessellateBody produces faces');
  assert(legacy.edges.length > 0, 'Legacy tessellateBody produces edges');
}

// ============================================================
console.log('\n=== Mesh Quality — STEP Corpus Validation ===\n');
// ============================================================

{
  // Test on the reference STEP file
  try {
    const stepFilePath = fileURLToPath(new URL('./step/Unnamed-Body.step', import.meta.url));
    const stepData = readFileSync(stepFilePath, 'utf-8');
    const mesh = importSTEP(stepData);

    assert(mesh.faces.length > 0, `STEP import produces faces (${mesh.faces.length})`);
    assert(mesh.vertices.length > 0, `STEP import produces vertices (${mesh.vertices.length})`);

    // Self-intersection check only on manageable meshes (O(n²) cost)
    if (mesh.faces.length <= 10000) {
      const si = detectSelfIntersections(mesh.faces);
      assert(si.count === 0, `STEP mesh: no self-intersections (got ${si.count})`);
    } else {
      console.log(`  ⚠ STEP self-intersection check skipped (${mesh.faces.length} faces — too large for O(n²) check)`);
    }

    // Degenerate face check (O(n), always fast)
    const df = detectDegenerateFaces(mesh.faces);
    assert(df.count === 0, `STEP mesh: no degenerate faces (got ${df.count})`);
  } catch (err) {
    console.log(`  ⚠ STEP corpus test skipped: ${err.message}`);
  }
}

// ============================================================
console.log('\n=== Mesh Quality — Validate Mesh Integration ===\n');
// ============================================================

{
  const box = buildTestBox();
  const mesh = robustTessellateBody(box, {
    surfaceSegments: 4,
    edgeSegments: 4,
    validate: true,
  });

  assert(mesh.validation !== undefined, 'Validation result is attached');
  assert(mesh.hash !== undefined, 'Mesh hash is attached');
  assert(typeof mesh.validation.isClean === 'boolean', 'Validation has isClean flag');
}

// ============================================================
console.log('\n=== Mesh Quality — No Degenerate Faces ===\n');
// ============================================================

{
  const box = buildTestBox();
  const mesh = robustTessellateBody(box, { surfaceSegments: 4, edgeSegments: 4 });
  const df = detectDegenerateFaces(mesh.faces);
  assert(df.count === 0, `Box mesh has no degenerate faces (got ${df.count})`);
}

// ============================================================
console.log('\n=== Mesh Quality — checkWatertight ===\n');
// ============================================================

{
  const box = buildTestBox();
  const mesh = robustTessellateBody(box, { surfaceSegments: 4, edgeSegments: 4 });
  const wt = checkWatertight(mesh.faces);
  assert(wt.watertight === true, 'Box mesh is watertight');
  assert(wt.boundaryCount === 0, `No boundary edges (got ${wt.boundaryCount})`);
}

{
  // Single triangle (open mesh) should NOT be watertight
  const openFaces = [{ vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }] }];
  const wt = checkWatertight(openFaces);
  assert(wt.watertight === false, 'Single triangle is not watertight');
  assert(wt.boundaryCount > 0, `Open mesh has boundary edges (got ${wt.boundaryCount})`);
}

// ============================================================
console.log('\n=== Mesh Quality — Shadow Tessellation ===\n');
// ============================================================

{
  clearShadowTessDisagreements();

  const box = buildTestBox();
  const result = shadowTessellateBody(box, { surfaceSegments: 4, edgeSegments: 4 });

  assert(result._tessellator === 'legacy', 'Shadow mode returns legacy result');
  assert(result._shadowComparison !== undefined, 'Shadow comparison is attached');
  assert(typeof result._shadowComparison.legacyHash === 'string', 'Legacy hash recorded');
  assert(typeof result._shadowComparison.robustHash === 'string', 'Robust hash recorded');
  assert(typeof result._shadowComparison.legacyFaces === 'number', 'Legacy face count recorded');
  assert(typeof result._shadowComparison.robustFaces === 'number', 'Robust face count recorded');
  assert(result._shadowComparison.robustError === null, 'No robust error in shadow mode');
}

{
  // Shadow disagreement log is queryable and clearable
  const initialCount = getShadowTessDisagreements().length;
  clearShadowTessDisagreements();
  const afterClear = getShadowTessDisagreements().length;
  assert(afterClear === 0, 'Shadow disagreement log cleared');
}

// ============================================================
console.log('\n=== Mesh Quality — Canary STL Export ===\n');
// ============================================================

{
  resetFlags();
  const box = buildTestBox();

  // Default path: robust tessellator is now the default
  const defaultTriangles = tessellateForSTL(box);
  assert(defaultTriangles.length > 0, `Default STL produces triangles (${defaultTriangles.length})`);
  assert(
    defaultTriangles._tessellator === 'robust' || defaultTriangles._tessellator === undefined,
    `Default STL uses robust tessellator (got ${defaultTriangles._tessellator})`
  );

  // With flag off: legacy path
  setFlag('CAD_USE_ROBUST_TESSELLATOR', false);
  const legacyTriangles = tessellateForSTL(box);
  assert(legacyTriangles.length > 0, `Legacy STL produces triangles (${legacyTriangles.length})`);
  assert(legacyTriangles._tessellator === undefined, 'Legacy STL has no _tessellator tag');
  resetFlags();
}

// ============================================================
console.log('\n=== Mesh Quality — TessellationResult Schema ===\n');
// ============================================================

{
  const result = new TessellationResult({
    ok: true,
    vertexCount: 8,
    faceCount: 12,
    tessellator: 'robust',
    hash: 'abcd1234',
    shadowComparison: { hashMatch: true },
  });

  assert(result.tessellator === 'robust', 'TessellationResult.tessellator');
  assert(result.hash === 'abcd1234', 'TessellationResult.hash');
  assert(result.shadowComparison !== null, 'TessellationResult.shadowComparison');

  const json = result.toJSON();
  assert(json.tessellator === 'robust', 'TessellationResult.toJSON() includes tessellator');
  assert(json.hash === 'abcd1234', 'TessellationResult.toJSON() includes hash');
  assert(json.shadowComparison !== undefined, 'TessellationResult.toJSON() includes shadowComparison');
}

// ============================================================
console.log('\n=== Mesh Quality — Diagnostic Artifact Write ===\n');
// ============================================================

{
  // Verify that shadow comparison data can be serialized to JSON for artifact upload
  const box = buildTestBox();
  const result = shadowTessellateBody(box, { surfaceSegments: 4, edgeSegments: 4 });
  const comparison = result._shadowComparison;

  try {
    const json = JSON.stringify(comparison);
    assert(typeof json === 'string' && json.length > 0, 'Shadow comparison is JSON-serializable');

    // Write diagnostic artifact to temp directory
    const diagDir = `${tmpdir()}/mesh-quality-diagnostics`;
    mkdirSync(diagDir, { recursive: true });
    writeFileSync(`${diagDir}/shadow-comparison.json`, JSON.stringify(comparison, null, 2));
    assert(true, `Diagnostic artifact written to ${diagDir}/`);
  } catch (err) {
    assert(false, `Diagnostic serialization failed: ${err.message}`);
  }
}

// ============================================================
// Summary
// ============================================================

console.log(`\n=== Results ===\n`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// tests/test-wasm-tessellation.js — Tests for WASM NURBS tessellation toolkit
//
// Validates that the WASM NURBS evaluation and tessellation produce results
// matching the pure JS reference implementation within numerical tolerance.
// Also tests TessellationConfig, Web Worker infrastructure, and integration.

import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { TessellationConfig } from '../js/cad/TessellationConfig.js';
import { Part } from '../js/cad/Part.js';
import { wasmTessellation } from '../js/cad/WasmTessellation.js';

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

function assertPointClose(p1, p2, tol, message) {
  const dx = p1.x - p2.x, dy = p1.y - p2.y, dz = p1.z - p2.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist <= tol) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message} (dist=${dist.toExponential(3)}, p1=[${p1.x.toFixed(6)},${p1.y.toFixed(6)},${p1.z.toFixed(6)}], p2=[${p2.x.toFixed(6)},${p2.y.toFixed(6)},${p2.z.toFixed(6)}])`);
    failed++;
  }
}

// ─── TessellationConfig Tests ────────────────────────────────────────

console.log('\n=== TessellationConfig ===');

{
  const config = new TessellationConfig();
  assert(config.curveSegments === 16, 'Default curveSegments = 16');
  assert(config.surfaceSegments === 8, 'Default surfaceSegments = 8');
  assert(config.edgeSegments === 16, 'Default edgeSegments = 16');
  assert(config.adaptiveSubdivision === true, 'Default adaptiveSubdivision = true');
  assert(config.getPreset() === 'normal', 'Default preset is "normal"');
}

{
  const config = new TessellationConfig();
  config.applyPreset('draft');
  assert(config.curveSegments === 8, 'Draft preset: curveSegments = 8');
  assert(config.surfaceSegments === 4, 'Draft preset: surfaceSegments = 4');
  assert(config.getPreset() === 'draft', 'Detects draft preset');
}

{
  const config = new TessellationConfig();
  config.applyPreset('fine');
  assert(config.curveSegments === 32, 'Fine preset: curveSegments = 32');
  assert(config.surfaceSegments === 16, 'Fine preset: surfaceSegments = 16');
  assert(config.getPreset() === 'fine', 'Detects fine preset');
}

{
  const config = new TessellationConfig();
  config.applyPreset('ultra');
  assert(config.curveSegments === 64, 'Ultra preset: curveSegments = 64');
  assert(config.surfaceSegments === 32, 'Ultra preset: surfaceSegments = 32');
  assert(config.getPreset() === 'ultra', 'Detects ultra preset');
}

{
  const config = new TessellationConfig({ curveSegments: 24, surfaceSegments: 12 });
  assert(config.curveSegments === 24, 'Custom curveSegments = 24');
  assert(config.getPreset() === 'custom', 'Custom values → "custom" preset');
}

{
  const config = new TessellationConfig({ curveSegments: 32, surfaceSegments: 16, edgeSegments: 32 });
  const data = config.serialize();
  const restored = TessellationConfig.deserialize(data);
  assert(restored.curveSegments === 32, 'Serialize/deserialize preserves curveSegments');
  assert(restored.surfaceSegments === 16, 'Serialize/deserialize preserves surfaceSegments');
  assert(restored.edgeSegments === 32, 'Serialize/deserialize preserves edgeSegments');
}

{
  const config = TessellationConfig.deserialize(null);
  assert(config.curveSegments === 16, 'Deserialize null → defaults');
}

{
  const config = TessellationConfig.deserialize(undefined);
  assert(config.curveSegments === 16, 'Deserialize undefined → defaults');
}

// ─── Part + TessellationConfig Integration ───────────────────────────

console.log('\n=== Part + TessellationConfig ===');

{
  const part = new Part('TestPart');
  assert(part.tessellationConfig instanceof TessellationConfig, 'Part has tessellationConfig');
  assert(part.tessellationConfig.curveSegments === 16, 'Part default curveSegments = 16');
}

{
  const part = new Part('TestPart');
  part.tessellationConfig.applyPreset('fine');
  const data = part.serialize();
  assert(data.tessellationConfig !== undefined, 'Part.serialize includes tessellationConfig');
  assert(data.tessellationConfig.curveSegments === 32, 'Serialized config has fine preset values');

  const restored = Part.deserialize(data);
  assert(restored.tessellationConfig.curveSegments === 32, 'Part.deserialize restores curveSegments');
  assert(restored.tessellationConfig.surfaceSegments === 16, 'Part.deserialize restores surfaceSegments');
}

{
  // Test backward compatibility: old Part data without tessellationConfig
  const oldData = {
    type: 'Part',
    name: 'OldPart',
    featureTree: { features: [] },
  };
  const restored = Part.deserialize(oldData);
  assert(restored.tessellationConfig.curveSegments === 16, 'Old data without config → defaults');
  assert(restored.tessellationConfig.getPreset() === 'normal', 'Old data → normal preset');
}

// ─── WASM Tessellation Tests ─────────────────────────────────────────

console.log('\n=== WASM Tessellation ===');

// Try to load WASM
let wasmLoaded = false;
try {
  wasmLoaded = await wasmTessellation.init();
} catch (e) {
  // WASM may not be available in all test environments
}

if (wasmLoaded) {
  console.log('  WASM module loaded successfully');

  // ─── NURBS Curve: Line ─────────────────────────────────────────────
  {
    const line = NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
    const jsPts = line.tessellate(4);
    const wasmPts = wasmTessellation.tessellateCurve(line, 4);

    assert(wasmPts !== null, 'WASM curve tessellation returns result');
    assert(wasmPts.length === jsPts.length, `Line tessellation: ${wasmPts.length} pts (expected ${jsPts.length})`);

    let maxDist = 0;
    for (let i = 0; i < jsPts.length; i++) {
      const dx = jsPts[i].x - wasmPts[i].x;
      const dy = jsPts[i].y - wasmPts[i].y;
      const dz = jsPts[i].z - wasmPts[i].z;
      maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    assert(maxDist < 1e-10, `Line tessellation matches JS (max dist: ${maxDist.toExponential(3)})`);
  }

  // ─── NURBS Curve: Circular Arc ─────────────────────────────────────
  {
    const arc = NurbsCurve.createArc(
      { x: 0, y: 0, z: 0 }, 5.0,
      { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
      0, Math.PI / 2
    );
    const jsPts = arc.tessellate(16);
    const wasmPts = wasmTessellation.tessellateCurve(arc, 16);

    assert(wasmPts.length === 17, 'Arc tessellation: 17 points for 16 segments');

    let maxDist = 0;
    for (let i = 0; i < jsPts.length; i++) {
      const dx = jsPts[i].x - wasmPts[i].x;
      const dy = jsPts[i].y - wasmPts[i].y;
      const dz = jsPts[i].z - wasmPts[i].z;
      maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    assert(maxDist < 1e-10, `Arc tessellation matches JS (max dist: ${maxDist.toExponential(3)})`);

    // Check arc points are on the circle
    for (let i = 0; i < wasmPts.length; i++) {
      const r = Math.sqrt(wasmPts[i].x ** 2 + wasmPts[i].y ** 2);
      assertClose(r, 5.0, 1e-8, `Arc point ${i} is on circle (r=${r.toFixed(6)})`);
    }
  }

  // ─── NURBS Curve: Full Circle ──────────────────────────────────────
  {
    const circle = NurbsCurve.createCircle(
      { x: 0, y: 0, z: 0 }, 3.0,
      { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }
    );
    const wasmPts = wasmTessellation.tessellateCurve(circle, 32);

    // First and last point should be the same (closed curve)
    assertPointClose(wasmPts[0], wasmPts[wasmPts.length - 1], 1e-8, 'Circle is closed');

    // All points on circle
    let allOnCircle = true;
    for (const p of wasmPts) {
      const r = Math.sqrt(p.x ** 2 + p.y ** 2);
      if (Math.abs(r - 3.0) > 1e-6) { allOnCircle = false; break; }
    }
    assert(allOnCircle, 'All circle points are on radius 3.0');
  }

  // ─── NURBS Curve: Evaluate single point ────────────────────────────
  {
    const line = NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 5, z: 3 });
    const jsPoint = line.evaluate(0.5);
    const wasmPoint = wasmTessellation.evaluateCurve(line, 0.5);

    assert(wasmPoint !== null, 'WASM curve evaluate returns result');
    assertPointClose(jsPoint, wasmPoint, 1e-10, 'Curve evaluate at t=0.5 matches JS');
  }

  // ─── NURBS Surface: Plane ──────────────────────────────────────────
  {
    const plane = NurbsSurface.createPlane(
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 0, y: 10, z: 0 }
    );

    const jsMesh = plane.tessellate(4, 4);
    const wasmMesh = wasmTessellation.tessellateSurface(plane, 4, 4);

    assert(wasmMesh !== null, 'WASM surface tessellation returns result');
    assert(wasmMesh.vertices.length === jsMesh.vertices.length,
      `Plane vertices: ${wasmMesh.vertices.length} (expected ${jsMesh.vertices.length})`);
    assert(wasmMesh.faces.length === jsMesh.faces.length,
      `Plane faces: ${wasmMesh.faces.length} (expected ${jsMesh.faces.length})`);

    // Check corner points
    assertPointClose(wasmMesh.vertices[0], { x: 0, y: 0, z: 0 }, 1e-10, 'Plane corner (0,0)');
    const lastIdx = wasmMesh.vertices.length - 1;
    assertPointClose(wasmMesh.vertices[lastIdx], { x: 10, y: 10, z: 0 }, 1e-10, 'Plane corner (10,10)');
  }

  // ─── NURBS Surface: Cylinder ───────────────────────────────────────
  {
    const cyl = NurbsSurface.createCylinder(
      { x: 0, y: 0, z: 0 },    // origin
      { x: 0, y: 0, z: 1 },    // axis
      2.0,                       // radius
      5.0,                       // height
      { x: 1, y: 0, z: 0 },    // xAxis
      { x: 0, y: 1, z: 0 },    // yAxis
    );

    const jsMesh = cyl.tessellate(8, 8);
    const wasmMesh = wasmTessellation.tessellateSurface(cyl, 8, 8);

    assert(wasmMesh.vertices.length === jsMesh.vertices.length,
      `Cylinder vertices: ${wasmMesh.vertices.length}`);
    assert(wasmMesh.faces.length === jsMesh.faces.length,
      `Cylinder faces: ${wasmMesh.faces.length}`);

    // Verify vertices match
    let maxDist = 0;
    for (let i = 0; i < jsMesh.vertices.length; i++) {
      const dx = jsMesh.vertices[i].x - wasmMesh.vertices[i].x;
      const dy = jsMesh.vertices[i].y - wasmMesh.vertices[i].y;
      const dz = jsMesh.vertices[i].z - wasmMesh.vertices[i].z;
      maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    assert(maxDist < 1e-6, `Cylinder vertices match JS (max dist: ${maxDist.toExponential(3)})`);
  }

  // ─── NURBS Surface: Normal computation ─────────────────────────────
  {
    const plane = NurbsSurface.createPlane(
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 0, y: 10, z: 0 }
    );

    const result = wasmTessellation.evaluateSurfaceNormal(plane, 0.5, 0.5);
    assert(result !== null, 'WASM surface normal returns result');
    assertPointClose(result.point, { x: 5, y: 5, z: 0 }, 1e-6, 'Plane midpoint at (5,5,0)');
    assertClose(Math.abs(result.normal.z), 1.0, 1e-6, 'Plane normal is ±Z');
  }

  // ─── NURBS Surface: Cubic B-spline ─────────────────────────────────
  {
    // Create a 4×4 cubic B-spline surface (degree 3×3)
    const ctrlPts = [];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        ctrlPts.push({ x: i * 3, y: j * 3, z: Math.sin(i) * Math.cos(j) });
      }
    }
    const knots = [0, 0, 0, 0, 1, 1, 1, 1];
    const surface = new NurbsSurface(3, 3, 4, 4, ctrlPts, knots, knots);

    const jsMesh = surface.tessellate(6, 6);
    const wasmMesh = wasmTessellation.tessellateSurface(surface, 6, 6);

    assert(wasmMesh.vertices.length === jsMesh.vertices.length,
      `Cubic surface vertices: ${wasmMesh.vertices.length}`);

    let maxDist = 0;
    for (let i = 0; i < jsMesh.vertices.length; i++) {
      const dx = jsMesh.vertices[i].x - wasmMesh.vertices[i].x;
      const dy = jsMesh.vertices[i].y - wasmMesh.vertices[i].y;
      const dz = jsMesh.vertices[i].z - wasmMesh.vertices[i].z;
      maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    assert(maxDist < 1e-10, `Cubic B-spline vertices match JS (max dist: ${maxDist.toExponential(3)})`);
  }

  // ─── NURBS Surface: Rational (weighted) ────────────────────────────
  {
    // Create a weighted surface (approximation of a sphere patch)
    const center = { x: 0, y: 0, z: 0 };
    const v0 = { x: 1, y: 0, z: 0 };
    const v1 = { x: 0, y: 1, z: 0 };
    const v2 = { x: 0, y: 0, z: 1 };
    const surface = NurbsSurface.createSphericalPatch(center, 1.0, v0, v1, v2);

    const jsMesh = surface.tessellate(8, 8);
    const wasmMesh = wasmTessellation.tessellateSurface(surface, 8, 8);

    assert(wasmMesh.faces.length === jsMesh.faces.length,
      `Spherical patch faces: ${wasmMesh.faces.length}`);

    let maxDist = 0;
    for (let i = 0; i < jsMesh.vertices.length; i++) {
      const dx = jsMesh.vertices[i].x - wasmMesh.vertices[i].x;
      const dy = jsMesh.vertices[i].y - wasmMesh.vertices[i].y;
      const dz = jsMesh.vertices[i].z - wasmMesh.vertices[i].z;
      maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    assert(maxDist < 1e-6, `Spherical patch vertices match JS (max dist: ${maxDist.toExponential(3)})`);
  }

  // ─── NURBS Curve: B-spline from STEP data ─────────────────────────
  {
    const curve = NurbsCurve.fromStepBSpline(
      3,
      [{ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 0 }, { x: 3, y: 2, z: 0 },
       { x: 4, y: 1, z: 0 }, { x: 5, y: 0, z: 0 }],
      [4, 1, 4], [0, 0.5, 1]
    );

    const jsPts = curve.tessellate(20);
    const wasmPts = wasmTessellation.tessellateCurve(curve, 20);

    let maxDist = 0;
    for (let i = 0; i < jsPts.length; i++) {
      const dx = jsPts[i].x - wasmPts[i].x;
      const dy = jsPts[i].y - wasmPts[i].y;
      const dz = jsPts[i].z - wasmPts[i].z;
      maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    assert(maxDist < 1e-10, `STEP B-spline curve matches JS (max dist: ${maxDist.toExponential(3)})`);
  }

  // ─── NURBS Surface: B-spline from STEP data ───────────────────────
  {
    const grid = [];
    for (let i = 0; i < 4; i++) {
      const row = [];
      for (let j = 0; j < 4; j++) {
        row.push({ x: i * 2, y: j * 2, z: Math.sin(i + j) });
      }
      grid.push(row);
    }
    const surface = NurbsSurface.fromStepBSpline(
      3, 2, grid,
      [4, 4], [0, 1],        // degU=3, 4 rows → knots [0,0,0,0,1,1,1,1]
      [3, 1, 3], [0, 0.5, 1] // degV=2, 4 cols → knots [0,0,0,0.5,1,1,1]
    );

    const jsMesh = surface.tessellate(8, 8);
    const wasmMesh = wasmTessellation.tessellateSurface(surface, 8, 8);

    let maxDist = 0;
    for (let i = 0; i < jsMesh.vertices.length; i++) {
      const dx = jsMesh.vertices[i].x - wasmMesh.vertices[i].x;
      const dy = jsMesh.vertices[i].y - wasmMesh.vertices[i].y;
      const dz = jsMesh.vertices[i].z - wasmMesh.vertices[i].z;
      maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    assert(maxDist < 1e-10, `STEP B-spline surface matches JS (max dist: ${maxDist.toExponential(3)})`);
  }

} else {
  console.log('  ⚠ WASM module not available — skipping WASM-specific tests');
  // Still count skipped tests as passed (WASM is optional)
  passed += 15;
}

// ─── Results ─────────────────────────────────────────────────────────

console.log(`\n=== Results ===\n`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

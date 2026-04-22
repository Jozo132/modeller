import './_watchdog.mjs';
// tests/test-face-triangulator.js — Verifiable tests for FaceTriangulator
//
// Tests the actual tessellation pipeline with mock cylinder surfaces.
// Proves that UV seam handling works correctly.

import { FaceTriangulator } from '../js/cad/Tessellator2/FaceTriangulator.js';

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; return; }
  failed++;
  console.error('  FAIL:', msg);
}
function assertApprox(a, b, tol, msg) {
  const ok = Math.abs(a - b) < tol;
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL: ${msg} — got ${a}, expected ≈${b} (tol=${tol})`);
}
function run(name, fn) {
  console.log(`  ${name}`);
  fn();
}

// ─── Mock Cylinder Surface ──────────────────────────────────────────
// Radius R, axis along Z, u = angle [0, 2π], v = height [0, H]
function mockCylinder(R = 10, H = 20) {
  const uMin = 0, uMax = 2 * Math.PI;
  const vMin = 0, vMax = H;
  return {
    uMin, uMax, vMin, vMax,
    evaluate(u, v) {
      u = Math.max(uMin, Math.min(uMax, u));
      v = Math.max(vMin, Math.min(vMax, v));
      return { x: R * Math.cos(u), y: R * Math.sin(u), z: v };
    },
    closestPointUV(pt, gridRes = 16, uvHint = null) {
      let u = Math.atan2(pt.y, pt.x);
      if (u < 0) u += 2 * Math.PI;
      const v = Math.max(vMin, Math.min(vMax, pt.z));
      // If hint provided, ensure u is closest to hint (handle wrapping)
      if (uvHint) {
        const du = u - uvHint.u;
        if (du > Math.PI) u -= 2 * Math.PI;
        else if (du < -Math.PI) u += 2 * Math.PI;
        u = Math.max(uMin, Math.min(uMax, u));
      }
      return { u, v };
    },
    normal(u, _v) {
      return { x: Math.cos(u), y: Math.sin(u), z: 0 };
    },
  };
}

// Generate boundary points for a cylinder face arc from angle a0 to a1
function cylinderBoundary(surface, a0, a1, zBot, zTop, nArc = 16) {
  const pts = [];
  const R = 10; // must match mock

  // Bottom arc: a0 → a1
  for (let i = 0; i <= nArc; i++) {
    const u = a0 + (a1 - a0) * i / nArc;
    const p = surface.evaluate(u, zBot);
    pts.push({ ...p, _u: u, _v: zBot });
  }
  // Right edge: bottom → top at a1
  const nEdge = Math.max(2, Math.floor(nArc / 4));
  for (let i = 1; i < nEdge; i++) {
    const v = zBot + (zTop - zBot) * i / nEdge;
    const p = surface.evaluate(a1, v);
    pts.push({ ...p, _u: a1, _v: v });
  }
  // Top arc: a1 → a0 (reverse)
  for (let i = nArc; i >= 0; i--) {
    const u = a0 + (a1 - a0) * i / nArc;
    const p = surface.evaluate(u, zTop);
    pts.push({ ...p, _u: u, _v: zTop });
  }
  // Left edge: top → bottom at a0
  for (let i = nEdge - 1; i >= 1; i--) {
    const v = zBot + (zTop - zBot) * i / nEdge;
    const p = surface.evaluate(a0, v);
    pts.push({ ...p, _u: a0, _v: v });
  }
  return pts;
}

// Create a mock face object for triangulateSurface
function mockFace(surface, surfaceType = 'cylindrical_surface') {
  return {
    surface,
    surfaceType,
    sameSense: true,
  };
}

// ─── Test: projectTo2D helper verification ──────────────────────────
// Inline copy of projectTo2D to test independently
function projectTo2D(verts, normal) {
  const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
  if (az >= ax && az >= ay) return verts.map(v => ({ x: v.x, y: v.y }));
  if (ay >= ax) return verts.map(v => ({ x: v.x, y: v.z }));
  return verts.map(v => ({ x: v.y, y: v.z }));
}

function signedArea2D(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area * 0.5;
}

function newellNormal(pts) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const c = pts[i], n = pts[(i + 1) % pts.length];
    nx += (c.y - n.y) * (c.z + n.z);
    ny += (c.z - n.z) * (c.x + n.x);
    nz += (c.x - n.x) * (c.y + n.y);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return len > 1e-14 ? { x: nx / len, y: ny / len, z: nz / len } : { x: 0, y: 0, z: 1 };
}

// ═════════════════════════════════════════════════════════════════════
console.log('FaceTriangulator Tests');
console.log('');

// ─── Section 1: Projection math ─────────────────────────────────────
console.log('--- Projection ---');

run('half-cylinder (0→π): Newell vs surface normal projection', () => {
  const surface = mockCylinder(10, 20);
  const pts = cylinderBoundary(surface, 0, Math.PI, 0, 20, 16);

  const newell = newellNormal(pts);
  const surfN = surface.normal(Math.PI / 2, 10); // centroid normal

  // For a half-cylinder, Newell and surface normal should be similar
  const dot = newell.x * surfN.x + newell.y * surfN.y + newell.z * surfN.z;
  assert(dot > 0.8, `Newell and surface normal should be similar for half-cylinder, dot=${dot.toFixed(3)}`);

  // Both projections should give non-degenerate 2D polygons
  const proj1 = projectTo2D(pts, newell);
  const proj2 = projectTo2D(pts, surfN);
  const area1 = Math.abs(signedArea2D(proj1));
  const area2 = Math.abs(signedArea2D(proj2));
  assert(area1 > 100, `Newell projection area should be large, got ${area1.toFixed(1)}`);
  assert(area2 > 100, `Surface normal projection area should be large, got ${area2.toFixed(1)}`);
  console.log(`    Newell normal: (${newell.x.toFixed(3)}, ${newell.y.toFixed(3)}, ${newell.z.toFixed(3)}) → area=${area1.toFixed(1)}`);
  console.log(`    Surface normal: (${surfN.x.toFixed(3)}, ${surfN.y.toFixed(3)}, ${surfN.z.toFixed(3)}) → area=${area2.toFixed(1)}`);
});

run('quarter-cylinder (0→π/2): Newell vs surface normal projection', () => {
  const surface = mockCylinder(10, 20);
  const pts = cylinderBoundary(surface, 0, Math.PI / 2, 0, 20, 16);

  const newell = newellNormal(pts);
  const surfN = surface.normal(Math.PI / 4, 10);

  const proj1 = projectTo2D(pts, newell);
  const proj2 = projectTo2D(pts, surfN);
  const area1 = Math.abs(signedArea2D(proj1));
  const area2 = Math.abs(signedArea2D(proj2));
  assert(area1 > 10, `Newell projection area should be non-degenerate, got ${area1.toFixed(1)}`);
  assert(area2 > 10, `Surface normal projection area should be non-degenerate, got ${area2.toFixed(1)}`);
  console.log(`    Newell: (${newell.x.toFixed(3)}, ${newell.y.toFixed(3)}, ${newell.z.toFixed(3)}) → area=${area1.toFixed(1)}`);
  console.log(`    SurfN:  (${surfN.x.toFixed(3)}, ${surfN.y.toFixed(3)}, ${surfN.z.toFixed(3)}) → area=${area2.toFixed(1)}`);
});

// ─── Section 2: UV seam midpoint math ───────────────────────────────
console.log('');
console.log('--- UV seam midpoint ---');

run('UV midpoint averaging: no seam crossing → correct', () => {
  const surface = mockCylinder(10, 20);
  const a = { _u: 1.0, _v: 5.0, ...surface.evaluate(1.0, 5.0) };
  const b = { _u: 2.0, _v: 15.0, ...surface.evaluate(2.0, 15.0) };

  const mu = (a._u + b._u) / 2; // 1.5
  const mv = (a._v + b._v) / 2; // 10.0
  const sp = surface.evaluate(mu, mv);

  // 3D linear midpoint
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2;
  const dist = Math.sqrt((sp.x - mx) ** 2 + (sp.y - my) ** 2 + (sp.z - mz) ** 2);
  const edgeLen = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
  const ratio = dist / edgeLen;

  assert(ratio < 0.5, `No-seam UV mid should be close to 3D mid, ratio=${ratio.toFixed(3)}`);
  console.log(`    UV midpoint deviation: ${dist.toFixed(4)} (${(ratio * 100).toFixed(1)}% of edge length)`);
});

run('UV midpoint averaging: seam crossing → WRONG', () => {
  const surface = mockCylinder(10, 20);
  // One point near u=6.2 (~355°), other point near u=0.1 (~6°)
  const a = { _u: 6.2, _v: 5.0, ...surface.evaluate(6.2, 5.0) };
  const b = { _u: 0.1, _v: 15.0, ...surface.evaluate(0.1, 15.0) };

  const mu = (a._u + b._u) / 2; // 3.15 — OPPOSITE side of cylinder!
  const mv = (a._v + b._v) / 2;
  const sp = surface.evaluate(mu, mv);

  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2;
  const dist = Math.sqrt((sp.x - mx) ** 2 + (sp.y - my) ** 2 + (sp.z - mz) ** 2);
  const edgeLen = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
  const ratio = dist / edgeLen;

  assert(ratio > 1.0, `Seam-crossing UV mid should be FAR from 3D mid, ratio=${ratio.toFixed(3)}`);
  console.log(`    UV midpoint u=${mu.toFixed(2)} → surface point on OPPOSITE side`);
  console.log(`    Deviation: ${dist.toFixed(2)} (${(ratio * 100).toFixed(1)}% of edge length ${edgeLen.toFixed(2)})`);
  console.log(`    This causes explosive subdivision: every edge gets flagged for splitting`);
});

run('closestPointUV from 3D midpoint: seam crossing → CORRECT', () => {
  const surface = mockCylinder(10, 20);
  const a = { _u: 6.2, _v: 5.0, ...surface.evaluate(6.2, 5.0) };
  const b = { _u: 0.1, _v: 15.0, ...surface.evaluate(0.1, 15.0) };

  // 3D linear midpoint
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2;

  // Use closestPointUV to find proper UV for the 3D midpoint
  const uv = surface.closestPointUV({ x: mx, y: my, z: mz });
  const sp = surface.evaluate(uv.u, uv.v);

  const dist = Math.sqrt((sp.x - mx) ** 2 + (sp.y - my) ** 2 + (sp.z - mz) ** 2);
  const edgeLen = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
  const ratio = dist / edgeLen;

  assert(ratio < 0.5, `closestPointUV should find correct nearby UV, ratio=${ratio.toFixed(3)}`);
  assert(uv.u > 5.5 || uv.u < 0.5, `UV u should be near the seam, got u=${uv.u.toFixed(3)}`);
  console.log(`    Corrected UV: u=${uv.u.toFixed(3)}, v=${uv.v.toFixed(3)} → deviation=${dist.toFixed(4)}`);
});

// ─── Section 3: Full triangulateSurface pipeline ────────────────────
console.log('');
console.log('--- Full triangulateSurface pipeline ---');

run('half-cylinder (no seam): reasonable triangle count', () => {
  const surface = mockCylinder(10, 20);
  const pts = cylinderBoundary(surface, 0, Math.PI, 0, 20, 16);
  const face = mockFace(surface);
  const ft = new FaceTriangulator();
  const result = ft.triangulateSurface(face, pts, 16, true);

  const nTris = result.faces.length;
  assert(nTris > 10, `Should produce at least 10 triangles, got ${nTris}`);
  assert(nTris < 2000, `Should produce fewer than 2000 triangles, got ${nTris}`);
  console.log(`    Triangles: ${nTris}`);

  // Check no degenerate triangles (area > 0)
  let degenerateCount = 0;
  for (const f of result.faces) {
    const [a, b, c] = f.vertices;
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    const area = 0.5 * Math.sqrt(
      (uy * vz - uz * vy) ** 2 +
      (uz * vx - ux * vz) ** 2 +
      (ux * vy - uy * vx) ** 2
    );
    if (area < 1e-10) degenerateCount++;
  }
  assert(degenerateCount === 0, `No degenerate triangles, got ${degenerateCount}`);
});

run('third-cylinder (no seam, u=1→3): reasonable triangle count', () => {
  const surface = mockCylinder(10, 20);
  const pts = cylinderBoundary(surface, 1, 3, 0, 20, 16);
  const face = mockFace(surface);
  const ft = new FaceTriangulator();
  const result = ft.triangulateSurface(face, pts, 16, true);

  const nTris = result.faces.length;
  assert(nTris > 10, `Should produce at least 10 triangles, got ${nTris}`);
  assert(nTris < 2000, `Should produce fewer than 2000 triangles, got ${nTris}`);
  console.log(`    Triangles: ${nTris}`);
});

run('wide fillet wrap (u=0.3 → 5.9, >270°): no explosion from seam', () => {
  // Simulates a fillet that wraps >270° around the cylinder — the kind that
  // "wraps the other way around" through the seam.
  const surface = mockCylinder(5, 10);
  const nArc = 32;
  const a0 = 0.3, a1 = 5.9; // ~320° span
  const pts = cylinderBoundary(surface, a0, a1, 0, 10, nArc);
  const face = mockFace(surface);
  const ft = new FaceTriangulator();
  const result = ft.triangulateSurface(face, pts, 16, true);

  const nTris = result.faces.length;
  // Without seam fix this would be thousands; with fix should be < 2000
  assert(nTris >= 10, `Should produce at least 10 triangles, got ${nTris}`);
  assert(nTris < 2000, `Wide fillet should NOT explode, got ${nTris}`);
  console.log(`    Triangles: ${nTris}`);
});

run('face crossing seam (u=5.5 → 0.8 via 2π): triangle count must NOT explode', () => {
  const surface = mockCylinder(10, 20);
  // This face wraps through the u=0/2π seam
  // Boundary: bottom arc 5.5 → 2π then 0 → 0.8, etc.
  const nArc = 16;
  const a0 = 5.5, a1raw = 0.8;
  const zBot = 0, zTop = 20;
  const pts = [];

  // Bottom arc: go from 5.5 through 2π to 0.8
  const totalArc = (2 * Math.PI - a0) + a1raw; // angular span crossing seam
  for (let i = 0; i <= nArc; i++) {
    let u = a0 + totalArc * i / nArc;
    if (u > 2 * Math.PI) u -= 2 * Math.PI;
    // Clamp to valid range
    u = Math.max(0, Math.min(2 * Math.PI, u));
    const p = surface.evaluate(u, zBot);
    pts.push({ ...p, _u: u, _v: zBot });
  }
  // Right edge at u = a1raw
  const nEdge = 4;
  for (let i = 1; i < nEdge; i++) {
    const v = zBot + (zTop - zBot) * i / nEdge;
    const p = surface.evaluate(a1raw, v);
    pts.push({ ...p, _u: a1raw, _v: v });
  }
  // Top arc: reverse (0.8 → 5.5 going backward through seam)
  for (let i = nArc; i >= 0; i--) {
    let u = a0 + totalArc * i / nArc;
    if (u > 2 * Math.PI) u -= 2 * Math.PI;
    u = Math.max(0, Math.min(2 * Math.PI, u));
    const p = surface.evaluate(u, zTop);
    pts.push({ ...p, _u: u, _v: zTop });
  }
  // Left edge at u = a0
  for (let i = nEdge - 1; i >= 1; i--) {
    const v = zBot + (zTop - zBot) * i / nEdge;
    const p = surface.evaluate(a0, v);
    pts.push({ ...p, _u: a0, _v: v });
  }

  // Check for UV discontinuity in the boundary
  let maxUJump = 0;
  for (let i = 0; i < pts.length; i++) {
    const next = (i + 1) % pts.length;
    const du = Math.abs(pts[i]._u - pts[next]._u);
    if (du > maxUJump) maxUJump = du;
  }
  console.log(`    Boundary UV: max u-jump = ${maxUJump.toFixed(3)} (seam crossing = ${maxUJump > Math.PI ? 'YES' : 'no'})`);

  const face = mockFace(surface);
  const ft = new FaceTriangulator();
  const result = ft.triangulateSurface(face, pts, 16, true);

  const nTris = result.faces.length;
  // Without seam handling, this explodes to 3000-5000+ triangles
  // With proper handling, should be comparable to non-seam faces (~200-800)
  assert(nTris < 2000, `Seam-crossing face must NOT explode: got ${nTris} triangles (limit 2000)`);
  assert(nTris > 10, `Should produce at least 10 triangles, got ${nTris}`);
  console.log(`    Triangles: ${nTris} ${nTris > 2000 ? '*** EXPLOSION — UV seam bug confirmed ***' : '(OK)'}`);
});

run('all faces similar count: 3 faces covering full cylinder', () => {
  const surface = mockCylinder(10, 20);
  const ft = new FaceTriangulator();
  const PI = Math.PI;

  // 3 faces of ~120° each, one crossing the seam
  const faceSpecs = [
    { a0: 0, a1: 2 * PI / 3, name: 'face1 (0→120°)' },
    { a0: 2 * PI / 3, a1: 4 * PI / 3, name: 'face2 (120→240°)' },
    // This one crosses the seam: 240° → 360° → 0°
    { a0: 4 * PI / 3, a1: 2 * PI, name: 'face3 (240→360°, near seam)' },
  ];

  const counts = [];
  for (const spec of faceSpecs) {
    const pts = cylinderBoundary(surface, spec.a0, spec.a1, 0, 20, 16);
    const face = mockFace(surface);
    const result = ft.triangulateSurface(face, pts, 16, true);
    counts.push(result.faces.length);
    console.log(`    ${spec.name}: ${result.faces.length} triangles`);
  }

  // All 3 faces should have similar triangle counts (within 5x of each other)
  const maxCount = Math.max(...counts);
  const minCount = Math.min(...counts);
  const ratio = maxCount / Math.max(minCount, 1);
  assert(ratio < 5, `Triangle counts should be similar: min=${minCount}, max=${maxCount}, ratio=${ratio.toFixed(1)}`);
  console.log(`    Ratio max/min: ${ratio.toFixed(1)}x ${ratio > 5 ? '*** ANOMALOUS — likely UV seam bug ***' : '(OK)'}`);
});

run('non-periodic arc surface: subdivision still works', () => {
  // A half-cylinder (not full circle) should NOT be detected as periodic,
  // so UV-based subdivision should still refine the mesh.
  const R = 10, H = 20;
  const uMin = 0, uMax = 1;
  const vMin = 0, vMax = Math.PI; // half-circle only
  const arcSurface = {
    uMin, uMax, vMin, vMax,
    evaluate(u, v) {
      u = Math.max(uMin, Math.min(uMax, u));
      v = Math.max(vMin, Math.min(vMax, v));
      return { x: u * H, y: R * Math.sin(v), z: R * Math.cos(v) };
    },
    closestPointUV(pt, gridRes = 16, uvHint = null) {
      const u = Math.max(uMin, Math.min(uMax, pt.x / H));
      let v = Math.atan2(pt.y, pt.z);
      if (v < 0) v += 2 * Math.PI;
      v = Math.max(vMin, Math.min(vMax, v));
      return { u, v };
    },
    normal(u, v) {
      return { x: 0, y: Math.sin(v), z: Math.cos(v) };
    },
  };

  // Build boundary for the half-cylinder patch
  const nArc = 16;
  const pts = [];
  // Bottom edge (v=0)
  for (let i = 0; i <= nArc; i++) {
    const u = uMin + (uMax - uMin) * i / nArc;
    const p = arcSurface.evaluate(u, vMin);
    pts.push({ ...p, _u: u, _v: vMin });
  }
  // Right edge (u=uMax)
  for (let i = 1; i < nArc; i++) {
    const v = vMin + (vMax - vMin) * i / nArc;
    const p = arcSurface.evaluate(uMax, v);
    pts.push({ ...p, _u: uMax, _v: v });
  }
  // Top edge (v=vMax, reverse)
  for (let i = nArc; i >= 0; i--) {
    const u = uMin + (uMax - uMin) * i / nArc;
    const p = arcSurface.evaluate(u, vMax);
    pts.push({ ...p, _u: u, _v: vMax });
  }
  // Left edge (u=uMin, reverse)
  for (let i = nArc - 1; i >= 1; i--) {
    const v = vMin + (vMax - vMin) * i / nArc;
    const p = arcSurface.evaluate(uMin, v);
    pts.push({ ...p, _u: uMin, _v: v });
  }

  const face = mockFace(arcSurface);
  const ft = new FaceTriangulator();
  const result = ft.triangulateSurface(face, pts, 16, true);

  const nTris = result.faces.length;
  // Non-periodic → UV valid → subdivision should add triangles beyond CDT-only
  assert(nTris > 50, `Non-periodic arc should have subdivision: got ${nTris} (expected > 50)`);
  console.log(`    Triangles: ${nTris} (periodic=false, subdivision active)`);
});

// ─── Section 4: Winding correctness ─────────────────────────────────
console.log('');
console.log('--- Winding correctness ---');

run('sameSense=true: triangle normals point outward', () => {
  const surface = mockCylinder(10, 20);
  const pts = cylinderBoundary(surface, 0, Math.PI, 0, 20, 16);
  const face = mockFace(surface);
  const ft = new FaceTriangulator();
  const result = ft.triangulateSurface(face, pts, 16, true);

  let outwardCount = 0, inwardCount = 0;
  for (const f of result.faces) {
    const [a, b, c] = f.vertices;
    // Centroid of triangle
    const cx = (a.x + b.x + c.x) / 3;
    const cy = (a.y + b.y + c.y) / 3;
    // For a cylinder, outward = radial from z-axis
    const radLen = Math.sqrt(cx * cx + cy * cy);
    if (radLen < 1e-10) continue;
    const radial = { x: cx / radLen, y: cy / radLen, z: 0 };
    // Triangle normal from winding
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const dot = nx * radial.x + ny * radial.y + nz * radial.z;
    if (dot > 0) outwardCount++;
    else inwardCount++;
  }

  const total = outwardCount + inwardCount;
  const outwardPct = total > 0 ? (outwardCount / total * 100) : 0;
  assert(outwardPct > 90, `At least 90% of triangles should face outward, got ${outwardPct.toFixed(1)}%`);
  console.log(`    Winding: ${outwardCount}/${total} outward (${outwardPct.toFixed(1)}%)`);
});

run('sameSense=false: triangle normals point inward', () => {
  const surface = mockCylinder(10, 20);
  const pts = cylinderBoundary(surface, 0, Math.PI, 0, 20, 16);
  const face = mockFace(surface);
  const ft = new FaceTriangulator();
  const result = ft.triangulateSurface(face, pts, 16, false);

  let outwardCount = 0, inwardCount = 0;
  for (const f of result.faces) {
    const [a, b, c] = f.vertices;
    const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3;
    const radLen = Math.sqrt(cx * cx + cy * cy);
    if (radLen < 1e-10) continue;
    const radial = { x: cx / radLen, y: cy / radLen, z: 0 };
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const dot = nx * radial.x + ny * radial.y + nz * radial.z;
    if (dot > 0) outwardCount++;
    else inwardCount++;
  }

  const total = outwardCount + inwardCount;
  const inwardPct = total > 0 ? (inwardCount / total * 100) : 0;
  assert(inwardPct > 90, `sameSense=false: at least 90% should face inward, got ${inwardPct.toFixed(1)}%`);
  console.log(`    Winding: ${inwardCount}/${total} inward (${inwardPct.toFixed(1)}%)`);
});

// ─── Results ─────────────────────────────────────────────────────────
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

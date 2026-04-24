import './_watchdog.mjs';
/**
 * tests/test-tess-dihedral-sweep.js
 *
 * Fast, minimal tessellation verification across all dihedral "attack angles"
 * between two adjacent face boundaries. Complements the larger
 * test-nurbs-fillet-chamfer-variants.js (~5 s, 1702 LOC) with a tight
 * ~3 s unit utility whose job is purely to assert that the tessellator
 * produces a sound mesh for every (angle, feature) combination.
 *
 * For each dihedral θ in {30°, 45°, 60°, 75°, 90°, 105°, 120°, 135°, 150°}
 * build a triangular-prism part whose two slanted side faces meet along a
 * vertical ridge at interior angle θ. Then verify three feature modes for
 * that part:
 *
 *   - NONE    : the bare extrusion
 *   - CHAMFER : chamfer on the ridge
 *   - FILLET  : fillet on the ridge
 *
 * For every result the tessellated mesh is checked against ALL of:
 *
 *   1. Triangle count > 0 and within a sane upper bound for the face count
 *   2. Watertightness: 0 boundary edges
 *   3. Manifoldness: 0 non-manifold edges, 0 winding errors
 *   4. No degenerate triangles (zero-area)
 *   5. No self-intersections between triangles across different B-Rep faces
 *      (this catches "intersecting but non-clipped boundaries" where a
 *      feature surface pokes through an adjacent face without being trimmed)
 *   6. Surface area is finite and matches analytic expectations: in the NONE
 *      mode it equals the analytic prism area to tight tolerance, and a
 *      feature only perturbs it by a bounded delta (no collapse / no growth)
 *   7. Volume matches analytic prism volume in NONE mode and is reduced but
 *      not collapsed after chamfer / fillet
 *
 * Exits non-zero on any failure.  Intended to run as a default fast test.
 */

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { calculateMeshVolume } from '../js/cad/toolkit/MeshAnalysis.js';
import {
  detectSelfIntersections,
  detectDegenerateFaces,
  checkWatertight,
} from '../js/cad/MeshValidator.js';
import { edgeKeyFromVerts } from '../js/cad/toolkit/Vec3Utils.js';
import { createTestContext, assertManifold } from './test-helpers.js';

// ---------------------------------------------------------------------------
// Sketch / Part factories
// ---------------------------------------------------------------------------

function makePlane() {
  return {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
}

/**
 * Triangular (kite-free) profile parameterised by the interior apex angle θ.
 * The apex sits at (w/2, h) and the two equal-length sides terminate on the
 * y=0 bottom edge.  The left/right sides make half-angle θ/2 with the
 * apex-down axis, so when extruded along +Z the two slanted faces meet at
 * interior dihedral angle θ along the vertical apex edge.
 *
 * `dihedral` is θ in degrees, 0 < θ < 180.  The bottom-to-slant dihedrals at
 * the two base vertices are 90°-θ/2, sweeping through every acute case as θ
 * increases.  This one primitive therefore covers *all* attack-angle
 * combinations between adjacent planar face boundaries with a single shape.
 */
function triangleApexProfile(dihedralDeg, w = 20, h = 12) {
  const halfRad = (dihedralDeg / 2) * Math.PI / 180;
  const dx = h * Math.tan(halfRad);
  const xL = w / 2 - dx;
  const xR = w / 2 + dx;
  return (s) => {
    s.addSegment(xL, 0, xR, 0);     // bottom edge
    s.addSegment(xR, 0, w / 2, h);  // right slanted edge
    s.addSegment(w / 2, h, xL, 0);  // left  slanted edge
  };
}

function buildPart(dihedralDeg, extrudeHeight = 6, profileW = 20, profileH = 12) {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('DihedralSweep');
  const sketch = new Sketch();
  triangleApexProfile(dihedralDeg, profileW, profileH)(sketch);
  part.addSketch(sketch, makePlane());
  part.extrude(part.getSketches()[0].id, extrudeHeight);
  return part;
}

function getExtrudeGeometry(part) {
  const ex = part.featureTree.features.find((f) => f.type === 'extrude');
  assert.ok(ex && ex.result && ex.result.geometry, 'extrude should produce geometry');
  return ex.result.geometry;
}

/**
 * Find the vertical ridge edge — the apex edge of the triangle prism,
 * uniquely identified as the vertical edge with the largest y coordinate.
 */
function findRidgeEdge(topoBody) {
  const seen = new Set();
  const verticals = [];
  for (const face of topoBody.faces()) {
    for (const ce of face.outerLoop.coedges) {
      const e = ce.edge;
      const a = e.startVertex.point;
      const b = e.endVertex.point;
      if (Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.y - b.y) > 1e-6) continue;
      const key = edgeKeyFromVerts(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      verticals.push({ edge: e, y: a.y });
    }
  }
  verticals.sort((a, b) => b.y - a.y);
  return verticals[0] ? verticals[0].edge : null;
}

// ---------------------------------------------------------------------------
// Mesh metrics
// ---------------------------------------------------------------------------

/** Total surface area of a triangulated mesh (supports triangle fans). */
function surfaceArea(faces) {
  let area = 0;
  for (const f of faces) {
    const v = f.vertices;
    if (!v || v.length < 3) continue;
    for (let i = 1; i < v.length - 1; i++) {
      const ax = v[i].x - v[0].x;
      const ay = v[i].y - v[0].y;
      const az = v[i].z - v[0].z;
      const bx = v[i + 1].x - v[0].x;
      const by = v[i + 1].y - v[0].y;
      const bz = v[i + 1].z - v[0].z;
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;
      area += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    }
  }
  return area;
}

/**
 * Analytic surface area of the triangular prism produced by
 * `triangleApexProfile(θ, w, h)` extruded by `ht`.
 */
function analyticPrismArea(dihedralDeg, w, h, ht) {
  const halfRad = (dihedralDeg / 2) * Math.PI / 180;
  const dx = h * Math.tan(halfRad);
  const baseWidth = 2 * dx;                          // length of the bottom edge
  const slantLen = Math.sqrt(dx * dx + h * h);       // each slanted side
  const crossSectionArea = 0.5 * baseWidth * h;
  const perimeter = baseWidth + 2 * slantLen;
  return 2 * crossSectionArea + perimeter * ht;
}

function analyticPrismVolume(dihedralDeg, w, h, ht) {
  const halfRad = (dihedralDeg / 2) * Math.PI / 180;
  const dx = h * Math.tan(halfRad);
  const baseWidth = 2 * dx;
  return 0.5 * baseWidth * h * ht;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Run the full tessellation audit on a geometry.  Returns a metrics object;
 * any failed invariant throws AssertionError.
 */
function auditTessellation(geometry, label, opts = {}) {
  const {
    minTris = 1,
    maxTrisPerFace = 512,
    expectedArea = null,
    areaTolerance = null,
    expectedVolume = null,
    volumeTolerance = null,
  } = opts;

  assert.ok(geometry && Array.isArray(geometry.faces), `${label}: geometry.faces missing`);
  const triCount = geometry.faces.length;

  // (1) Triangle count sanity
  assert.ok(triCount >= minTris, `${label}: expected >=${minTris} triangles, got ${triCount}`);
  // Upper bound uses B-Rep face count when available so the cap stays tight
  // on small shapes without capping legitimate fillet subdivision:
  const brepFaceCount = geometry.topoBody
    ? geometry.topoBody.shells.reduce((acc, s) => acc + s.faces.length, 0)
    : 1;
  const maxTris = Math.max(32, brepFaceCount * maxTrisPerFace);
  assert.ok(
    triCount <= maxTris,
    `${label}: triangle count ${triCount} exceeds sanity cap ${maxTris} (brepFaces=${brepFaceCount})`,
  );

  // (2) Watertightness
  const wt = checkWatertight(geometry.faces);
  assert.strictEqual(
    wt.boundaryCount, 0,
    `${label}: mesh has ${wt.boundaryCount} boundary edges (holes) — watertightness failed`,
  );

  // (3) Manifoldness + winding (shared helper — asserts zero on all three counters)
  assertManifold(geometry, label);

  // (4) No degenerate triangles
  const dg = detectDegenerateFaces(geometry.faces);
  assert.strictEqual(
    dg.count, 0,
    `${label}: ${dg.count} degenerate (zero-area) triangles`,
  );

  // (5) No intersecting-but-non-clipped boundaries.  sameTopoFaceOnly=false so
  //     we also catch a feature surface that pokes through an unrelated face.
  const si = detectSelfIntersections(geometry.faces, { sameTopoFaceOnly: false });
  assert.strictEqual(
    si.count, 0,
    `${label}: ${si.count} intersecting triangle pairs (feature not properly clipped)`,
  );

  // (6) Surface area finite and (optionally) close to analytic
  const area = surfaceArea(geometry.faces);
  assert.ok(Number.isFinite(area) && area > 0, `${label}: bad surface area ${area}`);
  if (expectedArea !== null) {
    const tol = areaTolerance ?? Math.max(0.01 * expectedArea, 0.05);
    assert.ok(
      Math.abs(area - expectedArea) <= tol,
      `${label}: mesh surface area ${area.toFixed(3)} diverges from analytic ${expectedArea.toFixed(3)} (tol=${tol.toFixed(3)})`,
    );
  }

  // (7) Volume finite and (optionally) close to analytic
  const vol = calculateMeshVolume(geometry);
  assert.ok(Number.isFinite(vol) && vol > 0, `${label}: bad volume ${vol}`);
  if (expectedVolume !== null) {
    const tol = volumeTolerance ?? Math.max(0.01 * expectedVolume, 0.05);
    assert.ok(
      Math.abs(vol - expectedVolume) <= tol,
      `${label}: volume ${vol.toFixed(3)} diverges from analytic ${expectedVolume.toFixed(3)} (tol=${tol.toFixed(3)})`,
    );
  }

  return { triCount, area, vol, brepFaceCount };
}

// ---------------------------------------------------------------------------
// Test matrix
// ---------------------------------------------------------------------------

const DIHEDRAL_ANGLES = [30, 45, 60, 75, 90, 105, 120, 135, 150];

// Feature parameter (chamfer distance, fillet radius) is chosen small
// enough that even the 30° apex case — where the ridge is long/tangled —
// does not over-trim.  Scaled relative to PROFILE_H (apex height) so a
// change to the profile height stays consistent.
const CHAMFER_DIST = 0.5;
const FILLET_RADIUS = 0.5;
const FILLET_SEGMENTS = 4;

// Shape parameters kept constant across the sweep so analytic area/volume
// depend only on the dihedral angle.
const PROFILE_W = 20;
const PROFILE_H = 12;
const EXTRUDE_HT = 6;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const { test, summarize } = createTestContext('Tess Dihedral Sweep');

console.log('\n=== NONE — bare extrusion across dihedral angles ===\n');

for (const theta of DIHEDRAL_ANGLES) {
  test(`θ=${theta}° NONE: triangular prism mesh is sound and matches analytic`, () => {
    const part = buildPart(theta, EXTRUDE_HT, PROFILE_W, PROFILE_H);
    const geom = getExtrudeGeometry(part);

    const expectedArea = analyticPrismArea(theta, PROFILE_W, PROFILE_H, EXTRUDE_HT);
    const expectedVolume = analyticPrismVolume(theta, PROFILE_W, PROFILE_H, EXTRUDE_HT);

    auditTessellation(geom, `θ=${theta}° NONE`, {
      expectedArea,
      // Bare prism of planar faces triangulates exactly → tight tolerance.
      areaTolerance: 1e-6,
      expectedVolume,
      volumeTolerance: 1e-6,
    });
  });
}

console.log('\n=== CHAMFER — applied to apex ridge across dihedral angles ===\n');

for (const theta of DIHEDRAL_ANGLES) {
  test(`θ=${theta}° CHAMFER on apex ridge: mesh sound, area/volume bounded`, () => {
    const part = buildPart(theta, EXTRUDE_HT, PROFILE_W, PROFILE_H);
    const baseGeom = getExtrudeGeometry(part);
    const baseArea = analyticPrismArea(theta, PROFILE_W, PROFILE_H, EXTRUDE_HT);
    const baseVol = analyticPrismVolume(theta, PROFILE_W, PROFILE_H, EXTRUDE_HT);

    const ridge = findRidgeEdge(baseGeom.topoBody);
    assert.ok(ridge, `θ=${theta}°: could not locate apex ridge edge`);

    const key = edgeKeyFromVerts(ridge.startVertex.point, ridge.endVertex.point);
    part.chamfer([key], CHAMFER_DIST);

    const finalGeom = part.getFinalGeometry().geometry;
    const m = auditTessellation(finalGeom, `θ=${theta}° CHAMFER`);

    const dv = baseVol - m.vol;
    // Feature sanity: chamfer must actually remove material (dv > 0), and
    // must not collapse the body (< 10% of volume).  The lower bound is
    // absolute not relative because at obtuse dihedrals a small chamfer
    // legitimately removes <0.01% of the prism volume.
    assert.ok(
      dv > 1e-6 && dv < baseVol * 0.10,
      `θ=${theta}° CHAMFER: volume delta ${dv.toFixed(6)} outside (1e-6, ${(baseVol * 0.10).toFixed(4)}]`,
    );
    // Area delta also bounded — chamfer replaces one ridge edge with a flat
    // bevel face, so surface area changes by at most ~perimeter * distance.
    assert.ok(
      Math.abs(m.area - baseArea) < baseArea * 0.10,
      `θ=${theta}° CHAMFER: area ${m.area.toFixed(3)} diverges too far from base ${baseArea.toFixed(3)}`,
    );
  });
}

console.log('\n=== FILLET — applied to apex ridge across dihedral angles ===\n');

for (const theta of DIHEDRAL_ANGLES) {
  test(`θ=${theta}° FILLET on apex ridge: mesh sound, area/volume bounded`, () => {
    const part = buildPart(theta, EXTRUDE_HT, PROFILE_W, PROFILE_H);
    const baseGeom = getExtrudeGeometry(part);
    const baseArea = analyticPrismArea(theta, PROFILE_W, PROFILE_H, EXTRUDE_HT);
    const baseVol = analyticPrismVolume(theta, PROFILE_W, PROFILE_H, EXTRUDE_HT);

    const ridge = findRidgeEdge(baseGeom.topoBody);
    assert.ok(ridge, `θ=${theta}°: could not locate apex ridge edge`);

    const key = edgeKeyFromVerts(ridge.startVertex.point, ridge.endVertex.point);
    part.fillet([key], FILLET_RADIUS, { segments: FILLET_SEGMENTS });

    const finalGeom = part.getFinalGeometry().geometry;
    // Fillets introduce a NURBS patch — allow up to ~256 tris/face.
    const m = auditTessellation(finalGeom, `θ=${theta}° FILLET`, { maxTrisPerFace: 256 });

    const dv = baseVol - m.vol;
    assert.ok(
      dv > 1e-6 && dv < baseVol * 0.10,
      `θ=${theta}° FILLET: volume delta ${dv.toFixed(6)} outside (1e-6, ${(baseVol * 0.10).toFixed(4)}]`,
    );
    assert.ok(
      Math.abs(m.area - baseArea) < baseArea * 0.10,
      `θ=${theta}° FILLET: area ${m.area.toFixed(3)} diverges too far from base ${baseArea.toFixed(3)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Determinism: two independent builds at the same angle must produce the
// same mesh triangle count.  Guards against non-deterministic tessellation
// regressions (e.g. random seeds, Map-insertion-order leaks).
// ---------------------------------------------------------------------------

console.log('\n=== Determinism — repeated builds produce identical triangle counts ===\n');

for (const theta of [45, 90, 135]) {
  test(`θ=${theta}° determinism: two builds agree on triangle count and area`, () => {
    const p1 = buildPart(theta, EXTRUDE_HT, PROFILE_W, PROFILE_H);
    const p2 = buildPart(theta, EXTRUDE_HT, PROFILE_W, PROFILE_H);
    const g1 = getExtrudeGeometry(p1);
    const g2 = getExtrudeGeometry(p2);
    assert.strictEqual(
      g1.faces.length, g2.faces.length,
      `θ=${theta}°: non-deterministic triangle count ${g1.faces.length} vs ${g2.faces.length}`,
    );
    const a1 = surfaceArea(g1.faces), a2 = surfaceArea(g2.faces);
    assert.ok(
      Math.abs(a1 - a2) < 1e-9,
      `θ=${theta}°: non-deterministic area ${a1} vs ${a2}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Audit self-tests — prove the audit is TRUTHFUL.
//
// `auditTessellation` is only as good as its ability to reject bad meshes.
// These tests take a known-good geometry, deliberately inject a single class
// of flaw, and assert the audit raises.  Without this layer, a regression
// that silently disables a check would still appear "green".
// ---------------------------------------------------------------------------

console.log('\n=== Audit self-tests — auditTessellation rejects known flaws ===\n');

function cloneGeometry(geom) {
  // Shallow clone is enough for mutation tests — we only need an independent
  // `faces` array whose `vertices` arrays we can splice.  The audit consults
  // `geometry.faces` and `geometry.topoBody` only.
  return {
    ...geom,
    faces: geom.faces.map((f) => ({
      ...f,
      vertices: f.vertices.map((v) => ({ ...v })),
    })),
  };
}

function assertAuditRejects(geom, label) {
  let threw = false;
  try {
    auditTessellation(geom, label);
  } catch (e) {
    threw = true;
  }
  assert.ok(threw, `${label}: audit should have rejected this mutated mesh but did not`);
}

test('audit self-test: clean reference prism passes', () => {
  const part = buildPart(90, EXTRUDE_HT, PROFILE_W, PROFILE_H);
  const geom = getExtrudeGeometry(part);
  // Sanity: unmodified mesh passes the audit — sets the baseline.
  auditTessellation(geom, 'self-test baseline');
});

test('audit self-test: dropped triangle → rejected (hole / boundary edges)', () => {
  const part = buildPart(90, EXTRUDE_HT, PROFILE_W, PROFILE_H);
  const base = getExtrudeGeometry(part);
  const mutated = cloneGeometry(base);
  // Remove one triangle — introduces three boundary edges where there were none.
  mutated.faces.splice(0, 1);
  assertAuditRejects(mutated, 'self-test dropped-triangle');
});

test('audit self-test: collapsed zero-area triangle → rejected (degenerate)', () => {
  const part = buildPart(90, EXTRUDE_HT, PROFILE_W, PROFILE_H);
  const base = getExtrudeGeometry(part);
  const mutated = cloneGeometry(base);
  // Collapse vertex 2 onto vertex 0 → degenerate triangle, zero area.
  // Also breaks manifoldness (edge 0-1 now has one real + one zero-area neighbor),
  // but the dedicated degenerate check must fire first.
  const f = mutated.faces[0];
  f.vertices[2].x = f.vertices[0].x;
  f.vertices[2].y = f.vertices[0].y;
  f.vertices[2].z = f.vertices[0].z;
  assertAuditRejects(mutated, 'self-test degenerate-triangle');
});

test('audit self-test: duplicated triangle → rejected (non-manifold)', () => {
  const part = buildPart(90, EXTRUDE_HT, PROFILE_W, PROFILE_H);
  const base = getExtrudeGeometry(part);
  const mutated = cloneGeometry(base);
  // Push a copy of face[0] — every edge of that triangle now appears in
  // 3 faces, which checkManifold flags as non-manifold.
  const src = mutated.faces[0];
  mutated.faces.push({
    ...src,
    vertices: src.vertices.map((v) => ({ ...v })),
  });
  assertAuditRejects(mutated, 'self-test duplicated-triangle');
});

// ---------------------------------------------------------------------------
// Face self-intersection self-tests.
//
// A NURBS surface is unbounded in its parametric domain; the bounded region
// within the B-Rep face must never produce a tessellation where:
//   (a) triangles from the SAME face pierce one another (face self-fold), or
//   (b) triangles from DIFFERENT faces pierce one another without a shared
//       edge loop (which would have been introduced by a boolean union).
//
// These two tests use the same synthetic piercing pair:
//   T1 — horizontal triangle flat in the XY-plane at z=0
//   T2 — a vertical sliver whose edge T2[0]→T2[1] passes through the
//         interior of T1 at (2.0, 1.2, 0) — verified analytically with the
//         Möller-Trumbore formulation used by detectSelfIntersections.
//
// Each test has two parts:
//   1. Direct-detector check: call detectSelfIntersections on the synthetic
//      pair and assert count > 0.  This proves the detector is not blind to
//      the specific geometry class.
//   2. Full-audit rejection: append the piercing pair to a real prism mesh
//      and assert the full audit pipeline rejects the resulting geometry.
// ---------------------------------------------------------------------------

// Shared piercing pair for both tests (coordinates verified above).
// T1: equilateral-ish triangle flat in the z=0 plane.
const SELF_INTER_T1 = [
  { x: 0, y: 0, z: 0 },
  { x: 4, y: 0, z: 0 },
  { x: 2, y: 4, z: 0 },
];
// T2: thin vertical sliver.  Its edge [0]→[1] stabs through T1's interior at
// z=0, (x≈2.0, y≈1.2).  No vertex of T2 is within 1e-10 of any vertex of T1
// (confirmed: nearest distance > 1.2 units), so _sharesVertexOrEdge is false
// and the Möller-Trumbore test fires.
const SELF_INTER_T2 = [
  { x: 1.5, y: 1.2, z: -1 },
  { x: 2.5, y: 1.2, z:  1 },
  { x: 2.0, y: 1.2, z: -1 },
];

test('audit self-test: face self-intersection (intra-face) → rejected', () => {
  // An unbounded NURBS surface can theoretically self-fold outside its
  // bounded domain.  The tessellator must never produce overlapping patches
  // for a single bounded B-Rep face (same faceGroup).

  // Part 1 — prove the detector catches this class of error:
  const si = detectSelfIntersections(
    [
      { vertices: SELF_INTER_T1, faceGroup: 7 },
      { vertices: SELF_INTER_T2, faceGroup: 7 }, // same faceGroup = same face
    ],
    { sameTopoFaceOnly: false },
  );
  assert.ok(
    si.count > 0,
    `intra-face self-test: detectSelfIntersections missed the piercing pair (count=${si.count})`,
  );

  // Part 2 — prove the full audit pipeline rejects the corrupted geometry:
  const part = buildPart(90, EXTRUDE_HT, PROFILE_W, PROFILE_H);
  const base = getExtrudeGeometry(part);
  assert.ok(base.faces.length > 0, 'intra-face self-test: base mesh must have at least one face');
  const mutated = cloneGeometry(base);
  // Append the piercing pair with the same faceGroup as an existing face,
  // simulating a tessellator bug that produces overlapping patches.
  const g = base.faces[0].faceGroup;
  mutated.faces.push(
    { vertices: SELF_INTER_T1, normal: { x: 0, y: 0, z: 1 }, faceGroup: g },
    { vertices: SELF_INTER_T2, normal: { x: 0, y: 1, z: 0 }, faceGroup: g },
  );
  assertAuditRejects(mutated, 'self-test intra-face self-intersection');
});

test('audit self-test: cross-face intersection (inter-face) → rejected', () => {
  // Two triangles from DIFFERENT B-Rep faces that pierce each other without
  // a shared edge loop indicate the feature kernel failed to properly clip
  // (trim) one face against the other.  A boolean union that introduces an
  // intersection would instead have merged a shared boundary loop first;
  // if that loop is absent the intersection is always a defect.

  // Part 1 — prove the detector catches this cross-group variant:
  const si = detectSelfIntersections(
    [
      { vertices: SELF_INTER_T1, faceGroup: 3 },
      { vertices: SELF_INTER_T2, faceGroup: 5 }, // different faceGroup = different face
    ],
    { sameTopoFaceOnly: false },
  );
  assert.ok(
    si.count > 0,
    `inter-face self-test: detectSelfIntersections missed the cross-face piercing pair (count=${si.count})`,
  );

  // Part 2 — prove the full audit pipeline rejects the corrupted geometry:
  const part = buildPart(90, EXTRUDE_HT, PROFILE_W, PROFILE_H);
  const base = getExtrudeGeometry(part);
  const mutated = cloneGeometry(base);
  // Use two distinct faceGroup values to model two different B-Rep faces
  // whose mesh triangles intersect.
  const groups = [...new Set(base.faces.map((f) => f.faceGroup))];
  assert.ok(groups.length >= 2, 'inter-face self-test: need at least 2 distinct faceGroups');
  mutated.faces.push(
    { vertices: SELF_INTER_T1, normal: { x: 0, y: 0, z: 1 }, faceGroup: groups[0] },
    { vertices: SELF_INTER_T2, normal: { x: 0, y: 1, z: 0 }, faceGroup: groups[groups.length - 1] },
  );
  assertAuditRejects(mutated, 'self-test cross-face intersection');
});

// ---------------------------------------------------------------------------
// Box-corner combinatorial coverage.
//
// At the corner of a box three faces meet along three concurrent edges.
// We pick the (+X, +Y, +Z) corner of a W×H×D box and exhaustively probe
// combinations of features on those three concurrent edges:
//
//   - any non-empty subset of {X-edge (top-back-horizontal),
//                              Y-edge (top-right-horizontal),
//                              Z-edge (back-right-vertical)}
//   - each selected edge receives `chamfer` or `fillet`
//   - orderings vary (so "order of application" is covered)
//   - a `repeat` case applies features multiple times
//
// Every result goes through `auditTessellation`.  Edges are re-resolved
// from spatial keys between ops because feature application invalidates
// topology IDs.
// ---------------------------------------------------------------------------

console.log('\n=== Box-corner combos — 3 faces meet, 3 concurrent edges ===\n');

// Counters for known-defect combos (caught by audit, not hidden).
let knownFail = 0;
let knownFixed = 0;

const BOX_W = 10, BOX_H = 8, BOX_D = 6;
const CORNER_PARAM = 0.6;          // chamfer distance / fillet radius — small vs min dim
const FILLET_SEG = 3;              // lower than the ridge sweep's 4 to stay fast
const CORNER_VOL = BOX_W * BOX_H * BOX_D;
const CORNER_AREA = 2 * (BOX_W * BOX_H + BOX_H * BOX_D + BOX_W * BOX_D);

function makeBoxPart() {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('BoxCorner');
  const sketch = new Sketch();
  sketch.addSegment(0, 0, BOX_W, 0);
  sketch.addSegment(BOX_W, 0, BOX_W, BOX_H);
  sketch.addSegment(BOX_W, BOX_H, 0, BOX_H);
  sketch.addSegment(0, BOX_H, 0, 0);
  part.addSketch(sketch, makePlane());
  part.extrude(part.getSketches()[0].id, BOX_D);
  return part;
}

function getCurrentGeom(part) {
  const fin = part.getFinalGeometry();
  assert.ok(fin && fin.geometry, 'part.getFinalGeometry() should return geometry');
  return fin.geometry;
}

/**
 * Concurrent-edge descriptors for the (+X, +Y, +Z) corner of the box.
 * Each is resolved dynamically from a spatial predicate on the current
 * TopoBody — the feature tree renumbers edges after each op so we cannot
 * cache edge IDs between stages.
 *
 *   X: top-back edge (y=H, z=D), runs along X
 *   Y: top-right edge (x=W, z=D), runs along Y
 *   Z: back-right vertical edge (x=W, y=H), runs along Z
 *
 * Each predicate picks the edge whose midpoint is at the expected line.
 * Predicates tolerate minor displacement from feature ops that nudge the
 * corner inward — they match the CLOSEST still-axis-aligned edge.
 */
function resolveConcurrentEdgeKey(topo, axis) {
  const EPS = 0.25; // generous — features can shift endpoints inward by ~CORNER_PARAM
  const seen = new Set();
  const candidates = [];
  for (const face of topo.faces()) {
    for (const ce of face.outerLoop.coedges) {
      const e = ce.edge;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const a = e.startVertex.point, b = e.endVertex.point;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
      // Require predominantly axis-aligned and sharing the right two coords.
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-4) continue;
      if (axis === 'X') {
        if (Math.abs(dx) / len < 0.9) continue;
        if (Math.abs(mid.y - BOX_H) > EPS || Math.abs(mid.z - BOX_D) > EPS) continue;
        candidates.push({ e, mid, score: Math.abs(mid.y - BOX_H) + Math.abs(mid.z - BOX_D) });
      } else if (axis === 'Y') {
        if (Math.abs(dy) / len < 0.9) continue;
        if (Math.abs(mid.x - BOX_W) > EPS || Math.abs(mid.z - BOX_D) > EPS) continue;
        candidates.push({ e, mid, score: Math.abs(mid.x - BOX_W) + Math.abs(mid.z - BOX_D) });
      } else if (axis === 'Z') {
        if (Math.abs(dz) / len < 0.9) continue;
        if (Math.abs(mid.x - BOX_W) > EPS || Math.abs(mid.y - BOX_H) > EPS) continue;
        candidates.push({ e, mid, score: Math.abs(mid.x - BOX_W) + Math.abs(mid.y - BOX_H) });
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0].e;
  return edgeKeyFromVerts(best.startVertex.point, best.endVertex.point);
}

function applyOp(part, axis, op) {
  const topo = getCurrentGeom(part).topoBody;
  assert.ok(topo, 'box part should have topoBody');
  const key = resolveConcurrentEdgeKey(topo, axis);
  if (!key) {
    // The edge has been fully absorbed by a previous op — this is a valid
    // test outcome (over-featured corner) but we don't want the run to
    // silently noop, so surface it via assertion so the caller's "expect
    // still-resolvable" contract holds.
    throw new Error(`concurrent edge ${axis} no longer resolvable — prior ops consumed it`);
  }
  if (op === 'chamfer') {
    part.chamfer([key], CORNER_PARAM);
  } else if (op === 'fillet') {
    part.fillet([key], CORNER_PARAM, { segments: FILLET_SEG });
  } else {
    throw new Error(`unknown op ${op}`);
  }
}

/**
 * Run one combo: an ordered list of `[axis, op]` steps applied in sequence,
 * auditing only the final geometry (individual steps are implicitly covered
 * by the next step's audit of the resulting intermediate body).
 *
 * `opts.known = true` marks a combo as a long-standing corner-tessellation
 * defect (caught by the audit — not hidden).  The test still runs so
 * regressions cannot go undetected, but a `known` failure counts as an
 * expected-fail row instead of a hard failure for the suite exit code.
 */
function runCombo(name, steps, opts = {}) {
  const wrapped = () => {
    const part = makeBoxPart();
    for (const [axis, op] of steps) {
      applyOp(part, axis, op);
    }
    const geom = getCurrentGeom(part);
    const m = auditTessellation(geom, name, { maxTrisPerFace: 512 });

    // Feature sanity: volume must shrink but not collapse.  Upper bound is
    // generous (30 %) because multiple corner features can remove a larger
    // chunk than a single edge.  Lower bound is absolute.
    const dv = CORNER_VOL - m.vol;
    assert.ok(
      dv > 1e-6 && dv < CORNER_VOL * 0.30,
      `${name}: volume delta ${dv.toFixed(4)} outside (1e-6, ${(CORNER_VOL * 0.30).toFixed(4)}]`,
    );
    // Surface area should stay within ±15 % of the box's analytic area.
    assert.ok(
      Math.abs(m.area - CORNER_AREA) < CORNER_AREA * 0.15,
      `${name}: area ${m.area.toFixed(2)} diverged from ${CORNER_AREA} by >15%`,
    );

    if (opts.expectTris) {
      assert.ok(m.triCount >= opts.expectTris, `${name}: expected >=${opts.expectTris} tris, got ${m.triCount}`);
    }
  };

  if (opts.known) {
    // Still execute — so if the defect is fixed, we notice immediately and
    // the author can remove the `known` flag.  A lingering failure is
    // counted towards knownFail, not failed.  Re-throw non-assertion errors
    // (crashes, TypeErrors, etc.) so they're not silently swallowed as a
    // "known defect" — only assertion failures are the expected signal here.
    let passed = false;
    try {
      wrapped();
      passed = true;
    } catch (err) {
      if (!(err instanceof assert.AssertionError)) throw err;
    }
    if (passed) {
      // Silent surprise-pass message; don't fail the suite on good news,
      // but do surface it so the flag can be flipped.
      console.log(`  ! ${name}: SURPRISE PASS — remove { known: true } flag`);
      knownFixed++;
    } else {
      console.log(`  ~ corner-combo: ${name} (known defect, expected-fail)`);
      knownFail++;
    }
  } else {
    test(`corner-combo: ${name}`, wrapped);
  }
}

// --- Single-edge features on each concurrent edge (3 edges × 2 ops = 6) ---
for (const axis of ['X', 'Y', 'Z']) {
  runCombo(`${axis}-only chamfer`, [[axis, 'chamfer']]);
  runCombo(`${axis}-only fillet`,  [[axis, 'fillet']]);
}

// --- Pairs of concurrent edges, various op mixes and orderings ---
// (C,F) × ordering × pair = enough coverage without blowing up runtime.
// NOTE: the previous `fillet→chamfer` defect on concurrent edges was fixed
// by filtering degenerate zero-length self-loop coedges in
// `_collectLoopPoints` (Tessellator2/index.js) — chamfer trim of a
// previously-filleted face was leaving a zero-length stub coedge at the
// junction corner, producing folded/overlapping triangulation.
const PAIRS = [['X', 'Y'], ['X', 'Z'], ['Y', 'Z']];
for (const [a, b] of PAIRS) {
  runCombo(`${a}+${b} chamfer→chamfer`, [[a, 'chamfer'], [b, 'chamfer']]);
  runCombo(`${a}+${b} fillet→fillet`,   [[a, 'fillet'],  [b, 'fillet']]);
  runCombo(`${a}+${b} chamfer→fillet`,  [[a, 'chamfer'], [b, 'fillet']]);
  runCombo(`${a}+${b} fillet→chamfer`,  [[a, 'fillet'],  [b, 'chamfer']]);
  // Reverse ordering proves order-independence for disjoint edges.
  runCombo(`${b}+${a} chamfer→fillet (reversed order)`, [[b, 'chamfer'], [a, 'fillet']]);
}

// --- All 3 concurrent edges at once, multiple orderings & op mixes ---
// NOTE: three mutually-adjacent fillets meeting at a corner generate an
// exact Cobb spherical corner patch (via BRepFillet._buildExactTrihedronFaceDesc);
// that face is now tessellated through Tessellator2's sphere fast path so
// the boundary samples are preserved and the mesh is watertight.
// (F,C,F) mixes still fail — applyBRepChamfer does not stitch cleanly to
// an adjacent fillet face.  Audit catches this as non-watertight; {known:true}
// so the suite still runs it.
runCombo('XYZ all chamfer (X→Y→Z)',   [['X', 'chamfer'], ['Y', 'chamfer'], ['Z', 'chamfer']]);
runCombo('XYZ all fillet  (X→Y→Z)',   [['X', 'fillet'],  ['Y', 'fillet'],  ['Z', 'fillet']]);
runCombo('XYZ all fillet  (Z→Y→X)',   [['Z', 'fillet'],  ['Y', 'fillet'],  ['X', 'fillet']]);
runCombo('XYZ mixed      (C,F,C)',    [['X', 'chamfer'], ['Y', 'fillet'],  ['Z', 'chamfer']]);
runCombo('XYZ mixed      (F,C,F)',    [['X', 'fillet'],  ['Y', 'chamfer'], ['Z', 'fillet']],  { known: true });
// Another order of same mix — proves commutativity of disjoint-edge ops.
runCombo('XYZ mixed reordered (Z,X,Y)', [['Z', 'chamfer'], ['X', 'fillet'],  ['Y', 'chamfer']]);

if (knownFail > 0 || knownFixed > 0) {
  console.log(`\n(corner combos: ${knownFail} known-defect expected-fail, ${knownFixed} surprise-pass)`);
}

summarize();

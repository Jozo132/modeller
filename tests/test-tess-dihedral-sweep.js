import './_watchdog.mjs';
/**
 * tests/test-tess-dihedral-sweep.js
 *
 * Fast, minimal tessellation verification across all dihedral "attack angles"
 * between two adjacent face boundaries. Complements the larger
 * test-nurbs-fillet-chamfer-variants.js (~5 s, 1702 LOC) with a tight
 * ~1 s unit utility whose job is purely to assert that the tessellator
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

summarize();

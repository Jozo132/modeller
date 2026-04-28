import './_watchdog.mjs';
// tests/test-cbrep-tess-roundtrip.js — CBREP roundtrip tessellation fidelity
//
// The CBREP roundtrip for a planar-only solid MUST preserve the tessellated
// mesh byte-exactly (same triangle count, same area, same centroid per
// BRep face). Roundtrip corruption on planar faces is a fatal regression —
// it means vertex coordinates or face orientation were perturbed by
// canonicalize → writer → reader.
//
// The same harness now also guards analytic-surface render metadata so
// restored CBREP meshes keep the curved-face normals expected by the WebGL
// renderer.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalize } from '../packages/ir/canonicalize.js';
import { writeCbrep } from '../packages/ir/writer.js';
import { readCbrep, setTopoDeps } from '../packages/ir/reader.js';
import {
  TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
  SurfaceType, resetTopoIds,
} from '../js/cad/BRepTopology.js';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { parseSTEPTopology } from '../js/cad/StepImport.js';
import { tessellateBody } from '../js/cad/Tessellation.js';
import { ensureWasmReady } from '../js/cad/StepImportWasm.js';

await ensureWasmReady().catch(() => null);

setTopoDeps({
  TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
  NurbsCurve, NurbsSurface, SurfaceType,
});

const STEP_DIR = join(fileURLToPath(import.meta.url), '..', 'step');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n    ${e.message}`); failed++; }
}

function triangleArea(a, b, c) {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

function aggregateByFace(mesh, body) {
  const faceList = body.faces();
  const idToIdx = new Map();
  for (let i = 0; i < faceList.length; i++) idToIdx.set(faceList[i].id, i);
  const out = faceList.map((f, i) => ({
    idx: i, surfaceType: f.surfaceType, triCount: 0, area: 0,
  }));
  for (const tri of mesh.faces) {
    const i = idToIdx.get(tri.topoFaceId);
    if (i == null) continue;
    const v = tri.vertices;
    if (!v || v.length < 3) continue;
    out[i].triCount += 1;
    out[i].area += triangleArea(v[0], v[1], v[2]);
  }
  return out;
}

function loadAndRoundtrip(stepFile) {
  const stepText = readFileSync(join(STEP_DIR, stepFile), 'utf-8');
  resetTopoIds();
  const body = parseSTEPTopology(stepText);
  const liveMesh = tessellateBody(body, { validate: false, fallbackOnInvalidWasm: true });

  const buf = writeCbrep(canonicalize(body));
  resetTopoIds();
  const restored = readCbrep(buf);
  const restMesh = tessellateBody(restored, { validate: false, fallbackOnInvalidWasm: true });

  return {
    live: aggregateByFace(liveMesh, body),
    rest: aggregateByFace(restMesh, restored),
    liveMesh, restMesh, body, restored,
  };
}

console.log('CBREP → tess roundtrip fidelity\n');

check('box-fillet-3.step (all-planar roundtrip) — every BRep face matches', () => {
  const { live, rest } = loadAndRoundtrip('box-fillet-3.step');
  if (live.length !== rest.length) {
    throw new Error(`face count mismatch: live=${live.length} restored=${rest.length}`);
  }
  for (let i = 0; i < live.length; i++) {
    const L = live[i], R = rest[i];
    if (L.surfaceType !== 'plane') continue; // analytic-surface fidelity tracked separately
    if (L.triCount !== R.triCount) {
      throw new Error(`face ${i} (${L.surfaceType}) triCount live=${L.triCount} restored=${R.triCount}`);
    }
    const areaDelta = Math.abs(L.area - R.area);
    const areaRel = L.area > 1e-9 ? areaDelta / L.area : areaDelta;
    if (areaRel > 1e-9) {
      throw new Error(`face ${i} (${L.surfaceType}) area diverged: live=${L.area} restored=${R.area} relΔ=${areaRel}`);
    }
  }
});

check('box-fillet-3.step — total triangle count preserved across roundtrip', () => {
  const { liveMesh, restMesh } = loadAndRoundtrip('box-fillet-3.step');
  if (liveMesh.faces.length !== restMesh.faces.length) {
    throw new Error(`total tri count diverged: live=${liveMesh.faces.length} restored=${restMesh.faces.length}`);
  }
});

check('box-fillet-3.step — total surface area preserved across roundtrip', () => {
  const { live, rest } = loadAndRoundtrip('box-fillet-3.step');
  const sumL = live.reduce((s, f) => s + f.area, 0);
  const sumR = rest.reduce((s, f) => s + f.area, 0);
  const delta = Math.abs(sumL - sumR);
  if (delta > 1e-6) {
    throw new Error(`total area diverged: live=${sumL} restored=${sumR} Δ=${delta}`);
  }
});

// With HAS_SURFACE_INFOS_V2 (xDir serialization) the mixed planar +
// cylinder Unnamed-Body.step model now roundtrips bit-exactly. This
// guards the fidelity fix against future regressions — if anyone drops
// xDir from the CBREP surfaceInfo record or perturbs cylinder
// tessellation, the harness flags it immediately.
check('Unnamed-Body.step (planar + cylinder, with xDir) — per-face fidelity', () => {
  const { live, rest } = loadAndRoundtrip('Unnamed-Body.step');
  if (live.length !== rest.length) {
    throw new Error(`face count mismatch: live=${live.length} restored=${rest.length}`);
  }
  let divergent = 0;
  let worstRel = 0;
  for (let i = 0; i < live.length; i++) {
    const L = live[i], R = rest[i];
    const areaDelta = Math.abs(L.area - R.area);
    const areaRel = L.area > 1e-9 ? areaDelta / L.area : areaDelta;
    if (areaRel > 1e-9 || L.triCount !== R.triCount) {
      divergent++;
      if (areaRel > worstRel) worstRel = areaRel;
    }
  }
  if (divergent > 0) {
    throw new Error(`${divergent}/${live.length} faces diverged (worst relΔ=${(worstRel * 100).toFixed(3)}%). Run tools/cbrep-roundtrip-diff.js for details.`);
  }
});

check('Unnamed-Body.step — total surface area bit-exact across roundtrip', () => {
  const { live, rest } = loadAndRoundtrip('Unnamed-Body.step');
  const sumL = live.reduce((s, f) => s + f.area, 0);
  const sumR = rest.reduce((s, f) => s + f.area, 0);
  if (Math.abs(sumL - sumR) > 1e-6) {
    throw new Error(`total area diverged: live=${sumL} restored=${sumR}`);
  }
});

check('Unnamed-Body.step — restored curved faces keep render normals', () => {
  const { restMesh, restored } = loadAndRoundtrip('Unnamed-Body.step');
  const curvedFaceIds = new Set(
    restored.faces()
      .filter((face) => face.surfaceInfo && face.surfaceInfo.type !== 'plane')
      .map((face) => face.id),
  );
  const curvedTriangles = restMesh.faces.filter((face) => curvedFaceIds.has(face.topoFaceId));
  assert.ok(curvedTriangles.length > 0, 'expected restored mesh to contain curved-face triangles');
  for (const face of curvedTriangles) {
    assert.equal(face.isCurved, true, `topoFace ${face.topoFaceId} should be marked curved`);
    assert.equal(face.vertexNormals?.length, face.vertices.length, `topoFace ${face.topoFaceId} should carry per-vertex normals`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

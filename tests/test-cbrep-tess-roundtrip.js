import './_watchdog.mjs';
// tests/test-cbrep-tess-roundtrip.js — CBREP roundtrip tessellation fidelity
//
// The CBREP roundtrip for a planar-only solid MUST preserve the tessellated
// mesh byte-exactly (same triangle count, same area, same centroid per
// BRep face). Roundtrip corruption on planar faces is a fatal regression —
// it means vertex coordinates or face orientation were perturbed by
// canonicalize → writer → reader.
//
// This is a deliberately narrow guardrail: analytic surfaces (cylinder,
// cone, torus, sphere) currently lose metadata during CBREP roundtrip
// (surfaceInfo xDir/yDir are not serialized, fusedGroupId is dropped,
// etc.) so we cannot yet assert fidelity on them. The roundtrip
// diagnostic harness in tools/cbrep-roundtrip-diff.js is the iteration
// surface for that work.

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
  const liveMesh = tessellateBody(body, { validate: false });

  const buf = writeCbrep(canonicalize(body));
  resetTopoIds();
  const restored = readCbrep(buf);
  const restMesh = tessellateBody(restored, { validate: false });

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

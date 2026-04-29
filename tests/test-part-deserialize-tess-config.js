import './_watchdog.mjs';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { globalTessConfig } from '../js/cad/TessellationConfig.js';
import { computeFeatureEdges } from '../js/cad/EdgeAnalysis.js';
import { tessellateBody } from '../js/cad/Tessellation.js';
import { ensureWasmReady } from '../js/cad/StepImportWasm.js';
import { calculateMeshVolume, calculateBoundingBox } from '../js/cad/toolkit/MeshAnalysis.js';
import {
  TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
  SurfaceType,
} from '../js/cad/BRepTopology.js';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { canonicalize } from '../packages/ir/canonicalize.js';
import { writeCbrep } from '../packages/ir/writer.js';
import { readCbrep, setTopoDeps } from '../packages/ir/reader.js';

await ensureWasmReady().catch(() => null);

setTopoDeps({
  TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
  NurbsCurve, NurbsSurface, SurfaceType,
});

const SAMPLE_DIR = join(fileURLToPath(import.meta.url), '..', 'samples');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL  ${name}\n    ${error.message}`);
    failed++;
  }
}

function assignGlobalTess(config) {
  Object.assign(globalTessConfig, config);
}

function deserializeUnnamedBodyWithGlobal(globalConfig) {
  const cmod = parseCMOD(readFileSync(join(SAMPLE_DIR, 'Unnamed-Body.cmod'), 'utf8'));
  const partData = cmod.data.part;
  assignGlobalTess(globalConfig);
  const part = Part.deserialize(partData);
  const feature = part.featureTree.features.find((candidate) => candidate.type === 'step-import');
  const result = part.featureTree.getFinalResult();

  return {
    savedConfig: partData.tessellationConfig,
    feature,
    triangleCount: result?.geometry?.faces?.length || 0,
  };
}

function fastRestoreDeps() {
  return {
    readCbrep,
    tessellateBody,
    computeFeatureEdges,
    calculateMeshVolume,
    calculateBoundingBox,
  };
}

function serializedUnnamedBodyWithCheckpoint() {
  const cmod = parseCMOD(readFileSync(join(SAMPLE_DIR, 'Unnamed-Body.cmod'), 'utf8'));
  const part = Part.deserialize(cmod.data.part);
  const result = part.featureTree.getFinalResult();
  const body = result?.body || result?.solid?.body || result?.geometry?.topoBody;
  assert.ok(body, 'expected Unnamed-Body deserialize to produce a TopoBody');

  const cbrep = writeCbrep(canonicalize(body));
  const feature = part.featureTree.features.find((candidate) => candidate.type === 'step-import');
  assert.ok(feature, 'expected Unnamed-Body to contain a STEP import feature');
  assert.equal(part.featureTree.attachCbrep(feature.id, cbrep, null), true, 'expected checkpoint attach to succeed');
  return part.serialize();
}

console.log('Part deserialize tessellation config\n');

check('Unnamed-Body.cmod restore uses saved tessellation before STEP replay', () => {
  const savedRun = deserializeUnnamedBodyWithGlobal({
    curveSegments: 16,
    surfaceSegments: 8,
    edgeSegments: 16,
    adaptiveSubdivision: true,
    tessellator: 'legacy',
  });

  const poisonedRun = deserializeUnnamedBodyWithGlobal({
    curveSegments: 64,
    surfaceSegments: 16,
    edgeSegments: 64,
    adaptiveSubdivision: true,
    tessellator: 'legacy',
  });

  assert.equal(
    poisonedRun.feature?._cachedMesh?.curveSegments,
    poisonedRun.savedConfig.curveSegments,
    'STEP import replay must use the saved part curve segment count, not startup/global defaults',
  );
  assert.equal(
    poisonedRun.triangleCount,
    savedRun.triangleCount,
    `triangle count should be restore-stable (${savedRun.triangleCount} expected, ${poisonedRun.triangleCount} restored)`,
  );
});

check('deserialize tessellation override wins over serialized model quality', () => {
  const cmod = parseCMOD(readFileSync(join(SAMPLE_DIR, 'Unnamed-Body.cmod'), 'utf8'));
  const override = {
    curveSegments: 32,
    surfaceSegments: 16,
    edgeSegments: 32,
    adaptiveSubdivision: true,
    tessellator: 'legacy',
  };

  const restored = Part.deserialize(cmod.data.part, { tessellationConfigOverride: override });
  const feature = restored.featureTree.features.find((candidate) => candidate.type === 'step-import');

  assert.equal(restored.tessellationConfig.curveSegments, override.curveSegments);
  assert.equal(restored.tessellationConfig.edgeSegments, override.edgeSegments);
  assert.equal(restored.tessellationConfig.surfaceSegments, override.surfaceSegments);
  assert.equal(globalTessConfig.curveSegments, override.curveSegments);
  assert.equal(feature?._cachedMesh?.curveSegments, override.curveSegments);
  assert.equal(feature?._cachedMesh?.edgeSegments, override.edgeSegments);
  assert.equal(feature?._cachedMesh?.surfaceSegments, override.surfaceSegments);
});

check('Unnamed-Body.cmod checkpoint restore replays STEP import instead of CBREP fast restore', () => {
  const serialized = serializedUnnamedBodyWithCheckpoint();
  assert.ok(serialized.featureTree?.checkpoints, 'test fixture should include a serialized CBREP checkpoint');

  assignGlobalTess({
    curveSegments: 64,
    surfaceSegments: 16,
    edgeSegments: 64,
    adaptiveSubdivision: true,
    tessellator: 'legacy',
  });

  const restored = Part.deserialize(serialized, { fastRestoreDeps: fastRestoreDeps() });
  const result = restored.featureTree.getFinalResult();
  const feature = restored.featureTree.features.find((candidate) => candidate.type === 'step-import');

  assert.equal(result?._restoredFromCheckpoint, undefined, 'STEP imports should opt out of direct CBREP fast restore');
  assert.equal(feature?._cachedMesh?.curveSegments, serialized.tessellationConfig.curveSegments);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
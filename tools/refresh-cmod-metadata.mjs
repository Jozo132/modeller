import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCMOD, parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { ensureWasmReady, ensureOcctStepShadowReady } from '../js/cad/StepImport.js';
import { preloadWasmGeometryOps } from '../js/cad/WasmGeometryOps.js';
import { ensureOcctBooleanShadowReady, loadOcctKernelModule } from '../js/cad/occt/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_TARGET = path.join(REPO_ROOT, 'tests', 'samples');
let runtimeReadyPromise = null;

function walkForCmods(targetPath, results = []) {
  const stat = statSync(targetPath);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(targetPath)) {
      walkForCmods(path.join(targetPath, entry), results);
    }
    return results;
  }
  if (stat.isFile() && targetPath.toLowerCase().endsWith('.cmod')) {
    results.push(targetPath);
  }
  return results;
}

function resolveTargets(argv) {
  const paths = argv.length > 0 ? argv : [DEFAULT_TARGET];
  const resolvedFiles = paths.flatMap((entry) => {
    const resolved = path.resolve(process.cwd(), entry);
    return walkForCmods(resolved);
  });
  return [...new Set(resolvedFiles)].sort();
}

async function ensureRefreshRuntimeReady() {
  if (!runtimeReadyPromise) {
    runtimeReadyPromise = (async () => {
      await Promise.allSettled([
        ensureWasmReady(),
        preloadWasmGeometryOps(),
        loadOcctKernelModule(),
      ]);
      await Promise.allSettled([
        ensureOcctStepShadowReady({ occtShadow: true }),
        ensureOcctBooleanShadowReady({ occtBooleanShadow: true }),
      ]);
      return true;
    })();
  }
  return runtimeReadyPromise;
}

function collectFeatureReplayErrors(part) {
  const features = Array.isArray(part?.featureTree?.features) ? part.featureTree.features : [];
  return features
    .filter((feature) => typeof feature?.error === 'string' && feature.error.trim() !== '')
    .map((feature) => ({
      id: feature.id || null,
      name: feature.name || feature.id || 'unknown feature',
      type: feature.type || null,
      error: feature.error.trim(),
    }));
}

function withFeatureReplayCapture(run) {
  const originalConsoleError = console.error;
  const captured = [];
  console.error = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('Error executing feature ')) {
      captured.push(args[0]);
    }
    originalConsoleError.apply(console, args);
  };
  try {
    return { value: run(), captured };
  } finally {
    console.error = originalConsoleError;
  }
}

async function refreshCmod(raw) {
  await ensureRefreshRuntimeReady();
  const parsed = parseCMOD(raw);
  if (!parsed.ok) {
    throw new Error(parsed.error || 'Unknown CMOD parse failure');
  }

  const current = parsed.data;
  if (!current.part) return { refreshed: current, changed: false };

  const { value: part, captured } = withFeatureReplayCapture(() => Part.deserialize(current.part));
  const featureErrors = collectFeatureReplayErrors(part);
  if (captured.length > 0 || featureErrors.length > 0) {
    return {
      changed: false,
      skipped: true,
      reason: featureErrors[0]?.error || captured[0] || 'feature replay reported errors',
      errors: featureErrors,
    };
  }

  const rebuilt = buildCMOD(part, {
    orbit: current.orbit || null,
    settings: current.settings || null,
    scenes: Array.isArray(current.scenes) ? current.scenes : [],
    cam: current.cam || null,
    replayDiagnostics: current._replayDiagnostics || null,
    cacheStats: current._cacheStats || null,
  });

  const refreshed = {
    ...current,
    ...rebuilt,
    scene: current.scene ?? rebuilt.scene,
    layers: Array.isArray(current.layers) && current.layers.length > 0 ? current.layers : rebuilt.layers,
    activeLayer: current.activeLayer ?? rebuilt.activeLayer,
    viewport: current.viewport ?? rebuilt.viewport,
    workspaceMode: current.workspaceMode ?? rebuilt.workspaceMode,
    sessionState: current.sessionState ?? rebuilt.sessionState,
    metadata: {
      ...(rebuilt.metadata || {}),
      ...(current.metadata?.exportedAt ? { exportedAt: current.metadata.exportedAt } : {}),
    },
  };

  const nextJson = JSON.stringify(refreshed, null, 2);
  return {
    refreshed,
    nextJson,
    changed: typeof raw === 'string' ? raw.trim() !== nextJson.trim() : true,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const files = resolveTargets(args);
  if (files.length === 0) {
    console.log('No .cmod files found.');
    return;
  }

  let refreshedCount = 0;
  let unchangedCount = 0;
  let skippedCount = 0;
  for (const filePath of files) {
    const raw = readFileSync(filePath, 'utf8');
    const { nextJson, changed, skipped, reason } = await refreshCmod(raw);
    if (skipped) {
      skippedCount += 1;
      console.log(`! ${path.relative(REPO_ROOT, filePath)} :: ${reason}`);
      continue;
    }
    if (!changed) {
      unchangedCount += 1;
      console.log(`= ${path.relative(REPO_ROOT, filePath)}`);
      continue;
    }
    writeFileSync(filePath, `${nextJson}\n`, 'utf8');
    refreshedCount += 1;
    console.log(`+ ${path.relative(REPO_ROOT, filePath)}`);
  }

  console.log(`Refreshed ${refreshedCount} file(s); ${unchangedCount} unchanged; ${skippedCount} skipped.`);
  if (skippedCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
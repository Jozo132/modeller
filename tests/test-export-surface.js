import './_watchdog.mjs';
// tests/test-export-surface.js — Verify public export paths resolve correctly
//
// This test dynamically imports each package.json export path and checks
// that the expected symbols are present. It does NOT exercise runtime
// behaviour — only that the module graph resolves without errors.

import assert from 'assert';
import { readFileSync } from 'fs';
import { formatTimingSuffix, startTiming } from './test-timing.js';

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const exportEntries = Object.entries(pkg.exports);

let passed = 0;
let failed = 0;

function test(label, fn) {
  const startedAt = startTiming();
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}${formatTimingSuffix(startedAt)}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${err.message}`);
  }
}

async function asyncTest(label, fn) {
  const startedAt = startTiming();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}${formatTimingSuffix(startedAt)}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${err.message}`);
  }
}

console.log('Export-surface tests');
console.log(`  Found ${exportEntries.length} export entries in package.json`);

// ── Validate each export resolves ───────────────────────────────────

// Some exports need browser globals or WASM binaries; we skip those.
const SKIP_IMPORT = new Set(['./wasm', './render', './workers']);

for (const [subpath, spec] of exportEntries) {
  const importPath = typeof spec === 'string' ? spec : spec.import;
  if (!importPath) continue;

  if (SKIP_IMPORT.has(subpath)) {
    // For skipped paths, just verify the file reference is a string
    test(`${subpath} — entry exists (${importPath})`, () => {
      assert.ok(typeof importPath === 'string' && importPath.length > 0);
    });
    continue;
  }

  const resolvedURL = new URL(importPath, import.meta.url.replace(/tests\/[^/]+$/, '')).href;

  // eslint-disable-next-line no-await-in-loop
  await asyncTest(`${subpath} — resolves (${importPath})`, async () => {
    const mod = await import(resolvedURL);
    assert.ok(mod !== null && typeof mod === 'object', 'module is an object');
  });
}

// ── Spot-check key symbols on specific export paths ─────────────────

await asyncTest('"." exports Part, Sketch, exportSTEP', async () => {
  const mod = await import('../js/index.js');
  assert.ok(typeof mod.Part === 'function', 'Part');
  assert.ok(typeof mod.Sketch === 'function', 'Sketch');
  assert.ok(typeof mod.exportSTEP === 'function', 'exportSTEP');
});

await asyncTest('"./cad" exports BooleanResult, TessellationResult, ContainmentResult', async () => {
  const mod = await import('../js/cad/index.js');
  assert.ok(typeof mod.BooleanResult === 'function', 'BooleanResult');
  assert.ok(typeof mod.TessellationResult === 'function', 'TessellationResult');
  assert.ok(typeof mod.ContainmentResult === 'function', 'ContainmentResult');
});

await asyncTest('"./flags" exports getFlag, setFlag, resetFlags, allFlags, flagDefinitions', async () => {
  const mod = await import('../js/featureFlags.js');
  assert.ok(typeof mod.getFlag === 'function', 'getFlag');
  assert.ok(typeof mod.setFlag === 'function', 'setFlag');
  assert.ok(typeof mod.resetFlags === 'function', 'resetFlags');
  assert.ok(typeof mod.allFlags === 'function', 'allFlags');
  assert.ok(typeof mod.flagDefinitions === 'function', 'flagDefinitions');
});

await asyncTest('"./ir" exports schema + IR symbols', async () => {
  const mod = await import('../js/ir/index.js');
  assert.ok(typeof mod.CBREP_MAGIC === 'number', 'CBREP_MAGIC');
  assert.ok(typeof mod.canonicalize === 'function', 'canonicalize');
  assert.ok(typeof mod.writeCbrep === 'function', 'writeCbrep');
  assert.ok(typeof mod.readCbrep === 'function', 'readCbrep');
  assert.ok(typeof mod.hashCbrep === 'function', 'hashCbrep');
});

await asyncTest('"./cache" exports CacheStore, getNodeFsCacheStore, BrowserIdbCacheStore', async () => {
  const mod = await import('../js/cache/index.js');
  assert.ok(typeof mod.CacheStore === 'function', 'CacheStore');
  assert.ok(typeof mod.getNodeFsCacheStore === 'function', 'getNodeFsCacheStore');
  assert.ok(typeof mod.BrowserIdbCacheStore === 'function', 'BrowserIdbCacheStore');
  // Dynamic factory loads the Node-only store on demand without polluting
  // the browser-safe static import graph.
  const NodeFsCacheStore = await mod.getNodeFsCacheStore();
  assert.ok(typeof NodeFsCacheStore === 'function', 'NodeFsCacheStore class');
});

await asyncTest('"./cmod" exports buildCMOD, parseCMOD', async () => {
  const mod = await import('../js/cmod.js');
  assert.ok(typeof mod.buildCMOD === 'function', 'buildCMOD');
  assert.ok(typeof mod.parseCMOD === 'function', 'parseCMOD');
});

await asyncTest('"./logger" exports setLogLevel', async () => {
  const mod = await import('../js/logger.js');
  assert.ok(typeof mod.setLogLevel === 'function', 'setLogLevel');
});

// ── Diagnostics schema smoke test ───────────────────────────────────

await asyncTest('BooleanResult defaults and toJSON()', async () => {
  const { BooleanResult } = await import('../js/cad/diagnostics.js');
  const r = new BooleanResult();
  assert.strictEqual(r.grade, 'exact');
  assert.strictEqual(r.ok, true);
  const j = r.toJSON();
  assert.strictEqual(j.grade, 'exact');
  assert.deepStrictEqual(j.warnings, []);
});

await asyncTest('TessellationResult defaults and toJSON()', async () => {
  const { TessellationResult } = await import('../js/cad/diagnostics.js');
  const r = new TessellationResult({ vertexCount: 12, faceCount: 20 });
  assert.strictEqual(r.vertexCount, 12);
  assert.strictEqual(r.faceCount, 20);
  const j = r.toJSON();
  assert.strictEqual(j.ok, true);
});

await asyncTest('ContainmentResult defaults and toJSON()', async () => {
  const { ContainmentResult } = await import('../js/cad/diagnostics.js');
  const r = new ContainmentResult({ state: 'inside', confidence: 0.99 });
  assert.strictEqual(r.state, 'inside');
  assert.strictEqual(r.confidence, 0.99);
  const j = r.toJSON();
  assert.strictEqual(j.state, 'inside');
});

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

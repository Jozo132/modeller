// tests/bench-step-native.js
//
// Perf A/B benchmark: legacy JS STEP import path vs the native
// WASM builder + tessellator (STEP_BUILD_WASM=1).  Reports median
// wall-clock time per file so we can see the iteration-speed delta.
//
// Run:
//   node tests/bench-step-native.js
//   node tests/bench-step-native.js --runs=5 --limit=20

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const optRuns = Number(args.find(a => a.startsWith('--runs='))?.slice(7) ?? 3);
const optLimit = Number(args.find(a => a.startsWith('--limit='))?.slice(8) ?? 0);

function collect(dir) {
  const out = [];
  for (const ent of readdirSync(dir)) {
    const p = path.join(dir, ent);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...collect(p));
    else if (/\.(stp|step)$/i.test(ent)) out.push(p);
  }
  return out;
}

const candidates = [
  path.join(__dirname, 'nist-samples'),
  path.join(__dirname, 'fixtures/step'),
];
const files = [];
for (const c of candidates) {
  try { files.push(...collect(c)); } catch (_) { /* absent */ }
}
if (files.length === 0) {
  console.error('No .stp files found under tests/.');
  process.exit(1);
}
if (optLimit > 0) files.length = Math.min(optLimit, files.length);

const now = () => Number(process.hrtime.bigint()) / 1e6;
const median = arr => {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function main() {
  const { importSTEP, ensureWasmReady } = await import('../js/cad/StepImport.js');
  const { ensureStepTopologyReady } = await import('../js/cad/StepTopologyWasm.js');
  await ensureWasmReady();
  await ensureStepTopologyReady();

  const rows = [];
  console.log(`Benchmarking ${files.length} file(s), ${optRuns} run(s) each`);
  console.log('─'.repeat(112));
  console.log(
    'file'.padEnd(44) +
    'size/kB'.padStart(10) +
    'JS/ms'.padStart(12) +
    'WASM+body'.padStart(12) +
    'WASM-only'.padStart(12) +
    'spd-full'.padStart(10) +
    'spd-fast'.padStart(10) +
    'tris'.padStart(10),
  );
  console.log('─'.repeat(112));

  let totJs = 0, totWasm = 0, totFast = 0;
  for (const f of files) {
    let src;
    try { src = readFileSync(f, 'utf-8'); } catch (_) { continue; }
    if (!src) continue;

    // Legacy path
    const js = [];
    delete process.env.STEP_BUILD_WASM;
    let jsMesh = null;
    for (let i = 0; i < optRuns; i++) {
      const t = now();
      try { jsMesh = importSTEP(src, { curveSegments: 16 }); } catch (_) { jsMesh = null; }
      js.push(now() - t);
    }

    // Native path — WITH body (default)
    process.env.STEP_BUILD_WASM = '1';
    const wa = [];
    let waMesh = null;
    for (let i = 0; i < optRuns; i++) {
      const t = now();
      try { waMesh = importSTEP(src, { curveSegments: 16 }); } catch (_) { waMesh = null; }
      wa.push(now() - t);
    }

    // Native path — skipBody (mesh-only)
    const wf = [];
    let wfMesh = null;
    for (let i = 0; i < optRuns; i++) {
      const t = now();
      try { wfMesh = importSTEP(src, { curveSegments: 16, skipBody: true }); } catch (_) { wfMesh = null; }
      wf.push(now() - t);
    }
    delete process.env.STEP_BUILD_WASM;

    const jsMed = median(js);
    const waMed = median(wa);
    const wfMed = median(wf);
    const tris = wfMesh?.faces?.length ?? waMesh?.faces?.length ?? jsMesh?.faces?.length ?? 0;
    totJs += jsMed;
    totWasm += waMed;
    totFast += wfMed;
    rows.push({ f, jsMed, waMed, wfMed, tris });
    console.log(
      path.basename(f).padEnd(44) +
      (src.length / 1024).toFixed(1).padStart(10) +
      jsMed.toFixed(1).padStart(12) +
      waMed.toFixed(1).padStart(12) +
      wfMed.toFixed(1).padStart(12) +
      ((jsMed / waMed).toFixed(2) + '×').padStart(10) +
      ((jsMed / wfMed).toFixed(2) + '×').padStart(10) +
      String(tris).padStart(10),
    );
  }

  console.log('─'.repeat(112));
  console.log(
    'TOTAL'.padEnd(54) +
    totJs.toFixed(1).padStart(12) +
    totWasm.toFixed(1).padStart(12) +
    totFast.toFixed(1).padStart(12) +
    ((totJs / totWasm).toFixed(2) + '×').padStart(10) +
    ((totJs / totFast).toFixed(2) + '×').padStart(10),
  );
}

main().catch(e => { console.error(e); process.exit(1); });

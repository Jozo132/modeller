// tests/bench-split.js — measure parse vs native split
import { readdirSync, statSync, readFileSync } from 'fs';
import path from 'path';
import { importSTEP, ensureWasmReady } from '../js/cad/StepImport.js';
import { ensureStepTopologyReady } from '../js/cad/StepTopologyWasm.js';

function collect(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) collect(p, out);
    else if (/\.(stp|step)$/i.test(e)) out.push(p);
  }
  return out;
}

await ensureWasmReady();
await ensureStepTopologyReady();

const files = collect('tests/nist-samples').slice(0, 5);
process.env.STEP_BUILD_WASM = '1';

for (const f of files) {
  const src = readFileSync(f, 'utf-8');
  importSTEP(src, { curveSegments: 16 }); // warm
  const r = importSTEP(src, { curveSegments: 16 });
  const t = r.timings;
  console.log(
    path.basename(f).padEnd(44),
    'parse=' + (t.parseMs ?? 0).toFixed(1).padStart(6),
    'build=' + (t.nativeBuildMs ?? 0).toFixed(1).padStart(6),
    'tess=' + (t.nativeTessMs ?? 0).toFixed(1).padStart(6),
    'total=' + (t.totalMs ?? 0).toFixed(1).padStart(6),
  );
}

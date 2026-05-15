// For a target topoFaceId, list all triangles AND edge-uses, flagging which
// edges are 1-used (boundary), 2-used (interior manifold), or >2 (bug).
// Diagnostic-only: intentionally uses Tessellator2 compatibility code.
import './_watchdog.mjs';
import fs from 'node:fs';
import { Part } from '../js/cad/Part.js';
import { parseCMOD } from '../js/cmod.js';
import { robustTessellateBody } from '../js/cad/Tessellator2/index.js';

const raw = fs.readFileSync('tests/samples/Unnamed-Body.cmod', 'utf-8');
const parsed = parseCMOD(raw);
const part = Part.deserialize(parsed.data.part);
const body = part.getFinalGeometry().body;
const tess = robustTessellateBody(body);

const target = Number(process.argv[2] || 32);
const tris = tess.faces.filter(f => f.topoFaceId === target);
console.log(`face ${target}: ${tris.length} tris`);

const PREC = 1e-4;
const q = c => Math.round(c / PREC);
const k = v => `${q(v.x)},${q(v.y)},${q(v.z)}`;
const ek = (a, b) => {
    const ka = k(a), kb = k(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

const edgeMap = new Map();
for (let i = 0; i < tris.length; i++) {
    const [a, b, c] = tris[i].vertices;
    for (const [p, q2] of [[a, b], [b, c], [c, a]]) {
        const key = ek(p, q2);
        if (!edgeMap.has(key)) edgeMap.set(key, []);
        edgeMap.get(key).push(i);
    }
}

let b1 = 0, b2 = 0, bN = 0;
for (const uses of edgeMap.values()) {
    if (uses.length === 1) b1++;
    else if (uses.length === 2) b2++;
    else bN++;
}
console.log(`  1-use (boundary): ${b1}`);
console.log(`  2-use (interior manifold): ${b2}`);
console.log(`  >2-use (per-face non-manifold): ${bN}`);

// Dump worst 5 per-face non-manifold
const sorted = [...edgeMap.entries()].filter(([, u]) => u.length > 2).sort((a, b) => b[1].length - a[1].length);
for (const [key, uses] of sorted.slice(0, 5)) {
    console.log(`\n  edge ${key} — ${uses.length} uses`);
    for (const idx of uses) {
        const [a, b, c] = tris[idx].vertices;
        console.log(`    tri${idx}: (${a.x.toFixed(4)},${a.y.toFixed(4)},${a.z.toFixed(4)}) (${b.x.toFixed(4)},${b.y.toFixed(4)},${b.z.toFixed(4)}) (${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)})`);
    }
}

// Sample a boundary edge and find all tris using it
if (sorted.length === 0 && b1 > 0) {
    console.log('\n  Sample 1-use edges:');
    let n = 0;
    for (const [key, uses] of edgeMap) {
        if (uses.length !== 1) continue;
        const [a, b, c] = tris[uses[0]].vertices;
        console.log(`    ${key} -> tri${uses[0]} (${a.x.toFixed(3)},${a.y.toFixed(3)},${a.z.toFixed(3)}) (${b.x.toFixed(3)},${b.y.toFixed(3)},${b.z.toFixed(3)}) (${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)})`);
        if (++n >= 5) break;
    }
}

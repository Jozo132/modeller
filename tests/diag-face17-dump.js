// Dump all triangles for face 17 and the non-manifold edges with their tri indices.
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

const tris = tess.faces.filter(f => f.topoFaceId === 17);
console.log(`face 17: ${tris.length} tris`);

const PREC = 1e-9;
const q = c => Math.round(c / PREC);
const k = v => `${q(v.x)},${q(v.y)},${q(v.z)}`;
const ek = (a, b) => {
    const ka = k(a), kb = k(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

const edgeMap = new Map();
tris.forEach((f, i) => {
    const [a, b, c] = f.vertices;
    for (const [p, q2] of [[a, b], [b, c], [c, a]]) {
        const key = ek(p, q2);
        if (!edgeMap.has(key)) edgeMap.set(key, []);
        edgeMap.get(key).push(i);
    }
});

const nm = [...edgeMap.entries()].filter(([, uses]) => uses.length > 2);
console.log(`non-manifold edges: ${nm.length}`);

// Print worst 3 and dump their tris
nm.sort((a, b) => b[1].length - a[1].length);
for (const [key, uses] of nm.slice(0, 5)) {
    console.log(`\nedge ${key} — used by ${uses.length} tris: [${uses.join(',')}]`);
    for (const idx of uses) {
        const f = tris[idx];
        const [a, b, c] = f.vertices;
        console.log(`  tri${idx}: (${a.x.toFixed(4)},${a.y.toFixed(4)},${a.z.toFixed(4)}) (${b.x.toFixed(4)},${b.y.toFixed(4)},${b.z.toFixed(4)}) (${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)})`);
    }
}

// Count how many nm edges have 3 vs 4+ uses
const byCount = {};
for (const [, uses] of nm) byCount[uses.length] = (byCount[uses.length] || 0) + 1;
console.log('\nbyUseCount:', byCount);

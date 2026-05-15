// For each non-manifold edge, list all incident triangles with their topoFaceIds.
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

const PREC = 1e-4;
const q = c => Math.round(c / PREC);
const k = v => `${q(v.x)},${q(v.y)},${q(v.z)}`;
const ek = (a, b) => {
    const ka = k(a), kb = k(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

const edgeIncident = new Map();
for (let i = 0; i < tess.faces.length; i++) {
    const f = tess.faces[i];
    const [a, b, c] = f.vertices;
    for (const [p, q2] of [[a, b], [b, c], [c, a]]) {
        const key = ek(p, q2);
        if (!edgeIncident.has(key)) edgeIncident.set(key, []);
        edgeIncident.get(key).push({ i, fid: f.topoFaceId });
    }
}

const targetFace = Number(process.argv[2] || 49);
console.log(`\nNon-manifold edges touching face ${targetFace}:`);
let count = 0;
for (const [key, uses] of edgeIncident) {
    if (uses.length <= 2) continue;
    if (!uses.some(u => u.fid === targetFace)) continue;
    count++;
    const byFid = {};
    for (const u of uses) byFid[u.fid] = (byFid[u.fid] || 0) + 1;
    console.log(`  ${key} — ${uses.length} uses, byFace=${JSON.stringify(byFid)}`);
    if (count >= 10) { console.log('  ...'); break; }
}
console.log(`total (face ${targetFace}): nm edges shown above (first 10)`);

import './_watchdog.mjs';
import fs from 'node:fs';
import { Part } from '../js/cad/Part.js';
import { parseCMOD } from '../js/cmod.js';

const raw = fs.readFileSync('tests/samples/Unnamed-Body.cmod', 'utf-8');
const parsed = parseCMOD(raw);
const part = Part.deserialize(parsed.data.part);
const body = part.getFinalGeometry().body;

const target = Number(process.argv[2] || 32);
const face = body.shells[0].faces[target];
console.log(`face ${target}: surfaceType=${face.surfaceType}, sameSense=${face.sameSense}`);
console.log(`  surfaceInfo=`, JSON.stringify(face.surfaceInfo, (k, v) => typeof v === 'number' ? +v.toFixed(4) : v).slice(0, 300));
console.log(`  outerLoop coedges: ${face.outerLoop.coedges.length}`);
for (const [i, ce] of face.outerLoop.coedges.entries()) {
    const s = ce.startVertex().point, e = ce.endVertex().point;
    const curve = ce.edge?.curve;
    console.log(`    ce${i}: sameSense=${ce.sameSense}, start=(${s.x.toFixed(3)},${s.y.toFixed(3)},${s.z.toFixed(3)}) end=(${e.x.toFixed(3)},${e.y.toFixed(3)},${e.z.toFixed(3)}) curve=${curve ? (curve.type || 'nurbs') : 'null'}`);
}
console.log(`  innerLoops: ${face.innerLoops.length}`);
for (const [i, loop] of face.innerLoops.entries()) {
    console.log(`    innerLoop ${i}: ${loop.coedges.length} coedges`);
}

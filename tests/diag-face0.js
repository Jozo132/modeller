import './_watchdog.mjs';
import fs from 'node:fs';
import { Part } from '../js/cad/Part.js';
import { parseCMOD } from '../js/cmod.js';

const raw = fs.readFileSync('tests/samples/Unnamed-Body.cmod', 'utf-8');
const parsed = parseCMOD(raw);
const part = Part.deserialize(parsed.data.part);
const finalGeom = part.getFinalGeometry();
const body = finalGeom.body || finalGeom.topoBody || (finalGeom.solid && finalGeom.solid.body);

const face = body.shells[0].faces[0];
console.log('Face id:', face.id, 'surfaceType:', face.surfaceType);
console.log('Outer loop coedges:', face.outerLoop.coedges.length);

for (let i = 0; i < face.outerLoop.coedges.length; i++) {
  const ce = face.outerLoop.coedges[i];
  const e = ce.edge;
  const sv = e.startVertex ? e.startVertex.point : null;
  const ev = e.endVertex ? e.endVertex.point : null;
  console.log(`  [${i}] sameSense=${ce.sameSense} edge#${e.id} curve=${e.curve ? e.curve.constructor.name : 'null'}`);
  console.log(`       startV#${e.startVertex && e.startVertex.id}=${sv ? `(${sv.x.toFixed(3)},${sv.y.toFixed(3)},${sv.z.toFixed(3)})` : 'null'}`);
  console.log(`       endV#${e.endVertex && e.endVertex.id}=${ev ? `(${ev.x.toFixed(3)},${ev.y.toFixed(3)},${ev.z.toFixed(3)})` : 'null'}`);
  if (e.curve) {
    const p0 = e.curve.evaluate ? safeEval(e.curve, 0) : null;
    const p1 = e.curve.evaluate ? safeEval(e.curve, 1) : null;
    console.log(`       curve(0)=${fmt(p0)}  curve(1)=${fmt(p1)}`);
    const tMin = e.curve.tMin, tMax = e.curve.tMax;
    if (tMin != null && tMax != null && (tMin !== 0 || tMax !== 1)) {
      const pa = safeEval(e.curve, tMin), pb = safeEval(e.curve, tMax);
      console.log(`       curve[tMin=${tMin}]=${fmt(pa)}  curve[tMax=${tMax}]=${fmt(pb)}`);
    }
  }
}
function safeEval(c, t) { try { return c.evaluate(t); } catch { return null; } }
function fmt(p) { return p ? `(${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)})` : 'null'; }

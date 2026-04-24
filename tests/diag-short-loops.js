import './_watchdog.mjs';
import fs from 'node:fs';
import { Part } from '../js/cad/Part.js';
import { parseCMOD } from '../js/cmod.js';

const raw = fs.readFileSync('tests/samples/Unnamed-Body.cmod', 'utf-8');
const parsed = parseCMOD(raw);
const part = Part.deserialize(parsed.data.part);
const body = part.getFinalGeometry().body;

console.log('All face IDs and their surface types and loop sizes:');
let faceRangeMin = Infinity, faceRangeMax = -Infinity;
for (const shell of body.shells) {
  for (const face of shell.faces) {
    faceRangeMin = Math.min(faceRangeMin, face.id);
    faceRangeMax = Math.max(faceRangeMax, face.id);
    const outer = face.outerLoop ? face.outerLoop.coedges.length : 0;
    const inners = (face.innerLoops || []).map(l => l.coedges.length);
    if (outer <= 2 || face.id === 33 || face.id === 49) {
      console.log(`  face ${face.id} surface=${face.surfaceType} outer=${outer} inners=[${inners.join(',')}]`);
      if (face.outerLoop) {
        for (let i = 0; i < face.outerLoop.coedges.length; i++) {
          const ce = face.outerLoop.coedges[i];
          const e = ce.edge;
          console.log(`    [${i}] sameSense=${ce.sameSense} edge#${e.id} startV#${e.startVertex.id} endV#${e.endVertex.id} curve=${e.curve ? e.curve.constructor.name : 'null'}`);
        }
      }
    }
  }
}
console.log(`\nFace ID range in body: [${faceRangeMin}..${faceRangeMax}]`);
console.log('Unnamed-Body.cmod has 60 faces, Face 15122 / Face 26709 from user bug report are GLOBAL monotonic IDs from a different session — NOT indices in this file.');

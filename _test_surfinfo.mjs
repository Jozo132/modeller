import fs from 'fs';
import { Part } from './js/cad/Part.js';
import { parseCMOD } from './js/cmod.js';
import { resetFeatureIds } from './js/cad/Feature.js';
import { resetTopoIds } from './js/cad/BRepTopology.js';

resetFeatureIds();
resetTopoIds();
const raw = fs.readFileSync('tests/samples/puzzle-extrude-cc.cmod', 'utf-8');
const parsed = parseCMOD(raw);
const part = Part.deserialize(parsed.data.part);
const result = part.getFinalGeometry();
const geom = result?.geometry || result;
const shell = geom.topoBody.shells[0];

for (const face of shell.faces) {
  if (face.surfaceType === 'cylinder') {
    console.log(`Face ${face.id}: surfaceType=${face.surfaceType}, sameSense=${face.sameSense}, surfaceInfo=${JSON.stringify(face.surfaceInfo)}`);
  }
}

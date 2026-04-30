import { readFileSync } from 'node:fs';
import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { edgeVKey } from '../js/cad/toolkit/Vec3Utils.js';

const part = Part.deserialize(parseCMOD(readFileSync('tests/samples/box-fillet-2-s-1.cmod', 'utf8')).data.part);
const geometry = part.getFinalGeometry().geometry;
for (const face of geometry.topoBody.faces()) {
  if (![24,27,28,29].includes(face.id)) continue;
  console.log('face', face.id, face.surfaceType, 'coedges', face.outerLoop.coedges.length, 'rolling', !!face.shared?.isRollingFillet, 'fillet', !!face.shared?.isFillet);
  for (const coedge of face.outerLoop.coedges) {
    const edge = coedge.edge;
    const a = coedge.sameSense === false ? edge.endVertex.point : edge.startVertex.point;
    const b = coedge.sameSense === false ? edge.startVertex.point : edge.endVertex.point;
    console.log(edge.id, coedge.sameSense, edgeVKey(a), '->', edgeVKey(b));
  }
}

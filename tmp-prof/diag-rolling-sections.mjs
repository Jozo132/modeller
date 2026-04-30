import { readFileSync } from 'node:fs';
import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { edgeVKey } from '../js/cad/toolkit/Vec3Utils.js';

const part = Part.deserialize(parseCMOD(readFileSync('tests/samples/box-fillet-2-s-1.cmod', 'utf8')).data.part);
const geometry = part.getFinalGeometry().geometry;
const topoBody = geometry.topoBody;

console.log('topo faces', topoBody.faces().length, 'triangles', geometry.faces.length);

for (const face of topoBody.faces()) {
  const shared = face.shared;
  if (!shared || (!shared.isFillet && !shared.isRollingFillet)) continue;
  const coedges = face.outerLoop?.coedges || [];
  console.log('FACE', face.id, face.surfaceType, 'rolling', !!shared.isRollingFillet, 'coedges', coedges.length, 'rails', shared._rollingRail0?.length || 0);
  if (!shared.isRollingFillet) continue;
  console.log(' rail0Spans', JSON.stringify(shared._rollingRail0Spans || null));
  console.log(' rail1Spans', JSON.stringify(shared._rollingRail1Spans || null));
  console.log(' sections', JSON.stringify(shared._rollingSections || null));
  const stationIndexes = [...Array.from({ length: 16 }, (_, index) => index), 126, 127, 128, 129, 130, 139, 140]
    .filter((index, position, values) => index >= 0 && index < shared._rollingRail0.length && values.indexOf(index) === position);
  for (const index of stationIndexes) {
    console.log(
      ' station', index,
      'r0', edgeVKey(shared._rollingRail0[index]),
      'r1', edgeVKey(shared._rollingRail1[index]),
      'center', edgeVKey(shared._rollingCenters[index]),
    );
  }
  for (let i = 0; i < coedges.length; i++) {
    const coedge = coedges[i];
    const edge = coedge.edge;
    const owners = (edge.coedges || []).map((owner) => owner.face?.id).filter((id) => id !== undefined);
    console.log('  coedge', i, 'edge', edge.id, 'same', coedge.sameSense, 'deg', edge.curve?.degree, 'cps', edge.curve?.controlPoints?.length || 0, edgeVKey(edge.startVertex.point), '->', edgeVKey(edge.endVertex.point), 'owners', owners.join(','));
  }
}
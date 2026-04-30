import { readFileSync } from 'node:fs';
import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { detectBoundaryEdges } from '../js/cad/MeshValidator.js';
import { edgeVKey } from '../js/cad/toolkit/Vec3Utils.js';

const part = Part.deserialize(parseCMOD(readFileSync('tests/samples/box-fillet-2-s-1.cmod', 'utf8')).data.part);
const geometry = part.getFinalGeometry().geometry;
const boundary = detectBoundaryEdges(geometry.faces);
console.log('boundary count', boundary.count);
for (const edge of boundary.edges.slice(0, 80)) {
  console.log(edgeVKey(edge.a), '->', edgeVKey(edge.b));
}

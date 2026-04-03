import { Part } from '../js/cad/Part.js';
import { parseCMOD } from '../js/cmod.js';
import fs from 'fs';

process.env.DEBUG_BREP_CHAMFER = '1';

const raw = fs.readFileSync('./tests/samples/puzzle-extrude-cc2.cmod', 'utf-8');
const parsed = parseCMOD(raw);
if (!parsed.ok) throw new Error(parsed.error);

const part = Part.deserialize(parsed.data.part);

const features = part.getFeatures();
console.log('Features:', features.map(f => `${f.type} ${f.name || ''}`).join(', '));

// Inspect Extrude result
const extrudeResult = features[1]?.result;
const extGeom = extrudeResult?.geometry;
const extTopo = extGeom?.topoBody || extrudeResult?.topoBody;
console.log('\n--- Extrude output ---');
console.log('Extrude has topoBody:', !!extTopo);
if (extTopo && extTopo.shells) {
  for (const shell of extTopo.shells) {
    const edges = [...shell.edges()];
    console.log(`Shell: ${shell.faces.length} faces, ${edges.length} edges`);
    for (const edge of edges) {
      const curve = edge.curve;
      const isLinear = !curve || (curve.degree === 1 && curve.controlPoints?.length === 2);
      if (!isLinear) {
        const s = edge.startVertex.point, e = edge.endVertex.point;
        console.log(`  Curved edge: deg=${curve?.degree} ctrl=${curve?.controlPoints?.length} start=(${s.x.toFixed(5)},${s.y.toFixed(5)},${s.z.toFixed(5)}) end=(${e.x.toFixed(5)},${e.y.toFixed(5)},${e.z.toFixed(5)})`);
        // Show first 3 tessellated points at 16 segments
        const pts = edge.tessellate(16);
        console.log(`    tessellate(16): ${pts.length} points`);
        if (pts.length > 2) {
          console.log(`      pt[0]=(${pts[0].x.toFixed(5)},${pts[0].y.toFixed(5)},${pts[0].z.toFixed(5)})`);
          console.log(`      pt[1]=(${pts[1].x.toFixed(5)},${pts[1].y.toFixed(5)},${pts[1].z.toFixed(5)})`);
        }
      }
    }
  }
}

// Inspect Chamfer 1 edge keys
const chamfer1 = features[2];
const chamfer1Keys = chamfer1?.edgeKeys || [];
console.log('\n--- Chamfer 1 edge keys ---');
console.log('Total keys:', chamfer1Keys.length);
if (chamfer1Keys.length > 0) {
  console.log('First 5 keys:');
  for (let i = 0; i < Math.min(5, chamfer1Keys.length); i++) {
    console.log(`  [${i}] ${chamfer1Keys[i]}`);
  }
}

const result = part.getFinalGeometry();
const geom = result?.geometry;
console.log('\n--- Final ---');
console.log('Final faces:', geom?.faces?.length || 'none');
console.log('Final topoBody:', !!(result?.topoBody));
console.log('Final exact:', result?._exactTopology || 'n/a');

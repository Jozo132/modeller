import './_watchdog.mjs';
import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { applyBRepChamfer } from '../js/cad/CSG.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { tessellateBody } from '../js/cad/Tessellation.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  const startedAt = startTiming();
  try {
    fn();
    console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function edgeKey(a, b) {
  return [a, b]
    .map((point) => `${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)}`)
    .sort()
    .join('|');
}

function countBoundaryEdges(body) {
  const edgeRefs = new Map();
  for (const face of body.shells[0].faces) {
    for (const coedge of face.outerLoop.coedges) {
      edgeRefs.set(coedge.edge.id, (edgeRefs.get(coedge.edge.id) || 0) + 1);
    }
  }
  let boundaryEdges = 0;
  for (const count of edgeRefs.values()) {
    if (count < 2) boundaryEdges++;
  }
  return boundaryEdges;
}

function makePlane() {
  return {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
}

function makeBoxPart() {
  const part = new Part('Box');
  const sketch = new Sketch();
  sketch.addSegment(0, 0, 20, 0);
  sketch.addSegment(20, 0, 20, 10);
  sketch.addSegment(20, 10, 0, 10);
  sketch.addSegment(0, 10, 0, 0);
  part.addSketch(sketch, makePlane());
  part.extrude(part.getSketches()[0].id, 10);
  return part;
}

function makeArcPart() {
  const part = new Part('ArcTest');
  const sketch = new Sketch();
  sketch.addSegment(-10, -10, -10, 10);
  sketch.addSegment(-10, 10, 10, 10);
  sketch.addArc(10, 0, 10, Math.PI / 2, -Math.PI / 2);
  sketch.addSegment(10, -10, -10, -10);
  part.addSketch(sketch, makePlane());
  part.extrude(part.getSketches()[0].id, 10);
  return part;
}

function validateExactChamfer(part, edgeSelector, distance) {
  const extrude = part.featureTree.features.find((feature) => feature.type === 'extrude');
  const geometry = extrude.result.geometry;
  const selectedEdge = edgeSelector(geometry.edges || []);
  assert.ok(selectedEdge, 'Expected an edge selection for chamfer');

  const result = applyBRepChamfer(geometry, [edgeKey(selectedEdge.start, selectedEdge.end)], distance);
  assert.ok(result, 'Exact chamfer should return a geometry');
  assert.ok(result.topoBody, 'Exact chamfer should produce a topoBody');
  assert.ok(result.topoBody.shells[0].faces.length >= 7, 'Chamfered body should add a face');
  assert.strictEqual(countBoundaryEdges(result.topoBody), 0, 'Chamfered topoBody should be closed');

  const tess = tessellateBody(result.topoBody, { validate: true });
  assert.strictEqual(tess.boundaryEdges ?? 0, 0, 'Tessellation should have no boundary edges');
  assert.strictEqual(tess.nonManifoldEdges ?? 0, 0, 'Tessellation should have no non-manifold edges');
}

console.log('=== Exact B-Rep Chamfer Tests ===\n');

test('Planar box edge chamfer builds a closed topoBody', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = makeBoxPart();
  validateExactChamfer(
    part,
    (edges) => edges.find((edge) => Math.abs(edge.start.z - 10) < 1e-6 && Math.abs(edge.end.z - 10) < 1e-6),
    1,
  );
});

test('Curved extrusion edge chamfer builds a closed topoBody', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = makeArcPart();
  validateExactChamfer(
    part,
    (edges) => edges.find((edge) =>
      Math.abs(edge.start.z - 10) < 1e-6 &&
      Math.abs(edge.end.z - 10) < 1e-6 &&
      Math.abs(edge.start.x - edge.end.x) > 0.5 &&
      Math.abs(edge.start.y - edge.end.y) > 0.01
    ),
    1,
  );
});

test('ChamferFeature uses exact path for curved extrusion edge', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = makeArcPart();
  const extrude = part.featureTree.features.find((feature) => feature.type === 'extrude');
  const geometry = extrude.result.geometry;
  const selectedEdge = (geometry.edges || []).find((edge) =>
    Math.abs(edge.start.z - 10) < 1e-6 &&
    Math.abs(edge.end.z - 10) < 1e-6 &&
    Math.abs(edge.start.x - edge.end.x) > 0.5 &&
    Math.abs(edge.start.y - edge.end.y) > 0.01
  );
  assert.ok(selectedEdge, 'Expected a curved top edge selection');

  const chamfer = part.chamfer([edgeKey(selectedEdge.start, selectedEdge.end)], 1);
  const result = chamfer.result.geometry;
  assert.ok(result.topoBody, 'Chamfer feature should keep exact topology');
  assert.strictEqual(countBoundaryEdges(result.topoBody), 0, 'Chamfer feature topoBody should be closed');
});

console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);
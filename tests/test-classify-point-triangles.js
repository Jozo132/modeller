import './_watchdog.mjs';
// tests/test-classify-point-triangles.js — smoke test for classifyPointVsTriangles.
import assert from 'assert';

const w = await import('../build/release.js');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (err) { console.log(`  XX ${name}\n    ${err.message}`); failed++; }
}

function buildUnitCube() {
  w.bodyBegin();
  w.geomPoolReset();
  const corners = [
    [0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1],
  ];
  const V = corners.map(([x,y,z]) => w.vertexAdd(x,y,z));
  const faceDefs = [
    { n: [0,0,-1], r: [1,0,0], verts: [0,3,2,1] },
    { n: [0,0,1],  r: [1,0,0], verts: [4,5,6,7] },
    { n: [0,-1,0], r: [1,0,0], verts: [0,1,5,4] },
    { n: [0,1,0],  r: [1,0,0], verts: [2,3,7,6] },
    { n: [-1,0,0], r: [0,1,0], verts: [0,4,7,3] },
    { n: [1,0,0],  r: [0,1,0], verts: [1,2,6,5] },
  ];
  for (const fd of faceDefs) {
    const [nx,ny,nz] = fd.n;
    const [rx,ry,rz] = fd.r;
    let ox=0, oy=0, oz=0;
    for (const vi of fd.verts) { ox+=corners[vi][0]; oy+=corners[vi][1]; oz+=corners[vi][2]; }
    ox/=4; oy/=4; oz/=4;
    const geomOff = w.planeStore(ox,oy,oz, nx,ny,nz, rx,ry,rz);
    const edges = [];
    for (let i=0;i<fd.verts.length;i++) {
      edges.push(w.edgeAdd(V[fd.verts[i]], V[fd.verts[(i+1)%fd.verts.length]], w.GEOM_LINE, 0));
    }
    const faceId = w.faceGetCount();
    const loopId = w.loopGetCount();
    const coedges = edges.map(e => w.coedgeAdd(e, w.ORIENT_FORWARD, 0, loopId));
    for (let i=0;i<coedges.length;i++) w.coedgeSetNext(coedges[i], coedges[(i+1)%coedges.length]);
    w.loopAdd(coedges[0], faceId, 1);
    w.faceAdd(loopId, 0, w.GEOM_PLANE, geomOff, w.ORIENT_FORWARD, 1);
  }
  w.shellAdd(0, 6, 1);
  w.bodyEnd();
}

function addFace(vertIds, normal, refDir) {
  const [nx,ny,nz] = normal;
  const [rx,ry,rz] = refDir;
  let ox=0, oy=0, oz=0;
  for (const vi of vertIds) { ox += w.vertexGetX(vi); oy += w.vertexGetY(vi); oz += w.vertexGetZ(vi); }
  ox/=vertIds.length; oy/=vertIds.length; oz/=vertIds.length;
  const geomOff = w.planeStore(ox,oy,oz, nx,ny,nz, rx,ry,rz);
  const edges = [];
  for (let i=0;i<vertIds.length;i++) edges.push(w.edgeAdd(vertIds[i], vertIds[(i+1)%vertIds.length], w.GEOM_LINE, 0));
  const faceId = w.faceGetCount();
  const loopId = w.loopGetCount();
  const coedges = edges.map(e => w.coedgeAdd(e, w.ORIENT_FORWARD, 0, loopId));
  for (let i=0;i<coedges.length;i++) w.coedgeSetNext(coedges[i], coedges[(i+1)%coedges.length]);
  w.loopAdd(coedges[0], faceId, 1);
  w.faceAdd(loopId, 0, w.GEOM_PLANE, geomOff, w.ORIENT_FORWARD, 1);
}

function buildLExtrusion() {
  w.bodyBegin();
  w.geomPoolReset();
  const base = [[0,0],[2,0],[2,1],[1,1],[1,2],[0,2]];
  const N = base.length;
  const bot = base.map(([x,y]) => w.vertexAdd(x,y,0));
  const top = base.map(([x,y]) => w.vertexAdd(x,y,1));
  addFace([bot[0], bot[5], bot[4], bot[3], bot[2], bot[1]], [0,0,-1], [1,0,0]);
  addFace([top[0], top[1], top[2], top[3], top[4], top[5]], [0,0, 1], [1,0,0]);
  for (let i=0;i<N;i++) {
    const [x0,y0] = base[i];
    const [x1,y1] = base[(i+1)%N];
    const dx=x1-x0, dy=y1-y0;
    const nlen = Math.hypot(dx,dy);
    const nx = dy/nlen, ny = -dx/nlen;
    addFace([bot[i], bot[(i+1)%N], top[(i+1)%N], top[i]], [nx,ny,0], [0,0,1]);
  }
  w.shellAdd(0, 2+N, 1);
  w.bodyEnd();
}

console.log('=== classifyPointVsTriangles ===');

t('export exists', () => assert.ok(typeof w.classifyPointVsTriangles === 'function'));

t('cube tessellates to 12 tris', () => {
  buildUnitCube();
  w.tessReset();
  const n = w.tessBuildAllFaces(16,16);
  assert.equal(n, 12);
});

t('cube: INSIDE (0.5,0.5,0.5)', () => assert.equal(w.classifyPointVsTriangles(0.5,0.5,0.5), w.CLASSIFY_INSIDE));
t('cube: OUTSIDE (-0.5,0.5,0.5)', () => assert.equal(w.classifyPointVsTriangles(-0.5,0.5,0.5), w.CLASSIFY_OUTSIDE));
t('cube: OUTSIDE (1.5,0.5,0.5)', () => assert.equal(w.classifyPointVsTriangles(1.5,0.5,0.5), w.CLASSIFY_OUTSIDE));
t('cube: OUTSIDE (0.5,0.5,2.0)', () => assert.equal(w.classifyPointVsTriangles(0.5,0.5,2.0), w.CLASSIFY_OUTSIDE));
t('cube: INSIDE near corner', () => assert.equal(w.classifyPointVsTriangles(0.05,0.05,0.05), w.CLASSIFY_INSIDE));
t('cube: INSIDE deep +y', () => assert.equal(w.classifyPointVsTriangles(0.5,0.9,0.5), w.CLASSIFY_INSIDE));

t('UNKNOWN empty tess', () => {
  w.tessReset();
  assert.equal(w.classifyPointVsTriangles(0.5,0.5,0.5), w.CLASSIFY_UNKNOWN);
});

t('L-extrusion tessellates', () => {
  buildLExtrusion();
  w.tessReset();
  const n = w.tessBuildAllFaces(16,16);
  assert.ok(n > 0, `got ${n}`);
});

t('L: concave notch OUTSIDE (1.5,1.5,0.5)', () => {
  assert.equal(w.classifyPointVsTriangles(1.5,1.5,0.5), w.CLASSIFY_OUTSIDE);
});
t('L: thin arm INSIDE (0.5,1.5,0.5)', () => {
  assert.equal(w.classifyPointVsTriangles(0.5,1.5,0.5), w.CLASSIFY_INSIDE);
});
t('L: wide arm INSIDE (1.5,0.5,0.5)', () => {
  assert.equal(w.classifyPointVsTriangles(1.5,0.5,0.5), w.CLASSIFY_INSIDE);
});
t('L: far OUTSIDE (-1,-1,0.5)', () => {
  assert.equal(w.classifyPointVsTriangles(-1,-1,0.5), w.CLASSIFY_OUTSIDE);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

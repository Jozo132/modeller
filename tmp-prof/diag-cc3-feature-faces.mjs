import { readFileSync } from 'node:fs';
import { Part } from '../js/cad/Part.js';
import { parseCMOD } from '../js/cmod.js';
import { ensureWasmReady, tessellateBodyWasm } from '../js/cad/StepImportWasm.js';
import { tessellateBody } from '../js/cad/Tessellation.js';
import { detectBoundaryEdges, detectDegenerateFaces, detectSelfIntersections } from '../js/cad/MeshValidator.js';

await ensureWasmReady();

const part = Part.deserialize(parseCMOD(readFileSync('tests/samples/puzzle-extrude-cc3.cmod', 'utf8')).data.part);
const finalGeometry = part.getFinalGeometry().geometry;
const body = finalGeometry.topoBody;
const routed = tessellateBody(body, { validate: false });
const raw = tessellateBodyWasm(body, {});

function normalFromVerts(vertices) {
  const [a, b, c] = vertices;
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  const n = { x: uy * vz - uz * vy, y: uz * vx - ux * vz, z: ux * vy - uy * vx };
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  return { x: n.x / len, y: n.y / len, z: n.z / len };
}

function centroid(vertices) {
  return {
    x: (vertices[0].x + vertices[1].x + vertices[2].x) / 3,
    y: (vertices[0].y + vertices[1].y + vertices[2].y) / 3,
    z: (vertices[0].z + vertices[1].z + vertices[2].z) / 3,
  };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function expectedNormal(face, point) {
  if (face.surface && typeof face.surface.closestPointUV === 'function' && typeof face.surface.normal === 'function') {
    const uv = face.surface.closestPointUV(point);
    const n = face.surface.normal(uv.u, uv.v);
    if (n) {
      const len = Math.hypot(n.x, n.y, n.z) || 1;
      const sign = face.sameSense === false ? -1 : 1;
      return { x: sign * n.x / len, y: sign * n.y / len, z: sign * n.z / len };
    }
  }
  if (face.surfaceInfo?.normal) {
    const n = face.surfaceInfo.normal;
    const len = Math.hypot(n.x, n.y, n.z) || 1;
    return { x: n.x / len, y: n.y / len, z: n.z / len };
  }
  return null;
}

function faceBounds(face) {
  const points = [];
  for (const loop of face.allLoops ? face.allLoops() : [face.outerLoop, ...(face.innerLoops || [])]) {
    for (const p of loop?.points?.() || []) points.push(p);
  }
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const p of points) {
    bounds.minX = Math.min(bounds.minX, p.x);
    bounds.minY = Math.min(bounds.minY, p.y);
    bounds.minZ = Math.min(bounds.minZ, p.z);
    bounds.maxX = Math.max(bounds.maxX, p.x);
    bounds.maxY = Math.max(bounds.maxY, p.y);
    bounds.maxZ = Math.max(bounds.maxZ, p.z);
  }
  return Object.fromEntries(Object.entries(bounds).map(([k, v]) => [k, Number(v.toFixed(3))]));
}

function classifyMesh(mesh, label) {
  const byFace = new Map();
  for (const tri of mesh.faces) {
    const id = tri.topoFaceId;
    if (!byFace.has(id)) byFace.set(id, []);
    byFace.get(id).push(tri);
  }

  const rows = [];
  for (const face of body.faces()) {
    const tris = byFace.get(face.id) || [];
    let flipped = 0;
    let area = 0;
    for (const tri of tris) {
      const c = centroid(tri.vertices);
      const expected = expectedNormal(face, c);
      const actual = normalFromVerts(tri.vertices);
      if (expected && dot(actual, expected) < -0.1) flipped++;
      const [a, b, d] = tri.vertices;
      area += Math.hypot(
        (b.y - a.y) * (d.z - a.z) - (b.z - a.z) * (d.y - a.y),
        (b.z - a.z) * (d.x - a.x) - (b.x - a.x) * (d.z - a.z),
        (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x),
      ) / 2;
    }
    rows.push({
      id: face.id,
      type: face.surfaceType,
      sameSense: face.sameSense,
      shared: face.shared || null,
      loops: 1 + (face.innerLoops?.length || 0),
      coedges: (face.outerLoop?.coedges?.length || 0),
      tris: tris.length,
      flipped,
      area: Number(area.toFixed(3)),
      bounds: faceBounds(face),
    });
  }

  console.log(`\n=== ${label} summary ===`);
  console.log(JSON.stringify({
    tessellator: mesh._tessellator || 'raw-wasm',
    totalFaces: mesh.faces.length,
    boundary: detectBoundaryEdges(mesh.faces).count,
    degenerate: detectDegenerateFaces(mesh.faces).count,
    selfSameTopo: detectSelfIntersections(mesh.faces, { sameTopoFaceOnly: true }).count,
  }, null, 2));

  console.log(`\n=== ${label} feature-ish/problem faces ===`);
  for (const row of rows) {
    const hasFeature = row.shared && Object.keys(row.shared).length > 0;
    const problem = row.tris === 0 || row.flipped > 0 || hasFeature || row.type !== 'plane';
    if (!problem) continue;
    console.log(JSON.stringify(row));
  }
}

classifyMesh(raw, 'raw wasm');
classifyMesh(routed, 'routed');
classifyMesh(finalGeometry, 'final geometry');

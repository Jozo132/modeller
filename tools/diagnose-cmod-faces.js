// Diagnostic-only: intentionally uses Tessellator2 compatibility code.
import fs from 'node:fs';
import path from 'node:path';

import { Part } from '../js/cad/Part.js';
import { EdgeSampler } from '../js/cad/Tessellator2/EdgeSampler.js';
import { FaceTriangulator } from '../js/cad/Tessellator2/FaceTriangulator.js';

function triangleArea3D(a, b, c) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

function calculateNormal(a, b, c) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-14) return { x: 0, y: 0, z: 1 };
  return { x: nx / len, y: ny / len, z: nz / len };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function boundaryNormal(loop) {
  if (!loop || loop.length < 3) return { x: 0, y: 0, z: 1 };
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < loop.length; i++) {
    const curr = loop[i];
    const next = loop[(i + 1) % loop.length];
    nx += (curr.y - next.y) * (curr.z + next.z);
    ny += (curr.z - next.z) * (curr.x + next.x);
    nz += (curr.x - next.x) * (curr.y + next.y);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-14) return calculateNormal(loop[0], loop[1], loop[2]);
  return { x: nx / len, y: ny / len, z: nz / len };
}

function polygonNormal(verts) {
  if (!Array.isArray(verts) || verts.length < 3) return null;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < verts.length; i++) {
    const curr = verts[i];
    const next = verts[(i + 1) % verts.length];
    nx += (curr.y - next.y) * (curr.z + next.z);
    ny += (curr.z - next.z) * (curr.x + next.x);
    nz += (curr.x - next.x) * (curr.y + next.y);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-14) return null;
  return { x: nx / len, y: ny / len, z: nz / len };
}

function pointKey(p, scale = 1e8) {
  return `${Math.round(p.x * scale)},${Math.round(p.y * scale)},${Math.round(p.z * scale)}`;
}

function edgeKey(a, b) {
  const ka = pointKey(a);
  const kb = pointKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function collectLoopPoints(loop, edgeSampler, edgeSegments) {
  if (!loop || !Array.isArray(loop.coedges) || loop.coedges.length === 0) return [];
  const points = [];
  for (const coedge of loop.coedges) {
    const samples = edgeSampler.sampleCoEdge(coedge, edgeSegments);
    if (!samples || samples.length === 0) continue;
    const start = points.length > 0 ? 1 : 0;
    for (let i = start; i < samples.length; i++) points.push(samples[i]);
  }
  if (points.length > 1 && distance(points[0], points[points.length - 1]) < 1e-10) {
    points.pop();
  }
  return points;
}

function countBoundaryEdges(meshFaces) {
  const counts = new Map();
  for (const face of meshFaces) {
    const verts = face.vertices || [];
    if (verts.length !== 3) continue;
    for (let i = 0; i < 3; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % 3];
      const key = edgeKey(a, b);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of counts.values()) {
    if (count === 1) boundaryEdges++;
    else if (count > 2) nonManifoldEdges++;
  }
  return { boundaryEdges, nonManifoldEdges };
}

function classifyRoute(face) {
  if (face.surface && face.surfaceType !== 'plane') return 'nurbs';
  if (!face.surface && face.surfaceInfo && face.surfaceType !== 'plane') return 'analytic';
  return 'planar';
}

function expectedBoundaryEdgeCount(face) {
  let count = 0;
  const loops = [];
  if (face.outerLoop) loops.push(face.outerLoop);
  if (Array.isArray(face.innerLoops)) loops.push(...face.innerLoops);
  for (const loop of loops) {
    const n = Array.isArray(loop?.coedges) ? loop.coedges.length : 0;
    count += n;
  }
  return count;
}

function computeBounds(points) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (p.z > maxZ) maxZ = p.z;
  }
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  };
}

function computeCentroid(points) {
  if (!points.length) return { x: 0, y: 0, z: 0 };
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
    z += p.z;
  }
  const inv = 1 / points.length;
  return { x: x * inv, y: y * inv, z: z * inv };
}

function sampleFace(triangulator, face, edgeSampler, edgeSegments, surfaceSegments) {
  const outerPts = collectLoopPoints(face.outerLoop, edgeSampler, edgeSegments);
  const holePts = (face.innerLoops || [])
    .map(loop => collectLoopPoints(loop, edgeSampler, edgeSegments))
    .filter(loop => loop.length >= 3);

  const route = classifyRoute(face);
  let mesh;
  if (route === 'nurbs') mesh = triangulator.triangulateSurface(face, outerPts, surfaceSegments, face.sameSense);
  else if (route === 'analytic') mesh = triangulator.triangulateAnalyticSurface(face, outerPts, holePts, surfaceSegments);
  else mesh = triangulator.triangulatePlanar(outerPts, holePts, null, true);

  const referenceNormal = boundaryNormal(outerPts);
  let zeroArea = 0;
  let flipped = 0;
  let minDot = Infinity;
  let maxDot = -Infinity;
  for (const tri of mesh.faces) {
    const [a, b, c] = tri.vertices;
    const area = triangleArea3D(a, b, c);
    if (area < 1e-12) {
      zeroArea++;
      continue;
    }
    const triNormal = calculateNormal(a, b, c);
    const align = dot(triNormal, referenceNormal);
    if (align < -1e-6) flipped++;
    if (align < minDot) minDot = align;
    if (align > maxDot) maxDot = align;
  }

  const edgeStats = countBoundaryEdges(mesh.faces);
  const boundarySampleCount = outerPts.length + holePts.reduce((sum, loop) => sum + loop.length, 0);
  const allLoopPoints = [...outerPts, ...holePts.flat()];
  return {
    route,
    outerPoints: outerPts.length,
    holeCount: holePts.length,
    loopEdgeCount: expectedBoundaryEdgeCount(face),
    boundarySampleCount,
    triangleCount: mesh.faces.length,
    zeroArea,
    flipped,
    minDot: Number.isFinite(minDot) ? minDot : null,
    maxDot: Number.isFinite(maxDot) ? maxDot : null,
    boundaryEdges: edgeStats.boundaryEdges,
    nonManifoldEdges: edgeStats.nonManifoldEdges,
    bounds: computeBounds(allLoopPoints),
    centroid: computeCentroid(allLoopPoints),
  };
}

function main() {
  const args = process.argv.slice(2);
  const inputArg = args[0] || 'tests/samples/Unnamed-Body.cmod';
  const inputPath = path.resolve(process.cwd(), inputArg);
  const raw = fs.readFileSync(inputPath, 'utf8');
  const data = JSON.parse(raw);
  const partData = data.part || data;
  const part = Part.deserialize(partData);
  const geo = part.getFinalGeometry();
  const body = geo?.body || geo?.solid?.body;
  if (!body) {
    throw new Error(`No solid body available in ${inputArg}`);
  }

  const edgeSegments = 64;
  const surfaceSegments = 16;
  const edgeSampler = new EdgeSampler();
  const triangulator = new FaceTriangulator();
  const faces = Array.from(body.faces());

  for (const shell of body.shells || []) {
    for (const edge of shell.edges()) edgeSampler.sampleEdge(edge, edgeSegments);
  }

  const summaries = faces.map((face, index) => {
    const summary = sampleFace(triangulator, face, edgeSampler, edgeSegments, surfaceSegments);
    return {
      faceIndex: index,
      surfaceType: face.surfaceType || 'unknown',
      sameSense: !!face.sameSense,
      hasSurface: !!face.surface,
      hasSurfaceInfo: !!face.surfaceInfo,
      ...summary,
    };
  });

  const invertedByFace = new Map();
  const meshFaces = geo?.geometry?.faces || [];
  for (const tri of meshFaces) {
    const faceIndex = tri.topoFaceId;
    if (faceIndex == null) continue;
    const polyN = polygonNormal(tri.vertices || []);
    const faceN = tri.normal;
    if (!polyN || !faceN) continue;
    const align = dot(polyN, faceN);
    if (align >= -1e-5) continue;
    if (!invertedByFace.has(faceIndex)) invertedByFace.set(faceIndex, 0);
    invertedByFace.set(faceIndex, invertedByFace.get(faceIndex) + 1);
  }

  for (const summary of summaries) {
    summary.invertedMeshTriangles = invertedByFace.get(summary.faceIndex) || 0;
  }

  const badFaces = summaries
    .filter((face) => {
      if (face.invertedMeshTriangles > 0 || face.flipped > 0 || face.zeroArea > 0 || face.nonManifoldEdges > 0) return true;
      if (face.route === 'analytic' && Math.abs(face.boundaryEdges - face.boundarySampleCount) > 2) return true;
      return false;
    })
    .sort((a, b) => {
      const aScore = a.invertedMeshTriangles * 1000 + a.flipped * 100 + a.nonManifoldEdges * 100 + Math.abs(a.boundaryEdges - a.boundarySampleCount) * 10 + a.zeroArea;
      const bScore = b.invertedMeshTriangles * 1000 + b.flipped * 100 + b.nonManifoldEdges * 100 + Math.abs(b.boundaryEdges - b.boundarySampleCount) * 10 + b.zeroArea;
      return bScore - aScore || a.faceIndex - b.faceIndex;
    });

  const routeCounts = {};
  const typeCounts = {};
  for (const face of summaries) {
    routeCounts[face.route] = (routeCounts[face.route] || 0) + 1;
    typeCounts[face.surfaceType] = (typeCounts[face.surfaceType] || 0) + 1;
  }

  const report = {
    input: inputArg,
    faceCount: summaries.length,
    meshTriangleCount: geo?.geometry?.faces?.length ?? null,
    invertedMeshTriangleCount: Array.from(invertedByFace.values()).reduce((sum, value) => sum + value, 0),
    routeCounts,
    typeCounts,
    badFaceCount: badFaces.length,
    badFaces,
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
import { mat4LookAt, mat4Multiply, mat4Ortho, mat4Perspective } from './render-math.js';

function projectPolygon2D(verts, normal) {
  const an = {
    x: Math.abs(normal?.x || 0),
    y: Math.abs(normal?.y || 0),
    z: Math.abs(normal?.z || 0),
  };
  if (an.z >= an.x && an.z >= an.y) return verts.map((v) => ({ x: v.x, y: v.y }));
  if (an.y >= an.x) return verts.map((v) => ({ x: v.x, y: v.z }));
  return verts.map((v) => ({ x: v.y, y: v.z }));
}

export function triangulatePolygonIndices(verts, normal) {
  if (!verts || verts.length < 3) return [];
  if (verts.length === 3) return [[0, 1, 2]];

  const pts2d = projectPolygon2D(verts, normal);
  let signedArea = 0;
  for (let i = 0; i < pts2d.length; i++) {
    const a = pts2d[i];
    const b = pts2d[(i + 1) % pts2d.length];
    signedArea += a.x * b.y - b.x * a.y;
  }
  const winding = signedArea >= 0 ? 1 : -1;

  function cross2(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function pointInTri(p, a, b, c) {
    const c1 = cross2(a, b, p) * winding;
    const c2 = cross2(b, c, p) * winding;
    const c3 = cross2(c, a, p) * winding;
    return c1 >= -1e-8 && c2 >= -1e-8 && c3 >= -1e-8;
  }

  const remaining = verts.map((_, i) => i);
  const triangles = [];
  let guard = 0;
  const maxGuard = verts.length * verts.length;

  while (remaining.length > 3 && guard < maxGuard) {
    let earFound = false;
    for (let ri = 0; ri < remaining.length; ri++) {
      const prev = remaining[(ri - 1 + remaining.length) % remaining.length];
      const curr = remaining[ri];
      const next = remaining[(ri + 1) % remaining.length];
      const a = pts2d[prev];
      const b = pts2d[curr];
      const c = pts2d[next];
      if (cross2(a, b, c) * winding <= 1e-8) continue;

      let containsPoint = false;
      for (const other of remaining) {
        if (other === prev || other === curr || other === next) continue;
        if (pointInTri(pts2d[other], a, b, c)) {
          containsPoint = true;
          break;
        }
      }
      if (containsPoint) continue;

      triangles.push([prev, curr, next]);
      remaining.splice(ri, 1);
      earFound = true;
      break;
    }

    if (!earFound) break;
    guard++;
  }

  if (remaining.length === 3) triangles.push([remaining[0], remaining[1], remaining[2]]);
  if (triangles.length !== Math.max(0, verts.length - 2)) {
    const fan = [];
    for (let i = 1; i < verts.length - 1; i++) fan.push([0, i, i + 1]);
    return fan;
  }

  return triangles;
}

function computePolygonNormal(verts) {
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
  if (len <= 1e-10) return null;
  return { x: nx / len, y: ny / len, z: nz / len };
}

function buildBoundaryEdges(faces) {
  const precision = 5;
  const vKey = (v) => `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`;
  const eKey = (a, b) => {
    const ka = vKey(a);
    const kb = vKey(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };

  const edgeCounts = new Map();
  for (const face of faces) {
    const verts = face.vertices || [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const key = eKey(a, b);
      if (!edgeCounts.has(key)) edgeCounts.set(key, { a, b, count: 0 });
      edgeCounts.get(key).count++;
    }
  }

  const boundary = [];
  for (const [, info] of edgeCounts) {
    if (info.count === 1) {
      boundary.push(info.a.x, info.a.y, info.a.z, info.b.x, info.b.y, info.b.z);
    }
  }
  return boundary.length > 0 ? new Float32Array(boundary) : null;
}

function buildSilhouetteCandidates(faces) {
  const SHARP_COS = Math.cos(15 * Math.PI / 180);
  // Minimum angular difference (30°) for silhouette candidates within the
  // same face group — prevents coarse tessellation of smooth surfaces
  // (e.g. spherical corners) from spawning interior contour lines.
  const SAME_GROUP_MIN_COS = Math.cos(30 * Math.PI / 180);
  const precision = 5;
  const vKey = (v) => `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`;
  const eKey = (a, b) => {
    const ka = vKey(a);
    const kb = vKey(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };

  const edgeMap = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    const verts = face.vertices || [];
    const n = face.normal || { x: 0, y: 0, z: 1 };
    const g = face.faceGroup != null ? face.faceGroup : fi;
    const tid = face.topoFaceId;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const key = eKey(a, b);
      if (!edgeMap.has(key)) edgeMap.set(key, { a, b, normals: [], groups: [], topoFaceIds: [] });
      const entry = edgeMap.get(key);
      entry.normals.push(n);
      entry.groups.push(g);
      entry.topoFaceIds.push(tid);
    }
  }

  const candidates = [];
  for (const [, info] of edgeMap) {
    if (info.normals.length >= 2) {
      // Suppress silhouette candidates between faces from the same STEP
      // topology face — internal tessellation edges on curved surfaces
      // (e.g. sphere patches) should never produce contour lines.
      const tid0 = info.topoFaceIds[0];
      const tid1 = info.topoFaceIds[1];
      if (tid0 !== undefined && tid0 === tid1) continue;

      const n0 = info.normals[0];
      const n1 = info.normals[1];
      const dot = n0.x * n1.x + n0.y * n1.y + n0.z * n1.z;
      const sameGroup = info.groups[0] === info.groups[1];
      // Within the same face group, only generate silhouette candidates
      // when normals differ by >= 30° to avoid tessellation artefacts.
      const sharpCos = sameGroup ? SAME_GROUP_MIN_COS : SHARP_COS;
      if (dot >= sharpCos && dot < 1 - 1e-6) {
        candidates.push(
          info.a.x, info.a.y, info.a.z,
          info.b.x, info.b.y, info.b.z,
          n0.x, n0.y, n0.z,
          n1.x, n1.y, n1.z
        );
      }
    }
  }

  return candidates.length > 0 ? new Float32Array(candidates) : null;
}

export function buildMeshRenderData(geometry) {
  const faces = geometry.faces || [];
  const isInvertedFace = (face) => {
    const polygonNormal = computePolygonNormal(face.vertices || []);
    const normal = face.normal;
    if (!polygonNormal || !normal) return false;
    const dot = polygonNormal.x * normal.x + polygonNormal.y * normal.y + polygonNormal.z * normal.z;
    return dot < -1e-5;
  };

  const meshFaces = faces.map((face, idx) => ({
    index: idx,
    faceGroup: face.faceGroup != null ? face.faceGroup : idx,
    faceType: face.faceType || 'unknown',
    isCurved: !!face.isCurved,
    isInverted: isInvertedFace(face),
    normal: face.normal || { x: 0, y: 0, z: 1 },
    shared: face.shared || null,
    vertices: face.vertices || [],
    vertexCount: (face.vertices || []).length,
  }));

  const smoothNormals = new Map();
  const precision = 6;
  const vKey = (v) => `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`;

  for (const face of faces) {
    if (!face.isCurved) continue;
    const n = face.normal || { x: 0, y: 0, z: 1 };
    const g = face.faceGroup;
    for (const v of face.vertices || []) {
      const key = `${g}|${vKey(v)}`;
      if (!smoothNormals.has(key)) smoothNormals.set(key, { x: 0, y: 0, z: 0 });
      const sn = smoothNormals.get(key);
      sn.x += n.x;
      sn.y += n.y;
      sn.z += n.z;
    }
  }

  for (const sn of smoothNormals.values()) {
    const len = Math.sqrt(sn.x * sn.x + sn.y * sn.y + sn.z * sn.z);
    if (len > 1e-10) {
      sn.x /= len;
      sn.y /= len;
      sn.z /= len;
    }
  }

  let triCount = 0;
  for (const face of faces) {
    if ((face.vertices || []).length >= 3) triCount += face.vertices.length - 2;
  }

  const triData = new Float32Array(triCount * 3 * 6);
  let ti = 0;
  const problemVerts = [];
  const triFaceMap = new Int32Array(triCount);
  let triIdx = 0;

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    const verts = face.vertices || [];
    const n = face.normal || { x: 0, y: 0, z: 1 };
    const curved = face.isCurved;
    const g = face.faceGroup;
    const inverted = meshFaces[fi].isInverted;
    if (verts.length < 3) continue;

    for (let i = 1; i < verts.length - 1; i++) {
      const triVerts = [verts[0], verts[i], verts[i + 1]];
      for (const v of triVerts) {
        triData[ti++] = v.x;
        triData[ti++] = v.y;
        triData[ti++] = v.z;
        if (curved) {
          const sn = smoothNormals.get(`${g}|${vKey(v)}`);
          triData[ti++] = sn.x;
          triData[ti++] = sn.y;
          triData[ti++] = sn.z;
        } else {
          triData[ti++] = n.x;
          triData[ti++] = n.y;
          triData[ti++] = n.z;
        }
        if (inverted) problemVerts.push(v.x, v.y, v.z, n.x, n.y, n.z);
      }
      triFaceMap[triIdx++] = fi;
    }
  }

  let meshEdges = null;
  let meshEdgeVertexCount = 0;
  let meshEdgeSegments = null;
  let meshEdgePaths = null;
  let edgeToPath = null;
  let meshSilhouetteCandidates = null;

  if (geometry.edges && geometry.edges.length > 0) {
    const edgeData = new Float32Array(geometry.edges.length * 2 * 3);
    let ei = 0;
    for (const edge of geometry.edges) {
      edgeData[ei++] = edge.start.x;
      edgeData[ei++] = edge.start.y;
      edgeData[ei++] = edge.start.z;
      edgeData[ei++] = edge.end.x;
      edgeData[ei++] = edge.end.y;
      edgeData[ei++] = edge.end.z;
    }
    meshEdges = edgeData;
    meshEdgeVertexCount = geometry.edges.length * 2;
    meshEdgeSegments = geometry.edges.map((e) => ({
      start: e.start,
      end: e.end,
      faceIndices: e.faceIndices || [],
      normals: e.normals || [],
    }));
    meshEdgePaths = geometry.paths || [];
    edgeToPath = new Map();
    if (meshEdgePaths) {
      for (let pi = 0; pi < meshEdgePaths.length; pi++) {
        for (const ei2 of meshEdgePaths[pi].edgeIndices) {
          edgeToPath.set(ei2, pi);
        }
      }
    }
    meshSilhouetteCandidates = buildSilhouetteCandidates(faces);
  }

  const boundaryEdgeData = buildBoundaryEdges(faces);

  let meshVisualEdges = null;
  let meshVisualEdgeVertexCount = 0;
  if (geometry.visualEdges && geometry.visualEdges.length > 0) {
    const vEdgeData = new Float32Array(geometry.visualEdges.length * 2 * 3);
    let vi = 0;
    for (const edge of geometry.visualEdges) {
      vEdgeData[vi++] = edge.start.x;
      vEdgeData[vi++] = edge.start.y;
      vEdgeData[vi++] = edge.start.z;
      vEdgeData[vi++] = edge.end.x;
      vEdgeData[vi++] = edge.end.y;
      vEdgeData[vi++] = edge.end.z;
    }
    meshVisualEdges = vEdgeData;
    meshVisualEdgeVertexCount = geometry.visualEdges.length * 2;
  }

  return {
    _meshTriangles: triData,
    _meshTriangleCount: triCount * 3,
    _problemTriangles: problemVerts.length > 0 ? new Float32Array(problemVerts) : null,
    _problemTriangleCount: problemVerts.length / 6,
    _meshFaces: meshFaces,
    _triFaceMap: triFaceMap,
    _meshEdges: meshEdges,
    _meshEdgeVertexCount: meshEdgeVertexCount,
    _meshEdgeSegments: meshEdgeSegments,
    _meshEdgePaths: meshEdgePaths,
    _edgeToPath: edgeToPath,
    _meshSilhouetteCandidates: meshSilhouetteCandidates,
    _meshVisualEdges: meshVisualEdges,
    _meshVisualEdgeVertexCount: meshVisualEdgeVertexCount,
    _meshBoundaryEdges: boundaryEdgeData,
    _meshBoundaryEdgeVertexCount: boundaryEdgeData ? boundaryEdgeData.length / 3 : 0,
  };
}

export function computeOrbitCameraPosition(theta, phi, radius, target) {
  return {
    x: target.x + radius * Math.sin(phi) * Math.cos(theta),
    y: target.y + radius * Math.sin(phi) * Math.sin(theta),
    z: target.z + radius * Math.cos(phi),
  };
}

export function computeSilhouetteEdges(candidates, orbitState) {
  if (!candidates || candidates.length === 0 || !orbitState) return null;

  const camera = computeOrbitCameraPosition(
    orbitState.theta,
    orbitState.phi,
    orbitState.radius,
    orbitState.target
  );

  const count = candidates.length / 12;
  const lines = [];
  for (let index = 0; index < count; index++) {
    const offset = index * 12;
    const ax = candidates[offset];
    const ay = candidates[offset + 1];
    const az = candidates[offset + 2];
    const bx = candidates[offset + 3];
    const by = candidates[offset + 4];
    const bz = candidates[offset + 5];
    const mx = (ax + bx) * 0.5;
    const my = (ay + by) * 0.5;
    const mz = (az + bz) * 0.5;
    const vx = camera.x - mx;
    const vy = camera.y - my;
    const vz = camera.z - mz;
    const d0 = candidates[offset + 6] * vx + candidates[offset + 7] * vy + candidates[offset + 8] * vz;
    const d1 = candidates[offset + 9] * vx + candidates[offset + 10] * vy + candidates[offset + 11] * vz;
    if ((d0 > 0) !== (d1 > 0)) {
      lines.push(ax, ay, az, bx, by, bz);
    }
  }

  return lines.length > 0 ? new Float32Array(lines) : null;
}

export function computeFitViewState(bounds, fallbackRadius = 25) {
  if (!bounds) {
    return {
      target: { x: 0, y: 0, z: 0 },
      radius: fallbackRadius,
      gridSize: 200,
      axesSize: 50,
    };
  }

  const sx = bounds.max.x - bounds.min.x;
  const sy = bounds.max.y - bounds.min.y;
  const sz = bounds.max.z - bounds.min.z;
  const maxDim = Math.max(sx, sy, sz, 10);
  return {
    target: {
      x: (bounds.max.x + bounds.min.x) / 2,
      y: (bounds.max.y + bounds.min.y) / 2,
      z: (bounds.max.z + bounds.min.z) / 2,
    },
    radius: maxDim * 2.5,
    gridSize: maxDim * 3,
    axesSize: maxDim * 0.5,
  };
}

export function computeOrbitMvp({ width, height, target, theta, phi, radius, fov, fovDegrees, ortho3D, orthoBounds }) {
  if (!width || !height) return null;
  const aspect = width / height;
  const near = 0.1;
  const far = 10000;
  const camera = computeOrbitCameraPosition(theta, phi, radius, target);
  const view = mat4LookAt(camera.x, camera.y, camera.z, target.x, target.y, target.z, 0, 0, 1);
  if (!view) return null;

  let proj;
  if (fovDegrees <= 0 || (ortho3D && orthoBounds)) {
    const halfH = radius * 0.5;
    const halfW = halfH * aspect;
    if (ortho3D && orthoBounds) {
      proj = mat4Ortho(orthoBounds.left, orthoBounds.right, orthoBounds.bottom, orthoBounds.top, near, far);
    } else {
      proj = mat4Ortho(-halfW, halfW, -halfH, halfH, near, far);
    }
  } else {
    proj = mat4Perspective(fov, aspect, near, far);
  }

  return mat4Multiply(proj, view);
}
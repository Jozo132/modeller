// js/cad/Tessellation.js — Mesh generation from exact B-Rep topology
//
// Generates renderable triangle/quad meshes from exact B-Rep data.
// Supports tolerance-controlled tessellation for both display and STL export.
//
// The default tessellation path now uses the robust Tessellator2 pipeline
// when CAD_USE_ROBUST_TESSELLATOR is enabled (the new default).  The legacy
// ear-clipping path is retained as _legacyTessellateBody() for fallback and
// backward compatibility but should not be used directly by new code.

import { robustTessellateBody } from './Tessellator2/index.js';
import { tessellateBodyWasm, ensureWasmReady } from './StepImportWasm.js';
import { globalTessConfig } from './TessellationConfig.js';
import { getFlag } from '../featureFlags.js';

// Fire-and-forget WASM init so that tessellateBodyWasm() works synchronously
// by the time tessellateBody() is first called.  Safe to call multiple times.
ensureWasmReady().catch(() => { /* WASM optional */ });

function meshNeedsRobustFallback(body, mesh) {
  if (!body || !mesh || !Array.isArray(mesh.faces) || mesh.faces.length === 0) return true;

  const topoFaces = body.faces();
  if (topoFaces.length === 0) return false;

  const wasmValidation = mesh._wasmValidation;
  if (wasmValidation?.coordinateHash && wasmValidation.faceCount === topoFaces.length) {
    if ((wasmValidation.missingFaces || 0) !== 0) return true;
    const closedShell = Array.isArray(body.shells) && body.shells.some((shell) => shell?.closed === true);
    if (!closedShell) return false;
    return (wasmValidation.boundaryEdges || 0) !== 0
      || (wasmValidation.nonManifoldEdges || 0) !== 0;
  }

  const coveredFaceIds = new Set();
  for (const face of mesh.faces) {
    if (typeof face?.topoFaceId === 'number') coveredFaceIds.add(face.topoFaceId);
  }
  for (const face of topoFaces) {
    if (!coveredFaceIds.has(face.id)) return true;
  }

  const closedShell = Array.isArray(body.shells) && body.shells.some((shell) => shell?.closed === true);
  if (!closedShell) return false;

  const edgeUse = new Map();
  const coordKey = (value) => (Math.abs(value) < 0.5e-6 ? 0 : value).toFixed(6);
  const vertexKey = (vertex) => `${coordKey(vertex?.x ?? 0)},${coordKey(vertex?.y ?? 0)},${coordKey(vertex?.z ?? 0)}`;
  for (const face of mesh.faces) {
    const vertices = face?.vertices || [];
    if (vertices.length < 3) continue;
    const vertexKeys = vertices.map(vertexKey);
    for (let index = 0; index < vertexKeys.length; index++) {
      const currentKey = vertexKeys[index];
      const nextKey = vertexKeys[(index + 1) % vertexKeys.length];
      const edgeKey = currentKey < nextKey ? `${currentKey}|${nextKey}` : `${nextKey}|${currentKey}`;
      edgeUse.set(edgeKey, (edgeUse.get(edgeKey) || 0) + 1);
    }
  }

  for (const count of edgeUse.values()) {
    if (count !== 2) return true;
  }
  return false;
}

function normalizeVector(vector) {
  const length = Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
  if (length < 1e-14) return { x: 0, y: 0, z: 1 };
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function dot3(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function distance2D(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-24) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / len2));
  const px = start.x + dx * t;
  const py = start.y + dy * t;
  return Math.hypot(point.x - px, point.y - py);
}

function pointNearPolygonBoundary2D(point, polygon, tolerance) {
  for (let index = 0; index < polygon.length; index++) {
    if (distance2D(point, polygon[index], polygon[(index + 1) % polygon.length]) <= tolerance) return true;
  }
  return false;
}

function pointInPolygon2D(point, polygon) {
  let inside = false;
  for (let currentIndex = 0, previousIndex = polygon.length - 1; currentIndex < polygon.length; previousIndex = currentIndex++) {
    const current = polygon[currentIndex];
    const previous = polygon[previousIndex];
    const crosses = (current.y > point.y) !== (previous.y > point.y);
    if (!crosses) continue;
    const xAtY = (previous.x - current.x) * (point.y - current.y) / ((previous.y - current.y) || 1e-30) + current.x;
    if (point.x < xAtY) inside = !inside;
  }
  return inside;
}

function polygonBounds2D(polygons) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons) {
    for (const point of polygon) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  return { minX, minY, maxX, maxY, diag: Math.hypot(maxX - minX, maxY - minY) };
}

function faceProjectionNormal(face) {
  if (face?.surfaceInfo?.normal) return normalizeVector(face.surfaceInfo.normal);

  const points = face?.outerLoop?.points?.() || [];
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    nx += (current.y - next.y) * (current.z + next.z);
    ny += (current.z - next.z) * (current.x + next.x);
    nz += (current.x - next.x) * (current.y + next.y);
  }
  if (Math.hypot(nx, ny, nz) > 1e-12) return normalizeVector({ x: nx, y: ny, z: nz });

  if (face?.surface && typeof face.surface.closestPointUV === 'function' && typeof face.surface.normal === 'function' && points.length > 0) {
    try {
      const uv = face.surface.closestPointUV(points[0]);
      const normal = face.surface.normal(uv.u, uv.v);
      if (normal) return normalizeVector(normal);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function projectPointForFace(point, normal) {
  const ax = Math.abs(normal?.x || 0);
  const ay = Math.abs(normal?.y || 0);
  const az = Math.abs(normal?.z || 0);
  if (az >= ax && az >= ay) return { x: point.x, y: point.y };
  if (ay >= ax) return { x: point.x, y: point.z };
  return { x: point.y, y: point.z };
}

function sampleCoedgePoints(coedge, segments = 64) {
  const edge = coedge?.edge;
  if (!edge) return [];
  let samples = typeof edge.tessellate === 'function'
    ? edge.tessellate(segments)
    : [edge.startVertex?.point, edge.endVertex?.point].filter(Boolean);
  if (coedge.sameSense === false) samples = [...samples].reverse();
  return samples.map((point) => ({ x: point.x, y: point.y, z: point.z }));
}

function sampleLoopPoints(loop, segments = 64) {
  const points = [];
  for (const coedge of loop?.coedges || []) {
    let samples = sampleCoedgePoints(coedge, segments);
    if (points.length > 0 && samples.length > 0) samples = samples.slice(1);
    points.push(...samples);
  }
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z) < 1e-8) points.pop();
  }
  return points;
}

function planarFaceTriangleOutsideTrim(face, triangles) {
  if (!face?.outerLoop || !Array.isArray(face.innerLoops) || face.innerLoops.length === 0) return false;
  if (!triangles.length) return true;

  const normal = faceProjectionNormal(face);
  if (!normal) return false;

  const outer = sampleLoopPoints(face.outerLoop, 64).map((point) => projectPointForFace(point, normal));
  const holes = face.innerLoops
    .map((loop) => sampleLoopPoints(loop, 64).map((point) => projectPointForFace(point, normal)))
    .filter((loop) => loop.length >= 3);
  if (outer.length < 3 || holes.length === 0) return false;

  const bounds = polygonBounds2D([outer, ...holes]);
  const tolerance = Math.max(1e-7, bounds.diag * 1e-7);
  const insideOuter = (point) => pointInPolygon2D(point, outer) || pointNearPolygonBoundary2D(point, outer, tolerance);
  const insideHole = (point, hole) => pointInPolygon2D(point, hole) && !pointNearPolygonBoundary2D(point, hole, tolerance);

  const vertexKey = (vertex) => `${(vertex?.x ?? 0).toFixed(7)},${(vertex?.y ?? 0).toFixed(7)},${(vertex?.z ?? 0).toFixed(7)}`;
  const edgeKey = (first, second) => {
    const firstKey = vertexKey(first);
    const secondKey = vertexKey(second);
    return firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`;
  };
  const edgeUse = new Map();
  for (const triangle of triangles) {
    const vertices = triangle?.vertices || [];
    if (vertices.length !== 3) continue;
    for (let index = 0; index < 3; index++) {
      const key = edgeKey(vertices[index], vertices[(index + 1) % 3]);
      edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
    }
  }

  for (const triangle of triangles) {
    const vertices = triangle?.vertices || [];
    if (vertices.length !== 3) continue;
    const centroid = projectPointForFace({
      x: (vertices[0].x + vertices[1].x + vertices[2].x) / 3,
      y: (vertices[0].y + vertices[1].y + vertices[2].y) / 3,
      z: (vertices[0].z + vertices[1].z + vertices[2].z) / 3,
    }, normal);
    if (!insideOuter(centroid)) return true;
    if (holes.some((hole) => insideHole(centroid, hole))) return true;

    for (let index = 0; index < 3; index++) {
      const first = vertices[index];
      const second = vertices[(index + 1) % 3];
      const probe = projectPointForFace({
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
        z: (first.z + second.z) / 2,
      }, normal);
      const isBoundaryEdge = (edgeUse.get(edgeKey(first, second)) || 0) <= 1;
      const invalidProbe = !insideOuter(probe) || holes.some((hole) => insideHole(probe, hole));
      if (invalidProbe && !isBoundaryEdge) return true;
    }
  }
  return false;
}

function meshHasInvalidFeaturePlanarTrims(body, mesh) {
  if (!body || !mesh || !Array.isArray(mesh.faces)) return false;
  const meshFacesByTopoId = new Map();
  for (const triangle of mesh.faces) {
    if (typeof triangle?.topoFaceId !== 'number') continue;
    if (!meshFacesByTopoId.has(triangle.topoFaceId)) meshFacesByTopoId.set(triangle.topoFaceId, []);
    meshFacesByTopoId.get(triangle.topoFaceId).push(triangle);
  }

  for (const face of body.faces()) {
    if (face.surfaceType !== 'plane') continue;
    if (!face.shared?.sourceFeatureId && !face.stableHash) continue;
    if (!Array.isArray(face.innerLoops) || face.innerLoops.length === 0) continue;
    if (planarFaceTriangleOutsideTrim(face, meshFacesByTopoId.get(face.id) || [])) return true;
  }
  return false;
}

function triangleNormalFromVertices(vertices) {
  const first = vertices[0];
  const second = vertices[1];
  const third = vertices[2];
  const ux = second.x - first.x;
  const uy = second.y - first.y;
  const uz = second.z - first.z;
  const vx = third.x - first.x;
  const vy = third.y - first.y;
  const vz = third.z - first.z;
  return normalizeVector({
    x: uy * vz - uz * vy,
    y: uz * vx - ux * vz,
    z: ux * vy - uy * vx,
  });
}

function strictTriangleNormalFromVertices(vertices) {
  const first = vertices[0];
  const second = vertices[1];
  const third = vertices[2];
  const ux = second.x - first.x;
  const uy = second.y - first.y;
  const uz = second.z - first.z;
  const vx = third.x - first.x;
  const vy = third.y - first.y;
  const vz = third.z - first.z;
  const normal = {
    x: uy * vz - uz * vy,
    y: uz * vx - ux * vz,
    z: ux * vy - uy * vx,
  };
  const length = Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
  if (length < 1e-14) return null;
  return { x: normal.x / length, y: normal.y / length, z: normal.z / length };
}

function analyticNormalAt(point, surfaceInfo, sameSense) {
  if (!surfaceInfo) return null;
  let normal = null;

  if (surfaceInfo.type === 'plane' && surfaceInfo.normal) {
    normal = { ...surfaceInfo.normal };
  } else if (surfaceInfo.type === 'cylinder' && surfaceInfo.axis) {
    const dx = point.x - surfaceInfo.origin.x;
    const dy = point.y - surfaceInfo.origin.y;
    const dz = point.z - surfaceInfo.origin.z;
    const axis = surfaceInfo.axis;
    const axial = dx * axis.x + dy * axis.y + dz * axis.z;
    normal = { x: dx - axial * axis.x, y: dy - axial * axis.y, z: dz - axial * axis.z };
  } else if (surfaceInfo.type === 'sphere') {
    normal = {
      x: point.x - surfaceInfo.origin.x,
      y: point.y - surfaceInfo.origin.y,
      z: point.z - surfaceInfo.origin.z,
    };
  } else if (surfaceInfo.type === 'cone' && surfaceInfo.axis) {
    const dx = point.x - surfaceInfo.origin.x;
    const dy = point.y - surfaceInfo.origin.y;
    const dz = point.z - surfaceInfo.origin.z;
    const axis = surfaceInfo.axis;
    const axial = dx * axis.x + dy * axis.y + dz * axis.z;
    const radial = { x: dx - axial * axis.x, y: dy - axial * axis.y, z: dz - axial * axis.z };
    const radialLength = Math.sqrt(radial.x * radial.x + radial.y * radial.y + radial.z * radial.z);
    if (radialLength < 1e-14) {
      normal = { ...axis };
    } else {
      const cosAngle = Math.cos(surfaceInfo.semiAngle || 0);
      const sinAngle = Math.sin(surfaceInfo.semiAngle || 0);
      normal = {
        x: (radial.x / radialLength) * cosAngle - axis.x * sinAngle,
        y: (radial.y / radialLength) * cosAngle - axis.y * sinAngle,
        z: (radial.z / radialLength) * cosAngle - axis.z * sinAngle,
      };
    }
  } else if (surfaceInfo.type === 'torus' && surfaceInfo.axis) {
    const dx = point.x - surfaceInfo.origin.x;
    const dy = point.y - surfaceInfo.origin.y;
    const dz = point.z - surfaceInfo.origin.z;
    const axis = surfaceInfo.axis;
    const axial = dx * axis.x + dy * axis.y + dz * axis.z;
    const radial = { x: dx - axial * axis.x, y: dy - axial * axis.y, z: dz - axial * axis.z };
    const radialLength = Math.sqrt(radial.x * radial.x + radial.y * radial.y + radial.z * radial.z);
    if (radialLength < 1e-14) {
      normal = { ...axis };
    } else {
      const center = {
        x: surfaceInfo.origin.x + (radial.x / radialLength) * surfaceInfo.majorR,
        y: surfaceInfo.origin.y + (radial.y / radialLength) * surfaceInfo.majorR,
        z: surfaceInfo.origin.z + (radial.z / radialLength) * surfaceInfo.majorR,
      };
      normal = { x: point.x - center.x, y: point.y - center.y, z: point.z - center.z };
    }
  }

  if (!normal) return null;
  const normalized = normalizeVector(normal);
  return sameSense === false
    ? { x: -normalized.x, y: -normalized.y, z: -normalized.z }
    : normalized;
}

function surfaceNormalAt(point, surface, sameSense) {
  if (!surface || typeof surface.closestPointUV !== 'function' || typeof surface.normal !== 'function') return null;
  try {
    const uv = surface.closestPointUV(point);
    const normal = surface.normal(uv.u, uv.v);
    if (!normal) return null;
    const normalized = normalizeVector(normal);
    return sameSense === false
      ? { x: -normalized.x, y: -normalized.y, z: -normalized.z }
      : normalized;
  } catch (_) {
    return null;
  }
}

function shouldPreferSurfaceNormals(info, vertices) {
  if (!info?.surface || !Array.isArray(vertices) || vertices.length !== 3) return false;
  if (info.preferSurfaceNormals !== undefined) return info.preferSurfaceNormals;

  if (info.shared?.isFillet || info.surfaceType === 'fillet') {
    info.preferSurfaceNormals = true;
    return true;
  }

  if (!info.hasFeatureSource || !info.surfaceInfo) return false;

  const centroid = {
    x: (vertices[0].x + vertices[1].x + vertices[2].x) / 3,
    y: (vertices[0].y + vertices[1].y + vertices[2].y) / 3,
    z: (vertices[0].z + vertices[1].z + vertices[2].z) / 3,
  };
  const analytic = analyticNormalAt(centroid, info.surfaceInfo, info.sameSense);
  if (!analytic) {
    info.preferSurfaceNormals = false;
    return false;
  }
  const exact = surfaceNormalAt(centroid, info.surface, info.sameSense);
  info.preferSurfaceNormals = !!(analytic && exact && dot3(analytic, exact) < -0.25);
  return info.preferSurfaceNormals;
}

function applyBodyRenderMetadata(body, mesh) {
  if (!body || !mesh || !Array.isArray(mesh.faces)) return mesh;

  const faceInfoById = new Map();
  for (const face of body.faces()) {
    faceInfoById.set(face.id, {
      surface: face.surface || null,
      surfaceInfo: face.surfaceInfo || null,
      sameSense: face.sameSense,
      shared: face.shared || null,
      surfaceType: face.surfaceType || null,
      isCurved: face.surfaceType !== 'plane' || !!(face.surfaceInfo && face.surfaceInfo.type !== 'plane'),
      hasFeatureSource: !!(face.shared?.sourceFeatureId || face.stableHash),
    });
  }

  for (const triangle of mesh.faces) {
    const info = faceInfoById.get(triangle?.topoFaceId);
    if (!info) continue;
    triangle.faceGroup = triangle.faceGroup ?? triangle.topoFaceId;
    triangle.faceType = triangle.faceType || (info.isCurved ? `curved-${info.surfaceType || 'surface'}` : 'planar');
    triangle.isCurved = !!info.isCurved;
    if (!triangle.shared && info.shared) triangle.shared = { ...info.shared };

    if (!Array.isArray(triangle.vertices) || triangle.vertices.length !== 3) continue;
    const geometricNormal = strictTriangleNormalFromVertices(triangle.vertices);
    if (!info.surfaceInfo) {
      if (geometricNormal) {
        const storedNormal = triangle.normal ? normalizeVector(triangle.normal) : null;
        if (!storedNormal || dot3(geometricNormal, storedNormal) < 0.2) {
          triangle.normal = geometricNormal;
        }
        if (!info.isCurved) delete triangle.vertexNormals;
      }
      continue;
    }
    if (!geometricNormal) continue;
    const preferSurfaceNormals = shouldPreferSurfaceNormals(info, triangle.vertices);
    const vertexNormals = triangle.vertices.map((vertex) =>
      preferSurfaceNormals
        ? surfaceNormalAt(vertex, info.surface, info.sameSense) || analyticNormalAt(vertex, info.surfaceInfo, info.sameSense)
        : analyticNormalAt(vertex, info.surfaceInfo, info.sameSense)
    );
    if (vertexNormals.some((normal) => !normal)) continue;

    const averageNormal = normalizeVector(vertexNormals.reduce((sum, normal) => ({
      x: sum.x + normal.x,
      y: sum.y + normal.y,
      z: sum.z + normal.z,
    }), { x: 0, y: 0, z: 0 }));
    if (geometricNormal.x * averageNormal.x + geometricNormal.y * averageNormal.y + geometricNormal.z * averageNormal.z < 0) {
      const swappedVertex = triangle.vertices[1];
      triangle.vertices[1] = triangle.vertices[2];
      triangle.vertices[2] = swappedVertex;
      const swappedNormal = vertexNormals[1];
      vertexNormals[1] = vertexNormals[2];
      vertexNormals[2] = swappedNormal;
    }
    triangle.normal = triangleNormalFromVertices(triangle.vertices);
    triangle.vertexNormals = vertexNormals.map((normal) => ({ ...normal }));
  }

  return mesh;
}

function projectPolygon2D(verts, normal) {
  const an = {
    x: Math.abs(normal?.x || 0),
    y: Math.abs(normal?.y || 0),
    z: Math.abs(normal?.z || 0),
  };
  if (an.z >= an.x && an.z >= an.y) {
    return verts.map((v) => ({ x: v.x, y: v.y }));
  }
  if (an.y >= an.x) {
    return verts.map((v) => ({ x: v.x, y: v.z }));
  }
  return verts.map((v) => ({ x: v.y, y: v.z }));
}

function triangulatePolygonIndices(verts, normal) {
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

  if (remaining.length === 3) {
    triangles.push([remaining[0], remaining[1], remaining[2]]);
  }

  if (triangles.length !== Math.max(0, verts.length - 2)) {
    const fan = [];
    for (let i = 1; i < verts.length - 1; i++) fan.push([0, i, i + 1]);
    return fan;
  }
  return triangles;
}

/**
 * Tessellate a TopoBody into a mesh geometry object compatible with the
 * existing rendering pipeline.
 *
 * When CAD_USE_ROBUST_TESSELLATOR is enabled (the default), this delegates
 * to the robust Tessellator2 pipeline.  If the robust path fails or
 * produces an empty mesh, the legacy ear-clipping path is used as a
 * fallback and the result is tagged with `_tessellator = 'legacy-fallback'`.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @param {number} [opts.chordalDeviation=0.01] - Max chordal deviation for curved surfaces
 * @param {number} [opts.angularTolerance=15] - Max angle (degrees) between adjacent normals
 * @param {number} [opts.surfaceSegments] - Segments for NURBS surface tessellation (from globalTessConfig)
 * @param {number} [opts.edgeSegments] - Segments for NURBS edge tessellation (from globalTessConfig)
 * @param {boolean} [opts.acceptWasmValidationIssues=false] - In strict mode, return native WASM mesh even when native mesh validation reports trim or boundary issues.
 * @returns {{ vertices: Array<{x,y,z}>, faces: Array<{vertices: Array<{x,y,z}>, normal: {x,y,z}, shared: Object}>, edges: Array }}
 */
export function tessellateBody(body, opts = {}) {
  // Merge with global config defaults so callers never need to specify segments
  opts = {
    surfaceSegments: globalTessConfig.surfaceSegments,
    edgeSegments: globalTessConfig.edgeSegments,
    ...opts,
  };
  // Early out: empty or null bodies produce empty meshes (e.g. intersect of
  // non-overlapping solids). No error — the caller handles the empty case.
  if (!body || !body.shells || body.shells.length === 0 ||
      body.faces().length === 0) {
    return { vertices: [], faces: [], edges: [], _tessellator: 'empty' };
  }

  // Validation honours caller intent: kernel paths (fillet/chamfer,
  // boolean) pass `validate: false` because they tessellate thousands of
  // times per operation and the O(n²) self-intersection check in
  // MeshValidator would dominate runtime. Default is true so callers that
  // just want "a mesh" still get a sanity check.
  const validate = opts.validate !== false;
  const requireWasm = opts.requireWasm === true
    || opts.throwOnJsFallback === true
    || getFlag('CAD_REQUIRE_WASM_TESSELLATION') === true;

  if (opts.incrementalCache && !requireWasm && opts.preferWasm !== true) {
    const incrementalResult = robustTessellateBody(body, { ...opts, validate });
    if (incrementalResult.faces.length > 0) {
      incrementalResult._tessellator = 'js-incremental';
      return applyBodyRenderMetadata(body, incrementalResult);
    }
  }

  // Primary path: native WASM tessellation pipeline (boundary-trimmed,
  // cross-parametric edge mapping, full kernel topology access).
  // All tessellation happens inside WASM — no JS fallback.
  const wasmResult = tessellateBodyWasm(body, opts);
  if (wasmResult && wasmResult.faces.length > 0) {
    const acceptWasmValidationIssues = opts.acceptWasmValidationIssues === true;
    const invalidFeaturePlanarTrims = acceptWasmValidationIssues ? false : meshHasInvalidFeaturePlanarTrims(body, wasmResult);
    const invalidWasmMesh = (requireWasm || opts.fallbackOnInvalidWasm) && !acceptWasmValidationIssues
      ? meshNeedsRobustFallback(body, wasmResult)
      : false;
    if (invalidFeaturePlanarTrims || ((requireWasm || opts.fallbackOnInvalidWasm) && invalidWasmMesh)) {
      if (requireWasm) {
        throw new Error(
          `[BRep-only] tessellateBody: WASM tessellation rejected (${invalidFeaturePlanarTrims ? 'invalid planar trim' : 'mesh quality'}); JS robust fallback is disabled.`
        );
      }
      const robustFallbackOpts = invalidFeaturePlanarTrims
        ? {
            ...opts,
            validate,
            edgeSegments: Math.max(opts.edgeSegments || 0, 64),
            surfaceSegments: Math.max(opts.surfaceSegments || 0, 16),
          }
        : { ...opts, validate };
      const robustFallback = robustTessellateBody(body, robustFallbackOpts);
      if (robustFallback.faces.length > 0) {
        robustFallback._tessellator = invalidFeaturePlanarTrims
          ? 'js-wasm-planar-trim-fallback'
          : 'js-wasm-quality-fallback';
        return applyBodyRenderMetadata(body, robustFallback);
      }
    }
    wasmResult._tessellator = 'wasm';
    return applyBodyRenderMetadata(body, wasmResult);
  }

  // WASM module not loaded or returned empty — use JS Tessellator2 as
  // a cold-start fallback only (WASM init is async, first call may miss).
  if (requireWasm) {
    throw new Error('[BRep-only] tessellateBody: WASM tessellation produced no mesh; JS robust fallback is disabled.');
  }
  const result = robustTessellateBody(body, { ...opts, validate });
  if (result.faces.length > 0) {
    result._tessellator = 'js-cold-start-fallback';
    return applyBodyRenderMetadata(body, result);
  }

  // If JS also fails but WASM had faces, use the WASM result.
  if (wasmResult && wasmResult.faces.length > 0) {
    wasmResult._tessellator = 'wasm';
    return applyBodyRenderMetadata(body, wasmResult);
  }

  throw new Error(
    '[BRep-only] tessellateBody: both WASM and JS tessellators produced empty meshes. ' +
    'Fix the TopoBody input or the tessellation pipeline.'
  );
}

/**
 * Count boundary edges in a triangle mesh.
 * A boundary edge is shared by exactly 1 triangle (non-watertight seam).
 * @param {Array<{vertices: Array<{x,y,z}>}>} faces
 * @returns {number} count of boundary edges
 */
export function _countBoundaryEdges(faces) {
  const counts = new Map();
  const snap = (v) => `${(v.x * 1e6 | 0)},${(v.y * 1e6 | 0)},${(v.z * 1e6 | 0)}`;
  for (const f of faces) {
    const verts = f.vertices;
    if (!verts || verts.length < 3) continue;
    for (let i = 0; i < verts.length; i++) {
      const ka = snap(verts[i]);
      const kb = snap(verts[(i + 1) % verts.length]);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let boundary = 0;
  for (const c of counts.values()) {
    if (c === 1) boundary++;
  }
  return boundary;
}

/**
 * Quick check for inverted face normals in a tessellated mesh.
 * Returns true if any face has a normal that disagrees with the
 * winding order of its vertices (cross-product test).
 *
 * @param {Array<{vertices: Array<{x,y,z}>, normal?: {x,y,z}}>} faces
 * @returns {boolean}
 */
export function _hasInvertedNormals(faces) {
  if (faces.length === 0) return false;
  for (const f of faces) {
    const v = f.vertices;
    const n = f.normal;
    if (!n || !v || v.length < 3) continue;
    const ux = v[1].x - v[0].x, uy = v[1].y - v[0].y, uz = v[1].z - v[0].z;
    const wx = v[2].x - v[0].x, wy = v[2].y - v[0].y, wz = v[2].z - v[0].z;
    const cx = uy * wz - uz * wy;
    const cy = uz * wx - ux * wz;
    const cz = ux * wy - uy * wx;
    if (cx * n.x + cy * n.y + cz * n.z < 0) return true;
  }
  return false;
}

/**
 * Legacy ear-clipping tessellation path.
 *
 * @deprecated Prefer the robust Tessellator2 pipeline via tessellateBody()
 *             with CAD_USE_ROBUST_TESSELLATOR enabled (now the default).
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @returns {{ vertices: Array, faces: Array, edges: Array }}
 */
export function _legacyTessellateBody(body, opts = {}) {
  const surfSegs = opts.surfaceSegments ?? 16;
  const edgeSegs = opts.edgeSegments ?? 64;

  const vertices = [];
  const faces = [];
  const edges = [];

  if (!body || !body.shells) return { vertices, faces, edges };

  for (const shell of body.shells) {
    for (const face of shell.faces) {
      const faceMesh = tessellateFace(face, surfSegs);
      for (const f of faceMesh.faces) {
        f.shared = face.shared || null;
        faces.push(f);
      }
      vertices.push(...faceMesh.vertices);
    }

    // Tessellate edges
    for (const edge of shell.edges()) {
      const pts = edge.tessellate(edgeSegs);
      if (pts.length >= 2) {
        edges.push({
          start: { ...pts[0] },
          end: { ...pts[pts.length - 1] },
          points: pts,
        });
      }
    }
  }

  return { vertices, faces, edges };
}

/**
 * Tessellate a single TopoFace.
 *
 * If the face has a NURBS surface, tessellates from the surface.
 * Otherwise, creates a polygon fan from the outer loop vertices.
 *
 * @param {import('./BRepTopology.js').TopoFace} face
 * @param {number} [segments=8]
 * @returns {{ vertices: Array<{x,y,z}>, faces: Array<{vertices: Array<{x,y,z}>, normal: {x,y,z}}> }}
 */
export function tessellateFace(face, segments = 8) {
  // Planar faces should tessellate from their trim loops, not from the full
  // support surface patch. Otherwise boolean-trimmed planar faces render as
  // their original untrimmed rectangles.
  if (face.surface && face.surfaceType !== 'plane') {
    const tess = face.surface.tessellate(segments, segments);
    // If face is reversed, flip normals and winding
    if (!face.sameSense) {
      for (const f of tess.faces) {
        f.vertices.reverse();
        f.normal = { x: -f.normal.x, y: -f.normal.y, z: -f.normal.z };
      }
    }
    return tess;
  }

  // If we have a NURBS surface, use it
  // Fallback: tessellate from loop vertices as a polygon
  if (!face.outerLoop) return { vertices: [], faces: [] };

  const pts = face.outerLoop.points();
  if (pts.length < 3) return { vertices: [], faces: [] };

  // Calculate face normal from first 3 vertices
  let orderedPts = pts;
  let normal = calculateNormal(orderedPts[0], orderedPts[1], orderedPts[2]);
  if (face.surface) {
    const surfNormal = face.surface.normal(
      (face.surface.uMin + face.surface.uMax) / 2,
      (face.surface.vMin + face.surface.vMax) / 2,
    );
    const desired = face.sameSense
      ? surfNormal
      : { x: -surfNormal.x, y: -surfNormal.y, z: -surfNormal.z };
    const dot = normal.x * desired.x + normal.y * desired.y + normal.z * desired.z;
    if (dot < 0) {
      orderedPts = [...pts].reverse();
      normal = { x: -normal.x, y: -normal.y, z: -normal.z };
    }
  }

  // Ear-clip planar polygons so non-convex exact-result faces render correctly.
  const meshFaces = [];
  for (const [a, b, c] of triangulatePolygonIndices(orderedPts, normal)) {
    meshFaces.push({
      vertices: [
        { ...orderedPts[a] },
        { ...orderedPts[b] },
        { ...orderedPts[c] },
      ],
      normal: { ...normal },
    });
  }

  return { vertices: orderedPts.map(p => ({ ...p })), faces: meshFaces };
}

/**
 * Tessellate a TopoBody for STL export with controlled tolerance.
 *
 * When CAD_USE_ROBUST_TESSELLATOR is enabled (the default), the robust
 * tessellator runs first with validation.  If its mesh passes validation
 * it is used; otherwise the legacy tessellator provides the fallback.
 *
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {Object} [opts]
 * @param {number} [opts.chordalDeviation=0.01] - Max chord deviation
 * @param {number} [opts.angularTolerance=15] - Max angle deviation (degrees)
 * @returns {Array<{vertices: [{x,y,z},{x,y,z},{x,y,z}], normal: {x,y,z}}>} Triangle array
 */
export function tessellateForSTL(body, opts = {}) {
  const chordalDev = opts.chordalDeviation ?? 0.01;

  // Determine segment count based on tolerance
  const segments = Math.max(4, Math.min(64, Math.ceil(1.0 / chordalDev)));

  // BRep-only: use robust tessellator, no legacy fallback
  const robustMesh = robustTessellateBody(body, {
    surfaceSegments: segments,
    validate: true,
  });
  if (robustMesh.faces.length > 0) {
    const triangles = _meshToTriangles(robustMesh);
    if (triangles.length > 0) {
      triangles._tessellator = 'robust';
      return triangles;
    }
  }
  throw new Error(
    '[BRep-only] tessellateForSTL: robust tessellator produced an empty mesh. ' +
    'Legacy ear-clipping fallback is no longer available.'
  );
}

/**
 * Calculate normal from three points.
 * @param {{x,y,z}} p0
 * @param {{x,y,z}} p1
 * @param {{x,y,z}} p2
 * @returns {{x:number,y:number,z:number}}
 */
function calculateNormal(p0, p1, p2) {
  const v1x = p1.x - p0.x, v1y = p1.y - p0.y, v1z = p1.z - p0.z;
  const v2x = p2.x - p0.x, v2y = p2.y - p0.y, v2z = p2.z - p0.z;
  const nx = v1y * v2z - v1z * v2y;
  const ny = v1z * v2x - v1x * v2z;
  const nz = v1x * v2y - v1y * v2x;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-14) return { x: 0, y: 0, z: 1 };
  return { x: nx / len, y: ny / len, z: nz / len };
}

/**
 * Convert a mesh result (vertices + faces) to an array of triangles.
 * @param {{ faces: Array<{vertices: Array<{x:number,y:number,z:number}>, normal?: {x:number,y:number,z:number}}> }} mesh
 * @returns {Array<{vertices: Array<{x:number,y:number,z:number}>, normal: {x:number,y:number,z:number}}>}
 */
function _meshToTriangles(mesh) {
  const triangles = [];
  for (const f of mesh.faces) {
    const verts = f.vertices;
    if (verts.length === 3) {
      triangles.push({
        vertices: [{ ...verts[0] }, { ...verts[1] }, { ...verts[2] }],
        normal: f.normal ? { ...f.normal } : calculateNormal(verts[0], verts[1], verts[2]),
      });
    } else if (verts.length === 4) {
      triangles.push({
        vertices: [{ ...verts[0] }, { ...verts[1] }, { ...verts[2] }],
        normal: f.normal ? { ...f.normal } : calculateNormal(verts[0], verts[1], verts[2]),
      });
      triangles.push({
        vertices: [{ ...verts[0] }, { ...verts[2] }, { ...verts[3] }],
        normal: f.normal ? { ...f.normal } : calculateNormal(verts[0], verts[2], verts[3]),
      });
    } else if (verts.length > 4) {
      for (let i = 1; i < verts.length - 1; i++) {
        triangles.push({
          vertices: [{ ...verts[0] }, { ...verts[i] }, { ...verts[i + 1] }],
          normal: f.normal ? { ...f.normal } : calculateNormal(verts[0], verts[i], verts[i + 1]),
        });
      }
    }
  }
  return triangles;
}

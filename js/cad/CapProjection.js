// js/cad/CapProjection.js — Shared helpers for exact fillet/chamfer cap projection.

import { SurfaceType } from './BRepTopology.js';
import {
  vec3Sub,
  vec3Add,
  vec3Scale,
  vec3Dot,
  vec3Cross,
  vec3Len,
  vec3Normalize,
} from './toolkit/Vec3Utils.js';

const DEFAULT_TOL = 1e-6;

export function topoPointsClose(a, b, tol = 1e-5) {
  if (!a || !b) return false;
  return vec3Len(vec3Sub(a, b)) <= tol;
}

export function findTopoEdgeByEndpoints(topoBody, pointA, pointB, tol = 1e-5) {
  if (!topoBody || typeof topoBody.edges !== 'function') return null;
  for (const edge of topoBody.edges()) {
    const start = edge.startVertex && edge.startVertex.point;
    const end = edge.endVertex && edge.endVertex.point;
    if (!start || !end) continue;
    if ((topoPointsClose(start, pointA, tol) && topoPointsClose(end, pointB, tol))
      || (topoPointsClose(start, pointB, tol) && topoPointsClose(end, pointA, tol))) {
      return edge;
    }
  }
  return null;
}

export function buildTopoFaceById(topoBody) {
  const out = new Map();
  if (!topoBody || typeof topoBody.faces !== 'function') return out;
  for (const face of topoBody.faces()) out.set(face.id, face);
  return out;
}

export function topoFacePlane(face) {
  if (!face || face.surfaceType !== SurfaceType.PLANE) return null;
  let point = null;
  let normal = null;

  if (face.surface && typeof face.surface.evaluate === 'function') {
    const u = Number.isFinite(face.surface.uMin) && Number.isFinite(face.surface.uMax)
      ? (face.surface.uMin + face.surface.uMax) * 0.5
      : 0.5;
    const v = Number.isFinite(face.surface.vMin) && Number.isFinite(face.surface.vMax)
      ? (face.surface.vMin + face.surface.vMax) * 0.5
      : 0.5;
    try {
      point = face.surface.evaluate(u, v);
      if (typeof face.surface.normal === 'function') normal = face.surface.normal(u, v);
    } catch (_) {
      point = null;
      normal = null;
    }
  }

  if (!point || !normal || vec3Len(normal) < 1e-12) {
    const points = face.outerLoop && typeof face.outerLoop.points === 'function'
      ? face.outerLoop.points()
      : [];
    if (points.length < 3) return null;
    point = points[0];
    for (let i = 1; i < points.length - 1; i++) {
      normal = vec3Cross(vec3Sub(points[i], point), vec3Sub(points[i + 1], point));
      if (vec3Len(normal) > 1e-12) break;
    }
  }

  if (!point || !normal || vec3Len(normal) < 1e-12) return null;
  normal = vec3Normalize(normal);
  if (face.sameSense === false) normal = vec3Scale(normal, -1);
  return { p0: { ...point }, n: normal, face };
}

function _edgeHasPoint(edge, point, tol) {
  return edge && (
    topoPointsClose(edge.startVertex && edge.startVertex.point, point, tol)
    || topoPointsClose(edge.endVertex && edge.endVertex.point, point, tol)
  );
}

function _incidentEdgeConnectsFace(edge, face) {
  if (!edge || !face) return false;
  for (const coedge of edge.coedges || []) {
    if (coedge && coedge.face === face) return true;
  }
  return false;
}

export function findTerminalCapFace(topoBody, selectedEdge, face0, face1, vertexPoint, tol = 1e-5) {
  if (!topoBody || typeof topoBody.faces !== 'function' || !selectedEdge || !vertexPoint) return null;
  let best = null;

  for (const face of topoBody.faces()) {
    if (!face || face === face0 || face === face1 || face.surfaceType !== SurfaceType.PLANE) continue;
    const vertices = typeof face.vertices === 'function' ? face.vertices() : [];
    if (!vertices.some((vertex) => topoPointsClose(vertex.point, vertexPoint, tol))) continue;

    let connects0 = false;
    let connects1 = false;
    let incidentCount = 0;
    for (const edge of face.edges()) {
      if (edge === selectedEdge || !_edgeHasPoint(edge, vertexPoint, tol)) continue;
      incidentCount++;
      if (_incidentEdgeConnectsFace(edge, face0)) connects0 = true;
      if (_incidentEdgeConnectsFace(edge, face1)) connects1 = true;
    }

    const score = (connects0 ? 2 : 0) + (connects1 ? 2 : 0) + Math.min(incidentCount, 2);
    if (!best || score > best.score) best = { face, score };
  }

  return best && best.score >= 2 ? best.face : null;
}

function _planeBasis(normal) {
  const ref = Math.abs(normal.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const u = vec3Normalize(vec3Cross(ref, normal));
  const v = vec3Normalize(vec3Cross(normal, u));
  return { u, v };
}

function _project2(point, origin, basis) {
  const rel = vec3Sub(point, origin);
  return { x: vec3Dot(rel, basis.u), y: vec3Dot(rel, basis.v) };
}

function _pointOnSegment2(point, a, b, tol) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = point.x - a.x;
  const apy = point.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < tol * tol) return Math.hypot(apx, apy) <= tol;
  const cross = Math.abs(abx * apy - aby * apx);
  if (cross > tol * Math.sqrt(lenSq)) return false;
  const dot = apx * abx + apy * aby;
  return dot >= -tol && dot <= lenSq + tol;
}

function _pointInPolygon2(point, polygon, tol) {
  if (!polygon || polygon.length < 3) return false;
  for (let i = 0; i < polygon.length; i++) {
    if (_pointOnSegment2(point, polygon[i], polygon[(i + 1) % polygon.length], tol)) return true;
  }

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersects = ((pi.y > point.y) !== (pj.y > point.y))
      && (point.x < (pj.x - pi.x) * (point.y - pi.y) / ((pj.y - pi.y) || 1e-30) + pi.x);
    if (intersects) inside = !inside;
  }
  return inside;
}

function _loopPoints(loop, samples = 12) {
  if (!loop || !Array.isArray(loop.coedges)) return [];
  const points = [];
  for (const coedge of loop.coedges) {
    if (!coedge || !coedge.edge) continue;
    let edgePoints = typeof coedge.edge.tessellate === 'function'
      ? coedge.edge.tessellate(samples)
      : [coedge.startVertex().point, coedge.endVertex().point];
    if (coedge.sameSense === false) edgePoints = edgePoints.reverse();
    if (points.length > 0 && edgePoints.length > 0) edgePoints = edgePoints.slice(1);
    points.push(...edgePoints.map((point) => ({ ...point })));
  }
  if (points.length > 1 && topoPointsClose(points[0], points[points.length - 1], DEFAULT_TOL)) points.pop();
  return points;
}

export function pointInTopoFaceDomain(face, point, tol = 1e-5) {
  const plane = topoFacePlane(face);
  if (!plane || !point) return false;
  if (Math.abs(vec3Dot(vec3Sub(point, plane.p0), plane.n)) > tol * 10) return false;
  const basis = _planeBasis(plane.n);
  const p2 = _project2(point, plane.p0, basis);
  const outer = _loopPoints(face.outerLoop).map((p) => _project2(p, plane.p0, basis));
  if (!_pointInPolygon2(p2, outer, tol)) return false;
  for (const loop of face.innerLoops || []) {
    const inner = _loopPoints(loop).map((p) => _project2(p, plane.p0, basis));
    if (_pointInPolygon2(p2, inner, tol)) return false;
  }
  return true;
}

export function projectLineToPlane(linePoint, lineDir, plane, tol = 1e-10) {
  if (!linePoint || !lineDir || !plane) return null;
  const denom = vec3Dot(lineDir, plane.n);
  if (Math.abs(denom) < tol) return null;
  const t = -vec3Dot(vec3Sub(linePoint, plane.p0), plane.n) / denom;
  return vec3Add(linePoint, vec3Scale(lineDir, t));
}

function _intersectLineCylinderAll(linePoint, lineDir, axisPoint, axisDir, radius) {
  const w = vec3Sub(linePoint, axisPoint);
  const wAxis = vec3Dot(w, axisDir);
  const dAxis = vec3Dot(lineDir, axisDir);
  const wp = vec3Sub(w, vec3Scale(axisDir, wAxis));
  const dp = vec3Sub(lineDir, vec3Scale(axisDir, dAxis));
  const a = vec3Dot(dp, dp);
  const b = 2 * vec3Dot(wp, dp);
  const c = vec3Dot(wp, wp) - radius * radius;
  if (Math.abs(a) < 1e-12) return [];
  const disc = b * b - 4 * a * c;
  if (disc < -1e-10) return [];
  if (Math.abs(disc) <= 1e-10) {
    return [vec3Add(linePoint, vec3Scale(lineDir, -b / (2 * a)))];
  }
  const sq = Math.sqrt(Math.max(0, disc));
  return [
    vec3Add(linePoint, vec3Scale(lineDir, (-b - sq) / (2 * a))),
    vec3Add(linePoint, vec3Scale(lineDir, (-b + sq) / (2 * a))),
  ];
}

function _lineFromPlanes(planeA, planeB) {
  const dirRaw = vec3Cross(planeA.n, planeB.n);
  const dirLen = vec3Len(dirRaw);
  if (dirLen < 1e-10) return null;
  const dir = vec3Scale(dirRaw, 1 / dirLen);
  const dA = vec3Dot(planeA.n, planeA.p0);
  const dB = vec3Dot(planeB.n, planeB.p0);
  const dirSq = vec3Dot(dirRaw, dirRaw);
  const termA = vec3Scale(vec3Cross(planeB.n, dirRaw), dA);
  const termB = vec3Scale(vec3Cross(dirRaw, planeA.n), dB);
  return { point: vec3Scale(vec3Add(termA, termB), 1 / dirSq), dir };
}

export function intersectPlanesWithCylinder(
  supportPlane,
  capPlane,
  axisPoint,
  axisDir,
  radius,
  nearPoint,
  supportFace = null,
  capFace = null,
) {
  const line = _lineFromPlanes(supportPlane, capPlane);
  if (!line) return null;
  const hits = _intersectLineCylinderAll(line.point, line.dir, axisPoint, axisDir, radius);
  if (hits.length === 0) return null;

  const scored = hits.map((point) => {
    let score = 0;
    if (!capFace || pointInTopoFaceDomain(capFace, point, 1e-4)) score += 8;
    if (!supportFace || pointInTopoFaceDomain(supportFace, point, 1e-4)) score += 4;
    return { point, score, dist: nearPoint ? vec3Len(vec3Sub(point, nearPoint)) : 0 };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.dist - b.dist));
  return scored[0].point;
}

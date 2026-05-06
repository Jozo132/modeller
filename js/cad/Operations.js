// js/cad/Operations.js — High-level geometry operations on primitives
//
// disconnect, union (join), trim, split, move point, move line
import {
  Coincident, Distance, Fixed, Horizontal, Vertical, Parallel, Perpendicular,
  Angle, EqualLength, Length, Tangent, OnLine, OnCircle,
} from './Constraint.js';
import { PSegment } from './Segment.js';
import { PArc } from './ArcPrimitive.js';

const TWO_PI = Math.PI * 2;
const MAX_CORNER_TRIM_RATIO = 0.95;

/**
 * Disconnect a point from coincident points — duplicate it so shapes no longer share.
 * Returns the new replacement point.
 */
export function disconnect(scene, point) {
  const shapes = scene.shapesUsingPoint(point);
  if (shapes.length <= 1) return point; // nothing to disconnect

  // Keep the first shape on the original point, give every other a clone
  const clones = [];
  for (let i = 1; i < shapes.length; i++) {
    const np = scene.addPoint(point.x, point.y);
    clones.push(np);
    const shape = shapes[i];
    if (shape.type === 'segment') {
      if (shape.p1 === point) shape.p1 = np;
      if (shape.p2 === point) shape.p2 = np;
    } else if (shape.type === 'circle') {
      shape.center = np;
    } else if (shape.type === 'arc') {
      if (shape.center === point) shape.center = np;
      if (shape.startPoint === point) shape.startPoint = np;
      if (shape.endPoint === point) shape.endPoint = np;
    }
  }

  // Remove coincident constraints that linked via this point
  scene.constraints = scene.constraints.filter(c =>
    !(c.type === 'coincident' && (c.ptA === point || c.ptB === point))
  );

  return clones;
}

/**
 * Union / join two points — merge ptB into ptA.
 * All shapes referencing ptB will now reference ptA.
 * Adds a coincident constraint implicitly (by making them the same object).
 */
export function union(scene, ptA, ptB) {
  if (ptA === ptB) return;
  // Move ptA to average position
  if (!ptA.fixed && !ptB.fixed) {
    ptA.x = (ptA.x + ptB.x) / 2;
    ptA.y = (ptA.y + ptB.y) / 2;
  } else if (ptB.fixed) {
    ptA.x = ptB.x; ptA.y = ptB.y;
    ptA.fixed = true;
  }

  // Re-wire shapes from ptB → ptA
  for (const s of scene.segments) {
    if (s.p1 === ptB) s.p1 = ptA;
    if (s.p2 === ptB) s.p2 = ptA;
  }
  for (const c of scene.circles) {
    if (c.center === ptB) c.center = ptA;
  }
  for (const a of scene.arcs) {
    if (a.center === ptB) a.center = ptA;
    if (a.startPoint === ptB) a.startPoint = ptA;
    if (a.endPoint === ptB) a.endPoint = ptA;
  }

  // Re-wire spline control points from ptB → ptA
  if (scene.splines) {
    for (const spl of scene.splines) {
      for (let i = 0; i < spl.points.length; i++) {
        if (spl.points[i] === ptB) spl.points[i] = ptA;
      }
    }
  }

  // Re-wire bezier vertex points from ptB → ptA
  if (scene.beziers) {
    for (const bez of scene.beziers) {
      for (let i = 0; i < bez.vertices.length; i++) {
        if (bez.vertices[i].point === ptB) bez.vertices[i].point = ptA;
      }
    }
  }

  // Remove degenerate segments (both endpoints now the same point)
  const degenerateSegs = scene.segments.filter(s => s.p1 === s.p2);
  if (degenerateSegs.length > 0) {
    const degSet = new Set(degenerateSegs);
    scene.segments = scene.segments.filter(s => !degSet.has(s));
    // Remove constraints that referenced degenerate segments
    scene.constraints = scene.constraints.filter(c => {
      if (c.seg && degSet.has(c.seg)) return false;
      if (c.segA && degSet.has(c.segA)) return false;
      if (c.segB && degSet.has(c.segB)) return false;
      return true;
    });
  }

  // Re-wire constraints from ptB → ptA, drop self-referencing coincidents
  for (const c of scene.constraints) {
    if (c.ptA === ptB) c.ptA = ptA;
    if (c.ptB === ptB) c.ptB = ptA;
    if (c.pt === ptB) c.pt = ptA;
  }
  scene.constraints = scene.constraints.filter(c =>
    !(c.type === 'coincident' && c.ptA === c.ptB)
  );

  // Remove the old point
  scene.points = scene.points.filter(p => p !== ptB);
}

/**
 * Trim a segment at a world position, keeping the side closer to the specified keep-point.
 * Splits the segment into two; removes the far half.
 *
 * @param {import('./Scene.js').Scene} scene
 * @param {import('./Segment.js').PSegment} seg
 * @param {number} wx — cut world x
 * @param {number} wy — cut world y
 * @param {number} keepX — keep the side containing this point
 * @param {number} keepY
 */
export function trim(scene, seg, wx, wy, keepX, keepY) {
  // Project cut point onto line
  const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
  const len = Math.hypot(dx, dy) || 1e-9;
  let t = ((wx - seg.x1) * dx + (wy - seg.y1) * dy) / (len * len);
  t = Math.max(0.01, Math.min(0.99, t));

  const cutX = seg.x1 + t * dx;
  const cutY = seg.y1 + t * dy;

  // Which side to keep?
  const d1 = Math.hypot(keepX - seg.x1, keepY - seg.y1);
  const d2 = Math.hypot(keepX - seg.x2, keepY - seg.y2);

  let movedPt;
  if (d1 < d2) {
    // Keep p1-side: move p2 to cut
    seg.p2.x = cutX; seg.p2.y = cutY;
    movedPt = seg.p2;
  } else {
    // Keep p2-side: move p1 to cut
    seg.p1.x = cutX; seg.p1.y = cutY;
    movedPt = seg.p1;
  }

  scene.solve();

  // After trim, if the moved endpoint forms a collinear junction, merge
  mergeCollinearAtPoint(scene, movedPt);
}

/**
 * Split a segment at a world position into two segments sharing a point.
 * Duplicates relevant constraints from the original onto both new sub-segments.
 *
 * @returns {[PSegment, PSegment]} — the two new segments (original is removed)
 */
export function split(scene, seg, wx, wy) {
  const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
  const len = Math.hypot(dx, dy) || 1e-9;
  let t = ((wx - seg.x1) * dx + (wy - seg.y1) * dy) / (len * len);
  t = Math.max(0.01, Math.min(0.99, t));

  const mx = seg.x1 + t * dx;
  const my = seg.y1 + t * dy;

  // Collect constraints referencing the original segment BEFORE it's removed
  const segConstraints = scene.constraints.filter(c =>
    c.seg === seg || c.segA === seg || c.segB === seg
  );

  const midPt = scene.addPoint(mx, my);

  const s1 = scene.addSegment(seg.x1, seg.y1, mx, my, { merge: false, layer: seg.layer, color: seg.color });
  // Re-point s1.p1 to original p1
  _replacePoint(s1, s1.p1, seg.p1, scene);
  _replacePoint(s1, s1.p2, midPt, scene);

  const s2 = scene.addSegment(mx, my, seg.x2, seg.y2, { merge: false, layer: seg.layer, color: seg.color });
  _replacePoint(s2, s2.p1, midPt, scene);
  _replacePoint(s2, s2.p2, seg.p2, scene);

  scene.removeSegment(seg);

  // Duplicate constraints onto both new sub-segments
  for (const c of segConstraints) {
    _duplicateConstraintForSplit(scene, c, seg, s1, s2);
  }

  return [s1, s2];
}

/**
 * Move a single point (the solver will enforce constraints afterward).
 */
export function movePoint(scene, pt, newX, newY) {
  if (pt.fixed) return;
  pt.x = newX;
  pt.y = newY;
  scene.solve();
}

/**
 * Move a shape (all its defining points) by (dx, dy), then re-solve.
 */
export function moveShape(scene, shape, dx, dy) {
  const pts = _shapePoints(shape);
  for (const p of pts) {
    if (!p.fixed) { p.x += dx; p.y += dy; }
  }
  scene.solve();
}

export function chamferSketchCorner(scene, selection, distance, options = {}) {
  const corner = resolveSketchCorner(scene, selection);
  const amount = Number(distance);
  if (!corner || !Number.isFinite(amount) || amount <= 0) return null;

  const geom = _cornerTrimGeometry(corner, amount);
  const { pA, pB } = _replaceCornerEndpoints(scene, corner, geom.trimA, geom.trimB);
  const chamfer = new PSegment(pA, pB);
  _copySketchStyle(chamfer, corner.segA, options);
  scene.segments.push(chamfer);
  _finishCornerReplacement(scene);
  return { type: 'chamfer', segment: chamfer, pA, pB, corner };
}

export function filletSketchCorner(scene, selection, radius, options = {}) {
  const corner = resolveSketchCorner(scene, selection);
  const r = Number(radius);
  if (!corner || !Number.isFinite(r) || r <= 0) return null;

  const theta = _cornerAngle(corner);
  if (theta <= 1e-6 || Math.abs(Math.PI - theta) <= 1e-6) return null;
  const trimDistance = r / Math.tan(theta / 2);
  const geom = _cornerTrimGeometry(corner, trimDistance);
  const bisector = _normalize({ x: corner.uA.x + corner.uB.x, y: corner.uA.y + corner.uB.y });
  if (!bisector) return null;
  const centerDistance = r / Math.sin(theta / 2);
  const center = {
    x: corner.x + bisector.x * centerDistance,
    y: corner.y + bisector.y * centerDistance,
  };

  const { pA, pB } = _replaceCornerEndpoints(scene, corner, geom.trimA, geom.trimB);
  const centerPoint = scene.addPoint(center.x, center.y);
  const startAngle = Math.atan2(pA.y - center.y, pA.x - center.x);
  let endAngle = Math.atan2(pB.y - center.y, pB.x - center.x);
  let sweep = endAngle - startAngle;
  while (sweep > Math.PI) { endAngle -= TWO_PI; sweep = endAngle - startAngle; }
  while (sweep < -Math.PI) { endAngle += TWO_PI; sweep = endAngle - startAngle; }

  const arc = new PArc(centerPoint, r, startAngle, endAngle, pA, pB);
  _copySketchStyle(arc, corner.segA, options);
  scene.arcs.push(arc);
  _finishCornerReplacement(scene);
  return { type: 'fillet', arc, pA, pB, center: centerPoint, corner };
}

export function resolveSketchCorner(scene, selection) {
  const selected = Array.isArray(selection) ? selection.filter(Boolean) : [];
  const selectedPoints = selected.filter(e => e.type === 'point');
  const selectedSegments = selected.filter(e => e.type === 'segment');

  if (selectedPoints.length === 1) {
    return _cornerFromPoint(scene, selectedPoints[0]);
  }
  if (selectedSegments.length >= 2) {
    return _cornerFromSegments(scene, selectedSegments[0], selectedSegments[1]);
  }
  if (selectedSegments.length === 1) {
    return _cornerFromSingleSegment(scene, selectedSegments[0]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _shapePoints(shape) {
  if (shape.type === 'segment') return [shape.p1, shape.p2];
  if (shape.type === 'circle' || shape.type === 'arc') return [shape.center];
  return [];
}

function _copySketchStyle(target, source, options) {
  target.layer = options.layer || source.layer;
  target.color = options.color ?? source.color;
  target.construction = options.construction ?? source.construction;
  if (source.constructionDash) target.constructionDash = source.constructionDash;
}

function _cornerFromPoint(scene, point) {
  const refs = _segmentEndpointRefs(scene, point);
  if (refs.length !== 2) return null;
  return _makeCorner(refs[0], refs[1]);
}

function _cornerFromSingleSegment(scene, seg) {
  const candidates = [];
  for (const point of [seg.p1, seg.p2]) {
    const refs = _segmentEndpointRefs(scene, point).filter(ref => ref.seg !== seg);
    if (refs.length === 1) candidates.push(_makeCorner({ seg, point }, refs[0]));
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function _cornerFromSegments(scene, segA, segB) {
  const pairs = [];
  for (const pA of [segA.p1, segA.p2]) {
    for (const pB of [segB.p1, segB.p2]) {
      if (_pointsCoincident(scene, pA, pB)) pairs.push([{ seg: segA, point: pA }, { seg: segB, point: pB }]);
    }
  }
  return pairs.length === 1 ? _makeCorner(pairs[0][0], pairs[0][1]) : null;
}

function _segmentEndpointRefs(scene, point) {
  const refs = [];
  for (const seg of scene.segments || []) {
    if (_pointsCoincident(scene, seg.p1, point)) refs.push({ seg, point: seg.p1 });
    if (_pointsCoincident(scene, seg.p2, point)) refs.push({ seg, point: seg.p2 });
  }
  return refs;
}

function _pointsCoincident(scene, a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.hypot(a.x - b.x, a.y - b.y) <= 1e-7) return true;
  return (scene.constraints || []).some(c =>
    c.type === 'coincident'
    && ((c.ptA === a && c.ptB === b) || (c.ptA === b && c.ptB === a))
  );
}

function _makeCorner(refA, refB) {
  if (!refA || !refB || refA.seg === refB.seg) return null;
  const otherA = refA.seg.p1 === refA.point ? refA.seg.p2 : refA.seg.p1;
  const otherB = refB.seg.p1 === refB.point ? refB.seg.p2 : refB.seg.p1;
  const x = (refA.point.x + refB.point.x) / 2;
  const y = (refA.point.y + refB.point.y) / 2;
  const uA = _normalize({ x: otherA.x - x, y: otherA.y - y });
  const uB = _normalize({ x: otherB.x - x, y: otherB.y - y });
  if (!uA || !uB) return null;
  return { segA: refA.seg, segB: refB.seg, pointA: refA.point, pointB: refB.point, otherA, otherB, x, y, uA, uB };
}

function _normalize(v) {
  const len = Math.hypot(v.x, v.y);
  if (len <= 1e-9) return null;
  return { x: v.x / len, y: v.y / len };
}

function _cornerAngle(corner) {
  const dot = Math.max(-1, Math.min(1, corner.uA.x * corner.uB.x + corner.uA.y * corner.uB.y));
  return Math.acos(dot);
}

function _cornerTrimGeometry(corner, distance) {
  const maxA = Math.hypot(corner.otherA.x - corner.x, corner.otherA.y - corner.y) * MAX_CORNER_TRIM_RATIO;
  const maxB = Math.hypot(corner.otherB.x - corner.x, corner.otherB.y - corner.y) * MAX_CORNER_TRIM_RATIO;
  const d = Math.min(distance, maxA, maxB);
  return {
    trimA: { x: corner.x + corner.uA.x * d, y: corner.y + corner.uA.y * d },
    trimB: { x: corner.x + corner.uB.x * d, y: corner.y + corner.uB.y * d },
  };
}

function _replaceCornerEndpoints(scene, corner, trimA, trimB) {
  const oldPoints = new Set([corner.pointA, corner.pointB]);
  const pA = scene.addPoint(trimA.x, trimA.y);
  const pB = scene.addPoint(trimB.x, trimB.y);
  _duplicateCornerPointConstraints(scene, oldPoints, pA);
  _duplicateCornerPointConstraints(scene, oldPoints, pB);
  _setSegmentEndpoint(corner.segA, corner.pointA, pA);
  _setSegmentEndpoint(corner.segB, corner.pointB, pB);
  return { pA, pB };
}

function _setSegmentEndpoint(seg, oldPt, newPt) {
  if (seg.p1 === oldPt) seg.p1 = newPt;
  if (seg.p2 === oldPt) seg.p2 = newPt;
}

function _duplicateCornerPointConstraints(scene, oldPoints, newPt) {
  const hasOld = (point) => oldPoints.has(point);
  const constraints = [...(scene.constraints || [])];
  for (const c of constraints) {
    if (c.type === 'fixed' && hasOld(c.pt)) {
      scene.constraints.push(new Fixed(newPt, newPt.x, newPt.y));
    } else if (c.type === 'distance') {
      if (hasOld(c.ptA) && !hasOld(c.ptB)) scene.constraints.push(new Distance(newPt, c.ptB, c.value));
      else if (hasOld(c.ptB) && !hasOld(c.ptA)) scene.constraints.push(new Distance(c.ptA, newPt, c.value));
    } else if (c.type === 'coincident') {
      if (hasOld(c.ptA) && !hasOld(c.ptB)) scene.constraints.push(new Coincident(newPt, c.ptB));
      else if (hasOld(c.ptB) && !hasOld(c.ptA)) scene.constraints.push(new Coincident(c.ptA, newPt));
    } else if (c.type === 'on_line' && hasOld(c.pt)) {
      scene.constraints.push(new OnLine(newPt, c.seg));
    } else if (c.type === 'on_circle' && hasOld(c.pt)) {
      scene.constraints.push(new OnCircle(newPt, c.circle));
    }
  }
}

function _finishCornerReplacement(scene) {
  if (typeof scene._cleanOrphanPoints === 'function') scene._cleanOrphanPoints();
  scene.solve();
}

/**
 * After a segment split, duplicate a constraint that referenced the original segment
 * onto both new sub-segments.
 */
function _duplicateConstraintForSplit(scene, c, origSeg, s1, s2) {
  const ty = c.type;

  // Single-segment constraints (seg field):
  if (c.seg === origSeg) {
    if (ty === 'horizontal')  { scene.addConstraint(new Horizontal(s1)); scene.addConstraint(new Horizontal(s2)); }
    else if (ty === 'vertical') { scene.addConstraint(new Vertical(s1)); scene.addConstraint(new Vertical(s2)); }
    else if (ty === 'tangent') { scene.addConstraint(new Tangent(s1, c.circle)); scene.addConstraint(new Tangent(s2, c.circle)); }
    else if (ty === 'on_line') { scene.addConstraint(new OnLine(c.pt, s1)); scene.addConstraint(new OnLine(c.pt, s2)); }
    // Length / Midpoint don't make sense after split — skip
    return;
  }

  // Two-segment constraints (segA / segB):
  const other = c.segA === origSeg ? c.segB : c.segA;
  const isA   = c.segA === origSeg;
  if (ty === 'parallel') {
    scene.addConstraint(new Parallel(isA ? s1 : other, isA ? other : s1));
    scene.addConstraint(new Parallel(isA ? s2 : other, isA ? other : s2));
  } else if (ty === 'perpendicular') {
    scene.addConstraint(new Perpendicular(isA ? s1 : other, isA ? other : s1));
    scene.addConstraint(new Perpendicular(isA ? s2 : other, isA ? other : s2));
  } else if (ty === 'angle') {
    scene.addConstraint(new Angle(isA ? s1 : other, isA ? other : s1, c.value));
    scene.addConstraint(new Angle(isA ? s2 : other, isA ? other : s2, c.value));
  } else if (ty === 'equal_length') {
    scene.addConstraint(new EqualLength(isA ? s1 : other, isA ? other : s1));
    scene.addConstraint(new EqualLength(isA ? s2 : other, isA ? other : s2));
  }
}

/**
 * After a trim, check if the moved endpoint sits at a shared point where
 * two collinear segments meet. If so, merge them into one segment.
 */
export function mergeCollinearAtPoint(scene, pt) {
  const segs = scene.segments.filter(s => s.p1 === pt || s.p2 === pt);
  if (segs.length !== 2) return null;

  const [sA, sB] = segs;
  // Direction vectors
  const dxA = sA.x2 - sA.x1, dyA = sA.y2 - sA.y1;
  const dxB = sB.x2 - sB.x1, dyB = sB.y2 - sB.y1;
  const lenA = Math.hypot(dxA, dyA) || 1e-9;
  const lenB = Math.hypot(dxB, dyB) || 1e-9;

  // Cross-product of unit vectors — near-zero means collinear
  const cross = Math.abs((dxA / lenA) * (dyB / lenB) - (dyA / lenA) * (dxB / lenB));
  if (cross > 0.01) return null; // not collinear (> ~0.6°)

  // Determine the two outer endpoints (the ones that are NOT the shared point)
  const outerA = sA.p1 === pt ? sA.p2 : sA.p1;
  const outerB = sB.p1 === pt ? sB.p2 : sB.p1;

  // Create a merged segment using the two outer points
  const merged = scene.addSegment(outerA.x, outerA.y, outerB.x, outerB.y,
    { merge: false, layer: sA.layer, color: sA.color });
  _replacePoint(merged, merged.p1, outerA, scene);
  _replacePoint(merged, merged.p2, outerB, scene);

  // Collect constraints from both old segments and duplicate onto merged
  const oldConstraints = scene.constraints.filter(c =>
    c.seg === sA || c.segA === sA || c.segB === sA ||
    c.seg === sB || c.segA === sB || c.segB === sB
  );

  scene.removeSegment(sA);
  scene.removeSegment(sB);

  // Duplicate constraints (use sA as the "original" reference for each)
  const seen = new Set();
  for (const c of oldConstraints) {
    const key = c.type + ':' + c.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const origSeg = (c.seg === sA || c.segA === sA || c.segB === sA) ? sA : sB;
    _reattachConstraintAfterMerge(scene, c, origSeg, merged);
  }

  return merged;
}

/** Re-attach a single constraint from an old segment to a merged segment. */
function _reattachConstraintAfterMerge(scene, c, origSeg, merged) {
  const ty = c.type;
  if (c.seg === origSeg) {
    if (ty === 'horizontal')  scene.addConstraint(new Horizontal(merged));
    else if (ty === 'vertical') scene.addConstraint(new Vertical(merged));
    else if (ty === 'tangent') scene.addConstraint(new Tangent(merged, c.circle));
    else if (ty === 'on_line') scene.addConstraint(new OnLine(c.pt, merged));
    else if (ty === 'length')  scene.addConstraint(new Length(merged, c.value));
    return;
  }
  if (c.segA === origSeg || c.segB === origSeg) {
    const other = c.segA === origSeg ? c.segB : c.segA;
    if (other === origSeg) return; // self-ref
    const isA = c.segA === origSeg;
    if (ty === 'parallel')       scene.addConstraint(new Parallel(isA ? merged : other, isA ? other : merged));
    else if (ty === 'perpendicular') scene.addConstraint(new Perpendicular(isA ? merged : other, isA ? other : merged));
    else if (ty === 'angle')     scene.addConstraint(new Angle(isA ? merged : other, isA ? other : merged, c.value));
    else if (ty === 'equal_length') scene.addConstraint(new EqualLength(isA ? merged : other, isA ? other : merged));
  }
}

function _replacePoint(seg, oldPt, newPt, scene) {
  if (seg.p1 === oldPt) seg.p1 = newPt;
  if (seg.p2 === oldPt) seg.p2 = newPt;
  // Remove orphan
  if (!scene.segments.some(s => s.p1 === oldPt || s.p2 === oldPt) &&
      !scene.circles.some(c => c.center === oldPt) &&
      !scene.arcs.some(a => a.center === oldPt)) {
    scene.points = scene.points.filter(p => p !== oldPt);
  }
}

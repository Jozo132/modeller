// js/cad/Operations.js — High-level geometry operations on primitives
//
// disconnect, union (join), trim, split, move point, move line
import { Coincident } from './Constraint.js';

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
    } else if (shape.type === 'circle' || shape.type === 'arc') {
      shape.center = np;
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

  if (d1 < d2) {
    // Keep p1-side: move p2 to cut
    seg.p2.x = cutX; seg.p2.y = cutY;
  } else {
    // Keep p2-side: move p1 to cut
    seg.p1.x = cutX; seg.p1.y = cutY;
  }

  scene.solve();
}

/**
 * Split a segment at a world position into two segments sharing a point.
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

  const midPt = scene.addPoint(mx, my);

  const s1 = scene.addSegment(seg.x1, seg.y1, mx, my, { merge: false, layer: seg.layer, color: seg.color });
  // Re-point s1.p1 to original p1
  _replacePoint(s1, s1.p1, seg.p1, scene);
  _replacePoint(s1, s1.p2, midPt, scene);

  const s2 = scene.addSegment(mx, my, seg.x2, seg.y2, { merge: false, layer: seg.layer, color: seg.color });
  _replacePoint(s2, s2.p1, midPt, scene);
  _replacePoint(s2, s2.p2, seg.p2, scene);

  scene.removeSegment(seg);
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _shapePoints(shape) {
  if (shape.type === 'segment') return [shape.p1, shape.p2];
  if (shape.type === 'circle' || shape.type === 'arc') return [shape.center];
  return [];
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

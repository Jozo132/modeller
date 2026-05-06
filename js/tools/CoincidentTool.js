// js/tools/CoincidentTool.js — Make two points coincident.
// When the target is a line body, project the point onto the line
// (or follow the source line's direction to the intersection).
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { OnCircle, OnLine } from '../cad/Constraint.js';
import { union } from '../cad/Operations.js';

const PT_PX = 12;   // pixel tolerance for point picking
const SEG_PX = 16;   // pixel tolerance for segment picking

export class CoincidentTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'coincident';
    this._firstPt = null;
  }

  activate() {
    super.activate();
    this._firstPt = null;
    this.step = 0;
    this.setStatus('Click a point');
  }

  deactivate() {
    this._firstPt = null;
    this.app.renderer.hoverEntity = null;
    super.deactivate();
  }

  // ---- helpers ----

  _findPoint(wx, wy) {
    const tol = PT_PX / this._effectiveZoom();
    return state.scene.findClosestPoint(wx, wy, tol);
  }

  _findSegment(wx, wy) {
    const tol = SEG_PX / this._effectiveZoom();
    const hit = state.scene.findClosestShape(wx, wy, tol);
    return (hit && (hit.type === 'segment' || hit.type === 'circle' || hit.type === 'arc')) ? hit : null;
  }

  /**
   * Move `pt` onto `targetSeg`.
   * If `pt` is an endpoint of a segment, slide it along that segment's
   * direction until it intersects `targetSeg` (concentric move).
   * Otherwise, project perpendicularly onto the target.
   */
  _movePointToLine(pt, targetSeg) {
    const parentSegs = state.scene.segments.filter(
      s => s.p1 === pt || s.p2 === pt
    );

    // Try concentric (line-line intersection): use first parent segment
    if (parentSegs.length > 0) {
      for (const parentSeg of parentSegs) {
        const ix = _lineLineIntersect(
          parentSeg.x1, parentSeg.y1, parentSeg.x2, parentSeg.y2,
          targetSeg.x1, targetSeg.y1, targetSeg.x2, targetSeg.y2,
        );
        if (ix) {
          this._movePointPreservingArcEndpoint(pt, ix.x, ix.y);
          return;
        }
      }
      // All parent lines are parallel to target — fall through to perpendicular
    }

    // Perpendicular projection onto target segment's infinite line
    const dx = targetSeg.x2 - targetSeg.x1;
    const dy = targetSeg.y2 - targetSeg.y1;
    const len2 = dx * dx + dy * dy || 1e-18;
    const t = ((pt.x - targetSeg.x1) * dx + (pt.y - targetSeg.y1) * dy) / len2;
    this._movePointPreservingArcEndpoint(pt, targetSeg.x1 + t * dx, targetSeg.y1 + t * dy);
  }

  _movePointToCircle(pt, circle, wx = pt.x, wy = pt.y) {
    let angle = Math.atan2(wy - circle.cy, wx - circle.cx);
    if (circle.type === 'arc' && !circle._angleInArc(angle)) {
      const start = circle.startPt;
      const end = circle.endPt;
      if (Math.hypot(wx - end.x, wy - end.y) < Math.hypot(wx - start.x, wy - start.y)) {
        angle = circle.endAngle;
      } else {
        angle = circle.startAngle;
      }
    }
    this._movePointPreservingArcEndpoint(
      pt,
      circle.cx + Math.cos(angle) * circle.radius,
      circle.cy + Math.sin(angle) * circle.radius
    );
  }

  _arcEndpointRefs(pt) {
    const refs = [];
    for (const arc of state.scene.arcs || []) {
      if (arc.startPoint === pt) refs.push({ arc, which: 'start' });
      if (arc.endPoint === pt) refs.push({ arc, which: 'end' });
    }
    return refs;
  }

  _movePointPreservingArcEndpoint(pt, x, y) {
    const refs = this._arcEndpointRefs(pt);
    if (refs.length === 0) {
      pt.x = x;
      pt.y = y;
      return;
    }
    for (const ref of refs) {
      ref.arc.setEndpointPosition(ref.which, x, y);
    }
    pt.x = x;
    pt.y = y;
  }

  // ---- events ----

  onMouseMove(wx, wy) {
    const pt = this._findPoint(wx, wy);
    if (pt) { this.app.renderer.hoverEntity = pt; return; }
    const seg = this._findSegment(wx, wy);
    this.app.renderer.hoverEntity = seg;
  }

  onClick(wx, wy) {
    if (this.step === 0) {
      // First click — pick a point
      const pt = this._findPoint(wx, wy);
      if (!pt) { this.setStatus('No point found — click closer to a point'); return; }
      this._firstPt = pt;
      this.step = 1;
      this.setStatus('Click second point, or an edge to project onto');
    } else {
      // Second click — destination: point or edge body
      const pt = this._findPoint(wx, wy);
      if (pt) {
        if (pt === this._firstPt) { this.setStatus('Same point — pick a different one'); return; }
        takeSnapshot();
        const firstRefs = this._arcEndpointRefs(this._firstPt);
        const targetRefs = this._arcEndpointRefs(pt);
        if (firstRefs.length > 0) {
          this._movePointPreservingArcEndpoint(this._firstPt, pt.x, pt.y);
        } else if (targetRefs.length > 0) {
          this._movePointPreservingArcEndpoint(pt, this._firstPt.x, this._firstPt.y);
        }
        union(state.scene, this._firstPt, pt);
        state.emit('change');
        this._firstPt = null;
        this.step = 0;
        this.setStatus('Coincident / union done. Click first point for next, or switch tool.');
        return;
      }

      // Clicking on an edge body → project point onto line/circle/arc
      const seg = this._findSegment(wx, wy);
      if (!seg) { this.setStatus('No point or edge found — click closer'); return; }

      // Don't project if the point is already an endpoint of the target
      if (this._firstPt === seg.p1 || this._firstPt === seg.p2 || this._firstPt === seg.center || this._firstPt === seg.startPoint || this._firstPt === seg.endPoint) {
        this.setStatus('Point is already on this edge');
        return;
      }

      takeSnapshot();
      if (seg.type === 'segment') {
        this._movePointToLine(this._firstPt, seg);
        state.scene.addConstraint(new OnLine(this._firstPt, seg));
      } else {
        this._movePointToCircle(this._firstPt, seg, wx, wy);
        state.scene.addConstraint(new OnCircle(this._firstPt, seg));
      }
      state.emit('change');
      this._firstPt = null;
      this.step = 0;
      this.setStatus('Point moved onto edge. Click first point for next, or switch tool.');
    }
  }

  onCancel() {
    this._firstPt = null;
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }
}

// ---------------------------------------------------------------------------
// Line-line intersection (infinite lines) — returns {x,y} or null (parallel)
// ---------------------------------------------------------------------------
function _lineLineIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
  const dx1 = ax2 - ax1, dy1 = ay2 - ay1;
  const dx2 = bx2 - bx1, dy2 = by2 - by1;
  const cross = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(cross) < 1e-10) return null; // parallel
  const t = ((bx1 - ax1) * dy2 - (by1 - ay1) * dx2) / cross;
  return { x: ax1 + t * dx1, y: ay1 + t * dy1 };
}

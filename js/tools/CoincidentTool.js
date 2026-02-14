// js/tools/CoincidentTool.js — Make two points coincident.
// When the target is a line body, project the point onto the line
// (or follow the source line's direction to the intersection).
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { OnLine } from '../cad/Constraint.js';
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
    const tol = PT_PX / this.app.viewport.zoom;
    return state.scene.findClosestPoint(wx, wy, tol);
  }

  _findSegment(wx, wy) {
    const tol = SEG_PX / this.app.viewport.zoom;
    const hit = state.scene.findClosestShape(wx, wy, tol);
    return (hit && hit.type === 'segment') ? hit : null;
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
          pt.x = ix.x;
          pt.y = ix.y;
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
    pt.x = targetSeg.x1 + t * dx;
    pt.y = targetSeg.y1 + t * dy;
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
      this.setStatus('Click second point, or a line to project onto');
    } else {
      // Second click — destination: point or line body
      const pt = this._findPoint(wx, wy);
      if (pt) {
        if (pt === this._firstPt) { this.setStatus('Same point — pick a different one'); return; }
        takeSnapshot();
        union(state.scene, this._firstPt, pt);
        state.emit('change');
        this._firstPt = null;
        this.step = 0;
        this.setStatus('Coincident / union done. Click first point for next, or switch tool.');
        return;
      }

      // Clicking on a line body → project point onto line
      const seg = this._findSegment(wx, wy);
      if (!seg) { this.setStatus('No point or line found — click closer'); return; }

      // Don't project if the point is already an endpoint of the target
      if (this._firstPt === seg.p1 || this._firstPt === seg.p2) {
        this.setStatus('Point is already on this line');
        return;
      }

      takeSnapshot();
      this._movePointToLine(this._firstPt, seg);
      // Add OnLine constraint so the point stays on the target line
      state.scene.addConstraint(new OnLine(this._firstPt, seg));
      state.emit('change');
      this._firstPt = null;
      this.step = 0;
      this.setStatus('Point moved onto line. Click first point for next, or switch tool.');
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

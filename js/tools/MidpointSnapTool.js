// js/tools/MidpointSnapTool.js — Snap a point to the midpoint of a segment
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { Midpoint } from '../cad/Constraint.js';

const PT_PX = 12;
const SEG_PX = 16;

export class MidpointSnapTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'midpoint_snap';
    this._firstPt = null;
  }

  activate() {
    super.activate();
    this._firstPt = null;
    this.step = 0;
    this.setStatus('Click a point to snap to a midpoint');
  }

  deactivate() {
    this._firstPt = null;
    this.app.renderer.hoverEntity = null;
    super.deactivate();
  }

  _findPoint(wx, wy) {
    const tol = PT_PX / this._effectiveZoom();
    return state.scene.findClosestPoint(wx, wy, tol);
  }

  _findSegment(wx, wy) {
    const tol = SEG_PX / this._effectiveZoom();
    const hit = state.scene.findClosestShape(wx, wy, tol);
    return (hit && hit.type === 'segment') ? hit : null;
  }

  onMouseMove(wx, wy) {
    if (this.step === 0) {
      const pt = this._findPoint(wx, wy);
      this.app.renderer.hoverEntity = pt;
    } else {
      const seg = this._findSegment(wx, wy);
      this.app.renderer.hoverEntity = seg;
    }
  }

  onClick(wx, wy) {
    if (this.step === 0) {
      const pt = this._findPoint(wx, wy);
      if (!pt) { this.setStatus('No point found — click closer to a point'); return; }
      this._firstPt = pt;
      this.step = 1;
      this.setStatus('Click a segment to snap point to its midpoint');
    } else {
      const seg = this._findSegment(wx, wy);
      if (!seg) { this.setStatus('No segment found — click on a line segment'); return; }

      // Check if the point is already an endpoint of this segment
      if (this._firstPt === seg.p1 || this._firstPt === seg.p2) {
        this.setStatus('Cannot snap an endpoint to its own segment midpoint');
        return;
      }

      takeSnapshot();
      // Move point to midpoint position immediately
      this._firstPt.x = seg.midX;
      this._firstPt.y = seg.midY;
      // Add midpoint constraint to maintain the relationship
      state.scene.addConstraint(new Midpoint(this._firstPt, seg));
      state.emit('change');
      this._firstPt = null;
      this.step = 0;
      this.setStatus('Midpoint snap applied. Click another point, or switch tool.');
    }
  }

  onCancel() {
    this._firstPt = null;
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }
}

// js/tools/DistanceTool2.js — Select two points, then set a fixed distance constraint
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { Distance } from '../cad/Constraint.js';
import { showPrompt } from '../ui/popup.js';

export class DistanceConstraintTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'distance';
    this._firstPt = null;
  }

  activate() {
    super.activate();
    this._firstPt = null;
    this.step = 0;
    this.setStatus('Click first point');
  }

  deactivate() {
    this._firstPt = null;
    this.app.renderer.hoverEntity = null;
    super.deactivate();
  }

  onMouseMove(wx, wy) {
    const tol = 10 / this.app.viewport.zoom;
    const pt = state.scene.findClosestPoint(wx, wy, tol);
    this.app.renderer.hoverEntity = pt;
  }

  async onClick(wx, wy) {
    const tol = 10 / this.app.viewport.zoom;
    const pt = state.scene.findClosestPoint(wx, wy, tol);
    if (!pt) { this.setStatus('No point found — click closer to a point'); return; }

    if (this.step === 0) {
      this._firstPt = pt;
      this.step = 1;
      this.setStatus('Click second point');
    } else {
      if (pt === this._firstPt) { this.setStatus('Same point — pick a different one'); return; }
      const currentDist = Math.hypot(pt.x - this._firstPt.x, pt.y - this._firstPt.y);
      const val = await showPrompt({
        title: 'Distance Constraint',
        message: 'Enter distance value:',
        defaultValue: currentDist.toFixed(4),
      });
      if (val !== null && val !== '') {
        const d = parseFloat(val);
        if (!isNaN(d) && d > 0) {
          takeSnapshot();
          state.scene.addConstraint(new Distance(this._firstPt, pt, d));
          state.emit('change');
        }
      }
      this._firstPt = null;
      this.step = 0;
      this.setStatus('Click first point for next distance, or switch tool.');
    }
  }

  onCancel() {
    this._firstPt = null;
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }
}

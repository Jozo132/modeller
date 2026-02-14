// js/tools/DistanceTool2.js — Select two points, then set a fixed distance constraint
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { Distance } from '../cad/Constraint.js';
import { showDimensionInput } from '../ui/popup.js';

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

      // Check if already constrained
      const ptA = this._firstPt, ptB = pt;
      const existingConstraints = state.scene.constraintsOn(ptA);
      const alreadyConstrained = existingConstraints.some(c =>
        c.type === 'distance' && (c.ptA === ptB || c.ptB === ptB));

      // Screen position at midpoint
      const vp = this.app.viewport;
      const midScreen = vp.worldToScreen(
        (ptA.x + ptB.x) / 2,
        (ptA.y + ptB.y) / 2
      );

      const result = await showDimensionInput({
        dimType: 'distance',
        defaultValue: currentDist.toFixed(4),
        driven: alreadyConstrained,
        hint: 'value or variable',
        screenPos: { x: midScreen.x, y: midScreen.y },
      });

      if (result !== null && result.value !== '') {
        if (!result.driven) {
          const d = parseFloat(result.value);
          const constraintVal = isNaN(d) ? result.value.trim() : d;
          if (typeof constraintVal === 'number' && constraintVal <= 0) {
            // invalid
          } else {
            takeSnapshot();
            state.scene.addConstraint(new Distance(ptA, ptB, constraintVal));
            state.emit('change');
          }
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

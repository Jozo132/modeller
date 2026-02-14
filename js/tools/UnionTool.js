// js/tools/UnionTool.js — Select two points to merge/join them
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { union } from '../cad/Operations.js';

export class UnionTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'union';
    this._firstPt = null;
  }

  activate() {
    super.activate();
    this._firstPt = null;
    this.step = 0;
    this.setStatus('Click first point to join');
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

  onClick(wx, wy) {
    const tol = 10 / this.app.viewport.zoom;
    const pt = state.scene.findClosestPoint(wx, wy, tol);
    if (!pt) { this.setStatus('No point found — click closer to a point'); return; }

    if (this.step === 0) {
      this._firstPt = pt;
      this.step = 1;
      this.setStatus('Click second point to merge into first');
    } else {
      if (pt === this._firstPt) { this.setStatus('Same point — pick a different one'); return; }
      takeSnapshot();
      union(state.scene, this._firstPt, pt);
      state.emit('change');
      this._firstPt = null;
      this.step = 0;
      this.setStatus('Points merged. Click first point for next, or switch tool.');
    }
  }

  onCancel() {
    this._firstPt = null;
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }
}

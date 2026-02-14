// js/tools/ParallelTool.js — Select two segments to make parallel
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { Parallel } from '../cad/Constraint.js';

export class ParallelTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'parallel';
    this._firstSeg = null;
  }

  activate() {
    super.activate();
    this._firstSeg = null;
    this.step = 0;
    this.setStatus('Click first segment');
  }

  deactivate() {
    this._firstSeg = null;
    this.app.renderer.hoverEntity = null;
    super.deactivate();
  }

  onMouseMove(wx, wy) {
    const tol = 12 / this.app.viewport.zoom;
    const hit = state.scene.findClosestShape(wx, wy, tol);
    this.app.renderer.hoverEntity = (hit && hit.type === 'segment') ? hit : null;
  }

  onClick(wx, wy) {
    const tol = 12 / this.app.viewport.zoom;
    const hit = state.scene.findClosestShape(wx, wy, tol);
    if (!hit || hit.type !== 'segment') { this.setStatus('Click on a segment'); return; }

    if (this.step === 0) {
      this._firstSeg = hit;
      this.step = 1;
      this.setStatus('Click second segment');
    } else {
      if (hit === this._firstSeg) { this.setStatus('Same segment — pick a different one'); return; }
      takeSnapshot();
      state.scene.addConstraint(new Parallel(this._firstSeg, hit));
      state.emit('change');
      this._firstSeg = null;
      this.step = 0;
      this.setStatus('Parallel applied. Click first segment for next, or switch tool.');
    }
  }

  onCancel() {
    this._firstSeg = null;
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }
}

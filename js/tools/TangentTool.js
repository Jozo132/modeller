// js/tools/TangentTool.js — Select a segment and a circle/arc to make tangent
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { Tangent } from '../cad/Constraint.js';

export class TangentTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'tangent';
    this._seg = null;
  }

  activate() {
    super.activate();
    this._seg = null;
    this.step = 0;
    this.setStatus('Click a segment (line)');
  }

  deactivate() {
    this._seg = null;
    this.app.renderer.hoverEntity = null;
    super.deactivate();
  }

  onMouseMove(wx, wy) {
    const tol = 12 / this.app.viewport.zoom;
    const hit = state.scene.findClosestShape(wx, wy, tol);
    if (this.step === 0) {
      this.app.renderer.hoverEntity = (hit && hit.type === 'segment') ? hit : null;
    } else {
      this.app.renderer.hoverEntity = (hit && (hit.type === 'circle' || hit.type === 'arc')) ? hit : null;
    }
  }

  onClick(wx, wy) {
    const tol = 12 / this.app.viewport.zoom;
    const hit = state.scene.findClosestShape(wx, wy, tol);
    if (!hit) return;

    if (this.step === 0) {
      if (hit.type !== 'segment') { this.setStatus('Click on a segment first'); return; }
      this._seg = hit;
      this.step = 1;
      this.setStatus('Click a circle or arc');
    } else {
      if (hit.type !== 'circle' && hit.type !== 'arc') { this.setStatus('Click on a circle or arc'); return; }
      takeSnapshot();
      state.scene.addConstraint(new Tangent(this._seg, hit));
      state.emit('change');
      this._seg = null;
      this.step = 0;
      this.setStatus('Tangent applied. Click a segment for next, or switch tool.');
    }
  }

  onCancel() {
    this._seg = null;
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }
}

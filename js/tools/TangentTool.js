// js/tools/TangentTool.js — Select line/circle/arc pairs to make tangent
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { Tangent } from '../cad/Constraint.js';

export class TangentTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'tangent';
    this._first = null;
  }

  activate() {
    super.activate();
    this._first = null;
    this.step = 0;
    this.setStatus('Click a line, circle, or arc');
  }

  deactivate() {
    this._first = null;
    this.app.renderer.hoverEntity = null;
    super.deactivate();
  }

  onMouseMove(wx, wy) {
    const tol = 12 / this._effectiveZoom();
    const hit = state.scene.findClosestShape(wx, wy, tol);
    if (this.step === 0) {
      this.app.renderer.hoverEntity = (hit && this._isTangentShape(hit)) ? hit : null;
    } else {
      this.app.renderer.hoverEntity = (hit && this._canTangent(this._first, hit)) ? hit : null;
    }
  }

  onClick(wx, wy) {
    const tol = 12 / this._effectiveZoom();
    const hit = state.scene.findClosestShape(wx, wy, tol);
    if (!hit) return;

    if (this.step === 0) {
      if (!this._isTangentShape(hit)) { this.setStatus('Click a line, circle, or arc first'); return; }
      this._first = hit;
      this.step = 1;
      this.setStatus('Click tangent target');
    } else {
      if (!this._canTangent(this._first, hit)) { this.setStatus('Click a valid tangent target'); return; }
      takeSnapshot();
      state.scene.addConstraint(new Tangent(this._first, hit));
      state.emit('change');
      this._first = null;
      this.step = 0;
      this.setStatus('Tangent applied. Click first tangent shape for next, or switch tool.');
    }
  }

  _isTangentShape(shape) {
    return !!shape && (shape.type === 'segment' || shape.type === 'circle' || shape.type === 'arc');
  }

  _canTangent(a, b) {
    if (!this._isTangentShape(a) || !this._isTangentShape(b) || a === b) return false;
    return a.type === 'segment' || b.type === 'segment' || (
      (a.type === 'circle' || a.type === 'arc') && (b.type === 'circle' || b.type === 'arc')
    );
  }

  onCancel() {
    this._first = null;
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }
}

// js/tools/EqualTool.js — Select two segments or two arcs/circles to make equal
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { EqualLength } from '../cad/Constraint.js';

export class EqualTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'equal';
    this._firstShape = null;
  }

  activate() {
    super.activate();
    this._firstShape = null;
    this.step = 0;
    this.setStatus('Click first line, circle, or arc');
  }

  deactivate() {
    this._firstShape = null;
    this.app.renderer.hoverEntity = null;
    super.deactivate();
  }

  onMouseMove(wx, wy) {
    const tol = 12 / this._effectiveZoom();
    const hit = state.scene.findClosestShape(wx, wy, tol);
    this.app.renderer.hoverEntity = (hit && this._isEqualShape(hit)) ? hit : null;
  }

  onClick(wx, wy) {
    const tol = 12 / this._effectiveZoom();
    const hit = state.scene.findClosestShape(wx, wy, tol);
    if (!hit || !this._isEqualShape(hit)) { this.setStatus('Click on a line, circle, or arc'); return; }

    if (this.step === 0) {
      this._firstShape = hit;
      this.step = 1;
      this.setStatus('Click matching line, circle, or arc');
    } else {
      if (hit === this._firstShape) { this.setStatus('Same shape — pick a different one'); return; }
      if (!this._canEqual(this._firstShape, hit)) { this.setStatus('Pick the same kind: two lines or two arcs/circles'); return; }
      takeSnapshot();
      state.scene.addConstraint(new EqualLength(this._firstShape, hit));
      state.emit('change');
      this._firstShape = null;
      this.step = 0;
      this.setStatus('Equal applied. Click first shape for next, or switch tool.');
    }
  }

  _isEqualShape(shape) {
    return !!shape && (shape.type === 'segment' || shape.type === 'circle' || shape.type === 'arc');
  }

  _canEqual(a, b) {
    if (!a || !b) return false;
    if (a.type === 'segment' || b.type === 'segment') return a.type === 'segment' && b.type === 'segment';
    return (a.type === 'circle' || a.type === 'arc') && (b.type === 'circle' || b.type === 'arc');
  }

  onCancel() {
    this._firstShape = null;
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }
}

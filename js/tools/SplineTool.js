// js/tools/SplineTool.js — Multi-click spline drawing tool
import { BaseTool } from './BaseTool.js';
import { PPoint, PSpline } from '../cad/index.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';

export class SplineTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'spline';
    this._controlPoints = []; // {x, y}[]
  }

  activate() {
    super.activate();
    this._controlPoints = [];
    this.setStatus('Spline: Click to place control points (Enter/double-click to finish, Esc to cancel)');
  }

  onClick(wx, wy) {
    this._controlPoints.push({ x: wx, y: wy });
    this.step = this._controlPoints.length;
    if (this._controlPoints.length >= 2) {
      this.setStatus(`Spline: ${this._controlPoints.length} points — click more, Enter/double-click to finish, Esc to cancel`);
    } else {
      this.setStatus('Spline: Click next control point');
    }
  }

  onDoubleClick(wx, wy) {
    // Double-click finishes the spline (the second click of the double-click already added a point in onClick)
    this._finish();
  }

  onMouseMove(wx, wy) {
    if (this._controlPoints.length > 0) {
      // Build a preview spline with the current control points plus the cursor position
      const previewPts = [...this._controlPoints, { x: wx, y: wy }];
      if (previewPts.length >= 2) {
        const pts = previewPts.map(c => new PPoint(c.x, c.y));
        try {
          const preview = new PSpline(pts);
          this.app.renderer.previewEntities = [preview];
        } catch (_) {
          this.app.renderer.previewEntities = [];
        }
      }
    }
  }

  onKeyDown(event) {
    if (event.key === 'Enter') {
      this._finish();
    }
  }

  onCancel() {
    this._controlPoints = [];
    super.onCancel();
    this.setStatus('Spline: Click to place control points (Enter/double-click to finish, Esc to cancel)');
  }

  _finish() {
    if (this._controlPoints.length < 2) {
      this.setStatus('Spline needs at least 2 control points');
      return;
    }
    takeSnapshot();
    const spl = state.scene.addSpline(this._controlPoints,
      { merge: true, layer: state.activeLayer, construction: state.constructionMode });
    state.emit('entity:add', spl);
    state.emit('change');
    this._controlPoints = [];
    this.step = 0;
    this.app.renderer.previewEntities = [];
    this.setStatus('Spline: Click to place control points (Enter/double-click to finish, Esc to cancel)');
  }
}

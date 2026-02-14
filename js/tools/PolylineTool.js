// js/tools/PolylineTool.js
import { BaseTool } from './BaseTool.js';
import { Polyline } from '../entities/index.js';
import { state } from '../state.js';

export class PolylineTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'polyline';
    this._points = [];
  }

  activate() {
    super.activate();
    this._points = [];
    this.setStatus('Polyline: Click first point');
  }

  onClick(wx, wy) {
    this._points.push({ x: wx, y: wy });
    if (this._points.length === 1) {
      this.setStatus('Polyline: Click next point (Enter to close, Esc to finish)');
    }
  }

  onMouseMove(wx, wy) {
    if (this._points.length > 0) {
      const pts = [...this._points, { x: wx, y: wy }];
      const preview = new Polyline(pts, false);
      this.app.renderer.previewEntities = [preview];
    }
  }

  onCancel() {
    // Finish polyline (open)
    if (this._points.length >= 2) {
      state.snapshot();
      const poly = new Polyline(this._points, false);
      state.addEntity(poly);
    }
    this._points = [];
    this.app.renderer.previewEntities = [];
    this.setStatus('Polyline: Click first point');
    this.step = 0;
  }

  onKeyDown(event) {
    if (event.key === 'Enter' && this._points.length >= 3) {
      // Close polyline
      state.snapshot();
      const poly = new Polyline(this._points, true);
      state.addEntity(poly);
      this._points = [];
      this.app.renderer.previewEntities = [];
      this.setStatus('Polyline: Click first point');
      this.step = 0;
    }
  }
}

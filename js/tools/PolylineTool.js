// js/tools/PolylineTool.js
import { BaseTool } from './BaseTool.js';
import { PSegment, PPoint } from '../cad/index.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';

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

  _commitSegments(closed) {
    const pts = this._points;
    const layer = state.activeLayer;
    const count = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < count; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      state.scene.addSegment(a.x, a.y, b.x, b.y, { merge: true, layer });
    }
    state.emit('change');
  }

  onMouseMove(wx, wy) {
    if (this._points.length > 0) {
      const pts = [...this._points, { x: wx, y: wy }];
      const previews = [];
      for (let i = 0; i < pts.length - 1; i++) {
        previews.push(new PSegment(
          new PPoint(pts[i].x, pts[i].y),
          new PPoint(pts[i + 1].x, pts[i + 1].y)
        ));
      }
      this.app.renderer.previewEntities = previews;
    }
  }

  onCancel() {
    // Finish polyline (open)
    if (this._points.length >= 2) {
      takeSnapshot();
      this._commitSegments(false);
    }
    this._points = [];
    this.app.renderer.previewEntities = [];
    this.setStatus('Polyline: Click first point');
    this.step = 0;
  }

  onKeyDown(event) {
    if (event.key === 'Enter' && this._points.length >= 3) {
      // Close polyline
      takeSnapshot();
      this._commitSegments(true);
      this._points = [];
      this.app.renderer.previewEntities = [];
      this.setStatus('Polyline: Click first point');
      this.step = 0;
    }
  }
}

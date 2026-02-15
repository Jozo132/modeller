// js/tools/RectangleTool.js
import { BaseTool } from './BaseTool.js';
import { PSegment, PPoint } from '../cad/index.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';

export class RectangleTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'rectangle';
    this._startX = 0;
    this._startY = 0;
  }

  activate() {
    super.activate();
    this.setStatus('Rectangle: Click first corner');
  }

  onClick(wx, wy) {
    if (this.step === 0) {
      this._startX = wx;
      this._startY = wy;
      this.step = 1;
      this.setStatus('Rectangle: Click opposite corner (Esc to cancel)');
    } else {
      takeSnapshot();
      const x1 = this._startX, y1 = this._startY, x2 = wx, y2 = wy;
      const layer = state.activeLayer;
      const construction = state.constructionMode;
      // Create 4 segments sharing corner points (auto-merge via scene)
      state.scene.addSegment(x1, y1, x2, y1, { merge: true, layer, construction });
      state.scene.addSegment(x2, y1, x2, y2, { merge: true, layer, construction });
      state.scene.addSegment(x2, y2, x1, y2, { merge: true, layer, construction });
      state.scene.addSegment(x1, y2, x1, y1, { merge: true, layer, construction });
      state.emit('change');
      this.step = 0;
      this.app.renderer.previewEntities = [];
      this.setStatus('Rectangle: Click first corner');
    }
  }

  onMouseMove(wx, wy) {
    if (this.step === 1) {
      const x1 = this._startX, y1 = this._startY, x2 = wx, y2 = wy;
      const previews = [
        new PSegment(new PPoint(x1, y1), new PPoint(x2, y1)),
        new PSegment(new PPoint(x2, y1), new PPoint(x2, y2)),
        new PSegment(new PPoint(x2, y2), new PPoint(x1, y2)),
        new PSegment(new PPoint(x1, y2), new PPoint(x1, y1)),
      ];
      this.app.renderer.previewEntities = previews;
    }
  }

  onCancel() {
    super.onCancel();
    this.setStatus('Rectangle: Click first corner');
  }
}

// js/tools/LineTool.js
import { BaseTool } from './BaseTool.js';
import { PSegment } from '../cad/index.js';
import { PPoint } from '../cad/index.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';

export class LineTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'line';
    this._startX = 0;
    this._startY = 0;
  }

  activate() {
    super.activate();
    this.setStatus('Line: Click first point');
  }

  onClick(wx, wy) {
    if (this.step === 0) {
      this._startX = wx;
      this._startY = wy;
      this.step = 1;
      this.setStatus('Line: Click second point (Esc to cancel)');
    } else {
      takeSnapshot();
      const seg = state.scene.addSegment(this._startX, this._startY, wx, wy,
        { merge: true, layer: state.activeLayer, construction: state.constructionMode });
      state.emit('entity:add', seg);
      state.emit('change');
      // Chain: next line starts from end of previous
      this._startX = wx;
      this._startY = wy;
      this.setStatus('Line: Click next point (Esc to finish)');
    }
  }

  onMouseMove(wx, wy) {
    if (this.step === 1) {
      const p1 = new PPoint(this._startX, this._startY);
      const p2 = new PPoint(wx, wy);
      const preview = new PSegment(p1, p2);
      this.app.renderer.previewEntities = [preview];
    }
  }

  onCancel() {
    super.onCancel();
    this.setStatus('Line: Click first point');
  }
}

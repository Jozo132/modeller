// js/tools/LineTool.js
import { BaseTool } from './BaseTool.js';
import { Line } from '../entities/index.js';
import { state } from '../state.js';

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
      state.snapshot();
      const line = new Line(this._startX, this._startY, wx, wy);
      state.addEntity(line);
      // Chain: next line starts from end of previous
      this._startX = wx;
      this._startY = wy;
      this.setStatus('Line: Click next point (Esc to finish)');
    }
  }

  onMouseMove(wx, wy) {
    if (this.step === 1) {
      const preview = new Line(this._startX, this._startY, wx, wy);
      this.app.renderer.previewEntities = [preview];
    }
  }

  onCancel() {
    super.onCancel();
    this.setStatus('Line: Click first point');
  }
}

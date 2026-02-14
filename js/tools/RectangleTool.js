// js/tools/RectangleTool.js
import { BaseTool } from './BaseTool.js';
import { Rectangle } from '../entities/index.js';
import { state } from '../state.js';

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
      state.snapshot();
      const rect = new Rectangle(this._startX, this._startY, wx, wy);
      state.addEntity(rect);
      this.step = 0;
      this.app.renderer.previewEntities = [];
      this.setStatus('Rectangle: Click first corner');
    }
  }

  onMouseMove(wx, wy) {
    if (this.step === 1) {
      const preview = new Rectangle(this._startX, this._startY, wx, wy);
      this.app.renderer.previewEntities = [preview];
    }
  }

  onCancel() {
    super.onCancel();
    this.setStatus('Rectangle: Click first corner');
  }
}

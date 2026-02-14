// js/tools/CircleTool.js
import { BaseTool } from './BaseTool.js';
import { Circle } from '../entities/index.js';
import { state } from '../state.js';

export class CircleTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'circle';
    this._cx = 0;
    this._cy = 0;
  }

  activate() {
    super.activate();
    this.setStatus('Circle: Click center point');
  }

  onClick(wx, wy) {
    if (this.step === 0) {
      this._cx = wx;
      this._cy = wy;
      this.step = 1;
      this.setStatus('Circle: Click radius point (Esc to cancel)');
    } else {
      const radius = Math.hypot(wx - this._cx, wy - this._cy);
      if (radius > 0) {
        state.snapshot();
        const circle = new Circle(this._cx, this._cy, radius);
        state.addEntity(circle);
      }
      this.step = 0;
      this.app.renderer.previewEntities = [];
      this.setStatus('Circle: Click center point');
    }
  }

  onMouseMove(wx, wy) {
    if (this.step === 1) {
      const radius = Math.hypot(wx - this._cx, wy - this._cy);
      if (radius > 0) {
        const preview = new Circle(this._cx, this._cy, radius);
        this.app.renderer.previewEntities = [preview];
      }
    }
  }

  onCancel() {
    super.onCancel();
    this.setStatus('Circle: Click center point');
  }
}

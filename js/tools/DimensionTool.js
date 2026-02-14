// js/tools/DimensionTool.js
import { BaseTool } from './BaseTool.js';
import { DimensionPrimitive } from '../cad/index.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';

export class DimensionTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'dimension';
    this._x1 = 0; this._y1 = 0;
  }

  activate() {
    super.activate();
    this.setStatus('Dimension: Click first point');
  }

  onClick(wx, wy) {
    if (this.step === 0) {
      this._x1 = wx; this._y1 = wy;
      this.step = 1;
      this.setStatus('Dimension: Click second point');
    } else {
      takeSnapshot();
      const dim = new DimensionPrimitive(this._x1, this._y1, wx, wy, 10);
      dim.layer = state.activeLayer;
      state.scene.dimensions.push(dim);
      state.emit('change');
      this.step = 0;
      this.app.renderer.previewEntities = [];
      this.setStatus('Dimension: Click first point');
    }
  }

  onMouseMove(wx, wy) {
    if (this.step === 1) {
      const preview = new DimensionPrimitive(this._x1, this._y1, wx, wy, 10);
      this.app.renderer.previewEntities = [preview];
    }
  }

  onCancel() {
    super.onCancel();
    this.setStatus('Dimension: Click first point');
  }
}

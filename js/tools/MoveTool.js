// js/tools/MoveTool.js
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';

export class MoveTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'move';
    this._baseX = 0; this._baseY = 0;
  }

  activate() {
    super.activate();
    if (state.selectedEntities.length === 0) {
      this.setStatus('Move: Select entities first, then click base point');
    } else {
      this.setStatus('Move: Click base point');
    }
  }

  onClick(wx, wy) {
    if (state.selectedEntities.length === 0) {
      this.setStatus('Move: No entities selected');
      return;
    }
    if (this.step === 0) {
      this._baseX = wx; this._baseY = wy;
      this.step = 1;
      this.setStatus('Move: Click destination point');
    } else {
      const dx = wx - this._baseX;
      const dy = wy - this._baseY;
      state.snapshot();
      for (const e of state.selectedEntities) {
        e.translate(dx, dy);
      }
      state.emit('change');
      this.step = 0;
      this.app.renderer.previewEntities = [];
      this.setStatus('Move: Click base point');
    }
  }

  onMouseMove(wx, wy) {
    if (this.step === 1) {
      // Show preview of moved entities
      const dx = wx - this._baseX;
      const dy = wy - this._baseY;
      const previews = [];
      for (const e of state.selectedEntities) {
        const clone = e.clone();
        clone.translate(dx, dy);
        previews.push(clone);
      }
      this.app.renderer.previewEntities = previews;
    }
  }

  onCancel() {
    super.onCancel();
    this.setStatus('Move: Click base point');
  }
}

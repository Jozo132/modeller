// js/tools/CopyTool.js
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';

export class CopyTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'copy';
    this._baseX = 0; this._baseY = 0;
  }

  activate() {
    super.activate();
    if (state.selectedEntities.length === 0) {
      this.setStatus('Copy: Select entities first, then click base point');
    } else {
      this.setStatus('Copy: Click base point');
    }
  }

  onClick(wx, wy) {
    if (state.selectedEntities.length === 0) {
      this.setStatus('Copy: No entities selected');
      return;
    }
    if (this.step === 0) {
      this._baseX = wx; this._baseY = wy;
      this.step = 1;
      this.setStatus('Copy: Click destination point (Esc to finish)');
    } else {
      const dx = wx - this._baseX;
      const dy = wy - this._baseY;
      state.snapshot();
      for (const e of state.selectedEntities) {
        const clone = e.clone();
        clone.translate(dx, dy);
        state.addEntity(clone);
      }
      this.setStatus('Copy: Click another destination (Esc to finish)');
    }
  }

  onMouseMove(wx, wy) {
    if (this.step === 1) {
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
    this.setStatus('Copy: Click base point');
  }
}

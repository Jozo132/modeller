// js/tools/ArcTool.js — Center-start-end arc
import { BaseTool } from './BaseTool.js';
import { PArc, PPoint } from '../cad/index.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';

export class ArcTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'arc';
    this._cx = 0; this._cy = 0;
    this._radius = 0;
    this._startAngle = 0;
  }

  activate() {
    super.activate();
    this.setStatus('Arc: Click center point');
  }

  onClick(wx, wy) {
    if (this.step === 0) {
      this._cx = wx; this._cy = wy;
      this.step = 1;
      this.setStatus('Arc: Click start point (defines radius)');
    } else if (this.step === 1) {
      this._radius = Math.hypot(wx - this._cx, wy - this._cy);
      this._startAngle = Math.atan2(wy - this._cy, wx - this._cx);
      if (this._radius > 0) {
        this.step = 2;
        this.setStatus('Arc: Click end point (Esc to cancel)');
      }
    } else {
      const endAngle = Math.atan2(wy - this._cy, wx - this._cx);
      takeSnapshot();
      state.scene.addArc(this._cx, this._cy, this._radius, this._startAngle, endAngle,
        { merge: true, layer: state.activeLayer, construction: state.constructionMode });
      state.emit('change');
      this.step = 0;
      this.app.renderer.previewEntities = [];
      this.setStatus('Arc: Click center point');
    }
  }

  onMouseMove(wx, wy) {
    if (this.step === 1) {
      const r = Math.hypot(wx - this._cx, wy - this._cy);
      if (r > 0) {
        const preview = new PArc(new PPoint(this._cx, this._cy), r, 0, Math.PI * 2);
        this.app.renderer.previewEntities = [preview];
      }
    } else if (this.step === 2) {
      const endAngle = Math.atan2(wy - this._cy, wx - this._cx);
      const preview = new PArc(new PPoint(this._cx, this._cy), this._radius, this._startAngle, endAngle);
      this.app.renderer.previewEntities = [preview];
    }
  }

  onCancel() {
    super.onCancel();
    this.setStatus('Arc: Click center point');
  }
}

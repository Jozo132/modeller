// js/tools/LineTool.js
import { BaseTool } from './BaseTool.js';
import { PSegment } from '../cad/index.js';
import { PPoint } from '../cad/index.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { OnCircle, OnLine } from '../cad/Constraint.js';

export class LineTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'line';
    this._startX = 0;
    this._startY = 0;
    this._startSnap = null;
  }

  activate() {
    super.activate();
    this.setStatus('Line: Click first point');
  }

  onClick(wx, wy) {
    if (this.step === 0) {
      this._startX = wx;
      this._startY = wy;
      this._startSnap = this.app?.renderer?.snapPoint || null;
      this.step = 1;
      this.setStatus('Line: Click second point (Esc to cancel)');
    } else {
      takeSnapshot();
      const endSnap = this.app?.renderer?.snapPoint || null;
      const seg = state.scene.addSegment(this._startX, this._startY, wx, wy,
        { merge: true, layer: state.activeLayer, construction: state.constructionMode });
      this._addEdgeConstraint(seg.p1, this._startSnap);
      this._addEdgeConstraint(seg.p2, endSnap);
      state.emit('entity:add', seg);
      state.emit('change');
      // Chain: next line starts from end of previous
      this._startX = wx;
      this._startY = wy;
      this._startSnap = endSnap;
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
    this._startSnap = null;
    this.setStatus('Line: Click first point');
  }

  _addEdgeConstraint(point, snap) {
    if (!point || !snap?.target) return;
    if (snap.target.type === 'segment') {
      state.scene.addConstraint(new OnLine(point, snap.target));
    } else if (snap.target.type === 'circle' || snap.target.type === 'arc') {
      state.scene.addConstraint(new OnCircle(point, snap.target));
    }
  }
}

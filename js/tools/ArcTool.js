// js/tools/ArcTool.js — Center-start-end arc
import { BaseTool } from './BaseTool.js';
import { PArc, PPoint } from '../cad/index.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { OnCircle, OnLine, Tangent } from '../cad/Constraint.js';

export class ArcTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'arc';
    this._cx = 0; this._cy = 0;
    this._radius = 0;
    this._startAngle = 0;
    this._startSnap = null;
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
      this._startSnap = this.app?.renderer?.snapPoint || null;
      if (this._radius > 0) {
        this.step = 2;
        this.setStatus('Arc: Click end point (Esc to cancel)');
      }
    } else {
      const endAngle = this._nearestEndAngle(Math.atan2(wy - this._cy, wx - this._cx));
      if (Math.abs(endAngle - this._startAngle) < 1e-6) {
        this.setStatus('Arc: Pick a different end point');
        return;
      }
      const endSnap = this.app?.renderer?.snapPoint || null;
      takeSnapshot();
      const arc = state.scene.addArc(this._cx, this._cy, this._radius, this._startAngle, endAngle,
        { merge: true, layer: state.activeLayer, construction: state.constructionMode });
      this._addEdgeConstraint(arc.startPoint, this._startSnap);
      this._addEdgeConstraint(arc.endPoint, endSnap);
      this._addTangentConstraint(arc, endSnap);
      state.emit('change');
      this.step = 0;
      this._startSnap = null;
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
      const endAngle = this._nearestEndAngle(Math.atan2(wy - this._cy, wx - this._cx));
      const preview = new PArc(new PPoint(this._cx, this._cy), this._radius, this._startAngle, endAngle);
      this.app.renderer.previewEntities = [preview];
    }
  }

  _nearestEndAngle(rawEndAngle) {
    let sweep = rawEndAngle - this._startAngle;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    return this._startAngle + sweep;
  }

  _addEdgeConstraint(point, snap) {
    if (!point || !snap?.target) return;
    if (snap.target.type === 'segment') {
      state.scene.addConstraint(new OnLine(point, snap.target));
    } else if (snap.target.type === 'circle' || snap.target.type === 'arc') {
      state.scene.addConstraint(new OnCircle(point, snap.target));
    }
  }

  _addTangentConstraint(arc, snap) {
    if (!arc || !snap?.target || snap.target === arc) return;
    if (snap.target.type === 'segment' || snap.target.type === 'circle' || snap.target.type === 'arc') {
      state.scene.addConstraint(new Tangent(snap.target, arc));
    }
  }

  onCancel() {
    super.onCancel();
    this._startSnap = null;
    this.setStatus('Arc: Click center point');
  }
}

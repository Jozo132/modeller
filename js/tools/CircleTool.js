// js/tools/CircleTool.js
import { BaseTool } from './BaseTool.js';
import { PCircle, PPoint } from '../cad/index.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { OnCircle, OnLine, Tangent } from '../cad/Constraint.js';

export class CircleTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'circle';
    this._cx = 0;
    this._cy = 0;
    this._centerSnap = null;
  }

  activate() {
    super.activate();
    this.setStatus('Circle: Click center point');
  }

  onClick(wx, wy) {
    if (this.step === 0) {
      this._cx = wx;
      this._cy = wy;
      this._centerSnap = this.app?.renderer?.snapPoint || null;
      this.step = 1;
      this.setStatus('Circle: Click radius point (Esc to cancel)');
    } else {
      const radius = Math.hypot(wx - this._cx, wy - this._cy);
      if (radius > 0) {
        takeSnapshot();
        const radiusSnap = this.app?.renderer?.snapPoint || null;
        const circle = state.scene.addCircle(this._cx, this._cy, radius,
          { merge: true, layer: state.activeLayer, construction: state.constructionMode });
        this._addEdgeConstraint(circle.center, this._centerSnap);
        this._addTangentConstraint(circle, radiusSnap);
        state.emit('change');
      }
      this.step = 0;
      this._centerSnap = null;
      this.app.renderer.previewEntities = [];
      this.setStatus('Circle: Click center point');
    }
  }

  onMouseMove(wx, wy) {
    if (this.step === 1) {
      const radius = Math.hypot(wx - this._cx, wy - this._cy);
      if (radius > 0) {
        const preview = new PCircle(new PPoint(this._cx, this._cy), radius);
        this.app.renderer.previewEntities = [preview];
      }
    }
  }

  onCancel() {
    super.onCancel();
    this._centerSnap = null;
    this.setStatus('Circle: Click center point');
  }

  _addEdgeConstraint(point, snap) {
    if (!point || !snap?.target) return;
    if (snap.target.type === 'segment') {
      state.scene.addConstraint(new OnLine(point, snap.target));
    } else if (snap.target.type === 'circle' || snap.target.type === 'arc') {
      state.scene.addConstraint(new OnCircle(point, snap.target));
    }
  }

  _addTangentConstraint(circle, snap) {
    if (!circle || !snap?.target || snap.target === circle) return;
    if (snap.target.type === 'segment') {
      state.scene.addConstraint(new Tangent(snap.target, circle));
    } else if (snap.target.type === 'circle' || snap.target.type === 'arc') {
      state.scene.addConstraint(new Tangent(snap.target, circle));
    }
  }
}

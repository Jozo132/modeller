// js/tools/PointTool.js
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { OnCircle, OnLine } from '../cad/Constraint.js';

export class PointTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'point';
  }

  activate() {
    super.activate();
    this.setStatus('Point: Click to place point');
  }

  onClick(wx, wy) {
    takeSnapshot();
    const point = state.scene.addPoint(wx, wy);
    point.standalone = true;
    const snap = this.app?.renderer?.snapPoint;
    if (snap?.target?.type === 'segment') {
      state.scene.addConstraint(new OnLine(point, snap.target));
    } else if (snap?.target?.type === 'circle' || snap?.target?.type === 'arc') {
      state.scene.addConstraint(new OnCircle(point, snap.target));
    }
    state.emit('entity:add', point);
    state.emit('change');
    this.setStatus('Point placed. Click to place another point.');
  }
}

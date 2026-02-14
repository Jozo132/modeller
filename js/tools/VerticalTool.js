// js/tools/VerticalTool.js — Click a segment to constrain it vertical
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { Vertical } from '../cad/Constraint.js';

export class VerticalTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'vertical';
  }

  activate() {
    super.activate();
    this.setStatus('Click a segment to make vertical');
  }

  deactivate() {
    this.app.renderer.hoverEntity = null;
    super.deactivate();
  }

  onMouseMove(wx, wy) {
    const tol = 12 / this.app.viewport.zoom;
    const hit = state.scene.findClosestShape(wx, wy, tol);
    this.app.renderer.hoverEntity = (hit && hit.type === 'segment') ? hit : null;
  }

  onClick(wx, wy) {
    const tol = 12 / this.app.viewport.zoom;
    const hit = state.scene.findClosestShape(wx, wy, tol);
    if (!hit || hit.type !== 'segment') { this.setStatus('Click on a segment'); return; }
    takeSnapshot();
    state.scene.addConstraint(new Vertical(hit));
    state.emit('change');
    this.setStatus('Vertical constraint applied. Click another or switch tool.');
  }

  onCancel() {
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }
}

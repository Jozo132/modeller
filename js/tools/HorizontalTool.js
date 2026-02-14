// js/tools/HorizontalTool.js — Click a segment to constrain it horizontal
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { Horizontal } from '../cad/Constraint.js';

export class HorizontalTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'horizontal';
  }

  activate() {
    super.activate();
    this.setStatus('Click a segment to make horizontal');
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
    state.scene.addConstraint(new Horizontal(hit));
    state.emit('change');
    this.setStatus('Horizontal constraint applied. Click another or switch tool.');
  }

  onCancel() {
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }
}

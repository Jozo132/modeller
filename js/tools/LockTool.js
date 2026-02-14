// js/tools/LockTool.js — Click a point to fix/lock it in place
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { Fixed } from '../cad/Constraint.js';

export class LockTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'lock';
  }

  activate() {
    super.activate();
    this.setStatus('Click a point to lock its position');
  }

  deactivate() {
    this.app.renderer.hoverEntity = null;
    super.deactivate();
  }

  onMouseMove(wx, wy) {
    const tol = 10 / this.app.viewport.zoom;
    const pt = state.scene.findClosestPoint(wx, wy, tol);
    this.app.renderer.hoverEntity = pt;
  }

  onClick(wx, wy) {
    const tol = 10 / this.app.viewport.zoom;
    const pt = state.scene.findClosestPoint(wx, wy, tol);
    if (!pt) { this.setStatus('No point found — click closer to a point'); return; }

    // Check if already fixed
    const existing = state.scene.constraints.find(c => c.type === 'fixed' && c.pt === pt);
    if (existing) {
      // Toggle: remove the fixed constraint
      takeSnapshot();
      state.scene.removeConstraint(existing);
      pt.fixed = false;
      state.emit('change');
      this.setStatus('Point unlocked.');
    } else {
      takeSnapshot();
      state.scene.addConstraint(new Fixed(pt));
      state.emit('change');
      this.setStatus('Point locked. Click another or switch tool.');
    }
  }

  onCancel() {
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }
}

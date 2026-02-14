// js/tools/DisconnectTool.js — Click a shared point to disconnect it from other shapes
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { disconnect } from '../cad/Operations.js';

export class DisconnectTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'disconnect';
  }

  activate() {
    super.activate();
    this.setStatus('Click a shared point to disconnect');
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

    const shapes = state.scene.shapesUsingPoint(pt);
    if (shapes.length <= 1) {
      this.setStatus('Point is not shared by multiple shapes.');
      return;
    }

    takeSnapshot();
    disconnect(state.scene, pt);
    state.emit('change');
    this.setStatus('Point disconnected. Click another or switch tool.');
  }

  onCancel() {
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }
}

// js/tools/SplitTool.js — Click a segment to split it at that point
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { split } from '../cad/Operations.js';

export class SplitTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'split';
    this._hover = null;
  }

  activate() {
    super.activate();
    this.setStatus('Click on a segment to split');
  }

  deactivate() {
    this._hover = null;
    this.app.renderer.hoverEntity = null;
    super.deactivate();
  }

  onMouseMove(wx, wy) {
    const tol = 12 / this.app.viewport.zoom;
    const hit = state.scene.findClosestShape(wx, wy, tol);
    this._hover = (hit && hit.type === 'segment') ? hit : null;
    this.app.renderer.hoverEntity = this._hover;
  }

  onClick(wx, wy) {
    if (!this._hover) return;
    takeSnapshot();
    split(state.scene, this._hover, wx, wy);
    this._hover = null;
    this.app.renderer.hoverEntity = null;
    state.emit('change');
    this.setStatus('Split done. Click another segment or switch tool.');
  }

  onCancel() {
    this._hover = null;
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }
}

// js/tools/AngleTool.js — Select two segments, then set an angle constraint
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { Angle } from '../cad/Constraint.js';
import { showDimensionInput } from '../ui/popup.js';

export class AngleTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'angle';
    this._firstSeg = null;
  }

  activate() {
    super.activate();
    this._firstSeg = null;
    this.step = 0;
    this.setStatus('Click first segment');
  }

  deactivate() {
    this._firstSeg = null;
    this.app.renderer.hoverEntity = null;
    super.deactivate();
  }

  onMouseMove(wx, wy) {
    const tol = 12 / this.app.viewport.zoom;
    const hit = state.scene.findClosestShape(wx, wy, tol);
    this.app.renderer.hoverEntity = (hit && hit.type === 'segment') ? hit : null;
  }

  async onClick(wx, wy) {
    const tol = 12 / this.app.viewport.zoom;
    const hit = state.scene.findClosestShape(wx, wy, tol);
    if (!hit || hit.type !== 'segment') { this.setStatus('Click on a segment'); return; }

    if (this.step === 0) {
      this._firstSeg = hit;
      this.step = 1;
      this.setStatus('Click second segment');
    } else {
      if (hit === this._firstSeg) { this.setStatus('Same segment — pick a different one'); return; }
      // Compute current angle between segments
      const dxA = this._firstSeg.x2 - this._firstSeg.x1, dyA = this._firstSeg.y2 - this._firstSeg.y1;
      const dxB = hit.x2 - hit.x1, dyB = hit.y2 - hit.y1;
      const a = Math.atan2(dyA, dxA);
      const b = Math.atan2(dyB, dxB);
      let diff = b - a;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      const currentDeg = (diff * 180 / Math.PI).toFixed(2);

      // Check if already constrained
      const segA = this._firstSeg, segB = hit;
      const existingConstraints = state.scene.constraintsOn(segA);
      const alreadyConstrained = existingConstraints.some(c =>
        c.type === 'angle' && (c.segA === segB || c.segB === segB));

      // Screen position at midpoint between segments
      const vp = this.app.viewport;
      const midScreen = vp.worldToScreen(
        (segA.midX + segB.midX) / 2,
        (segA.midY + segB.midY) / 2
      );

      const result = await showDimensionInput({
        dimType: 'angle',
        defaultValue: currentDeg,
        driven: alreadyConstrained,
        hint: 'degrees or variable',
        screenPos: { x: midScreen.x, y: midScreen.y },
      });

      if (result !== null && result.value !== '') {
        if (!result.driven) {
          const deg = parseFloat(result.value);
          if (!isNaN(deg)) {
            const rad = deg * Math.PI / 180;
            takeSnapshot();
            state.scene.addConstraint(new Angle(segA, segB, rad));
            state.emit('change');
          } else if (result.value.trim()) {
            // Variable name
            const rad = diff; // keep current angle as initial
            takeSnapshot();
            state.scene.addConstraint(new Angle(segA, segB, result.value.trim()));
            state.emit('change');
          }
        }
      }
      this._firstSeg = null;
      this.step = 0;
      this.setStatus('Click first segment for next angle, or switch tool.');
    }
  }

  onCancel() {
    this._firstSeg = null;
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }
}

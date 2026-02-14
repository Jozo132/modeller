// js/tools/MoveTool.js
import { BaseTool } from './BaseTool.js';
import { PSegment, PPoint, PCircle, PArc } from '../cad/index.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';

export class MoveTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'move';
    this._baseX = 0; this._baseY = 0;
  }

  activate() {
    super.activate();
    if (state.selectedEntities.length === 0) {
      this.setStatus('Move: Select entities first, then click base point');
    } else {
      this.setStatus('Move: Click base point');
    }
  }

  onClick(wx, wy) {
    if (state.selectedEntities.length === 0) {
      this.setStatus('Move: No entities selected');
      return;
    }
    if (this.step === 0) {
      this._baseX = wx; this._baseY = wy;
      this.step = 1;
      this.setStatus('Move: Click destination point');
    } else {
      const dx = wx - this._baseX;
      const dy = wy - this._baseY;
      takeSnapshot();
      // Collect unique points to avoid moving shared points twice
      const movedPts = new Set();
      for (const e of state.selectedEntities) {
        if (e.type === 'segment') {
          if (!movedPts.has(e.p1)) { e.p1.x += dx; e.p1.y += dy; movedPts.add(e.p1); }
          if (!movedPts.has(e.p2)) { e.p2.x += dx; e.p2.y += dy; movedPts.add(e.p2); }
        } else if (e.type === 'circle' || e.type === 'arc') {
          if (!movedPts.has(e.center)) { e.center.x += dx; e.center.y += dy; movedPts.add(e.center); }
        } else {
          e.translate(dx, dy);
        }
      }
      state.scene.solve();
      state.emit('change');
      this.step = 0;
      this.app.renderer.previewEntities = [];
      this.setStatus('Move: Click base point');
    }
  }

  onMouseMove(wx, wy) {
    if (this.step === 1) {
      const dx = wx - this._baseX;
      const dy = wy - this._baseY;
      const previews = [];
      for (const e of state.selectedEntities) {
        const prev = this._makePreview(e, dx, dy);
        if (prev) previews.push(prev);
      }
      this.app.renderer.previewEntities = previews;
    }
  }

  /** Create a lightweight preview primitive offset by (dx, dy) */
  _makePreview(e, dx, dy) {
    switch (e.type) {
      case 'segment':
        return new PSegment(
          new PPoint(e.x1 + dx, e.y1 + dy),
          new PPoint(e.x2 + dx, e.y2 + dy)
        );
      case 'circle':
        return new PCircle(new PPoint(e.cx + dx, e.cy + dy), e.radius);
      case 'arc':
        return new PArc(new PPoint(e.cx + dx, e.cy + dy), e.radius, e.startAngle, e.endAngle);
      default:
        return null;
    }
  }

  onCancel() {
    super.onCancel();
    this.setStatus('Move: Click base point');
  }
}

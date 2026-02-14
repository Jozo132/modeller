// js/tools/SelectTool.js
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';

export class SelectTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'select';
    this._dragStart = null;
    this._isDragging = false;
    this._selectionBox = null;
  }

  activate() {
    super.activate();
    this.app.renderer.hoverEntity = null;
    this.setStatus('Click to select, drag for box selection');
  }

  deactivate() {
    this.app.renderer.hoverEntity = null;
    super.deactivate();
  }

  _findClosestEntity(wx, wy, pixelTolerance = 12) {
    const worldTolerance = pixelTolerance / this.app.viewport.zoom;
    let hit = null;
    let minDist = Infinity;

    for (const entity of state.entities) {
      if (!entity.visible || !state.isLayerVisible(entity.layer)) continue;
      const d = entity.distanceTo(wx, wy);
      if (d <= worldTolerance && d < minDist) {
        minDist = d;
        hit = entity;
      }
    }
    return hit;
  }

  onClick(wx, wy, event) {
    if (this._isDragging) return;

    const hit = this.app.renderer.hoverEntity || this._findClosestEntity(wx, wy, 14);

    if (!event.shiftKey) {
      state.clearSelection();
    }

    if (hit) {
      if (event.shiftKey && hit.selected) {
        state.deselect(hit);
      } else {
        state.select(hit);
      }
    }
  }

  onMouseDown(wx, wy, sx, sy, event) {
    if (event.button === 0) {
      this._dragStart = { wx, wy, sx, sy };
      this._isDragging = false;
    }
  }

  onMouseMove(wx, wy, sx, sy) {
    if (this._dragStart) {
      const dx = sx - this._dragStart.sx;
      const dy = sy - this._dragStart.sy;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        this._isDragging = true;
        this._selectionBox = {
          x1: this._dragStart.wx,
          y1: this._dragStart.wy,
          x2: wx,
          y2: wy,
        };
      }
      this.app.renderer.hoverEntity = null;
    } else {
      this.app.renderer.hoverEntity = this._findClosestEntity(wx, wy, 12);
    }
  }

  onMouseUp(wx, wy, event) {
    if (this._isDragging && this._selectionBox) {
      const box = this._selectionBox;
      const minX = Math.min(box.x1, box.x2);
      const maxX = Math.max(box.x1, box.x2);
      const minY = Math.min(box.y1, box.y2);
      const maxY = Math.max(box.y1, box.y2);

      // If dragging left-to-right => window select (fully inside)
      // If right-to-left => crossing select (any intersection)
      const isWindow = box.x2 > box.x1;

      if (!event.shiftKey) state.clearSelection();

      for (const entity of state.entities) {
        if (!entity.visible || !state.isLayerVisible(entity.layer)) continue;
        const b = entity.getBounds();
        if (isWindow) {
          if (b.minX >= minX && b.maxX <= maxX && b.minY >= minY && b.maxY <= maxY) {
            state.select(entity);
          }
        } else {
          if (b.maxX >= minX && b.minX <= maxX && b.maxY >= minY && b.minY <= maxY) {
            state.select(entity);
          }
        }
      }
    }
    this._dragStart = null;
    this._isDragging = false;
    this._selectionBox = null;

    if (!this._isDragging) {
      this.app.renderer.hoverEntity = this._findClosestEntity(wx, wy, 12);
    }
  }

  /** Render the selection box overlay */
  drawOverlay(ctx, vp) {
    if (!this._isDragging || !this._selectionBox) return;
    const box = this._selectionBox;
    const p1 = vp.worldToScreen(box.x1, box.y1);
    const p2 = vp.worldToScreen(box.x2, box.y2);
    const x = Math.min(p1.x, p2.x);
    const y = Math.min(p1.y, p2.y);
    const w = Math.abs(p2.x - p1.x);
    const h = Math.abs(p2.y - p1.y);

    ctx.save();
    const isWindow = box.x2 > box.x1;
    if (isWindow) {
      ctx.fillStyle = 'rgba(0,100,255,0.1)';
      ctx.strokeStyle = 'rgba(0,100,255,0.6)';
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = 'rgba(0,200,100,0.1)';
      ctx.strokeStyle = 'rgba(0,200,100,0.6)';
      ctx.setLineDash([6, 4]);
    }
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
}

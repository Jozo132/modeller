// js/tools/SelectTool.js
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { union } from '../cad/Operations.js';

const PICK_PX = 18;       // pixel tolerance for shape picking
const PICK_PT_PX = 14;    // pixel tolerance for point picking (tighter — points are small)
const DRAG_THRESHOLD = 5; // min pixels before a drag starts

/** Collect the unique movable points of a shape. */
function _shapePoints(shape) {
  if (shape.type === 'segment') return [shape.p1, shape.p2];
  if (shape.type === 'circle' || shape.type === 'arc') return [shape.center];
  return [];
}

/** True when every defining point of a primitive is fully locked. */
function _isFullyConstrained(prim) {
  if (prim.type === 'point') return prim.fixed;
  const pts = _shapePoints(prim);
  return pts.length > 0 && pts.every(p => p.fixed);
}

export class SelectTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'select';
    this._dragStart = null;
    this._isDragging = false;
    this._selectionBox = null;

    // Vertex drag state
    this._dragPoint = null;       // PPoint being dragged
    this._dragTookSnapshot = false;

    // Shape drag state
    this._dragShape = null;       // shape being dragged (segment / circle / arc)
    this._dragShapePts = [];      // non-fixed points of that shape

    // Dimension drag state (repositioning the offset)
    this._dragDimension = null;   // DimensionPrimitive being dragged

    // Snap-to-coincidence state
    this._snapCandidate = null;   // {point, x, y} — nearby point to merge on drop
  }

  activate() {
    super.activate();
    this.app.renderer.hoverEntity = null;
    this.setStatus('Click to select, drag for box selection, drag a point/shape to move it');
  }

  deactivate() {
    this.app.renderer.hoverEntity = null;
    this._dragPoint = null;
    this._dragShape = null;
    this._dragShapePts = [];
    this._dragDimension = null;
    this._snapCandidate = null;
    super.deactivate();
  }

  // ------------------------------------------------------------------
  //  Hit-testing helpers
  // ------------------------------------------------------------------

  /** Find closest point (vertex) near screen position */
  _findClosestPoint(wx, wy, pixelTolerance = PICK_PT_PX) {
    const worldTol = pixelTolerance / this.app.viewport.zoom;
    return state.scene.findClosestPoint(wx, wy, worldTol);
  }

  /** Find closest shape (segment/circle/arc/text/dim) near screen position */
  _findClosestEntity(wx, wy, pixelTolerance = PICK_PX) {
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

  /** Combined hit: prefer point if very close, otherwise shape */
  _hitTest(wx, wy) {
    const pt = this._findClosestPoint(wx, wy, PICK_PT_PX);
    if (pt) return { kind: 'point', target: pt };
    const shape = this._findClosestEntity(wx, wy, PICK_PX);
    if (shape) return { kind: 'shape', target: shape };
    return null;
  }

  // ------------------------------------------------------------------
  //  Events
  // ------------------------------------------------------------------

  onClick(wx, wy, event) {
    // If we just finished a drag, suppress the click
    if (this._dragPoint || this._dragShape || this._dragDimension) return;
    if (this._isDragging) return;

    const hit = this._hitTest(wx, wy);

    if (!event.shiftKey) {
      state.clearSelection();
    }

    if (hit) {
      const t = hit.target;
      if (event.shiftKey && t.selected) {
        state.deselect(t);
      } else {
        state.select(t);
      }
    }
  }

  onMouseDown(wx, wy, sx, sy, event) {
    if (event.button !== 0) return;

    // 1. Point takes priority
    const pt = this._findClosestPoint(wx, wy, PICK_PT_PX);
    if (pt) {
      if (pt.fixed) {
        // Fully constrained point — allow click-select but not drag
        this._dragStart = { wx, wy, sx, sy };
        this._isDragging = false;
        this._dragPoint = null;
        this._dragShape = null;
        return;
      }
      this._dragPoint = pt;
      this._dragShape = null;
      this._dragShapePts = [];
      this._dragTookSnapshot = false;
      this._isDragging = false;
      this._dragStart = { wx, wy, sx, sy };
      return;
    }

    // 2. Dimension drag — reposition offset
    const entity = this._findClosestEntity(wx, wy, PICK_PX);
    if (entity && entity.type === 'dimension') {
      this._dragDimension = entity;
      this._dragPoint = null;
      this._dragShape = null;
      this._dragShapePts = [];
      this._dragTookSnapshot = false;
      this._isDragging = false;
      this._dragStart = { wx, wy, sx, sy };
      return;
    }

    // 3. Shape drag (segment / circle / arc)
    const shape = entity;
    if (shape && !_isFullyConstrained(shape)) {
      const movable = _shapePoints(shape).filter(p => !p.fixed);
      if (movable.length > 0) {
        this._dragShape = shape;
        this._dragShapePts = movable;
        this._dragPoint = null;
        this._dragTookSnapshot = false;
        this._isDragging = false;
        this._dragStart = { wx, wy, sx, sy };
        return;
      }
    }

    // 4. Default — box select / click-select
    this._dragStart = { wx, wy, sx, sy };
    this._isDragging = false;
    this._dragPoint = null;
    this._dragShape = null;
    this._dragShapePts = [];
    this._dragDimension = null;
  }

  onMouseMove(wx, wy, sx, sy) {
    // ---- Vertex drag in progress ----
    if (this._dragPoint && this._dragStart) {
      const dx = sx - this._dragStart.sx;
      const dy = sy - this._dragStart.sy;
      if (!this._isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        this._isDragging = true;
        if (!this._dragTookSnapshot) { takeSnapshot(); this._dragTookSnapshot = true; }
      }
      if (this._isDragging) {
        this._dragPoint.x = wx;
        this._dragPoint.y = wy;
        state.scene.solve();

        // --- Snap-to-coincidence detection ---
        this._snapCandidate = null;
        const snapTol = PICK_PT_PX / this.app.viewport.zoom;
        const dragPt = this._dragPoint;
        // Collect points that already share this point (same primitive endpoints)
        const connectedPts = new Set();
        connectedPts.add(dragPt);
        for (const s of state.scene.segments) {
          if (s.p1 === dragPt) connectedPts.add(s.p2);
          if (s.p2 === dragPt) connectedPts.add(s.p1);
        }
        // Also skip points already coincident-constrained with dragPt
        for (const c of state.scene.constraints) {
          if (c.type === 'coincident') {
            if (c.ptA === dragPt) connectedPts.add(c.ptB);
            if (c.ptB === dragPt) connectedPts.add(c.ptA);
          }
        }
        let bestDist = Infinity;
        for (const p of state.scene.points) {
          if (connectedPts.has(p)) continue;
          const d = Math.hypot(p.x - dragPt.x, p.y - dragPt.y);
          if (d < snapTol && d < bestDist) {
            bestDist = d;
            this._snapCandidate = { point: p, x: p.x, y: p.y };
          }
        }

        state.emit('change');
      }
      return;
    }

    // ---- Dimension drag in progress ----
    if (this._dragDimension && this._dragStart) {
      const dx = sx - this._dragStart.sx;
      const dy = sy - this._dragStart.sy;
      if (!this._isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        this._isDragging = true;
        if (!this._dragTookSnapshot) { takeSnapshot(); this._dragTookSnapshot = true; }
      }
      if (this._isDragging) {
        this._dragDimension.offset = this._computeDimOffset(this._dragDimension, wx, wy);
        state.emit('change');
      }
      return;
    }

    // ---- Shape drag in progress ----
    if (this._dragShape && this._dragStart) {
      const dx = sx - this._dragStart.sx;
      const dy = sy - this._dragStart.sy;
      if (!this._isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        this._isDragging = true;
        if (!this._dragTookSnapshot) { takeSnapshot(); this._dragTookSnapshot = true; }
      }
      if (this._isDragging) {
        const wdx = wx - this._dragStart.wx;
        const wdy = wy - this._dragStart.wy;
        for (const p of this._dragShapePts) {
          p.x += wdx;
          p.y += wdy;
        }
        // Update reference so delta is cumulative
        this._dragStart.wx = wx;
        this._dragStart.wy = wy;
        state.scene.solve();
        state.emit('change');
      }
      return;
    }

    // ---- Box-select drag ----
    if (this._dragStart) {
      const dx = sx - this._dragStart.sx;
      const dy = sy - this._dragStart.sy;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        this._isDragging = true;
        this._selectionBox = {
          x1: this._dragStart.wx,
          y1: this._dragStart.wy,
          x2: wx,
          y2: wy,
        };
      }
      this.app.renderer.hoverEntity = null;
      return;
    }

    // ---- Hover highlight ----
    const hit = this._hitTest(wx, wy);
    this.app.renderer.hoverEntity = hit ? hit.target : null;
  }

  onMouseUp(wx, wy, event) {
    // ---- Finish vertex drag ----
    if (this._dragPoint) {
      if (this._isDragging) {
        // Apply coincidence if snapped to a candidate point
        if (this._snapCandidate) {
          union(state.scene, this._dragPoint, this._snapCandidate.point);
          this._snapCandidate = null;
        }
        state.scene.solve();
        state.emit('change');
      }
      this._dragPoint = null;
      this._snapCandidate = null;
      this._isDragging = false;
      this._dragStart = null;
      this._dragTookSnapshot = false;
      return;
    }

    // ---- Finish dimension drag ----
    if (this._dragDimension) {
      if (this._isDragging) {
        state.emit('change');
      }
      this._dragDimension = null;
      this._isDragging = false;
      this._dragStart = null;
      this._dragTookSnapshot = false;
      return;
    }

    // ---- Finish shape drag ----
    if (this._dragShape) {
      if (this._isDragging) {
        state.scene.solve();
        state.emit('change');
      }
      this._dragShape = null;
      this._dragShapePts = [];
      this._isDragging = false;
      this._dragStart = null;
      this._dragTookSnapshot = false;
      return;
    }

    // ---- Finish box selection ----
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

    // Refresh hover
    const hit = this._hitTest(wx, wy);
    this.app.renderer.hoverEntity = hit ? hit.target : null;
  }

  onCancel() {
    this._dragPoint = null;
    this._dragShape = null;
    this._dragShapePts = [];
    this._dragDimension = null;
    this._snapCandidate = null;
    this._isDragging = false;
    this._dragStart = null;
    this._selectionBox = null;
    this._dragTookSnapshot = false;
    super.onCancel();
  }

  /** Compute new offset for a dimension based on world mouse position. */
  _computeDimOffset(dim, wx, wy) {
    if (dim.dimType === 'angle') {
      // Offset = distance from vertex to mouse
      return Math.hypot(wx - dim.x1, wy - dim.y1) || 10;
    }
    if (dim.dimType === 'dx') {
      // Offset moves the horizontal dim line vertically
      return (wy - dim.y1) || 10;
    }
    if (dim.dimType === 'dy') {
      // Offset moves the vertical dim line horizontally
      return (wx - dim.x1) || 10;
    }
    // Linear: perpendicular projection onto the dimension baseline normal
    const dx = dim.x2 - dim.x1, dy = dim.y2 - dim.y1;
    const len = Math.hypot(dx, dy) || 1e-9;
    const nx = -dy / len, ny = dx / len;
    const dot = (wx - dim.x1) * nx + (wy - dim.y1) * ny;
    return dot || 10;
  }

  /** Render the selection box overlay */
  drawOverlay(ctx, vp) {
    // --- Coincidence snap indicator ---
    if (this._snapCandidate && this._isDragging) {
      const s = vp.worldToScreen(this._snapCandidate.x, this._snapCandidate.y);
      const r = 8;
      ctx.save();
      // Outer circle
      ctx.strokeStyle = '#00e676';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
      // Inner dot
      ctx.fillStyle = '#00e676';
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      // "Coincident" label
      ctx.font = '10px Consolas, monospace';
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(0,230,118,0.85)';
      ctx.fillText('⊙ Coincident', s.x + r + 4, s.y - 2);
      ctx.restore();
    }

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

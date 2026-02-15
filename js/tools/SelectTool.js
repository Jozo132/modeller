// js/tools/SelectTool.js
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { union } from '../cad/Operations.js';
import { OnLine } from '../cad/Constraint.js';

const PICK_PX = 18;       // pixel tolerance for shape picking
const PICK_PT_PX = 14;    // pixel tolerance for point picking (tighter — points are small)
const DRAG_THRESHOLD = 5; // min pixels before a drag starts
const ALIGN_TOL_PX = 5;   // pixel tolerance for alignment guide detection

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
    this._snapCandidates = [];    // [{dragPt, targetPt, x, y}, ...] — nearby points to merge on drop

    // Point-to-line snap state
    this._lineSnapCandidates = []; // [{dragPt, seg, x, y}, ...] — points to constrain on-line on drop

    // Alignment guide state (visual only, no constraints)
    this._alignmentGuides = [];   // [{axis:'h'|'v', dragPt, matchPt, value}, ...]
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
    this._snapCandidates = [];
    this._lineSnapCandidates = [];
    this._alignmentGuides = [];
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
  //  Snap-to-coincidence helpers
  // ------------------------------------------------------------------

  /**
   * Find snap-to-coincidence candidates for a set of dragged points.
   * For each dragged point, find the closest non-connected scene point within
   * snap tolerance. Returns array of {dragPt, targetPt, x, y}.
   * Each target point is only used once (closest drag point wins).
   */
  _findSnapCandidates(dragPts) {
    const snapTol = PICK_PT_PX / this.app.viewport.zoom;
    const scene = state.scene;
    const dragSet = new Set(dragPts);

    // Build exclusion set: points connected to any dragged point
    const excluded = new Set(dragPts);
    for (const dp of dragPts) {
      for (const s of scene.segments) {
        if (s.p1 === dp) excluded.add(s.p2);
        if (s.p2 === dp) excluded.add(s.p1);
      }
      for (const c of scene.constraints) {
        if (c.type === 'coincident') {
          if (c.ptA === dp) excluded.add(c.ptB);
          if (c.ptB === dp) excluded.add(c.ptA);
        }
      }
    }

    // For each dragged point find the best target
    const candidates = [];
    const usedTargets = new Set();
    for (const dp of dragPts) {
      let bestDist = Infinity;
      let bestTarget = null;
      for (const p of scene.points) {
        if (excluded.has(p) || usedTargets.has(p)) continue;
        const d = Math.hypot(p.x - dp.x, p.y - dp.y);
        if (d < snapTol && d < bestDist) {
          bestDist = d;
          bestTarget = p;
        }
      }
      if (bestTarget) {
        candidates.push({ dragPt: dp, targetPt: bestTarget, x: bestTarget.x, y: bestTarget.y });
        usedTargets.add(bestTarget);
      }
    }
    return candidates;
  }

  /** Apply all snap candidates — merge each drag point into its target. */
  _applySnapCandidates() {
    if (this._snapCandidates.length === 0) return;
    const scene = state.scene;
    for (const c of this._snapCandidates) {
      // Verify both points still exist (union may have removed some)
      if (scene.points.includes(c.dragPt) && scene.points.includes(c.targetPt)) {
        union(scene, c.dragPt, c.targetPt);
      }
    }
    this._snapCandidates = [];
  }

  /**
   * Find point-to-line snap candidates for dragged points.
   * Only activates if the point is NOT already snapping to a coincident point.
   * Returns array of {dragPt, seg, x, y} where (x,y) is the projection.
   */
  _findLineSnapCandidates(dragPts) {
    const snapTol = PICK_PX / this.app.viewport.zoom;
    const scene = state.scene;
    const dragSet = new Set(dragPts);
    // Points that already have a coincident snap — skip line snap for those
    const coincidentDragPts = new Set(this._snapCandidates.map(c => c.dragPt));

    const candidates = [];
    for (const dp of dragPts) {
      if (coincidentDragPts.has(dp)) continue;
      // Check if already on-line constrained to a segment
      const alreadyOnLine = scene.constraints.some(c =>
        c.type === 'on_line' && c.pt === dp
      );
      if (alreadyOnLine) continue;

      let bestDist = Infinity;
      let bestSeg = null;
      let bestX = 0, bestY = 0;
      for (const seg of scene.segments) {
        // Skip segments that own this point
        if (seg.p1 === dp || seg.p2 === dp) continue;
        const d = seg.distanceTo(dp.x, dp.y);
        if (d < snapTol && d < bestDist) {
          // Compute projection onto segment
          const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
          const lenSq = dx * dx + dy * dy;
          if (lenSq < 1e-12) continue;
          let t = ((dp.x - seg.x1) * dx + (dp.y - seg.y1) * dy) / lenSq;
          t = Math.max(0, Math.min(1, t));
          bestX = seg.x1 + t * dx;
          bestY = seg.y1 + t * dy;
          bestDist = d;
          bestSeg = seg;
        }
      }
      if (bestSeg) {
        candidates.push({ dragPt: dp, seg: bestSeg, x: bestX, y: bestY });
      }
    }
    return candidates;
  }

  /** Apply line snap candidates — add OnLine constraints. */
  _applyLineSnapCandidates() {
    if (this._lineSnapCandidates.length === 0) return;
    const scene = state.scene;
    for (const c of this._lineSnapCandidates) {
      if (scene.points.includes(c.dragPt) && scene.segments.includes(c.seg)) {
        const constraint = new OnLine(c.dragPt, c.seg);
        scene.addConstraint(constraint);
      }
    }
    this._lineSnapCandidates = [];
  }

  /**
   * Find horizontal/vertical alignment guides for dragged points.
   * Returns array of {axis, dragPt, matchX, matchY, value}.
   * Only visual — no constraints applied.
   */
  _findAlignmentGuides(dragPts) {
    const alignTol = ALIGN_TOL_PX / this.app.viewport.zoom;
    const scene = state.scene;
    const dragSet = new Set(dragPts);
    const guides = [];
    const seenH = new Set(); // avoid duplicate guides for same Y value
    const seenV = new Set(); // avoid duplicate guides for same X value

    for (const dp of dragPts) {
      for (const p of scene.points) {
        if (dragSet.has(p)) continue;
        // Horizontal alignment (same Y)
        const dy = Math.abs(p.y - dp.y);
        if (dy < alignTol && dy > 1e-9) {
          const key = `h_${dp.id}_${Math.round(p.y * 1000)}`;
          if (!seenH.has(key)) {
            seenH.add(key);
            guides.push({ axis: 'h', dragPt: dp, matchX: p.x, matchY: p.y, value: p.y });
          }
        }
        // Vertical alignment (same X)
        const dx = Math.abs(p.x - dp.x);
        if (dx < alignTol && dx > 1e-9) {
          const key = `v_${dp.id}_${Math.round(p.x * 1000)}`;
          if (!seenV.has(key)) {
            seenV.add(key);
            guides.push({ axis: 'v', dragPt: dp, matchX: p.x, matchY: p.y, value: p.x });
          }
        }
      }
    }
    return guides;
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

        // Snap-to-coincidence detection for the single dragged point
        if (state.autoCoincidence) {
          this._snapCandidates = this._findSnapCandidates([this._dragPoint]);
          this._lineSnapCandidates = this._findLineSnapCandidates([this._dragPoint]);
        } else {
          this._snapCandidates = [];
          this._lineSnapCandidates = [];
        }
        this._alignmentGuides = this._findAlignmentGuides([this._dragPoint]);

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

        // Snap-to-coincidence detection for all movable points of the shape
        if (state.autoCoincidence) {
          this._snapCandidates = this._findSnapCandidates(this._dragShapePts);
          this._lineSnapCandidates = this._findLineSnapCandidates(this._dragShapePts);
        } else {
          this._snapCandidates = [];
          this._lineSnapCandidates = [];
        }
        this._alignmentGuides = this._findAlignmentGuides(this._dragShapePts);

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
        this._applySnapCandidates();
        this._applyLineSnapCandidates();
        state.scene.solve();
        state.emit('change');
      }
      this._dragPoint = null;
      this._snapCandidates = [];
      this._lineSnapCandidates = [];
      this._alignmentGuides = [];
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
        this._applySnapCandidates();
        this._applyLineSnapCandidates();
        state.scene.solve();
        state.emit('change');
      }
      this._dragShape = null;
      this._dragShapePts = [];
      this._snapCandidates = [];
      this._lineSnapCandidates = [];
      this._alignmentGuides = [];
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
    this._snapCandidates = [];
    this._lineSnapCandidates = [];
    this._alignmentGuides = [];
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
    // --- Coincidence snap indicators ---
    if (this._snapCandidates.length > 0 && this._isDragging) {
      ctx.save();
      for (const cand of this._snapCandidates) {
        const s = vp.worldToScreen(cand.x, cand.y);
        const r = 8;
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
        ctx.fillText('\u2299 Coincident', s.x + r + 4, s.y - 2);
      }
      ctx.restore();
    }

    // --- On-line snap indicators ---
    if (this._lineSnapCandidates.length > 0 && this._isDragging) {
      ctx.save();
      for (const cand of this._lineSnapCandidates) {
        const s = vp.worldToScreen(cand.x, cand.y);
        const r = 8;
        // Draw a small "X" on the line
        ctx.strokeStyle = '#ff9800';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(s.x - r * 0.6, s.y - r * 0.6);
        ctx.lineTo(s.x + r * 0.6, s.y + r * 0.6);
        ctx.moveTo(s.x + r * 0.6, s.y - r * 0.6);
        ctx.lineTo(s.x - r * 0.6, s.y + r * 0.6);
        ctx.stroke();
        // Circle around it
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.stroke();
        // "On Line" label
        ctx.font = '10px Consolas, monospace';
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(255,152,0,0.85)';
        ctx.fillText('\u2295 On Line', s.x + r + 4, s.y - 2);
      }
      ctx.restore();
    }

    // --- Alignment guides (thin dashed lines) ---
    if (this._alignmentGuides.length > 0 && this._isDragging) {
      ctx.save();
      ctx.strokeStyle = 'rgba(0,200,255,0.45)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([6, 4]);
      const cw = ctx.canvas.width;
      const ch = ctx.canvas.height;
      for (const g of this._alignmentGuides) {
        if (g.axis === 'h') {
          // Horizontal guide at y = g.value
          const sy = vp.worldToScreen(0, g.value).y;
          ctx.beginPath();
          ctx.moveTo(0, sy);
          ctx.lineTo(cw, sy);
          ctx.stroke();
          // Small diamond at the matched point
          const ms = vp.worldToScreen(g.matchX, g.matchY);
          ctx.fillStyle = 'rgba(0,200,255,0.6)';
          ctx.beginPath();
          ctx.moveTo(ms.x, ms.y - 4);
          ctx.lineTo(ms.x + 4, ms.y);
          ctx.lineTo(ms.x, ms.y + 4);
          ctx.lineTo(ms.x - 4, ms.y);
          ctx.closePath();
          ctx.fill();
        } else {
          // Vertical guide at x = g.value
          const sx = vp.worldToScreen(g.value, 0).x;
          ctx.beginPath();
          ctx.moveTo(sx, 0);
          ctx.lineTo(sx, ch);
          ctx.stroke();
          // Small diamond at the matched point
          const ms = vp.worldToScreen(g.matchX, g.matchY);
          ctx.fillStyle = 'rgba(0,200,255,0.6)';
          ctx.beginPath();
          ctx.moveTo(ms.x, ms.y - 4);
          ctx.lineTo(ms.x + 4, ms.y);
          ctx.lineTo(ms.x, ms.y + 4);
          ctx.lineTo(ms.x - 4, ms.y);
          ctx.closePath();
          ctx.fill();
        }
      }
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

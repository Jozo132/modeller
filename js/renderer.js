// js/renderer.js — Canvas renderer: grid, entities, selection highlights, crosshair

import { state } from './state.js';
import { error as logError } from './logger.js';

const SNAP_MARKER_SIZE = 6;

export class Renderer {
  constructor(viewport) {
    this.vp = viewport;
    this.ctx = viewport.ctx;

    // Snap indicator
    this.snapPoint = null;   // {x, y, type}
    this.cursorWorld = null;  // {x, y}  current cursor in world

    // Temp entity for tool preview
    this.previewEntities = [];
    this.hoverEntity = null;
  }

  /** Full redraw */
  render() {
    try {
      const { ctx, vp } = this;
      ctx.clearRect(0, 0, vp.width, vp.height);
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, vp.width, vp.height);

      if (state.gridVisible) this._drawGrid();
      this._drawAxes();
      this._drawEntities();
      this._drawPoints();
      this._drawConstraints();
      this._drawPreview();
      this._drawSnapIndicator();
      this._drawCrosshair();
    } catch (err) {
      logError('Renderer.render failed', err);
    }
  }

  // --- Grid ---
  _drawGrid() {
    const { ctx, vp } = this;
    const baseGridSize = state.gridSize;

    // Determine visible world bounds
    const tl = vp.screenToWorld(0, 0);
    const br = vp.screenToWorld(vp.width, vp.height);
    const worldLeft = Math.min(tl.x, br.x);
    const worldRight = Math.max(tl.x, br.x);
    const worldTop = Math.max(tl.y, br.y);
    const worldBottom = Math.min(tl.y, br.y);

    // Keep grid readable at all zoom levels by adapting world step
    let gridStep = baseGridSize;
    while (gridStep * vp.zoom < 8) {
      gridStep *= 2;
    }

    // Minor grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 0.5;
    const startX = Math.floor(worldLeft / gridStep) * gridStep;
    const startY = Math.floor(worldBottom / gridStep) * gridStep;

    ctx.beginPath();
    for (let x = startX; x <= worldRight; x += gridStep) {
      const s = vp.worldToScreen(x, 0);
      ctx.moveTo(s.x, 0);
      ctx.lineTo(s.x, vp.height);
    }
    for (let y = startY; y <= worldTop; y += gridStep) {
      const s = vp.worldToScreen(0, y);
      ctx.moveTo(0, s.y);
      ctx.lineTo(vp.width, s.y);
    }
    ctx.stroke();

    // Major grid (every 5 units)
    const majorGs = gridStep * 5;
    if (majorGs * vp.zoom >= 20) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 0.5;
      const startMX = Math.floor(worldLeft / majorGs) * majorGs;
      const startMY = Math.floor(worldBottom / majorGs) * majorGs;
      ctx.beginPath();
      for (let x = startMX; x <= worldRight; x += majorGs) {
        const s = vp.worldToScreen(x, 0);
        ctx.moveTo(s.x, 0);
        ctx.lineTo(s.x, vp.height);
      }
      for (let y = startMY; y <= worldTop; y += majorGs) {
        const s = vp.worldToScreen(0, y);
        ctx.moveTo(0, s.y);
        ctx.lineTo(vp.width, s.y);
      }
      ctx.stroke();
    }
  }

  // --- Axes ---
  _drawAxes() {
    const { ctx, vp } = this;
    const origin = vp.worldToScreen(0, 0);

    // X axis (red)
    ctx.strokeStyle = 'rgba(255,80,80,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, origin.y);
    ctx.lineTo(vp.width, origin.y);
    ctx.stroke();

    // Y axis (green)
    ctx.strokeStyle = 'rgba(80,255,80,0.4)';
    ctx.beginPath();
    ctx.moveTo(origin.x, 0);
    ctx.lineTo(origin.x, vp.height);
    ctx.stroke();
  }

  // --- Entities ---
  _drawEntities() {
    const { ctx, vp } = this;
    for (const entity of state.entities) {
      if (!entity.visible) continue;
      if (!state.isLayerVisible(entity.layer)) continue;

      const color = entity.color || state.getLayerColor(entity.layer);

      if (entity.selected) {
        ctx.strokeStyle = '#00bfff';
        ctx.fillStyle = '#00bfff';
        ctx.lineWidth = 2;
      } else if (entity === this.hoverEntity) {
        ctx.strokeStyle = '#7fd8ff';
        ctx.fillStyle = '#7fd8ff';
        ctx.lineWidth = Math.max(1.5, (entity.lineWidth || 1) + 0.5);
      } else {
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = entity.lineWidth;
      }

      entity.draw(ctx, vp);

      // Draw selection grips
      if (entity.selected) {
        this._drawGrips(entity);
      }
    }
  }

  _drawGrips(entity) {
    const { ctx, vp } = this;
    const snaps = entity.getSnapPoints().filter(s => s.type === 'endpoint' || s.type === 'center');
    ctx.fillStyle = '#00bfff';
    for (const snap of snaps) {
      const s = vp.worldToScreen(snap.x, snap.y);
      ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
    }
  }

  // --- Points (shared vertices) ---
  _drawPoints() {
    const { ctx, vp } = this;
    const scene = state.scene;
    ctx.save();
    for (const pt of scene.points) {
      const s = vp.worldToScreen(pt.x, pt.y);
      // How many shapes share this point?
      const refs = scene.shapesUsingPoint(pt).length;
      if (refs <= 1 && !pt.selected && !pt.fixed) continue; // skip lonely points
      const r = pt.selected ? 5 : (pt.fixed ? 4 : 3);
      ctx.fillStyle = pt.fixed ? '#ff6644' : (pt.selected ? '#00bfff' : 'rgba(255,255,0,0.55)');
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // --- Constraint indicators ---
  _drawConstraints() {
    const { ctx, vp } = this;
    const scene = state.scene;
    ctx.save();
    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const c of scene.constraints) {
      const pts = c.involvedPoints();
      if (pts.length === 0) continue;
      // Draw a small icon near the centroid of involved points
      let cx = 0, cy = 0;
      for (const p of pts) { cx += p.x; cy += p.y; }
      cx /= pts.length; cy /= pts.length;
      const s = vp.worldToScreen(cx, cy);
      // Offset a bit so it doesn't overlap geometry
      const ox = s.x + 12, oy = s.y - 10;

      ctx.fillStyle = c.error() < 1e-4 ? 'rgba(0,230,118,0.7)' : 'rgba(255,100,60,0.8)';
      const label = _constraintLabel(c.type);
      ctx.fillText(label, ox, oy);
    }
    ctx.restore();
  }

  // --- Preview (ghost entities being drawn) ---
  _drawPreview() {
    const { ctx, vp } = this;
    if (this.previewEntities.length === 0) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,191,255,0.6)';
    ctx.fillStyle = 'rgba(0,191,255,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    for (const entity of this.previewEntities) {
      entity.draw(ctx, vp);
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  // --- Snap indicator ---
  _drawSnapIndicator() {
    if (!this.snapPoint) return;
    const { ctx, vp } = this;
    const s = vp.worldToScreen(this.snapPoint.x, this.snapPoint.y);
    const sz = SNAP_MARKER_SIZE;

    ctx.save();
    ctx.strokeStyle = '#ffff00';
    ctx.lineWidth = 1.5;

    switch (this.snapPoint.type) {
      case 'endpoint':
        ctx.strokeRect(s.x - sz, s.y - sz, sz * 2, sz * 2);
        break;
      case 'midpoint':
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - sz);
        ctx.lineTo(s.x + sz, s.y + sz);
        ctx.lineTo(s.x - sz, s.y + sz);
        ctx.closePath();
        ctx.stroke();
        break;
      case 'center':
        ctx.beginPath();
        ctx.arc(s.x, s.y, sz, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s.x - sz, s.y); ctx.lineTo(s.x + sz, s.y);
        ctx.moveTo(s.x, s.y - sz); ctx.lineTo(s.x, s.y + sz);
        ctx.stroke();
        break;
      case 'quadrant':
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - sz);
        ctx.lineTo(s.x + sz, s.y);
        ctx.lineTo(s.x, s.y + sz);
        ctx.lineTo(s.x - sz, s.y);
        ctx.closePath();
        ctx.stroke();
        break;
      case 'grid':
        ctx.beginPath();
        ctx.moveTo(s.x - sz, s.y); ctx.lineTo(s.x + sz, s.y);
        ctx.moveTo(s.x, s.y - sz); ctx.lineTo(s.x, s.y + sz);
        ctx.stroke();
        break;
    }
    ctx.restore();
  }

  // --- Crosshair at cursor ---
  _drawCrosshair() {
    if (!this.cursorWorld) return;
    const { ctx, vp } = this;
    const s = vp.worldToScreen(this.cursorWorld.x, this.cursorWorld.y);

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([]);
    const gap = 10;
    ctx.beginPath();
    // Horizontal
    ctx.moveTo(0, s.y);
    ctx.lineTo(s.x - gap, s.y);
    ctx.moveTo(s.x + gap, s.y);
    ctx.lineTo(vp.width, s.y);
    // Vertical
    ctx.moveTo(s.x, 0);
    ctx.lineTo(s.x, s.y - gap);
    ctx.moveTo(s.x, s.y + gap);
    ctx.lineTo(s.x, vp.height);
    ctx.stroke();
    ctx.restore();
  }
}

// Map constraint type to a short display label
function _constraintLabel(type) {
  const map = {
    coincident: '⊙', distance: '↔', fixed: '⊕',
    horizontal: 'H', vertical: 'V',
    parallel: '∥', perpendicular: '⊥', angle: '∠',
    equal_length: '=L', length: 'L',
    radius: 'R', tangent: 'T',
    on_line: '—·', on_circle: '○·', midpoint: 'M',
  };
  return map[type] || type;
}
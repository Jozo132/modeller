// js/tools/TrimTool.js — Free-drawn path trim tool.
// Draw a path across segments; crossed portions are highlighted in red
// and trimmed on mouse-up.
import { BaseTool } from './BaseTool.js';
import { state }    from '../state.js';
import { takeSnapshot } from '../history.js';
import { trim }     from '../cad/Operations.js';

export class TrimTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'trim';
    this._drawing   = false;
    this._path       = [];   // world-coord points [{x,y}, …]
    this._crossings  = [];   // [{seg, cutX, cutY, keepX, keepY, discardX, discardY}]
  }

  activate() {
    super.activate();
    this._reset();
    this.setStatus('Draw a path across segments to trim them');
  }

  deactivate() {
    this._reset();
    this.app.renderer.hoverEntity = null;
    super.deactivate();
  }

  _reset() {
    this._drawing  = false;
    this._path      = [];
    this._crossings = [];
  }

  // ---- events ----

  onMouseDown(wx, wy) {
    this._drawing = true;
    this._path      = [{ x: wx, y: wy }];
    this._crossings = [];
  }

  onMouseMove(wx, wy) {
    if (!this._drawing) return;
    const prev = this._path[this._path.length - 1];
    // Skip tiny moves
    if (Math.hypot(wx - prev.x, wy - prev.y) < 1 / this.app.viewport.zoom) return;

    const a = prev;
    const b = { x: wx, y: wy };
    this._path.push(b);

    // Test new path segment against all scene segments
    for (const seg of state.scene.segments) {
      if (this._crossings.some(c => c.seg === seg)) continue; // already crossed
      const ix = _segSeg(a, b,
                         { x: seg.x1, y: seg.y1 },
                         { x: seg.x2, y: seg.y2 });
      if (!ix) continue;

      // Decide which side to keep: keep the endpoint FARTHER from the
      // path at the crossing (the path sweeps through the nearer side).
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const d1 = Math.hypot(mx - seg.x1, my - seg.y1);
      const d2 = Math.hypot(mx - seg.x2, my - seg.y2);
      const keepX    = d1 > d2 ? seg.x1 : seg.x2;
      const keepY    = d1 > d2 ? seg.y1 : seg.y2;
      const discardX = d1 <= d2 ? seg.x1 : seg.x2;
      const discardY = d1 <= d2 ? seg.y1 : seg.y2;

      this._crossings.push({ seg, cutX: ix.x, cutY: ix.y,
                              keepX, keepY, discardX, discardY });
    }
  }

  onMouseUp() {
    if (!this._drawing) return;
    this._drawing = false;

    if (this._crossings.length) {
      takeSnapshot();
      for (const c of this._crossings) {
        if (!state.scene.segments.includes(c.seg)) continue; // already gone
        trim(state.scene, c.seg, c.cutX, c.cutY, c.keepX, c.keepY);
      }
      state.emit('change');
      this.setStatus(`Trimmed ${this._crossings.length} segment(s). Draw again or switch tool.`);
    }

    this._path      = [];
    this._crossings = [];
  }

  onClick() { /* handled by down/up */ }

  onCancel() {
    this._reset();
    this.app.renderer.hoverEntity = null;
    super.onCancel();
  }

  // ---- overlay ----

  drawOverlay(ctx, vp) {
    if (this._path.length < 2 && !this._crossings.length) return;
    ctx.save();

    // Dashed red cutting path
    if (this._path.length >= 2) {
      ctx.beginPath();
      let s = vp.worldToScreen(this._path[0].x, this._path[0].y);
      ctx.moveTo(s.x, s.y);
      for (let i = 1; i < this._path.length; i++) {
        s = vp.worldToScreen(this._path[i].x, this._path[i].y);
        ctx.lineTo(s.x, s.y);
      }
      ctx.strokeStyle = 'rgba(255,80,80,0.55)';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Highlight each trimmed-away portion
    for (const c of this._crossings) {
      const sc = vp.worldToScreen(c.cutX, c.cutY);
      const sd = vp.worldToScreen(c.discardX, c.discardY);

      // Thick red line for the portion that will be removed
      ctx.beginPath();
      ctx.moveTo(sc.x, sc.y);
      ctx.lineTo(sd.x, sd.y);
      ctx.strokeStyle = 'rgba(255,60,60,0.9)';
      ctx.lineWidth   = 3;
      ctx.stroke();

      // Small × at the discard endpoint
      const sz = 5;
      ctx.beginPath();
      ctx.moveTo(sd.x - sz, sd.y - sz); ctx.lineTo(sd.x + sz, sd.y + sz);
      ctx.moveTo(sd.x + sz, sd.y - sz); ctx.lineTo(sd.x - sz, sd.y + sz);
      ctx.strokeStyle = 'rgba(255,60,60,0.9)';
      ctx.lineWidth   = 2;
      ctx.stroke();
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Line-segment ↔ line-segment intersection (returns {x,y} or null)
// ---------------------------------------------------------------------------
function _segSeg(a, b, c, d) {
  const dx1 = b.x - a.x, dy1 = b.y - a.y;
  const dx2 = d.x - c.x, dy2 = d.y - c.y;
  const cross = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(cross) < 1e-10) return null;          // parallel / collinear

  const dx3 = c.x - a.x, dy3 = c.y - a.y;
  const t = (dx3 * dy2 - dy3 * dx2) / cross;
  const s = (dx3 * dy1 - dy3 * dx1) / cross;
  if (t < 0 || t > 1 || s < 0 || s > 1) return null; // no overlap

  return { x: a.x + t * dx1, y: a.y + t * dy1 };
}

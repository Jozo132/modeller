// js/viewport.js — Viewport handles pan/zoom and coordinate transforms

export class Viewport {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // World-space origin offset (pan)
    this.panX = 0; // in screen pixels
    this.panY = 0;
    this.zoom = 1; // pixels per world unit

    this._isPanning = false;
    this._panStartX = 0;
    this._panStartY = 0;

    this.resize();
  }

  resize(forcedWidth = null, forcedHeight = null) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, Math.floor(forcedWidth ?? rect.width));
    const cssHeight = Math.max(1, Math.floor(forcedHeight ?? rect.height));

    const MAX_BITMAP_SIDE = 8192;
    const bitmapWidth = Math.min(MAX_BITMAP_SIDE, Math.floor(cssWidth * dpr));
    const bitmapHeight = Math.min(MAX_BITMAP_SIDE, Math.floor(cssHeight * dpr));

    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    this.canvas.width = bitmapWidth;
    this.canvas.height = bitmapHeight;
    this.width = cssWidth;
    this.height = cssHeight;

    const scaleX = bitmapWidth / cssWidth;
    const scaleY = bitmapHeight / cssHeight;
    const effectiveScale = Math.min(scaleX, scaleY);
    this.ctx.setTransform(effectiveScale, 0, 0, effectiveScale, 0, 0);
  }

  /** Convert world coords to screen (canvas) coords */
  worldToScreen(wx, wy) {
    return {
      x: wx * this.zoom + this.panX + this.width / 2,
      y: -wy * this.zoom + this.panY + this.height / 2, // Y is flipped
    };
  }

  /** Convert screen (canvas) coords to world coords */
  screenToWorld(sx, sy) {
    return {
      x: (sx - this.panX - this.width / 2) / this.zoom,
      y: -(sy - this.panY - this.height / 2) / this.zoom,
    };
  }

  /** Zoom at a specific screen point */
  zoomAt(sx, sy, factor) {
    const before = this.screenToWorld(sx, sy);
    const nextZoom = Math.max(0.01, Math.min(1000, this.zoom * factor));
    this.zoom = nextZoom;

    this.panX = sx - before.x * this.zoom - this.width / 2;
    this.panY = sy + before.y * this.zoom - this.height / 2;
  }

  /** Fit all entities in view */
  fitEntities(entities) {
    if (entities.length === 0) {
      this.panX = 0; this.panY = 0; this.zoom = 1;
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of entities) {
      const b = e.getBounds();
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const padding = 40;
    const scaleX = (this.width - padding * 2) / w;
    const scaleY = (this.height - padding * 2) / h;
    this.zoom = Math.min(scaleX, scaleY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.panX = -cx * this.zoom;
    this.panY = cy * this.zoom;
  }

  /** Start panning */
  startPan(sx, sy) {
    this._isPanning = true;
    this._panStartX = sx - this.panX;
    this._panStartY = sy - this.panY;
  }

  /** Update pan */
  updatePan(sx, sy) {
    if (!this._isPanning) return;
    this.panX = sx - this._panStartX;
    this.panY = sy - this._panStartY;
  }

  /** End panning */
  endPan() {
    this._isPanning = false;
  }

  get isPanning() { return this._isPanning; }
}

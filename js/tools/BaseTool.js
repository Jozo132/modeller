// js/tools/BaseTool.js — Abstract base tool

export class BaseTool {
  constructor(app) {
    this.app = app;       // Main app reference
    this.name = 'base';
    this.step = 0;        // Multi-click tracking
  }

  /** Called when tool is activated */
  activate() { this.step = 0; }

  /** Called when tool is deactivated */
  deactivate() {
    this.step = 0;
    this.app.renderer.previewEntities = [];
  }

  /** Mouse click (after snap) */
  onClick(worldX, worldY, event) {}

  /** Mouse move (after snap) */
  onMouseMove(worldX, worldY, screenX, screenY) {}

  /** Right-click or Escape — cancel / finish */
  onCancel() {
    this.step = 0;
    this.app.renderer.previewEntities = [];
    this.app.setStatus('');
  }

  /** Key press */
  onKeyDown(event) {}

  /** Set status message */
  setStatus(msg) {
    this.app.setStatus(msg);
  }

  /**
   * Returns the effective pixels-per-world-unit for tolerance calculations.
   * In 3D sketch mode the 2D viewport zoom is not updated to match the 3D
   * camera, so we derive the scale from the 3D projection instead.
   */
  _effectiveZoom() {
    if (this.app._sketchingOnPlane && this.app._renderer3d) {
      const s0 = this.app._renderer3d.sketchToScreen(0, 0);
      const s1 = this.app._renderer3d.sketchToScreen(1, 0);
      if (s0 && s1) {
        const ppu = Math.hypot(s1.x - s0.x, s1.y - s0.y);
        if (ppu > 1e-3) return ppu;
      }
    }
    return this.app.viewport.zoom;
  }
}

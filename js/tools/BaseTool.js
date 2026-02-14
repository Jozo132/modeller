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
}

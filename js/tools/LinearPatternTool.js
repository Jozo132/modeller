// js/tools/LinearPatternTool.js — 2D linear pattern along a reference line
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { LinearPattern } from '../cad/Constraint.js';

const PT_PX = 12;
const SEG_PX = 16;

export class LinearPatternTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'linear_pattern';
    this._selectedPoints = [];
    this._directionSeg = null;
    this._count = 2;
    this._spacing = 10;
    this._panel = null;
  }

  activate() {
    super.activate();
    this._selectedPoints = [];
    this._directionSeg = null;
    this._count = 2;
    this._spacing = 10;
    this.step = 0;
    this._showPanel();
    this._updatePanel();
    this.setStatus('Select source points for the linear pattern');
  }

  deactivate() {
    this._selectedPoints = [];
    this._directionSeg = null;
    this._hidePanel();
    this.app.renderer.hoverEntity = null;
    this.app.renderer.previewEntities = [];
    super.deactivate();
  }

  _findPoint(wx, wy) {
    const tol = PT_PX / this.app.viewport.zoom;
    return state.scene.findClosestPoint(wx, wy, tol);
  }

  _findSegment(wx, wy) {
    const tol = SEG_PX / this.app.viewport.zoom;
    const hit = state.scene.findClosestShape(wx, wy, tol);
    return (hit && hit.type === 'segment') ? hit : null;
  }

  onMouseMove(wx, wy) {
    if (this.step <= 1) {
      if (this.step === 0) {
        const pt = this._findPoint(wx, wy);
        this.app.renderer.hoverEntity = pt;
      } else {
        const seg = this._findSegment(wx, wy);
        this.app.renderer.hoverEntity = seg;
      }
    }
  }

  onClick(wx, wy) {
    if (this.step === 0) {
      const pt = this._findPoint(wx, wy);
      if (!pt) { this.setStatus('No point found — click closer to a point'); return; }
      if (this._selectedPoints.includes(pt)) {
        this.setStatus('Point already selected');
        return;
      }
      this._selectedPoints.push(pt);
      this._updatePanel();
      this.setStatus(`${this._selectedPoints.length} point(s) selected. Press Enter to pick direction line.`);
    } else if (this.step === 1) {
      const seg = this._findSegment(wx, wy);
      if (!seg) { this.setStatus('No segment found — click on a line for direction'); return; }
      this._directionSeg = seg;
      this.step = 2;
      this._updatePanel();
      this.setStatus('Set count and spacing in the panel, then click Apply.');
    }
  }

  onKeyDown(event) {
    if (this.step === 0 && (event.key === 'Enter' || event.key === 'Return')) {
      if (this._selectedPoints.length === 0) {
        this.setStatus('Select at least one point first');
        return;
      }
      this.step = 1;
      this._updatePanel();
      this.setStatus('Click a line segment for the pattern direction');
    }
  }

  onCancel() {
    if (this.step > 0) {
      if (this.step === 1) {
        this.step = 0;
        this._directionSeg = null;
        this._updatePanel();
        this.setStatus(`${this._selectedPoints.length} point(s) selected. Click more or press Enter.`);
        return;
      }
      if (this.step === 2) {
        this.step = 1;
        this._directionSeg = null;
        this._updatePanel();
        this.setStatus('Click a line segment for the pattern direction');
        return;
      }
    }
    this._selectedPoints = [];
    this._directionSeg = null;
    this.app.renderer.hoverEntity = null;
    this.app.renderer.previewEntities = [];
    super.onCancel();
  }

  _applyPattern() {
    if (this._selectedPoints.length === 0 || !this._directionSeg) {
      this.setStatus('Select points and a direction line first');
      return;
    }
    if (this._count < 1) {
      this.setStatus('Count must be at least 1');
      return;
    }

    takeSnapshot();
    const scene = state.scene;
    const seg = this._directionSeg;
    const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
    const len = Math.hypot(dx, dy) || 1e-9;
    const ux = dx / len, uy = dy / len;
    const sp = this._spacing;

    for (let i = 1; i <= this._count; i++) {
      const pairs = [];
      for (const srcPt of this._selectedPoints) {
        const nx = srcPt.x + ux * sp * i;
        const ny = srcPt.y + uy * sp * i;
        const dstPt = scene.addPoint(nx, ny);
        pairs.push({ src: srcPt, dst: dstPt });
      }
      scene.addConstraint(new LinearPattern(pairs, seg, i, sp));
    }

    // Pattern segments connecting selected source points
    const selectedSet = new Set(this._selectedPoints);
    const segsToPattern = [...scene.segments].filter(s =>
      selectedSet.has(s.p1) && selectedSet.has(s.p2) && s !== seg
    );

    // Build source→copy point maps for each copy index
    for (let i = 1; i <= this._count; i++) {
      const copyMap = new Map();
      for (const c of scene.constraints) {
        if (c.type === 'linear_pattern' && c.seg === seg && c.count === i) {
          for (const p of c.pairs) copyMap.set(p.src, p.dst);
        }
      }
      for (const s of segsToPattern) {
        const cp1 = copyMap.get(s.p1);
        const cp2 = copyMap.get(s.p2);
        if (cp1 && cp2) {
          const newSeg = scene.addSegment(cp1.x, cp1.y, cp2.x, cp2.y);
          if (s.construction) newSeg.construction = true;
        }
      }
    }

    state.emit('change');
    this._selectedPoints = [];
    this._directionSeg = null;
    this.step = 0;
    this._updatePanel();
    this.setStatus('Linear pattern applied. Select points for next pattern, or switch tool.');
  }

  // ---- Sidebar Panel ----

  _showPanel() {
    if (this._panel) return;
    const panel = document.createElement('div');
    panel.id = 'linear-pattern-panel';
    panel.className = 'pattern-tool-panel';
    const leftPanel = document.getElementById('left-panel');
    if (leftPanel) {
      // Insert before the variables section
      const varsSep = document.querySelector('.left-panel-vars-sep');
      if (varsSep) {
        leftPanel.insertBefore(panel, varsSep);
      } else {
        leftPanel.appendChild(panel);
      }
    }
    this._panel = panel;
  }

  _hidePanel() {
    if (this._panel && this._panel.parentNode) {
      this._panel.parentNode.removeChild(this._panel);
    }
    this._panel = null;
  }

  _updatePanel() {
    if (!this._panel) return;
    const ptCount = this._selectedPoints.length;
    const hasSeg = !!this._directionSeg;
    const ready = ptCount > 0 && hasSeg;

    this._panel.innerHTML = `
      <h3>Linear Pattern</h3>
      <div class="pattern-field">
        <label>Source points</label>
        <span class="pattern-value ${ptCount > 0 ? 'pattern-ok' : ''}">${ptCount} selected</span>
      </div>
      <div class="pattern-field">
        <label>Direction line</label>
        <span class="pattern-value ${hasSeg ? 'pattern-ok' : ''}">${hasSeg ? 'Segment #' + this._directionSeg.id : 'Not set'}</span>
      </div>
      <hr/>
      <div class="pattern-field">
        <label for="lp-count">Copies</label>
        <input id="lp-count" type="number" min="1" max="100" value="${this._count}" class="pattern-input" />
      </div>
      <div class="pattern-field">
        <label for="lp-spacing">Spacing</label>
        <input id="lp-spacing" type="number" step="0.1" value="${this._spacing}" class="pattern-input" />
      </div>
      <div class="pattern-actions">
        <button id="lp-apply" class="pattern-btn pattern-btn-primary" ${ready ? '' : 'disabled'}>Apply</button>
        <button id="lp-cancel" class="pattern-btn">Cancel</button>
      </div>
    `;

    // Bind events
    const countInput = this._panel.querySelector('#lp-count');
    const spacingInput = this._panel.querySelector('#lp-spacing');
    const applyBtn = this._panel.querySelector('#lp-apply');
    const cancelBtn = this._panel.querySelector('#lp-cancel');

    if (countInput) {
      countInput.addEventListener('change', (e) => {
        this._count = Math.max(1, parseInt(e.target.value) || 1);
      });
      countInput.addEventListener('keydown', (e) => e.stopPropagation());
    }
    if (spacingInput) {
      spacingInput.addEventListener('change', (e) => {
        this._spacing = parseFloat(e.target.value) || 0;
      });
      spacingInput.addEventListener('keydown', (e) => e.stopPropagation());
    }
    if (applyBtn) {
      applyBtn.addEventListener('click', () => this._applyPattern());
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.onCancel());
    }
  }
}

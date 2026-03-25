// js/tools/RadialPatternTool.js — Radial pattern around a center (arc/circle)
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { RadialPattern } from '../cad/Constraint.js';

const PT_PX = 12;
const SHAPE_PX = 16;

export class RadialPatternTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'radial_pattern';
    this._selectedPoints = [];
    this._centerPt = null;
    this._count = 4;
    this._totalAngle = 360;  // degrees (full circle by default)
    this._panel = null;
  }

  activate() {
    super.activate();
    this._selectedPoints = [];
    this._centerPt = null;
    this._count = 4;
    this._totalAngle = 360;
    this.step = 0;
    this._showPanel();
    this._updatePanel();
    this.setStatus('Select source points for the radial pattern');
  }

  deactivate() {
    this._selectedPoints = [];
    this._centerPt = null;
    this._hidePanel();
    this.app.renderer.hoverEntity = null;
    this.app.renderer.previewEntities = [];
    super.deactivate();
  }

  _findPoint(wx, wy) {
    const tol = PT_PX / this.app.viewport.zoom;
    return state.scene.findClosestPoint(wx, wy, tol);
  }

  _findArcOrCircle(wx, wy) {
    const tol = SHAPE_PX / this.app.viewport.zoom;
    const hit = state.scene.findClosestShape(wx, wy, tol);
    return (hit && (hit.type === 'arc' || hit.type === 'circle')) ? hit : null;
  }

  onMouseMove(wx, wy) {
    if (this.step === 0) {
      const pt = this._findPoint(wx, wy);
      this.app.renderer.hoverEntity = pt;
    } else if (this.step === 1) {
      // Highlight arc/circle or point for center selection
      const shape = this._findArcOrCircle(wx, wy);
      if (shape) {
        this.app.renderer.hoverEntity = shape;
      } else {
        const pt = this._findPoint(wx, wy);
        this.app.renderer.hoverEntity = pt;
      }
    }
  }

  onClick(wx, wy) {
    if (this.step === 0) {
      // Select source points
      const pt = this._findPoint(wx, wy);
      if (!pt) { this.setStatus('No point found — click closer to a point'); return; }
      if (this._selectedPoints.includes(pt)) {
        this.setStatus('Point already selected');
        return;
      }
      this._selectedPoints.push(pt);
      this._updatePanel();
      this.setStatus(`${this._selectedPoints.length} point(s) selected. Press Enter to pick center.`);
    } else if (this.step === 1) {
      // Select center: either an arc/circle (use its center) or a bare point
      const shape = this._findArcOrCircle(wx, wy);
      if (shape) {
        this._centerPt = shape.center;
        this.step = 2;
        this._updatePanel();
        this.setStatus('Set count and angle in the panel, then click Apply.');
        return;
      }
      const pt = this._findPoint(wx, wy);
      if (!pt) { this.setStatus('Click on a point, arc, or circle for the center'); return; }
      if (this._selectedPoints.includes(pt)) {
        this.setStatus('Center point should not be one of the source points');
        return;
      }
      this._centerPt = pt;
      this.step = 2;
      this._updatePanel();
      this.setStatus('Set count and angle in the panel, then click Apply.');
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
      this.setStatus('Click an arc, circle, or point for the rotation center');
    }
  }

  onCancel() {
    if (this.step > 0) {
      if (this.step === 1) {
        this.step = 0;
        this._centerPt = null;
        this._updatePanel();
        this.setStatus(`${this._selectedPoints.length} point(s) selected. Click more or press Enter.`);
        return;
      }
      if (this.step === 2) {
        this.step = 1;
        this._centerPt = null;
        this._updatePanel();
        this.setStatus('Click an arc, circle, or point for the rotation center');
        return;
      }
    }
    this._selectedPoints = [];
    this._centerPt = null;
    this.app.renderer.hoverEntity = null;
    this.app.renderer.previewEntities = [];
    super.onCancel();
  }

  _applyPattern() {
    if (this._selectedPoints.length === 0 || !this._centerPt) {
      this.setStatus('Select points and a center first');
      return;
    }
    if (this._count < 1) {
      this.setStatus('Count must be at least 1');
      return;
    }

    takeSnapshot();
    const scene = state.scene;
    const center = this._centerPt;
    const angleIncrement = (this._totalAngle / (this._count + 1)) * Math.PI / 180;

    for (let i = 1; i <= this._count; i++) {
      const totalAngle = angleIncrement * i;
      const cos = Math.cos(totalAngle), sin = Math.sin(totalAngle);
      const pairs = [];
      for (const srcPt of this._selectedPoints) {
        const dx = srcPt.x - center.x, dy = srcPt.y - center.y;
        const nx = center.x + dx * cos - dy * sin;
        const ny = center.y + dx * sin + dy * cos;
        const dstPt = scene.addPoint(nx, ny);
        pairs.push({ src: srcPt, dst: dstPt });
      }
      scene.addConstraint(new RadialPattern(pairs, center, i, angleIncrement));
    }

    // Pattern segments connecting selected source points
    const selectedSet = new Set(this._selectedPoints);
    const segsToPattern = [...scene.segments].filter(s =>
      selectedSet.has(s.p1) && selectedSet.has(s.p2)
    );

    for (let i = 1; i <= this._count; i++) {
      const copyMap = new Map();
      for (const c of scene.constraints) {
        if (c.type === 'radial_pattern' && c.center === center && c.count === i) {
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
    this._centerPt = null;
    this.step = 0;
    this._updatePanel();
    this.setStatus('Radial pattern applied. Select points for next pattern, or switch tool.');
  }

  // ---- Sidebar Panel ----

  _showPanel() {
    if (this._panel) return;
    const panel = document.createElement('div');
    panel.id = 'radial-pattern-panel';
    panel.className = 'pattern-tool-panel';
    const leftPanel = document.getElementById('left-panel');
    if (leftPanel) {
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
    const hasCenter = !!this._centerPt;
    const ready = ptCount > 0 && hasCenter;

    this._panel.innerHTML = `
      <h3>Radial Pattern</h3>
      <div class="pattern-field">
        <label>Source points</label>
        <span class="pattern-value ${ptCount > 0 ? 'pattern-ok' : ''}">${ptCount} selected</span>
      </div>
      <div class="pattern-field">
        <label>Center</label>
        <span class="pattern-value ${hasCenter ? 'pattern-ok' : ''}">${hasCenter ? 'Point #' + this._centerPt.id : 'Not set'}</span>
      </div>
      <hr/>
      <div class="pattern-field">
        <label for="rp-count">Copies</label>
        <input id="rp-count" type="number" min="1" max="100" value="${this._count}" class="pattern-input" />
      </div>
      <div class="pattern-field">
        <label for="rp-angle">Total angle (°)</label>
        <input id="rp-angle" type="number" step="1" value="${this._totalAngle}" class="pattern-input" />
      </div>
      <div class="pattern-actions">
        <button id="rp-apply" class="pattern-btn pattern-btn-primary" ${ready ? '' : 'disabled'}>Apply</button>
        <button id="rp-cancel" class="pattern-btn">Cancel</button>
      </div>
    `;

    // Bind events
    const countInput = this._panel.querySelector('#rp-count');
    const angleInput = this._panel.querySelector('#rp-angle');
    const applyBtn = this._panel.querySelector('#rp-apply');
    const cancelBtn = this._panel.querySelector('#rp-cancel');

    if (countInput) {
      countInput.addEventListener('change', (e) => {
        this._count = Math.max(1, parseInt(e.target.value) || 1);
      });
      countInput.addEventListener('keydown', (e) => e.stopPropagation());
    }
    if (angleInput) {
      angleInput.addEventListener('change', (e) => {
        this._totalAngle = parseFloat(e.target.value) || 360;
      });
      angleInput.addEventListener('keydown', (e) => e.stopPropagation());
    }
    if (applyBtn) {
      applyBtn.addEventListener('click', () => this._applyPattern());
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.onCancel());
    }
  }
}

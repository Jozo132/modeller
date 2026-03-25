// js/tools/MirrorTool.js — Mirror points across a reference line (segment)
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { Mirror } from '../cad/Constraint.js';

const PT_PX = 12;
const SEG_PX = 16;

export class MirrorTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'mirror';
    this._selectedPoints = [];
    this._mirrorSeg = null;
  }

  activate() {
    super.activate();
    this._selectedPoints = [];
    this._mirrorSeg = null;
    this.step = 0;
    this.setStatus('Select points to mirror (click points, then Enter to pick mirror line)');
  }

  deactivate() {
    this._selectedPoints = [];
    this._mirrorSeg = null;
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
    if (this.step === 0) {
      const pt = this._findPoint(wx, wy);
      this.app.renderer.hoverEntity = pt;
    } else {
      const seg = this._findSegment(wx, wy);
      this.app.renderer.hoverEntity = seg;
    }
  }

  onClick(wx, wy) {
    if (this.step === 0) {
      // Step 0: select source points
      const pt = this._findPoint(wx, wy);
      if (!pt) { this.setStatus('No point found — click closer to a point'); return; }
      if (this._selectedPoints.includes(pt)) {
        this.setStatus('Point already selected — pick a different one');
        return;
      }
      this._selectedPoints.push(pt);
      this.setStatus(`${this._selectedPoints.length} point(s) selected. Click more or press Enter to pick mirror line.`);
    } else {
      // Step 1: select mirror line
      const seg = this._findSegment(wx, wy);
      if (!seg) { this.setStatus('No segment found — click on a line to use as mirror axis'); return; }
      this._mirrorSeg = seg;
      this._applyMirror();
    }
  }

  onKeyDown(event) {
    if (this.step === 0 && (event.key === 'Enter' || event.key === 'Return')) {
      if (this._selectedPoints.length === 0) {
        this.setStatus('Select at least one point first');
        return;
      }
      this.step = 1;
      this.setStatus('Click a line segment to use as mirror axis');
    }
  }

  onCancel() {
    if (this.step === 1 && this._selectedPoints.length > 0) {
      this.step = 0;
      this._mirrorSeg = null;
      this.setStatus(`${this._selectedPoints.length} point(s) selected. Click more or press Enter to pick mirror line.`);
      return;
    }
    this._selectedPoints = [];
    this._mirrorSeg = null;
    this.app.renderer.hoverEntity = null;
    this.app.renderer.previewEntities = [];
    super.onCancel();
  }

  _applyMirror() {
    takeSnapshot();
    const scene = state.scene;
    const seg = this._mirrorSeg;
    const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
      this.setStatus('Mirror line has zero length');
      return;
    }

    // Build source→mirror point map
    const mirrorMap = new Map();
    for (const srcPt of this._selectedPoints) {
      const t = ((srcPt.x - seg.x1) * dx + (srcPt.y - seg.y1) * dy) / len2;
      const fx = seg.x1 + t * dx, fy = seg.y1 + t * dy;
      const mx = 2 * fx - srcPt.x, my = 2 * fy - srcPt.y;
      const dstPt = scene.addPoint(mx, my);
      mirrorMap.set(srcPt, dstPt);
      scene.addConstraint(new Mirror(srcPt, dstPt, seg));
    }

    // Mirror segments whose both endpoints are selected
    const selectedSet = new Set(this._selectedPoints);
    for (const s of [...scene.segments]) {
      if (s === seg) continue;
      if (selectedSet.has(s.p1) && selectedSet.has(s.p2)) {
        const mp1 = mirrorMap.get(s.p1);
        const mp2 = mirrorMap.get(s.p2);
        if (mp1 && mp2) {
          // Create segment directly referencing the mirrored points
          // addSegment with merge=true will find our existing mirror points
          const newSeg = scene.addSegment(mp1.x, mp1.y, mp2.x, mp2.y);
          if (s.construction) newSeg.construction = true;
        }
      }
    }

    state.emit('change');
    this._selectedPoints = [];
    this._mirrorSeg = null;
    this.step = 0;
    this.setStatus('Mirror applied. Select points for next mirror, or switch tool.');
  }
}

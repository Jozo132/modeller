// js/tools/CopyTool.js
import { BaseTool } from './BaseTool.js';
import { PSegment, PPoint, PCircle, PArc, TextPrimitive, DimensionPrimitive } from '../cad/index.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';

export class CopyTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'copy';
    this._baseX = 0; this._baseY = 0;
  }

  activate() {
    super.activate();
    if (state.selectedEntities.length === 0) {
      this.setStatus('Copy: Select entities first, then click base point');
    } else {
      this.setStatus('Copy: Click base point');
    }
  }

  onClick(wx, wy) {
    if (state.selectedEntities.length === 0) {
      this.setStatus('Copy: No entities selected');
      return;
    }
    if (this.step === 0) {
      this._baseX = wx; this._baseY = wy;
      this.step = 1;
      this.setStatus('Copy: Click destination point (Esc to finish)');
    } else {
      const dx = wx - this._baseX;
      const dy = wy - this._baseY;
      takeSnapshot();
      for (const e of this._effectiveSelection()) {
        this._copyPrimitive(e, dx, dy);
      }
      state.emit('change');
      this.setStatus('Copy: Click another destination (Esc to finish)');
    }
  }

  /** Create a new primitive offset by (dx, dy) and add to scene */
  _copyPrimitive(e, dx, dy) {
    const layer = e.layer;
    switch (e.type) {
      case 'segment':
        state.scene.addSegment(e.x1 + dx, e.y1 + dy, e.x2 + dx, e.y2 + dy,
          { merge: true, layer });
        break;
      case 'circle':
        state.scene.addCircle(e.cx + dx, e.cy + dy, e.radius,
          { merge: true, layer });
        break;
      case 'arc':
        state.scene.addArc(e.cx + dx, e.cy + dy, e.radius, e.startAngle, e.endAngle,
          { merge: true, layer });
        break;
      case 'text': {
        const tp = new TextPrimitive(e.x + dx, e.y + dy, e.text, e.height);
        tp.layer = layer;
        state.scene.texts.push(tp);
        break;
      }
      case 'dimension': {
        const dp = new DimensionPrimitive(e.x1 + dx, e.y1 + dy, e.x2 + dx, e.y2 + dy, e.offset);
        dp.layer = layer;
        state.scene.dimensions.push(dp);
        break;
      }
      case 'group': {
        const copied = [];
        for (const child of e.getChildren()) {
          switch (child.type) {
            case 'segment':
              copied.push(state.scene.addSegment(child.x1 + dx, child.y1 + dy, child.x2 + dx, child.y2 + dy, { merge: true, layer: child.layer }));
              break;
            case 'circle':
              copied.push(state.scene.addCircle(child.cx + dx, child.cy + dy, child.radius, { merge: true, layer: child.layer }));
              break;
            case 'arc':
              copied.push(state.scene.addArc(child.cx + dx, child.cy + dy, child.radius, child.startAngle, child.endAngle, { merge: true, layer: child.layer }));
              break;
            case 'spline':
              copied.push(state.scene.addSpline(child.points.map((point) => ({ x: point.x + dx, y: point.y + dy })), { merge: true, layer: child.layer }));
              break;
          }
        }
        state.scene.addGroup(copied, {
          name: e.name,
          immutable: e.immutable,
          sourceGroupId: e.sourceGroupId || e.id,
          layer,
        });
        break;
      }
    }
  }

  onMouseMove(wx, wy) {
    if (this.step === 1) {
      const dx = wx - this._baseX;
      const dy = wy - this._baseY;
      const previews = [];
      for (const e of this._effectiveSelection()) {
        const prev = this._makePreview(e, dx, dy);
        if (prev) previews.push(prev);
      }
      this.app.renderer.previewEntities = previews;
    }
  }

  _makePreview(e, dx, dy) {
    switch (e.type) {
      case 'segment':
        return new PSegment(
          new PPoint(e.x1 + dx, e.y1 + dy),
          new PPoint(e.x2 + dx, e.y2 + dy)
        );
      case 'circle':
        return new PCircle(new PPoint(e.cx + dx, e.cy + dy), e.radius);
      case 'arc':
        return new PArc(new PPoint(e.cx + dx, e.cy + dy), e.radius, e.startAngle, e.endAngle);
      case 'group':
        return null;
      default:
        return null;
    }
  }

  _effectiveSelection() {
    const result = [];
    const seen = new Set();
    const activeGroupId = this.app?._activeGroupEditId ?? null;
    for (const entity of state.selectedEntities) {
      if (!entity) continue;
      const parentGroup = activeGroupId == null && entity.type !== 'group'
        ? state.scene.groupForPrimitive(entity, null)
        : null;
      const target = parentGroup || entity;
      if (target.type !== 'group' && activeGroupId != null && !state.scene.isPrimitiveInGroup(target, activeGroupId)) continue;
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      result.push(target);
    }
    return result;
  }

  onCancel() {
    super.onCancel();
    this.setStatus('Copy: Click base point');
  }
}

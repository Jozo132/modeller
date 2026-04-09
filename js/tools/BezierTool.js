// js/tools/BezierTool.js — Multi-click bezier curve drawing tool with tangent handles
import { BaseTool } from './BaseTool.js';
import { PPoint, PBezier } from '../cad/index.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';

export class BezierTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'bezier';
    this._vertices = []; // {x, y, handleIn?, handleOut?}[]
    this._currentX = 0;
    this._currentY = 0;
    this._draggingHandle = false;
    this._dragStartX = 0;
    this._dragStartY = 0;
  }

  activate() {
    super.activate();
    this._vertices = [];
    this._draggingHandle = false;
    this.setStatus('Bezier: Click to place vertices, drag to set tangent handles (Enter/double-click to finish, Esc to cancel)');
  }

  onClick(wx, wy) {
    // If we were dragging a handle, the mouseUp already handled it
    if (this._draggingHandle) {
      this._draggingHandle = false;
      return;
    }
    this._addVertex(wx, wy);
  }

  onMouseDown(wx, wy) {
    this._dragStartX = wx;
    this._dragStartY = wy;
    this._draggingHandle = false;
  }

  onMouseUp(wx, wy) {
    if (this._draggingHandle) {
      this._draggingHandle = false;
      return;
    }
    const dx = wx - this._dragStartX;
    const dy = wy - this._dragStartY;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.5) {
      // User dragged — add vertex with tangent handle
      this._addVertex(this._dragStartX, this._dragStartY, dx, dy);
      this._draggingHandle = true; // prevent onClick from adding again
    }
  }

  _addVertex(wx, wy, handleDx, handleDy) {
    const vertex = { x: wx, y: wy, tangent: true };
    if (handleDx !== undefined) {
      vertex.handleOut = { dx: handleDx, dy: handleDy };
      vertex.handleIn = { dx: -handleDx, dy: -handleDy };
    }
    // Set handleIn for this new vertex from the previous vertex's handleOut (smooth continuation)
    this._vertices.push(vertex);
    this.step = this._vertices.length;
    if (this._vertices.length >= 2) {
      this.setStatus(`Bezier: ${this._vertices.length} vertices — click more, Enter/double-click to finish, Esc to cancel`);
    } else {
      this.setStatus('Bezier: Click next vertex (drag to set tangent)');
    }
  }

  onDoubleClick(wx, wy) {
    this._finish();
  }

  onMouseMove(wx, wy) {
    this._currentX = wx;
    this._currentY = wy;
    if (this._vertices.length > 0) {
      const previewVerts = [...this._vertices, { x: wx, y: wy, tangent: false }];
      if (previewVerts.length >= 2) {
        try {
          const pts = previewVerts.map(v => new PPoint(v.x, v.y));
          const vertices = previewVerts.map((v, i) => ({
            point: pts[i],
            handleIn: v.handleIn || null,
            handleOut: v.handleOut || null,
            tangent: v.tangent !== false,
          }));
          const preview = new PBezier(vertices);
          this.app.renderer.previewEntities = [preview];
        } catch (_) {
          this.app.renderer.previewEntities = [];
        }
      }
    }
  }

  onKeyDown(event) {
    if (event.key === 'Enter') {
      this._finish();
    }
  }

  onCancel() {
    this._vertices = [];
    this._draggingHandle = false;
    super.onCancel();
    this.setStatus('Bezier: Click to place vertices, drag to set tangent handles (Enter/double-click to finish, Esc to cancel)');
  }

  _finish() {
    if (this._vertices.length < 2) {
      this.setStatus('Bezier needs at least 2 vertices');
      return;
    }
    takeSnapshot();
    const bez = state.scene.addBezier(this._vertices,
      { merge: true, layer: state.activeLayer, construction: state.constructionMode });
    state.emit('entity:add', bez);
    state.emit('change');
    this._vertices = [];
    this._draggingHandle = false;
    this.step = 0;
    this.app.renderer.previewEntities = [];
    this.setStatus('Bezier: Click to place vertices, drag to set tangent handles (Enter/double-click to finish, Esc to cancel)');
  }
}

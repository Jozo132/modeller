// js/main.js — Application entry point
import { state } from './state.js';
import { Viewport } from './viewport.js';
import { Renderer } from './renderer.js';
import { getSnappedPosition } from './snap.js';
import { undo, redo, takeSnapshot } from './history.js';
import { downloadDXF } from './dxf/export.js';
import { openDXFFile } from './dxf/import.js';
import { debug, info, warn, error } from './logger.js';
import { loadProject, debouncedSave, clearSavedProject, setViewport } from './persist.js';
import { showConfirm, showPrompt, showDimensionInput } from './ui/popup.js';
import {
  Coincident, Horizontal, Vertical,
  Parallel, Perpendicular, EqualLength,
  Fixed, Distance, Tangent, Angle,
  resolveValue, setVariable, getVariable, removeVariable, getAllVariables,
} from './cad/Constraint.js';
import { union } from './cad/Operations.js';
import {
  SelectTool, LineTool, RectangleTool, CircleTool,
  ArcTool, PolylineTool, TextTool, DimensionTool,
  MoveTool, CopyTool,
  TrimTool, SplitTool, DisconnectTool, UnionTool,
  CoincidentTool, HorizontalTool, VerticalTool,
  ParallelTool, PerpendicularTool, DistanceConstraintTool,
  LockTool, EqualTool, TangentTool, AngleTool,
} from './tools/index.js';

class App {
  constructor() {
    info('App initialization started');
    this.canvas = document.getElementById('cad-canvas');
    this.viewport = new Viewport(this.canvas);
    this.renderer = new Renderer(this.viewport);
    this._pointerFramePending = false;
    this._lastPointer = null;
    this._moveEventCount = 0;
    this._renderScheduled = false;
    this._renderRequested = false;

    // Tools
    this.tools = {
      select:        new SelectTool(this),
      line:          new LineTool(this),
      rectangle:     new RectangleTool(this),
      circle:        new CircleTool(this),
      arc:           new ArcTool(this),
      polyline:      new PolylineTool(this),
      text:          new TextTool(this),
      dimension:     new DimensionTool(this),
      move:          new MoveTool(this),
      copy:          new CopyTool(this),
      trim:          new TrimTool(this),
      split:         new SplitTool(this),
      disconnect:    new DisconnectTool(this),
      union:         new UnionTool(this),
      coincident:    new CoincidentTool(this),
      horizontal:    new HorizontalTool(this),
      vertical:      new VerticalTool(this),
      parallel:      new ParallelTool(this),
      perpendicular: new PerpendicularTool(this),
      distance:      new DistanceConstraintTool(this),
      lock:          new LockTool(this),
      equal:         new EqualTool(this),
      tangent:       new TangentTool(this),
      angle:         new AngleTool(this),
    };
    this.activeTool = this.tools.select;
    this.activeTool.activate();

    // Left panel state
    this._lpHoverPrimId = null;    // primitive hovered from left panel
    this._lpHoverConstraintId = null; // constraint hovered from left panel
    this._lpSelectedConstraintId = null; // constraint selected in left panel

    // Bind events
    this._bindCanvasEvents();
    this._bindToolbarEvents();
    this._bindKeyboardEvents();
    this._bindResizeEvent();
    this._bindStateEvents();
    this._bindLeftPanelEvents();

    // Register viewport for persistence and restore saved project
    setViewport(this.viewport);
    const loaded = loadProject();
    if (loaded.ok) {
      this._rebuildLayersPanel();
      this._rebuildLeftPanel();
      if (!loaded.hasViewport && state.entities.length > 0) {
        this.viewport.fitEntities(state.entities);
      }
    }

    // Initial render
    this._scheduleRender();
    info('App initialization completed');
  }

  // --- Rendering ---
  _scheduleRender() {
    this._renderRequested = true;
    if (this._renderScheduled) return;

    this._renderScheduled = true;

    const runRender = () => {
      this._renderScheduled = false;
      if (!this._renderRequested) return;
      this._renderRequested = false;

      this._syncViewportSize();
      try {
        this.renderer.render();
      } catch (err) {
        error('Render loop failed', err);
      }
      if (this.activeTool.drawOverlay) {
        this.activeTool.drawOverlay(this.viewport.ctx, this.viewport);
      }

      if (this._renderRequested) {
        this._scheduleRender();
      }
    };

    requestAnimationFrame(runRender);
  }

  _syncViewportSize() {
    const compact = window.matchMedia('(max-width: 1000px)').matches;
    const mobile = window.matchMedia('(max-width: 780px)').matches;
    const panelWidth = mobile ? 0 : (compact ? 180 : 220);
    const bottomBars = 56;
    const topBar = 34;
    const panelBottomHeight = mobile ? Math.floor(window.innerHeight * 0.36) : 0;

    // Subtract both left and right panel widths from available canvas width
    const width = Math.max(1, window.innerWidth - panelWidth * 2);
    const height = Math.max(1, window.innerHeight - topBar - bottomBars - panelBottomHeight);

    if (width !== this.viewport.width || height !== this.viewport.height) {
      this.viewport.resize(width, height);
      debug('Viewport sync resize', { width: this.viewport.width, height: this.viewport.height });
    }
  }

  _schedulePointerProcessing() {
    if (this._pointerFramePending || !this._lastPointer) return;
    this._pointerFramePending = true;
    requestAnimationFrame(() => {
      this._pointerFramePending = false;
      if (!this._lastPointer) return;
      const { sx, sy, ctrlKey } = this._lastPointer;
      const t0 = performance.now();

      const basePoint = this.activeTool._startX !== undefined && this.activeTool.step > 0
        ? { x: this.activeTool._startX, y: this.activeTool._startY }
        : null;
      const { world, snap } = getSnappedPosition(
        sx,
        sy,
        this.viewport,
        basePoint,
        { ignoreGridSnap: !!ctrlKey }
      );

      this.renderer.cursorWorld = world;
      this.renderer.snapPoint = snap;

      // Show snapped position in status bar (falls back to raw world if no snap)
      const display = snap || world;
      document.getElementById('status-coords').textContent =
        `X: ${display.x.toFixed(2)}  Y: ${display.y.toFixed(2)}`;

      this.activeTool.onMouseMove(world.x, world.y, sx, sy);

      // Update left panel highlights when canvas hover changes
      this._updateLeftPanelHighlights();

      const dt = performance.now() - t0;
      if (dt > 12) {
        warn('Pointer processing frame is slow', { ms: dt.toFixed(2), tool: this.activeTool.name });
      }
      this._scheduleRender();
    });
  }

  // --- Tool switching ---

  /**
   * If the select tool is active and the current selection matches the
   * requirement for a constraint, apply it immediately and return true.
   * Otherwise return false so the caller can switch tools normally.
   */
  _tryApplyConstraintFromSelection(toolName) {
    if (this.activeTool.name !== 'select') return false;
    const sel = state.selectedEntities;
    if (sel.length === 0) return false;

    const segments = sel.filter(e => e.type === 'segment');
    const points   = sel.filter(e => e.type === 'point');
    const curves   = sel.filter(e => e.type === 'circle' || e.type === 'arc');

    let constraint = null;
    let applied = false;

    switch (toolName) {
      // --- Single-segment constraints ---
      case 'horizontal':
        if (segments.length >= 1) {
          takeSnapshot();
          for (const s of segments) state.scene.addConstraint(new Horizontal(s));
          applied = true;
        }
        break;
      case 'vertical':
        if (segments.length >= 1) {
          takeSnapshot();
          for (const s of segments) state.scene.addConstraint(new Vertical(s));
          applied = true;
        }
        break;

      // --- Two-segment constraints ---
      case 'parallel':
        if (segments.length === 2) {
          takeSnapshot();
          state.scene.addConstraint(new Parallel(segments[0], segments[1]));
          applied = true;
        }
        break;
      case 'perpendicular':
        if (segments.length === 2) {
          takeSnapshot();
          state.scene.addConstraint(new Perpendicular(segments[0], segments[1]));
          applied = true;
        }
        break;
      case 'equal':
        if (segments.length === 2) {
          takeSnapshot();
          state.scene.addConstraint(new EqualLength(segments[0], segments[1]));
          applied = true;
        }
        break;

      // --- Point constraints ---
      case 'lock':
        if (points.length >= 1) {
          takeSnapshot();
          for (const pt of points) {
            const existing = state.scene.constraints.find(c => c.type === 'fixed' && c.pt === pt);
            if (existing) {
              state.scene.removeConstraint(existing);
              pt.fixed = false;
            } else {
              state.scene.addConstraint(new Fixed(pt));
            }
          }
          applied = true;
        }
        break;
      case 'coincident':
        if (points.length === 2) {
          takeSnapshot();
          union(state.scene, points[0], points[1]);
          applied = true;
        }
        break;
      case 'distance':
        if (points.length === 2) {
          const ptA = points[0], ptB = points[1];
          const currentDist = Math.hypot(ptB.x - ptA.x, ptB.y - ptA.y);
          const existDist = state.scene.constraintsOn(ptA).some(c =>
            c.type === 'distance' && (c.ptA === ptB || c.ptB === ptB));
          const midScreenD = this.viewport.worldToScreen(
            (ptA.x + ptB.x) / 2, (ptA.y + ptB.y) / 2);
          showDimensionInput({
            dimType: 'distance',
            defaultValue: currentDist.toFixed(4),
            driven: existDist,
            hint: 'value or variable',
            screenPos: { x: midScreenD.x, y: midScreenD.y },
          }).then(result => {
            if (result !== null && result.value !== '' && !result.driven) {
              const d = parseFloat(result.value);
              const val = isNaN(d) ? result.value.trim() : d;
              if (typeof val === 'number' && val <= 0) return;
              takeSnapshot();
              state.scene.addConstraint(new Distance(ptA, ptB, val));
              state.emit('change');
              this._scheduleRender();
            }
          });
          return true; // handled (async)
        }
        break;

      // --- Tangent: 1 segment + 1 circle/arc ---
      case 'tangent':
        if (segments.length === 1 && curves.length === 1) {
          takeSnapshot();
          state.scene.addConstraint(new Tangent(segments[0], curves[0]));
          applied = true;
        }
        break;

      // --- Angle: 2 segments ---
      case 'angle':
        if (segments.length === 2) {
          const segA = segments[0], segB = segments[1];
          const dxA = segA.x2 - segA.x1, dyA = segA.y2 - segA.y1;
          const dxB = segB.x2 - segB.x1, dyB = segB.y2 - segB.y1;
          const aA = Math.atan2(dyA, dxA);
          const aB = Math.atan2(dyB, dxB);
          let diff = aB - aA;
          while (diff > Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          const currentDeg = (diff * 180 / Math.PI).toFixed(2);
          const existAngle = state.scene.constraintsOn(segA).some(c =>
            c.type === 'angle' && (c.segA === segB || c.segB === segB));
          const midScreenA = this.viewport.worldToScreen(
            (segA.midX + segB.midX) / 2, (segA.midY + segB.midY) / 2);
          showDimensionInput({
            dimType: 'angle',
            defaultValue: currentDeg,
            driven: existAngle,
            hint: 'degrees or variable',
            screenPos: { x: midScreenA.x, y: midScreenA.y },
          }).then(result => {
            if (result !== null && result.value !== '' && !result.driven) {
              const deg = parseFloat(result.value);
              if (!isNaN(deg)) {
                const rad = deg * Math.PI / 180;
                takeSnapshot();
                state.scene.addConstraint(new Angle(segA, segB, rad));
                state.emit('change');
                this._scheduleRender();
              } else if (result.value.trim()) {
                takeSnapshot();
                state.scene.addConstraint(new Angle(segA, segB, result.value.trim()));
                state.emit('change');
                this._scheduleRender();
              }
            }
          });
          return true; // handled (async)
        }
        break;
    }

    if (applied) {
      state.emit('change');
      this._scheduleRender();
      this.setStatus(`${toolName.charAt(0).toUpperCase() + toolName.slice(1)} applied from selection.`);
      return true;
    }
    return false;
  }

  setActiveTool(name) {
    if (this.activeTool) this.activeTool.deactivate();
    this.activeTool = this.tools[name] || this.tools.select;
    this.activeTool.activate();
    state.setTool(name);
    info('Tool changed', name);
    this._updateToolbarHighlight(name);
    this._scheduleRender();
  }

  _updateToolbarHighlight(name) {
    document.querySelectorAll('#toolbar button[data-tool]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === name);
    });
    const statusTool = document.getElementById('status-tool');
    statusTool.textContent = `Tool: ${name.charAt(0).toUpperCase() + name.slice(1)}`;
  }

  // --- Status ---
  setStatus(msg) {
    document.getElementById('status-message').textContent = msg;
  }

  // --- Canvas events ---
  _bindCanvasEvents() {
    const canvas = this.canvas;
    let movedSinceDown = false;
    let mouseDown = false;

    // Mouse down
    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      movedSinceDown = false;
      mouseDown = true;

      // Middle button = pan
      if (e.button === 1) {
        e.preventDefault();
        this.viewport.startPan(sx, sy);
        return;
      }

      const basePoint = this.activeTool._startX !== undefined
        ? { x: this.activeTool._startX, y: this.activeTool._startY }
        : null;
      const { world } = getSnappedPosition(
        sx,
        sy,
        this.viewport,
        this.activeTool.step > 0 ? basePoint : null,
        { ignoreGridSnap: !!e.ctrlKey }
      );

      if (e.button === 0) {
        if (this.activeTool.onMouseDown) {
          this.activeTool.onMouseDown(world.x, world.y, sx, sy, e);
        }
      }
    });

    // Mouse move
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (mouseDown) movedSinceDown = true;

      // Pan
      if (this.viewport.isPanning) {
        this.viewport.updatePan(sx, sy);
        this._scheduleRender();
        return;
      }

      this._lastPointer = { sx, sy, ctrlKey: e.ctrlKey };
      this._schedulePointerProcessing();

      this._moveEventCount += 1;
      if (this._moveEventCount % 200 === 0) {
        debug('Pointer move activity', { count: this._moveEventCount, tool: this.activeTool.name });
      }
    });

    // Mouse up
    canvas.addEventListener('mouseup', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      mouseDown = false;

      if (e.button === 1) {
        this.viewport.endPan();
        debouncedSave();
        return;
      }

      const world = this.viewport.screenToWorld(sx, sy);

      if (this.activeTool.onMouseUp) {
        this.activeTool.onMouseUp(world.x, world.y, e);
      }

      this._scheduleRender();
    });

    // Click
    canvas.addEventListener('click', (e) => {
      if (this.viewport.isPanning) return;
      if (movedSinceDown && this.activeTool.name === 'select') {
        movedSinceDown = false;
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const basePoint = this.activeTool._startX !== undefined && this.activeTool.step > 0
        ? { x: this.activeTool._startX, y: this.activeTool._startY }
        : null;
      const { world } = getSnappedPosition(
        sx,
        sy,
        this.viewport,
        basePoint,
        { ignoreGridSnap: !!e.ctrlKey }
      );

      // Only fire onClick if not coming from a drag (select tool)
      if (this.activeTool.name === 'select' && this.activeTool._isDragging) return;

      this.activeTool.onClick(world.x, world.y, e);
      movedSinceDown = false;
      this._scheduleRender();
    });

    // Wheel zoom
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      this.viewport.zoomAt(sx, sy, factor);
      debug('Wheel zoom', { factor, zoom: this.viewport.zoom.toFixed(4) });
      debouncedSave();
      this._scheduleRender();
    }, { passive: false });

    // Context menu
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.activeTool.onCancel();
      this._scheduleRender();
    });

    // Double-click on canvas to edit dimensions inline
    canvas.addEventListener('dblclick', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = this.viewport.screenToWorld(sx, sy);
      const tol = 12 / this.viewport.zoom;

      // Find the closest dimension near the double-click position
      let closestDim = null;
      let closestDist = Infinity;
      for (const dim of state.scene.dimensions) {
        if (!dim.visible) continue;
        const d = dim.distanceTo(world.x, world.y);
        if (d < tol && d < closestDist) {
          closestDist = d;
          closestDim = dim;
        }
      }

      if (closestDim) {
        e.preventDefault();
        e.stopPropagation();
        this._editDimensionConstraint(closestDim, { x: sx, y: sy });
      }
    });

    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches[0];
      const sx = touch.clientX - rect.left;
      const sy = touch.clientY - rect.top;
      const basePoint = this.activeTool._startX !== undefined && this.activeTool.step > 0
        ? { x: this.activeTool._startX, y: this.activeTool._startY }
        : null;
      const { world } = getSnappedPosition(sx, sy, this.viewport, basePoint);
      this.activeTool.onClick(world.x, world.y, e);
      this._scheduleRender();
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches[0];
      const sx = touch.clientX - rect.left;
      const sy = touch.clientY - rect.top;
      const basePoint = this.activeTool._startX !== undefined && this.activeTool.step > 0
        ? { x: this.activeTool._startX, y: this.activeTool._startY }
        : null;
      const { world, snap } = getSnappedPosition(sx, sy, this.viewport, basePoint);
      this.renderer.cursorWorld = world;
      this.renderer.snapPoint = snap;
      this.activeTool.onMouseMove(world.x, world.y, sx, sy);
      this._scheduleRender();
    }, { passive: false });
  }

  // --- Toolbar ---
  _bindToolbarEvents() {
    // Draw tools — intercept constraint buttons to apply from selection
    document.querySelectorAll('#toolbar button[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        if (this._tryApplyConstraintFromSelection(tool)) return;
        this.setActiveTool(tool);
      });
    });

    // File
    document.getElementById('btn-new').addEventListener('click', async () => {
      const ok = await showConfirm({
        title: 'New Drawing',
        message: 'Clear all? Unsaved changes will be lost.',
        okText: 'Clear',
        cancelText: 'Cancel',
      });
      if (ok) {
        state.clearAll();
        clearSavedProject();
        this._scheduleRender();
      }
    });
    document.getElementById('btn-save').addEventListener('click', () => downloadDXF());
    document.getElementById('btn-open').addEventListener('click', () => {
      info('Opening DXF file');
      openDXFFile();
      setTimeout(() => {
        this.viewport.fitEntities(state.entities);
        this._scheduleRender();
      }, 500);
    });

    // Edit
    document.getElementById('btn-delete').addEventListener('click', () => {
      if (state.selectedEntities.length > 0) {
        takeSnapshot();
        for (const e of [...state.selectedEntities]) {
          state.removeEntity(e);
        }
        state.clearSelection();
        this._scheduleRender();
      }
    });
    document.getElementById('btn-undo').addEventListener('click', () => { undo(); this._scheduleRender(); });
    document.getElementById('btn-redo').addEventListener('click', () => { redo(); this._scheduleRender(); });

    // View
    document.getElementById('btn-zoom-fit').addEventListener('click', () => {
      this.viewport.fitEntities(state.entities);
      this._scheduleRender();
    });
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      this.viewport.zoomAt(this.viewport.width / 2, this.viewport.height / 2, 1.3);
      this._scheduleRender();
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      this.viewport.zoomAt(this.viewport.width / 2, this.viewport.height / 2, 0.7);
      this._scheduleRender();
    });
    document.getElementById('btn-grid-toggle').addEventListener('click', () => {
      state.gridVisible = !state.gridVisible;
      this._scheduleRender();
    });

    // Snap
    document.getElementById('btn-snap-toggle').addEventListener('click', (e) => {
      state.snapEnabled = !state.snapEnabled;
      e.target.classList.toggle('active', state.snapEnabled);
      document.getElementById('status-snap').classList.toggle('active', state.snapEnabled);
    });
    document.getElementById('btn-ortho-toggle').addEventListener('click', (e) => {
      state.orthoEnabled = !state.orthoEnabled;
      e.target.classList.toggle('active', state.orthoEnabled);
      document.getElementById('status-ortho').classList.toggle('active', state.orthoEnabled);
    });

    // Layer add
    document.getElementById('btn-add-layer').addEventListener('click', async () => {
      const name = await showPrompt({
        title: 'Add Layer',
        message: 'Layer name:',
        defaultValue: '',
      });
      if (name && name.trim()) {
        state.addLayer(name.trim());
        this._rebuildLayersPanel();
      }
    });

    // Initialize status indicators
    document.getElementById('status-snap').classList.toggle('active', state.snapEnabled);
    document.getElementById('status-ortho').classList.toggle('active', state.orthoEnabled);
  }

  // --- Keyboard ---
  _bindKeyboardEvents() {
    const cmdInput = document.getElementById('cmd-input');

    document.addEventListener('keydown', (e) => {
      // Don't intercept when typing in input fields, textareas, or contenteditable
      const tag = document.activeElement?.tagName?.toLowerCase();
      const isEditable = tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable;
      if (isEditable) {
        // Special handling for command input
        if (document.activeElement === cmdInput && e.key === 'Enter') {
          this._handleCommand(cmdInput.value.trim());
          cmdInput.value = '';
        }
        return;
      }

      // Forward to tool first
      this.activeTool.onKeyDown(e);

      // Shortcuts
      if (e.ctrlKey) {
        switch (e.key.toLowerCase()) {
          case 'z': e.preventDefault(); undo(); this._scheduleRender(); break;
          case 'y': e.preventDefault(); redo(); this._scheduleRender(); break;
          case 's': e.preventDefault(); downloadDXF(); break;
          case 'n':
            e.preventDefault();
            showConfirm({ title: 'New Drawing', message: 'Clear all?', okText: 'Clear', cancelText: 'Cancel' })
              .then((ok) => {
                if (ok) {
                  state.clearAll();
                  this._scheduleRender();
                }
              });
            break;
          case 'd': e.preventDefault(); this.setActiveTool('copy'); break;
          case 'a':
            e.preventDefault();
            state.entities.forEach(ent => state.select(ent));
            this._scheduleRender();
            break;
        }
        return;
      }

      switch (e.key) {
        case 'Escape':
          this.activeTool.onCancel();
          if (this.activeTool.name !== 'select') this.setActiveTool('select');
          state.clearSelection();
          this._scheduleRender();
          break;
        case 'Delete':
        case 'Backspace':
          if (state.selectedEntities.length > 0) {
            takeSnapshot();
            for (const ent of [...state.selectedEntities]) state.removeEntity(ent);
            state.clearSelection();
            this._scheduleRender();
          }
          break;
        case 'l': case 'L': this.setActiveTool('line'); break;
        case 'r': case 'R': this.setActiveTool('rectangle'); break;
        case 'c': case 'C': this.setActiveTool('circle'); break;
        case 'a': case 'A': this.setActiveTool('arc'); break;
        case 'p': case 'P': this.setActiveTool('polyline'); break;
        case 't': case 'T': this.setActiveTool('text'); break;
        case 'd': case 'D': this.setActiveTool('dimension'); break;
        case 'm': case 'M': this.setActiveTool('move'); break;
        case 'x': case 'X': this.setActiveTool('trim'); break;
        case 'k': case 'K': this.setActiveTool('split'); break;
        case 'f': case 'F':
          this.viewport.fitEntities(state.entities);
          this._scheduleRender();
          break;
        case 'g': case 'G':
          state.gridVisible = !state.gridVisible;
          this._scheduleRender();
          break;
        case 's': case 'S':
          state.snapEnabled = !state.snapEnabled;
          document.getElementById('btn-snap-toggle').classList.toggle('active', state.snapEnabled);
          document.getElementById('status-snap').classList.toggle('active', state.snapEnabled);
          break;
        case 'o': case 'O':
          state.orthoEnabled = !state.orthoEnabled;
          document.getElementById('btn-ortho-toggle').classList.toggle('active', state.orthoEnabled);
          document.getElementById('status-ortho').classList.toggle('active', state.orthoEnabled);
          break;
      }
    });
  }

  // --- Command line ---
  _handleCommand(cmd) {
    if (!cmd) return;
    const parts = cmd.toLowerCase().split(/\s+/);
    const command = parts[0];

    switch (command) {
      case 'line': case 'l': this.setActiveTool('line'); break;
      case 'rect': case 'rectangle': case 'r': this.setActiveTool('rectangle'); break;
      case 'circle': case 'c': this.setActiveTool('circle'); break;
      case 'arc': case 'a': this.setActiveTool('arc'); break;
      case 'polyline': case 'pl': case 'p': this.setActiveTool('polyline'); break;
      case 'text': case 't': this.setActiveTool('text'); break;
      case 'dim': case 'dimension': case 'd': this.setActiveTool('dimension'); break;
      case 'move': case 'm': this.setActiveTool('move'); break;
      case 'copy': case 'co': this.setActiveTool('copy'); break;
      case 'select': case 'sel': this.setActiveTool('select'); break;
      case 'trim': case 'x': this.setActiveTool('trim'); break;
      case 'split': case 'k': this.setActiveTool('split'); break;
      case 'coincident': this.setActiveTool('coincident'); break;
      case 'horizontal': case 'hor': this.setActiveTool('horizontal'); break;
      case 'vertical': case 'ver': this.setActiveTool('vertical'); break;
      case 'parallel': case 'par': this.setActiveTool('parallel'); break;
      case 'perpendicular': case 'perp': this.setActiveTool('perpendicular'); break;
      case 'distance': case 'dist': this.setActiveTool('distance'); break;
      case 'lock': case 'fix': this.setActiveTool('lock'); break;
      case 'equal': case 'eq': this.setActiveTool('equal'); break;
      case 'tangent': case 'tan': this.setActiveTool('tangent'); break;
      case 'disconnect': case 'disc': this.setActiveTool('disconnect'); break;
      case 'union': case 'join': this.setActiveTool('union'); break;
      case 'undo': case 'u': undo(); this._scheduleRender(); break;
      case 'redo': redo(); this._scheduleRender(); break;
      case 'delete': case 'del': case 'erase':
        if (state.selectedEntities.length > 0) {
          takeSnapshot();
          for (const e of [...state.selectedEntities]) state.removeEntity(e);
          state.clearSelection();
          this._scheduleRender();
        }
        break;
      case 'fit': case 'zoom':
        this.viewport.fitEntities(state.entities);
        this._scheduleRender();
        break;
      case 'grid':
        if (parts[1]) {
          const size = parseFloat(parts[1]);
          if (size > 0) state.gridSize = size;
        } else {
          state.gridVisible = !state.gridVisible;
        }
        this._scheduleRender();
        break;
      case 'save': downloadDXF(); break;
      case 'open': openDXFFile(); break;
      case 'new':
        showConfirm({ title: 'New Drawing', message: 'Clear all?', okText: 'Clear', cancelText: 'Cancel' })
          .then((ok) => {
            if (ok) {
              state.clearAll();
              this._scheduleRender();
            }
          });
        break;
      default:
        this.setStatus(`Unknown command: ${command}`);
    }
  }

  // --- Resize ---
  _bindResizeEvent() {
    const onResize = () => {
      this.viewport.resize();
      debug('Canvas resized', { width: this.viewport.width, height: this.viewport.height });
      this._scheduleRender();
    };

    window.addEventListener('resize', onResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onResize);
    }

    onResize();
  }

  // --- State events ---
  _bindStateEvents() {
    state.on('change', () => {
      this._scheduleRender();
      this._rebuildLeftPanel();
      debouncedSave();
    });
    state.on('selection:change', (sel) => {
      this._updatePropertiesPanel(sel);
      this._rebuildLeftPanel();
    });
    state.on('layers:change', () => {
      this._rebuildLayersPanel();
      debouncedSave();
    });
    state.on('file:loaded', () => {
      this.viewport.fitEntities(state.entities);
      this._rebuildLayersPanel();
      this._rebuildLeftPanel();
      this._scheduleRender();
    });
  }

  // --- Properties panel ---
  _updatePropertiesPanel(selection) {
    const panel = document.getElementById('properties-content');
    if (!selection || selection.length === 0) {
      panel.innerHTML = '<p class="hint">Select an entity to view properties</p>';
      return;
    }
    if (selection.length === 1) {
      const e = selection[0];
      const typeName = e.type.charAt(0).toUpperCase() + e.type.slice(1);
      let html = `<div class="prop-row"><label>Type</label><span>${typeName}</span></div>`;
      html += `<div class="prop-row"><label>Layer</label><span>${e.layer}</span></div>`;
      html += `<div class="prop-row"><label>ID</label><span>${e.id}</span></div>`;

      if (e.type === 'point') {
        html += `<div class="prop-row"><label>X</label><span>${e.x.toFixed(4)}</span></div>`;
        html += `<div class="prop-row"><label>Y</label><span>${e.y.toFixed(4)}</span></div>`;
        html += `<div class="prop-row"><label>Fixed</label><span>${e.fixed ? 'Yes' : 'No'}</span></div>`;
        const shapes = state.scene.shapesUsingPoint(e);
        html += `<div class="prop-row"><label>Shared by</label><span>${shapes.length} shape${shapes.length !== 1 ? 's' : ''}</span></div>`;
      } else if (e.type === 'segment') {
        html += `<div class="prop-row"><label>X1</label><span>${e.x1.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Y1</label><span>${e.y1.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>X2</label><span>${e.x2.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Y2</label><span>${e.y2.toFixed(2)}</span></div>`;
        const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
        html += `<div class="prop-row"><label>Length</label><span>${len.toFixed(2)}</span></div>`;
      } else if (e.type === 'circle') {
        html += `<div class="prop-row"><label>Center X</label><span>${e.cx.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Center Y</label><span>${e.cy.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Radius</label><span>${e.radius.toFixed(2)}</span></div>`;
      } else if (e.type === 'arc') {
        html += `<div class="prop-row"><label>Center X</label><span>${e.cx.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Center Y</label><span>${e.cy.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Radius</label><span>${e.radius.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Start°</label><span>${(e.startAngle * 180 / Math.PI).toFixed(1)}</span></div>`;
        html += `<div class="prop-row"><label>End°</label><span>${(e.endAngle * 180 / Math.PI).toFixed(1)}</span></div>`;
      } else if (e.type === 'text') {
        html += `<div class="prop-row"><label>X</label><span>${e.x.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Y</label><span>${e.y.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Text</label><span>${e.text}</span></div>`;
        html += `<div class="prop-row"><label>Height</label><span>${e.height}</span></div>`;
      } else if (e.type === 'dimension') {
        html += `<div class="prop-row"><label>Dim Type</label><span>${e.dimType}</span></div>`;
        html += `<div class="prop-row"><label>Value</label><span>${e.displayLabel}</span></div>`;
        html += `<div class="prop-row"><label>Constraint</label><span>${e.isConstraint ? 'Yes' : 'No'}</span></div>`;
        html += `<div class="prop-row"><label>Display</label><span>${e.displayMode}</span></div>`;
        if (e.variableName) html += `<div class="prop-row"><label>Variable</label><span>${e.variableName}</span></div>`;
        if (e.formula != null) html += `<div class="prop-row"><label>Formula</label><span>${e.formula}</span></div>`;
      }

      // Show constraints on this entity
      const constraints = state.scene.constraintsOn(e);
      if (constraints.length > 0) {
        html += '<hr/><div class="prop-row"><label>Constraints</label><span>' + constraints.length + '</span></div>';
        for (const c of constraints) {
          html += `<div class="prop-row"><label></label><span style="font-size:11px;color:var(--text-secondary)">${c.type} #${c.id}</span></div>`;
        }
      }

      panel.innerHTML = html;
    } else {
      panel.innerHTML = `<p class="hint">${selection.length} entities selected</p>`;
    }
    this._scheduleRender();
  }

  // --- Left panel (Primitives & Constraints) ---
  _bindLeftPanelEvents() {
    // Handle DELETE key on selected constraint
    document.getElementById('left-panel').addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this._lpSelectedConstraintId != null) {
        const c = state.scene.constraints.find(c => c.id === this._lpSelectedConstraintId);
        if (c) {
          takeSnapshot();
          state.scene.removeConstraint(c);
          this._lpSelectedConstraintId = null;
          state.emit('change');
          this._scheduleRender();
        }
        e.preventDefault();
      }
    });

    // Add variable button
    document.getElementById('btn-add-variable').addEventListener('click', async () => {
      const val = await showPrompt({
        title: 'Add Variable',
        message: 'Enter variable as name=value (e.g. width=50):',
        defaultValue: '',
      });
      if (val !== null && val !== '') {
        const eqIdx = val.indexOf('=');
        if (eqIdx > 0) {
          const name = val.substring(0, eqIdx).trim();
          const num = parseFloat(val.substring(eqIdx + 1).trim());
          if (name && !isNaN(num)) {
            takeSnapshot();
            setVariable(name, num);
            state.scene.solve();
            state.emit('change');
            this._scheduleRender();
          }
        }
      }
    });
  }

  _rebuildLeftPanel() {
    this._rebuildPrimitivesList();
    this._rebuildConstraintsList();
    this._rebuildVariablesList();
  }

  /** Get a short icon string for a primitive type */
  _primIcon(type) {
    const icons = { segment: '╱', circle: '○', arc: '◠', point: '·', text: 'T', dimension: '↔' };
    return icons[type] || '?';
  }

  /** Get a short icon string for a constraint type */
  _constraintIcon(type) {
    const icons = {
      coincident: '⊙', distance: '↔', fixed: '⊕',
      horizontal: 'H', vertical: 'V',
      parallel: '∥', perpendicular: '⊥', angle: '∠',
      equal_length: '=', length: 'L',
      radius: 'R', tangent: 'T',
      on_line: '—·', on_circle: '○·', midpoint: 'M',
      dimension: '📐',
    };
    return icons[type] || type;
  }

  /** Describe a constraint in a compact way */
  _constraintLabel(c) {
    if (c.type === 'dimension') {
      // Dimension constraint: show dim type and formula/value
      const dimT = c.dimType || 'distance';
      let details = '';
      if (c.formula != null) {
        if (c.dimType === 'angle') {
          const numVal = typeof c.formula === 'number' ? (c.formula * 180 / Math.PI).toFixed(2) + '°' : String(c.formula);
          details = ` (${numVal})`;
        } else if (typeof c.formula === 'number') {
          details = ` (${c.formula.toFixed(2)})`;
        } else {
          details = ` (${c.formula})`;
        }
      }
      if (c.min != null || c.max != null) {
        const lo = c.min != null ? c.min.toFixed(1) : '–∞';
        const hi = c.max != null ? c.max.toFixed(1) : '∞';
        details += ` [${lo}..${hi}]`;
      }
      return `dim ${dimT} #${c.id}${details}`;
    }
    const t = c.type.replace(/_/g, ' ');
    let details = '';
    if (c.value !== undefined) {
      if (c.type === 'angle') {
        // Show angle in degrees
        if (typeof c.value === 'number') {
          details = ` (${(c.value * 180 / Math.PI).toFixed(2)}°)`;
        } else {
          details = ` (${c.value})`;
        }
      } else if (typeof c.value === 'number') {
        details = ` (${c.value.toFixed(2)})`;
      } else {
        details = ` (${c.value})`;
      }
    }
    if (c.fx !== undefined) details = ` (${c.fx.toFixed(1)}, ${c.fy.toFixed(1)})`;
    // Show range if set
    if (c.min != null || c.max != null) {
      const lo = c.min != null ? c.min.toFixed(1) : '–∞';
      const hi = c.max != null ? c.max.toFixed(1) : '∞';
      details += ` [${lo}..${hi}]`;
    }
    return `${t} #${c.id}${details}`;
  }

  /** Get all primitive IDs involved in a constraint */
  _constraintPrimIds(c) {
    const ids = new Set();
    if (c.type === 'dimension') {
      // Use source IDs and involved points
      if (c.sourceAId != null) ids.add(c.sourceAId);
      if (c.sourceBId != null) ids.add(c.sourceBId);
      for (const pt of c.involvedPoints()) ids.add(pt.id);
      return ids;
    }
    if (c.ptA) ids.add(c.ptA.id);
    if (c.ptB) ids.add(c.ptB.id);
    if (c.pt) ids.add(c.pt.id);
    if (c.seg) { ids.add(c.seg.id); ids.add(c.seg.p1.id); ids.add(c.seg.p2.id); }
    if (c.segA) { ids.add(c.segA.id); ids.add(c.segA.p1.id); ids.add(c.segA.p2.id); }
    if (c.segB) { ids.add(c.segB.id); ids.add(c.segB.p1.id); ids.add(c.segB.p2.id); }
    if (c.circle) { ids.add(c.circle.id); if (c.circle.center) ids.add(c.circle.center.id); }
    if (c.shape) { ids.add(c.shape.id); if (c.shape.center) ids.add(c.shape.center.id); }
    return ids;
  }

  /** Get all shape primitives (non-point) involved in a constraint */
  _constraintShapes(c) {
    const shapes = [];
    if (c.type === 'dimension') {
      if (c.sourceA && c.sourceA.type !== 'point') shapes.push(c.sourceA);
      if (c.sourceB && c.sourceB.type !== 'point') shapes.push(c.sourceB);
      return shapes;
    }
    if (c.seg) shapes.push(c.seg);
    if (c.segA) shapes.push(c.segA);
    if (c.segB) shapes.push(c.segB);
    if (c.circle) shapes.push(c.circle);
    if (c.shape) shapes.push(c.shape);
    return shapes;
  }

  _rebuildPrimitivesList() {
    const list = document.getElementById('primitives-list');
    list.innerHTML = '';
    const scene = state.scene;
    const allShapes = [...scene.shapes()];

    if (allShapes.length === 0) {
      list.innerHTML = '<p class="hint">No primitives</p>';
      return;
    }

    for (const prim of allShapes) {
      const row = document.createElement('div');
      row.className = 'lp-item';
      row.dataset.primId = prim.id;
      row.dataset.primType = prim.type;

      // Mark as selected if the primitive is selected in the scene
      if (prim.selected) row.classList.add('selected');

      // Mark as highlighted if this primitive is being hovered on the canvas
      const hoverEnt = this.renderer.hoverEntity;
      if (hoverEnt && hoverEnt.id === prim.id) row.classList.add('highlight');

      // Mark as highlighted if a constraint in the left panel references this primitive
      if (this._lpHoverConstraintId != null) {
        const hc = scene.constraints.find(c => c.id === this._lpHoverConstraintId);
        if (hc && this._constraintPrimIds(hc).has(prim.id)) {
          row.classList.add('highlight');
        }
      }

      const typeName = prim.type.charAt(0).toUpperCase() + prim.type.slice(1);
      let desc = `${typeName} #${prim.id}`;
      if (prim.type === 'text') desc = `Text #${prim.id} "${prim.text}"`;

      row.innerHTML = `<span class="lp-icon">${this._primIcon(prim.type)}</span><span class="lp-label">${desc}</span>`;

      // Mouse events for cross-highlighting
      row.addEventListener('mouseenter', () => {
        this._lpHoverPrimId = prim.id;
        this.renderer.hoverEntity = prim;
        this._scheduleRender();
        this._updateLeftPanelHighlights();
      });
      row.addEventListener('mouseleave', () => {
        this._lpHoverPrimId = null;
        if (this.renderer.hoverEntity === prim) this.renderer.hoverEntity = null;
        this._scheduleRender();
        this._updateLeftPanelHighlights();
      });

      // Click to select/deselect and filter constraints
      row.addEventListener('click', (e) => {
        if (!e.shiftKey) state.clearSelection();
        if (prim.selected && e.shiftKey) {
          state.deselect(prim);
        } else {
          state.select(prim);
        }
        this._scheduleRender();
      });

      list.appendChild(row);
    }
  }

  _rebuildConstraintsList() {
    const list = document.getElementById('constraints-list');
    const badge = document.getElementById('constraints-filter-badge');
    list.innerHTML = '';
    const scene = state.scene;

    // Filter constraints by selected primitives
    const sel = state.selectedEntities;
    let constraints = scene.constraints;
    let filtered = false;

    if (sel.length > 0) {
      const selIds = new Set(sel.map(e => e.id));
      // Also include IDs of points belonging to selected shapes
      for (const e of sel) {
        if (e.type === 'segment') { selIds.add(e.p1.id); selIds.add(e.p2.id); }
        if (e.type === 'circle' || e.type === 'arc') { selIds.add(e.center.id); }
      }
      constraints = constraints.filter(c => {
        const cIds = this._constraintPrimIds(c);
        for (const id of cIds) {
          if (selIds.has(id)) return true;
        }
        return false;
      });
      filtered = true;
    }

    badge.style.display = filtered ? 'inline' : 'none';
    badge.onclick = () => {
      state.clearSelection();
      this._scheduleRender();
    };

    if (constraints.length === 0) {
      list.innerHTML = `<p class="hint">${filtered ? 'No related constraints' : 'No constraints'}</p>`;
      return;
    }

    for (const c of constraints) {
      const row = document.createElement('div');
      row.className = 'lp-item';
      row.dataset.constraintId = c.id;
      row.tabIndex = 0; // make focusable for keyboard delete

      if (this._lpSelectedConstraintId === c.id) row.classList.add('selected');

      // Highlight if canvas is hovering a primitive that this constraint references
      const hoverEnt = this.renderer.hoverEntity;
      if (hoverEnt) {
        const cIds = this._constraintPrimIds(c);
        if (cIds.has(hoverEnt.id)) row.classList.add('highlight');
      }

      // Highlight if a primitive in the left panel is hovered and this constraint references it
      if (this._lpHoverPrimId != null) {
        const cIds = this._constraintPrimIds(c);
        if (cIds.has(this._lpHoverPrimId)) row.classList.add('highlight');
      }

      const satisfied = c.error() < 1e-4;
      const iconColor = satisfied ? 'color:rgba(0,230,118,0.9)' : 'color:rgba(255,100,60,0.9)';

      const editBtn = c.editable ? `<button class="lp-edit" title="Edit constraint value">✎</button>` : '';
      row.innerHTML = `<span class="lp-icon" style="${iconColor}">${this._constraintIcon(c.type)}</span>` +
        `<span class="lp-label">${this._constraintLabel(c)}</span>` +
        editBtn +
        `<button class="lp-delete" title="Delete constraint">✕</button>`;

      // Mouse events for cross-highlighting
      row.addEventListener('mouseenter', () => {
        this._lpHoverConstraintId = c.id;
        // Highlight the first shape involved in the constraint on the canvas
        const shapes = this._constraintShapes(c);
        if (shapes.length > 0) this.renderer.hoverEntity = shapes[0];
        this._scheduleRender();
        this._updateLeftPanelHighlights();
      });
      row.addEventListener('mouseleave', () => {
        this._lpHoverConstraintId = null;
        const shapes = this._constraintShapes(c);
        if (shapes.includes(this.renderer.hoverEntity)) this.renderer.hoverEntity = null;
        this._scheduleRender();
        this._updateLeftPanelHighlights();
      });

      // Click to select constraint
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('lp-delete') || e.target.classList.contains('lp-edit')) return;
        this._lpSelectedConstraintId = (this._lpSelectedConstraintId === c.id) ? null : c.id;
        this._updateLeftPanelHighlights();
        row.focus();
      });

      // Double-click to edit constraint value
      if (c.editable) {
        row.addEventListener('dblclick', (e) => {
          if (e.target.classList.contains('lp-delete')) return;
          this._editConstraint(c);
        });
      }

      // Edit button
      if (c.editable) {
        row.querySelector('.lp-edit').addEventListener('click', () => {
          this._editConstraint(c);
        });
      }

      // Delete button
      row.querySelector('.lp-delete').addEventListener('click', () => {
        takeSnapshot();
        if (c.type === 'dimension') {
          // For dimension constraints, remove from constraints and mark as driven
          state.scene.removeConstraint(c);
          c.isConstraint = false;
        } else {
          state.scene.removeConstraint(c);
        }
        if (this._lpSelectedConstraintId === c.id) this._lpSelectedConstraintId = null;
        state.emit('change');
        this._scheduleRender();
      });

      // DELETE key on focused constraint row
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          takeSnapshot();
          if (c.type === 'dimension') {
            state.scene.removeConstraint(c);
            c.isConstraint = false;
          } else {
            state.scene.removeConstraint(c);
          }
          if (this._lpSelectedConstraintId === c.id) this._lpSelectedConstraintId = null;
          state.emit('change');
          this._scheduleRender();
          e.preventDefault();
          e.stopPropagation();
        }
      });

      list.appendChild(row);
    }
  }

  /** Edit a constraint value via prompt dialog or inline input */
  async _editConstraint(c) {
    if (c.type === 'dimension') {
      // Use inline dimension input for dimension constraints
      await this._editDimensionConstraint(c);
      return;
    }
    if (c.type === 'fixed') {
      const val = await showPrompt({
        title: 'Edit Fixed Position',
        message: 'Enter position as X, Y:',
        defaultValue: `${c.fx.toFixed(4)}, ${c.fy.toFixed(4)}`,
      });
      if (val !== null && val !== '') {
        const parts = val.split(',').map(s => s.trim());
        if (parts.length === 2) {
          const x = parseFloat(parts[0]), y = parseFloat(parts[1]);
          if (!isNaN(x) && !isNaN(y)) {
            takeSnapshot();
            c.fx = x;
            c.fy = y;
            state.scene.solve();
            state.emit('change');
            this._scheduleRender();
          }
        }
      }
    } else if (c.type === 'angle') {
      const currentDeg = typeof c.value === 'number' ? (c.value * 180 / Math.PI).toFixed(2) : String(c.value);
      const rangeStr = (c.min != null || c.max != null)
        ? ` [${c.min != null ? (c.min * 180 / Math.PI).toFixed(1) : ''}..${c.max != null ? (c.max * 180 / Math.PI).toFixed(1) : ''}]` : '';
      const val = await showPrompt({
        title: 'Edit Angle Constraint',
        message: 'Enter angle in degrees (or variable name).\nOptionally add min..max range, e.g. "45 [0..90]":',
        defaultValue: currentDeg + rangeStr,
      });
      if (val !== null && val !== '') {
        const parsed = this._parseConstraintInput(val);
        if (parsed) {
          takeSnapshot();
          const numVal = parseFloat(parsed.value);
          if (!isNaN(numVal)) {
            c.value = numVal * Math.PI / 180;
          } else if (parsed.value.trim()) {
            c.value = parsed.value.trim(); // variable name
          } else {
            return;
          }
          c.min = parsed.min != null ? parsed.min * Math.PI / 180 : null;
          c.max = parsed.max != null ? parsed.max * Math.PI / 180 : null;
          state.scene.solve();
          state.emit('change');
          this._scheduleRender();
        }
      }
    } else {
      // distance, length, radius
      const currentVal = typeof c.value === 'number' ? c.value.toFixed(4) : String(c.value);
      const rangeStr = (c.min != null || c.max != null)
        ? ` [${c.min != null ? c.min.toFixed(1) : ''}..${c.max != null ? c.max.toFixed(1) : ''}]` : '';
      const val = await showPrompt({
        title: `Edit ${c.type.charAt(0).toUpperCase() + c.type.slice(1)} Constraint`,
        message: 'Enter value (or variable name).\nOptionally add min..max range, e.g. "50 [10..100]":',
        defaultValue: currentVal + rangeStr,
      });
      if (val !== null && val !== '') {
        const parsed = this._parseConstraintInput(val);
        if (parsed) {
          takeSnapshot();
          const numVal = parseFloat(parsed.value);
          if (!isNaN(numVal) && numVal >= 0) {
            c.value = numVal;
          } else if (isNaN(numVal) && parsed.value.trim()) {
            c.value = parsed.value.trim(); // variable name
          } else {
            return; // invalid
          }
          c.min = parsed.min;
          c.max = parsed.max;
          state.scene.solve();
          state.emit('change');
          this._scheduleRender();
        }
      }
    }
  }

  /** Parse constraint input string like "50 [10..100]" or "myVar [0..200]" */
  _parseConstraintInput(input) {
    const rangeMatch = input.match(/\[([\d.eE+\-]*)\.\.([\d.eE+\-]*)\]/);
    let min = null, max = null;
    if (rangeMatch) {
      if (rangeMatch[1].trim()) min = parseFloat(rangeMatch[1]);
      if (rangeMatch[2].trim()) max = parseFloat(rangeMatch[2]);
      if ((min != null && isNaN(min)) || (max != null && isNaN(max))) return null;
      input = input.replace(/\[[\d.eE+\-]*\.\.[\d.eE+\-]*\]/, '').trim();
    }
    return { value: input.trim(), min, max };
  }

  /** Edit a dimension-type constraint via the inline dimension widget */
  async _editDimensionConstraint(dim, screenPos = null) {
    const isAngle = dim.dimType === 'angle';
    const currentVal = dim.formula != null
      ? (isAngle && typeof dim.formula === 'number'
          ? (dim.formula * 180 / Math.PI).toFixed(2)
          : String(dim.formula))
      : (isAngle
          ? (dim.value * 180 / Math.PI).toFixed(2)
          : dim.value.toFixed(4));

    // Compute screen position from dimension midpoint if not given
    if (!screenPos) {
      const midWx = (dim.x1 + dim.x2) / 2;
      const midWy = (dim.y1 + dim.y2) / 2;
      const s = this.viewport.worldToScreen(midWx, midWy);
      screenPos = { x: s.x, y: s.y };
    }

    const result = await showDimensionInput({
      dimType: dim.dimType,
      defaultValue: currentVal,
      driven: !dim.isConstraint,
      hint: 'value or variable name',
      screenPos,
    });

    if (result === null) return; // cancelled

    const { value: inputVal, driven } = result;
    const num = parseFloat(inputVal);
    const isNum = !isNaN(num);
    const trimmed = inputVal.trim();
    // A simple variable name is an identifier (letters/underscore, optionally followed by letters/digits/underscore)
    const isSimpleVar = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed);
    const isFormula = !isNum && !isSimpleVar && trimmed.length > 0;

    takeSnapshot();

    const wasConstraint = dim.isConstraint;
    dim.isConstraint = !driven;
    dim.displayMode = (isSimpleVar || isFormula) ? 'both' : 'value';

    if (isSimpleVar) {
      // Simple variable name — create/update the variable and link to it
      dim.formula = trimmed;
      dim.variableName = trimmed;
      setVariable(trimmed, dim.value);
    } else if (isFormula) {
      // Formula expression (e.g., "x + 10") — use as formula without creating a variable
      dim.formula = trimmed;
      dim.variableName = null;
    } else if (isNum) {
      dim.formula = isAngle ? (num * Math.PI / 180) : num;
      dim.variableName = null;
    }

    // Handle constraint state transitions
    const inConstraints = state.scene.constraints.includes(dim);
    if (!driven && dim.sourceA && !inConstraints) {
      // Becoming a constraint — add to solver
      state.scene.addConstraint(dim);
    } else if (driven && inConstraints) {
      // Becoming driven — remove from solver
      state.scene.removeConstraint(dim);
    } else {
      // Still a constraint — re-solve with new value
      state.scene.solve();
    }

    state.emit('change');
    this._scheduleRender();
  }

  _rebuildVariablesList() {
    const list = document.getElementById('variables-list');
    list.innerHTML = '';
    const vars = getAllVariables();

    if (vars.size === 0) {
      list.innerHTML = '<p class="hint">No variables</p>';
      return;
    }

    for (const [name, value] of vars) {
      const row = document.createElement('div');
      row.className = 'lp-item';

      row.innerHTML = `<span class="lp-icon" style="color:var(--accent)">𝑥</span>` +
        `<span class="lp-var-name">${name}</span>` +
        `<span class="lp-var-eq">=</span>` +
        `<span class="lp-var-value">${value}</span>` +
        `<button class="lp-edit" title="Edit variable (name &amp; value)">✎</button>` +
        `<button class="lp-delete" title="Delete variable">✕</button>`;

      // --- Inline value edit: click on the value span ---
      const valueSpan = row.querySelector('.lp-var-value');
      valueSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        this._inlineEditVariableValue(row, name, value);
      });

      // --- Inline name edit: double-click on the name span ---
      const nameSpan = row.querySelector('.lp-var-name');
      nameSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this._inlineEditVariableName(row, name, value);
      });

      // --- Edit button: full popup for name=value ---
      row.querySelector('.lp-edit').addEventListener('click', async () => {
        const val = await showPrompt({
          title: 'Edit Variable',
          message: `Edit variable (name=value):`,
          defaultValue: `${name}=${value}`,
        });
        if (val !== null && val !== '') {
          const eqIdx = val.indexOf('=');
          if (eqIdx > 0) {
            const newName = val.substring(0, eqIdx).trim();
            const num = parseFloat(val.substring(eqIdx + 1).trim());
            if (newName && !isNaN(num)) {
              takeSnapshot();
              if (newName !== name) removeVariable(name);
              setVariable(newName, num);
              state.scene.solve();
              state.emit('change');
              this._scheduleRender();
            }
          }
        }
      });

      row.querySelector('.lp-delete').addEventListener('click', async () => {
        takeSnapshot();
        removeVariable(name);
        state.scene.solve();
        state.emit('change');
        this._scheduleRender();
      });

      list.appendChild(row);
    }
  }

  /** Replace the value span with an inline input, commit on Enter/blur */
  _inlineEditVariableValue(row, name, currentValue) {
    const valueSpan = row.querySelector('.lp-var-value');
    if (!valueSpan || row.querySelector('.lp-inline-input')) return; // already editing

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'lp-inline-input';
    input.value = String(currentValue);

    valueSpan.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) {
        const num = parseFloat(input.value);
        if (!isNaN(num) && num !== currentValue) {
          takeSnapshot();
          setVariable(name, num);
          state.scene.solve();
          state.emit('change');
          return; // change event already triggers _rebuildLeftPanel
        }
      }
      this._rebuildVariablesList();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }

  /** Replace the name span with an inline input, commit on Enter/blur */
  _inlineEditVariableName(row, currentName, value) {
    const nameSpan = row.querySelector('.lp-var-name');
    if (!nameSpan || row.querySelector('.lp-inline-input')) return; // already editing

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'lp-inline-input';
    input.value = currentName;

    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) {
        const newName = input.value.trim();
        if (newName && newName !== currentName) {
          takeSnapshot();
          removeVariable(currentName);
          setVariable(newName, value);
          state.scene.solve();
          state.emit('change');
          return; // change event already triggers _rebuildLeftPanel
        }
      }
      this._rebuildVariablesList();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }

  /** Update highlight classes on left panel items without full rebuild */
  _updateLeftPanelHighlights() {
    const scene = state.scene;
    const hoverEnt = this.renderer.hoverEntity;

    // Pre-compute hovered constraint's prim IDs
    let hcPrimIds = null;
    if (this._lpHoverConstraintId != null) {
      const hc = scene.constraints.find(c => c.id === this._lpHoverConstraintId);
      if (hc) hcPrimIds = this._constraintPrimIds(hc);
    }

    // Build a shapes map for quick lookup by id
    const shapesArr = [...scene.shapes()];
    const shapesById = new Map();
    for (const s of shapesArr) shapesById.set(s.id, s);

    // Update primitives list highlights
    const primItems = document.querySelectorAll('#primitives-list .lp-item');
    for (const item of primItems) {
      const id = parseInt(item.dataset.primId);
      let hl = false;

      // Highlight if this prim is hovered on canvas
      if (hoverEnt && hoverEnt.id === id) hl = true;

      // Highlight if a constraint being hovered references this prim
      if (hcPrimIds && hcPrimIds.has(id)) hl = true;

      item.classList.toggle('highlight', hl);

      // Update selected class
      const prim = shapesById.get(id);
      item.classList.toggle('selected', prim ? prim.selected : false);
    }

    // Build a constraints map for quick lookup by id
    const constraintsById = new Map();
    for (const c of scene.constraints) constraintsById.set(c.id, c);

    // Update constraints list highlights
    const cItems = document.querySelectorAll('#constraints-list .lp-item');
    for (const item of cItems) {
      const cId = parseInt(item.dataset.constraintId);
      let hl = false;

      const c = constraintsById.get(cId);
      if (c) {
        const cPrimIds = this._constraintPrimIds(c);

        // Highlight if canvas hover target is referenced by this constraint
        if (hoverEnt && cPrimIds.has(hoverEnt.id)) hl = true;

        // Highlight if a primitive hovered in left panel is referenced by this constraint
        if (this._lpHoverPrimId != null && cPrimIds.has(this._lpHoverPrimId)) hl = true;
      }

      item.classList.toggle('highlight', hl);
      item.classList.toggle('selected', this._lpSelectedConstraintId === cId);
    }

    // Scroll highlighted items into view
    const highlightedPrim = document.querySelector('#primitives-list .lp-item.highlight');
    if (highlightedPrim) highlightedPrim.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const highlightedConstraint = document.querySelector('#constraints-list .lp-item.highlight');
    if (highlightedConstraint) highlightedConstraint.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // --- Layers panel ---
  _rebuildLayersPanel() {
    const panel = document.getElementById('layers-panel');
    panel.innerHTML = '';
    for (const layer of state.layers) {
      const row = document.createElement('div');
      row.className = 'layer-row' + (layer.name === state.activeLayer ? ' active-layer' : '');
      row.dataset.layer = layer.name;
      row.innerHTML = `
        <span class="layer-color" style="background:${layer.color}"></span>
        <span class="layer-name">${layer.name}</span>
        <button class="layer-visibility" title="Toggle visibility">${layer.visible ? '👁' : '—'}</button>
      `;
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('layer-visibility')) {
          layer.visible = !layer.visible;
          this._rebuildLayersPanel();
          this._scheduleRender();
          return;
        }
        state.activeLayer = layer.name;
        this._rebuildLayersPanel();
      });
      panel.appendChild(row);
    }
  }
}

// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  window.cadApp = new App();
});

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
import { showConfirm, showPrompt } from './ui/popup.js';
import {
  SelectTool, LineTool, RectangleTool, CircleTool,
  ArcTool, PolylineTool, TextTool, DimensionTool,
  MoveTool, CopyTool,
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
      select:    new SelectTool(this),
      line:      new LineTool(this),
      rectangle: new RectangleTool(this),
      circle:    new CircleTool(this),
      arc:       new ArcTool(this),
      polyline:  new PolylineTool(this),
      text:      new TextTool(this),
      dimension: new DimensionTool(this),
      move:      new MoveTool(this),
      copy:      new CopyTool(this),
    };
    this.activeTool = this.tools.select;
    this.activeTool.activate();

    // Bind events
    this._bindCanvasEvents();
    this._bindToolbarEvents();
    this._bindKeyboardEvents();
    this._bindResizeEvent();
    this._bindStateEvents();

    // Register viewport for persistence and restore saved project
    setViewport(this.viewport);
    const loaded = loadProject();
    if (loaded.ok) {
      this._rebuildLayersPanel();
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
    const topBar = 42;
    const panelBottomHeight = mobile ? Math.floor(window.innerHeight * 0.36) : 0;

    const width = Math.max(1, window.innerWidth - panelWidth);
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
      const { sx, sy } = this._lastPointer;
      const t0 = performance.now();

      const basePoint = this.activeTool._startX !== undefined && this.activeTool.step > 0
        ? { x: this.activeTool._startX, y: this.activeTool._startY }
        : null;
      const { world, snap } = getSnappedPosition(sx, sy, this.viewport, basePoint);

      this.renderer.cursorWorld = world;
      this.renderer.snapPoint = snap;

      // Show snapped position in status bar (falls back to raw world if no snap)
      const display = snap || world;
      document.getElementById('status-coords').textContent =
        `X: ${display.x.toFixed(2)}  Y: ${display.y.toFixed(2)}`;

      this.activeTool.onMouseMove(world.x, world.y, sx, sy);

      const dt = performance.now() - t0;
      if (dt > 12) {
        warn('Pointer processing frame is slow', { ms: dt.toFixed(2), tool: this.activeTool.name });
      }
      this._scheduleRender();
    });
  }

  // --- Tool switching ---
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
      const { world } = getSnappedPosition(sx, sy, this.viewport, this.activeTool.step > 0 ? basePoint : null);

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

      this._lastPointer = { sx, sy };
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
      const { world } = getSnappedPosition(sx, sy, this.viewport, basePoint);

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
    // Draw tools
    document.querySelectorAll('#toolbar button[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => this.setActiveTool(btn.dataset.tool));
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
      // Don't intercept when typing in command line
      if (document.activeElement === cmdInput) {
        if (e.key === 'Enter') {
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
      debouncedSave();
    });
    state.on('selection:change', (sel) => this._updatePropertiesPanel(sel));
    state.on('layers:change', () => {
      this._rebuildLayersPanel();
      debouncedSave();
    });
    state.on('file:loaded', () => {
      this.viewport.fitEntities(state.entities);
      this._rebuildLayersPanel();
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
      let html = `<div class="prop-row"><label>Type</label><span>${e.type}</span></div>`;
      html += `<div class="prop-row"><label>Layer</label><span>${e.layer}</span></div>`;
      html += `<div class="prop-row"><label>ID</label><span>${e.id}</span></div>`;

      if (e.type === 'LINE') {
        html += `<div class="prop-row"><label>X1</label><span>${e.x1.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Y1</label><span>${e.y1.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>X2</label><span>${e.x2.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Y2</label><span>${e.y2.toFixed(2)}</span></div>`;
        const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
        html += `<div class="prop-row"><label>Length</label><span>${len.toFixed(2)}</span></div>`;
      } else if (e.type === 'CIRCLE') {
        html += `<div class="prop-row"><label>Center X</label><span>${e.cx.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Center Y</label><span>${e.cy.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Radius</label><span>${e.radius.toFixed(2)}</span></div>`;
      } else if (e.type === 'ARC') {
        html += `<div class="prop-row"><label>Center X</label><span>${e.cx.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Center Y</label><span>${e.cy.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Radius</label><span>${e.radius.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Start°</label><span>${(e.startAngle * 180 / Math.PI).toFixed(1)}</span></div>`;
        html += `<div class="prop-row"><label>End°</label><span>${(e.endAngle * 180 / Math.PI).toFixed(1)}</span></div>`;
      } else if (e.type === 'TEXT') {
        html += `<div class="prop-row"><label>X</label><span>${e.x.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Y</label><span>${e.y.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Text</label><span>${e.text}</span></div>`;
        html += `<div class="prop-row"><label>Height</label><span>${e.height}</span></div>`;
      }
      panel.innerHTML = html;
    } else {
      panel.innerHTML = `<p class="hint">${selection.length} entities selected</p>`;
    }
    this._scheduleRender();
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
